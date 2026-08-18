import { describe, it, expect } from "vitest";
import { drainOtherKeys } from "@/lib/drain-queue";

// Group D Task 7: the §5.13 rollback-drain for the mutation-gate detail pages. A failed save's
// rollback `load()` takes the NEWEST mutation ticket, so its GET served before a SIBLING key's
// in-flight PATCH commits would revert that sibling's committed write on screen (the sibling's
// own response then drops as older-ticketed). The drain waits out every OTHER key's chain tail
// before the GET dispatches — and must NEVER await the own key's tail, because the failing
// save's catch runs INSIDE that very chain (awaiting yourself is a deadlock, and a deadlock
// here is a test timeout). Pure module driven by hand-resolved deferreds — the
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

  it("skips the own key — its chain tail is never awaited (no deadlock)", async () => {
    // Never resolved: the catch the drain is called from runs INSIDE this chain, so awaiting it
    // would hang forever. The drain must return anyway.
    const own = deferred();
    const queue = new Map<string, Promise<unknown>>([["a", own.promise]]);
    await drainOtherKeys(queue, "a");
  });

  it("waits out another key's in-flight chain", async () => {
    const b = deferred();
    const queue = new Map<string, Promise<unknown>>([["b", b.promise]]);
    let done = false;
    const drain = drainOtherKeys(queue, "a").then(() => { done = true; });
    await flush();
    expect(done).toBe(false); // sibling still in flight — the GET must not dispatch yet
    b.resolve();
    await drain;
    expect(done).toBe(true);
  });

  it("waits out siblings while still skipping the pending own key", async () => {
    const own = deferred(); // stays pending forever
    const b = deferred();
    const queue = new Map<string, Promise<unknown>>([["a", own.promise], ["b", b.promise]]);
    let done = false;
    const drain = drainOtherKeys(queue, "a").then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    b.resolve(); // only the sibling needs to settle
    await drain;
    expect(done).toBe(true);
  });

  it("a rejecting sibling chain releases the drain (allSettled, never all)", async () => {
    const b = deferred();
    const queue = new Map<string, Promise<unknown>>([["b", b.promise]]);
    const drain = drainOtherKeys(queue, "a");
    b.reject(new Error("sibling PATCH failed"));
    await drain; // must resolve, not reject — the drain orders the GET, it doesn't judge siblings
  });

  it("re-drains a chain extended during the wait — the park is itself a save window", async () => {
    const b1 = deferred();
    const queue = new Map<string, Promise<unknown>>([["b", b1.promise]]);
    let done = false;
    const drain = drainOtherKeys(queue, "a").then(() => { done = true; });
    await flush();
    // A new save on "b" queues behind the first while the drain sits on allSettled…
    const b2 = deferred();
    queue.set("b", b2.promise);
    b1.resolve();
    await flush();
    // …so the drain must not release on the OLD tail alone: b2's PATCH could still commit after
    // the rollback GET is served, which is the exact reversion the drain exists to prevent.
    expect(done).toBe(false);
    b2.resolve();
    await drain;
    expect(done).toBe(true);
  });
});
