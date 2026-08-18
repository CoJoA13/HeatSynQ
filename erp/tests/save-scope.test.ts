import { describe, it, expect } from "vitest";
import { makeSaveScope, type SaveScope } from "@/lib/save-scope";

// Issues #3 (customers detail) and #15 (parts detail): the failed-save rollback clobber. The
// optimistic set happens at save() CALL time, outside the per-key serial() queue, so a §5.13
// rollback reload fired by an EARLIER save's failure can resolve carrying server truth that
// predates a save still in flight — applying it reverts the newer save's value on screen while
// that save then commits server-side without ever reapplying. Pure module driven by
// hand-resolved deferreds (vitest runs `environment: "node"`; the submitWithConflictRetry /
// makeLatestGate precedent), with a REAL clone of the pages' serial() per-key queue so the
// detached-rollback contract is proven deadlock-free: a deadlock here is a test timeout.

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// One macrotask drains every microtask chain reachable from the deferreds resolved so far —
// serial()'s settlement chaining, allSettled parking, and begin()'s cleanup are all microtasks.
const flush = () => new Promise((r) => setTimeout(r, 0));

type Data = Record<string, string>;

/**
 * A minimal clone of the two detail pages' state machinery, wired to the scope under test the
 * way the pages themselves are (brief Task 2): optimistic set at save call time OUTSIDE the
 * queue; the PUT runs inside the pages' verbatim serial() per-key chain; begin() registers the
 * chain tail; the catch sets the error and fires the rollback reload WITHOUT awaiting it; the
 * rollback apply does NOT clear the error (§5.13), the ordinary load's apply does.
 */
function makeHarness(scope: SaveScope, initial: Data) {
  const server: Data = { ...initial };
  const state = { data: { ...initial } as Data, error: null as string | null, applies: 0 };

  const queue = new Map<string, Promise<unknown>>();
  function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = queue.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    queue.set(key, next.catch(() => {}));
    return next;
  }

  const gets: Array<Deferred<Data>> = [];
  const fetchData = () => {
    const d = deferred<Data>();
    gets.push(d);
    return d.promise;
  };
  const load = () => scope.reload(fetchData, (v) => { state.data = v; state.error = null; state.applies++; });
  const rollbackLoad = () => scope.reload(fetchData, (v) => { state.data = v; state.applies++; });

  function save(key: string, value: string) {
    state.data = { ...state.data, [key]: value };
    const put = deferred();
    const settled = serial(key, async () => {
      try {
        await put.promise;
        state.error = null;
        return true;
      } catch (e) {
        state.error = (e as Error).message;
        void rollbackLoad().catch(() => {});
        return false;
      }
    });
    scope.begin(settled);
    return { put, settled };
  }

  return {
    state,
    server,
    save,
    load,
    /** Commit key=value server-side, then resolve the PUT — the order a real server answers in. */
    commit(s: { put: Deferred<void> }, key: string, value: string) {
      server[key] = value;
      s.put.resolve();
    },
    pendingGets: () => gets.length,
    /** Answer the oldest in-flight GET with the server's CURRENT truth. */
    answerGet() {
      const g = gets.shift();
      if (!g) throw new Error("no GET in flight");
      g.resolve({ ...server });
    },
    /** Fail the oldest in-flight GET. */
    rejectGet(e: Error) {
      const g = gets.shift();
      if (!g) throw new Error("no GET in flight");
      g.reject(e);
    },
  };
}

