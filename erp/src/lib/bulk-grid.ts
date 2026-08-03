"use client";
// Shared by the order hub's bulk-edit grids (Containers/Charges/Loads/per-line Serials,
// src/app/orders/[id]/) — every one of them PUTs its ENTIRE array back to a Task 5/6 endpoint
// (replaceContainers/replaceCharges/replaceLoads/replaceSerials), so the natural editor shape is
// "edit several rows, then one Save sends the whole thing" rather than a per-field PATCH.
//
// The 2C-3 lesson (HANDOFF §4a, docs/2026-08-02-2c3-process-steps-design.md §... — "preserving
// unsaved UI work is a model problem, not a patch problem") applies here just as much as it did to
// ProcessStepsSection's step editor: a full local COPY of the server array, once seeded, either
// goes stale the moment something else refreshes the parent order (masking that refresh) or has
// to be defensively re-synced in a way that risks discarding what the user just typed. The fix
// used there — keep only what the user actually touched, in a separate overlay, and compose it
// with server state at RENDER time — generalizes cleanly to "array of rows" once row identity is
// handled: an edited EXISTING row is tracked by its server id (only the touched fields, `step-
// drafts.ts`'s own shape); a newly ADDED row has no server id yet, so it is tracked in full under
// a client-generated id; a REMOVED existing row is tracked as a bare id, never spliced out of the
// server array directly (there is no server array to splice — `containers` etc. are props, not
// state). None of the three can go stale: if the server array is unrelated-refreshed (e.g. the
// Overview section saves a PO change, which re-fetches the whole order), `compose` just re-runs
// against the new (in this case unchanged) server rows with the exact same overlay.
//
// Fix round 1 (Important finding): three of this hook's four callers — Containers/Charges/
// per-line Serials — sit on DELETE-THEN-RECREATE mutators (replaceContainers/replaceSerials/
// replaceCharges each delete every row and reinsert at positions 1..n, so EVERY row gets a fresh
// id on EVERY save, whoever saves it). Loads is the partial exception: `applyLoads` matches
// existing rows by array position and updates them in place, so ids survive a save that keeps the
// SAME row count — the review's own "Loads is immune" note, which is why LoadsSection.tsx
// originally never rendered `orphanWarning`. That immunity does not extend to a save that
// SHRINKS the array (this section's own remove, or a Re-split landing on fewer loads than
// before): `applyLoads` hard-deletes the trailing rows beyond the new, shorter length, so an edit
// still pending against one of those now-gone ids orphans exactly like it would under the other
// three sections — Task 15 (the shrink-path residual) made LoadsSection.tsx render the warning
// too, since `detectOrphans` below has always run for every caller regardless of which ones
// render its result. Composing an edit keyed on a row id that another actor's save already
// replaced used to just silently produce nothing: `compose` looked up `edits.get(r.id)` for each
// CURRENT row, found no match for the
// stale id, and the edit — real, unsaved, user-typed content — vanished with no trace, the moment
// ANY mutation anywhere on the page (not necessarily this grid's own) next refreshed `order` and
// therefore this grid's `serverRows` prop. `detectOrphans` below catches exactly this: it
// remembers the last set of row ids `compose` saw, and the moment that set changes out from under
// a NON-EMPTY `edits` map, it clears the entries that no longer match anything live and records a
// warning for the section to render — never silently, and never by guessing which new row an old
// edit "must" belong to.
import { useState } from "react";

/** The server row shape every grid's rows need at minimum — a stable id to key edits/removal by. */
export type BulkRow = { id: string };

/** One row as `compose` renders it: either an existing server row (`isNew: false`, keyed by its
 *  real id) or a not-yet-saved local addition (`isNew: true`, keyed by a client-generated id). */
export type ComposedRow<Fields> = { key: string; isNew: boolean } & Fields;

const ORPHAN_WARNING =
  "This list changed on the server while you were editing — your unsaved changes here were " +
  "set aside; please re-check.";

/**
 * `Fields` is the flat, string-valued shape a grid's inputs are bound to (e.g. containers'
 * `{ typeId, count, qty, tareWeight, grossWeight }` — every value a plain string, same wire-shape
 * convention the order entry page uses throughout: what a text input can hold, converted to the
 * server's numbers/decimals only when a Save actually builds the request body).
 */
