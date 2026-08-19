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
// `onFocusCell(collection, rowId, field)` registers WHICH collection the row belongs to (a
// page-chosen name — "addresses", "contacts"), WHICH row (by id — stable across the reorders
// and insertions a fresh payload can carry) and WHICH field is under the cursor, and
// `mergeRows(collection, cur, incoming)` is `merge`'s array counterpart: the incoming array
// lands wholesale UNLESS that one cell is dirty-since-focus, in which case it keeps its local
// text inside the incoming row of the same id. The collection scopes the slot (Codex PR #154
// round 1): a page can merge SEVERAL keyed arrays through one guard back-to-back, and a row id
// is by definition absent from every array but its own — so a merge acts on the registration
// (protecting OR releasing) only when it names the merge's own collection, and passes through
// otherwise, payload and slot both. A focused row deleted from its OWN collection's payload
// takes the payload as-is — there is no row left to carry the cell, and resurrecting one would
// show data the server no longer has — and RELEASES the slot: the unmounting input never blurs
// through React, and soft-delete means the same id can re-enter the payload later
// (reactivation, an includeInactive refetch) and must merge clean. One slot still serves both
// variants — the DOM has one focused element, so a cell registration and a scalar registration
// displace each other.
//
// PURITY AND THE COMPANION TRANSITION (Codex PR #154 round 2). `merge` and `mergeRows` run
// inside React functional setState updaters, and updaters must be PURE: Strict Mode
// double-invokes them with the same prev, and React can both DEFER an updater past the code
// following its setState (guaranteed for the 2nd/3rd dispatch in one handler — customers'
// applyDetail) and re-run updaters when rebasing concurrent updates. So the merges only READ
// the slot; the focus-session transition lives in the companions `noteMerged`/`noteMergedRows`,
// called beside the setState. THE PAIRING DISCIPLINE: a functional-updater merge is ALWAYS
// followed by its companion with the same payload — and where the setState sits inside a
// mutation-gate accept branch, the companion goes inside that branch too (a dropped stale
// payload is never applied, so it must never be noted).
//
// Because React fixes neither whether the updater runs before or after the companion, nor how
// many times, the untouched-vs-dirty decision cannot compare against a single mutable atFocus.
// Instead the slot keeps a per-focus-session SNAPSHOT SET — the at-entry value plus every
// server value the companions have noted since — and "untouched" means the field's current text
// is a member: a value the box was given, not one the user typed. The set only ever grows
// within a session, so the merge decision is identical under every interleaving. Blur semantics
// (worked through, round 2): an untouched field behaves exactly as before (its shown value is
// always the newest member); a dirty field's typed text still commits (it matches no snapshot);
// a dirty field reverted to exactly the server's value now blurs to a NO-OP instead of a
// redundant PATCH (strictly better — the write would assert a change nobody made); and a dirty
// field reverted to the AT-ENTRY value stays a no-op, the pre-round-2 behavior, because the set
// keeps the original snapshot (an atFocus overwrite would have committed there). `onBlurSave`'s
// `atFocus` argument is the NEWEST snapshot — for the int-field rollback callers, the last
// value the box was actually given.
import { useState } from "react";

type EditableElement = HTMLInputElement | HTMLTextAreaElement;