describe("makeSaveScope — the rollback clobber traces", () => {
  // Issue #3's exact same-key sequence: save#1 (v1) fails after save#2 (v2, same key) was queued
  // and optimistically applied. The rollback GET must not surface pre-v1 server truth over v2;
  // once save#2 settles, the re-fetch applies the committed (= optimistic) v2.
  it("#3 same-key: a failing save's rollback cannot revert a newer queued save's value", async () => {
    const scope = makeSaveScope();
    const h = makeHarness(scope, { X: "v0" });

    const s1 = h.save("X", "v1");
    await flush(); // fn1 runs: PUT#1 in flight
    const s2 = h.save("X", "v2");
    expect(h.state.data.X).toBe("v2"); // optimistic, applied at call time, outside the queue

    s1.put.reject(new Error("PUT failed"));
    await flush(); // fn1's catch: error set, rollback reload fired (detached)
    expect(h.state.error).toBe("PUT failed");

    // The rollback GET must be withheld while save#2 is in flight — answering any GET dispatched
    // now would carry pre-v1 truth (X: "v0") and clobber the optimistic v2. The explicit zero
    // pins the settle-defer itself (a dispatch-then-drop implementation would also keep X intact,
    // but would show a pending GET here); the drain loop stays as belt.
    expect(h.pendingGets()).toBe(0);
    while (h.pendingGets()) h.answerGet();
    await flush();
    expect(h.state.data.X).toBe("v2");

    h.commit(s2, "X", "v2"); // save#2 commits server-side
    await expect(s2.settled).resolves.toBe(true);
    await flush(); // the settle-deferred re-fetch dispatches now
    h.server.stamp = "fresh"; // distinguishes "applied the re-fetch" from "never applied"
    expect(h.pendingGets()).toBe(1);
    h.answerGet();
    await flush();

    expect(h.state.data.X).toBe("v2"); // the post-settle re-fetch shows the committed value
    expect(h.state.data.stamp).toBe("fresh"); // and it genuinely applied
    // save#2's own SUCCESS cleared the banner (the pages' setError(null)-on-success), which is
    // the pages' design — §5.13's rollback-apply-never-clears is pinned by the ordinary-failure
    // case below, where nothing else touches the error.
    expect(h.state.error).toBeNull();
    await expect(s1.settled).resolves.toBe(false); // both chains settled — no deadlock
  });

  // Issue #15's cross-key sequence: A's failing save's rollback GET is already in flight when the
  // user toggles B. The GET resolves carrying B's pre-edit value — a save intervened mid-fetch,
  // so its commit may postdate the read — and must be withheld; the re-fetch after B settles
  // shows B's committed value and A's rolled-back one.
  it("#15 cross-key: a rollback GET resolving mid-flight of a sibling save is withheld, then re-fetched", async () => {
    const scope = makeSaveScope();
    const h = makeHarness(scope, { A: "a0", B: "b0" });

    const s1 = h.save("A", "a1");
    await flush();
    s1.put.reject(new Error("A failed"));
    await flush(); // chain A settles; the rollback GET dispatches — nothing else is pending
    expect(h.pendingGets()).toBe(1);

    const s2 = h.save("B", "b1"); // sibling key: independent chain, dispatches immediately
    expect(h.state.data.B).toBe("b1");
    h.answerGet(); // the rollback GET resolves NOW, carrying B's pre-edit value (B: "b0")
    await flush();
    expect(h.state.data.B).toBe("b1"); // withheld — the stale payload must not revert B

    h.commit(s2, "B", "b1");
    await expect(s2.settled).resolves.toBe(true);
    await flush(); // the loop re-fetches once B has settled
    expect(h.pendingGets()).toBe(1);
    h.answerGet();
    await flush();

    expect(h.state.data.A).toBe("a0"); // the failed field rolled back to server truth
    expect(h.state.data.B).toBe("b1"); // the committed sibling survived
    expect(h.state.error).toBeNull(); // B's own success cleared the banner, the pages' design
  });

  // §5.13 regression guard: with NO newer save intervening, the rollback must not be deferred —
  // the GET dispatches as soon as the failed chain settles, applies promptly, and the error set
  // at failure survives the reload (the no-clear apply variant).
  it("ordinary failure: rolls back promptly and the error banner survives the reload", async () => {
    const scope = makeSaveScope();
    const h = makeHarness(scope, { X: "v0" });

    const s1 = h.save("X", "v1");
    await flush();
    s1.put.reject(new Error("PUT failed"));
    await flush();
    expect(h.pendingGets()).toBe(1); // dispatched promptly — the gate must not defer this case
    h.answerGet();
    await flush();

    expect(h.state.data.X).toBe("v0"); // server truth restored
    expect(h.state.error).toBe("PUT failed"); // still on screen
    await expect(s1.settled).resolves.toBe(false);
  });

  // Task 2 review finding R1: the settle-wait park is itself a save window. A reload parked on
  // allSettled must not treat a save that BEGAN during the park as already seen — the epoch is
  // captured before the park, so the intervening bump forces the loop to re-wait (now including
  // the new save's chain) and re-fetch, instead of applying a payload that predates its commit.
  it("a save beginning during the settle-wait park is waited out too", async () => {
    const scope = makeSaveScope();
    const h = makeHarness(scope, { A: "a0", B: "b0" });

    const s1 = h.save("A", "a1");
    await flush(); // PUT#A in flight — any reload now parks on A's chain
    const r = h.load();
    await flush();
    expect(h.pendingGets()).toBe(0); // parked, nothing dispatched

    const s2 = h.save("B", "b1"); // begins DURING the park: optimistic apply + epoch bump
    expect(h.state.data.B).toBe("b1");

    h.commit(s1, "A", "a1"); // A settles → the park resumes; B is still uncommitted
    await flush();
    // Whatever GET the resumed iteration dispatched was issued before B committed — its payload
    // (B: "b0") must be withheld, not applied.
    while (h.pendingGets()) { h.answerGet(); await flush(); }
    expect(h.state.data.B).toBe("b1");

    h.commit(s2, "B", "b1");
    await expect(s2.settled).resolves.toBe(true);
    await flush(); // the re-wait now includes B's chain; with B settled, the re-fetch dispatches
    h.server.stamp = "fresh";
    expect(h.pendingGets()).toBe(1);
    h.answerGet();
    await flush();

    expect(h.state.data.B).toBe("b1");
    expect(h.state.data.stamp).toBe("fresh"); // the reload genuinely completed with fresh truth
    await r;
  });
});

