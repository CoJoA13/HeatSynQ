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
import { useState } from "react";

/** The server row shape every grid's rows need at minimum — a stable id to key edits/removal by. */
export type BulkRow = { id: string };

/** One row as `compose` renders it: either an existing server row (`isNew: false`, keyed by its
 *  real id) or a not-yet-saved local addition (`isNew: true`, keyed by a client-generated id). */
export type ComposedRow<Fields> = { key: string; isNew: boolean } & Fields;

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
   *  rows already reflect exactly what was just sent, so there is nothing left to overlay. */
  function reset() {
    setEdits(new Map());
    setAdded([]);
    setRemovedIds(new Set());
  }

  /** Whether there is anything a Save button would actually send that differs from server state
   *  as loaded — an empty overlay (nothing edited, added, or removed) means the button has
   *  nothing to do yet. */
  const dirty = edits.size > 0 || added.length > 0 || removedIds.size > 0;

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
    const existing: ComposedRow<Fields>[] = serverRows
      .filter((r) => !removedIds.has(r.id))
      .map((r) => ({ key: r.id, isNew: false, ...toFields(r), ...(edits.get(r.id) ?? {}) }));
    const addedRows: ComposedRow<Fields>[] = added.map((a) => ({ key: a.clientId, isNew: true, ...a }));
    return [...existing, ...addedRows];
  }

  return {
    edits, added, removedIds, dirty,
    updateExisting, updateAdded, removeExisting, removeAdded, addRow, reset, compose,
  };
}
