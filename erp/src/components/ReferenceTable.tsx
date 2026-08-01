"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { HistoryPanel } from "@/components/HistoryPanel";
import { PasteGrid } from "@/components/PasteGrid";
import { REFERENCE_LABELS, REFERENCE_EXTRA_FIELDS, type ReferenceKind } from "@/lib/reference-constants";
import { linksFrom, nameKey } from "@/lib/reference-links";
import { gate } from "@/lib/permission-ui";

type Row = { id: string; name: string; active: boolean } & Record<string, unknown>;
type Blocker = { entityLabel: string; name: string; id: string; href: string | null };

export function ReferenceTable({ kind }: { kind: ReferenceKind }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [blocked, setBlocked] = useState<{ row: Row; list: Blocker[] } | null>(null);
  const [perms, setPerms] = useState<string[] | undefined>(undefined);
  const labels = REFERENCE_LABELS[kind];
  const extras = REFERENCE_EXTRA_FIELDS[kind];
  const refLinks = linksFrom(kind);
  const [refOptions, setRefOptions] = useState<Record<string, { id: string; name: string }[]>>({});
  const canEdit = gate(perms, "admin.edit");

  const load = useCallback(async () => {
    setRows(await api<Row[]>(`/api/admin/reference/${kind}${showInactive ? "?includeInactive=1" : ""}`));
  }, [kind, showInactive]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  useEffect(() => {
    api<{ permissions: string[] }>("/api/auth/me").then((me) => setPerms(me.permissions))
      .catch((e) => setError((e as Error).message));
  }, []);

  // A stale blocker list from another kind's row must not linger on screen once the admin
  // switches tables.
  useEffect(() => { setBlocked(null); }, [kind]);

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
      setError(null); setBlocked(null); await load();
    } catch (e) {
      // A refusal is not a dead end here: say what is blocking, and make the list exportable.
      const list = await api<Blocker[]>(`/api/admin/reference/${kind}/${row.id}/blockers`)
        .catch(() => [] as Blocker[]);
      if (list.length) { setBlocked({ row, list }); setError(null); }
      else setError((e as Error).message);
    }
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
        <button onClick={() => setPasting((p) => !p)} disabled={canEdit.disabled} title={canEdit.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
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
                <button onClick={() => remove(r)} disabled={canEdit.disabled} title={canEdit.title}
                        className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                  delete
                </button>
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
              <button onClick={add} disabled={canEdit.disabled} title={canEdit.title}
                      className="rounded bg-slate-800 px-3 py-1 text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      {blocked && (
        <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          <div className="mb-2 font-medium">
            Cannot delete {labels.singular.toLowerCase()} “{blocked.row.name}” — {blocked.list.length} record(s) use it:
          </div>
          <ul className="mb-2 space-y-1">
            {blocked.list.map((b) => (
              <li key={`${b.entityLabel}-${b.id}`}>
                <span className="text-slate-500">{b.entityLabel}</span>{" "}
                {b.href ? <a href={b.href} className="text-blue-700 underline">{b.name}</a> : <span>{b.name}</span>}
              </li>
            ))}
          </ul>
          <div className="flex gap-3">
            <a href={`/api/admin/reference/${kind}/${blocked.row.id}/blockers/export`}
               className="text-blue-700 underline">Export list to Excel</a>
            <button onClick={() => setBlocked(null)} className="text-slate-600">dismiss</button>
          </div>
        </div>
      )}
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
