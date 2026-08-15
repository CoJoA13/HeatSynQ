"use client";
// Shipped report screen (Phase 8A Task 2, spec §4.2). Consumes GET /api/reports/shipped
// (`reportShipped`, src/server/reports/shipped.ts): actual shipped volume windowed on
// Shipper.shipDate, filterable by ship-date range + customer + part and sliceable by
// customer / part / ship-month / day. A numeric table — no charts (§3 dashboard-graphs non-goal) —
// with an Excel export link that reuses the SAME query string as the fetch, so the table and the
// file can never disagree. Styling and the loaded/error discipline mirror BacklogReport.tsx.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { GateNotice, ExportLink } from "@/lib/report-ui";
import { exportState } from "@/lib/report-export-state";

// Local mirrors of src/server/reports/shipped.ts's row types — NOT imported from src/server/**
// (CLAUDE.md "Constraints that will bite you": a client component pulling from there drags
// node:async_hooks and Prisma into the browser bundle).
type GroupBy = "none" | "customer" | "part" | "month" | "day";
type DetailRow = {
  shipperId: string; shipperLineId: string; shipperNumber: number; shipDate: string;
  customerCode: string; customerName: string;
  partNumber: string; partName: string; qty: number; weight: number;
};
type GroupRow = { key: string; label: string; shipmentCount: number; qty: number; weight: number };
type ShippedResult =
  | { groupBy: "none"; rows: DetailRow[] }
  | { groupBy: "customer" | "part" | "month" | "day"; rows: GroupRow[] };

// Slices of CustomerRow / PartRow needed to populate the filter dropdowns — the id/code/name and
// id/partNumber/name the plain, active-only list endpoints already return.
type CustomerOption = { id: string; code: string; name: string };
type PartOption = { id: string; customerId: string; partNumber: string; name: string };

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "none", label: "Detail (per line)" },
  { value: "customer", label: "By customer" },
  { value: "part", label: "By part" },
  { value: "month", label: "By ship month" },
  { value: "day", label: "By ship day" },
];

const GROUP_HEADER: Record<"customer" | "part" | "month" | "day", string> = {
  customer: "Customer", part: "Part", month: "Ship month", day: "Ship day",
};

