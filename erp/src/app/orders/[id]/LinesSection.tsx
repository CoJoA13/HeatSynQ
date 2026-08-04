"use client";
import { useRef, useState } from "react";
import { api } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { Combobox, type ComboboxOption } from "../new/Combobox";
import { computeLineWeight } from "../new/OrderLineCard";
import type { ApplyMutation, OrderLine, OrderMutationResult, PartOption } from "./page";

function lineLabel(line: OrderLine): string {
  return line.position === 1 ? "Lead" : `Line ${line.position}`;
}

/**
 * The lead (position 1, badged "Lead · Rev N locked" — part and revision immutable) plus every
 * rider (qty/weight editable, remove-with-confirm) and the add-rider form. Task 5's
 * `updateLine`/`addLine`/`removeLine` (spec §5a): customer and the lead part/revision can never
 * be changed here — a wrong-part order is voided and re-keyed, never edited down to its lead.
 *
 * qty/weight are per-field onBlur-saves (the customers/[id]/page.tsx address-cell precedent),
 * NOT the bulk-grid overlay pattern (src/lib/bulk-grid.ts) — there is no array-shaped bulk PUT
 * here, just one PATCH per field, so a small local `edits` map (only the lines actually being
 * typed into, keyed by line id) is enough to keep an in-progress edit visible without needing a
 * parent-owned optimistic copy of `order.lines`.
 */
