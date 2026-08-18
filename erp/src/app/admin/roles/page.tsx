"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/fetcher";
import { AREAS, CRUD_ACTIONS, SPECIAL_ACTIONS } from "@/lib/permission-constants";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest, useMutationGate } from "@/lib/use-latest";

type Role = { id: string; name: string; permissions: string[]; userCount: number };

export default function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [selected, setSelected] = useState<Role | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { permissions: perms, error: permsError } = usePermissions();
  // Gated per the permission each route actually enforces (verified by reading the routes, not
  // inferred): add role and the permission checkboxes both hit PUT/POST routes requiring
  // admin.edit (src/app/api/admin/roles/route.ts, .../roles/[id]/route.ts); delete hits the
  // DELETE route Task 8 tightened to admin.delete.
  const canEdit = gate(perms, "admin.edit");
  const canDelete = gate(perms, "admin.delete");

  // Mirrors `roles` for save-time reads: a queued toggle must compose its payload from the
  // FRESHEST known role, not the one captured when the checkbox was clicked (the
  // step-codes/page.tsx `codesRef` precedent).
  const rolesRef = useRef<Role[]>([]);
  const latest = useLatest();
  // The rolesRef landing (the step-codes/page.tsx codesRefGate shape): the ref exists to hand a
  // QUEUED run the freshest server truth, not to gate what the user sees, so a superseded load
  // must still be allowed to land it — but landing on ARRIVAL order lets an older fetch resolving
  // after a newer one rewind the ref to a PRE-mutation permission set, and the next queued toggle
  // composes its ENTIRE array from the ref at run time, so it would persist the reverted set
  // server-side. The write is therefore applied-monotonic on the load ticket (makeMutationGate
  // semantics): an early finisher of a superseded load still lands, a straggler is dropped.
  const rolesRefGate = useMutationGate();
  const load = useCallback(async () => {
    const ticket = latest.next();
    try {
      const data = await api<Role[]>("/api/admin/roles");
      if (rolesRefGate.accept(ticket)) rolesRef.current = data;
      if (!latest.isCurrent(ticket)) return; // a slower, now-superseded load lost the state race
      setRoles(data);
      setSelected((cur) => (cur ? data.find((r) => r.id === cur.id) ?? null : null));
    } catch (e) {
      // F7 (customers/page.tsx): a superseded load's rejection must not clobber current state.
      if (!latest.isCurrent(ticket)) return;
      throw e;
    }
  }, [latest, rolesRefGate]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  async function create() {
    try { await api("/api/admin/roles", { method: "POST", body: JSON.stringify({ name: newName }) });
      setNewName(""); await load(); } catch (e) { setError((e as Error).message); }
  }

  // One at a time, composed inside the queued run (the surcharges/page.tsx saveQueue shape): each
  // PUT carries the role's ENTIRE permission array, so composing from click-time state let two
  // quick checks overlap — checking box A then box B before A's round trip landed made PUT#B
  // replace the array WITHOUT A, silently reverting the first grant server-side. The queued run
  // looks the role up from `rolesRef` at its OWN turn — after the previous save's load() has
  // landed the ref — so overlapping toggles accumulate instead of clobbering.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  function toggle(roleId: string, permission: string): Promise<void> {
    const run = async () => {
      const role = rolesRef.current.find((r) => r.id === roleId);
      if (!role) return;
      const has = role.permissions.includes(permission);
      const next = has ? role.permissions.filter((p) => p !== permission) : [...role.permissions, permission];
      try {
        await api(`/api/admin/roles/${roleId}`, { method: "PUT", body: JSON.stringify({ permissions: next }) });
        await load();
      } catch (e) { setError((e as Error).message); }
    };
    saveQueue.current = saveQueue.current.then(run, run);
    return saveQueue.current;
  }

  async function remove(role: Role) {
    const reason = prompt(`Delete role "${role.name}"?\n\nWhy? (recorded in the audit trail)`);
    // null = cancelled; empty = submitted blank, which the service rejects with a clear message.
    if (reason === null) return;
    try {
      await api(`/api/admin/roles/${role.id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
      setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Roles</h1>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      <div className="flex gap-6">
        <div className="w-64">
          <ul className="mb-3 divide-y rounded border bg-white">
            {roles.map((r) => (
              <li key={r.id}
                  className={`flex cursor-pointer items-center justify-between px-3 py-2 ${selected?.id === r.id ? "bg-slate-100" : ""}`}
                  onClick={() => setSelected(r)}>
                <span>{r.name} <span className="text-xs text-slate-500">({r.userCount})</span></span>
                <button onClick={(e) => { e.stopPropagation(); void remove(r); }}
                        disabled={canDelete.disabled} title={canDelete.title}
                        className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                  delete
                </button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New role name"
                   className="w-full rounded border px-2 py-1 text-sm" />
            <button onClick={create} disabled={canEdit.disabled} title={canEdit.title}
                    className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
              Add
            </button>
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
                                 disabled={canEdit.disabled} title={canEdit.title}
                                 onChange={() => void toggle(selected.id, key)} />
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
                    <input type="checkbox" checked={selected.permissions.includes(key)}
                           disabled={canEdit.disabled} title={canEdit.title}
                           onChange={() => void toggle(selected.id, key)} />
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