export function useBulkGrid<Fields extends Record<string, string>>() {
  const [edits, setEdits] = useState<Map<string, Partial<Fields>>>(new Map());
  const [added, setAdded] = useState<({ clientId: string } & Fields)[]>([]);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  // The row-id set `compose`/`detectOrphans` last saw, and the standing "your edits were set
  // aside" notice. Both `useState`, not `useRef`: `detectOrphans` below updates them by calling
  // their setters DURING RENDER — react.dev's own documented "adjust state when a prop changes"
  // technique (compare an incoming value against a remembered one, conditionally setState; React
  // reruns the component immediately, before painting, rather than needing a separate effect plus
  // an extra visible frame where the grid still shows the about-to-vanish edit with no warning
  // posted yet). That pattern is specified to use `useState` for the remembered value, not a ref —
  // mutating a ref directly during render is exactly what React's own rules forbid, and is also
  // what StrictMode's deliberate double-render-in-dev exists to catch.
  const [lastLiveIds, setLastLiveIds] = useState<Set<string> | null>(null);
  const [orphanWarning, setOrphanWarning] = useState<string | null>(null);

  /** Patches one EXISTING row's overlay — only the fields actually passed are recorded, so a
   *  field nobody touched keeps showing server truth via `compose` below. */
  function updateExisting(id: string, patch: Partial<Fields>) {
    setEdits((cur) => {
      const next = new Map(cur);
      next.set(id, { ...next.get(id), ...patch });
      return next;
    });
  }

  /** Patches one locally-ADDED row (identified by the client id `addRow` returned it under) —
   *  these have no server state to compose with, so the row IS the edit. */
  function updateAdded(clientId: string, patch: Partial<Fields>) {
    setAdded((cur) => cur.map((a) => (a.clientId === clientId ? { ...a, ...patch } : a)));
  }

  /** Marks an existing server row for removal on the next Save. Never mutates the server array
   *  (there isn't one to mutate here — it is the caller's prop) — `compose` filters it out. */
  function removeExisting(id: string) {
    setRemovedIds((cur) => new Set(cur).add(id));
  }

  function removeAdded(clientId: string) {
    setAdded((cur) => cur.filter((a) => a.clientId !== clientId));
  }

  /** Appends one new local-only row, seeded with `initial` (typically all-blank fields). Returns
   *  the client id so a caller that needs it immediately (none currently do) can have it. */
  function addRow(initial: Fields): string {
    const clientId = crypto.randomUUID();
    setAdded((cur) => [...cur, { clientId, ...initial }]);
    return clientId;
  }

  /** Clears every local edit — called after a Save actually succeeds, once the server's fresh
   *  rows already reflect exactly what was just sent, so there is nothing left to overlay. Also
   *  clears any standing orphan notice: a fresh, successful save of THIS user's own edits
   *  supersedes it. */
  function reset() {
    setEdits(new Map());
    setAdded([]);
    setRemovedIds(new Set());
    setOrphanWarning(null);
  }

  /** Whether there is anything a Save button would actually send that differs from server state
   *  as loaded — an empty overlay (nothing edited, added, or removed) means the button has
   *  nothing to do yet. */
  const dirty = edits.size > 0 || added.length > 0 || removedIds.size > 0;

  /**
   * Detects edits whose row id is no longer present among the CURRENT server rows, clears exactly
   * those entries, and records the standing warning `compose`'s caller renders. Deliberately never
   * reattaches an orphaned edit's values to some OTHER row by array position instead of identity —
   * that would just be the 2C-3 masked-edit bug in reverse, forcing one row's unsaved values onto
   * a DIFFERENT row's real content because they happened to land at the same index after someone
   * else's delete-then-recreate save. `added` (keyed by client id, never a server id — it cannot
   * orphan) and `removedIds` (a removal intent against a row that's already gone is moot, not a
   * loss of anything the user typed) are left untouched.
   *
   * Runs unconditionally on every call — i.e. every render `compose` (below) is part of, since
   * `compose` is only ever called from a section's own render body — comparing the incoming row
   * ids against the previous set purely by CONTENT (never by array/Set reference), so an unrelated
   * mutation that refreshes `order` without actually changing THIS grid's rows is a no-op here,
   * not a false alarm.
   */
  function detectOrphans(serverRows: readonly BulkRow[]): void {
    const liveIds = new Set(serverRows.map((r) => r.id));
    const unchanged = lastLiveIds !== null
      && liveIds.size === lastLiveIds.size
      && [...liveIds].every((id) => lastLiveIds.has(id));
    if (unchanged) return;

    const priorIds = lastLiveIds; // null on this hook instance's very first call — nothing to compare against yet
    setLastLiveIds(liveIds);
    if (priorIds === null || edits.size === 0) return;

    const orphanedKeys = [...edits.keys()].filter((id) => !liveIds.has(id));
    if (orphanedKeys.length === 0) return;
    const next = new Map(edits);
    for (const key of orphanedKeys) next.delete(key);
    setEdits(next);
    setOrphanWarning(ORPHAN_WARNING);
  }

  /**
   * The composed, render-ready row list: live server rows (skipping any marked removed, each
   * mapped through `toFields` and then overlaid with whatever edit exists for its id) followed by
   * locally-added rows in the order they were added. Recomputed fresh on every call — nothing
   * here is memoized state of its own, so it can never itself go stale; call it from the render
   * body (optionally wrapped in the caller's own `useMemo` if the row count ever gets large).
   */
  function compose<Row extends BulkRow>(
    serverRows: readonly Row[], toFields: (row: Row) => Fields,
  ): ComposedRow<Fields>[] {
    detectOrphans(serverRows);
    const existing: ComposedRow<Fields>[] = serverRows
      .filter((r) => !removedIds.has(r.id))
      .map((r) => ({ key: r.id, isNew: false, ...toFields(r), ...(edits.get(r.id) ?? {}) }));
    const addedRows: ComposedRow<Fields>[] = added.map((a) => ({ key: a.clientId, isNew: true, ...a }));
    return [...existing, ...addedRows];
  }

  return {
    edits, added, removedIds, dirty, orphanWarning,
    updateExisting, updateAdded, removeExisting, removeAdded, addRow, reset, compose,
  };
}