export type EditGuard = {
  /** onFocus handler factory. Pass the state-object property this input is bound to; pass `null`
   *  for inputs that want only the blur no-op guard (fields not bound to the merged object —
   *  e.g. a child row's cell). */
  onFocusField: (key: string | null) => (e: React.FocusEvent<EditableElement>) => void;
  /** onFocus handler factory for a cell bound to a row of a keyed array (`mergeRows`) rather
   *  than a property of the page's detail object (`merge`): registers WHICH collection the row
   *  belongs to (a page-chosen name — "addresses", "contacts"), WHICH row (by id), and WHICH
   *  field is under the cursor. The collection is part of the cell's identity (Codex PR #154
   *  round 1): a page can merge SEVERAL keyed arrays through one guard, and a row id is by
   *  definition absent from every array but its own — without the scope, another collection's
   *  merge would read that absence as a deletion and release the registration. Shares the one
   *  focused slot with `onFocusField` — the DOM has one focused element, so either registration
   *  displaces the other. */
  onFocusCell: (collection: string, rowId: string, field: string) =>
    (e: React.FocusEvent<EditableElement>) => void;
  /** Blur-save no-op guard: commits only when the value is one the user typed — a value
   *  matching ANY of the focus session's snapshots (the at-entry value, or a server value a
   *  companion noted since) is a no-op, since committing it would assert a change nobody made.
   *  `commit`'s second argument is the NEWEST snapshot (the last value the box was given), for
   *  callers that roll a bad value back to it. `opts.trim` mirrors a server-side zod `.trim()`
   *  so add-and-remove-a-space is a no-op. */
  onBlurSave: (
    e: React.FocusEvent<EditableElement>,
    commit: (value: string, atFocus: string) => void,
    opts?: { trim?: boolean },
  ) => void;
  /** Merge an arriving server detail over current state, preserving the one field the user is
   *  actively editing (focused AND changed since focus — i.e. its text matches no session
   *  snapshot). PURE: runs inside functional setState updaters and never writes the slot —
   *  ALWAYS pair the setState with `noteMerged(incoming)` beside it (inside the same accept
   *  branch where one gates the setState). Route EVERY set-state-from-server-detail through
   *  this. */
  merge: <T extends object>(cur: T | null, incoming: T) => T;
  /** The companion transition for `merge` — call it beside (not inside) the setState whose
   *  updater merged this payload: records the payload's value for the focused key as a session
   *  snapshot, so the box's new server-given text reads as untouched and blurs to a no-op.
   *  No-ops when nothing scalar is focused or the payload lacks the key. Never note a payload
   *  the mutation gate dropped — it was not applied. */
  noteMerged: <T extends object>(incoming: T) => void;
  /** `merge`'s counterpart for array state keyed by row id: the incoming array lands wholesale
   *  UNLESS the focused cell (registered via `onFocusCell`) is dirty-since-focus, in which case
   *  that ONE cell keeps its local value inside the incoming row of the same id — reorders,
   *  insertions, and every sibling field/row refresh. Reads the slot only when the registration
   *  names THIS `collection`; any other registration passes through untouched (Codex PR #154
   *  round 1: a focused contact's id is absent from the addresses array by definition, and that
   *  absence is not a deletion). PURE like `merge` — it never writes the slot; the transition
   *  AND the release-on-absence live in `noteMergedRows`, so ALWAYS pair the setState with it.
   *  Route EVERY set-rows-from-server through this on pages whose cells register with
   *  `onFocusCell`. */
  mergeRows: <R extends { id: string }>(collection: string, cur: R[], incoming: R[]) => R[];
  /** The companion transition for `mergeRows` — call it beside (not inside) the setState whose
   *  updater merged this payload, with the SAME collection and payload. Same collection scoping
   *  as the merge; for its own collection it records the focused cell's server value as a
   *  session snapshot, or — when the focused row is ABSENT from the payload (genuinely deleted
   *  server-side) — RELEASES the slot: the cell's input is about to unmount with no React blur,
   *  and the same id can re-enter a later payload (round 1's rule, now living outside the
   *  updater so it runs exactly once). A payload whose row lacks the field leaves the
   *  registration alone. Never note a payload the mutation gate dropped. */
  noteMergedRows: <R extends { id: string }>(collection: string, incoming: R[]) => void;
};

