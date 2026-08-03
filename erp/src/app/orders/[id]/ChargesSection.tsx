"use client";
import { api } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { useBulkGrid } from "@/lib/bulk-grid";
import type { OrderCharge, OrderMutationResult } from "./page";

type Fields = { description: string; amount: string };

/** Bulk-edit grid PUTting `replaceCharges`' whole array (Task 5, spec §6/§7.5.3 — a blank amount
 *  is a legitimate "needs price", not an error; Phase 5 prices and bills these). Same
 *  compose-with-server-state shape as ContainersSection — see src/lib/bulk-grid.ts. */
export function ChargesSection({
  orderId, charges, editGate, applyMutation, onError,
}: {
  orderId: string;
  charges: OrderCharge[];
  editGate: Gate;
  applyMutation: (res: OrderMutationResult) => void;
  onError: (message: string | null) => void;
}) {
  const grid = useBulkGrid<Fields>();
  const rows = grid.compose(charges, (c) => ({
    description: c.description,
    amount: c.amount === null ? "" : String(c.amount),
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
    const payload: { description: string; amount: string | null }[] = [];
    for (const [i, row] of rows.entries()) {
      const description = row.description.trim();
      if (!description) { onError(`Charge ${i + 1}: enter a description.`); return; }
      const amount = row.amount.trim();
      if (amount !== "" && !(Number(amount) >= 0)) { onError(`Charge ${i + 1}: amount must not be negative.`); return; }
      payload.push({ description, amount: amount === "" ? null : amount });
    }
    try {
      const res = await api<OrderMutationResult>(`/api/orders/${orderId}/charges`, {
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
      <h2 className="mb-2 font-medium">Charges</h2>
      {rows.length === 0 && <p className="mb-2 text-sm text-slate-500">None.</p>}
      {rows.map((row, i) => (
        <div key={row.key} className="mb-2 flex items-end gap-2 text-sm">
          <label className="block flex-1">
            Description
            <input value={row.description} disabled={!editGate.allowed} title={editGate.title}
                   onChange={(e) => patch(row, "description", e.target.value)}
                   aria-label={`Charge ${i + 1} description`} className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50" />
          </label>
          <label className="block w-40">
            Amount
            <input value={row.amount} inputMode="decimal" placeholder="needs price" disabled={!editGate.allowed} title={editGate.title}
                   onChange={(e) => patch(row, "amount", e.target.value)}
                   aria-label={`Charge ${i + 1} amount`} className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-50" />
          </label>
          <button onClick={() => remove(row)} disabled={!editGate.allowed} title={editGate.title}
                  className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
            Remove
          </button>
        </div>
      ))}
      <div className="mt-2 flex items-center gap-3">
        <button onClick={() => grid.addRow({ description: "", amount: "" })} disabled={!editGate.allowed} title={editGate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Add charge
        </button>
        <button onClick={() => void save()} disabled={!editGate.allowed || !grid.dirty} title={editGate.title}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          Save charges
        </button>
      </div>
    </section>
  );
}
