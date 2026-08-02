"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";

type InspRow = {
  id: string; inspectionCodeId: string; inspectionCodeName: string;
  scaleId: string | null; scaleName: string | null;
  min: number | string | null; max: number | string | null; location: string; sort: number;
};
type CodeOption = { id: string; name: string; active: boolean };
type ScaleOption = { id: string; name: string; active: boolean };

const emptyDraft = { inspectionCodeId: "", scaleId: "", min: "", max: "", location: "" };

export function InspectionsSection({
  partId, perms, onError,
}: {
  partId: string;
  perms: string[] | undefined;
  onError: (message: string | null) => void;
}) {
  const [rows, setRows] = useState<InspRow[]>([]);
  const [codes, setCodes] = useState<CodeOption[]>([]);
  const [scales, setScales] = useState<ScaleOption[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const canEdit = gate(perms, "parts.edit");

  const load = useCallback(async () => {
    const data = await api<InspRow[]>(`/api/parts/${partId}/inspections`);
    setRows(data);
  }, [partId]);
  useEffect(() => { load().catch((e) => onError((e as Error).message)); }, [load, onError]);

  // includeInactive=1 on both: an inspection row can carry a code or scale that's since been
  // marked inactive (the R3 pattern from customers/[id]/page.tsx's Terms/Parent selects).
  // Without it a controlled <select> bound to that id would match no <option> and silently fall
  // back to blank, misrepresenting stored data and risking clobbering the real value on the next
  // interaction. No `.catch(() => {})` — failures land in the page's one error banner.
  //
  // Note the deliberate gap this section does NOT try to close: the inspection code's default
  // scale (inspectionCode.defaultScaleId) lives on the reference row, but the pick-list
  // projection this route exposes is `{ id, name, active }` only — no default-scale prefill is
  // available to a non-admin screen. The scale select is left blank for the user to choose
  // rather than widening /api/picklists to leak that field; recorded as a papercut in the PR body.
  useEffect(() => {
    api<CodeOption[]>("/api/picklists/inspectionCode?includeInactive=1").then(setCodes)
      .catch((e) => onError((e as Error).message));
  }, [onError]);
  useEffect(() => {
    api<ScaleOption[]>("/api/picklists/inspectionScale?includeInactive=1").then(setScales)
      .catch((e) => onError((e as Error).message));
  }, [onError]);

  function setRowField(id: string, field: "min" | "max" | "location", value: string) {
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }
  // Optimistic (mirrors customers/[id]/page.tsx's saveAddressField): the row already shows the
  // new value (either from setRowField above on a text field, or from the <select>'s own native
  // behavior), so a failure has something to roll back — reload from the server FIRST, then
  // report the error (§5.13), never the other way around.
  async function saveRow(id: string, patch: Record<string, unknown>): Promise<boolean> {
    setRows((cur) => cur.map((r) => (r.id === id ? ({ ...r, ...patch } as InspRow) : r)));
    try {
      await api(`/api/parts/${partId}/inspections/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      onError(null);
      return true;
    } catch (e) {
      await load().catch(() => {});
      onError((e as Error).message);
      return false;
    }
  }
  const focusedValue = useRef("");
  const noteFocus = (e: React.FocusEvent<HTMLInputElement>) => { focusedValue.current = e.target.value; };
  function blurSave(e: React.FocusEvent<HTMLInputElement>, id: string, field: "min" | "max" | "location") {
    const value = e.target.value;
    if (value === focusedValue.current) return;
    void saveRow(id, { [field]: field === "location" ? value : (value === "" ? null : value) });
  }

  async function removeRow(id: string) {
    try {
      await api(`/api/parts/${partId}/inspections/${id}`, { method: "DELETE" });
      onError(null);
      await load();
    } catch (e) { onError((e as Error).message); }
  }
  // Renumber by swapping the two affected rows' `sort` values, then reload — listPartInspections
  // orders by sort ascending, so swapping is enough to move a row up or down one place.
  async function move(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= rows.length) return;
    const a = rows[idx], b = rows[j];
    try {
      await api(`/api/parts/${partId}/inspections/${a.id}`, { method: "PATCH", body: JSON.stringify({ sort: b.sort }) });
      await api(`/api/parts/${partId}/inspections/${b.id}`, { method: "PATCH", body: JSON.stringify({ sort: a.sort }) });
      onError(null);
      await load();
    } catch (e) {
      // Roll back to server truth FIRST, then report why (§5.13) — the two PATCHes above are not
      // atomic, so a failure on the second leaves the server holding only half the swap. Reload
      // before setting the error, the saveRow() precedent above, so local rows never diverge from
      // what the server actually has.
      await load().catch(() => {});
      onError((e as Error).message);
    }
  }
  async function add() {
    if (!draft.inspectionCodeId) return;
    try {
      // F6: rows.length duplicates a sort value after a mid-list delete — deleting row 0 of 3
      // leaves rows at sort {1, 2}, and rows.length (now 2) collides with the row still at sort
      // 2 instead of landing after it. The highest sort actually present, plus one, always lands
      // strictly after every row on screen regardless of gaps left by earlier deletes.
      const nextSort = rows.length ? Math.max(...rows.map((r) => r.sort)) + 1 : 0;
      await api(`/api/parts/${partId}/inspections`, {
        method: "POST",
        body: JSON.stringify({
          inspectionCodeId: draft.inspectionCodeId,
          scaleId: draft.scaleId || null,
          min: draft.min === "" ? undefined : draft.min,
          max: draft.max === "" ? undefined : draft.max,
          location: draft.location,
          sort: nextSort,
        }),
      });
      setDraft(emptyDraft);
      onError(null);
      await load();
    } catch (e) { onError((e as Error).message); }
  }

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Inspections</h2>
      <table className="mb-2 w-full text-sm">
        <thead>
          <tr className="text-left">
            <th className="py-1">Code</th><th>Scale</th><th>Min</th><th>Max</th><th>Location</th><th /><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={r.id} className="border-t">
              <td className="py-1">
                <select value={r.inspectionCodeId} disabled={!canEdit.allowed} title={canEdit.title}
                        onChange={(e) => void saveRow(r.id, { inspectionCodeId: e.target.value })}
                        className="rounded border px-1 py-0.5">
                  {codes.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{!c.active && " (inactive)"}</option>
                  ))}
                </select>
              </td>
              <td>
                <select value={r.scaleId ?? ""} disabled={!canEdit.allowed} title={canEdit.title}
                        onChange={(e) => void saveRow(r.id, { scaleId: e.target.value || null })}
                        className="rounded border px-1 py-0.5">
                  <option value="">—</option>
                  {scales.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}{!s.active && " (inactive)"}</option>
                  ))}
                </select>
              </td>
              <td>
                <input value={r.min ?? ""} inputMode="decimal" onFocus={noteFocus} readOnly={!canEdit.allowed}
                       title={canEdit.title}
                       onChange={(e) => setRowField(r.id, "min", e.target.value)}
                       onBlur={(e) => blurSave(e, r.id, "min")}
                       className="w-16 rounded border px-1 py-0.5 read-only:bg-slate-50" />
              </td>
              <td>
                <input value={r.max ?? ""} inputMode="decimal" onFocus={noteFocus} readOnly={!canEdit.allowed}
                       title={canEdit.title}
                       onChange={(e) => setRowField(r.id, "max", e.target.value)}
                       onBlur={(e) => blurSave(e, r.id, "max")}
                       className="w-16 rounded border px-1 py-0.5 read-only:bg-slate-50" />
              </td>
              <td>
                <input value={r.location} onFocus={noteFocus} readOnly={!canEdit.allowed} title={canEdit.title}
                       onChange={(e) => setRowField(r.id, "location", e.target.value)}
                       onBlur={(e) => blurSave(e, r.id, "location")}
                       className="w-28 rounded border px-1 py-0.5 read-only:bg-slate-50" />
              </td>
              <td className="text-right">
                <button onClick={() => move(idx, -1)} disabled={canEdit.disabled || idx === 0} title={canEdit.title}
                        aria-label="Move up"
                        className="mr-1 text-xs disabled:cursor-not-allowed disabled:text-slate-300">
                  ↑
                </button>
                <button onClick={() => move(idx, 1)} disabled={canEdit.disabled || idx === rows.length - 1}
                        title={canEdit.title} aria-label="Move down"
                        className="text-xs disabled:cursor-not-allowed disabled:text-slate-300">
                  ↓
                </button>
              </td>
              <td className="text-right">
                <button onClick={() => removeRow(r.id)} disabled={canEdit.disabled} title={canEdit.title}
                        className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                  delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-end gap-2">
        <select value={draft.inspectionCodeId} disabled={!canEdit.allowed} title={canEdit.title}
                onChange={(e) => setDraft({ ...draft, inspectionCodeId: e.target.value })}
                className="rounded border px-2 py-1 text-sm">
          <option value="">Code…</option>
          {codes.map((c) => <option key={c.id} value={c.id}>{c.name}{!c.active && " (inactive)"}</option>)}
        </select>
        <select value={draft.scaleId} disabled={!canEdit.allowed} title={canEdit.title}
                onChange={(e) => setDraft({ ...draft, scaleId: e.target.value })}
                className="rounded border px-2 py-1 text-sm">
          <option value="">Scale…</option>
          {scales.map((s) => <option key={s.id} value={s.id}>{s.name}{!s.active && " (inactive)"}</option>)}
        </select>
        <input value={draft.min} placeholder="Min" inputMode="decimal" disabled={!canEdit.allowed}
               onChange={(e) => setDraft({ ...draft, min: e.target.value })}
               className="w-16 rounded border px-2 py-1 text-sm" />
        <input value={draft.max} placeholder="Max" inputMode="decimal" disabled={!canEdit.allowed}
               onChange={(e) => setDraft({ ...draft, max: e.target.value })}
               className="w-16 rounded border px-2 py-1 text-sm" />
        <input value={draft.location} placeholder="Location" disabled={!canEdit.allowed}
               onChange={(e) => setDraft({ ...draft, location: e.target.value })}
               className="w-28 rounded border px-2 py-1 text-sm" />
        <button onClick={add} disabled={canEdit.disabled || !draft.inspectionCodeId} title={canEdit.title}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          Add
        </button>
      </div>
    </section>
  );
}
