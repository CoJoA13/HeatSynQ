"use client";
// One seeded requirement (spec §6.3): the frozen fields READ-ONLY on top — code, scale, min,
// max, sample qty, location are COPIED from the part's inspections at cert creation and frozen
// by design (§4.1); editing the part next month must not rewrite a cert already being filled in
// — and the editable readings grid underneath: value, computed pass/fail (the exact same
// `computePassed` the server runs, so the screen never disagrees with what gets stored), an
// explicit override toggle, and a note.
//
// Draft state lives HERE, per block, and is re-seeded from server truth by the parent bumping
// this block's `key` — after a successful save (fresh computed `passed` comes back) and after a
// failed one (rollback-then-report). Only THIS block's draft is ever discarded; sibling blocks
// keep their unsaved rows, mirroring PUT …/results' merge semantics client-side.
import { useState } from "react";
import type { Gate } from "@/lib/permission-ui";
import { computePassed } from "@/lib/pass-fail";
import type { CertRequirementRow } from "./CertDetail";

/** One reading as PUT /api/certs/[id]/results accepts it. `value` crosses as the typed decimal
 *  string (`decimalField(10, 4)` accepts a decimal string); `passed` is only meaningful when
 *  `overridden` — otherwise the server recomputes it against the frozen min/max. */
export type ReadingPayload = {
  value: string | null; passed: boolean | null; overridden: boolean; note: string;
};

/** Mirrors the server's `decimalField(10, 4)` regex — pre-checked client-side so a typo'd value
 *  is refused BEFORE the request goes out. A server-side 400 would be a failed save, and a
 *  failed save's mandated recovery (rollback-then-report) discards the whole draft — too harsh
 *  a price for a typo the client can name in place. */
const DECIMAL_10_4 = /^-?\d{1,6}(\.\d{1,4})?$/;

type DraftRow = {
  key: number; value: string; overridden: boolean;
  // The override's own verdict, three-state: "" = pending (stored as null), the same
  // passed === true / false / null model the server keeps. Only read when `overridden`.
  passedChoice: "" | "pass" | "fail";
  note: string;
};

function fromServer(req: CertRequirementRow): DraftRow[] {
  return req.readings.map((r, i) => ({
    key: i,
    value: r.value === null ? "" : String(r.value),
    overridden: r.overridden,
    passedChoice: r.passed === true ? "pass" : r.passed === false ? "fail" : "",
    note: r.note,
  }));
}

/** The row's on-screen verdict — three states, never two (the Task 15 review finding): an empty
 *  value is PENDING (`null`), not a pass and not a fail. An overridden row's verdict is whatever
 *  the override says; otherwise it is `computePassed` against the frozen min/max, exactly what
 *  the server will store on save. */
function rowVerdict(row: DraftRow, min: number | null, max: number | null): boolean | null {
  if (row.overridden) {
    return row.passedChoice === "pass" ? true : row.passedChoice === "fail" ? false : null;
  }
  const raw = row.value.trim();
  if (raw === "" || !DECIMAL_10_4.test(raw)) return null; // nothing judgeable yet
  return computePassed(Number(raw), min, max);
}

function VerdictBadge({ verdict }: { verdict: boolean | null }) {
  if (verdict === true) {
    return <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-800">Pass</span>;
  }
  if (verdict === false) {
    return <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800">Fail</span>;
  }
  return <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">Pending</span>;
}

function Frozen({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-slate-500">{label}</span> <b>{value}</b>
    </span>
  );
}

