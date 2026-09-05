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

/** What one call to `detectOrphans` (below) decided, given the live id set and what's pending —
 *  pulled out as a pure function (fix-wave R2 finding 5) so the id-churn matrix is unit-testable
 *  without a component-test harness (this codebase has none). `"unchanged"`: the live id set is
 *  the same content as last time (by CONTENT, not Set identity) — a true no-op, nothing recorded.
 *  `"first-seen"`: this hook instance's very first call — there is no prior set to compare
 *  against, so nothing can have "orphaned" yet, only a baseline to remember. `"churned"`: the live
 *  set actually changed since last time, carrying whichever edit keys and/or removedIds entries no
 *  longer match any current row. */
export type OrphanChurn =
  | { kind: "unchanged" }
  | { kind: "first-seen" }
  | { kind: "churned"; orphanedEditKeys: string[]; orphanedRemovedIds: string[] };

export function computeOrphanChurn(params: {
  liveIds: ReadonlySet<string>;
  /** `null` on the very first call — there is nothing yet to have churned away from. */
  priorLiveIds: ReadonlySet<string> | null;
  editKeys: Iterable<string>;
  removedIds: ReadonlySet<string>;
}): OrphanChurn {
  const { liveIds, priorLiveIds, editKeys, removedIds } = params;
  const unchanged = priorLiveIds !== null
    && liveIds.size === priorLiveIds.size
    && [...liveIds].every((id) => priorLiveIds.has(id));
  if (unchanged) return { kind: "unchanged" };
  if (priorLiveIds === null) return { kind: "first-seen" };

  const orphanedEditKeys = [...editKeys].filter((id) => !liveIds.has(id));
  const orphanedRemovedIds = [...removedIds].filter((id) => !liveIds.has(id));
  return { kind: "churned", orphanedEditKeys, orphanedRemovedIds };
}

/** One locally-added row as `useBulkGrid` stores it: the caller's fields plus the client-generated
 *  id they are keyed by (there is no server id yet — that is what makes them "added"). */
export type AddedRow<Fields> = { clientId: string } & Fields;

/**
 * The pure patch behind `updateAdded`: the row whose `clientId` matches takes the patch, everything
 * else is returned untouched.
 *
 * Extracted for the same reason as `appendRows` below — it is the third place an identity can be
 * spread over (#281), and the only way to prove it is not. The `clientId` is re-stamped AFTER the
 * patch: a patch is a `Partial<Fields>`, and while `NoRowIdentity` now stops a typed `Fields` from
 * declaring `clientId`, that guard is invisible to plain JS and to an `as` cast — which is exactly
 * how the original defect reached production through a type that looked fine.
 */
export function patchAdded<Fields extends Record<string, string>>(
  current: readonly AddedRow<Fields>[], clientId: string, patch: Partial<Fields>,
): AddedRow<Fields>[] {
  return current.map((a) => (a.clientId === clientId ? { ...a, ...patch, clientId } : a));
}

/**
 * The pure append behind `addRows` (fix-wave R4 finding 7): every row in `rows` gets its own
 * client id and lands, in order, after everything already there — in ONE pass over one copy.
 *
 * Extracted rather than inlined so the batch behaviour is unit-testable without a component-test
 * harness (this codebase has none; vitest runs `environment: "node"`) — the `computeOrphanChurn`
 * precedent above. Never mutates `current`: the hook hands it straight to a `setAdded` updater,
 * where mutating React's own previous state would be a bug independent of anything here.
 */
export function appendRows<Fields extends Record<string, string>>(
  current: readonly AddedRow<Fields>[], rows: readonly Fields[],
): AddedRow<Fields>[] {
  const next = current.slice();
  // The generated id spreads LAST, the #281 rule: a `Fields` carrying a `clientId` of its own would
  // otherwise overwrite it, and a row whose clientId is not its own can never be patched or removed.
  for (const row of rows) next.push({ ...row, clientId: crypto.randomUUID() });
  return next;
}