export function ShippedReport() {
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
  const [result, setResult] = useState<ShippedResult>({ groupBy: "none", rows: [] });
  // A `loaded` flag distinct from "the array is empty" (HANDOFF §5.15): a failed fetch must say so,
  // never render as a genuinely empty, healthy report.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Codex fix 3: option-fetch failures live in their OWN state. The report load()'s setError(null)
  // on success must not erase a customer/part options failure — that would leave a silently
  // truncated dropdown (only "All …") with no explanation. The banner shows either.
  const [optionsError, setOptionsError] = useState<string | null>(null);
  // Codex fixes 5 & 6: the query string of the CURRENTLY-DISPLAYED result, or `null` until the FIRST
  // successful load (a failed load must NOT enable Export — a "" init would collide with the default
  // empty query). Set to `query` only on success (never on failure); the Export link is built from
  // THIS, never the live filter state, so a stale/failed reload keeps it pinned to the shown data.
  const [appliedQuery, setAppliedQuery] = useState<string | null>(null);

  const allowed = viewGate.allowed;

  // ONE query string, reused for the JSON fetch AND the export link (the shared-parse invariant on
  // the client side — the routes share `parseShippedFilter`, this shares the string that feeds it).
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
    let data: ShippedResult;
    try {
      data = await api<ShippedResult>(`/api/reports/shipped${query ? `?${query}` : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) { setError((e as Error).message); setLoaded(true); }
      return;
    }
    if (!latest.isCurrent(t)) return;
    setResult(data);
    setAppliedQuery(query);
    setError(null);
    setLoaded(true);
  }, [query, allowed, latest]);
  useEffect(() => { void load(); }, [load]);

  // Filter-dropdown options — fetched only once the caller holds the source area's view (§5.16: a
  // blocked control says why, never a silent-empty `.catch(() => {})`). Codex fix 4: `includeInactive=1`
  // — the list services default to `active: true`, so an inactive-but-LIVE customer/part whose
  // historical rows still appear in the report would otherwise be un-selectable in the filter. Still
  // `deletedAt: null` (live only); the customer/part admin pages pass the same flag.
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers?includeInactive=1").then(setCustomers).catch((e) => setOptionsError((e as Error).message));
  }, [customersGate.allowed]);
  useEffect(() => {
    if (!partsGate.allowed) return;
    api<PartOption[]>("/api/parts?includeInactive=1").then(setParts).catch((e) => setOptionsError((e as Error).message));
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
          <h1 className="mb-4 mt-2 text-2xl font-semibold">Shipped</h1>
        </>}
        permsError={permsError}
        loading={perms === undefined}
        deniedMessage={viewGate.title ?? "You do not have permission to view reports."}
      />
    );
  }

  const totalQty = result.rows.reduce((s, r) => s + r.qty, 0);
  const totalWeight = result.rows.reduce((s, r) => s + r.weight, 0);
  const isDetail = result.groupBy === "none";
  const colCount = isDetail ? 6 : 4;
  // Export is live only once a load has SUCCEEDED (appliedQuery non-null); the table shows stale data
  // while a reload is behind the current filters. See report-export-state.ts (Codex fixes 5 & 6).
  const { exportable, showingStale } = exportState(appliedQuery, query);

  return (
    <div className="p-6">
      <a href="/reports" className="text-sm text-blue-700 underline">← All reports</a>
      <h1 className="mb-4 mt-2 text-2xl font-semibold">Shipped</h1>
      <p className="mb-3 text-sm text-slate-500">Shipped quantity and weight by period.</p>
      {(error ?? optionsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? optionsError}</p>
      )}

      <div className="mb-3 flex flex-wrap items-end gap-3 text-sm">
        <label className="block">
          Ship from
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                 className="mt-1 block rounded border px-2 py-1" />
        </label>
        <label className="block">
          Ship to
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
        <ExportLink base="/api/reports/shipped/export" query={appliedQuery} ready={exportable} />
        {showingStale && <span className="text-xs text-slate-400">Updating…</span>}
      </div>

      <div className={`overflow-x-auto ${showingStale ? "opacity-60" : ""}`}>
        <table className="w-full rounded border bg-white text-sm">
          <thead>
            <tr className="border-b text-left">
              {isDetail ? (
                <>
                  <th className="p-2">Shipper</th>
                  <th className="p-2">Ship date</th>
                  <th className="p-2">Customer</th>
                  <th className="p-2">Part</th>
                  <th className="p-2 text-right">Qty shipped</th>
                  <th className="p-2 text-right">Weight shipped</th>
                </>
              ) : (
                <>
                  <th className="p-2">{GROUP_HEADER[result.groupBy]}</th>
                  <th className="p-2 text-right">Shipments</th>
                  <th className="p-2 text-right">Qty shipped</th>
                  <th className="p-2 text-right">Weight shipped</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {result.groupBy === "none" && result.rows.map((r) => (
              <tr key={r.shipperLineId} className="border-t">
                <td className="p-2">{r.shipperNumber}</td>
                <td className="p-2">{r.shipDate}</td>
                <td className="p-2">{r.customerCode} · {r.customerName}</td>
                <td className="p-2">{r.partNumber}{r.partName ? ` · ${r.partName}` : ""}</td>
                <td className="p-2 text-right">{r.qty}</td>
                <td className="p-2 text-right">{r.weight.toFixed(2)}</td>
              </tr>
            ))}
            {result.groupBy !== "none" && result.rows.map((r) => (
              <tr key={r.key} className="border-t">
                <td className="p-2">{r.label}</td>
                <td className="p-2 text-right">{r.shipmentCount}</td>
                <td className="p-2 text-right">{r.qty}</td>
                <td className="p-2 text-right">{r.weight.toFixed(2)}</td>
              </tr>
            ))}
            {result.rows.length === 0 && loaded && !error && (
              <tr>
                <td colSpan={colCount} className="p-4 text-center text-slate-400">Nothing shipped in range</td>
              </tr>
            )}
          </tbody>
          {result.rows.length > 0 && (
            <tfoot>
              <tr className="border-t bg-slate-50 font-medium">
                {isDetail ? (
                  <>
                    <td className="p-2" colSpan={4}>Total</td>
                    <td className="p-2 text-right">{totalQty}</td>
                    <td className="p-2 text-right">{totalWeight.toFixed(2)}</td>
                  </>
                ) : (
                  <>
                    <td className="p-2">Total</td>
                    <td className="p-2"></td>
                    <td className="p-2 text-right">{totalQty}</td>
                    <td className="p-2 text-right">{totalWeight.toFixed(2)}</td>
                  </>
                )}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
