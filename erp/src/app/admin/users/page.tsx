"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";

type Role = { id: string; name: string };
type User = {
  id: string; username: string; displayName: string; roleId: string | null;
  roleName: string | null; active: boolean;
  overrides: { permission: string; mode: "GRANT" | "DENY" }[];
};

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ username: "", displayName: "", password: "", roleId: "" });

  const load = useCallback(async () => {
    setUsers(await api<User[]>("/api/admin/users"));
    setRoles(await api<Role[]>("/api/admin/roles"));
  }, []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  async function create() {
    try {
      await api("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ ...form, roleId: form.roleId || undefined }),
      });
      setForm({ username: "", displayName: "", password: "", roleId: "" });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function patch(id: string, body: object) {
    try { await api(`/api/admin/users/${id}`, { method: "PUT", body: JSON.stringify(body) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Users</h1>
      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <table className="mb-6 w-full rounded border bg-white text-sm">
        <thead><tr className="border-b text-left">
          <th className="p-2">Username</th><th className="p-2">Name</th><th className="p-2">Role</th>
          <th className="p-2">Active</th><th className="p-2">Reset password</th>
        </tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b">
              <td className="p-2">{u.username}</td>
              <td className="p-2">{u.displayName}</td>
              <td className="p-2">
                <select value={u.roleId ?? ""} onChange={(e) => patch(u.id, { roleId: e.target.value || null })}
                        className="rounded border px-1 py-0.5">
                  <option value="">— none —</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </td>
              <td className="p-2">
                <input type="checkbox" checked={u.active} onChange={(e) => patch(u.id, { active: e.target.checked })} />
              </td>
              <td className="p-2">
                <button className="text-blue-700 underline"
                        onClick={() => { const p = prompt("New password (min 8 chars):"); if (p) void patch(u.id, { password: p }); }}>
                  reset…
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2 className="mb-2 font-medium">Add user</h2>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <input placeholder="Username" value={form.username}
               onChange={(e) => setForm({ ...form, username: e.target.value })} className="rounded border px-2 py-1" />
        <input placeholder="Display name" value={form.displayName}
               onChange={(e) => setForm({ ...form, displayName: e.target.value })} className="rounded border px-2 py-1" />
        <input placeholder="Password" type="password" value={form.password}
               onChange={(e) => setForm({ ...form, password: e.target.value })} className="rounded border px-2 py-1" />
        <select value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}
                className="rounded border px-2 py-1">
          <option value="">— no role —</option>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button onClick={create} className="rounded bg-slate-800 px-3 py-1 text-white">Add</button>
      </div>
      <p className="mt-4 text-xs text-slate-500">
        Users are never deleted — deactivate instead (audit history must keep resolving their names).
        Per-user permission overrides are edited from the user&apos;s History panel in a later phase; the API already supports them.
      </p>
    </div>
  );
}
