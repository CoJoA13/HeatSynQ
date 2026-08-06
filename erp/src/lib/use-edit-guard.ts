"use client";
// Client-safe: no src/server imports. The fix-wave 2026-08-06 cross-page notes-clobber fix
// (whole-branch review Important #3), ONE mechanism for the three detail pages that bind text
// fields straight to a fetched entity object and apply arriving server details over that object
// wholesale — CertDetail.tsx (`cert`), ShipmentDetail.tsx (`shipper`), customers/[id]/page.tsx
// (`c`):
//
// Every one of those pages saves a text field on blur and answers a save with either the PATCH
// response's fresh detail (applyMutation) or a rollback `load()` (§5.13's failure path). Both
// paths used to REPLACE the whole state object, so a detail landing while the user was already
// typing in a SIBLING field reset that field's controlled value to server truth — the ordinary
// fill-out-both-notes flow lost keystrokes (reproduced live during T16).
//
// The mechanism is per-field dirty-since-focus preservation, grown out of the `focusedValue`
// blur no-op guard all three pages already shared:
//
//  - `onFocusField(key)` remembers the value a field held when the user entered it (exactly the
//    old guard) AND, when `key` names the top-level property of the page's detail object the
//    field is bound to, WHICH property is under the cursor. Only one field can hold focus at a
//    time, so one slot suffices (the old guard's own argument).
//  - `onBlurSave` is the old no-op guard: clears the slot, then commits only a genuine change.
//  - `merge(cur, incoming)` is what every "apply a server detail" call site routes through:
//    the incoming detail lands wholesale UNLESS the focused field is dirty-since-focus, in which
//    case that ONE property keeps its local value — the user's in-flight text — while everything
//    else (including the sibling the save was actually about) refreshes. A focused-but-untouched
//    field takes the server value and re-snapshots the no-op guard against it, so a later blur
//    doesn't "save" a change the user never typed.
//
// What this deliberately does NOT do: block, queue, or diff whole objects. A field the user is
// not actively editing is always server truth — the §5.13 rollback contract is untouched for
// everything except the keystrokes it used to eat.
import { useState } from "react";

type EditableElement = HTMLInputElement | HTMLTextAreaElement;

export type EditGuard = {
  /** onFocus handler factory. Pass the state-object property this input is bound to; pass `null`
   *  for inputs that want only the blur no-op guard (fields not bound to the merged object —
   *  e.g. a child row's cell). */
  onFocusField: (key: string | null) => (e: React.FocusEvent<EditableElement>) => void;
  /** Blur-save no-op guard: commits only when the value genuinely changed since focus.
   *  `commit` also receives the at-focus snapshot, for callers that roll a bad value back to it.
   *  `opts.trim` mirrors a server-side zod `.trim()` so add-and-remove-a-space is a no-op. */
  onBlurSave: (
    e: React.FocusEvent<EditableElement>,
    commit: (value: string, atFocus: string) => void,
    opts?: { trim?: boolean },
  ) => void;
  /** Merge an arriving server detail over current state, preserving the one field the user is
   *  actively editing (focused AND changed since focus). Route EVERY set-state-from-server-detail
   *  through this. */
  merge: <T extends object>(cur: T | null, incoming: T) => T;
};

export function makeEditGuard(): EditGuard {
  let focused: { key: string | null; atFocus: string } = { key: null, atFocus: "" };

  return {
    onFocusField: (key) => (e) => {
      focused = { key, atFocus: e.target.value };
    },

    onBlurSave: (e, commit, opts = {}) => {
      const was = focused;
      focused = { key: null, atFocus: "" };
      const normalize = (v: string) => (opts.trim ? v.trim() : v);
      const value = normalize(e.target.value);
      if (value === normalize(was.atFocus)) return;
      commit(value, was.atFocus);
    },

    merge: <T extends object>(cur: T | null, incoming: T): T => {
      const f = focused;
      if (cur === null || f.key === null || !(f.key in incoming)) return incoming;
      const local = (cur as Record<string, unknown>)[f.key];
      // Same string lens the inputs themselves render through (`value={x ?? ""}`), so a numeric
      // field mid-edit (held as the typed string) still compares against what the box showed.
      if (String(local ?? "") === f.atFocus) {
        // Untouched since focus: take the server's value and re-snapshot the no-op guard against
        // what the box will now show.
        focused = { key: f.key, atFocus: String((incoming as Record<string, unknown>)[f.key] ?? "") };
        return incoming;
      }
      // Dirty since focus: the server detail lands everywhere EXCEPT under the user's cursor.
      return { ...incoming, [f.key]: local };
    },
  };
}

export function useEditGuard(): EditGuard {
  // Once-only construction via useState's lazy initializer — the `useLatest`/`useMutationGate`
  // reasoning (use-latest.ts): never re-created, never set, no render-time ref read.
  const [guard] = useState(makeEditGuard);
  return guard;
}
