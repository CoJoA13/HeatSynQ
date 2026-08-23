import { describe, it, expect, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  attemptDir,
  classifyFailure,
  retryRefusal,
  isSessionEndpoint,
  findRawApiMutations,
  resultsLine,
} from "../e2e/lib/failure-classify.mjs";
import { enumerateRoutes, warmupRefusal } from "../e2e/lib/warmup.mjs";
import { preflightRefusal } from "../e2e/lib/preflight.mjs";
import {
  findAmbientRowLocators,
  findPlainErrorFailures,
  findUncheckedAbsenceAssertions,
} from "../e2e/lib/flow-lint.mjs";
import { suiteSourcesSync } from "../e2e/lib/suite-sources.mjs";

// #192: the sweeps read the flow files AND the shared lib helpers (minus the two detector modules,
// which hold the patterns as literals). One list, from suite-sources.mjs, read identically here and
// in run.mjs so a file can never be swept by one enforcement point and skipped by the other.
const E2E_DIR = path.join(process.cwd(), "e2e");
const sweptSources = () => suiteSourcesSync(E2E_DIR);
const sweep = (find: (src: string) => { line: number; snippet: string }[]) =>
  sweptSources().flatMap(({ relPath, source }) =>
    find(source).map((f) => `${relPath}:${f.line} ${f.snippet}`),
  );

/**
 * The E2E harness's decision predicates (#184, gate-infrastructure Task 2 fix round).
 *
 * These three — "was this a transport failure?", "is a retry safe?", "can the mutation counters
 * see this write?" — decide whether a red run is allowed to become a green one. They were
 * module-private inside `e2e/run.mjs` and therefore untestable: the round-1 proofs that they work
 * were genuine but were injected by hand and reverted, so nothing guarded the next edit to them.
 * In a group whose whole subject is checks that lie about their own coverage, that was the wrong
 * place to leave them.
 *
 * `e2e/run.mjs` is never imported here: it starts a dev server and a browser at module scope's
 * mercy. The predicates live in `e2e/lib/failure-classify.mjs` precisely so this file can reach
 * them without any of that.
 */

describe("isSessionEndpoint", () => {
  it("excludes the two session endpoints, which login() re-POSTs on every attempt", () => {
    expect(isSessionEndpoint("http://localhost:3100/api/auth/login")).toBe(true);
    expect(isSessionEndpoint("http://localhost:3100/api/auth/logout")).toBe(true);
    // Query strings and ports must not defeat the match — it is a pathname test, not a substring one.
    expect(isSessionEndpoint("http://localhost:3100/api/auth/login?next=%2Forders")).toBe(true);
  });

  it("counts every other mutation, including paths that merely start with a session path", () => {
    expect(isSessionEndpoint("http://localhost:3100/api/orders")).toBe(false);
    expect(isSessionEndpoint("http://localhost:3100/api/auth/login/extra")).toBe(false);
    expect(isSessionEndpoint("http://localhost:3100/api/auth/me")).toBe(false);
  });

  it("treats an unparseable url as countable rather than exempt (fails closed)", () => {
    expect(isSessionEndpoint("not a url")).toBe(false);
  });
});

