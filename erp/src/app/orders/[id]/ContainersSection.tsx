"use client";
import { api } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { useBulkGrid } from "@/lib/bulk-grid";
import type { ContainerTypeOption, OrderContainer, OrderMutationResult } from "./page";

type Fields = { typeId: string; count: string; qty: string; tareWeight: string; grossWeight: string };

function blankRow(): Fields {
  return { typeId: "", count: "", qty: "", tareWeight: "", grossWeight: "" };
}

function netWeight(gross: string, tare: string): number | null {
  if (gross.trim() === "" || tare.trim() === "") return null;
  const g = Number(gross), t = Number(tare);
  if (!Number.isFinite(g) || !Number.isFinite(t)) return null;
  return Math.round((g - t) * 100) / 100;
}

/**
 * Bulk-edit grid PUTting `replaceContainers`' whole array (Task 5, spec §5a) — delete-then-
 * recreate server-side, so row ids are not stable across a save (`useBulkGrid`'s edits/removed
 * overlay is cleared on success rather than carried forward, since there is nothing left for it
 * to key against). Container `net` is derived here for display only, never sent — the server
 * derives it identically for the traveler (design spec §4).
 */
export function ContainersSection({
  orderId, containers, containerTypes, editGate, applyMutation, onError,
}: {
  orderId: string;
  containers: OrderContainer[];
  containerTypes: ContainerTypeOption[];
  editGate: Gate;
  applyMutation: (res: OrderMutationResult) => void;
  onError: (message: string | null) => void;
}) {
  const grid = useBulkGrid<Fields>();
  const rows = grid.compose(containers, (c) => ({
    typeId: c.typeId,
    count: String(c.count),
    qty: c.qty === null ? "" : String(c.qty),
    tareWeight: c.tareWeight === null ? "" : String(c.tareWeight),
    grossWeight: c.grossWeight === null ? "" : String(c.grossWeight),
  }));

  function patch(row: { key: string; isNew: boolean }, field: keyof Fields, value: string) {
    if (row.isNew) grid.updateAdded(row.key, { [field]: value } as Partial<Fields>);
    else grid.updateExisting(row.key, { [field]: value } as Partial<Fields>);
  }
  function remove(row: { key: string; isNew: boolean }) {
    if (row.isNew) grid.removeAdded(row.key);
    else grid.removeExisting(row.key);
  }

  async function save() {
    const payload: { typeId: string; count: number; qty: number | null; tareWeight: string | null; grossWeight: string | null }[] = [];
    for (const [i, row] of rows.entries()) {
      const label = `Container ${i + 1}`;
      if (!row.typeId) { onError(`${label}: pick a type.`); return; }
      const count = Number(row.count);
      if (!Number.isInteger(count) || count < 1) { onError(`${label}: count must be a whole number of at least 1.`); return; }
      let qty: number | null = null;
      if (row.qty.trim() !== "") {
        qty = Number(row.qty);
        if (!Number.isInteger(qty) || qty < 1) { onError(`${label}: quantity per container must be a whole number of at least 1.`); return; }
      }
      const tare = row.tareWeight.trim();
      if (tare !== "" && !(Number(tare) >= 0)) { onError(`${label}: tare weight must not be negative.`); return; }
      const gross = row.grossWeight.trim();
      if (gross !== "" && !(Number(gross) >= 0)) { onError(`${label}: gross weight must not be negative.`); return; }
      payload.push({
        typeId: row.typeId, count, qty,
        tareWeight: tare === "" ? null : tare, grossWeight: gross === "" ? null : gross,
      });
    }
    try {
      const res = await api<OrderMutationResult>(`/api/orders/${orderId}/containers`, {
        method: "PUT", body: JSON.stringify(payload),
      });
      applyMutation(res);
      grid.reset();
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Containers</h2>
      {rows.length === 0 && <p className="mb-2 text-sm text-slate-500">None.</p>}
      {rows.map((row, i) => {
        const net = netWeight(row.grossWeight, row.tareWeight);
        return (
          <div key={row.key} className="mb-2 grid grid-cols-6 items-end gap-2 text-sm">
            <label className="block">
              Type
              <select value={row.typeId} disabled={!editGate.allowed} title={editGate.title}
                      onChange={(e) => patch(row, "typeId", e.target.value)}
                      aria-label={`Container ${i + 1} type`}
                      className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50">
                <option value="">— choose —</option>
                {containerTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label className="block">
              Count
              <input value={row.count} inputMode="numeric" disabled={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patch(row, "count", e.target.value)}
                     aria-label={`Container ${i + 1} count`} className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50" />
            </label>
            <label className="block">
              Qty/container
              <input value={row.qty} inputMode="numeric" disabled={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patch(row, "qty", e.target.value)}
                     aria-label={`Container ${i + 1} quantity`} className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50" />
            </label>
            <label className="block">
              Tare
              <input value={row.tareWeight} inputMode="decimal" disabled={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patch(row, "tareWeight", e.target.value)}
                     aria-label={`Container ${i + 1} tare weight`} className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50" />
            </label>
            <label className="block">
              Gross
              <input value={row.grossWeight} inputMode="decimal" disabled={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patch(row, "grossWeight", e.target.value)}
                     aria-label={`Container ${i + 1} gross weight`} className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50" />
            </label>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-600">Net: {net ?? "—"}</span>
              <button onClick={() => remove(row)} disabled={!editGate.allowed} title={editGate.title}
                      className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                Remove
              </button>
            </div>
          </div>
        );
      })}
      <div className="mt-2 flex items-center gap-3">
        <button onClick={() => grid.addRow(blankRow())} disabled={!editGate.allowed} title={editGate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Add container
        </button>
        <button onClick={() => void save()} disabled={!editGate.allowed || !grid.dirty} title={editGate.title}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          Save containers
        </button>
      </div>
    </section>
  );
}
