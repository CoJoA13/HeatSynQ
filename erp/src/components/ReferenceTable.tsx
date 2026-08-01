"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { HistoryPanel } from "@/components/HistoryPanel";
import { PasteGrid } from "@/components/PasteGrid";
import { REFERENCE_LABELS, REFERENCE_EXTRA_FIELDS, type ReferenceKind } from "@/lib/reference-constants";
import { linksFrom, nameKey } from "@/lib/reference-links";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { BlockerPanel, type Blocker } from "@/components/BlockerPanel";

type Row = { id: string; name: string; active: boolean } & Record<string, unknown>;

export function ReferenceTable({ kind }: { kind: ReferenceKind }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [blocked, setBlocked] = useState<{ row: Row; list: Blocker[] } | null>(null);
  const { permissions: perms, error: permsError } = usePermissions();
  const labels = REFERENCE_LABELS[kind];
  const extras = REFERENCE_EXTRA_FIELDS[kind];
  const refLinks = linksFrom(kind);
  const [refOptions, setRefOptions] = useState<Record<string, { id: string; name: string }[]>>({});
  // Gated per the permission each route actually enforces, not one blanket key: add/paste hit
  // POST routes requiring admin.create, delete hits a DELETE route requiring admin.delete, and
  // only the Active-toggle PUT requires admin.edit (src/app/api/admin/reference/[kind]/route.ts,
  // .../paste/route.ts, .../[id]/route.ts).
  const canCreate = gate(perms, "admin.create");
  const canDelete = gate(perms, "admin.delete");
  const canEdit = gate(perms, "admin.edit");

  const load = useCallback(async () => {
    setRows(await api<Row[]>(`/api/admin/reference/${kind}${showInactive ? "?includeInactive=1" : ""}`));
  }, [kind, showInactive]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

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
      // Retiring a row via the Active toggle is the sanctioned alternative to deleting it (§4.2)
      // — it must not leave a blocker panel from an earlier failed delete attempt on screen.
      setError(null); setBlocked(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function remove(row: Row) {
    if (!confirm(`Delete ${labels.singular.toLowerCase()} "${row.name}"?`)) return;
    try {
      await api(`/api/admin/reference/${kind}/${row.id}`, { method: "DELETE" });
      setError(null); setBlocked(null); await load();
    } catch (e) {
      // A refusal is not a dead end here: say what is blocking, and make the list exportable.
      // Only the delete guard's own 400 means there IS a blocker list to fetch — a 500 or a
      // network failure is a genuine error, not a refusal, and fetching (and likely finding no)
      // blockers for it would misreport a real failure as "N records use it".
      if (e instanceof ApiError && e.status === 400) {
        try {
          const list = await api<Blocker[]>(`/api/admin/reference/${kind}/${row.id}/blockers`);
          if (list.length) { setBlocked({ row, list }); setError(null); return; }
        } catch (listErr) {
          // The delete WAS correctly refused, but the follow-up fetch for WHAT is blocking it
          // failed too (network, 500). A silently empty list here is indistinguishable from
          // "nothing blocks it" and recreates the undiscoverable dead end this feature exists to
          // remove — say plainly that the list is missing, not empty, so the user can retry.
          setError(`${(e as Error).message} — the list of what's using it could not be loaded ` +
            `(${(listErr as Error).message}). Try again.`);
          return;
        }
      }
      setError((e as Error).message);
    }
  }

  return (
    <div>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      <div className="mb-2 flex items-center gap-3">
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        <a href={`/api/admin/reference/${kind}/export${showInactive ? "?includeInactive=1" : ""}`}
           className="text-sm text-blue-700 underline">
          Export to Excel
        </a>
        <button onClick={() => setPasting((p) => !p)} disabled={canCreate.disabled} title={canCreate.title}
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
                <input type="checkbox" checked={r.active} disabled={canEdit.disabled} title={canEdit.title}
                       onChange={() => toggleActive(r)} />
              </td>
              <td className="p-2 text-right">
                <button onClick={() => setOpenHistory(openHistory === r.id ? null : r.id)}
                        className="mr-3 text-xs text-slate-600">history</button>
                <button onClick={() => remove(r)} disabled={canDelete.disabled} title={canDelete.title}
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
              <button onClick={add} disabled={canCreate.disabled} title={canCreate.title}
                      className="rounded bg-slate-800 px-3 py-1 text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      {blocked && (
        <BlockerPanel
          label={labels.singular.toLowerCase()}
          rowName={blocked.row.name}
          list={blocked.list}
          exportHref={`/api/admin/reference/${kind}/${blocked.row.id}/blockers/export`}
          onDismiss={() => setBlocked(null)}
        />
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