describe("makeSaveScope — reload ordering (the internal latest-gate)", () => {
  // The ticket is taken at reload() CALL time, before any await (the use-latest.ts:40-41 rule):
  // of two overlapping reloads the older one must drop even when its fetch resolves LAST —
  // ordering by arrival is the bug, not the fix.
  it("ticket-before-dispatch: an older reload resolving after a newer one is dropped", async () => {
    const scope = makeSaveScope();
    const h = makeHarness(scope, { X: "v0" });

    const r1 = h.load();
    const r2 = h.load();
    await flush();
    expect(h.pendingGets()).toBe(2);

    h.server.X = "newer";
    h.answerGet(); // r1's GET — issued first, but r1 is already superseded
    await flush();
    expect(h.state.data.X).toBe("v0"); // superseded-reload dropped, not applied
    h.server.X = "newest";
    h.answerGet(); // r2's GET
    await flush();
    expect(h.state.data.X).toBe("newest");
    expect(h.state.applies).toBe(1); // exactly one apply — the stale payload never landed
    await Promise.all([r1, r2]);
  });

  // The F7 rule's other half: a superseded reload's REJECTION must not surface either — its
  // promise resolves quietly instead of letting a stale failure clobber current state (or reach
  // a caller's setError).
  it("gates the rejection path too: a superseded fetch failure is swallowed", async () => {
    const scope = makeSaveScope();
    const h = makeHarness(scope, { X: "v0" });

    const r1 = h.load();
    const r2 = h.load();
    await flush();
    expect(h.pendingGets()).toBe(2);

    h.rejectGet(new Error("network down")); // r1's GET — r1 is superseded, so this must vanish
    await flush();
    await expect(r1).resolves.toBeUndefined(); // resolved quietly, not rejected

    h.server.X = "fresh";
    h.answerGet(); // r2's GET
    await flush();
    expect(h.state.data.X).toBe("fresh");
    await r2;
  });

  it("a lone reload's fetch rejection propagates to the caller", async () => {
    const scope = makeSaveScope();
    let calls = 0;
    const failing = () => { calls++; return Promise.reject(new Error("network down")); };
    await expect(scope.reload(failing, () => { throw new Error("must not apply"); }))
      .rejects.toThrow("network down");
    expect(calls).toBe(1);
  });
});
