// The unsaved-edit guard, as a client-safe leaf (no src/server imports — the permission-ui.ts /
// nav.ts precedent). Pure logic plus a module-level registry; the DOM wiring lives in Shell.tsx
// and the per-section registration in useUnsavedSection, so the decisions below are unit-testable
// without a DOM (tests/unsaved-guard.test.ts).
//
// WHY THIS EXISTS. A detail page runs TWO save models side by side, and always has. On the order
// hub, PO number / VS order # / Customer job # / Notes save on BLUR — no button, no confirmation —
// while Containers, Serials, Charges and Loads each need an explicit "Save X" click. That split is
// deliberate and is NOT redesigned here: the blur-save/mutation-gate discipline is §5.13, with
// save-scope.ts, drain-queue.ts and use-edit-guard.ts built around it. What was missing is that
// nothing on screen distinguished the two, and `beforeunload` appeared nowhere in src/ — so an
// edited-but-unsaved grid was discarded SILENTLY the moment anyone clicked a nav link, having just
// been taught by the fields above it that this page saves itself. Making the rail sticky (#270) put
// those links within reach at every scroll position, which makes the loss easier to trigger, not
// harder.
//
// The registry is module-level with a listener Set — the invalidateBackupBanner/invalidateSetupBanner
// idiom — because the sections that go dirty and the Shell that guards navigation are in different
// component trees with no common owner short of the root layout.
//
// WHAT HOLDS THE COVERAGE: tests/unsaved-registration-sweep.test.ts, not a convention. Every editor
// whose Save control gates on a dirty flag must register, the census is walked from src/ rather than
// hand-listed, and an exemption is an allowlist entry with a reason. The shared SaveButton registers
// for its own consumers, but that alone never covered the editors that do not use it.

/** Sections currently holding unsaved edits, keyed so one section going clean cannot clear another
 *  (two grids on one page are routine). The VALUE is the human label the prompt names. */
const dirtySections = new Map<string, string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

/** Record that `key` holds unsaved edits, shown to the user as `label`. Re-marking the same key
 *  replaces its label rather than accumulating entries. */
export function markUnsaved(key: string, label: string): void {
  if (dirtySections.get(key) === label) return; // idempotent: a re-render must not wake the UI
  dirtySections.set(key, label);
  notify();
}

/** Record that `key` is clean. A key that was never marked is a no-op — and deliberately does NOT
 *  notify, so an unmount storm on a page with nothing dirty costs no re-renders. */
export function clearUnsaved(key: string): void {
  if (!dirtySections.delete(key)) return;
  notify();
}

/** The labels of every section holding unsaved edits — de-duplicated and sorted, so a page with
 *  two dirty grids produces a stable sentence rather than one that depends on mount order. */
export function unsavedLabels(): string[] {
  return [...new Set(dirtySections.values())].sort();
}

/** How many sections hold unsaved edits. A NUMBER rather than the label array because this is the
 *  `useSyncExternalStore` snapshot behind the Shell's reactive arming: a fresh array each call
 *  would read as a new snapshot on every render and loop. */
export function unsavedCount(): number {
  return dirtySections.size;
}

/** Subscribe to registry changes; returns the unsubscribe. */
export function subscribeUnsaved(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Everything about a click that decides whether it will replace what is on screen. Gathered from
 *  the DOM event by the caller so this predicate stays pure and testable. */
export type NavIntent = {
  /** The anchor's href, or null when the click was not on a link at all. */
  href: string | null;
  sameOrigin: boolean;
  /** The path currently open, for the same-page comparisons below. */
  currentPath: string;
  /** ctrl/meta/shift/alt — the click opens elsewhere and leaves this page alone. */
  modifierKey: boolean;
  newTab: boolean;
  download: boolean;
  defaultPrevented: boolean;
};

/**
 * Whether a click should be interrupted to warn about unsaved edits.
 *
 * Deliberately narrow. It fires ONLY for a click that genuinely replaces what is on screen, because
 * a guard that also fires on downloads, new tabs and in-page anchors is one people learn to click
 * through — and a prompt nobody reads protects nothing. The caller has already established that
 * something is actually dirty; this answers only "will this click take the page away".
 */
export function shouldGuardNavigation(i: NavIntent): boolean {
  if (i.href === null) return false;
  if (i.defaultPrevented || i.modifierKey || i.newTab || i.download) return false;
  // Cross-origin leaves the app entirely, where the browser's own beforeunload prompt takes over —
  // guarding here as well would ask twice.
  if (!i.sameOrigin) return false;
  // A bare hash, or a hash on the path already open, is an in-page jump: nothing is lost.
  if (i.href.startsWith("#")) return false;
  const [path] = i.href.split("#");
  // An `/api/` link is an export or a document, not a page this app navigates to: the route answers
  // Content-Disposition or opens a viewer, and THIS page stays exactly where it is. Prompting there
  // is a false positive, and a prompt that fires when nothing is at stake is the one people learn
  // to dismiss — which costs the prompts that matter (Codex P2 on #272, found on BlockerPanel's
  // "Export list to Excel"). Compared with the trailing slash so `/apiary` stays a page.
  if (path === "/api" || path.startsWith("/api/")) return false;
  // Re-entering the page already open discards nothing either.
  return path !== "" && path !== i.currentPath;
}

/** The prompt. It NAMES the sections at risk: "you have unsaved changes" is the wording everyone
 *  clicks through, and the section name is the difference between a warning and a speed bump. */
export function confirmMessage(labels: string[]): string {
  const subject =
    labels.length === 1
      ? `${labels[0]} has`
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]} have`;
  return `${subject} unsaved changes. Leave the page and discard them?`;
}
