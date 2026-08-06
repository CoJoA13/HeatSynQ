"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";

// Local mirror of src/server/shippers.ts's ShipperRow — not imported from src/server/** (CLAUDE.md
// "Constraints that will bite you": a client component pulling from there drags node:async_hooks
// and Prisma into the browser bundle). `shipDate` arrives pre-formatted as a "yyyy-mm-dd" string
// (`formatDateOnly` runs server-side before `NextResponse.json`), so there is nothing left to
// parse here.
type ShipperRow = {
  id: string; shipperNumber: number; bolNumber: number | null; customerCode: string; customerName: string;
  shipDate: string; orderCount: number; orderLabels: string[]; carrierName: string | null;
  totalQty: number; totalWeight: number; freightAmount: number | null; deletedAt: string | null;
};

// The orders board / parts page precedent: only the slice the customer filter picker needs.
type CustomerOption = { id: string; code: string; name: string };

type Filters = { customerId: string; from: string; to: string; includeVoided: boolean; search: string };

// includeVoided defaults off (spec §11) — a voided shipment stays off the board until the caller
// deliberately asks for it.
const DEFAULT_FILTERS: Filters = { customerId: "", from: "", to: "", includeVoided: false, search: "" };

/** Mirrors `src/app/api/shippers/query.ts`'s `parseShipperFilter` in reverse: turns this screen's
 *  filter state into the query string both `/api/shippers` and `/api/shippers/export` expect. */
function buildQuery(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.customerId) params.set("customerId", filters.customerId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.includeVoided) params.set("includeVoided", "1");
  if (filters.search.trim()) params.set("search", filters.search.trim());
  return params.toString();
}

export function ShippingList() {
  const router = useRouter();
  const { permissions: perms, error: permsError } = usePermissions();
  const [rows, setRows] = useState<ShipperRow[]>([]);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  const customersGate = gate(perms, "customers.view");
  const createGate = gate(perms, "shipping.create");

  // Customer filter picker: fetched only once the caller is known to hold customers.view, never
  // left silently empty for someone who lacks it (§5.16) — the orders board (src/app/page.tsx)
  // precedent, applied to this screen's own customer filter.
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers).catch((e) => setError((e as Error).message));
  }, [customersGate.allowed]);

  function updateFilters(patch: Partial<Filters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
  }

  const query = buildQuery(filters);

  const latest = useLatest();
  // Ticket-gated on BOTH the success and the rejection path (issues #5/#15 — a stale search
  // response must never overwrite a newer one, and a stale FAILURE must never overwrite a newer
  // success either). No `.catch(() => {})` anywhere: a failed load sets `error` and renders it,
  // never silently leaves `rows` looking like an empty-but-healthy list.
  const load = useCallback(async () => {
    const t = latest.next();
    let data: ShipperRow[];
    try {
      data = await api<ShipperRow[]>(`/api/shippers${query ? `?${query}` : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) setError((e as Error).message);
      return;
    }
    if (!latest.isCurrent(t)) return;
    setRows(data);
    setError(null);
  }, [query, latest]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Shipping</h1>
        {/* The entry point to /shipping/new (Task 14b) — §5.16: disabled with the missing
            permission named, never hidden (the orders board's New Order precedent). */}
        <button onClick={() => router.push("/shipping/new")} disabled={createGate.disabled} title={createGate.title}
                className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          New Shipment
        </button>
      </div>

      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}

      <div className="mb-3 flex flex-wrap items-end gap-4 rounded border bg-white p-2 text-sm">
        <div>
          <label className="block text-xs text-slate-500">Search</label>
          <input value={filters.search} onChange={(e) => updateFilters({ search: e.target.value })}
                 placeholder="Packing list #, BOL #, order #, customer code"
                 className="w-72 rounded border px-2 py-1" />
        </div>

        <div>
          <label className="block text-xs text-slate-500">Customer</label>
          <select value={filters.customerId} onChange={(e) => updateFilters({ customerId: e.target.value })}
                  disabled={!customersGate.allowed} title={customersGate.allowed ? undefined : customersGate.title}
                  className="rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
            <option value="">All customers</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-xs text-slate-500">Ship date</label>
          <div className="flex items-center gap-1">
            <input type="date" value={filters.from} onChange={(e) => updateFilters({ from: e.target.value })}
                   className="rounded border px-2 py-1" />
            <span>&ndash;</span>
            <input type="date" value={filters.to} onChange={(e) => updateFilters({ to: e.target.value })}
                   className="rounded border px-2 py-1" />
          </div>
        </div>

        <label className="flex items-center gap-1">
          <input type="checkbox" checked={filters.includeVoided}
                 onChange={(e) => updateFilters({ includeVoided: e.target.checked })} />
          Include voided
        </label>

        <a href={`/api/shippers/export${query ? `?${query}` : ""}`} className="text-blue-700 underline">
          Export to Excel
        </a>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full rounded border bg-white text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2">Packing List No</th>
              <th className="p-2">Customer</th>
              <th className="p-2">Ship Date</th>
              <th className="p-2">Orders</th>
              <th className="p-2">Carrier</th>
              <th className="p-2">Qty</th>
              <th className="p-2">Weight</th>
              <th className="p-2">Freight</th>
              <th className="p-2">BOL No</th>
              <th className="p-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="p-2 font-mono">
                  {/* The one path to an existing shipment for a shipping.view-only user (#48) —
                      the cert and order-hub shipment lists' own link shape. */}
                  <Link href={`/shipping/${r.id}`} className="text-blue-700 underline">{r.shipperNumber}</Link>
                </td>
                <td className="p-2">{r.customerCode} · {r.customerName}</td>
                <td className="p-2">{r.shipDate}</td>
                <td className="p-2">{r.orderLabels.join(", ")}</td>
                <td className="p-2">{r.carrierName ?? ""}</td>
                <td className="p-2">{r.totalQty}</td>
                <td className="p-2">{r.totalWeight}</td>
                <td className="p-2">{r.freightAmount ?? ""}</td>
                <td className="p-2 font-mono">{r.bolNumber ?? ""}</td>
                <td className="p-2">
                  {r.deletedAt && <span className="rounded bg-red-100 px-1 text-xs text-red-800">voided</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !error && (
              <tr><td colSpan={10} className="p-4 text-center text-slate-400">No shipments</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
