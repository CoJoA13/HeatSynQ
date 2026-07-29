"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { AREAS, CRUD_ACTIONS, SPECIAL_ACTIONS } from "@/lib/permission-constants";

type Role = { id: string; name: string; permissions: string[]; userCount: number };

export default function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [selected, setSelected] = useState<Role | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api<Role[]>("/api/admin/roles");
    setRoles(data);
    setSelected((cur) => (cur ? data.find((r) => r.id === cur.id) ?? null : null));
  }, []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  async function create() {
    try { await api("/api/admin/roles", { method: "POST", body: JSON.stringify({ name: newName }) });
      setNewName(""); await load(); } catch (e) { setError((e as Error).message); }
  }

  async function toggle(permission: string) {
    if (!selected) return;
    const has = selected.permissions.includes(permission);
    const next = has ? selected.permissions.filter((p) => p !== permission) : [...selected.permissions, permission];
    try { await api(`/api/admin/roles/${selected.id}`, { method: "PUT", body: JSON.stringify({ permissions: next }) });
      await load(); } catch (e) { setError((e as Error).message); }
  }

  async function remove(role: Role) {
    if (!confirm(`Delete role "${role.name}"?`)) return;
    try { await api(`/api/admin/roles/${role.id}`, { method: "DELETE" }); setSelected(null); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Roles</h1>
      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <div className="flex gap-6">
        <div className="w-64">
          <ul className="mb-3 divide-y rounded border bg-white">
            {roles.map((r) => (
              <li key={r.id}
                  className={`flex cursor-pointer items-center justify-between px-3 py-2 ${selected?.id === r.id ? "bg-slate-100" : ""}`}
                  onClick={() => setSelected(r)}>
                <span>{r.name} <span className="text-xs text-slate-500">({r.userCount})</span></span>
                <button onClick={(e) => { e.stopPropagation(); void remove(r); }}
                        className="text-xs text-red-600">delete</button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New role name"
                   className="w-full rounded border px-2 py-1 text-sm" />
            <button onClick={create} className="rounded bg-slate-800 px-3 py-1 text-sm text-white">Add</button>
          </div>
        </div>
        {selected && (
          <div className="flex-1 rounded border bg-white p-4">
            <h2 className="mb-3 font-medium">{selected.name} — permissions</h2>
            <table className="mb-4 w-full text-sm">
              <thead><tr><th className="text-left">Area</th>
                {CRUD_ACTIONS.map((a) => <th key={a} className="px-2 capitalize">{a}</th>)}</tr></thead>
              <tbody>
                {AREAS.map((area) => (
                  <tr key={area} className="border-t">
                    <td className="py-1 capitalize">{area}</td>
                    {CRUD_ACTIONS.map((action) => {
                      const key = `${area}.${action}`;
                      return (
                        <td key={key} className="px-2 text-center">
                          <input type="checkbox" checked={selected.permissions.includes(key)}
                                 onChange={() => toggle(key)} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <h3 className="mb-2 font-medium">Special actions</h3>
            <div className="grid grid-cols-2 gap-1 text-sm">
              {SPECIAL_ACTIONS.map((s) => {
                const key = `action.${s}`;
                return (
                  <label key={key} className="flex items-center gap-2">
                    <input type="checkbox" checked={selected.permissions.includes(key)} onChange={() => toggle(key)} />
                    {s.replaceAll("_", " ")}
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
