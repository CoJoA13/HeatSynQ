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