describe("classifyFailure", () => {
  const netFailure = { at: 0, line: "GET /api/parts/x — net::ERR_NETWORK_CHANGED" };

  it("names a request that got no response as network-level", () => {
    const err = new Error("locator.waitFor: Timeout 45000ms exceeded.");
    expect(classifyFailure(err, [netFailure])).toBe("network");
  });

  it("calls a plain thrown error an assertion failure", () => {
    expect(classifyFailure(new Error("boom"), [])).toBe("assertion");
  });

  it("keeps a LOCATOR timeout an assertion failure when nothing failed on the wire", () => {
    const err = new Error("locator.waitFor: Timeout 45000ms exceeded.");
    expect(classifyFailure(err, [])).toBe("assertion");
  });

  it("reads a NAVIGATION timeout as network-level even with no requestfailed record", () => {
    const err = new Error("page.goto: Timeout 60000ms exceeded.");
    expect(classifyFailure(err, [])).toBe("network");
  });

  it("accepts a non-Error throw without crashing", () => {
    expect(classifyFailure("net::ERR_CONNECTION_REFUSED", [])).toBe("network");
    expect(classifyFailure(undefined, [])).toBe("assertion");
  });

  // --- Finding 2 (fix round): an ERR_ASSERTION must never launder into a green RETRIED. ---
  //
  // `netFailures` accumulates for the WHOLE flow with no time window, so one dropped request at
  // step 3 that the app recovered from made a step-40 assertion failure classify as "network" —
  // and, in a flow that had not yet mutated, retried into `RETRIED ... exit 0`. That is exactly the
  // outcome #184 says the gate must prevent.
  describe("an AssertionError hard-overrides the netFailures signal (finding 2)", () => {
    const assertionError = (): unknown => {
      try {
        assert.equal(1, 2, "the surcharge row count");
        return null;
      } catch (err) {
        return err;
      }
    };

    it("is an assertion failure even with a whole flow's worth of dropped requests behind it", () => {
      const err = assertionError();
      expect((err as { code?: string })?.code).toBe("ERR_ASSERTION");
      expect(classifyFailure(err, [netFailure, netFailure, netFailure])).toBe("assertion");
    });

    it("stays an assertion failure when the assertion's own message quotes a network error", () => {
      let err: unknown = null;
      try {
        assert.equal("net::ERR_CONNECTION_REFUSED", "", "the flow asserted on an error string");
      } catch (thrown) {
        err = thrown;
      }
      expect(classifyFailure(err, [netFailure])).toBe("assertion");
    });

    it("still calls a genuine transport failure network-level (the override is not a blanket)", () => {
      const err = new Error("page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3399/x");
      expect((err as { code?: string }).code).toBeUndefined();
      expect(classifyFailure(err, [])).toBe("network");
    });
  });

  // --- Finding 3 (fix round): the two ERR_ABORTED sides must agree. ---
  //
  // `requestfailed` deliberately DROPS net::ERR_ABORTED (a fetch superseded by a navigation, a
  // cancelled preload, a navigation that becomes a download) — but the error-text regex's
  // `net::ERR_` alternation admitted the very same string, so `page.goto` onto a URL that turns
  // into a download classified as network and burned a retry on a deterministic, reproducible bug.
  describe("net::ERR_ABORTED is excluded on BOTH sides (finding 3)", () => {
    it("does not read an aborted navigation as a transport failure", () => {
      const err = new Error("page.goto: net::ERR_ABORTED at http://localhost:3100/api/x/traveler");
      expect(classifyFailure(err, [])).toBe("assertion");
    });

    it("still sees a real net:: error sharing the same message", () => {
      const err = new Error(
        "page.goto: net::ERR_ABORTED at http://localhost:3100/x\n" +
        "Call log:\n  - net::ERR_NETWORK_CHANGED",
      );
      expect(classifyFailure(err, [])).toBe("network");
    });
  });
});

describe("retryRefusal", () => {
  const clean = { kind: "network", committed: 0, indeterminate: 0 };

  it("allows the retry only when the attempt provably changed nothing", () => {
    expect(retryRefusal(clean)).toBeNull();
  });

  it("refuses an assertion failure outright", () => {
    expect(retryRefusal({ ...clean, kind: "assertion" })).toMatch(/assertion failure/);
  });

  it("refuses once anything committed", () => {
    expect(retryRefusal({ ...clean, committed: 4 })).toMatch(/4 mutating request\(s\) already committed/);
  });

  it("refuses a mutating request whose outcome is unknown — the dangerous direction", () => {
    expect(retryRefusal({ ...clean, indeterminate: 1 })).toMatch(/unknown outcome/);
  });
});

