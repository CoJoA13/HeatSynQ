import { describe, it, expect, afterEach } from "vitest";
import { beginWrite, writesInFlight, isWriteMethod } from "@/lib/in-flight-writes";
import { trackedFetch, api, ApiError } from "@/lib/fetcher";

// The counter behind the truthful navigation prompt (#276), and its one consumer, `trackedFetch`.
//
// The registry is module-level and shared across this file, exactly like `unsaved-guard.test.ts`'s:
// there is no exported reset, deliberately — a test-only back door into state the Shell reads is
// worse than each test cleaning up after itself. So every test here ends at zero, and the
// `afterEach` asserts that rather than assuming it, which is what stops one leaked write from
// turning every later assertion in the file into a different question.

afterEach(() => {
  expect(writesInFlight(), "a test leaked an unfinished write into the next one").toBe(0);
});

describe("the in-flight write counter", () => {
  it("starts at zero and returns there", () => {
    expect(writesInFlight()).toBe(0);
    const end = beginWrite();
    expect(writesInFlight()).toBe(1);
    end();
    expect(writesInFlight()).toBe(0);
  });

  it("counts concurrent writes independently, so one settling does not clear the other", () => {
    // The case that matters on the order hub: two grids saved in quick succession. If the counter
    // were a boolean, the first response would report "nothing in flight" while the second was
    // still committing, and the prompt would go back to offering to discard it.
    const a = beginWrite();
    const b = beginWrite();
    expect(writesInFlight()).toBe(2);
    a();
    expect(writesInFlight()).toBe(1);
    b();
    expect(writesInFlight()).toBe(0);
  });

  it("makes the ender IDEMPOTENT, so a double release cannot drive the count negative", () => {
    // Load-bearing, not defensive. A caller that releases in a `finally` and also on its own error
    // path would decrement twice, and a negative count reads as "no writes in flight" while one
    // still is — the guard failing silently OPEN, which is the direction this exists to prevent.
    const a = beginWrite();
    const b = beginWrite();
    a();
    a();
    a();
    expect(writesInFlight(), "the extra releases must not touch the other write").toBe(1);
    b();
    expect(writesInFlight()).toBe(0);
  });

});

describe("isWriteMethod", () => {
  it("counts the four methods that change server state", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(isWriteMethod(m), m).toBe(true);
  });

  it("is case-insensitive, because RequestInit takes the method as a free string", () => {
    expect(isWriteMethod("post")).toBe(true);
    expect(isWriteMethod("Delete")).toBe(true);
  });

  it("treats a missing method as the GET it is, not as an unknown", () => {
    // The fetch default, not a guess — and the reason a read never arms the prompt's second arm.
    expect(isWriteMethod(undefined)).toBe(false);
    expect(isWriteMethod("GET")).toBe(false);
    expect(isWriteMethod("HEAD")).toBe(false);
  });
});

/**
 * `trackedFetch` is the whole coverage story: every client write in `src/` goes through it or
 * through `api()`, which is built on it. These stub the global `fetch` by plain property
 * save/restore — the repo's stubbing idiom (never `vi.spyOn` a shared object, since `mockRestore`
 * does not reliably put the original back).
 */
