"use client";
// Turnaround report screen (Phase 8A Task 3, spec §4.2 / §12). Consumes GET /api/reports/turnaround
// (`reportTurnaround`, src/server/reports/turnaround.ts): average order-to-ship days over
// currently-SHIPPED orders, the completion date DERIVED from shipments (per-line earliest live
// complete shipDate; order = MAX). Filterable by completion-date range + customer + part and
// sliceable by customer / part / completion-month. A numeric table — no charts (§3 dashboard-graphs
// non-goal) — with an Excel export link that reuses the SAME query string as the fetch, so the table
// and the file can never disagree. Styling and the loaded/error discipline mirror ShippedReport.tsx.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { GateNotice } from "@/lib/report-ui";

// Local mirrors of src/server/reports/turnaround.ts's row types — NOT imported from src/server/**
// (CLAUDE.md "Constraints that will bite you": a client component pulling from there drags
// node:async_hooks and Prisma into the browser bundle).
type GroupBy = "none" | "customer" | "part" | "month";
type DetailRow = {
  orderId: string; orderNumber: number;
  customerCode: string; customerName: string;
  receivedDate: string; completionDate: string; turnaroundDays: number;
};
type GroupRow = { key: string; label: string; orderCount: number; avgDays: number; minDays: number; maxDays: number };
type TurnaroundResult =
  | { groupBy: "none"; rows: DetailRow[]; orderCount: number; avgDays: number }
  | { groupBy: "customer" | "part" | "month"; rows: GroupRow[]; orderCount: number; avgDays: number };

// Slices of CustomerRow / PartRow needed to populate the filter dropdowns — the id/code/name and
// id/partNumber/name the plain, active-only list endpoints already return.
type CustomerOption = { id: string; code: string; name: string };
type PartOption = { id: string; customerId: string; partNumber: string; name: string };

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "none", label: "Detail (per order)" },
  { value: "customer", label: "By customer" },
  { value: "part", label: "By part" },
  { value: "month", label: "By completion month" },
];

const GROUP_HEADER: Record<"customer" | "part" | "month", string> = {
  customer: "Customer", part: "Part", month: "Completion month",
};

const EMPTY: TurnaroundResult = { groupBy: "none", rows: [], orderCount: 0, avgDays: 0 };