// --- Finding 1 (fix round): the mutation counters are blind to page.request.*. ---
//
// `context.on("request"/"response")` only fires for requests issued FROM A PAGE. An
// APIRequestContext call (`page.request.patch(...)`) is issued from the Playwright process and
// produces no context event at all — so a flow could mutate the dev DB with the retry gate's
// counters reading zero, and be retried from step 1. `templates-admin.mjs` already had exactly one
// such call. The sweep below is what makes the next one a decision rather than a silent hole.
describe("findRawApiMutations", () => {
  it("finds a raw mutating APIRequestContext call, with its line number", () => {
    const src = "line one\nconst res = await page.request.patch(url, { data });\nline three\n";
    const found = findRawApiMutations(src);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
    expect(found[0].method).toBe("patch");
  });

  it("finds every mutating verb, and `fetch` (which carries its own method)", () => {
    for (const verb of ["post", "put", "patch", "delete", "fetch"]) {
      expect(findRawApiMutations(`await page.request.${verb}(u)`)).toHaveLength(1);
    }
  });

  it("finds them on any receiver, not just `page`", () => {
    expect(findRawApiMutations("await context.request.post(u)")).toHaveLength(1);
    expect(findRawApiMutations("await ctx.request.delete(u)")).toHaveLength(1);
  });

  it("flags a second APIRequestContext being built, which would carry its own cookies", () => {
    expect(findRawApiMutations("const api = await request.newContext({})")).toHaveLength(1);
  });

  // #192: the literal-`request`-receiver blind spot. The old regex matched only `request.post(`, so
  // three ways of reaching the very same call slipped past it while producing exactly the state the
  // refusal exists to prevent — a flow that mutated, counters that read zero, a retry granted on it.
  it("flags an ALIASED receiver — `const req = page.request; req.post(u)`", () => {
    expect(findRawApiMutations("const req = page.request;\nawait req.post(u)")).toHaveLength(1);
  });

  it("flags a DESTRUCTURED method — `const {post} = page.request; post(u)`", () => {
    expect(findRawApiMutations("const {post} = page.request;\nawait post(u)")).toHaveLength(1);
  });

  it("flags BRACKET access — `page[\"request\"].post(u)` and its alias", () => {
    expect(findRawApiMutations('await page["request"].post(u)')).toHaveLength(1);
    expect(findRawApiMutations('const r = page["request"];\nawait r.delete(u)')).toHaveLength(1);
  });

  // Codex P1: the capture detector flags the CAPTURE itself, not a fixed assignment shape, so the
  // parenthesized alias, a return, and an argument hand-off — all ways of smuggling the context out —
  // are caught, where an assignment-anchored pattern missed them.
  it("flags a PARENTHESIZED alias, a return, and an argument hand-off", () => {
    expect(findRawApiMutations("const req = (page.request);\nawait req.post(u)")).toHaveLength(1);
    expect(findRawApiMutations("return page.request")).toHaveLength(1);
    expect(findRawApiMutations("archive(page.request, url)")).toHaveLength(1);
  });

  // ...and the two forms it must NOT confuse with a capture, both all over the current flows.
  it("leaves `res.request()` alone — a response's METHOD, not the APIRequestContext property", () => {
    // ~20 flows read `res.request().method()` off a waited response. `request` there is followed by
    // `(`, not `.`, so it is a method call, never a captured context.
    expect(findRawApiMutations('res.request().method() === "POST"')).toEqual([]);
    expect(findRawApiMutations('res.url().includes("/lines") && res.request().method() === "PUT" && res.ok()')).toEqual([]);
  });

  it("leaves an inline `.request.get(...)` read alone — a trailing `.` is an access, not a capture", () => {
    expect(findRawApiMutations("const response = await page.request.get(exportUrl)")).toEqual([]);
    expect(findRawApiMutations("await (await page.request.get(u)).json()")).toEqual([]);
  });

  it("leaves reads alone — a GET cannot mutate, and the flows read this way constantly", () => {
    expect(findRawApiMutations("const pdf = await page.request.get(url)")).toEqual([]);
    expect(findRawApiMutations("await (await page.request.get(u)).json()")).toEqual([]);
  });

  it("leaves the counted wrapper alone — that is the sanctioned way to do it", () => {
    expect(findRawApiMutations('await ctx.apiMutate(page, url, { method: "PATCH", data })')).toEqual([]);
  });

  it("over-matches rather than under-matches: it fails CLOSED on a commented-out call", () => {
    // Deliberate, the `issuesMutatingRequest` precedent: a sweep that a comment can talk its way
    // past is a sweep that a real call can too. The escape hatch is ctx.apiMutate, not a comment.
    expect(findRawApiMutations("// await page.request.post(u) — disabled for now")).toHaveLength(1);
  });

  it("reports several findings in source order", () => {
    const src = "a\nawait page.request.post(u)\nb\nc\nawait page.request.delete(u)\n";
    expect(findRawApiMutations(src).map((f) => f.line)).toEqual([2, 5]);
  });

  // The guard itself, run centrally rather than only at harness startup — now over flows AND lib
  // (#192), the population run.mjs refuses on.
  it("every swept suite source is clean today", () => {
    expect(sweptSources().length).toBeGreaterThan(0);
    expect(sweep(findRawApiMutations)).toEqual([]);
  });
});

describe("enumerateRoutes", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "e2e-routes-"));
    const write = (rel: string) => {
      mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), "");
    };
    write("page.tsx");
    write("orders/page.tsx");
    write("orders/[id]/page.tsx");
    write("api/orders/route.ts");
    write("api/orders/[id]/loads/[loadId]/route.ts");
    write("orders/layout.tsx");        // not routable
    write("orders/OrdersTable.tsx");   // not routable
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("splits pages from API routes and ignores everything else", async () => {
    const { pages, apis } = await enumerateRoutes(dir);
    expect(pages).toEqual(["/", "/orders", "/orders/e2e-warmup"]);
    expect(apis).toEqual(["/api/orders", "/api/orders/e2e-warmup/loads/e2e-warmup"]);
  });
});

