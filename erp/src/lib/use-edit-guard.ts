"use client";
// Client-safe: no src/server imports. The fix-wave 2026-08-06 cross-page notes-clobber fix
// (whole-branch review Important #3), ONE mechanism for the detail pages that bind text
// fields straight to a fetched entity object and apply arriving server details over that object
// wholesale — CertDetail.tsx (`cert`), ShipmentDetail.tsx (`shipper`), customers/[id]/page.tsx
// (`c`), and their later adopters (parts, invoices, batches, orders):
//
// Every one of those pages saves a text field on blur and answers a save with either the PATCH
// response's fresh detail (applyMutation) or a rollback `load()` (§5.13's failure path). Both
// paths used to REPLACE the whole state object, so a detail landing while the user was already
// typing in a SIBLING field reset that field's controlled value to server truth — the ordinary
// fill-out-both-notes flow lost keystrokes (reproduced live during T16).
//
// The mechanism is per-field dirty-since-focus preservation, grown out of the `focusedValue`
// blur no-op guard the pages originally shared:
//
//  - `onFocusField(key)` starts a FOCUS SESSION: it remembers the value the field held when the
//    user entered it AND, when `key` names the top-level property of the page's detail object
//    the field is bound to, WHICH property is under the cursor. Only one field can hold focus
//    at a time, so one session suffices (the old guard's own argument).
//  - `onBlurSave` ends the session: commits only a genuine change (see the snapshot set below).
//  - `applyPayload(incoming)` is what every "apply a server detail" call site routes through:
//    it returns the setState UPDATER. The incoming detail lands wholesale UNLESS the focused
//    field is dirty-since-focus, in which case that ONE property keeps its local value — the
//    user's in-flight text — while everything else (including the sibling the save was actually
//    about) refreshes. A focused-but-untouched field takes the server value, and the session
//    learns it so a later blur doesn't "save" a change the user never typed.
//
// What this deliberately does NOT do: block, queue, or diff whole objects. A field the user is
// not actively editing is always server truth — the §5.13 rollback contract is untouched for
// everything except the keystrokes it used to eat.
//
// THE KEYED VARIANT (#149, Group H2): pages that bind cells to an ARRAY of rows (customers'
// address/contact tables) register `onFocusCell(collection, rowId, field)` — WHICH collection
// (a page-chosen name: "addresses", "contacts"), WHICH row (by id — stable across the reorders
// and insertions a fresh payload can carry), WHICH field — and route the array applies through
// `applyRows(collection, incoming)`. The collection scopes the session (Codex PR #154 round 1):
// a page can merge SEVERAL keyed arrays back-to-back through one guard, and a row id is by
// definition absent from every array but its own — so an apply acts on the session (protecting
// OR releasing) only when it names the apply's own collection. A focused row genuinely deleted
// from its OWN collection's payload lands as-is AND releases the session: the cell's input
// unmounts with no React blur (only guard-registered focus/blur replaces a session — checkboxes,
// selects, and buttons never touch it), and soft-delete means the same id can re-enter a later
// payload (reactivation, an includeInactive refetch) and must merge clean.
//
// THE SESSION MODEL (Codex PR #154 rounds 2–3, the fixpoint). The merge decision runs inside
// React functional setState updaters, and updaters must be PURE AND SELF-CONTAINED: Strict Mode
// double-invokes them with the same prev, React defers them past the code that follows their
// setState (guaranteed for the 2nd/3rd dispatch in one handler — customers' applyDetail issues
// three), and concurrent rebasing can re-run them. Round 2 removed the updater's WRITES to
// guard state; round 3 removes its READS of live guard state too — a deferred updater that
// consulted the live session after a focus change replaced it would judge with the wrong
// registration entirely. So:
//
//  - The focus session is an IMMUTABLE-IDENTITY VALUE OBJECT: created by onFocus*, replaced —
//    never mutated — by the next onFocus*/onBlurSave. While current it accumulates a GROW-ONLY
//    set of snapshots (its at-entry value, plus every server value applied to it); once
//    replaced, nothing writes it again, so a late reader holds a stable record.
//  - `applyPayload`/`applyRows` CAPTURE the current session once, at dispatch, note the
//    payload's value for the focused field into that same captured session (the keyed variant's
//    release-on-absence also happens here — it replaces the LIVE session, which at this
//    synchronous instant IS the captured one), and return a pure updater CLOSED OVER the
//    captured session. Capture, note, and merge derive from ONE identity; mispairing is not
//    expressible at a call site. `capturePayload` is the low-level pair for the one composed
//    updater (orders' travelerPrinted ternary derives `next` from prev, then merges NEXT with
//    the captured session).
//  - Live-session access exists at exactly TWO kinds of places: user-event handlers
//    (onFocusField/onFocusCell/onBlurSave — never deferred), and the single synchronous capture
//    instant inside applyPayload/applyRows/capturePayload. An updater NEVER touches live state.
//
// The untouched-vs-dirty decision is snapshot-set MEMBERSHIP: a field whose text is a value the
// box was GIVEN (at entry, or by an applied payload) is untouched; anything else is the user's
// typing. The set only grows within a session, so the decision — and therefore the updater's
// result — is identical whether React runs it before other dispatches' notes, after them, once,
// or twice. Blur commits only values matching NO session snapshot: an untouched field behaves
// exactly as it always did; typed text still commits; a dirty field reverted to exactly the
// server's value blurs to a no-op instead of a redundant PATCH (strictly better — the write
// would assert a change nobody made); a dirty field reverted to its at-entry value stays a
// no-op, the original behavior. `onBlurSave`'s `atFocus` argument is the NEWEST snapshot — for
// the int-field rollback callers, the last value the box was actually given.
//
// THE DOCUMENTED RESIDUAL (round 3 — a boundary, not a bug to chase): a payload whose updater
// commits AFTER a focus change repaints the newly-focused untouched box with the payload value,
// and the NEW session never learns it (the note went — correctly — to the session that existed
// at dispatch), so an immediate blur PATCHes a server-given value. Reaching this requires a
// macrotask-scale updater deferral: default-priority updates flush in microtasks, a focus event
// is a macrotask, and nothing in this codebase uses startTransition for these applies — so it
// is unreachable today, and its behavior equals the app's long-standing pre-adoption
// `focusedValue` behavior (which had the hole unconditionally, not just in this window). No
// pure guard API can close it: that requires observing the DOM-rendered value at effect time —
// if it ever matters, the fix is an effect-time note, not more merge machinery.
import { useState } from "react";