describe("trackedFetch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  /** Replaces `fetch` with one that records the count AT REQUEST-ISSUE and the arguments it was
   *  handed. Deliberately NOT described as mid-flight: it samples synchronously, so it cannot tell a
   *  count that is held for the request's lifetime from one raised and dropped in the same tick.
   *  That distinction is what "holds the count while the request is genuinely PENDING" below is for
   *  — a reviewer deleted `trackedFetch`'s `await` and every test here stayed green. */
  function stubFetch(
    seen: number[], outcome: "resolve" | "reject", body: unknown = {},
    calls: { path: unknown; init: RequestInit | undefined }[] = [],
  ): void {
    globalThis.fetch = (async (path: unknown, init?: RequestInit) => {
      seen.push(writesInFlight());
      calls.push({ path, init });
      await Promise.resolve();
      if (outcome === "reject") throw new Error("network down");
      return new Response(JSON.stringify(body), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  it("holds the count while the request is genuinely PENDING, not merely around the call", async () => {
    // THE TEST THE OTHERS CANNOT REPLACE. `trackedFetch` releases in a `finally`, which only spans
    // the request because the call is AWAITED — drop that one `await` and the `finally` runs at
    // request-issue, the count is raised for zero async ticks, and `confirmDiscard` (which reads it
    // from a click handler while the response is outstanding) sees nothing in flight. A reviewer made
    // exactly that edit and all fourteen tests here passed. It looks like the redundant `return
    // await` some lint rules flag, so it is the change somebody plausibly makes.
    let release!: (r: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { release = resolve; })) as typeof fetch;
    const pending = trackedFetch("/api/x", { method: "POST" });
    await Promise.resolve();
    await Promise.resolve();
    expect(writesInFlight(), "raised WHILE the response is still outstanding").toBe(1);
    release(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    await pending;
    expect(writesInFlight()).toBe(0);
  });

  it("passes the path and init through untouched, on the write path and the read path", async () => {
    // The indirection is new, and nothing else here would notice if it dropped its arguments: a
    // reviewer changed the write branch to `fetch(path)` — sending every write in the app as a
    // bodyless GET — and all seventeen tests passed. `api()`'s json content-type is asserted too,
    // because `AttachmentsSection` deliberately overrides it and would break silently.
    const calls: { path: unknown; init: RequestInit | undefined }[] = [];
    stubFetch([], "resolve", {}, calls);
    await trackedFetch("/api/w", { method: "POST", body: "payload" });
    await trackedFetch("/api/r");
    await api("/api/a", { method: "PUT", body: "{}" });
    expect(calls[0].path).toBe("/api/w");
    expect(calls[0].init).toMatchObject({ method: "POST", body: "payload" });
    expect(calls[1].path, "the read path forwards its arguments too").toBe("/api/r");
    expect(calls[2].init).toMatchObject({
      method: "PUT", body: "{}", headers: { "content-type": "application/json" },
    });
  });

  it("counts a write for as long as the request is actually in flight", async () => {
    const seen: number[] = [];
    stubFetch(seen, "resolve");
    await trackedFetch("/api/x", { method: "POST" });
    expect(seen, "the count must be raised while the request is open").toEqual([1]);
    expect(writesInFlight()).toBe(0);
  });

  it("releases the count when the request REJECTS, not only when it resolves", async () => {
    // The stuck-guard case: a dropped connection must not leave the prompt permanently saying a
    // save is running. Without the `finally` this is the shape that would leak.
    const seen: number[] = [];
    stubFetch(seen, "reject");
    await expect(trackedFetch("/api/x", { method: "DELETE" })).rejects.toThrow("network down");
    expect(seen).toEqual([1]);
    expect(writesInFlight()).toBe(0);
  });

  it("does not count a read", async () => {
    const seen: number[] = [];
    stubFetch(seen, "resolve");
    await trackedFetch("/api/x");
    await trackedFetch("/api/x", { headers: {} });
    expect(seen, "neither call is a write").toEqual([0, 0]);
  });

  it("counts a lowercase method, which a caller may legally write", async () => {
    const seen: number[] = [];
    stubFetch(seen, "resolve");
    await trackedFetch("/api/x", { method: "post" });
    expect(seen).toEqual([1]);
  });

  it("counts every write issued through api(), which is how 150-odd call sites are covered", async () => {
    const seen: number[] = [];
    stubFetch(seen, "resolve", { ok: true });
    await api("/api/x", { method: "PUT", body: "{}" });
    expect(seen).toEqual([1]);
    expect(writesInFlight()).toBe(0);
  });

  it("releases the count on a FAILED api() call, where the throw happens after the fetch settles", async () => {
    // `api()` reads the body and throws ApiError on a non-OK status — after `trackedFetch` has
    // already released. Pinned because the release and the throw are in different functions, which
    // is exactly where a leak would hide.
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "nope" }), {
      status: 400, headers: { "content-type": "application/json" },
    })) as typeof fetch;
    await expect(api("/api/x", { method: "POST" })).rejects.toBeInstanceOf(ApiError);
    expect(writesInFlight()).toBe(0);
  });
});
