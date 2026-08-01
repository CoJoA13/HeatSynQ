"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { PART_FIELD_TYPES, type PartFieldTypeValue } from "@/lib/part-constants";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { BlockerPanel, type Blocker } from "@/components/BlockerPanel";

type FieldDef = { id: string; name: string; type: PartFieldTypeValue; sort: number; active: boolean };

export default function PartFieldsPage() {
  const [rows, setRows] = useState<FieldDef[]>([]);
  const [draft, setDraft] = useState<{ name: string; type: PartFieldTypeValue; sort: number }>({
    name: "", type: PART_FIELD_TYPES[0], sort: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ row: FieldDef; list: Blocker[] } | null>(null);
  const { permissions: perms, error: permsError } = usePermissions();
  // Gated per the permission each route actually enforces (ReferenceTable.tsx precedent, fixed
  // in 2C-1's review, followed here rather than the step-codes page, which gates none of this):
  // add hits POST requiring admin.create, every row edit (name/type/sort/active) hits PUT
  // requiring admin.edit, delete hits DELETE requiring admin.delete
  // (src/app/api/admin/part-fields/route.ts, .../[id]/route.ts).
  const canCreate = gate(perms, "admin.create");
  const canEdit = gate(perms, "admin.edit");
  const canDelete = gate(perms, "admin.delete");

  // includeInactive=1 always: unlike the reference grid, there is no separate "show inactive"
  // filter here — the Active column IS the reactivation control, so an inactive def must stay
  // visible to be turned back on.
  const load = useCallback(async () => {
    setRows(await api<FieldDef[]>("/api/admin/part-fields?includeInactive=1"));
  }, []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  async function save(id: string, body: Record<string, unknown>) {
    try {
      await api(`/api/admin/part-fields/${id}`, { method: "PUT", body: JSON.stringify(body) });
      setError(null); setBlocked(null); await load();
    } catch (e) {
      // Roll back to server truth FIRST, then report why (§5.13) — a failed edit must not leave
      // a stale, unsaved value sitting in the grid looking as if it took effect. The reload's own
      // failure is swallowed here only because the original error below is what gets reported;
      // it is not silencing that original error.
      await load().catch(() => {});
      setError((e as Error).message);
    }
  }

  function editLocal(id: string, patch: Partial<FieldDef>) {
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  // onChange-sets-local/onBlur-saves split (IdentitySection.tsx precedent): typing doesn't hit
  // the network on every keystroke, and tabbing through a row without changing it writes no
  // no-op audit entry.
  const focused = useRef<Record<string, string>>({});
  function noteFocus(id: string, field: string, value: string) {
    focused.current[`${id}.${field}`] = value;
  }

  function blurSaveName(id: string, value: string) {
    const before = focused.current[`${id}.name`];
    const name = value.trim();
    if (name === before?.trim()) return;
    if (!name) { setError("Name is required"); void load(); return; }
    void save(id, { name });
  }

  function blurSaveSort(id: string, value: string) {
    const before = focused.current[`${id}.sort`];
    if (value === before) return;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) {
      setError("Sort must be a whole number, 0 or greater");
      void load();
      return;
    }
    void save(id, { sort: n });
  }

  async function add() {
    try {
      await api("/api/admin/part-fields", { method: "POST", body: JSON.stringify(draft) });
      setDraft({ name: "", type: PART_FIELD_TYPES[0], sort: rows.length });
      setError(null); setBlocked(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function remove(row: FieldDef) {
    if (!confirm(`Delete part field "${row.name}"?`)) return;
    try {
      await api(`/api/admin/part-fields/${row.id}`, { method: "DELETE" });
      setError(null); setBlocked(null); await load();
    } catch (e) {
      // A refusal is not a dead end (ReferenceTable.tsx precedent): say what's blocking, and
      // make the list exportable. Only the delete guard's own 400 means a blocker list exists to
      // fetch — a 500 or a network failure is a genuine error, not a refusal, and fetching (and
      // likely finding no) blockers for it would misreport a real failure as "N records use it".
      if (e instanceof ApiError && e.status === 400) {
        try {
          const list = await api<Blocker[]>(`/api/admin/part-fields/${row.id}/blockers`);
          if (list.length) { setBlocked({ row, list }); setError(null); return; }
        } catch (listErr) {
          setError(`${(e as Error).message} — the list of what's using it could not be loaded ` +
            `(${(listErr as Error).message}). Try again.`);
          return;
        }
      }
      setError((e as Error).message);
    }
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Part custom fields</h1>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      <table className="w-full rounded border bg-white text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="p-2">Name</th><th className="p-2">Type</th><th className="p-2">Sort</th>
            <th className="p-2">Active</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t">
              <td className="p-2">
                <input value={r.name} disabled={canEdit.disabled} title={canEdit.title}
                       onFocus={(e) => noteFocus(r.id, "name", e.target.value)}
                       onChange={(e) => editLocal(r.id, { name: e.target.value })}
                       onBlur={(e) => blurSaveName(r.id, e.target.value)}
                       className="w-full rounded border px-2 py-1 disabled:bg-slate-100" />
              </td>
              <td className="p-2">
                <select value={r.type} disabled={canEdit.disabled} title={canEdit.title}
                        onChange={(e) => void save(r.id, { type: e.target.value })}
                        className="rounded border px-2 py-1 disabled:bg-slate-100">
                  {PART_FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </td>
              <td className="p-2">
                <input value={r.sort} type="number" disabled={canEdit.disabled} title={canEdit.title}
                       onFocus={(e) => noteFocus(r.id, "sort", e.target.value)}
                       onChange={(e) => editLocal(r.id, { sort: Number(e.target.value) || 0 })}
                       onBlur={(e) => blurSaveSort(r.id, e.target.value)}
                       className="w-20 rounded border px-2 py-1 disabled:bg-slate-100" />
              </td>
              <td className="p-2">
                <input type="checkbox" checked={r.active} disabled={canEdit.disabled} title={canEdit.title}
                       onChange={(e) => void save(r.id, { active: e.target.checked })} />
              </td>
              <td className="p-2 text-right">
                <button onClick={() => remove(r)} disabled={canDelete.disabled} title={canDelete.title}
                        className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                  delete
                </button>
              </td>
            </tr>
          ))}
          <tr className="border-t bg-slate-50">
            <td className="p-2">
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                     placeholder="Name" className="w-full rounded border px-2 py-1" />
            </td>
            <td className="p-2">
              <select value={draft.type}
                      onChange={(e) => setDraft({ ...draft, type: e.target.value as PartFieldTypeValue })}
                      className="rounded border px-2 py-1">
                {PART_FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </td>
            <td className="p-2">
              <input value={draft.sort} type="number"
                     onChange={(e) => setDraft({ ...draft, sort: Number(e.target.value) || 0 })}
                     className="w-20 rounded border px-2 py-1" />
            </td>
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
          label="part field"
          rowName={blocked.row.name}
          list={blocked.list}
          exportHref={`/api/admin/part-fields/${blocked.row.id}/blockers/export`}
          onDismiss={() => setBlocked(null)}
        />
      )}
    </div>
  );
}
