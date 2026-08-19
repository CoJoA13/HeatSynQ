"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { invalidateSetupBanner } from "@/components/SetupBanner";
import { usePermissions } from "@/lib/use-permissions";
import { gateDo, type Gate } from "@/lib/permission-ui";
import { useLatest } from "@/lib/use-latest";
import { UserSignatureControl } from "@/components/UserSignatureControl";

type Role = { id: string; name: string };
type User = {
  id: string; username: string; displayName: string; title: string; roleId: string | null;
  roleName: string | null; active: boolean;
  overrides: { permission: string; mode: "GRANT" | "DENY" }[];
};

/** The signature-title cell (Phase 6 ruling 14): prints on the quote and cert signature blocks;
 *  blank prints nothing. Local draft, PATCHed on blur only when actually changed — the row's
 *  other controls PATCH per interaction, and a keystroke-level PATCH would mint an audit entry
 *  per character. Keyed remount (below) re-baselines it after every reload.
 *  `gate`: the page's `gateDo(perms, "manage_users")` (§5.16 — disabled with the reason, never
 *  hidden; the UserSignatureControl precedent). */
function TitleCell({ user, gate, onSave }: { user: User; gate: Gate; onSave: (title: string) => void }) {
  const [draft, setDraft] = useState(user.title);
  return (
    <input value={draft} placeholder="— none —"
           disabled={gate.disabled} title={gate.title}
           onChange={(e) => setDraft(e.target.value)}
           onBlur={() => { if (draft !== user.title) onSave(draft); }}
           className="w-36 rounded border px-1 py-0.5" />
  );
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ username: "", displayName: "", password: "", roleId: "" });
  const { permissions: perms, error: permsError } = usePermissions();
  // Every route this page calls — list/create (api/admin/users), per-user PUT, and every verb on
  // the signature route — requires this same special action, so ONE gate covers the whole page:
  // each row control and the Add form disable with the reason, never hide (§5.16; #100 item 4).
  const manageUsersGate = gateDo(perms, "manage_users");

  // Ticket-gated load (the surcharges/page.tsx load shape): patch()/create() refire this per row
  // interaction, so overlapping loads used to land in arrival order — a toggled checkbox visibly
  // reverted while the server held the new value. ONE ticket covers BOTH fetches (Promise.all),
  // so users and roles can never tear across two loads' snapshots either.
  const latest = useLatest();
  const load = useCallback(async () => {
    const ticket = latest.next();
    try {
      const [u, r] = await Promise.all([
        api<User[]>("/api/admin/users"),
        api<Role[]>("/api/admin/roles"),
      ]);
      if (!latest.isCurrent(ticket)) return; // a slower, now-superseded load lost the state race
      setUsers(u); setRoles(r);
    } catch (e) {
      // F7 (customers/page.tsx): a superseded load's rejection must not surface an error over
      // state a newer load has already refreshed.
      if (!latest.isCurrent(ticket)) return;
      throw e;
    }
  }, [latest]);
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

  async function patch(id: string, body: object, opts?: { invalidatesSetup?: boolean }) {
    try {
      await api(`/api/admin/users/${id}`, { method: "PUT", body: JSON.stringify(body) });
      // #110: fired for the PASSWORD mutation only (the reset button below passes the flag) —
      // it is the one PATCH here that moves the banner's readiness signal (install-readiness.ts
      // argon2-verifies the admin row's password; title/role/active touch nothing it reads), and
      // invalidating on every title blur would spend a server-side argon2 verify per field edit
      // for nothing. Before load(), the #124/#131 ordering.
      if (opts?.invalidatesSetup) invalidateSetupBanner();
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Users</h1>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      <table className="mb-6 w-full rounded border bg-white text-sm">
        <thead><tr className="border-b text-left">
          <th className="p-2">Username</th><th className="p-2">Name</th>
          <th className="p-2">Title</th><th className="p-2">Role</th>
          <th className="p-2">Active</th><th className="p-2">Signature</th><th className="p-2">Reset password</th>
        </tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b">
              <td className="p-2">{u.username}</td>
              <td className="p-2">{u.displayName}</td>
              <td className="p-2">
                {/* key re-baselines the draft when a reload brings fresh server truth. */}
                <TitleCell key={`${u.id}-${u.title}`} user={u} gate={manageUsersGate}
                           onSave={(title) => patch(u.id, { title })} />
              </td>
              <td className="p-2">
                <select value={u.roleId ?? ""} onChange={(e) => patch(u.id, { roleId: e.target.value || null })}
                        disabled={manageUsersGate.disabled} title={manageUsersGate.title}
                        className="rounded border px-1 py-0.5 disabled:cursor-not-allowed">
                  <option value="">— none —</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </td>
              <td className="p-2">
                <input type="checkbox" checked={u.active}
                       disabled={manageUsersGate.disabled} title={manageUsersGate.title}
                       className="disabled:cursor-not-allowed"
                       onChange={(e) => patch(u.id, { active: e.target.checked })} />
              </td>
              <td className="p-2">
                <UserSignatureControl userId={u.id} gate={manageUsersGate} />
              </td>
              <td className="p-2">
                <button className="text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400"
                        disabled={manageUsersGate.disabled} title={manageUsersGate.title}
                        onClick={() => { const p = prompt("New password (min 8 chars):"); if (p) void patch(u.id, { password: p }, { invalidatesSetup: true }); }}>
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
               disabled={manageUsersGate.disabled} title={manageUsersGate.title}
               onChange={(e) => setForm({ ...form, username: e.target.value })}
               className="rounded border px-2 py-1 disabled:cursor-not-allowed" />
        <input placeholder="Display name" value={form.displayName}
               disabled={manageUsersGate.disabled} title={manageUsersGate.title}
               onChange={(e) => setForm({ ...form, displayName: e.target.value })}
               className="rounded border px-2 py-1 disabled:cursor-not-allowed" />
        <input placeholder="Password" type="password" value={form.password}
               disabled={manageUsersGate.disabled} title={manageUsersGate.title}
               onChange={(e) => setForm({ ...form, password: e.target.value })}
               className="rounded border px-2 py-1 disabled:cursor-not-allowed" />
        <select value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}
                disabled={manageUsersGate.disabled} title={manageUsersGate.title}
                className="rounded border px-2 py-1 disabled:cursor-not-allowed">
          <option value="">— no role —</option>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button onClick={create} disabled={manageUsersGate.disabled} title={manageUsersGate.title}
                className="rounded bg-slate-800 px-3 py-1 text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          Add
        </button>
      </div>
      <p className="mt-4 text-xs text-slate-500">
        Users are never deleted — deactivate instead (audit history must keep resolving their names).
        Per-user permission overrides are edited from the user&apos;s History panel in a later phase; the API already supports them.
      </p>
    </div>
  );
}