export function RequirementBlock({ requirement, editGate, onSave }: {
  requirement: CertRequirementRow;
  editGate: Gate;
  onSave: (requirementId: string, readings: ReadingPayload[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<DraftRow[]>(() => fromServer(requirement));
  const [nextKey, setNextKey] = useState(() => requirement.readings.length);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // Local pre-validation refusal (a bad decimal named in place) — NOT a failed save: the draft
  // stays, unlike the parent's rollback-then-report for a request the server actually rejected.
  const [localError, setLocalError] = useState<string | null>(null);

  function edit(key: number, patch: Partial<DraftRow>) {
    setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
  }
  function addRow() {
    setRows((cur) => [...cur, { key: nextKey, value: "", overridden: false, passedChoice: "", note: "" }]);
    setNextKey((k) => k + 1);
    setDirty(true);
  }
  function removeRow(key: number) {
    setRows((cur) => cur.filter((r) => r.key !== key));
    setDirty(true);
  }

  async function save() {
    for (const [i, row] of rows.entries()) {
      const raw = row.value.trim();
      if (raw !== "" && !DECIMAL_10_4.test(raw)) {
        setLocalError(`Reading ${i + 1}: "${row.value}" is not a decimal (up to 6 digits, up to 4 decimal places).`);
        return;
      }
      if (row.note.length > 500) {
        setLocalError(`Reading ${i + 1}: the note is over 500 characters.`);
        return;
      }
    }
    setLocalError(null);
    setSaving(true);
    try {
      await onSave(requirement.id, rows.map((row) => ({
        value: row.value.trim() === "" ? null : row.value.trim(),
        passed: row.overridden ? rowVerdict(row, requirement.min, requirement.max) : null,
        overridden: row.overridden,
        note: row.note,
      })));
      // On success the parent bumps this block's key — this instance is about to unmount, and
      // its successor re-seeds from the fresh server truth. On failure the same happens against
      // the reloaded (rolled-back) truth, then the parent's banner reports why.
    } finally {
      setSaving(false);
    }
  }

  const fmt = (n: number | null) => (n === null ? "—" : String(n));

  return (
    <div className="mb-3 rounded border border-slate-200 p-3 last:mb-0">
      {/* Frozen fields — read-only by design (§4.1), rendered as text, not inputs. */}
      <div className="mb-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
        <span className="font-medium">
          {requirement.position}. {requirement.inspectionCodeName}
        </span>
        <Frozen label="Scale" value={requirement.scaleName ?? "—"} />
        <Frozen label="Min" value={fmt(requirement.min)} />
        <Frozen label="Max" value={fmt(requirement.max)} />
        <Frozen label="Sample qty" value={requirement.sampleQty || "—"} />
        <Frozen label="Location" value={requirement.location || "—"} />
        <span className="text-xs text-slate-400">
          Frozen when this certification was created — part changes never rewrite it.
        </span>
      </div>

      {localError && <p className="mb-2 rounded bg-red-50 p-2 text-sm text-red-700">{localError}</p>}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="w-8 py-1 font-medium">#</th>
            <th className="w-36 font-medium">Value</th>
            <th className="w-40 font-medium">Pass/fail <span className="font-normal text-slate-400">(screen only)</span></th>
            <th className="w-24 font-medium">Override</th>
            <th className="font-medium">Note</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.key} className="border-t">
              <td className="py-1 text-slate-500">{i + 1}</td>
              <td className="pr-2">
                <input value={row.value} inputMode="decimal"
                       readOnly={!editGate.allowed} title={editGate.title}
                       onChange={(e) => edit(row.key, { value: e.target.value })}
                       className="w-full rounded border px-2 py-1 read-only:bg-slate-50" />
              </td>
              <td className="pr-2">
                {row.overridden ? (
                  <select value={row.passedChoice} disabled={!editGate.allowed} title={editGate.title}
                          onChange={(e) => edit(row.key, { passedChoice: e.target.value as DraftRow["passedChoice"] })}
                          className="rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
                    <option value="">Pending</option>
                    <option value="pass">Pass</option>
                    <option value="fail">Fail</option>
                  </select>
                ) : (
                  <VerdictBadge verdict={rowVerdict(row, requirement.min, requirement.max)} />
                )}
              </td>
              <td className="pr-2">
                <label className="flex items-center gap-1 text-xs text-slate-600" title={editGate.title}>
                  <input type="checkbox" checked={row.overridden} disabled={!editGate.allowed}
                         onChange={(e) => edit(row.key, { overridden: e.target.checked })} />
                  override
                </label>
              </td>
              <td className="pr-2">
                <input value={row.note} readOnly={!editGate.allowed} title={editGate.title}
                       onChange={(e) => edit(row.key, { note: e.target.value })}
                       className="w-full rounded border px-2 py-1 read-only:bg-slate-50" />
              </td>
              <td>
                <button type="button" onClick={() => removeRow(row.key)}
                        disabled={!editGate.allowed} title={editGate.allowed ? "Remove this reading" : editGate.title}
                        className="rounded px-1 text-slate-400 hover:text-red-600 disabled:cursor-not-allowed disabled:hover:text-slate-400">
                  ×
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr className="border-t">
              <td colSpan={6} className="py-1 text-slate-500">No readings yet.</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={addRow} disabled={!editGate.allowed} title={editGate.title}
                className="rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:text-slate-400">
          Add reading
        </button>
        <button type="button" onClick={() => void save()}
                disabled={!editGate.allowed || !dirty || saving}
                title={editGate.allowed ? (dirty ? undefined : "No unsaved changes") : editGate.title}
                className="rounded bg-slate-800 px-3 py-1 text-xs text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          {saving ? "Saving…" : "Save readings"}
        </button>
      </div>
    </div>
  );
}
