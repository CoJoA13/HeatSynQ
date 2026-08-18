"use client";
// Client-safe: no src/server imports. The failed-save rollback clobber, issues #3 (customers
// detail) and #15 (parts detail): an optimistic save applies its value to state at CALL time,
// OUTSIDE the per-key serial() queue, so when an earlier save fails and §5.13 rolls the page
// back to server truth, the rollback GET's payload can predate saves still in flight — applying
// it reverts a value the user already re-typed (same key) or toggled (sibling key), and the
// newer save then commits server-side without ever reapplying on screen. No queue arrangement
// fixes that (the optimistic set never queues), and dropping the rollback outright is not
// acceptable either — §5.13 requires the failed field to end up showing server truth. So the
// reload is deferred and re-checked instead: one scope per page/section-level state slice.
//
//  - `begin(settled)` is called at every optimistic-apply site, at save call time, with the
//    save's settlement promise — the serial() queue-chain tail where a queue exists, the request
//    round-trip itself where none does. It bumps a monotonic epoch and holds the promise until
//    it settles.
//  - `reload(fetchData, apply)` is the guarded load every caller (mount, success-path refresh,
//    rollback) routes through. It takes an internal latest-gate ticket at call time — before any
//    await, the use-latest.ts dispatch rule — then loops: wait for every registered save to
//    settle, capture the epoch, fetch; a superseded ticket returns without applying (on the
//    rejection path too — the F7 rule: a stale failure must not surface either); a moved epoch
//    means a save was dispatched mid-fetch, so its commit may postdate the read, and the loop
//    re-waits and re-fetches instead of applying a payload that would undo it. Terminates
//    because the epoch advances only on user actions.
//
// The rollback contract this yields: a failing save reports its error, then fires the reload
// WITHOUT awaiting it — awaiting from inside the settling save deadlocks against the settle-wait
// on that very promise. By the time the GET is dispatched, every save issued before it has
// settled, so the payload carries the committed (= optimistic) value for every newer field and
// server truth for the failed one. Rollback call sites must pass an `apply` that does NOT clear
// the error banner (§5.13 — a reload must never clear an error set after it started); the
// ordinary load variant may keep its clear-on-success.
import { useState } from "react";
import { makeLatestGate } from "./use-latest";

export type SaveScope = {
  /** Register a dispatched save. Call at the optimistic-apply site, at save CALL time, with the
   *  promise that settles when the save (queue chain included) is done. */
  begin: (settled: Promise<unknown>) => void;
  /** Guarded load: waits out registered saves, fetches, applies only if still the newest reload
   *  and no save intervened mid-fetch. A current fetch failure propagates; a superseded one is
   *  swallowed. */
  reload: <T>(fetchData: () => Promise<T>, apply: (data: T) => void) => Promise<void>;
};

export function makeSaveScope(): SaveScope {
  const gate = makeLatestGate();
  let epoch = 0;
  const pending = new Set<Promise<unknown>>();
  return {
    begin: (settled) => {
      epoch++;
      pending.add(settled);
      const done = () => { pending.delete(settled); };
      // Both arms so a rejecting save neither lingers in the set nor surfaces as an unhandled
      // rejection here (the pages' queue chains catch their own errors; this must not rely on it).
      settled.then(done, done);
    },
    reload: async (fetchData, apply) => {
      const ticket = gate.next();
      for (;;) {
        await Promise.allSettled([...pending]);
        const seen = epoch;
        let data;
        try {
          data = await fetchData();
        } catch (err) {
          if (!gate.isCurrent(ticket)) return; // superseded: a stale rejection must vanish (F7)
          throw err;
        }
        if (!gate.isCurrent(ticket)) return;
        if (epoch !== seen) continue; // a save intervened mid-fetch — settle-wait and re-fetch
        apply(data);
        return;
      }
    },
  };
}

export function useSaveScope(): SaveScope {
  // Once-only construction via useState's lazy initializer — the useLatest/useEditGuard
  // reasoning (use-latest.ts): never re-created, never set, no render-time ref read.
  const [scope] = useState(makeSaveScope);
  return scope;
}
