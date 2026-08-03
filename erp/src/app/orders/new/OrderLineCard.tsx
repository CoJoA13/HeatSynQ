"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { useLatest } from "@/lib/use-latest";
import { expandSerialRange } from "@/lib/serial-range";
import type { Gate } from "@/lib/permission-ui";
import { Combobox, type ComboboxOption } from "./Combobox";
import type { LineDraft, PartOption, SerialDraft } from "./page";

// Mirrors src/server/part-process-steps.ts's RevisionSummary/RevisionDetail (narrowed to what
// this preview renders) — not imported, same reason every client file in this app keeps its own
// copy of a server type rather than importing from src/server/** (CLAUDE.md).
type RevisionSummary = { revisionNumber: number; stepCount: number };
type RevisionStepValue = { fieldDefId: string; label: string; unit: string | null; value: string };
type RevisionStep = {
  id: string; position: number; code: string; codeName: string; instruction: string;
  values: RevisionStepValue[];
};
type RevisionDetail = { revisionNumber: number; steps: RevisionStep[] };

type LeadCheck =
  | { status: "checking" }
  | { status: "ok"; revisionNumber: number; steps: RevisionStep[] }
  | { status: "no-steps" }
  | { status: "unknown"; message: string }; // fetch failed or lacking processes.view — never blocks; the save-time 400 is the real gate

// Exported so page.tsx's validation/submit-body building shares the exact same computation this
// card displays — two copies of "eachWeight × qty, rounded to the cent" would be a correctness
// risk (a rounding drift between what the user sees and what gets sent), not just duplication.
export function computeLineWeight(part: PartOption | undefined, qty: number): number | null {
  if (!part || !Number.isFinite(qty) || qty <= 0) return null;
  return Math.round(part.eachWeight * qty * 100) / 100;
}

/** Exact-match dupes within ONE line, mirroring the server's `@@unique([lineId, serial])` scope
 *  (a serial repeated across two DIFFERENT lines is not flagged — the server allows it too).
 *  Exported so page.tsx's validate() gates Save on the exact same check this card displays live —
 *  the live inline warning was previously advisory only, so a duplicate could still reach the
 *  server (which does reject it, just after a wasted round trip and a less specific message). */
export function findDuplicateSerials(serials: SerialDraft[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const s of serials) {
    if (seen.has(s.serial)) dupes.add(s.serial);
    else seen.add(s.serial);
  }
  return dupes;
}

/**
 * One part line: the picker, qty/weight (derived-until-touched), the lead's read-only revision
 * preview, and its serial entry grid. Position (lead vs. rider) is purely "am I index 0 in the
 * parent's array" — there is no separate "this is the lead" flag to keep in sync.
 */
