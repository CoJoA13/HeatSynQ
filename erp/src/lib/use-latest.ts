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