type EditableElement = HTMLInputElement | HTMLTextAreaElement;

/** One focus session: an immutable-identity value object. Created at focus, REPLACED at the
 *  next focus/blur (and by the keyed release-on-absence); while current, its grow-only
 *  `snapshots` set accumulates the server values applied to the focused field, and `atFocus`
 *  tracks the newest of them. Never exported — call sites hold it only inside the closures
 *  `applyPayload`/`applyRows`/`capturePayload` return. */
type FocusSession = {
  key: string | null;
  cell: { collection: string; rowId: string; field: string } | null;
  atFocus: string;
  snapshots: Set<string>;
};

const idleSession = (): FocusSession =>
  ({ key: null, cell: null, atFocus: "", snapshots: new Set([""]) });

/** The low-level capture handle (orders' composed-updater shape): `merge` is the pure
 *  focused-field preserve against the session captured when `capturePayload` ran. */
export type CapturedMerge = {
  merge: <T extends object>(cur: T | null, incoming: T) => T;
};

export type EditGuard = {
  /** onFocus handler factory — starts a scalar focus session. Pass the state-object property
   *  this input is bound to; pass `null` for inputs that want only the blur no-op guard. */
  onFocusField: (key: string | null) => (e: React.FocusEvent<EditableElement>) => void;
  /** onFocus handler factory for a cell bound to a row of a keyed array (`applyRows`) rather
   *  than a property of the page's detail object (`applyPayload`): starts a session naming the
   *  COLLECTION (a page-chosen name — "addresses", "contacts"), the row (by id), and the field.
   *  The collection is part of the identity (round 1): a row id is by definition absent from
   *  every array but its own, and without the scope another collection's apply would read that
   *  absence as a deletion. One session serves both variants — the DOM has one focused element,
   *  so either registration displaces the other. */
  onFocusCell: (collection: string, rowId: string, field: string) =>
    (e: React.FocusEvent<EditableElement>) => void;
  /** Blur-save no-op guard — ends the session. Commits only a value the user typed: a value
   *  matching ANY of the session's snapshots (the at-entry value, or a server value an apply
   *  gave the box since) is a no-op, since committing it would assert a change nobody made.
   *  `commit`'s second argument is the NEWEST snapshot (the last value the box was given), for
   *  callers that roll a bad value back to it. `opts.trim` mirrors a server-side zod `.trim()`
   *  so add-and-remove-a-space is a no-op. */
  onBlurSave: (
    e: React.FocusEvent<EditableElement>,
    commit: (value: string, atFocus: string) => void,
    opts?: { trim?: boolean },
  ) => void;
  /** THE apply for a server detail object: captures the current session, notes the payload's
   *  value for the focused field into it, and returns the pure setState updater — closed over
   *  the captured session, so it is safe under deferral, re-runs, and focus changes. Use as
   *  `setX(editGuard.applyPayload(incoming))` for EVERY set-state-from-server-detail; where a
   *  mutation gate guards the apply, call this inside the accept branch (a dropped payload is
   *  never applied, so it must never be noted). */
  applyPayload: <T extends object>(incoming: T) => (cur: T | null) => T;
  /** `applyPayload`'s counterpart for array state keyed by row id: the incoming array lands
   *  wholesale UNLESS the focused cell (same collection, registered via `onFocusCell`) is
   *  dirty-since-focus, in which case that ONE cell keeps its local value inside the incoming
   *  row of the same id — reorders, insertions, and every sibling field/row refresh. A focused
   *  row ABSENT from its own collection's payload releases the session at dispatch (round 1's
   *  rule) and the payload lands as-is. Use as `setRows(editGuard.applyRows(collection,
   *  incoming))` for EVERY set-rows-from-server on pages whose cells register. */
  applyRows: <R extends { id: string }>(collection: string, incoming: R[]) => (cur: R[]) => R[];
  /** Low-level capture + note WITHOUT the updater, for the one composed site (orders'
   *  applyMutation) whose updater derives `next` from prev before merging: capture at dispatch,
   *  then call `captured.merge(prev, next)` inside the updater. The note reads `incoming`
   *  exactly as `applyPayload`'s would — pass the same payload the updater's derivation starts
   *  from. Everywhere else, prefer `applyPayload`. */
  capturePayload: <T extends object>(incoming: T) => CapturedMerge;
};

