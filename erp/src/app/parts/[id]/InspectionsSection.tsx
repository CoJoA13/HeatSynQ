"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { useSaveScope } from "@/lib/save-scope";
import { invalidateHistory } from "@/components/HistoryPanel";

type InspRow = {
  id: string; inspectionCodeId: string; inspectionCodeName: string;
  scaleId: string | null; scaleName: string | null;
  min: number | string | null; max: number | string | null; sampleQty: string; location: string; sort: number;
};
/** The free-text/decimal cells this grid edits in place (the two <select>s save directly).
 *  `sampleQty` is deliberately a string, not a number — owner ruling 2026-08-03, spec §3.9. */
type TextField = "min" | "max" | "sampleQty" | "location";
type CodeOption = { id: string; name: string; active: boolean };
type ScaleOption = { id: string; name: string; active: boolean };

const emptyDraft = { inspectionCodeId: "", scaleId: "", min: "", max: "", sampleQty: "", location: "" };

export function InspectionsSection({
  partId, perms, onError, onOptionsError,
}: {
  partId: string;
  perms: string[] | undefined;
  onError: (message: string | null) => void;
  onOptionsError: (message: string) => void;
}) {
  const [rows, setRows] = useState<InspRow[]>([]);
  // Set only once `load()` has actually landed a real list (the PricingSection `rowsReady`
  // port): `rows` starts `[]` the same as "loaded, genuinely empty", so `add()` used to be
  // unable to tell those apart and would happily mint sort 0 while the initial GET was still in
  // flight OR had already failed — a failed load is the steady state on an error, not a
  // transient race, so without this a duplicate sort-0 could sit there indefinitely.
  const [rowsReady, setRowsReady] = useState(false);
  const [codes, setCodes] = useState<CodeOption[]>([]);
  const [scales, setScales] = useState<ScaleOption[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const canEdit = gate(perms, "parts.edit");

  // Guards the list reload two ways (save-scope.ts — the PricingSection shape; this section
  // previously had no reload ticket at all): overlapping reloads stay ordered, and a reload's
  // GET waits out the saves registered below, re-fetching if one is dispatched mid-fetch, so a
  // §5.13 rollback reload can never revert a NEWER row's optimistic patch (#15's section-local
  // analog). `load` never touches the error state, so it doubles as the no-clear rollback
  // variant.
  const saveScope = useSaveScope();
  const load = useCallback(
    () => saveScope.reload(
      () => api<InspRow[]>(`/api/parts/${partId}/inspections`),
      (data) => { setRows(data); setRowsReady(true); },
    ),
    [partId, saveScope],
  );
  useEffect(() => { load().catch((e) => onError((e as Error).message)); }, [load, onError]);

  // F9: a failed code/scale-options fetch used to report through the shared `onError`, which a
  // later successful save elsewhere on the page resets to null — see IdentitySection's comment on
  // the same fix. `onOptionsError` writes into the page's persistent `loadError` instead, and
  // `codesReady`/`scalesReady` disable the affected selects (both the per-row ones and the
  // add-row draft ones) until their fetch actually succeeds.
  //
  // includeInactive=1 on both: an inspection row can carry a code or scale that's since been
  // marked inactive (the R3 pattern from customers/[id]/page.tsx's Terms/Parent selects).
  // Without it a controlled <select> bound to that id would match no <option> and silently fall
  // back to blank, misrepresenting stored data and risking clobbering the real value on the next
  // interaction.
  //
  // Note the deliberate gap this section does NOT try to close: the inspection code's default
  // scale (inspectionCode.defaultScaleId) lives on the reference row, but the pick-list
  // projection this route exposes is `{ id, name, active }` only — no default-scale prefill is
  // available to a non-admin screen. The scale select is left blank for the user to choose
  // rather than widening /api/picklists to leak that field; recorded as a papercut in the PR body.
  const [codesReady, setCodesReady] = useState(false);
  const [scalesReady, setScalesReady] = useState(false);
  useEffect(() => {
    api<CodeOption[]>("/api/picklists/inspectionCode?includeInactive=1").then((data) => {
      setCodes(data);
      setCodesReady(true);
    }).catch((e) => onOptionsError((e as Error).message));
  }, [onOptionsError]);
  useEffect(() => {
    api<ScaleOption[]>("/api/picklists/inspectionScale?includeInactive=1").then((data) => {
      setScales(data);
      setScalesReady(true);
    }).catch((e) => onOptionsError((e as Error).message));
  }, [onOptionsError]);

  function setRowField(id: string, field: TextField, value: string) {
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }
  // Optimistic (mirrors customers/[id]/page.tsx's saveAddressField): the row already shows the
  // new value (either from setRowField above on a text field, or from the <select>'s own native
  // behavior), so a failure has something to roll back. The PATCH registers with saveScope at
  // call time — no serial() queue here, so the round-trip itself is the registered save — and
  // the §5.13 rollback is fired detached (never awaited: the reload waits for every registered
  // save, this one included, to settle before its GET dispatches).
  async function saveRow(id: string, patch: Record<string, unknown>): Promise<boolean> {
    setRows((cur) => cur.map((r) => (r.id === id ? ({ ...r, ...patch } as InspRow) : r)));
    const put = api(`/api/parts/${partId}/inspections/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    saveScope.begin(put);
    try {
      await put;
      onError(null);
      invalidateHistory(); // #14 item 1 — success path, the instant the save resolves
      return true;
    } catch (e) {
      onError((e as Error).message);
      void load().catch(() => {});
      return false;
    }
  }
  const focusedValue = useRef("");
  const noteFocus = (e: React.FocusEvent<HTMLInputElement>) => { focusedValue.current = e.target.value; };
  function blurSave(e: React.FocusEvent<HTMLInputElement>, id: string, field: TextField) {
    const value = e.target.value;
    if (value === focusedValue.current) return;
    // min/max are nullable decimals — blanking one means "no bound", which the service reads as
    // null. sampleQty and location are plain strings whose empty value IS "" (their column
    // default); sending null there would fail the zod string parse rather than clear the field.
    const numeric = field === "min" || field === "max";
    void saveRow(id, { [field]: numeric ? (value === "" ? null : value) : value });
  }

  async function removeRow(id: string) {
    try {
      await api(`/api/parts/${partId}/inspections/${id}`, { method: "DELETE" });
      onError(null);
      invalidateHistory(); // #14 item 1
      await load();
    } catch (e) { onError((e as Error).message); }
  }
  // G1: computes the full new order client-side (swap idx/j in the displayed list) and sends it
  // as ONE call to the atomic reorder route, which writes every changed `sort` inside a single
  // Serializable transaction. Replaces the old two-PATCH swap of `sort` values: if the second of
  // those PATCHes failed, both rows kept the SAME sort, and since listPartInspections orders
  // purely by sort, a tie rendered nondeterministically with no way to "swap back" out of it.
  async function move(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= rows.length) return;
    const reordered = [...rows];
    [reordered[idx], reordered[j]] = [reordered[j], reordered[idx]];
    const put = api(`/api/parts/${partId}/inspections/order`, {
      method: "PUT",
      body: JSON.stringify({ orderedIds: reordered.map((r) => r.id) }),
    });
    saveScope.begin(put);
    try {
      await put;
      onError(null);
      invalidateHistory(); // #14 item 1
      await load();
    } catch (e) {
      // §5.13 rollback, detached — the saveRow() shape above. (The success path may await
      // load(): by then the registered PUT has settled, so the reload cannot deadlock on it.)
      onError((e as Error).message);
      void load().catch(() => {});
    }
  }
  async function add() {
    if (!draft.inspectionCodeId) return;
    // The PricingSection addRow guard: `rows` reads `[]` both when the part genuinely has no
    // inspections yet AND when the initial GET is still in flight or has failed outright — on a
    // failed load that empty array is the steady state, not a momentary race. Without this,
    // `nextSort` below computed `0` either way, so a failed fetch silently produced a duplicate
    // sort-0 the instant the user added a row. Refuse rather than guess.
    if (!rowsReady) {
      onError("Inspection rows have not finished loading yet — reload the page and try again.");
      return;
    }
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
          // Fix-wave R2 finding 1: this was missing entirely, so every add silently dropped
          // whatever the operator typed into Sample qty (the server's own default, "", is
          // indistinguishable from "the field was never sent").
          sampleQty: draft.sampleQty,
          location: draft.location,
          sort: nextSort,
        }),
      });
      setDraft(emptyDraft);
      onError(null);
      invalidateHistory(); // #14 item 1
      await load();
    } catch (e) { onError((e as Error).message); }
  }

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <h2 className="mb-2 font-medium">Inspections</h2>
      <table className="mb-2 w-full text-sm">
        <thead>
          <tr className="text-left">
            <th className="py-1">Code</th><th>Scale</th><th>Min</th><th>Max</th><th>Sample qty</th>
            <th>Location</th><th /><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={r.id} className="border-t">
              <td className="py-1">
                <select value={r.inspectionCodeId} disabled={!canEdit.allowed || !codesReady}
                        title={!codesReady ? "Options failed to load — reload the page" : canEdit.title}
                        onChange={(e) => void saveRow(r.id, { inspectionCodeId: e.target.value })}
                        className="rounded border px-1 py-0.5">
                  {codes.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{!c.active && " (inactive)"}</option>
                  ))}
                </select>
              </td>
              <td>
                <select value={r.scaleId ?? ""} disabled={!canEdit.allowed || !scalesReady}
                        title={!scalesReady ? "Options failed to load — reload the page" : canEdit.title}
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
                <input value={r.sampleQty} onFocus={noteFocus} readOnly={!canEdit.allowed} title={canEdit.title}
                       aria-label="Sample quantity"
                       onChange={(e) => setRowField(r.id, "sampleQty", e.target.value)}
                       onBlur={(e) => blurSave(e, r.id, "sampleQty")}
                       className="w-24 rounded border px-1 py-0.5 read-only:bg-slate-50" />
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
        <select value={draft.inspectionCodeId} disabled={!canEdit.allowed || !codesReady}
                title={!codesReady ? "Options failed to load — reload the page" : canEdit.title}
                onChange={(e) => setDraft({ ...draft, inspectionCodeId: e.target.value })}
                className="rounded border px-2 py-1 text-sm">
          <option value="">Code…</option>
          {codes.map((c) => <option key={c.id} value={c.id}>{c.name}{!c.active && " (inactive)"}</option>)}
        </select>
        <select value={draft.scaleId} disabled={!canEdit.allowed || !scalesReady}
                title={!scalesReady ? "Options failed to load — reload the page" : canEdit.title}
                onChange={(e) => setDraft({ ...draft, scaleId: e.target.value })}
                className="rounded border px-2 py-1 text-sm">
          <option value="">Scale…</option>
          {scales.map((s) => <option key={s.id} value={s.id}>{s.name}{!s.active && " (inactive)"}</option>)}
        </select>
        <input value={draft.min} placeholder="Min" inputMode="decimal" disabled={!canEdit.allowed}
               title={canEdit.title}
               onChange={(e) => setDraft({ ...draft, min: e.target.value })}
               className="w-16 rounded border px-2 py-1 text-sm" />
        <input value={draft.max} placeholder="Max" inputMode="decimal" disabled={!canEdit.allowed}
               title={canEdit.title}
               onChange={(e) => setDraft({ ...draft, max: e.target.value })}
               className="w-16 rounded border px-2 py-1 text-sm" />
        <input value={draft.sampleQty} placeholder="Sample qty" disabled={!canEdit.allowed}
               title={canEdit.title}
               onChange={(e) => setDraft({ ...draft, sampleQty: e.target.value })}
               className="w-24 rounded border px-2 py-1 text-sm" />
        <input value={draft.location} placeholder="Location" disabled={!canEdit.allowed}
               title={canEdit.title}
               onChange={(e) => setDraft({ ...draft, location: e.target.value })}
               className="w-28 rounded border px-2 py-1 text-sm" />
        <button onClick={add} disabled={canEdit.disabled || !draft.inspectionCodeId || !rowsReady}
                title={!rowsReady ? "Inspection rows have not finished loading yet — reload the page and try again."
                  : canEdit.title}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          Add
        </button>
      </div>
    </section>
  );
}
