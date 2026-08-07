"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/fetcher";
import { gate, gateDo } from "@/lib/permission-ui";
import { PRICE_PER, PRICE_PER_LABELS, type PricePerValue } from "@/lib/part-constants";
import { swapAt } from "@/lib/reorder";
import { useLatest } from "@/lib/use-latest";

// Local mirrors of src/server/part-prices.ts's PartPriceRow/PartBreakRow — not imported from
// src/server/**, since a client component pulling from there drags node:async_hooks and Prisma
// into the browser bundle (CLAUDE.md "Constraints that will bite you"). Decimal fields are
// `number | string` (and `| null` where the column is nullable): a value loaded from the server is
// a number, but mid-edit the bound input holds whatever text the user is typing — the
// customers/[id]/page.tsx creditLimit precedent.
type PriceBreak = { id: string; threshold: number | string; price: number | string };
type PriceRow = {
  id: string;
  processStepCodeId: string;
  stepCode: string;
  stepName: string;
  position: number;
  setupCharge: number | string | null;
  unitPrice: number | string | null;
  minimumCharge: number | string | null;
  pricePer: PricePerValue;
  breaks: PriceBreak[];
};
type StepCodeOption = { id: string; name: string; active: boolean };

type RowMoneyField = "setupCharge" | "unitPrice" | "minimumCharge";
type BreakField = "threshold" | "price";

