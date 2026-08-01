"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { HistoryPanel } from "@/components/HistoryPanel";
import { PasteGrid } from "@/components/PasteGrid";
import { REFERENCE_LABELS, REFERENCE_EXTRA_FIELDS, type ReferenceKind } from "@/lib/reference-constants";
import { linksFrom, nameKey } from "@/lib/reference-links";

type Row = { id: string; name: string; active: boolean } & Record<string, unknown>;

export function ReferenceTable({ kind }: { kind: ReferenceKind }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const labels = REFERENCE_LABELS[kind];
  const extras = REFERENCE_EXTRA_FIELDS[kind];
  const refLinks = linksFrom(kind);
  const [refOptions, setRefOptions] = useState<Record<string, { id: string; name: string }[]>>({});

  const load = useCallback(async () => {
    setRows(await api<Row[]>(`/api/admin/reference/${kind}${showInactive ? "?includeInactive=1" : ""}`));
  }, [kind, showInactive]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  useEffect(() => {
    if (!refLinks.length) return;
    Promise.all(refLinks.map(async (l) => {
      // /api/picklists/<kind> deliberately 404s for glAccount — it stays off the route every
      // signed-in user can reach, but paymentType.glAccountId IS a valid FK target here. This
      // grid is itself an admin.view-gated screen (its own row listing above already calls
      // /api/admin/reference/${kind}), so every ref-link's options are fetched from that same
      // admin endpoint rather than the narrower picklist route — one endpoint choice, no
      // per-link special-casing, and it sidesteps the 404 without widening PICKLIST_KINDS.
      // includeInactive so an already-assigned inactive target still renders by name.
      const opts = await api<{ id: string; name: string }[]>(
        `/api/admin/reference/${l.targetKind}?includeInactive=1`);
      return [l.column, opts] as const;
    }))
      .then((pairs) => setRefOptions(Object.fromEntries(pairs)))
      // No .catch(() => {}) here: a failed fetch that renders an empty dropdown is
      // indistinguishable from a shop that has configured nothing. Say so instead.
      .catch((e) => setError(`Could not load pick lists: ${(e as Error).message}`));
    // refLinks is recomputed every render (a fresh array from linksFrom), so it deliberately
    // isn't a dependency here — that would re-run this effect on every render instead of once
    // per kind change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  async function add() {
    try {
      await api(`/api/admin/reference/${kind}`, { method: "POST", body: JSON.stringify(draft) });
      setDraft({}); setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function toggleActive(row: Row) {
    try {
      await api(`/api/admin/reference/${kind}/${row.id}`, {
        method: "PUT", body: JSON.stringify({ active: !row.active }),
      });
      setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function remove(row: Row) {
    if (!confirm(`Delete ${labels.singular.toLowerCase()} "${row.name}"?`)) return;
    try {
      await api(`/api/admin/reference/${kind}/${row.id}`, { method: "DELETE" });
      setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div>
      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <div className="mb-2 flex items-center gap-3">
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        <a href={`/api/admin/reference/${kind}/export${showInactive ? "?includeInactive=1" : ""}`}
           className="text-sm text-blue-700 underline">
          Export to Excel
        </a>
        <button onClick={() => setPasting((p) => !p)} className="text-sm text-blue-700 underline">
          {pasting ? "Hide paste entry" : "Paste from spreadsheet"}
        </button>
      </div>
      <table className="w-full rounded border bg-white text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="p-2">{labels.nameLabel}</th>
            {extras.map((f) => <th key={f.key} className="p-2">{f.label}</th>)}
            <th className="p-2">Active</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t">
              <td className="p-2">{r.name}</td>
              {extras.map((f) => (
                <td key={f.key} className="p-2">
                  {String(r[f.kind === "ref" ? nameKey(f.key) : f.key] ?? "")}
                </td>
              ))}
              <td className="p-2">
                <input type="checkbox" checked={r.active} onChange={() => toggleActive(r)} />
              </td>
              <td className="p-2 text-right">
                <button onClick={() => setOpenHistory(openHistory === r.id ? null : r.id)}
                        className="mr-3 text-xs text-slate-600">history</button>
                <button onClick={() => remove(r)} className="text-xs text-red-600">delete</button>
                {openHistory === r.id && <HistoryPanel entity={kind} entityId={r.id} />}
              </td>
            </tr>
          ))}
          <tr className="border-t bg-slate-50">
            <td className="p-2">
              <input value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                     placeholder={labels.nameLabel} className="w-full rounded border px-2 py-1" />
            </td>
            {extras.map((f) => (
              <td key={f.key} className="p-2">
                {f.kind === "ref" ? (
                  <select value={draft[nameKey(f.key)] ?? ""}
                          onChange={(e) => setDraft({ ...draft, [nameKey(f.key)]: e.target.value })}
                          className="w-full rounded border px-2 py-1">
                    <option value="">—</option>
                    {(refOptions[f.key] ?? []).map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
                  </select>
                ) : (
                  <input value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                         placeholder={f.label} className="w-full rounded border px-2 py-1" />
                )}
              </td>
            ))}
            <td />
            <td className="p-2 text-right">
              <button onClick={add} className="rounded bg-slate-800 px-3 py-1 text-white">Add</button>
            </td>
          </tr>
        </tbody>
      </table>
      {pasting && (
        <PasteGrid
          endpoint={`/api/admin/reference/${kind}/paste`}
          columns={[REFERENCE_LABELS[kind].nameLabel, ...REFERENCE_EXTRA_FIELDS[kind].map((f) => f.label)]}
          onDone={load}
        />
      )}
    </div>
  );
}