/**
 * Merges one patch into an existing row's overlay and DROPS every field that matches the server
 * row's own value — returning `undefined` when nothing is left, i.e. the row is no longer edited.
 *
 * The pure decision behind `updateExisting`, extracted so it can be mutation-tested without a
 * component harness (the `computeOrphanChurn` / `appendRows` precedent above).
 *
 * Pruning, not merely ignoring (#279). Narrowing the `dirty` PREDICATE alone would leave the no-op
 * entry in the overlay, where `compose` still spreads it over the server row it equals — invisible,
 * unclearable (Save is disabled, and Save is the only thing that calls `reset`), and it re-arms
 * without any user action the moment another actor changes that row underneath it, because
 * `detectOrphans` returns early while the id set is unchanged. Removing the entry is what makes
 * "nothing to send" and "nothing overlaid" the same state. It also matches the settled answer in
 * `field-drafts.ts`: a field typed away and back to the server's value is no longer the user's, and
 * the server's copy shows through.
 *
 * Compared as STRINGS, exactly — never trimmed, never through `Number`. Composed values are the
 * strings the PUT carries (see the `Fields` note below), so `"5.00"` typed over a server `5` is a
 * real difference, and callers deliberately differ on trimming (`SerialsSection` trims `serial` at
 * save but sends `description` untrimmed), so a normalising comparison here would report a genuine
 * payload difference clean.
 *
 * The whole merged overlay is re-checked, not just the incoming patch's keys: a caller may write
 * several fields at once (the invoice grid stamps `priceSource`/`needsPrice` alongside an amount),
 * and a field left over from an earlier keystroke can be the one that just became equal.
 */
