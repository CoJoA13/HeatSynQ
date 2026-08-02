"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/fetcher";
import { gate, gateDo } from "@/lib/permission-ui";
import { PRICE_PER_LABELS, type PricePerValue } from "@/lib/part-constants";
import type { Part } from "./page";

type Break = { id: string; threshold: number | string; price: number | string };

export function PricingSection({
  part, perms, save, patchDraft, onError,
}: {
  part: Part;
  perms: string[] | undefined;
  save: (patch: Record<string, unknown>) => Promise<boolean>;
  patchDraft: (patch: Partial<Part>) => void;
  onError: (message: string | null) => void;
}) {
  const canEdit = gate(perms, "parts.edit");
  const priceGate = gateDo(perms, "change_prices");
  // Every control in this section needs BOTH gates — parts.edit (can this user touch the part at
  // all) and change_prices (can they touch pricing specifically), spec §7. Computed once and
  // reused rather than re-derived per control. The title favors whichever is actually the
  // blocker: a user who holds change_prices but not parts.edit sees the edit gate's reason
  // instead of "Requires change_prices" for a control they were never going to be allowed to
  // touch regardless.
  const disabled = canEdit.disabled || priceGate.disabled;
  const title = canEdit.disabled ? canEdit.title : priceGate.title;

  const [breaks, setBreaks] = useState<Break[]>([]);
  const [draft, setDraft] = useState({ threshold: "", price: "" });

  const load = useCallback(async () => {
    const rows = await api<Break[]>(`/api/parts/${part.id}/breaks`);
    setBreaks(rows);
  }, [part.id]);
  useEffect(() => { load().catch((e) => onError((e as Error).message)); }, [load, onError]);

  function setBreakField(id: string, field: "threshold" | "price", value: string) {
    setBreaks((cur) => cur.map((b) => (b.id === id ? { ...b, [field]: value } : b)));
  }
  async function saveBreak(id: string, patch: Record<string, unknown>): Promise<boolean> {
    setBreaks((cur) => cur.map((b) => (b.id === id ? ({ ...b, ...patch } as Break) : b)));
    try {
      await api(`/api/parts/${part.id}/breaks/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      onError(null);
      return true;
    } catch (e) {
      // Roll back to server truth FIRST, then report why (§5.13) — the row above was already
      // updated optimistically.
      await load().catch(() => {});
      onError((e as Error).message);
      return false;
    }
  }
  // Server errors here (addPartBreak's "A LOT-priced part cannot carry price breaks") surface
  // through onError verbatim — no client-side re-paraphrasing of a message the service already
  // wrote for the user.
  async function addBreak() {
    try {
      await api(`/api/parts/${part.id}/breaks`, {
        method: "POST", body: JSON.stringify({ threshold: draft.threshold, price: draft.price }),
      });
      setDraft({ threshold: "", price: "" });
      onError(null);
      await load();
    } catch (e) { onError((e as Error).message); }
  }
  async function removeBreak(id: string) {
    try {
      await api(`/api/parts/${part.id}/breaks/${id}`, { method: "DELETE" });
      onError(null);
      await load();
    } catch (e) { onError((e as Error).message); }
  }

  // One ref for every text field in this section — only one can hold focus at a time, the
  // customers/[id]/page.tsx precedent.
  const focusedValue = useRef("");
  const noteFocus = (e: React.FocusEvent<HTMLInputElement>) => { focusedValue.current = e.target.value; };
  function blurSaveBreak(e: React.FocusEvent<HTMLInputElement>, id: string, field: "threshold" | "price") {
    const value = e.target.value;
    if (value === focusedValue.current) return;
    void saveBreak(id, { [field]: value });
  }
  function blurSavePart(
    e: React.FocusEvent<HTMLInputElement>, field: "setupCharge" | "unitPrice" | "minimumCharge",
  ) {
    const value = e.target.value;
    if (value === focusedValue.current) return;
    void save({ [field]: value === "" ? null : value });
  }

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Pricing</h2>
      <div className="mb-4 grid grid-cols-4 gap-3">
        <label className="block text-sm">
          Setup charge
          <input value={part.setupCharge ?? ""} inputMode="decimal" onFocus={noteFocus}
                 readOnly={disabled} title={title}
                 onChange={(e) => patchDraft({ setupCharge: e.target.value })}
                 onBlur={(e) => blurSavePart(e, "setupCharge")}
                 className="mt-1 w-full rounded border px-2 py-1 text-right read-only:bg-slate-50" />
        </label>
        <label className="block text-sm">
          Unit price
          <input value={part.unitPrice ?? ""} inputMode="decimal" onFocus={noteFocus}
                 readOnly={disabled} title={title}
                 onChange={(e) => patchDraft({ unitPrice: e.target.value })}
                 onBlur={(e) => blurSavePart(e, "unitPrice")}
                 className="mt-1 w-full rounded border px-2 py-1 text-right read-only:bg-slate-50" />
        </label>
        <label className="block text-sm">
          Minimum charge
          <input value={part.minimumCharge ?? ""} inputMode="decimal" onFocus={noteFocus}
                 readOnly={disabled} title={title}
                 onChange={(e) => patchDraft({ minimumCharge: e.target.value })}
                 onBlur={(e) => blurSavePart(e, "minimumCharge")}
                 className="mt-1 w-full rounded border px-2 py-1 text-right read-only:bg-slate-50" />
        </label>
        <label className="block text-sm">
          Price per
          <select value={part.pricePer} disabled={disabled} title={title}
                  onChange={(e) => void save({ pricePer: e.target.value })}
                  className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-100">
            {(Object.keys(PRICE_PER_LABELS) as PricePerValue[]).map((p) => (
              <option key={p} value={p}>{PRICE_PER_LABELS[p]}</option>
            ))}
          </select>
        </label>
      </div>

      <h3 className="mb-1 text-sm font-medium text-slate-600">Price breaks</h3>
      <table className="mb-2 w-full text-sm">
        <thead>
          <tr className="text-left">
            <th className="py-1">Threshold</th><th>Price</th><th />
          </tr>
        </thead>
        <tbody>
          {breaks.map((b) => (
            <tr key={b.id} className="border-t">
              <td className="py-1">
                <input value={b.threshold} inputMode="decimal" onFocus={noteFocus}
                       readOnly={disabled} title={title}
                       onChange={(e) => setBreakField(b.id, "threshold", e.target.value)}
                       onBlur={(e) => blurSaveBreak(e, b.id, "threshold")}
                       className="w-24 rounded border px-1 py-0.5 text-right read-only:bg-slate-50" />
              </td>
              <td>
                <input value={b.price} inputMode="decimal" onFocus={noteFocus}
                       readOnly={disabled} title={title}
                       onChange={(e) => setBreakField(b.id, "price", e.target.value)}
                       onBlur={(e) => blurSaveBreak(e, b.id, "price")}
                       className="w-24 rounded border px-1 py-0.5 text-right read-only:bg-slate-50" />
              </td>
              <td className="text-right">
                <button onClick={() => removeBreak(b.id)} disabled={disabled} title={title}
                        className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                  delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex gap-2">
        <input value={draft.threshold} placeholder="Threshold" inputMode="decimal" disabled={disabled}
               onChange={(e) => setDraft({ ...draft, threshold: e.target.value })}
               className="w-24 rounded border px-2 py-1 text-sm" />
        <input value={draft.price} placeholder="Price" inputMode="decimal" disabled={disabled}
               onChange={(e) => setDraft({ ...draft, price: e.target.value })}
               className="w-24 rounded border px-2 py-1 text-sm" />
        <button onClick={addBreak} disabled={disabled || !draft.threshold || !draft.price} title={title}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          Add break
        </button>
      </div>
    </section>
  );
}