export function makeEditGuard(): EditGuard {
  // The ONE live session — read/replaced ONLY by the user-event handlers below and by the
  // single capture instant in applyPayload/applyRows/capturePayload. Never read by an updater.
  let session: FocusSession = idleSession();

  // The pure focused-field preserve against a CAPTURED session — the only merge there is.
  function mergeWith<T extends object>(s: FocusSession, cur: T | null, incoming: T): T {
    if (cur === null || s.key === null || !(s.key in incoming)) return incoming;
    const local = (cur as Record<string, unknown>)[s.key];
    // Same string lens the inputs themselves render through (`value={x ?? ""}`), so a numeric
    // field mid-edit (held as the typed string) still compares against what the box showed.
    // Untouched = the shown text is a session snapshot (a value the box was given).
    if (s.snapshots.has(String(local ?? ""))) return incoming;
    // Dirty since focus: the server detail lands everywhere EXCEPT under the user's cursor.
    return { ...incoming, [s.key]: local };
  }

  function mergeRowsWith<R extends { id: string }>(
    s: FocusSession, collection: string, cur: R[], incoming: R[],
  ): R[] {
    // Not this collection's session (or none at all): the payload lands wholesale — a focused
    // contact's id is absent from the addresses array by definition, and that absence is not a
    // deletion (round 1).
    if (s.cell === null || s.cell.collection !== collection) return incoming;
    const { rowId, field } = s.cell;
    const incomingRow = incoming.find((r) => r.id === rowId);
    // Row deleted server-side (the dispatch-time note released the LIVE session; this captured
    // reader just lands the payload) or the field unknown to the payload: as-is.
    if (!incomingRow || !(field in incomingRow)) return incoming;
    const curRow = cur.find((r) => r.id === rowId);
    if (!curRow) return incoming;
    const local = (curRow as Record<string, unknown>)[field];
    if (s.snapshots.has(String(local ?? ""))) return incoming;
    return incoming.map((r) => (r.id === rowId ? { ...r, [field]: local } : r));
  }

  // The dispatch-time note: grows the CAPTURED session's snapshot set (at this synchronous
  // instant the captured session IS the current one — a note can never target a replaced
  // session) and advances its newest-snapshot marker.
  function notePayload<T extends object>(s: FocusSession, incoming: T): void {
    if (s.key === null || !(s.key in incoming)) return;
    const v = String((incoming as Record<string, unknown>)[s.key] ?? "");
    s.snapshots.add(v);
    s.atFocus = v;
  }

  return {
    onFocusField: (key) => (e) => {
      session = { key, cell: null, atFocus: e.target.value, snapshots: new Set([e.target.value]) };
    },

    onFocusCell: (collection, rowId, field) => (e) => {
      session = {
        key: null,
        cell: { collection, rowId, field },
        atFocus: e.target.value,
        snapshots: new Set([e.target.value]),
      };
    },

    onBlurSave: (e, commit, opts = {}) => {
      const was = session;
      session = idleSession();
      const normalize = (v: string) => (opts.trim ? v.trim() : v);
      const value = normalize(e.target.value);
      // A value matching ANY session snapshot is one the box was GIVEN — at entry, or by an
      // applied payload — not one the user typed; committing it would assert a change nobody
      // made (and write an identical-before-and-after audit entry).
      for (const s of was.snapshots) if (normalize(s) === value) return;
      commit(value, was.atFocus);
    },

    applyPayload: <T extends object>(incoming: T) => {
      const s = session; // the single dispatch-time capture
      notePayload(s, incoming);
      return (cur: T | null) => mergeWith(s, cur, incoming);
    },

    applyRows: <R extends { id: string }>(collection: string, incoming: R[]) => {
      const s = session; // the single dispatch-time capture
      if (s.cell !== null && s.cell.collection === collection) {
        const row = incoming.find((r) => r.id === s.cell!.rowId);
        if (!row) {
          // Round 1's release-on-absence, at dispatch, exactly once: the focused row was
          // deleted from its OWN collection's payload; its input unmounts with no React blur,
          // and the same id can re-enter a later payload and must merge clean. Replacing the
          // LIVE session is safe here — at this synchronous instant it is `s`.
          session = idleSession();
        } else if (s.cell.field in row) {
          const v = String((row as Record<string, unknown>)[s.cell.field] ?? "");
          s.snapshots.add(v);
          s.atFocus = v;
        }
      }
      return (cur: R[]) => mergeRowsWith(s, collection, cur, incoming);
    },

    capturePayload: <T extends object>(incoming: T) => {
      const s = session; // the single dispatch-time capture
      notePayload(s, incoming);
      return { merge: <U extends object>(cur: U | null, inc: U): U => mergeWith(s, cur, inc) };
    },
  };
}

export function useEditGuard(): EditGuard {
  // Once-only construction via useState's lazy initializer — the `useLatest`/`useMutationGate`
  // reasoning (use-latest.ts): never re-created, never set, no render-time ref read.
  const [guard] = useState(makeEditGuard);
  return guard;
}
