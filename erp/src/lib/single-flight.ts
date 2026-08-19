// Single-flight: at most one invocation of `fn` runs at a time per wrapper; a call issued while
// one is in flight JOINS it — it receives the very same promise — instead of starting a second
// run. The slot clears when the flight settles, on rejection as much as resolution, so one failed
// run can never wedge the wrapper; the next call after settlement runs fresh. The joiner contract
// is deliberate: a joined caller sees the running flight's outcome — its rejection included —
// because "the work was done once, and this is how it ended" is the whole promise being shared.
//
// Pure and dependency-free (the drain-queue.ts leaf shape). Lives in the shared layer so server
// code may use it: #111's practice reset serializes its concurrent callers with a module-scoped
// wrapper instead of a connection-pinning advisory-lock transaction (see practice-reset.ts for
// the process-model rationale).
//
// `fn` must return a promise. A SYNCHRONOUS throw from `fn` propagates synchronously to the one
// caller that triggered it and leaves the slot clear — nothing was ever in flight to join.
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () =>
    (inFlight ??= fn().finally(() => {
      inFlight = null;
    }));
}
