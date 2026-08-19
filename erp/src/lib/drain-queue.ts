// Pure, client-safe (no src/server imports, no React — the field-blocker-panel.ts leaf shape):
// the §5.13 rollback-drain for the detail pages built on `useMutationGate` + a per-key `serial()`
// save queue — orders/[id]/page.tsx, invoicing/[id]/InvoiceDetail.tsx,
// shipping/[id]/ShipmentDetail.tsx, certs/[id]/CertDetail.tsx (Group D Task 7).
//
// The hole: a failed save's rollback `load()` takes the NEWEST mutation ticket, so its GET can be
// served before a SIBLING key's still-in-flight PATCH commits. The payload then carries the
// sibling's PRE-save value, the accept gate applies it (nothing newer has landed yet), and the
// sibling's committed write reverts on screen — its own response is dropped as older-ticketed, so
// the reversion sticks until the next full refresh. Same-key corrections are already safe on
// these pages (a same-key response re-applies through the accept gate), so the fix is to wait out
// every OTHER key's in-flight request before dispatching the rollback GET.
//
// WHAT THE MAP MUST HOLD (fix round 1, review CRITICAL): per-key REQUEST-settled signals —
// registered at dispatch (`inFlight.current.set(key, req.then(noop, noop))` beside the `await`),
// settling when the request itself settles. NEVER hand this function the `serial()` chain-TAIL
// map: a key's stored tail settles only after its own catch — drain included — completes, so two
// saves on different keys both failing while overlapping (one network blip rejects both in-flight
// PATCHes) had each catch awaiting the other's tail: a reproducible mutual deadlock — no
// rollback, no error banner, both queues permanently wedged, and any third key's failing save
// hanging behind them. A request's settlement IS its commit/failure, which is all the rollback
// GET must postdate — nothing about a sibling's RECOVERY (its own drain, rollback load, banner)
// needs to have finished — and a signal never depends on a drain, so no cycle is possible.
//
//  - The OWN key is excluded, always. Under the signals contract the own entry is settled by the
//    time the catch drains (the own request just failed — that is why the catch is running), but
//    the exclusion must not DEPEND on that: an own entry that never settles still must not wedge
//    the drain.
//  - The wait re-snapshots until the other keys' signals are stable (the save-scope.ts "park is
//    itself a save window" lesson, Task 2 review R1): a save dispatched WHILE we sit on
//    allSettled registers a fresh signal under its key, and its commit could still postdate a GET
//    released on the old snapshot alone — the exact reversion this drain exists to prevent.
//    Terminates because signals are only registered by user actions — which is also the
//    starvation acceptance: under SUSTAINED sibling saving the rollback waits indefinitely,
//    bounded only by the user pausing, the same acceptance the save-scope reload made.
//  - `allSettled`, never `all`: a rejecting sibling request must release the drain either way —
//    the drain ORDERS the rollback GET after the siblings; it does not care how they fared.

/** Await the settlement of every key's request-settled signal in `signals` EXCEPT `ownKey`'s.
 *  Call from a failing save's catch, before dispatching the §5.13 rollback load. `signals` must
 *  be the dispatch-time request-signal map, never the serial() chain-tail map — see above. */
export async function drainOtherKeys(
  signals: Map<string, Promise<unknown>>,
  ownKey: string,
): Promise<void> {
  for (;;) {
    const others = [...signals.entries()].filter(([k]) => k !== ownKey).map(([, p]) => p);
    if (others.length === 0) return;
    await Promise.allSettled(others);
    const seen = new Set(others);
    const now = [...signals.entries()].filter(([k]) => k !== ownKey).map(([, p]) => p);
    if (now.every((p) => seen.has(p))) return;
  }
}
