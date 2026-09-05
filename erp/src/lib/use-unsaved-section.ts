"use client";
// The React half of the unsaved-edit guard — the pure registry and predicates are in
// unsaved-guard.ts, which this keeps free of React so it stays unit-testable without a DOM
// (the use-latest.ts / use-edit-guard.ts split).
import { useEffect, useId, useSyncExternalStore } from "react";
import {
  markUnsaved, clearUnsaved, unsavedLabels, confirmMessage, subscribeUnsaved, unsavedCount,
} from "./unsaved-guard";

/**
 * Declare that this section holds unsaved edits while `dirty` is true, named `label` in the
 * navigation prompt.
 *
 * Call it from any section whose edits need an explicit Save click — the grids on the order hub
 * (Containers, Serials, Charges, Loads) and their equivalents elsewhere. Blur-saving fields need
 * nothing: they are already committed by the time focus leaves them, which is exactly the
 * asymmetry that made the silent loss so easy to walk into.
 *
 * The key is a `useId`, so two instances of the same section on one page (a multi-order shipment
 * panel, say) register independently and one going clean cannot clear the other.
 */
export function useUnsavedSection(dirty: boolean, label: string): void {
  const key = useId();
  useEffect(() => {
    if (dirty) markUnsaved(key, label);
    else clearUnsaved(key);
    // Unmounting is leaving: a section that goes away cannot still be holding edits, and without
    // this a navigated-away page would keep the prompt armed forever.
    return () => clearUnsaved(key);
  }, [key, dirty, label]);
}

/**
 * The ONE place a discard is confirmed. Returns true when it is safe to navigate.
 *
 * Lives here rather than in `unsaved-guard.ts` so that leaf stays pure and DOM-free: this is the
 * half that touches `window.confirm`.
 *
 * Every navigation that is not a plain `<Link>` click has to call it, because `router.push`
 * produces neither a click for the Shell's capture listener nor a document unload for
 * `beforeunload` — the Shell's own search/scan/sign-out paths, and any button elsewhere that
 * navigates after a mutation. **Call it BEFORE the request**, never after: cancelling a prompt that
 * appears once the invoice or reversal already exists cancels nothing, it just strands the user on
 * a page whose server state has already moved (Codex P1 on #272).
 */
export function confirmDiscard(): boolean {
  const labels = unsavedLabels();
  return labels.length === 0 || window.confirm(confirmMessage(labels));
}

/**
 * Whether anything on screen is holding unsaved edits — for gating a DESTRUCTIVE or IRREVERSIBLE
 * control, not for navigation (the Shell already guards that).
 *
 * The point is that some actions are worse than losing the edits: printing a certification archives
 * the readings the SERVER has, and finalizing an invoice freezes the lines the SERVER has, so
 * running either over an unsaved editor produces permanent paper that disagrees with what the
 * operator is looking at. A parent cannot see its child grid's dirty flag, and this registry is the
 * bridge that already exists.
 *
 * SCOPE, stated because it is a real caveat rather than a guarantee: the registry is app-wide. It
 * reads as "this page's editors" only because exactly one page is mounted at a time — true of this
 * app, but a property of the router, not of this hook. Use it for gating a control on the page whose
 * editors are registered, never as a global "is the app busy".
 */
export function useUnsavedPresent(): boolean {
  return useSyncExternalStore(subscribeUnsaved, () => unsavedCount() > 0, () => false);
}
