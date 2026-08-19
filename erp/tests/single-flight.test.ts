import { describe, it, expect } from "vitest";
import { singleFlight } from "@/lib/single-flight";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A hand-held fn: every invocation records a fresh deferred and returns ITS promise, so promise
 *  identity distinguishes a JOIN (the same object comes back) from a second invocation (a new
 *  gate appears). The test holds each gate open until it decides how that flight ends. */
function trackedFn<T>() {
  const gates: Deferred<T>[] = [];
  const fn = () => {
    const gate = deferred<T>();
    gates.push(gate);
    return gate.promise;
  };
  return { fn, gates };
}

describe("singleFlight (#111 — the practice-reset serialization leaf)", () => {
  it("a call issued WHILE one is in flight JOINS it: same promise, fn invoked once", async () => {
    const { fn, gates } = trackedFn<string>();
    const run = singleFlight(fn);
    const first = run();
    const second = run();
    expect(gates).toHaveLength(1); // fn ran once — the second caller joined, it did not re-run
    expect(second).toBe(first); // literally the same promise object
    gates[0].resolve("baseline");
    await expect(first).resolves.toBe("baseline");
    await expect(second).resolves.toBe("baseline");
  });

  it("resolution clears the slot: a call AFTER completion runs fresh", async () => {
    const { fn, gates } = trackedFn<string>();
    const run = singleFlight(fn);
    const first = run();
    gates[0].resolve("one");
    await first;
    const next = run();
    expect(gates).toHaveLength(2); // a genuinely new invocation, not a stale join
    expect(next).not.toBe(first);
    gates[1].resolve("two");
    await expect(next).resolves.toBe("two");
  });

  it("REJECTION clears the slot: a failed run must not wedge later calls", async () => {
    const { fn, gates } = trackedFn<string>();
    const run = singleFlight(fn);
    const failed = run();
    gates[0].reject(new Error("seed blew up"));
    await expect(failed).rejects.toThrow("seed blew up");
    const retry = run();
    expect(gates).toHaveLength(2); // the slot cleared on rejection — the retry runs fresh
    gates[1].resolve("recovered");
    await expect(retry).resolves.toBe("recovered");
  });

  it("a JOINED caller sees the same rejection as the flight it joined", async () => {
    const { fn, gates } = trackedFn<string>();
    const run = singleFlight(fn);
    const first = run();
    const joined = run();
    expect(joined).toBe(first); // asserted BEFORE rejecting: fails fast (no timeout) if not joined
    const boom = new Error("mid-reset failure");
    gates[0].reject(boom);
    await expect(first).rejects.toBe(boom);
    await expect(joined).rejects.toBe(boom);
  });
});