describe("warmupRefusal", () => {
  const budgetMs = 240000;

  it("passes a healthy warm-up", () => {
    expect(warmupRefusal({ count: 243, failures: [], skipped: 0, budgetMs })).toBeNull();
  });

  it("passes a warm-up with a handful of slow routes — a warm-up failure is not fatal", () => {
    const failures = [{ route: "/api/x", error: "TimeoutError" }];
    expect(warmupRefusal({ count: 243, failures, skipped: 0, budgetMs })).toBeNull();
  });

  it("refuses the run when most of the warm-up failed, naming the reason", () => {
    const failures = Array.from({ length: 200 }, () => ({ route: "/api/x", error: "fetch failed" }));
    const refusal = warmupRefusal({ count: 243, failures, skipped: 0, budgetMs });
    expect(refusal).toMatch(/200 of 243/);
    expect(refusal).toMatch(/fetch failed/);
  });

  it("refuses the run when the warm-up blew its aggregate budget", () => {
    const refusal = warmupRefusal({ count: 40, failures: [], skipped: 203, budgetMs });
    expect(refusal).toMatch(/203/);
    expect(refusal).toMatch(/240s/);
  });

  // Was pinned as "says nothing about an empty route set" and returned null. That made it the one
  // shape where the warm-up did NOTHING and the run proceeded anyway, printing `warmed 0 routes` —
  // a phase whose entire job is compiling every route before flow 1 compiling none of them, while
  // every other failure of it refuses. Flipped in the whole-branch review, 2026-08-22.
  it("refuses an empty route set — the warm-up did nothing, which is not a healthy warm-up", () => {
    const refusal = warmupRefusal({ count: 0, failures: [], skipped: 0, budgetMs });
    expect(refusal).toMatch(/no requests at all/);
    expect(refusal).toMatch(/src\/app/);
  });

  // ...but a blown budget still reads as a blown budget, not as an empty enumeration: `skipped`
  // is tested first, and with a zero count the two are otherwise indistinguishable from here.
  it("reports a budget blow-out that issued nothing as a budget blow-out", () => {
    const refusal = warmupRefusal({ count: 0, failures: [], skipped: 243, budgetMs });
    expect(refusal).toMatch(/blew its 240s budget/);
    expect(refusal).toMatch(/243 of 243/);
  });

  // The self-check that replaces "delete the third session-cookie literal" (finding 7). If this
  // file's cookie name ever drifts from the one src/proxy.ts checks, every page 307s to /login and
  // the warm-up compiles nothing while still reporting "warmed 45 pages".
  it("refuses when the warm-up's session cookie stopped defeating the proxy redirect", () => {
    const refusal = warmupRefusal({ count: 243, failures: [], skipped: 0, budgetMs, pages: 45, pagesRedirected: 44 });
    expect(refusal).toMatch(/44 of 45/);
    expect(refusal).toMatch(/SESSION_COOKIE/);
  });

  it("tolerates the odd page redirect — only a broad one means the cookie is wrong", () => {
    expect(warmupRefusal({ count: 243, failures: [], skipped: 0, budgetMs, pages: 45, pagesRedirected: 1 })).toBeNull();
  });
});