export function makeEditGuard(): EditGuard {
  // The ONE focused slot, shared by both variants: `key` names a property of the page's detail
  // object (`merge`), `cell` names a collection+row-id+field of a keyed array (`mergeRows`). At
  // most one of the two is set — registering either clears the other, mirroring the DOM's
  // single focus. `snapshots` is the focus session's grow-only set of server-given values (the
  // at-entry value, plus one per companion note); `atFocus` is its newest member. Only the
  // focus/blur handlers and the companions write this slot — the merges are PURE (round 2).
  let focused: {
    key: string | null;
    cell: { collection: string; rowId: string; field: string } | null;
    atFocus: string;
    snapshots: Set<string>;
  } = { key: null, cell: null, atFocus: "", snapshots: new Set([""]) };

  return {
    onFocusField: (key) => (e) => {
      focused = { key, cell: null, atFocus: e.target.value, snapshots: new Set([e.target.value]) };
    },

    onFocusCell: (collection, rowId, field) => (e) => {
      focused = {
        key: null,
        cell: { collection, rowId, field },
        atFocus: e.target.value,
        snapshots: new Set([e.target.value]),
      };
    },

    onBlurSave: (e, commit, opts = {}) => {
      const was = focused;
      focused = { key: null, cell: null, atFocus: "", snapshots: new Set([""]) };
      const normalize = (v: string) => (opts.trim ? v.trim() : v);
      const value = normalize(e.target.value);
      // A value matching ANY session snapshot is one the box was GIVEN — at entry, or by a
      // noted server apply — not one the user typed; committing it would assert a change
      // nobody made (and write an identical-before-and-after audit entry).
      for (const s of was.snapshots) if (normalize(s) === value) return;
      commit(value, was.atFocus);
    },

    // PURE — runs inside functional setState updaters (Strict Mode double-invokes them; React
    // may also defer them past the companion call). Reads the slot, never writes it.
    merge: <T extends object>(cur: T | null, incoming: T): T => {
      const f = focused;
      if (cur === null || f.key === null || !(f.key in incoming)) return incoming;
      const local = (cur as Record<string, unknown>)[f.key];
      // Same string lens the inputs themselves render through (`value={x ?? ""}`), so a numeric
      // field mid-edit (held as the typed string) still compares against what the box showed.
      // Untouched = the shown text is a session snapshot (a value the box was given): server
      // truth lands. This membership test is what makes the decision identical whether the
      // updater runs before its companion, after it, once, or twice — the set only grows.
      if (f.snapshots.has(String(local ?? ""))) return incoming;
      // Dirty since focus: the server detail lands everywhere EXCEPT under the user's cursor.
      return { ...incoming, [f.key]: local };
    },

    noteMerged: <T extends object>(incoming: T) => {
      const f = focused;
      if (f.key === null || !(f.key in incoming)) return;
      const v = String((incoming as Record<string, unknown>)[f.key] ?? "");
      f.snapshots.add(v);
      focused = { ...f, atFocus: v };
    },

    // PURE — the same updater constraints as `merge`. The transition and the release-on-absence
    // both live in `noteMergedRows`.
    mergeRows: <R extends { id: string }>(collection: string, cur: R[], incoming: R[]): R[] => {
      const f = focused;
      // Not this collection's registration (or none at all): the payload lands wholesale — a
      // focused contact's id is absent from the addresses array by definition, and treating
      // that absence as a deletion is what re-opened the #149 clobber (round 1). Only a cell's
      // OWN collection may act on it.
      if (f.cell === null || f.cell.collection !== collection) return incoming;
      const { rowId, field } = f.cell;
      const incomingRow = incoming.find((r) => r.id === rowId);
      // Row deleted server-side (there is no row left to carry the cell, and resurrecting one
      // would show data the server no longer has) or the field unknown to the payload: land
      // as-is. The RELEASE for the deleted case is `noteMergedRows`'s job — a pure updater
      // cannot clear the slot.
      if (!incomingRow || !(field in incomingRow)) return incoming;
      const curRow = cur.find((r) => r.id === rowId);
      if (!curRow) return incoming;
      const local = (curRow as Record<string, unknown>)[field];
      // The scalar merge's exact string lens and membership decision, per-cell.
      if (f.snapshots.has(String(local ?? ""))) return incoming;
      return incoming.map((r) => (r.id === rowId ? { ...r, [field]: local } : r));
    },

    noteMergedRows: <R extends { id: string }>(collection: string, incoming: R[]) => {
      const f = focused;
      if (f.cell === null || f.cell.collection !== collection) return;
      const { field } = f.cell;
      const incomingRow = incoming.find((r) => r.id === f.cell!.rowId);
      if (!incomingRow) {
        // Round 1's release-on-absence, now outside the updater so it runs exactly once: the
        // focused row was deleted from its OWN collection's payload, its input unmounts with no
        // React blur (only guard-registered focus/blur replaces the slot — checkboxes, selects,
        // and buttons never touch it), and soft-delete means the same id can re-enter a later
        // payload (reactivation, an includeInactive refetch) and must merge clean.
        focused = { key: null, cell: null, atFocus: "", snapshots: new Set([""]) };
        return;
      }
      if (!(field in incomingRow)) return;
      const v = String((incomingRow as Record<string, unknown>)[field] ?? "");
      f.snapshots.add(v);
      focused = { ...f, atFocus: v };
    },
  };
}

export function useEditGuard(): EditGuard {
  // Once-only construction via useState's lazy initializer — the `useLatest`/`useMutationGate`
  // reasoning (use-latest.ts): never re-created, never set, no render-time ref read.
  const [guard] = useState(makeEditGuard);
  return guard;
}
