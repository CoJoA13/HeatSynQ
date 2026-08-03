"use client";
import { api } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { useBulkGrid } from "@/lib/bulk-grid";
import type { OrderLoad, OrderMutationResult } from "./page";

type Fields = { loadNumber: string; qty: string; weight: string };

/**
 * Grid edit + renumber + Re-split (Task 6, spec §5.4/§5b). The two amber warnings this section's
 * own mutations can return ("Loads no longer sum...", "A traveler has already printed...") are
 * NOT rendered here — they land in the page-level amber banner (src/app/orders/[id]/page.tsx's
 * `applyMutation`), same as every other section's warnings, so there is exactly one place on the
 * page that ever shows a mutation's warnings rather than a section-local duplicate.
 *
 * Renumber is purely local (not itself a save): it reassigns every composed row's `loadNumber` to
 * its current display position, 1..N, so closing a gap left by a removed row — or fixing a typo —
 * does not mean retyping every other row by hand. `Save loads` still has to be clicked afterward.
 *
 * Task 15 (T14 review rider): DOES still read `grid.orphanWarning`, same as the other three grid
 * sections, despite `applyLoads` (order-loads.ts) matching existing rows by array position and
 * updating them IN PLACE rather than delete-then-recreating them — the shrink path is the
 * exception. When a save (this section's own, or a Re-split producing fewer loads than before)
 * shortens the array, `applyLoads` hard-deletes the trailing rows beyond the new length, so an
 * edit still pending against one of THOSE ids goes stale exactly like it would under
 * replaceContainers/replaceSerials/replaceCharges — `detectOrphans` (bulk-grid.ts) already runs
 * unconditionally inside `compose` for every grid instance, this one included; only the render was
 * missing.
 */
export function LoadsSection({
  orderId, loads, editGate, applyMutation, onError,
}: {
  orderId: string;
  loads: OrderLoad[];
  editGate: Gate;
  applyMutation: (res: OrderMutationResult) => void;
  onError: (message: string | null) => void;
}) {
  const grid = useBulkGrid<Fields>();
  const rows = grid.compose(loads, (l) => ({
    loadNumber: String(l.loadNumber),
    qty: l.qty === null ? "" : String(l.qty),
    weight: l.weight === null ? "" : String(l.weight),
  }));

  function patch(row: { key: string; isNew: boolean }, field: keyof Fields, value: string) {
    if (row.isNew) grid.updateAdded(row.key, { [field]: value } as Partial<Fields>);
    else grid.updateExisting(row.key, { [field]: value } as Partial<Fields>);
  }
  function remove(row: { key: string; isNew: boolean }) {
    // REPLACE_LOADS requires at least one row (z.array(LOAD_ITEM).min(1)) — refuse client-side
    // rather than let a doomed PUT round-trip just to learn that.
    if (rows.length <= 1) { onError("An order must keep at least one load."); return; }
    if (row.isNew) grid.removeAdded(row.key);
    else grid.removeExisting(row.key);
  }
  function addRow() {
    grid.addRow({ loadNumber: String(rows.length + 1), qty: "", weight: "" });
  }
  function renumber() {
    const byKey = new Map(rows.map((r, i) => [r.key, String(i + 1)]));
    for (const row of rows) patch(row, "loadNumber", byKey.get(row.key)!);
  }

  function buildPayload(): { loadNumber: number; qty: number | null; weight: string | null }[] | null {
    const parsed = rows.map((r) => ({
      loadNumber: Number(r.loadNumber),
      qty: r.qty.trim() === "" ? null : Number(r.qty),
      weight: r.weight.trim() === "" ? null : r.weight.trim(),
    }));
    for (const [i, r] of parsed.entries()) {
      if (!Number.isInteger(r.loadNumber) || r.loadNumber < 1) { onError(`Load ${i + 1}: load # must be a whole number of at least 1.`); return null; }
      if (r.qty !== null && (!Number.isInteger(r.qty) || r.qty < 1)) { onError(`Load ${i + 1}: quantity must be a whole number of at least 1.`); return null; }
      if (r.weight !== null && !(Number(r.weight) > 0)) { onError(`Load ${i + 1}: weight must be greater than zero.`); return null; }
      if (r.qty === null && r.weight === null) { onError(`Load ${i + 1}: needs a quantity, a weight, or both.`); return null; }
    }
    const numbers = new Set(parsed.map((r) => r.loadNumber));
    if (numbers.size !== parsed.length || [...numbers].some((n) => n < 1 || n > parsed.length)) {
      onError("Load numbers must be 1..N with no gaps or repeats — try Renumber.");
      return null;
    }
    return parsed;
  }

  async function save() {
    const payload = buildPayload();
    if (!payload) return;
    try {
      const res = await api<OrderMutationResult>(`/api/orders/${orderId}/loads`, {
        method: "PUT", body: JSON.stringify(payload),
      });
      applyMutation(res);
      grid.reset();
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  async function resplit() {
    try {
      const res = await api<OrderMutationResult>(`/api/orders/${orderId}/loads/resplit`, { method: "POST" });
      applyMutation(res);
      grid.reset(); // the resplit result supersedes any pending manual edit
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Loads</h2>
      {grid.orphanWarning && (
        <p className="mb-2 rounded bg-amber-50 p-2 text-sm text-amber-800">{grid.orphanWarning}</p>
      )}
      {rows.length === 0 && <p className="mb-2 text-sm text-slate-500">None.</p>}
      <table className="mb-2 w-full text-sm">
        <thead>
          <tr className="text-left">
            <th className="py-1 w-24">Load #</th><th className="w-32">Qty</th><th className="w-32">Weight</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.key} className="border-t">
              <td className="py-1">
                <input value={row.loadNumber} inputMode="numeric" disabled={!editGate.allowed} title={editGate.title}
                       onChange={(e) => patch(row, "loadNumber", e.target.value)}
                       aria-label={`Load ${i + 1} number`} className="w-16 rounded border px-1 py-0.5 disabled:bg-slate-50" />
              </td>
              <td>
                <input value={row.qty} inputMode="numeric" disabled={!editGate.allowed} title={editGate.title}
                       onChange={(e) => patch(row, "qty", e.target.value)}
                       aria-label={`Load ${i + 1} quantity`} className="w-24 rounded border px-1 py-0.5 disabled:bg-slate-50" />
              </td>
              <td>
                <input value={row.weight} inputMode="decimal" disabled={!editGate.allowed} title={editGate.title}
                       onChange={(e) => patch(row, "weight", e.target.value)}
                       aria-label={`Load ${i + 1} weight`} className="w-24 rounded border px-1 py-0.5 disabled:bg-slate-50" />
              </td>
              <td className="text-right">
                <button onClick={() => remove(row)} disabled={!editGate.allowed} title={editGate.title}
                        className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={addRow} disabled={!editGate.allowed} title={editGate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Add load
        </button>
        <button onClick={renumber} disabled={!editGate.allowed} title={editGate.title}
                className="rounded border border-slate-800 px-3 py-1 text-sm text-slate-800 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400">
          Renumber
        </button>
        <button onClick={() => void resplit()} disabled={!editGate.allowed} title={editGate.title}
                className="rounded border border-slate-800 px-3 py-1 text-sm text-slate-800 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400">
          Re-split
        </button>
        <button onClick={() => void save()} disabled={!editGate.allowed || !grid.dirty} title={editGate.title}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          Save loads
        </button>
      </div>
    </section>
  );
}