export function mergeEdit<Fields extends Record<string, string>>(
  current: Partial<Fields> | undefined, patch: Partial<Fields>, base: Fields,
): Partial<Fields> | undefined {
  const merged = { ...current, ...patch } as Partial<Fields>;
  for (const key of Object.keys(merged) as (keyof Fields)[]) {
    if (merged[key] === base[key]) delete merged[key];
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/**
 * The two names this hook OWNS on every composed row, declared as an impossible-to-satisfy shape so
 * that a `Fields` type claiming either one is a COMPILE ERROR at the call site rather than a silent
 * shadow at runtime (#281).
 *
 * Three names, not two: an ADDED row is identified by its `clientId` before it has a server id, so
 * a field of that name shadows an identity just as surely — and an added row that loses its
 * `clientId` can never be patched or removed, which is the same dead end by a different route.
 *
 * The members are optional string LITERALS on purpose: TypeScript reports the mismatch by printing
 * the literal, so the compiler itself tells the next author what is wrong and why. A plain
 * `key?: never` also rejects the call, but on the type PARAMETER it collapses `ComposedRow<Fields>`
 * to `never` and buries the one real message under dozens of "property does not exist on type
 * 'never'" — so the prohibition rides `toFields`'s RETURN TYPE, where it produces exactly one error,
 * at the call site, naming the offending property.
 */
type NoRowIdentity = {
  key?: "useBulkGrid supplies `key` — a Fields type must not declare one (#281)";
  isNew?: "useBulkGrid supplies `isNew` — a Fields type must not declare one (#281)";
  clientId?: "useBulkGrid supplies `clientId` — a Fields type must not declare one (#281)";
};

/**
 * The composed, render-ready row list — server rows (skipping any marked removed, mapped through
 * `toFields` and overlaid with whatever edit exists for the id) followed by locally-added rows.
 *
 * Pure and exported for the same reason as `computeOrphanChurn` / `appendRows` / `mergeEdit`: the
 * hook itself cannot be driven under vitest (environment "node", no component renderer), so this is
 * the only place the composition can be mutation-proven. It is NOT a re-supply hatch — a consumer
 * that calls it with its own rows would recreate the two-baselines drift #279 removed, and the
 * call-site sweep in tests/bulk-grid.test.ts refuses it.
 *
 * THE IDENTITY SPREADS LAST, in both branches, and that is the whole of #281. It used to spread
 * first, so a caller whose `Fields` declared a `key` overwrote it — the invoice grid's added charge
 * rows composed under `key: ""`, which matched no `clientId`, leaving a row that could not be typed
 * into, could not be removed, and held the grid dirty forever. Last-wins makes the identity
 * un-shadowable whatever a caller passes, and `NoRowIdentity` above stops the collision compiling
 * in the first place; neither alone is enough, because the type guard is invisible to plain JS and
 * an `as` cast, and the ordering is invisible to a reader who never looks.
 */
export function composeRows<Row extends BulkRow, Fields extends Record<string, string>>(params: {
  serverRows: readonly Row[];
  toFields: (row: Row) => Fields;
  edits: ReadonlyMap<string, Partial<Fields>>;
  added: readonly AddedRow<Fields>[];
  removedIds: ReadonlySet<string>;
}): ComposedRow<Fields>[] {
  const { serverRows, toFields, edits, added, removedIds } = params;
  return [
    ...serverRows
      .filter((r) => !removedIds.has(r.id))
      .map((r) => ({ ...toFields(r), ...(edits.get(r.id) ?? {}), key: r.id, isNew: false })),
    ...added.map((a) => ({ ...a, key: a.clientId, isNew: true })),
  ];
}

/**
 * `Fields` is the flat, string-valued shape a grid's inputs are bound to (e.g. containers'
 * `{ typeId, count, qty, tareWeight, grossWeight }` — every value a plain string, same wire-shape
 * convention the order entry page uses throughout: what a text input can hold, converted to the
 * server's numbers/decimals only when a Save actually builds the request body).
 */
export function useBulkGrid<Row extends BulkRow, Fields extends Record<string, string>>(
  serverRows: readonly Row[], toFields: (row: Row) => Fields & NoRowIdentity,
) {
  const [edits, setEdits] = useState<Map<string, Partial<Fields>>>(new Map());
  const [added, setAdded] = useState<AddedRow<Fields>[]>([]);
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

  /** Patches one EXISTING row's overlay — only the fields actually passed are recorded, so a field
   *  nobody touched keeps showing server truth through `rows` below, and only the fields that
   *  actually DIFFER from that row are kept (`mergeEdit`). Typing a value back to the server's
   *  therefore leaves the row unedited rather than merely un-dirty (#279). */
  function updateExisting(id: string, patch: Partial<Fields>) {
    // Read outside the updater: an updater must stay pure, and StrictMode double-invokes it.
    const row = serverRows.find((r) => r.id === id);
    setEdits((cur) => {
      const next = new Map(cur);
      // No server row to compare against — an edit whose id has churned away, before
      // `detectOrphans` has seen the new set. Held work the comparison cannot see fails CLOSED and
      // is kept whole, the `ProcessStepsSection` direction; the orphan sweep clears it properly.
      const merged = row === undefined
        ? ({ ...next.get(id), ...patch } as Partial<Fields>)
        : mergeEdit(next.get(id), patch, toFields(row));
      if (merged === undefined) next.delete(id); else next.set(id, merged);
      return next;
    });
  }

  /** Patches one locally-ADDED row (identified by the client id `addRow` returned it under) —
   *  these have no server state to compose with, so the row IS the edit. */
  function updateAdded(clientId: string, patch: Partial<Fields>) {
    setAdded((cur) => patchAdded(cur, clientId, patch));
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
    setAdded((cur) => [...cur, { ...initial, clientId }]); // identity last — see `appendRows`
    
    return clientId;
  }

  /**
   * Appends a whole BATCH of new local-only rows in ONE state update (fix-wave R4 finding 7).
   *
   * `addRow` in a loop is not an equivalent shorthand for this: every call spreads the entire
   * `added` array to make the next one, so N rows cost N successive whole-array copies —
   * quadratic — plus N separate updates. The hub's serial grid did exactly that for a range
   * expansion, and `expandSerialRange` legitimately produces up to 10,000 serials from one
   * keystroke (`EC{1-10000}`), which is ~50 million element copies on the main thread inside a
   * single event handler: the grid froze instead of filling in. Reach for this whenever the row
   * count comes from the input rather than from a click.
   */
  function addRows(rows: readonly Fields[]) {
    if (rows.length === 0) return; // nothing to append — don't schedule a re-render for it
    setAdded((cur) => appendRows(cur, rows));
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

  /**
   * Whether there is anything a Save button would actually send that differs from server state as
   * loaded.
   *
   * This expression only earns that sentence because `updateExisting` prunes: an `edits` entry now
   * exists only while some field genuinely differs, so an overlay that is non-empty is an overlay
   * that changes something (#279 — before that it meant "an overlay exists", and a revert to the
   * original value still armed the badge, the navigation prompt, and every gate that refuses over a
   * dirty editor). `added` and `removedIds` need no such treatment and deliberately get none: every
   * consumer PUTs the whole composed array, so an added row is always an extra element and a
   * removal always a shorter one — neither can be a no-op, and comparing an added row against a
   * blank template would hide a deliberately empty row from the guard.
   */
  const dirty = edits.size > 0 || added.length > 0 || removedIds.size > 0;

  /**
   * Detects edits whose row id is no longer present among the CURRENT server rows, clears exactly
   * those entries, and records the standing warning `compose`'s caller renders. Deliberately never
   * reattaches an orphaned edit's values to some OTHER row by array position instead of identity —
   * that would just be the 2C-3 masked-edit bug in reverse, forcing one row's unsaved values onto
   * a DIFFERENT row's real content because they happened to land at the same index after someone
   * else's delete-then-recreate save. `added` (keyed by client id, never a server id — it cannot
   * orphan) is left untouched.
   *
   * Fix-wave R2 finding 5: `removedIds` is NOT left untouched, unlike the comment this replaced
   * used to claim — "a removal intent against a row that's already gone is moot" turned out to be
   * wrong. A removedIds entry names a SERVER row the user marked for deletion; if that id vanishes
   * from a churn (someone else's delete-then-recreate save, same as the edits case above), the
   * row the user meant to remove hasn't actually gone anywhere from their point of view — it
   * reappears in `compose`'s output, because the filter `!removedIds.has(r.id)` no longer matches
   * the row's new id — while the stale entry lingers in `removedIds` doing nothing. That is the
   * exact same "unsaved work silently set aside with no trace" shape `edits` is already protected
   * against, so it gets the identical treatment: cleared, and folded into the same warning.
   *
   * Runs unconditionally on every call — i.e. every render `compose` (below) is part of, since
   * `compose` is only ever called from a section's own render body — comparing the incoming row
   * ids against the previous set purely by CONTENT (never by array/Set reference), so an unrelated
   * mutation that refreshes `order` without actually changing THIS grid's rows is a no-op here,
   * not a false alarm.
   */
  function detectOrphans(serverRows: readonly BulkRow[]): void {
    const liveIds = new Set(serverRows.map((r) => r.id));
    const decision = computeOrphanChurn({ liveIds, priorLiveIds: lastLiveIds, editKeys: edits.keys(), removedIds });
    if (decision.kind === "unchanged") return;

    setLastLiveIds(liveIds);
    if (decision.kind === "first-seen") return;

    const { orphanedEditKeys, orphanedRemovedIds } = decision;
    if (orphanedEditKeys.length === 0 && orphanedRemovedIds.length === 0) return;

    if (orphanedEditKeys.length > 0) {
      const next = new Map(edits);
      for (const key of orphanedEditKeys) next.delete(key);
      setEdits(next);
    }
    if (orphanedRemovedIds.length > 0) {
      const next = new Set(removedIds);
      for (const id of orphanedRemovedIds) next.delete(id);
      setRemovedIds(next);
    }
    setOrphanWarning(ORPHAN_WARNING);
  }

  /**
   * The composed, render-ready row list: live server rows (skipping any marked removed, each mapped
   * through `toFields` and then overlaid with whatever edit exists for its id) followed by
   * locally-added rows in the order they were added.
   *
   * Derived here rather than returned as a `compose(serverRows, toFields)` method the caller
   * invokes, because `dirty` above has to be answered from the SAME baseline this renders from, and
   * one consumer reads `dirty` well before it would have called `compose` (the receivables apply
   * panel registers with the unsaved guard immediately after the hook call). Two supply sites for
   * the same server rows is how the two answers drift apart, which is #279's shape.
   *
   * Recomputed fresh on every render — nothing here is memoized state of its own, so it can never
   * itself go stale. The composition proper is `composeRows` above, so that it is testable.
   */
  detectOrphans(serverRows);
  const rows = composeRows({ serverRows, toFields, edits, added, removedIds });

  return {
    edits, added, removedIds, dirty, orphanWarning, rows,
    updateExisting, updateAdded, removeExisting, removeAdded, addRow, addRows, reset,
  };
}
