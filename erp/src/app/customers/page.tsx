"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { PasteGrid } from "@/components/PasteGrid";
import { invalidateSetupBanner } from "@/components/SetupBanner";
import { CUSTOMER_PASTE_COLUMNS } from "@/lib/customer-constants";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";

type Customer = {
  id: string; code: string; name: string; parentCode: string | null;
  creditHold: boolean; active: boolean;
};

export default function CustomersPage() {
  const [rows, setRows] = useState<Customer[]>([]);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [draft, setDraft] = useState({ code: "", name: "" });
  const [error, setError] = useState<string | null>(null);
  const { permissions: perms, error: permsError } = usePermissions();

  const query = `${showInactive ? "includeInactive=1&" : ""}${search ? `search=${encodeURIComponent(search)}` : ""}`;

  // Named `latest`, not `gate` — this file also imports `gate` from permission-ui for the
  // held-permission checks below, and shadowing that binding with the stale-response gate would
  // break every `gate(perms, ...)` call in this component.
  const latest = useLatest();
  // F7: the catch must be ticket-gated too, not just the success path. Without this, a
  // superseded request's REJECTION (a dropped connection on the OLD search term, say) can land
  // after a newer request already succeeded, and setError() would overwrite the fresh rows with
  // a stale failure message — the mirror image of the stale-success bug isCurrent() already
  // guarded against below.
  const load = useCallback(async () => {
    const t = latest.next();
    let data: Customer[];
    try {
      data = await api<Customer[]>(`/api/customers${query ? `?${query}` : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) setError((e as Error).message);
      return;
    }
    if (!latest.isCurrent(t)) return;
    setRows(data);
  }, [query, latest]);
  useEffect(() => { void load(); }, [load]);

  const canCreate = gate(perms, "customers.create");

  async function add() {
    try {
      await api("/api/customers", { method: "POST", body: JSON.stringify(draft) });
      // #110: the first customer completes a banner readiness step (#124/#131 ordering: before load()).
      invalidateSetupBanner();
      setDraft({ code: "", name: "" }); setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Customers</h1>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}

      <div className="mb-3 flex items-center gap-3">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
               placeholder="Search code or name" className="w-64 rounded border px-2 py-1 text-sm" />
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        <a href={`/api/customers/export${query ? `?${query}` : ""}`} className="text-sm text-blue-700 underline">
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
            <th className="p-2">Code</th><th className="p-2">Name</th>
            <th className="p-2">Parent</th><th className="p-2">Active</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="border-t">
              <td className="p-2 font-mono">
                <Link href={`/customers/${c.id}`} className="text-blue-700 underline">{c.code}</Link>
              </td>
              <td className="p-2">
                {c.name}
                {c.creditHold && (
                  <span className="ml-2 rounded bg-red-100 px-1 text-xs text-red-800">credit hold</span>
                )}
              </td>
              <td className="p-2 font-mono text-slate-500">{c.parentCode ?? ""}</td>
              <td className="p-2">{c.active ? "yes" : "no"}</td>
            </tr>
          ))}
          <tr className="border-t bg-slate-50">
            <td className="p-2">
              <input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                     placeholder="Code" className="w-full rounded border px-2 py-1" />
            </td>
            <td className="p-2" colSpan={2}>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                     placeholder="Name" className="w-full rounded border px-2 py-1" />
            </td>
            <td className="p-2 text-right">
              <button onClick={add} disabled={canCreate.disabled} title={canCreate.title}
                      className="rounded bg-slate-800 px-3 py-1 text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      {pasting && (
        // #110: PasteGrid fires onDone only after a successful POST.
        <PasteGrid endpoint="/api/customers/paste" columns={[...CUSTOMER_PASTE_COLUMNS]}
                   onDone={() => { invalidateSetupBanner(); void load(); }} />
      )}
    </div>
  );
}
