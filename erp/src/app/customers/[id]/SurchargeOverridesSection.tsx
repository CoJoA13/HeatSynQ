"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/fetcher";
import { gate, gateDo } from "@/lib/permission-ui";
import { useLatest } from "@/lib/use-latest";
import { percentToDecimal, decimalToPercentText } from "@/lib/surcharge-percent";
import {
  buildCustomerSurchargeBody as buildBody,
  type CustomerSurchargeOptionRow as SurchargeRow,
  type CustomerSurchargeSaveFields as SaveFields,
} from "@/lib/customer-surcharge-body";

/** Formats a Decimal(12,2) money value the way the field itself is scaled — the admin
 *  surcharges page `moneyText` precedent (src/app/admin/surcharges/page.tsx). */
function moneyText(value: number | null): string {
  return value === null ? "" : value.toFixed(2);
}

export function SurchargeOverridesSection({
  customerId, perms, onError,
}: {
  customerId: string;
  perms: string[] | undefined;
  onError: (message: string | null) => void;
}) {
  const canEdit = gate(perms, "customers.edit");
  const priceGate = gateDo(perms, "change_prices");
  // Both gates, same as the parts Pricing section (task-8 brief): every control here needs
  // customers.edit (can this user touch the customer at all) AND change_prices (can they touch
  // pricing specifically — a per-customer surcharge override is a price change, the route's own
  // mustCan+mustDo). The title favors whichever is actually the blocker (PricingSection.tsx's own
  // comment): a user who holds change_prices but not customers.edit sees the edit gate's reason,
  // not "Requires change_prices" for a control they were never going to be allowed to touch
  // regardless.
  const disabled = canEdit.disabled || priceGate.disabled;
  const title = canEdit.disabled ? canEdit.title : priceGate.title;

  const [rows, setRows] = useState<SurchargeRow[]>([]);

  // rowsRef mirrors `rows` for save-time reads (surcharges/page.tsx's `rowsRef` precedent): a
  // queued save must compose its payload from the FRESHEST known row, not whatever was on screen
  // when the field was first focused. Written unconditionally on every completed fetch, never
  // gated by the `useLatest` ticket that guards only the rendered state below — a save queued
  // between a superseded load and the load that supersedes it must still see the newer row
  // (Task 7 re-review's fix, task-8 brief's carried-in note 3).
  const rowsRef = useRef<SurchargeRow[]>([]);
  const latest = useLatest();
  const load = useCallback(async () => {
    const ticket = latest.next();
    const r = await api<SurchargeRow[]>(`/api/customers/${customerId}/surcharges`);
    rowsRef.current = r;
    if (!latest.isCurrent(ticket)) return;
    setRows(r);
  }, [customerId, latest]);
  useEffect(() => { load().catch((e) => onError((e as Error).message)); }, [load, onError]);

  // What the user has actually typed into a free-text numeric field (rate%, amount) but not yet
  // blurred, keyed by `${surchargeId}.${field}` — composed with the server value at render time,
  // not a parallel editable copy of the row (surcharges/page.tsx `textDrafts` precedent).
  const [textDrafts, setTextDrafts] = useState<Record<string, string>>({});
  function draftValue(key: string, serverValue: string): string {
    return Object.hasOwn(textDrafts, key) ? textDrafts[key] : serverValue;
  }
  const focused = useRef<Record<string, string>>({});
  function noteFocus(key: string, value: string) { focused.current[key] = value; }
  function clearDraft(key: string) {
    setTextDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
  }

  // One at a time, shared by every write this section makes (surcharges/page.tsx `saveQueue`
  // precedent, task-8 brief's carried-in note 2): each write PUTs the surcharge override's ENTIRE
  // row, so two overlapping saves are last-writer-wins over the whole thing, and they overlap on
  // the most ordinary interaction there is — typing a value, then clicking a control (mousedown
  // blurs the input, starting save #1; the click starts save #2 before #1 returns). `save`/
  // `clearOverride` below look their row up from `rowsRef.current` INSIDE the queued run, not at
  // call time, so a later-queued run always composes against the row as it stands on ITS OWN
  // turn — after `rowsRef.current` has been updated by an earlier save's own `load()`.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  /** The one save path every field on this section goes through. `patch` carries only what
   *  changed; `buildBody` composes it — at the queued run's own turn — with the freshest server
   *  row into the WHOLE row `setCustomerSurcharge` expects (an omitted field clears it, task-8
   *  brief's opening blockquote note 1). On failure, rolls back to server truth FIRST, then
   *  reports why (§5.13). */
  function save(surchargeId: string, patch: Partial<SaveFields>): Promise<void> {
    const run = async () => {
      const row = rowsRef.current.find((r) => r.surchargeId === surchargeId);
      if (!row) return;
      const body = buildBody(row, patch);
      try {
        await api(`/api/customers/${customerId}/surcharges`, {
          method: "PUT", body: JSON.stringify({ surchargeId, ...body }),
        });
        onError(null); await load();
      } catch (e) {
        await load().catch(() => {});
        onError((e as Error).message);
      }
    };
    saveQueue.current = saveQueue.current.then(run, run);
    return saveQueue.current;
  }

  /** Removes the override entirely (rather than PUTting optOut:false/rate:null/amount:null),
   *  which is what actually frees this surcharge to be deleted — a live override row blocks its
   *  surcharge's deletion even when every field on it reads empty (task-8 brief's opening
   *  blockquote; `customerSurchargeOptions`' own `hasOverride` distinguishes the two). Same queue
   *  as `save`: must serialize against edits to this same row too. */
  function clearOverride(surchargeId: string): Promise<void> {
    const run = async () => {
      try {
        await api(`/api/customers/${customerId}/surcharges`, {
          method: "DELETE", body: JSON.stringify({ surchargeId }),
        });
        onError(null); await load();
      } catch (e) {
        await load().catch(() => {});
        onError((e as Error).message);
      }
    };
    saveQueue.current = saveQueue.current.then(run, run);
    return saveQueue.current;
  }

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Surcharge overrides</h2>
      {rows.length === 0 && (
        <p className="text-sm text-slate-500">No active surcharges are configured.</p>
      )}
      <div className="divide-y">
        {rows.map((row) => {
          const rateKey = `${row.surchargeId}.rate`;
          const amountKey = `${row.surchargeId}.amount`;
          return (
            <div key={row.surchargeId} className="flex flex-wrap items-center gap-4 py-2 text-sm">
              <span className="w-48 shrink-0 font-medium">{row.surchargeName}</span>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={row.optOut} disabled={disabled} title={title}
                       onChange={(e) => void save(row.surchargeId, { optOut: e.target.checked })} />
                Opt out
              </label>
              {row.kind === "PERCENT" ? (
                <label className="flex items-center gap-1">
                  Rate override (%)
                  <input value={draftValue(rateKey, decimalToPercentText(row.rate))} inputMode="decimal"
                         disabled={disabled} title={title} placeholder="plant rate"
                         onFocus={(e) => noteFocus(rateKey, e.target.value)}
                         onChange={(e) => setTextDrafts((d) => ({ ...d, [rateKey]: e.target.value }))}
                         onBlur={(e) => {
                           const value = e.target.value;
                           if (value === focused.current[rateKey]) { clearDraft(rateKey); return; }
                           void save(row.surchargeId, { rate: percentToDecimal(value) }).finally(() => clearDraft(rateKey));
                         }}
                         className="w-20 rounded border px-2 py-1 text-right disabled:bg-slate-100" />
                </label>
              ) : (
                <label className="flex items-center gap-1">
                  Amount override ($)
                  <input value={draftValue(amountKey, moneyText(row.amount))} inputMode="decimal"
                         disabled={disabled} title={title} placeholder="plant amount"
                         onFocus={(e) => noteFocus(amountKey, e.target.value)}
                         onChange={(e) => setTextDrafts((d) => ({ ...d, [amountKey]: e.target.value }))}
                         onBlur={(e) => {
                           const value = e.target.value;
                           if (value === focused.current[amountKey]) { clearDraft(amountKey); return; }
                           void save(row.surchargeId, { amount: value.trim() === "" ? null : value })
                             .finally(() => clearDraft(amountKey));
                         }}
                         className="w-24 rounded border px-2 py-1 text-right disabled:bg-slate-100" />
                </label>
              )}
              {/* Discoverable removal (task-8 brief's opening blockquote): only shown once a live
                  override row actually exists — `hasOverride`, not the field values, which read
                  identically to "no override" once every field is cleared back to empty. */}
              {row.hasOverride ? (
                <button onClick={() => void clearOverride(row.surchargeId)} disabled={disabled} title={title}
                        className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                  Clear override
                </button>
              ) : (
                <span className="text-xs text-slate-400">no override — bills at the plant rate</span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
