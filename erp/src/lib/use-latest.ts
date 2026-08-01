"use client";
// Client-safe: no src/server imports. Guards a fetch-into-state effect against out-of-order
// responses: a response is applied only if it belongs to the newest request (backlog #5 — a
// stale customer-list search response could overwrite a newer one; the parts list has the same
// shape, so the fix is this shared gate rather than two copies).
import { useRef } from "react";

export function makeLatestGate() {
  let seq = 0;
  return {
    next: () => ++seq,
    isCurrent: (ticket: number) => ticket === seq,
  };
}

export function useLatest() {
  const ref = useRef<ReturnType<typeof makeLatestGate> | null>(null);
  ref.current ??= makeLatestGate();
  return ref.current;
}