// #167a. The pre-flight decides whether the dev database can host a run at all. Its whole value is
// being NARROW — a check that refuses a database the suite would in fact have passed on is one
// people start bypassing — so the clean case and each condition in isolation are pinned separately.
describe("preflightRefusal", () => {
  const clean = {
    year: 2026, month: 8, closePeriodStatus: null,
    preliminaryError: null, unpostedBatchCount: 0, variance: 0, readinessGaps: [],
  };

  it("passes a dev database with nothing ambient in the way", () => {
    expect(preflightRefusal(clean)).toBeNull();
  });

  it("refuses an OPEN receipt batch dated in the target month, with the count as evidence", () => {
    const refusal = preflightRefusal({ ...clean, unpostedBatchCount: 1, variance: 1250 });
    expect(refusal).toMatch(/1 OPEN receipt batch/);
    expect(refusal).toMatch(/2026-08/);
    expect(refusal).toMatch(/npm run db:reset/);
  });

  it("refuses a ClosePeriod already covering the target month, whatever its status", () => {
    expect(preflightRefusal({ ...clean, closePeriodStatus: "CLOSED" })).toMatch(/ClosePeriod row already covers/);
    expect(preflightRefusal({ ...clean, closePeriodStatus: "REOPENED" })).toMatch(/REOPENED/);
  });

  it("refuses a schedule that does not reconcile, and prints the variance", () => {
    expect(preflightRefusal({ ...clean, variance: -6750 })).toMatch(/variance -6750/);
  });

  it("collects every reason rather than short-circuiting on the first — they share one fix", () => {
    const refusal = preflightRefusal({
      year: 2026, month: 8, closePeriodStatus: "CLOSED", unpostedBatchCount: 2, variance: 1250,
    });
    expect(refusal).toMatch(/ClosePeriod/);
    expect(refusal).toMatch(/2 OPEN receipt batch/);
    expect(refusal).toMatch(/variance 1250/);
    expect(refusal!.split("\n  - ")).toHaveLength(4);   // the header plus three reasons
  });

  // The half that matters most: surcharges were half of #167 and are deliberately NOT a condition
  // here, because invoice-shipped-order now counts only its own surcharge row. A pre-flight that
  // over-refuses is a pre-flight people disable.
  it("says nothing about anything it is not responsible for", () => {
    const refusal = preflightRefusal(clean);
    expect(refusal).toBeNull();
  });

  it("names both directions of the recipe, since the refusal is the only place a developer reads it", () => {
    const refusal = preflightRefusal({ ...clean, unpostedBatchCount: 1 });
    expect(refusal).toMatch(/db:reset/);
    expect(refusal).toMatch(/docs\/manual\/dataset\.md/);
  });

  // The recipe has to WORK in the session that reads it. `db:reset` confirms before it truncates,
  // and a non-interactive shell (an agent, CI, a script) cannot be asked — so the flag form is
  // printed beside the bare one rather than left for the reader to discover from a second refusal.
  it("prints the non-interactive form of the recipe too, because db:reset now confirms", () => {
    const refusal = preflightRefusal({ ...clean, unpostedBatchCount: 1 });
    expect(refusal).toMatch(/npm run db:reset -- --yes/);
  });

  // --- Fix round. ---

  // #167a fix round, finding 3. `preliminaryReport` does not always ANSWER: `priorEndingAr` throws
  // 409 when an earlier month is closed and the immediately-prior one is not. The demonstration
  // dataset closes the month before its seed date, so it produces exactly that the moment the
  // calendar rolls over. Unwrapped it surfaced as an execFileSync "Command failed" and a raw stack.
  it("turns the close service REFUSING to report into a reason, not a stack trace", () => {
    const refusal = preflightRefusal({
      ...clean, preliminaryError: "The prior period 2026-08 is not closed",
    });
    expect(refusal).toMatch(/refuses to report on 2026-08 at all/);
    expect(refusal).toMatch(/The prior period 2026-08 is not closed/);
    expect(refusal).toMatch(/npm run db:reset/);
  });

  it("says the batch and variance figures were not computed rather than reporting them as clean", () => {
    // They are the probe's zero defaults in this state. Printing "0 unposted, variance 0" beside a
    // refusal to report would be the same lie in a smaller font.
    const refusal = preflightRefusal({ ...clean, preliminaryError: "The prior period 2026-07 is not closed" });
    expect(refusal).toMatch(/were NOT computed and are not being reported/);
    expect(refusal!.split("\n  - ")).toHaveLength(2);   // the header plus exactly one reason
  });

  // Finding 1 (minor). `readinessGaps.length === 0` is close-month-end's FOURTH plant-wide
  // assertion and was the one the pre-flight did not hoist.
  it("refuses ambient GL-export readiness gaps, and names them", () => {
    const refusal = preflightRefusal({
      ...clean,
      readinessGaps: ["Invoice 1042 has a line with no GL account — unlock and re-finalize it"],
    });
    expect(refusal).toMatch(/1 GL-export readiness gap/);
    expect(refusal).toMatch(/Invoice 1042/);
  });

  it("caps the named gaps rather than printing a hundred of them, and says how many it hid", () => {
    const gaps = Array.from({ length: 8 }, (_, i) => `Invoice ${1000 + i} has a line with no GL account`);
    const refusal = preflightRefusal({ ...clean, readinessGaps: gaps });
    expect(refusal).toMatch(/8 GL-export readiness gap/);
    expect(refusal).toMatch(/and 3 more/);
  });

  // Finding 4 (minor). `runDbScript` returns null when the probe printed nothing, and the old
  // signature destructured it — a TypeError inside the harness instead of a diagnosis.
  it("diagnoses a probe that answered with nothing instead of throwing a TypeError", () => {
    for (const bad of [null, undefined]) {
      const refusal = preflightRefusal(bad);
      expect(refusal).toMatch(/produced no readable answer/);
      expect(refusal).toMatch(/npx tsx e2e\/lib\/db-fixtures\.ts preflight/);
    }
  });

  it("still passes a clean probe that predates the two new fields", () => {
    // The probe and the policy ship together, but the policy must not depend on that: both new
    // fields default, so an older answer reads as clean rather than as a crash.
    expect(preflightRefusal({ year: 2026, month: 8, closePeriodStatus: null, unpostedBatchCount: 0, variance: 0 }))
      .toBeNull();
  });
});