export function OrderLineCard({
  index, isLead, line, parts, customerChosen, partsGate, processesGate, onChange, onRemove, onLeadValidity,
}: {
  index: number;
  isLead: boolean;
  line: LineDraft;
  parts: PartOption[]; // already filtered to the selected customer
  customerChosen: boolean;
  partsGate: Gate;
  processesGate: Gate;
  onChange: (patch: Partial<LineDraft>) => void;
  onRemove?: () => void;
  /** Fires only while isLead. `null` = unknown/unchecked — never blocks Save on its own. */
  onLeadValidity?: (ok: boolean | null) => void;
}) {
  const part = parts.find((p) => p.id === line.partId);
  const qtyNum = Number(line.qty);
  const computedWeight = computeLineWeight(part, qtyNum);
  const displayedWeight = line.weightOverride ?? (computedWeight !== null ? String(computedWeight) : "");

  const [rangeInput, setRangeInput] = useState("");
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [leadCheck, setLeadCheck] = useState<LeadCheck | null>(null);

  const checkLead = useCallback(async (partId: string): Promise<LeadCheck> => {
    const revs = await api<RevisionSummary[]>(`/api/parts/${partId}/process/revisions`);
    const current = revs[0]; // getRevisions orders revisionNumber desc — [0] is the current one
    if (!current || current.stepCount === 0) return { status: "no-steps" };
    const detail = await api<RevisionDetail>(`/api/parts/${partId}/process/revisions/${current.revisionNumber}`);
    return { status: "ok", revisionNumber: detail.revisionNumber, steps: detail.steps };
  }, []);

  const latest = useLatest();
  // Lazily validated ONLY for the lead line, and ONLY the one part actually picked — not every
  // option in the picker's dropdown, which would mean one fetch per part instead of one per pick
  // (task-13-brief.md's steer: the parts list payload carries no steps-status column, so
  // upfront per-option disabling would need N fetches; validating the single pick is the cheap
  // alternative). Re-runs whenever this card becomes/stops being the lead too, since removing an
  // earlier line can promote this one to index 0 without its partId changing.
  useEffect(() => {
    if (!isLead || !line.partId || !processesGate.allowed) {
      setLeadCheck(null);
      onLeadValidity?.(null);
      return;
    }
    const partId = line.partId;
    const t = latest.next();
    setLeadCheck({ status: "checking" });
    checkLead(partId).then((result) => {
      if (!latest.isCurrent(t)) return;
      setLeadCheck(result);
      onLeadValidity?.(result.status === "ok");
    }).catch((e) => {
      if (!latest.isCurrent(t)) return;
      setLeadCheck({ status: "unknown", message: (e as Error).message });
      onLeadValidity?.(null);
    });
  }, [isLead, line.partId, processesGate.allowed, latest, checkLead, onLeadValidity]);

  // Spec §11: the picker shows step-status up front rather than only after a pick — but only for
  // the LEAD slot. Riders never lock a revision (resolveLineParts exempts them from the
  // orderability check server-side too), so a steps-less part is perfectly valid there.
  const partOptions: ComboboxOption[] = parts.map((p) => ({
    value: p.id, label: `${p.partNumber} — ${p.name}`,
    disabled: isLead && !p.hasProcessSteps,
    disabledReason: isLead && !p.hasProcessSteps ? "No process steps" : undefined,
  }));
  const dupes = findDuplicateSerials(line.serials);

  function addRange() {
    if (!rangeInput.trim()) return;
    try {
      const expanded = expandSerialRange(rangeInput);
      onChange({ serials: [...line.serials, ...expanded.map((serial) => ({ id: crypto.randomUUID(), serial, description: "" }))] });
      setRangeInput("");
      setRangeError(null);
    } catch (e) {
      // expandSerialRange throws a plain Error with a message already fit to show the user
      // (src/lib/serial-range.ts) — nothing left to translate.
      setRangeError((e as Error).message);
    }
  }

  function updateSerial(i: number, patch: Partial<SerialDraft>) {
    onChange({ serials: line.serials.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) });
  }
  function removeSerial(i: number) {
    onChange({ serials: line.serials.filter((_, idx) => idx !== i) });
  }

  const partsTitle = !customerChosen ? "Pick a customer first" : !partsGate.allowed ? partsGate.title : undefined;

  return (
    <div className="mb-4 rounded border p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">
          {isLead
            ? <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-white">Lead</span>
            : `Line ${index + 1}`}
        </span>
        {onRemove && <button type="button" onClick={onRemove} className="text-xs text-red-600">Remove</button>}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <label className="col-span-2 block text-sm">
          Part
          <Combobox value={line.partId} options={partOptions} onSelect={(partId) => onChange({ partId })}
                     disabled={!customerChosen || !partsGate.allowed} title={partsTitle}
                     placeholder="Part number or name" ariaLabel={`Line ${index + 1} part`} />
        </label>
        <label className="block text-sm">
          Qty
          <input value={line.qty} inputMode="numeric" onChange={(e) => onChange({ qty: e.target.value })}
                 aria-label={`Line ${index + 1} quantity`}
                 className="mt-1 w-full rounded border px-2 py-1" />
        </label>
      </div>

      {/* The customer can change after a part was already picked (the picker's `parts` prop is
          filtered to whichever customer is CURRENTLY selected) — rather than silently clearing
          what the user typed, name what's now wrong, the same "never a dead end without an
          explanation" rule every blocked-delete guard in this app follows. */}
      {line.partId && !part && (
        <p className="mt-2 rounded bg-amber-50 p-1.5 text-xs text-amber-800">
          This part is not in the selected customer&apos;s catalog — pick a different part.
        </p>
      )}

      <div className="mt-3 flex items-end gap-3">
        <label className="block text-sm">
          Weight
          <input value={displayedWeight} inputMode="decimal"
                 onChange={(e) => onChange({ weightOverride: e.target.value })}
                 aria-label={`Line ${index + 1} weight`}
                 className="mt-1 w-full rounded border px-2 py-1" />
        </label>
        {line.weightOverride !== null && (
          <button type="button" onClick={() => onChange({ weightOverride: null })} className="text-xs text-blue-700 underline">
            Reset to computed
          </button>
        )}
      </div>

      {part?.serializationRequired && line.serials.length === 0 && (
        <p className="mt-2 rounded bg-amber-50 p-1.5 text-xs text-amber-800">
          Serialization required — no serials entered yet.
        </p>
      )}

      {isLead && (
        <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-2 text-sm">
          {leadCheck?.status === "checking" && <p className="text-slate-500">Checking process steps…</p>}
          {leadCheck?.status === "no-steps" && (
            <p className="text-red-700">No process steps — this part cannot be the lead.</p>
          )}
          {leadCheck?.status === "unknown" && (
            <p className="text-slate-500">Could not verify process steps: {leadCheck.message}</p>
          )}
          {leadCheck?.status === "ok" && (
            <div>
              <p className="font-medium">Rev {leadCheck.revisionNumber} — locks at save</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs text-slate-600">
                {leadCheck.steps.map((s) => (
                  <li key={s.id}>
                    {s.code} — {s.codeName}
                    {s.instruction && `: ${s.instruction}`}
                    {s.values.length > 0 && (
                      <span> ({s.values.map((v) => `${v.label}: ${v.value}${v.unit ? ` ${v.unit}` : ""}`).join(", ")})</span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      <div className="mt-3">
        <label className="block text-sm">
          Add serial(s)
          <input value={rangeInput} onChange={(e) => setRangeInput(e.target.value)} onBlur={addRange}
                 onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRange(); } }}
                 placeholder="EC001 or EC{001-025}" aria-label={`Line ${index + 1} add serial`}
                 className="mt-1 w-full rounded border px-2 py-1 font-mono text-sm" />
        </label>
        {rangeError && <p className="mt-1 text-xs text-red-700">{rangeError}</p>}
        {dupes.size > 0 && (
          <p className="mt-1 rounded bg-red-50 p-1.5 text-xs text-red-700">
            Duplicate serial{dupes.size > 1 ? "s" : ""}: {[...dupes].join(", ")}
          </p>
        )}
        {line.serials.length > 0 && (
          <div className="mt-2 space-y-1">
            {line.serials.map((s, i) => (
              <div key={s.id} className={`flex items-center gap-2 rounded border p-1 ${dupes.has(s.serial) ? "border-red-400 bg-red-50" : ""}`}>
                <input value={s.serial} onChange={(e) => updateSerial(i, { serial: e.target.value })}
                       aria-label={`Line ${index + 1} serial ${i + 1}`}
                       className="w-32 rounded border px-1 py-0.5 font-mono text-xs" />
                <input value={s.description} onChange={(e) => updateSerial(i, { description: e.target.value })}
                       placeholder="Description" aria-label={`Line ${index + 1} serial ${i + 1} description`}
                       className="flex-1 rounded border px-1 py-0.5 text-xs" />
                <button type="button" onClick={() => removeSerial(i)} aria-label={`Remove serial ${s.serial}`}
                        className="text-xs text-red-600">
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
