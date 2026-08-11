"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { Combobox, type ComboboxOption } from "../new/Combobox";
import { computeLineWeight } from "../new/OrderLineCard";
import {
  QuoteLinkPicker, type EligiblePayload, type QuoteLinkPick,
} from "../new/QuoteLinkPicker";
import type { ApplyMutation, OrderLine, OrderMutationResult, PartOption } from "./page";

function lineLabel(line: OrderLine): string {
  return line.position === 1 ? "Lead" : `Line ${line.position}`;
}

/**
 * The SAVED line's quote re-pick (spec §5.2's re-pick rule): mounted only when the user opens it,
 * it fetches eligibility against the order's CURRENT received date and PATCHes `quoteLineId`
 * only on an explicit selection. The untouched state is represented by the "keep" placeholder —
 * selecting nothing (or closing) sends NO request, so the stored link is kept by updateLine's
 * absent-key semantics rather than re-asserted; the stored id is never echoed back. The current
 * link is excluded from the option list (picking it again would be a no-op write minting an
 * empty audit diff), and "No quote" is offered only while a link exists to remove.
 */
function LineQuoteRepick({
  orderId, line, customerId, receivedDate, viewAllowed, applyMutation, onError, onClose,
}: {
  orderId: string;
  line: OrderLine;
  customerId: string;
  receivedDate: string;
  viewAllowed: boolean;
  applyMutation: ApplyMutation;
  onError: (message: string | null) => void;
  onClose: () => void;
}) {
  const [payload, setPayload] = useState<EligiblePayload | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const partId = line.partId;
  useEffect(() => {
    if (!viewAllowed) return;
    let stale = false;
    const qs = new URLSearchParams({ customerId, partId, receivedDate });
    api<EligiblePayload>(`/api/quotes/eligible?${qs}`).then((p) => {
      if (!stale) setPayload(p);
    }).catch((e) => {
      if (!stale) setFetchError((e as Error).message);
    });
    return () => { stale = true; };
  }, [customerId, partId, receivedDate, viewAllowed]);

  async function pick(quoteLineId: string | null) {
    setSaving(true);
    try {
      await applyMutation(() => api<OrderMutationResult>(
        `/api/orders/${orderId}/lines/${line.id}`,
        { method: "PATCH", body: JSON.stringify({ quoteLineId }) },
      ));
      onError(null);
      onClose();
    } catch (e) {
      // §5.13: the refusal (judgeQuoteLine's named reason) is shown; the control stays open with
      // everything as it was so the user can pick differently or close.
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!viewAllowed) {
    return (
      <span className="ml-2 text-xs text-slate-500">
        Re-pick requires orders.view.{" "}
        <button onClick={onClose} className="text-blue-700 underline">close</button>
      </span>
    );
  }
  if (fetchError) {
    return (
      <span className="ml-2 text-xs text-amber-800">
        Could not check quotes: {fetchError}{" "}
        <button onClick={onClose} className="text-blue-700 underline">close</button>
      </span>
    );
  }
  if (!payload) return <span className="ml-2 text-xs text-slate-500">Checking quotes…</span>;

  const options = payload.candidates.filter((c) => c.quoteLineId !== line.quoteLineId);
  const nothingToChange = options.length === 0 && line.quoteLineId === null;

  return (
    <span className="ml-2 inline-flex items-center gap-1.5 text-xs">
      {nothingToChange ? (
        <span className="text-slate-500">No eligible quotes as of the received date.</span>
      ) : (
        <select value="" disabled={saving} aria-label={`${lineLabel(line)} quote re-pick`}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") return; // the "keep" placeholder — never a request
                  void pick(v === "none" ? null : v);
                }}
                className="rounded border px-1 py-0.5">
          <option value="">
            {line.quoteNumber !== null ? `— keep Quote #${line.quoteNumber} —` : "— keep: no quote —"}
          </option>
          {options.map((c) => (
            <option key={c.quoteLineId} value={c.quoteLineId}>
              Quote #{c.quoteNumber} (effective {c.effectiveDate} to {c.expiryDate})
            </option>
          ))}
          {line.quoteLineId !== null && <option value="none">No quote</option>}
        </select>
      )}
      <button onClick={onClose} disabled={saving} className="text-blue-700 underline">close</button>
    </span>
  );
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
  orderId, lines, customerParts, editGate, partsGate, customerId, receivedDate, ordersViewAllowed,
  applyMutation, onError,
}: {
  orderId: string;
  lines: OrderLine[];
  /** The order's customer's full catalog (active AND inactive) — src/app/orders/[id]/page.tsx's
   *  own comment on why it fetches both. */
  customerParts: PartOption[];
  editGate: Gate;
  partsGate: Gate;
  /** For the quote-link surfaces (Task 9): the re-pick reads eligibility against the order's
   *  CURRENT received date (§5.2's re-pick rule) and the add-rider preview against the same —
   *  addLine judges against the ORDER's stored received date, however backdated (ruling 6). */
  customerId: string;
  receivedDate: string;
  ordersViewAllowed: boolean;
  applyMutation: ApplyMutation;
  onError: (message: string | null) => void;
}) {
  // Only the fields actually being typed into — an untouched line always shows server truth
  // (`shown` below), so a fresh `order` prop (from an unrelated section's mutation) can never be
  // masked by a stale local copy. Cleared the moment a save actually lands.
  const [edits, setEdits] = useState<Map<string, { qty?: string; weight?: string }>>(new Map());
  const focusedValue = useRef("");
  // Which line's quote re-pick is open (one at a time — the control fetches on open, so leaving
  // every line's list mounted would mean N idle fetches for a control few saves ever touch).
  const [repickLineId, setRepickLineId] = useState<string | null>(null);

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
  // The rider's three-way quote pick, exactly the entry form's LineDraft.quoteLineIdOverride:
  // undefined = untouched — the POST body OMITS `quoteLineId` and addLine auto-resolves; a
  // string/null is the explicit pick/unlink. The previewed auto-link's id is never copied in
  // (QuoteLinkPicker's contract), so an untouched control sends ABSENT by construction.
  const [addQuotePick, setAddQuotePick] = useState<QuoteLinkPick>(undefined);
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
        method: "POST", body: JSON.stringify({
          partId: addPartId, qty, weight,
          // Three-way (spec §5.2): present only for an explicit pick/unlink; ABSENT while
          // untouched, so addLine's own auto-resolution stays authoritative.
          ...(addQuotePick !== undefined ? { quoteLineId: addQuotePick } : {}),
        }),
      }));
      onError(null);
      setAddPartId(null);
      setAddQty("");
      setAddWeightOverride(null);
      setAddQuotePick(undefined);
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
            <th className="py-1">&nbsp;</th><th>Part</th><th>Qty</th><th>Weight</th><th>Quote</th><th />
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
              <td>
                {/* Spec §5.2 Display: the STORED link (judged at link time, ruling 6 — never
                    re-derived; a received-date edit refreshes nothing here). The re-pick, when
                    opened, fetches eligibility against the CURRENT received date and PATCHes
                    only on an explicit selection — an untouched (or closed) re-pick sends no
                    request at all, which IS updateLine's absent-key "keep" semantics. */}
                {line.quoteId !== null && line.quoteNumber !== null ? (
                  <Link href={`/quotes/${line.quoteId}`} className="text-blue-700 underline">
                    Quote #{line.quoteNumber}
                  </Link>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
                {repickLineId === line.id ? (
                  <LineQuoteRepick orderId={orderId} line={line} customerId={customerId}
                                   receivedDate={receivedDate} viewAllowed={ordersViewAllowed}
                                   applyMutation={applyMutation} onError={onError}
                                   onClose={() => setRepickLineId(null)} />
                ) : (
                  <button onClick={() => setRepickLineId(line.id)}
                          disabled={editGate.disabled} title={editGate.title}
                          className="ml-2 text-xs text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
                    change
                  </button>
                )}
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
          {/* A part swap resets the quote pick to auto (spec §5.2) — a pick made for the old
              part must never ride onto the new one (the entry card's own rule). */}
          <Combobox value={addPartId} options={addOptions}
                     onSelect={(id) => { setAddPartId(id); setAddQuotePick(undefined); }}
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
        {/* The rider's quote-link preview + re-pick (spec §5.2 — addLine is a create path with
            the same three-way semantics as entry). Judged against the ORDER's stored received
            date (ruling 6), which is why the fetch pins `receivedDate` rather than omitting it.
            Full-width so the flex-wrap row breaks below the inputs. */}
        <div className="w-full">
          <QuoteLinkPicker customerId={customerId} partId={addPartId} receivedDate={receivedDate}
                           value={addQuotePick} onChange={setAddQuotePick}
                           pickGate={editGate} viewAllowed={ordersViewAllowed}
                           ariaLabel="Add rider quote link" />
        </div>
      </div>
    </section>
  );
}
