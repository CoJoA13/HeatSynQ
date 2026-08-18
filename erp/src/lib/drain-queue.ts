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
// every OTHER key's chain before dispatching the rollback GET:
//
//  - The OWN key is excluded, always: the failing save's catch runs INSIDE its own chain, so
//    awaiting that chain's tail is awaiting yourself — a deadlock, not a wait.
//  - The wait re-snapshots until the other keys' chain tails are stable (the save-scope.ts
//    "park is itself a save window" lesson, Task 2 review R1): a save dispatched WHILE we sit on
//    allSettled extends its key's chain, and its commit could still postdate a GET released on
//    the old tail alone — the exact reversion this drain exists to prevent. Terminates because
//    chains only extend on user actions.
//  - `allSettled`, never `all`: the pages' stored tails are pre-caught (`next.catch(() => {})`),
//    but a rejecting sibling must release the drain either way — the drain ORDERS the rollback
//    GET after the siblings; it does not care how they fared.

/** Await the settlement of every key's chain tail in `queue` EXCEPT `ownKey`'s. Call from a
 *  failing save's catch, before dispatching the §5.13 rollback load. */
export async function drainOtherKeys(
  queue: Map<string, Promise<unknown>>,
  ownKey: string,
): Promise<void> {
  for (;;) {
    const others = [...queue.entries()].filter(([k]) => k !== ownKey).map(([, p]) => p);
    if (others.length === 0) return;
    await Promise.allSettled(others);
    const seen = new Set(others);
    const now = [...queue.entries()].filter(([k]) => k !== ownKey).map(([, p]) => p);
    if (now.every((p) => seen.has(p))) return;
  }
}