export function TurnaroundReport() {
  const { permissions: perms, error: permsError } = usePermissions();
  const viewGate = gate(perms, "reports.view");
  const customersGate = gate(perms, "customers.view");
  const partsGate = gate(perms, "parts.view");

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [partId, setPartId] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");

  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [parts, setParts] = useState<PartOption[]>([]);
  const [result, setResult] = useState<TurnaroundResult>(EMPTY);
  // A `loaded` flag distinct from "the array is empty" (HANDOFF §5.15): a failed fetch must say so,
  // never render as a genuinely empty, healthy report.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allowed = viewGate.allowed;

  // ONE query string, reused for the JSON fetch AND the export link (the shared-parse invariant on
  // the client side — the routes share `parseTurnaroundFilter`, this shares the string that feeds it).
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (groupBy !== "none") p.set("groupBy", groupBy);
    if (customerId) p.set("customerId", customerId);
    if (partId) p.set("partId", partId);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return p.toString();
  }, [groupBy, customerId, partId, from, to]);

  const latest = useLatest();
  const load = useCallback(async () => {
    if (!allowed) return;
    const t = latest.next();
    let data: TurnaroundResult;
    try {
      data = await api<TurnaroundResult>(`/api/reports/turnaround${query ? `?${query}` : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) { setError((e as Error).message); setLoaded(true); }
      return;
    }
    if (!latest.isCurrent(t)) return;
    setResult(data);
    setError(null);
    setLoaded(true);
  }, [query, allowed, latest]);
  useEffect(() => { void load(); }, [load]);

  // Filter-dropdown options — fetched only once the caller holds the source area's view (§5.16: a
  // blocked control says why, never a silent-empty `.catch(() => {})`).
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers).catch((e) => setError((e as Error).message));
  }, [customersGate.allowed]);
  useEffect(() => {
    if (!partsGate.allowed) return;
    api<PartOption[]>("/api/parts").then(setParts).catch((e) => setError((e as Error).message));
  }, [partsGate.allowed]);

  // Parts are customer-scoped: when a customer is chosen, offer only its parts, and clear a part
  // selection that no longer belongs to the chosen customer.
  const partOptions = customerId ? parts.filter((p) => p.customerId === customerId) : parts;
  useEffect(() => {
    if (partId && !partOptions.some((p) => p.id === partId)) setPartId("");
  }, [partId, partOptions]);

  // §5.16 + Codex fix 2: distinguish a permissions-fetch FAILURE (retryable banner) from the initial
  // LOADING state from a genuine denial — a failed /api/auth/me must never read as "Requires
  // reports.view", which also hid the retryable banner behind this early return.
  if (permsError || perms === undefined || !viewGate.allowed) {
    return (
      <GateNotice
        header={<>
          <a href="/reports" className="text-sm text-blue-700 underline">← All reports</a>
          <h1 className="mb-4 mt-2 text-2xl font-semibold">Turnaround</h1>
        </>}
        permsError={permsError}
        loading={perms === undefined}
        deniedMessage={viewGate.title ?? "You do not have permission to view reports."}
      />
    );
  }

  const isDetail = result.groupBy === "none";
  const colCount = 5; // detail and grouped views both render 5 columns

  return (
    <div className="p-6">
      <a href="/reports" className="text-sm text-blue-700 underline">← All reports</a>
      <h1 className="mb-4 mt-2 text-2xl font-semibold">Turnaround</h1>
      <p className="mb-3 text-sm text-slate-500">Average order-to-ship days.</p>
      {error && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>
      )}

      <div className="mb-3 flex flex-wrap items-end gap-3 text-sm">
        <label className="block">
          Completed from
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                 className="mt-1 block rounded border px-2 py-1" />
        </label>
        <label className="block">
          Completed to
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                 className="mt-1 block rounded border px-2 py-1" />
        </label>
        <label className="block">
          Customer
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}
                  disabled={!customersGate.allowed} title={customersGate.allowed ? undefined : customersGate.title}
                  className="mt-1 block rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
            <option value="">All customers</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          Part
          <select value={partId} onChange={(e) => setPartId(e.target.value)}
                  disabled={!partsGate.allowed} title={partsGate.allowed ? undefined : partsGate.title}
                  className="mt-1 block rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
            <option value="">All parts</option>
            {partOptions.map((p) => (
              <option key={p.id} value={p.id}>{p.partNumber}{p.name ? ` · ${p.name}` : ""}</option>
            ))}
          </select>
        </label>
        <label className="block">
          Group by
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}
                  className="mt-1 block rounded border px-2 py-1">
            {GROUP_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <a href={`/api/reports/turnaround/export${query ? `?${query}` : ""}`} className="text-blue-700 underline">
          Export to Excel
        </a>
      </div>

      {loaded && !error && (
        <p className="mb-3 text-sm text-slate-600">
          Average turnaround: <span className="font-medium">{result.avgDays.toFixed(1)}</span> days
          {" "}over <span className="font-medium">{result.orderCount}</span>{" "}
          {result.orderCount === 1 ? "order" : "orders"}.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full rounded border bg-white text-sm">
          <thead>
            <tr className="border-b text-left">
              {isDetail ? (
                <>
                  <th className="p-2">Order</th>
                  <th className="p-2">Customer</th>
                  <th className="p-2">Received</th>
                  <th className="p-2">Completed</th>
                  <th className="p-2 text-right">Turnaround (days)</th>
                </>
              ) : (
                <>
                  <th className="p-2">{GROUP_HEADER[result.groupBy]}</th>
                  <th className="p-2 text-right">Orders</th>
                  <th className="p-2 text-right">Avg days</th>
                  <th className="p-2 text-right">Min</th>
                  <th className="p-2 text-right">Max</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {result.groupBy === "none" && result.rows.map((r) => (
              <tr key={r.orderId} className="border-t">
                <td className="p-2">{r.orderNumber}</td>
                <td className="p-2">{r.customerCode} · {r.customerName}</td>
                <td className="p-2">{r.receivedDate}</td>
                <td className="p-2">{r.completionDate}</td>
                <td className="p-2 text-right">{r.turnaroundDays}</td>
              </tr>
            ))}
            {result.groupBy !== "none" && result.rows.map((r) => (
              <tr key={r.key} className="border-t">
                <td className="p-2">{r.label}</td>
                <td className="p-2 text-right">{r.orderCount}</td>
                <td className="p-2 text-right">{r.avgDays.toFixed(1)}</td>
                <td className="p-2 text-right">{r.minDays}</td>
                <td className="p-2 text-right">{r.maxDays}</td>
              </tr>
            ))}
            {result.rows.length === 0 && loaded && !error && (
              <tr>
                <td colSpan={colCount} className="p-4 text-center text-slate-400">No completed orders in range</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
