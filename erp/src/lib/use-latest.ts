"use client";
// Client-safe: no src/server imports. Guards a fetch-into-state effect against out-of-order
// responses: a response is applied only if it belongs to the newest request (backlog #5 — a
// stale customer-list search response could overwrite a newer one; the parts list has the same
// shape, so the fix is this shared gate rather than two copies).
import { useState } from "react";

export function makeLatestGate() {
  let seq = 0;
  return {
    next: () => ++seq,
    isCurrent: (ticket: number) => ticket === seq,
  };
}

/**
 * The mutation counterpart of `makeLatestGate` (fix-wave R4 finding 6).
 *
 * The order hub runs several independent whole-order mutations — Overview PATCHes, line add/edit/
 * remove, four bulk replaces, link/unlink — and every one of them answers with the ENTIRE fresh
 * order, which the page then swaps into one piece of state. Overlapping calls therefore race, and
 * the loser is whichever response happens to arrive last: a slow line edit answering after a fast
 * bulk replace put the page back to a state the server had already moved past. Not merely stale
 * display — the sections' bulk-grid overlays compose against those rows, so a reverted row set
 * also drags their pending edits into `detectOrphans`' churn path.
 *
 * `makeLatestGate` cannot be reused for this. It keeps only the NEWEST ISSUED ticket, so of two
 * overlapping saves it discards the first one's result even when that result is the only one that
 * ever arrives — acceptable for a fetch-into-state (another fetch is already on its way to answer
 * the same question) and quietly wrong for a save, whose response is the only report of a write
 * that actually happened. This gate is monotonic against what has already been APPLIED instead:
 * take a ticket when the request is DISPATCHED, and on completion apply it only if nothing newer
 * has been applied in the meantime. An out-of-order straggler is dropped; an early finisher is
 * not.
 */
export function makeMutationGate() {
  let issued = 0;
  let applied = 0;
  return {
    /** Take a ticket. MUST be called before the request is dispatched — a ticket taken after the
     *  await would order responses by arrival, which is the bug, not the fix. */
    next: () => ++issued,
    /** Records and returns whether `ticket`'s result is still the newest thing to be applied. */
    accept: (ticket: number) => {
      if (ticket <= applied) return false;
      applied = ticket;
      return true;
    },
  };
}

export function useMutationGate() {
  // Same once-only construction, and the same reason for `useState` over a ref, as `useLatest`.
  const [gate] = useState(makeMutationGate);
  return gate;
}

export function useLatest() {
  // `useState`'s lazy initializer rather than a lazily-assigned ref. Both create the gate exactly
  // once and never replace it, but the ref version had to read `ref.current` during render, which
  // is what `react-hooks/refs` objects to — and it is right that the general pattern is unsafe,
  // since a ref written during render is invisible to React's own bookkeeping. `useState` gets the
  // same once-only construction with none of that. The gate is never set, so no re-render is
  // possible from it; only the initial value is ever used.
  const [gate] = useState(makeLatestGate);
  return gate;
}