export function PricingSection({
  partId, perms, onError, onOptionsError,
}: {
  partId: string;
  perms: string[] | undefined;
  onError: (message: string | null) => void;
  onOptionsError: (message: string) => void;
}) {
  const canEdit = gate(perms, "parts.edit");
  const priceGate = gateDo(perms, "change_prices");
  // Every control in this section needs BOTH gates — parts.edit (can this user touch the part at
  // all) and change_prices (can they touch pricing specifically), spec §7. Computed once and
  // reused rather than re-derived per control. The title favors whichever is actually the
  // blocker: a user who holds change_prices but not parts.edit sees the edit gate's reason
  // instead of "Requires change_prices" for a control they were never going to be allowed to
  // touch regardless. (Carried over from the pre-Phase-5A PricingSection.)
  const disabled = canEdit.disabled || priceGate.disabled;
  const title = canEdit.disabled ? canEdit.title : priceGate.title;

  const [rows, setRows] = useState<PriceRow[]>([]);
  const [codes, setCodes] = useState<StepCodeOption[]>([]);
  const [codesReady, setCodesReady] = useState(false);
  const [addCodeId, setAddCodeId] = useState("");
  const [addingRow, setAddingRow] = useState(false);
  // Per-row "add a break" draft, keyed by price row id — a card's own nested table gets its own
  // add-row, so one shared draft (the old flat section's shape) would leak text typed under one
  // operation's breaks into another's the moment either was submitted.
  const [breakDrafts, setBreakDrafts] = useState<Record<string, { threshold: string; price: string }>>({});
  function draftFor(priceId: string) {
    return breakDrafts[priceId] ?? { threshold: "", price: "" };
  }

  // Guards the list reload against an out-of-order response (src/lib/use-latest.ts) — this
  // section funnels every mutation (add/edit/remove a row, reorder, add/edit/remove a break)
  // through the same full-list `load()`, so a slower earlier reload landing after a faster later
  // one would otherwise silently revert the screen past what the user just did.
  const rowsLatest = useLatest();
  const load = useCallback(async () => {
    const t = rowsLatest.next();
    const data = await api<PriceRow[]>(`/api/parts/${partId}/prices`);
    if (rowsLatest.isCurrent(t)) setRows(data);
  }, [partId, rowsLatest]);
  useEffect(() => { load().catch((e) => onError((e as Error).message)); }, [load, onError]);

  // F9: a failed step-code-options fetch reports through `onOptionsError` (the page's persistent
  // loadError banner), not the shared `onError` a later successful save elsewhere would clear —
  // the Inspections/Specs sections' precedent. includeInactive=1: an existing row can be priced
  // against a step code that's since gone inactive (the Inspections code/scale precedent) — the
  // per-row select below still needs it as an option, not just the Add-operation picker.
  useEffect(() => {
    api<StepCodeOption[]>("/api/picklists/processStepCode?includeInactive=1").then((data) => {
      setCodes(data);
      setCodesReady(true);
    }).catch((e) => onOptionsError((e as Error).message));
  }, [onOptionsError]);

  function setRowField(id: string, field: RowMoneyField, value: string) {
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }
  // Optimistic (mirrors InspectionsSection's saveRow): the row already shows the new value, so a
  // failure has something to roll back. Roll back to server truth FIRST, then report why (§5.13)
  // — load() before onError, never the other way around. Server messages (the LOT-with-breaks
  // refusal, the duplicate-operation refusal) surface verbatim; no client re-paraphrasing.
  async function saveRow(id: string, patch: Record<string, unknown>): Promise<boolean> {
    setRows((cur) => cur.map((r) => (r.id === id ? ({ ...r, ...patch } as PriceRow) : r)));
    try {
      await api(`/api/parts/${partId}/prices/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      onError(null);
      return true;
    } catch (e) {
      await load().catch(() => {});
      onError((e as Error).message);
      return false;
    }
  }

  // One ref for every text field in this section — only one can hold focus at a time (the
  // customers/[id]/page.tsx precedent) — so a blur that changed nothing issues no request.
  const focusedValue = useRef("");
  const noteFocus = (e: React.FocusEvent<HTMLInputElement>) => { focusedValue.current = e.target.value; };
  function blurSaveRow(e: React.FocusEvent<HTMLInputElement>, id: string, field: RowMoneyField) {
    const value = e.target.value;
    if (value === focusedValue.current) return;
    void saveRow(id, { [field]: value === "" ? null : value });
  }

  // The open question this task owns (task-5 brief, carried in from Task 4's review): moving a
  // row's basis among the non-LOT units (EACH/LB/PER_1000/PER_100) while it still has live breaks
  // silently changes what every stored `threshold` means — the service does not (and, per Task 9's
  // marker, should not: a row whose breaks predate a basis change is a state the pricing engine is
  // explicitly expected to cope with) refuse this the way it refuses a LOT move. Decision: warn,
  // don't refuse and don't attempt to re-derive new thresholds — refusing would foreclose a state
  // Task 9 is already scoped to handle, and re-stating the numbers would require a unit conversion
  // (e.g. EACH -> LB needs a weight-per-piece) this screen has no authority to invent. The old
  // flat-column surface allowed the same move with no warning at all; this at least tells the user
  // what just happened before it happens. LOT itself needs no client-side pre-check — the existing
  // save path already surfaces the server's LOT_WITH_BREAKS refusal verbatim.
  function changePricePer(row: PriceRow, next: PricePerValue) {
    if (next === row.pricePer) return;
    if (row.breaks.length > 0 && row.pricePer !== "LOT" && next !== "LOT") {
      const ok = confirm(
        `This operation has ${row.breaks.length} price break(s) with thresholds stated in ` +
        `${PRICE_PER_LABELS[row.pricePer]} units. Switching to ${PRICE_PER_LABELS[next]} does not ` +
        `change those threshold numbers — they will be read as ${PRICE_PER_LABELS[next]} amounts ` +
        `from now on. Continue?`
      );
      if (!ok) return; // Nothing was set locally, so the controlled <select> stays at row.pricePer.
    }
    void saveRow(row.id, { pricePer: next });
  }

  async function removeRow(id: string) {
    try {
      await api(`/api/parts/${partId}/prices/${id}`, { method: "DELETE" });
      onError(null);
      await load();
    } catch (e) { onError((e as Error).message); }
  }

  // part-prices.ts ships no atomic /reorder route (only a per-row PATCH that happens to accept
  // `position`), so an up/down move is two sequential PATCHes rather than the Inspections/
  // ProcessSteps sections' one-call swap. `position` carries no uniqueness constraint, so there is
  // no transient-collision ordering to worry about between the two calls. Roll back to server
  // truth FIRST, then report why (§5.13) on either call's failure.
  async function move(idx: number, dir: -1 | 1) {
    const reordered = swapAt(rows, idx, dir); // bounds check only — the buttons are already
    if (!reordered) return;                   // disabled at the ends of the list (belt + braces).
    const a = rows[idx];
    const b = rows[idx + dir];
    try {
      await api(`/api/parts/${partId}/prices/${a.id}`, {
        method: "PATCH", body: JSON.stringify({ position: b.position }) });
      await api(`/api/parts/${partId}/prices/${b.id}`, {
        method: "PATCH", body: JSON.stringify({ position: a.position }) });
      onError(null);
      await load();
    } catch (e) {
      await load().catch(() => {});
      onError((e as Error).message);
    }
  }

  // One at a time (the ProcessStepsSection addStepAction precedent) — `addingRow` blocks a second
  // click from firing before the first POST returns.
  async function addRow() {
    if (!addCodeId || addingRow) return;
    setAddingRow(true);
    try {
      // The highest position actually present, plus one — not rows.length, which duplicates a
      // position after a mid-list delete (the InspectionsSection F6 fix).
      const nextPosition = rows.length ? Math.max(...rows.map((r) => r.position)) + 1 : 0;
      await api(`/api/parts/${partId}/prices`, {
        method: "POST", body: JSON.stringify({ processStepCodeId: addCodeId, position: nextPosition }),
      });
      setAddCodeId("");
      onError(null);
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setAddingRow(false);
    }
  }

  function setBreakDraft(priceId: string, field: BreakField, value: string) {
    setBreakDrafts((cur) => ({ ...cur, [priceId]: { ...draftFor(priceId), [field]: value } }));
  }
  function setBreakField(priceId: string, breakId: string, field: BreakField, value: string) {
    setRows((cur) => cur.map((r) => (r.id === priceId
      ? { ...r, breaks: r.breaks.map((b) => (b.id === breakId ? { ...b, [field]: value } : b)) }
      : r)));
  }
  async function saveBreak(priceId: string, breakId: string, patch: Record<string, unknown>): Promise<boolean> {
    setRows((cur) => cur.map((r) => (r.id === priceId
      ? { ...r, breaks: r.breaks.map((b) => (b.id === breakId ? ({ ...b, ...patch } as PriceBreak) : b)) }
      : r)));
    try {
      await api(`/api/parts/${partId}/prices/${priceId}/breaks/${breakId}`, {
        method: "PATCH", body: JSON.stringify(patch) });
      onError(null);
      return true;
    } catch (e) {
      await load().catch(() => {});
      onError((e as Error).message);
      return false;
    }
  }
  function blurSaveBreak(
    e: React.FocusEvent<HTMLInputElement>, priceId: string, breakId: string, field: BreakField,
  ) {
    const value = e.target.value;
    if (value === focusedValue.current) return;
    void saveBreak(priceId, breakId, { [field]: value });
  }
  async function addBreak(priceId: string) {
    const draft = draftFor(priceId);
    if (!draft.threshold || !draft.price) return;
    try {
      await api(`/api/parts/${partId}/prices/${priceId}/breaks`, {
        method: "POST", body: JSON.stringify({ threshold: draft.threshold, price: draft.price }),
      });
      setBreakDrafts((cur) => ({ ...cur, [priceId]: { threshold: "", price: "" } }));
      onError(null);
      await load();
    } catch (e) { onError((e as Error).message); }
  }
  async function removeBreak(priceId: string, breakId: string) {
    try {
      await api(`/api/parts/${partId}/prices/${priceId}/breaks/${breakId}`, { method: "DELETE" });
      onError(null);
      await load();
    } catch (e) { onError((e as Error).message); }
  }

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Pricing</h2>

      {rows.length === 0 && (
        <p className="mb-3 text-sm text-slate-500">No priced operations yet — add one below.</p>
      )}

      <div className="mb-4 space-y-4">
        {rows.map((row, idx) => {
          // R3: a controlled <select> bound to an id absent from its options renders blank,
          // misrepresenting the stored assignment and risking clobbering it on the next
          // interaction (the InspectionsSection/customers-page precedent) — reachable here if the
          // options fetch is still in flight, failed, or (in principle) omitted a code. A
          // synthesized fallback option built straight from the row's own embedded stepCode/
          // stepName (no extra fetch needed) keeps the control honest either way.
          const hasCode = codes.some((c) => c.id === row.processStepCodeId);
          return (
            <div key={row.id} className="rounded border p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <select value={row.processStepCodeId} disabled={disabled || !codesReady}
                        title={!codesReady ? "Options failed to load — reload the page" : title}
                        onChange={(e) => void saveRow(row.id, { processStepCodeId: e.target.value })}
                        className="rounded border px-2 py-1 text-sm">
                  {!hasCode && (
                    <option value={row.processStepCodeId}>{row.stepCode} — {row.stepName}</option>
                  )}
                  {codes.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{!c.active && " (inactive)"}</option>
                  ))}
                </select>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => move(idx, -1)} disabled={disabled || idx === 0}
                          title={title} aria-label="Move up"
                          className="text-xs disabled:cursor-not-allowed disabled:text-slate-300">
                    ↑
                  </button>
                  <button type="button" onClick={() => move(idx, 1)}
                          disabled={disabled || idx === rows.length - 1}
                          title={title} aria-label="Move down"
                          className="text-xs disabled:cursor-not-allowed disabled:text-slate-300">
                    ↓
                  </button>
                  <button type="button" onClick={() => removeRow(row.id)} disabled={disabled} title={title}
                          className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                    Remove operation
                  </button>
                </div>
              </div>

              <div className="mb-3 grid grid-cols-4 gap-3">
                <label className="block text-sm">
                  Setup charge
                  <input value={row.setupCharge ?? ""} inputMode="decimal" onFocus={noteFocus}
                         readOnly={disabled} title={title}
                         onChange={(e) => setRowField(row.id, "setupCharge", e.target.value)}
                         onBlur={(e) => blurSaveRow(e, row.id, "setupCharge")}
                         className="mt-1 w-full rounded border px-2 py-1 text-right read-only:bg-slate-50" />
                </label>
                <label className="block text-sm">
                  Unit price
                  <input value={row.unitPrice ?? ""} inputMode="decimal" onFocus={noteFocus}
                         readOnly={disabled} title={title}
                         onChange={(e) => setRowField(row.id, "unitPrice", e.target.value)}
                         onBlur={(e) => blurSaveRow(e, row.id, "unitPrice")}
                         className="mt-1 w-full rounded border px-2 py-1 text-right read-only:bg-slate-50" />
                </label>
                <label className="block text-sm">
                  Minimum charge
                  <input value={row.minimumCharge ?? ""} inputMode="decimal" onFocus={noteFocus}
                         readOnly={disabled} title={title}
                         onChange={(e) => setRowField(row.id, "minimumCharge", e.target.value)}
                         onBlur={(e) => blurSaveRow(e, row.id, "minimumCharge")}
                         className="mt-1 w-full rounded border px-2 py-1 text-right read-only:bg-slate-50" />
                </label>
                <label className="block text-sm">
                  Price per
                  <select value={row.pricePer} disabled={disabled} title={title}
                          onChange={(e) => changePricePer(row, e.target.value as PricePerValue)}
                          className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-100">
                    {PRICE_PER.map((p) => <option key={p} value={p}>{PRICE_PER_LABELS[p]}</option>)}
                  </select>
                </label>
              </div>

              <h3 className="mb-1 text-xs font-medium text-slate-600">Price breaks</h3>
              <table className="mb-2 w-full text-sm">
                <thead>
                  <tr className="text-left">
                    <th className="py-1">Threshold</th><th>Price</th><th />
                  </tr>
                </thead>
                <tbody>
                  {row.breaks.map((b) => (
                    <tr key={b.id} className="border-t">
                      <td className="py-1">
                        <input value={b.threshold} inputMode="decimal" onFocus={noteFocus}
                               readOnly={disabled} title={title}
                               onChange={(e) => setBreakField(row.id, b.id, "threshold", e.target.value)}
                               onBlur={(e) => blurSaveBreak(e, row.id, b.id, "threshold")}
                               className="w-24 rounded border px-1 py-0.5 text-right read-only:bg-slate-50" />
                      </td>
                      <td>
                        <input value={b.price} inputMode="decimal" onFocus={noteFocus}
                               readOnly={disabled} title={title}
                               onChange={(e) => setBreakField(row.id, b.id, "price", e.target.value)}
                               onBlur={(e) => blurSaveBreak(e, row.id, b.id, "price")}
                               className="w-24 rounded border px-1 py-0.5 text-right read-only:bg-slate-50" />
                      </td>
                      <td className="text-right">
                        <button onClick={() => removeBreak(row.id, b.id)} disabled={disabled} title={title}
                                className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                          delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex gap-2">
                <input value={draftFor(row.id).threshold} placeholder="Threshold" inputMode="decimal"
                       disabled={disabled}
                       onChange={(e) => setBreakDraft(row.id, "threshold", e.target.value)}
                       className="w-24 rounded border px-2 py-1 text-sm" />
                <input value={draftFor(row.id).price} placeholder="Price" inputMode="decimal"
                       disabled={disabled}
                       onChange={(e) => setBreakDraft(row.id, "price", e.target.value)}
                       className="w-24 rounded border px-2 py-1 text-sm" />
                <button onClick={() => addBreak(row.id)}
                        disabled={disabled || !draftFor(row.id).threshold || !draftFor(row.id).price}
                        title={title}
                        className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                  Add break
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <select value={addCodeId} disabled={disabled || !codesReady}
                title={!codesReady ? "Options failed to load — reload the page" : title}
                onChange={(e) => setAddCodeId(e.target.value)}
                className="rounded border px-2 py-1 text-sm">
          <option value="">Add operation: code…</option>
          {codes.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button onClick={addRow} disabled={disabled || !addCodeId || addingRow}
                title={addingRow ? "Adding…" : title}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          {addingRow ? "Adding…" : "Add operation"}
        </button>
      </div>
    </section>
  );
}
