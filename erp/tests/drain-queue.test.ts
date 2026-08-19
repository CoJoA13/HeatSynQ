import { describe, it, expect } from "vitest";
import { drainOtherKeys } from "@/lib/drain-queue";

// Group D Task 7: the §5.13 rollback-drain for the mutation-gate detail pages. A failed save's
// rollback `load()` takes the NEWEST mutation ticket, so its GET served before a SIBLING key's
// in-flight PATCH commits would revert that sibling's committed write on screen (the sibling's
// own response then drops as older-ticketed). The drain waits out every OTHER key's in-flight
// REQUEST before the GET dispatches. Fix round 1 (review CRITICAL): the map handed to the drain
// is the pages' request-settled SIGNAL map — registered at dispatch, settling with the request —
// NEVER the serial() chain-tail map: a tail settles only after its own catch (drain included)
// completes, so two failing keys draining each other's tails deadlock mutually (the
// mutual-failure case below). Pure module driven by hand-resolved deferreds — the
// save-scope.test.ts recipe (vitest runs `environment: "node"`).

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// One macrotask drains every microtask chain reachable from the deferreds resolved so far.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("drainOtherKeys", () => {
  it("resolves immediately on an empty queue", async () => {
    await drainOtherKeys(new Map(), "a");
  });

  it("skips the own key — its entry is never awaited (no deadlock)", async () => {
    // Never resolved: under the signals contract the own entry is settled by the time the catch
    // drains (the own request just failed — that is why the catch is running), but the helper
    // must not DEPEND on that: an own entry that never settles still must not wedge the drain.
    const own = deferred();
    const signals = new Map<string, Promise<unknown>>([["a", own.promise]]);
    await drainOtherKeys(signals, "a");
  });

  it("waits out another key's in-flight request", async () => {
    const b = deferred();
    const signals = new Map<string, Promise<unknown>>([["b", b.promise]]);
    let done = false;
    const drain = drainOtherKeys(signals, "a").then(() => { done = true; });
    await flush();
    expect(done).toBe(false); // sibling still in flight — the GET must not dispatch yet
    b.resolve();
    await drain;
    expect(done).toBe(true);
  });

  it("waits out siblings while still skipping the pending own key", async () => {
    const own = deferred(); // stays pending forever
    const b = deferred();
    const signals = new Map<string, Promise<unknown>>([["a", own.promise], ["b", b.promise]]);
    let done = false;
    const drain = drainOtherKeys(signals, "a").then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    b.resolve(); // only the sibling needs to settle
    await drain;
    expect(done).toBe(true);
  });

  it("a rejecting sibling request releases the drain (allSettled, never all)", async () => {
    const b = deferred();
    const signals = new Map<string, Promise<unknown>>([["b", b.promise]]);
    const drain = drainOtherKeys(signals, "a");
    b.reject(new Error("sibling PATCH failed"));
    await drain; // must resolve, not reject — the drain orders the GET, it doesn't judge siblings
  });

  // Fix round 1 (review CRITICAL): the existing "skips own key" case models only ONE side of the
  // cycle. Two saves on DIFFERENT keys both failing while overlapping is ordinary use (one
  // network blip rejects both in-flight PATCHes), and a drain fed the serial() chain-TAIL map
  // deadlocks mutually: a key's tail settles only after its own catch (drain included) completes,
  // so A's catch awaits B's tail awaits A's tail — no rollback, no error banner, both queues
  // permanently wedged. The pages therefore hand the drain a second map of REQUEST-settled
  // signals, registered at dispatch: a signal settles with the request itself — which IS the
  // commit/failure the rollback GET must postdate — and never depends on a drain.
  it("mutual failure across two keys — both drains resolve, both rollbacks dispatch, both errors report", async () => {
    // Harness cloning the pages' wiring: the verbatim serial() queue for ordering, plus the
    // dispatch-time signal registration the fix adds. The catch drains the SIGNALS, never the
    // queue tails.
    const chain = new Map<string, Promise<unknown>>();
    const signals = new Map<string, Promise<unknown>>();
    function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = chain.get(key) ?? Promise.resolve();
      const next = prev.then(fn, fn);
      chain.set(key, next.catch(() => {}));
      return next;
    }
    const state = { rollbacks: [] as string[], errors: [] as string[] };
    function failingSave(key: string, req: Promise<void>) {
      return serial(key, async () => {
        try {
          signals.set(key, req.then(() => {}, () => {})); // registered at dispatch
          await req;
        } catch (e) {
          await drainOtherKeys(signals, key);
          state.rollbacks.push(key); // stands in for the §5.13 rollback load()
          state.errors.push((e as Error).message);
        }
      });
    }
    const a = deferred();
    const b = deferred();
    const saveA = failingSave("poNumber", a.promise);
    const saveB = failingSave("notes", b.promise);
    a.reject(new Error("network A"));
    b.reject(new Error("network B"));
    await flush();
    await flush();
    // A deadlock shows here as empty arrays, not as a test timeout.
    expect(state.rollbacks.sort()).toEqual(["notes", "poNumber"]);
    expect(state.errors.sort()).toEqual(["network A", "network B"]);
    // And both chain tails must have settled — later saves on these keys chain behind them.
    await Promise.allSettled([saveA, saveB]);
  });

  it("re-drains a signal replaced during the wait — the park is itself a save window", async () => {
    const b1 = deferred();
    const signals = new Map<string, Promise<unknown>>([["b", b1.promise]]);
    let done = false;
    const drain = drainOtherKeys(signals, "a").then(() => { done = true; });
    await flush();
    // A new save on "b" dispatches while the drain sits on allSettled, registering a fresh
    // request signal under its key…
    const b2 = deferred();
    signals.set("b", b2.promise);
    b1.resolve();
    await flush();
    // …so the drain must not release on the OLD signal alone: b2's PATCH could still commit
    // after the rollback GET is served, which is the exact reversion the drain exists to prevent.
    expect(done).toBe(false);
    b2.resolve();
    await drain;
    expect(done).toBe(true);
  });
});