// #167a fix round. The two sweeps in `e2e/lib/flow-lint.mjs` answer the question the retry gate
// does not: can a GREEN run be green while the thing it asserts is broken? Both shapes below were
// found in code that had already been reviewed, and both PASS rather than fail — which is why
// neither can be left to a census by hand. Enforced twice, the `findRawApiMutations` precedent:
// `run.mjs` refuses before flow 1, and the corpus sweeps at the bottom of each block run centrally.
describe("findAmbientRowLocators", () => {
  it("finds a board row locator taken off `page` and filtered by an order number", () => {
    const src = 'a\nconst row = page.locator("tr", { hasText: String(created.orderNumber) });\n';
    const found = findAmbientRowLocators(src);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
  });

  it("finds every unscoped row shape, including the tbody and role forms", () => {
    expect(findAmbientRowLocators('page.locator("tbody tr").filter({ hasText: String(order.number) });')).toHaveLength(1);
    expect(findAmbientRowLocators('page.locator("table tbody tr", { hasText: `${orderNumber}` });')).toHaveLength(1);
    expect(findAmbientRowLocators('page.getByRole("row", { name: String(orderNumber) });')).toHaveLength(1);
  });

  it("reads the whole STATEMENT, so a chained multi-line locator cannot hide the filter", () => {
    const src = 'const r = page.locator("tr")\n  .filter({ has: page.getByText(String(order.number), { exact: true }) });\n';
    expect(findAmbientRowLocators(src)).toHaveLength(1);
  });

  it("leaves a SCOPED row locator alone — that family is narrower and was left as found-not-fixed", () => {
    expect(findAmbientRowLocators(
      'readySection.locator("tr").filter({ has: page.getByText(String(order.number), { exact: true }) });',
    )).toEqual([]);
    expect(findAmbientRowLocators('receivables.locator("tbody tr").filter({ hasText: String(order.number) }).first();'))
      .toEqual([]);
  });

  it("leaves an unscoped row locator alone when it filters on something no other column prints", () => {
    // invoice-shipped-order's surcharge row and close-month-end's payment row: correct as written.
    expect(findAmbientRowLocators('page.locator("tr").filter({ has: page.locator("td", { hasText: "Surcharge" }) });'))
      .toEqual([]);
    expect(findAmbientRowLocators('page.locator("tr").filter({ has: page.getByText(fixtures.closePaymentTypeName) });'))
      .toEqual([]);
  });

  it("over-matches rather than under-matches: it fails CLOSED on a commented-out locator", () => {
    // The `findRawApiMutations` rule. The escape hatch is boardRow(), never a comment — which is
    // why board-search-scan.mjs describes the old shape in prose instead of quoting it.
    expect(findAmbientRowLocators('// const row = page.locator("tr", { hasText: String(orderNumber) });'))
      .toHaveLength(1);
  });

  it("every swept suite source uses boardRow today (flows AND the lib helpers, #192)", () => {
    expect(sweptSources().length).toBeGreaterThan(0);
    expect(sweep(findAmbientRowLocators)).toEqual([]);
  });
});