export function LinesSection({
  orderId, lines, customerParts, editGate, partsGate, applyMutation, onError,
}: {
  orderId: string;
  lines: OrderLine[];
  /** The order's customer's full catalog (active AND inactive) — src/app/orders/[id]/page.tsx's
   *  own comment on why it fetches both. */
  customerParts: PartOption[];
  editGate: Gate;
  partsGate: Gate;
  applyMutation: ApplyMutation;
  onError: (message: string | null) => void;
}) {
  // Only the fields actually being typed into — an untouched line always shows server truth
  // (`shown` below), so a fresh `order` prop (from an unrelated section's mutation) can never be
  // masked by a stale local copy. Cleared the moment a save actually lands.
  const [edits, setEdits] = useState<Map<string, { qty?: string; weight?: string }>>(new Map());
  const focusedValue = useRef("");

  function shown(line: OrderLine, field: "qty" | "weight"): string {
    return edits.get(line.id)?.[field] ?? String(line[field]);
  }
  function setDraft(lineId: string, patch: { qty?: string; weight?: string }) {
    setEdits((cur) => {
      const next = new Map(cur);
      next.set(lineId, { ...next.get(lineId), ...patch });
      return next;
    });
  }
  function clearDraft(lineId: string) {
    setEdits((cur) => {
      if (!cur.has(lineId)) return cur;
      const next = new Map(cur);
      next.delete(lineId);
      return next;
    });
  }

  function noteFocus(e: React.FocusEvent<HTMLInputElement>) {
    focusedValue.current = e.target.value;
  }

  async function saveField(line: OrderLine, field: "qty" | "weight", raw: string) {
    const trimmed = raw.trim();
    if (trimmed === String(line[field])) { clearDraft(line.id); return; } // no real change — skip the round trip
    if (field === "qty") {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 1) {
        onError(`${lineLabel(line)}: quantity must be a whole number of at least 1.`);
        return;
      }
    } else {
      const n = Number(trimmed);
      if (!(n > 0) || Number.isNaN(n)) {
        onError(`${lineLabel(line)}: weight must be greater than zero.`);
        return;
      }
    }
    const body = field === "qty" ? { qty: Number(trimmed) } : { weight: trimmed };
    try {
      await applyMutation(() => api<OrderMutationResult>(
        `/api/orders/${orderId}/lines/${line.id}`, { method: "PATCH", body: JSON.stringify(body) },
      ));
      clearDraft(line.id);
      onError(null);
    } catch (e) {
      // Keep the local edit so the user sees exactly what they typed and can fix it — the field
      // is not rolled back, since nothing shared (`order` state) was ever optimistically changed.
      onError((e as Error).message);
    }
  }

  function onBlurField(e: React.FocusEvent<HTMLInputElement>, line: OrderLine, field: "qty" | "weight") {
    if (e.target.value === focusedValue.current) return;
    void saveField(line, field, e.target.value);
  }

  async function removeLine(line: OrderLine) {
    if (!confirm(`Remove ${line.part.customer.code} · ${line.part.partNumber} (${lineLabel(line)}) from this order?`)) return;
    try {
      await applyMutation(() =>
        api<OrderMutationResult>(`/api/orders/${orderId}/lines/${line.id}`, { method: "DELETE" }));
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  // ---- add rider ----
  const [addPartId, setAddPartId] = useState<string | null>(null);
  const [addQty, setAddQty] = useState("");
  const [addWeightOverride, setAddWeightOverride] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Inactive parts cannot be added (resolveLineParts refuses them server-side) — riders are
  // otherwise unrestricted regardless of hasProcessSteps (spec §11: only the lead locks a
  // revision), so unlike the entry page's lead picker, no option here is ever disabled.
  const addOptions: ComboboxOption[] = customerParts
    .filter((p) => p.active)
    .map((p) => ({ value: p.id, label: `${p.partNumber} — ${p.name}` }));
  const addPart = customerParts.find((p) => p.id === addPartId);
  const computedAddWeight = computeLineWeight(addPart, Number(addQty));
  const displayedAddWeight = addWeightOverride ?? (computedAddWeight !== null ? String(computedAddWeight) : "");

  async function addRider() {
    if (adding) return;
    if (!addPartId) { onError("Pick a part to add as a rider."); return; }
    const qty = Number(addQty);
    if (!Number.isInteger(qty) || qty < 1) { onError("New line: enter a quantity of at least 1."); return; }
    const weight = addWeightOverride !== null ? addWeightOverride.trim() : String(computedAddWeight ?? 0);
    if (!(Number(weight) > 0)) { onError("New line: enter a weight greater than zero."); return; }
    setAdding(true);
    try {
      await applyMutation(() => api<OrderMutationResult>(`/api/orders/${orderId}/lines`, {
        method: "POST", body: JSON.stringify({ partId: addPartId, qty, weight }),
      }));
      onError(null);
      setAddPartId(null);
      setAddQty("");
      setAddWeightOverride(null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  const addTitle = !partsGate.allowed ? partsGate.title : editGate.title;

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Lines</h2>
      <table className="mb-3 w-full text-sm">
        <thead>
          <tr className="text-left">
            <th className="py-1">&nbsp;</th><th>Part</th><th>Qty</th><th>Weight</th><th />
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} className="border-t">
              <td className="py-1">
                {line.position === 1 ? (
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-white">
                    Lead · Rev {line.revisionNumber ?? "?"} locked
                  </span>
                ) : (
                  <span className="text-xs text-slate-500">Line {line.position}</span>
                )}
              </td>
              <td className="font-mono">{line.part.customer.code} · {line.part.partNumber} <span className="font-sans text-slate-500">— {line.part.name}</span></td>
              <td>
                <input value={shown(line, "qty")} inputMode="numeric" onFocus={noteFocus}
                       disabled={editGate.disabled} title={editGate.title}
                       onChange={(e) => setDraft(line.id, { qty: e.target.value })}
                       onBlur={(e) => onBlurField(e, line, "qty")}
                       aria-label={`${lineLabel(line)} quantity`}
                       className="w-20 rounded border px-1 py-0.5 disabled:bg-slate-50" />
              </td>
              <td>
                <input value={shown(line, "weight")} inputMode="decimal" onFocus={noteFocus}
                       disabled={editGate.disabled} title={editGate.title}
                       onChange={(e) => setDraft(line.id, { weight: e.target.value })}
                       onBlur={(e) => onBlurField(e, line, "weight")}
                       aria-label={`${lineLabel(line)} weight`}
                       className="w-24 rounded border px-1 py-0.5 disabled:bg-slate-50" />
              </td>
              <td className="text-right">
                {line.position !== 1 && (
                  <button onClick={() => void removeLine(line)} disabled={editGate.disabled} title={editGate.title}
                          className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex flex-wrap items-end gap-2 border-t pt-3 text-sm">
        <label className="block">
          Add rider — part
          <Combobox value={addPartId} options={addOptions} onSelect={setAddPartId}
                     disabled={editGate.disabled || !partsGate.allowed} title={addTitle}
                     placeholder="Part number or name" ariaLabel="Add rider part" />
        </label>
        <label className="block">
          Qty
          <input value={addQty} inputMode="numeric" onChange={(e) => setAddQty(e.target.value)}
                 disabled={editGate.disabled || !partsGate.allowed} title={addTitle}
                 aria-label="Add rider quantity" className="mt-1 w-20 rounded border px-2 py-1 disabled:bg-slate-50" />
        </label>
        <label className="block">
          Weight
          <input value={displayedAddWeight} inputMode="decimal"
                 onChange={(e) => setAddWeightOverride(e.target.value)}
                 disabled={editGate.disabled || !partsGate.allowed} title={addTitle}
                 aria-label="Add rider weight" className="mt-1 w-24 rounded border px-2 py-1 disabled:bg-slate-50" />
        </label>
        {addWeightOverride !== null && (
          <button type="button" onClick={() => setAddWeightOverride(null)}
                  disabled={editGate.disabled || !partsGate.allowed} title={addTitle}
                  className="text-xs text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
            Reset to computed
          </button>
        )}
        <button onClick={() => void addRider()} disabled={editGate.disabled || !partsGate.allowed || adding}
                title={addTitle}
                className="rounded bg-slate-800 px-3 py-1 text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          {adding ? "Adding…" : "Add rider"}
        </button>
      </div>
    </section>
  );
}
