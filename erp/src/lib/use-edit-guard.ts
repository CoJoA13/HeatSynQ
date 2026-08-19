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
//
// The KEYED variant (#149, Group H2): pages that bind cells to an ARRAY of rows (customers'
// address/contact tables) had only the blur no-op half — their cells registered
// `onFocusField(null)`, so a server array landing mid-typing (`setAddresses(addr)` from a sibling
// save's rollback, a show-inactive toggle's refetch) still reset the cell under the cursor.
// `onFocusCell(rowId, field)` registers WHICH row (by id — stable across the reorders and
// insertions a fresh payload can carry) and WHICH field is under the cursor, and `mergeRows` is
// `merge`'s array counterpart: the incoming array lands wholesale UNLESS that one cell is
// dirty-since-focus, in which case it keeps its local text inside the incoming row of the same
// id. A focused row deleted server-side takes the payload as-is — there is no row left to carry
// the cell, and resurrecting one would show data the server no longer has — and RELEASES the
// slot: the unmounting input never blurs through React, and soft-delete means the same id can
// re-enter the payload later (reactivation, an includeInactive refetch) and must merge clean.
// One slot still serves both variants — the DOM has one focused element, so a cell registration
// and a scalar registration displace each other.
import { useState } from "react";

type EditableElement = HTMLInputElement | HTMLTextAreaElement;

export type EditGuard = {
  /** onFocus handler factory. Pass the state-object property this input is bound to; pass `null`
   *  for inputs that want only the blur no-op guard (fields not bound to the merged object —
   *  e.g. a child row's cell). */
  onFocusField: (key: string | null) => (e: React.FocusEvent<EditableElement>) => void;
  /** onFocus handler factory for a cell bound to a row of a keyed array (`mergeRows`) rather
   *  than a property of the page's detail object (`merge`): registers WHICH row (by id) and
   *  WHICH field is under the cursor. Shares the one focused slot with `onFocusField` — the DOM
   *  has one focused element, so either registration displaces the other. */
  onFocusCell: (rowId: string, field: string) => (e: React.FocusEvent<EditableElement>) => void;
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
  /** `merge`'s counterpart for array state keyed by row id: the incoming array lands wholesale
   *  UNLESS the focused cell (registered via `onFocusCell`) is dirty-since-focus, in which case
   *  that ONE cell keeps its local value inside the incoming row of the same id — reorders,
   *  insertions, and every sibling field/row refresh. A focused row absent from the payload
   *  (deleted server-side) takes the payload as-is and releases the slot — its input is about
   *  to unmount with no React blur, and the same id can re-enter a later payload. Route EVERY
   *  set-rows-from-server through this on pages whose cells register with `onFocusCell`. */
  mergeRows: <R extends { id: string }>(cur: R[], incoming: R[]) => R[];
};

export function makeEditGuard(): EditGuard {
  // The ONE focused slot, shared by both variants: `key` names a property of the page's detail
  // object (`merge`), `cell` names a row-id+field of a keyed array (`mergeRows`). At most one of
  // the two is set — registering either clears the other, mirroring the DOM's single focus.
  let focused: { key: string | null; cell: { rowId: string; field: string } | null; atFocus: string } =
    { key: null, cell: null, atFocus: "" };

  return {
    onFocusField: (key) => (e) => {
      focused = { key, cell: null, atFocus: e.target.value };
    },

    onFocusCell: (rowId, field) => (e) => {
      focused = { key: null, cell: { rowId, field }, atFocus: e.target.value };
    },

    onBlurSave: (e, commit, opts = {}) => {
      const was = focused;
      focused = { key: null, cell: null, atFocus: "" };
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
        focused = { key: f.key, cell: null, atFocus: String((incoming as Record<string, unknown>)[f.key] ?? "") };
        return incoming;
      }
      // Dirty since focus: the server detail lands everywhere EXCEPT under the user's cursor.
      return { ...incoming, [f.key]: local };
    },

    mergeRows: <R extends { id: string }>(cur: R[], incoming: R[]): R[] => {
      const f = focused;
      if (f.cell === null) return incoming;
      const { rowId, field } = f.cell;
      const incomingRow = incoming.find((r) => r.id === rowId);
      if (!incomingRow) {
        // The focused row deleted server-side: land as-is — there is no row left to carry the
        // cell, and resurrecting one would show data the server no longer has — and RELEASE the
        // slot. Once this payload applies, the cell's input unmounts without a React blur, and
        // only guard-REGISTERED focus/blur replaces the slot (checkboxes, selects, and buttons
        // never touch it) — so a stale registration would survive until the next guarded field
        // is entered. Soft-delete is exactly what lets the same id LEAVE and RE-ENTER the
        // visible payload (reactivation, an includeInactive refetch): a re-entering row must
        // merge clean, not read as dirty against this dead snapshot forever.
        focused = { key: null, cell: null, atFocus: "" };
        return incoming;
      }
      // The field unknown to the payload's row shape: land as-is (nothing comparable to
      // preserve). The row — and its input — are still live, so the registration stays for the
      // blur no-op guard.
      if (!(field in incomingRow)) return incoming;
      const curRow = cur.find((r) => r.id === rowId);
      if (!curRow) return incoming;
      const local = (curRow as Record<string, unknown>)[field];
      // The scalar merge's exact string lens and untouched/dirty split, per-cell.
      if (String(local ?? "") === f.atFocus) {
        focused = { key: null, cell: f.cell, atFocus: String((incomingRow as Record<string, unknown>)[field] ?? "") };
        return incoming;
      }
      return incoming.map((r) => (r.id === rowId ? { ...r, [field]: local } : r));
    },
  };
}

export function useEditGuard(): EditGuard {
  // Once-only construction via useState's lazy initializer — the `useLatest`/`useMutationGate`
  // reasoning (use-latest.ts): never re-created, never set, no render-time ref read.
  const [guard] = useState(makeEditGuard);
  return guard;
}