describe("findUncheckedAbsenceAssertions", () => {
  it("finds assert.rejects wrapped around a waitFor — the false-green absence assertion", () => {
    const src = 'x\nawait assert.rejects(\n  row.waitFor({ state: "visible", timeout: 1500 }),\n  "gone",\n);\n';
    const found = findUncheckedAbsenceAssertions(src);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
  });

  it("leaves assert.rejects around anything that is not a waitFor alone", () => {
    // Only the waitFor pairing can launder a strict-mode violation into a pass: "no such element"
    // and "several such elements" both reject there. A route that must 403 is a different thing.
    expect(findUncheckedAbsenceAssertions('await assert.rejects(lockRevision(id, 2), /409/);')).toEqual([]);
  });

  it("leaves the sanctioned helper alone", () => {
    expect(findUncheckedAbsenceAssertions('await assertNeverVisible(row, "should be gone", 500);')).toEqual([]);
  });

  it("over-matches rather than under-matches: it fails CLOSED on a commented-out assertion", () => {
    expect(findUncheckedAbsenceAssertions('// await assert.rejects(row.waitFor({ state: "visible" }));'))
      .toHaveLength(1);
  });

  it("every swept suite source states absence through assertNeverVisible today (flows AND lib, #192)", () => {
    expect(sweptSources().length).toBeGreaterThan(0);
    expect(sweep(findUncheckedAbsenceAssertions)).toEqual([]);
  });
});

// #193. The third false-green shape: a code-less Error minted as a flow failure carries no
// ERR_ASSERTION code, so classifyFailure's hard override (above) does not cover it and a stale
// netFailure earlier in the flow can launder it into FAIL [network] and a granted retry.
describe("findPlainErrorFailures", () => {
  it("finds a throw new Error, with its line number", () => {
    const src = 'line one\nif (!x) throw new Error("boom");\nline three\n';
    const found = findPlainErrorFailures(src);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
  });

  it("finds any built-in Error subclass, not just Error", () => {
    expect(findPlainErrorFailures('throw new TypeError("x")')).toHaveLength(1);
    expect(findPlainErrorFailures('throw new RangeError("x")')).toHaveLength(1);
  });

  it("finds the no-`new` and QUALIFIED forms too — all mint the identical code-less Error", () => {
    // Fails CLOSED on every equivalent idiom (Codex round 1, P1/P2).
    expect(findPlainErrorFailures('if (!x) throw Error("boom")')).toHaveLength(1);
    expect(findPlainErrorFailures('throw TypeError("x")')).toHaveLength(1);
    expect(findPlainErrorFailures('throw new globalThis.Error("x")')).toHaveLength(1);
    expect(findPlainErrorFailures('throw new errors.TimeoutError("x")')).toHaveLength(1);
    // ...but `throwError(...)` (a function call, no space) is not a throw statement.
    expect(findPlainErrorFailures("throwError(msg)")).toEqual([]);
  });

  it("finds a code-less Error delivered through a promise `reject(...)` (Codex round 2, P2)", () => {
    // A dialog handler that `reject(new Error(...))`s reaches classifyFailure with the same code-less
    // Error a throw would — so the sweep covers the reject verb too.
    expect(findPlainErrorFailures("reject(new Error(`got ${type}`))")).toHaveLength(1);
    expect(findPlainErrorFailures(".finally(() => reject(new Error(msg)))")).toHaveLength(1);
    expect(findPlainErrorFailures("Promise.reject(new TypeError(msg))")).toHaveLength(1);
  });

  it("leaves an AssertionError alone — the sanctioned promise-side fix carries ERR_ASSERTION", () => {
    expect(findPlainErrorFailures("reject(new assert.AssertionError({ message: msg }))")).toEqual([]);
    expect(findPlainErrorFailures("throw new AssertionError({ message: msg })")).toEqual([]);
  });

  it("leaves a re-raise alone — `throw err` / `reject(err)` preserve the original classification", () => {
    // assertNeverVisible re-throws a transport error untouched so the harness still sees it as
    // itself; only a freshly minted code-less Error is the problem.
    expect(findPlainErrorFailures("try { a(); } catch (err) { throw err; }")).toEqual([]);
    expect(findPlainErrorFailures("dialog.accept().catch((err) => reject(err))")).toEqual([]);
  });

  it("leaves the sanctioned replacements alone", () => {
    expect(findPlainErrorFailures('assert.fail("boom")')).toEqual([]);
    expect(findPlainErrorFailures('assert.ok(match, "could not parse")')).toEqual([]);
  });

  it("over-matches rather than under-matches: it fails CLOSED on a commented-out throw", () => {
    expect(findPlainErrorFailures('// throw new Error("disabled for now")')).toHaveLength(1);
  });

  it("every swept suite source delivers failures through node:assert today (flows AND lib, #193)", () => {
    expect(sweptSources().length).toBeGreaterThan(0);
    expect(sweep(findPlainErrorFailures)).toEqual([]);
  });
});

