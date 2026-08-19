"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { PasteGrid } from "@/components/PasteGrid";
import { invalidateSetupBanner } from "@/components/SetupBanner";
import { PART_PASTE_COLUMNS } from "@/lib/part-constants";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";

// Local row type mirrors only the columns this list renders — id, partNumber, name,
// customerCode, customerName, materialName, eachWeight, active. Not imported from
// src/server/parts.ts's PartRow: a client component must not import from src/server/**
// (CLAUDE.md "Constraints that will bite you" — it drags node:async_hooks and Prisma into the
// browser bundle), and PartRow itself carries pricing/description/etc. fields this list has no
// use for.
type PartRow = {
  id: string; partNumber: string; name: string;
  customerCode: string; customerName: string;
  materialName: string | null; eachWeight: number; active: boolean;
};

// Slice of CustomerRow needed to populate the add-row's customer picker.
type CustomerOption = { id: string; code: string; name: string };

export default function PartsPage() {
  const [rows, setRows] = useState<PartRow[]>([]);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [draft, setDraft] = useState({ customerId: "", partNumber: "", eachWeight: "" });
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
    let data: PartRow[];
    try {
      data = await api<PartRow[]>(`/api/parts${query ? `?${query}` : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) setError((e as Error).message);
      return;
    }
    if (!latest.isCurrent(t)) return;
    setRows(data);
  }, [query, latest]);
  useEffect(() => { void load(); }, [load]);

  // Stale-closure guard (Task 7): `load` closes over `query`, so a handler continuation captured
  // before a search/show-inactive change would re-ask the OLD query with the NEWEST ticket —
  // defeating the gate, and leaving the table disagreeing with the controls above it. The
  // post-mutation refetches below go through this ref, updated every render (in an effect — the
  // `react-hooks/refs` rule forbids a render-time write), so they always call the CURRENT loader.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });

  const canCreate = gate(perms, "parts.create");
  const customersGate = gate(perms, "customers.view");

  // Customer picker for the add row: fetched only once the caller is known to hold
  // customers.view, never left silently empty for someone who lacks it (§5.16 — a blocked
  // control must say why, not just refuse). A failed fetch surfaces through `error`, same as
  // every other fetch on this page — no `.catch(() => {})` silencing.
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers).catch((e) => setError(e.message));
  }, [customersGate.allowed]);

  async function add() {
    try {
      // eachWeight is sent as the string the user typed — the service's decimalField zod
      // schema accepts a decimal string directly, no client-side parseFloat needed.
      await api("/api/parts", { method: "POST", body: JSON.stringify(draft) });
      // #110: the first part completes a banner readiness step (#124/#131 ordering: before load()).
      invalidateSetupBanner();
      setDraft({ customerId: "", partNumber: "", eachWeight: "" });
      setError(null);
      await loadRef.current();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Parts</h1>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}

      <div className="mb-3 flex items-center gap-3">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
               placeholder="Search part number or customer" className="w-64 rounded border px-2 py-1 text-sm" />
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        <a href={`/api/parts/export${query ? `?${query}` : ""}`} className="text-sm text-blue-700 underline">
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
            <th className="p-2">Customer</th><th className="p-2">Part number</th>
            <th className="p-2">Name</th><th className="p-2">Material</th>
            <th className="p-2">Each wt</th><th className="p-2">Active</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className="border-t">
              <td className="p-2">{p.customerCode} · {p.customerName}</td>
              <td className="p-2 font-mono">
                <Link href={`/parts/${p.id}`} className="text-blue-700 underline">{p.partNumber}</Link>
              </td>
              <td className="p-2">{p.name}</td>
              <td className="p-2 text-slate-500">{p.materialName ?? ""}</td>
              <td className="p-2">{p.eachWeight}</td>
              <td className="p-2">{p.active ? "yes" : "no"}</td>
            </tr>
          ))}
          <tr className="border-t bg-slate-50">
            <td className="p-2">
              <select value={draft.customerId} onChange={(e) => setDraft({ ...draft, customerId: e.target.value })}
                      disabled={!customersGate.allowed} title={customersGate.allowed ? undefined : customersGate.title}
                      className="w-full rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
                <option value="">Customer…</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
                ))}
              </select>
            </td>
            <td className="p-2">
              <input value={draft.partNumber} onChange={(e) => setDraft({ ...draft, partNumber: e.target.value })}
                     placeholder="Part number" className="w-full rounded border px-2 py-1" />
            </td>
            <td className="p-2" colSpan={2} />
            <td className="p-2">
              <input value={draft.eachWeight} onChange={(e) => setDraft({ ...draft, eachWeight: e.target.value })}
                     placeholder="Each wt" inputMode="decimal" className="w-full rounded border px-2 py-1" />
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
        <PasteGrid endpoint="/api/parts/paste" columns={[...PART_PASTE_COLUMNS]}
                   onDone={() => { invalidateSetupBanner(); void loadRef.current(); }} />
      )}
    </div>
  );
}
