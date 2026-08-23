import { describe, it, expect, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyFailure,
  retryRefusal,
  isSessionEndpoint,
  findRawApiMutations,
} from "../e2e/lib/failure-classify.mjs";
import { enumerateRoutes, warmupRefusal } from "../e2e/lib/warmup.mjs";
import { preflightRefusal } from "../e2e/lib/preflight.mjs";
import { findAmbientRowLocators, findUncheckedAbsenceAssertions } from "../e2e/lib/flow-lint.mjs";

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

  // The guard itself, run centrally rather than only at harness startup.
  it("every e2e flow is clean today", () => {
    const flowsDir = path.join(process.cwd(), "e2e", "flows");
    const files = readdirSync(flowsDir).filter((f) => f.endsWith(".mjs"));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((file) =>
      findRawApiMutations(readFileSync(path.join(flowsDir, file), "utf8"))
        .map((f) => `${file}:${f.line} ${f.snippet}`),
    );
    expect(offenders).toEqual([]);
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

  it("says nothing about an empty route set", () => {
    expect(warmupRefusal({ count: 0, failures: [], skipped: 0, budgetMs })).toBeNull();
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
  const clean = { year: 2026, month: 8, closePeriodStatus: null, unpostedBatchCount: 0, variance: 0 };

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

  it("every e2e flow uses boardRow today", () => {
    const flowsDir = path.join(process.cwd(), "e2e", "flows");
    const files = readdirSync(flowsDir).filter((f) => f.endsWith(".mjs"));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((file) =>
      findAmbientRowLocators(readFileSync(path.join(flowsDir, file), "utf8"))
        .map((f) => `${file}:${f.line} ${f.snippet}`),
    );
    expect(offenders).toEqual([]);
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

  it("every e2e flow states absence through assertNeverVisible today", () => {
    const flowsDir = path.join(process.cwd(), "e2e", "flows");
    const files = readdirSync(flowsDir).filter((f) => f.endsWith(".mjs"));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((file) =>
      findUncheckedAbsenceAssertions(readFileSync(path.join(flowsDir, file), "utf8"))
        .map((f) => `${file}:${f.line} ${f.snippet}`),
    );
    expect(offenders).toEqual([]);
  });
});