// #192. The file set the sweeps read is the SHARED one from suite-sources.mjs — flows AND lib, minus
// the two detector modules — so a bad locator/mutation/absence/throw written into a shared helper is
// caught, and the same population is refused at both enforcement points.
describe("suiteSourcesSync (the swept file set, #192)", () => {
  const sources = suiteSourcesSync(E2E_DIR);
  const rels = sources.map((s) => s.relPath);

  it("includes the flow files AND the lib helpers", () => {
    expect(rels).toContain("flows/order-entry-full.mjs");
    // The two homes of the sanctioned helpers a bad edit would slip into — the whole point of #192.
    expect(rels).toContain("lib/orders.mjs"); // boardRow
    expect(rels).toContain("lib/ui.mjs"); // assertNeverVisible
  });

  it("excludes ONLY the two detector modules, which hold the patterns as literals", () => {
    expect(rels).not.toContain("lib/flow-lint.mjs");
    expect(rels).not.toContain("lib/failure-classify.mjs");
    // Nothing else is excluded — e.g. the lister itself is swept.
    expect(rels).toContain("lib/suite-sources.mjs");
  });

  it("carries each file's source, keyed by an e2e-relative path a refusal can print", () => {
    const ui = sources.find((s) => s.relPath === "lib/ui.mjs");
    expect(ui?.source).toContain("assertNeverVisible");
  });
});

// #190. The two harness OUTPUT surfaces the CI `e2e` job's retry gate reads
// (.github/workflows/ci.yml, "Check for retried flows"). Pinned against the literal shapes CI globs
// and greps, so a rename in run.mjs reds a test here rather than silently narrowing that gate to the
// case it happens still to match. Detector 1 globs `e2e-artifacts/*__attempt-*`; detector 2 greps
// `^  RETRIED `.
describe("attemptDir / resultsLine (the CI retry-gate surfaces, #190)", () => {
  // Read the WORKFLOW itself and validate the helpers against IT (Codex P2), not against separately
  // hard-coded copies of its glob/grep — otherwise a change to ci.yml's retry detection would leave
  // these green while silently disabling the gate. The pin is now bidirectional: rename the helper
  // OR change the workflow's glob/grep, and this reds.
  const ci = readFileSync(path.join(process.cwd(), "..", ".github", "workflows", "ci.yml"), "utf8");

  it("the workflow's retry glob still matches the directory attemptDir mints for a retry", () => {
    // Detector 1: `granted=(e2e-artifacts/<glob>)`. Extract <glob> from the workflow.
    const m = ci.match(/granted=\(e2e-artifacts\/([^)\s]+)\)/);
    expect(m, "ci.yml no longer has the `granted=(e2e-artifacts/...)` retry glob").toBeTruthy();
    const glob = m![1]; // e.g. *__attempt-*
    const asRegex = new RegExp("^" + glob.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    expect(attemptDir("void-order", 2)).toMatch(asRegex);
    // ...and a first attempt (the bare dir) must NOT match it, or every clean run would look retried.
    expect(attemptDir("void-order", 1)).not.toMatch(asRegex);
  });

  it("the workflow's RETRIED grep still matches the line resultsLine prints for a retry", () => {
    // Detector 2: `grep -qE '<pattern>'`. Extract the pattern that mentions RETRIED.
    const m = ci.match(/grep -qE '([^']*RETRIED[^']*)'/);
    expect(m, "ci.yml no longer greps for a RETRIED line").toBeTruthy();
    const grep = new RegExp(m![1]);
    expect(resultsLine({ name: "close-month-end", ok: true, retried: true })).toMatch(grep);
    // A plain PASS and a FAIL must NOT match that grep, or the gate would fire on every run.
    expect(resultsLine({ name: "quotes", ok: true, retried: false })).not.toMatch(grep);
    expect(resultsLine({ name: "void-order", ok: false, retried: false, kind: "assertion", committed: 0, indeterminate: 0 })).not.toMatch(grep);
  });

  it("attempt 1 keeps the bare directory; a retry gets its own sibling", () => {
    expect(attemptDir("void-order", 1)).toBe("void-order");
    expect(attemptDir("void-order", 2)).toBe("void-order__attempt-2");
  });

  it("never prints a retried flow as a plain PASS, and a failure reads FAIL with its reason", () => {
    expect(resultsLine({ name: "quotes", ok: true, retried: false }).startsWith("  PASS   ")).toBe(true);
    const failed = resultsLine({ name: "void-order", ok: false, retried: false, kind: "assertion", committed: 0, indeterminate: 0 });
    expect(failed.startsWith("  FAIL   ")).toBe(true);
    expect(failed).toMatch(/assertion-level/);
  });
});
