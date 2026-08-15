"use client";
// Sales report screen (Phase 8A Task 4, spec §4.2/§8). Consumes GET /api/reports/sales
// (`reportSales`, src/server/reports/sales.ts): invoiced revenue EXCLUDING sales tax, net of
// credits, recognized by `finalizedAt` over a half-open window, filterable by finalized-date range +
// customer and sliceable by customer / finalized-month / part. A numeric table — no charts (§3
// dashboard-graphs non-goal) — with an Excel export link that reuses the SAME query string as the
// fetch, so the table and the file can never disagree. Styling and the loaded/error discipline
// mirror ShippedReport.tsx.
//
// There is deliberately NO part filter: the Sales report reads the FROZEN part-number snapshot, and
// filtering by a live part would need a live join the frozen-paper rule forbids (a renamed part
// would silently drop the sales it earned under its old number). Part is a groupBy dimension only.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { GateNotice, ExportLink } from "@/lib/report-ui";
import { exportState } from "@/lib/report-export-state";

// Local mirrors of src/server/reports/sales.ts's row types — NOT imported from src/server/**
// (CLAUDE.md "Constraints that will bite you": a client component pulling from there drags
// node:async_hooks and Prisma into the browser bundle).
type GroupBy = "none" | "customer" | "part" | "month";
type Kind = "INVOICE" | "CREDIT";
type DetailRow = {
  invoiceId: string; documentNumber: string; kind: Kind;
  customerCode: string; customerName: string; finalizedDate: string; revenue: number;
};
type GroupRow = { key: string; label: string; invoiceCount: number; revenue: number };
type SalesResult =
  | { groupBy: "none"; rows: DetailRow[]; total: number; invoiceCount: number }
  | { groupBy: "customer" | "part" | "month"; rows: GroupRow[]; total: number; invoiceCount: number };

// Slice of CustomerRow needed to populate the filter dropdown.
type CustomerOption = { id: string; code: string; name: string };

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "none", label: "Detail (per document)" },
  { value: "customer", label: "By customer" },
  { value: "part", label: "By part" },
  { value: "month", label: "By finalized month" },
];

const GROUP_HEADER: Record<"customer" | "part" | "month", string> = {
  customer: "Customer", part: "Part", month: "Finalized month",
};

const KIND_LABEL: Record<Kind, string> = { INVOICE: "Invoice", CREDIT: "Credit" };

export function SalesReport() {
  const { permissions: perms, error: permsError } = usePermissions();
  const viewGate = gate(perms, "reports.view");
  const customersGate = gate(perms, "customers.view");

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");

  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [result, setResult] = useState<SalesResult>({ groupBy: "none", rows: [], total: 0, invoiceCount: 0 });
  // A `loaded` flag distinct from "the array is empty" (HANDOFF §5.15): a failed fetch must say so,
  // never render as a genuinely empty, healthy report.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Codex fix 3: option-fetch failures live in their OWN state. The report load()'s setError(null)
  // on success must not erase a customer options failure — that would leave a silently truncated
  // dropdown (only "All customers") with no explanation. The banner shows either.
  const [optionsError, setOptionsError] = useState<string | null>(null);
  // Codex fixes 5 & 6: the query string of the CURRENTLY-DISPLAYED result, or `null` until the FIRST
  // successful load (a failed load must NOT enable Export — a "" init would collide with the default
  // empty query). Set to `query` only on success (never on failure); the Export link is built from
  // THIS, never the live filter state, so a stale/failed reload keeps it pinned to the shown data.
  const [appliedQuery, setAppliedQuery] = useState<string | null>(null);

  const allowed = viewGate.allowed;

  // ONE query string, reused for the JSON fetch AND the export link (the shared-parse invariant on
  // the client side — the routes share `parseSalesFilter`, this shares the string that feeds it).
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (groupBy !== "none") p.set("groupBy", groupBy);
    if (customerId) p.set("customerId", customerId);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return p.toString();
  }, [groupBy, customerId, from, to]);

  const latest = useLatest();
  const load = useCallback(async () => {
    if (!allowed) return;
    const t = latest.next();
    let data: SalesResult;
    try {
      data = await api<SalesResult>(`/api/reports/sales${query ? `?${query}` : ""}`);
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

  // Filter-dropdown options — fetched only once the caller holds customers.view (§5.16: a blocked
  // control says why, never a silent-empty `.catch(() => {})`). Codex fix 4: `includeInactive=1` — the
  // list service defaults to `active: true`, so an inactive-but-LIVE customer whose historical
  // invoices still appear in the report would otherwise be un-selectable. Still `deletedAt: null`.
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers?includeInactive=1").then(setCustomers).catch((e) => setOptionsError((e as Error).message));
  }, [customersGate.allowed]);

  // §5.16 + Codex fix 2: distinguish a permissions-fetch FAILURE (retryable banner) from the initial
  // LOADING state from a genuine denial — a failed /api/auth/me must never read as "Requires
  // reports.view", which also hid the retryable banner behind this early return.
  if (permsError || perms === undefined || !viewGate.allowed) {
    return (
      <GateNotice
        header={<>
          <a href="/reports" className="text-sm text-blue-700 underline">← All reports</a>
          <h1 className="mb-4 mt-2 text-2xl font-semibold">Sales</h1>
        </>}
        permsError={permsError}
        loading={perms === undefined}
        deniedMessage={viewGate.title ?? "You do not have permission to view reports."}
      />
    );
  }

  const isDetail = result.groupBy === "none";
  // Export is live only once a load has SUCCEEDED (appliedQuery non-null); the table shows stale data
  // while a reload is behind the current filters. See report-export-state.ts (Codex fixes 5 & 6).
  const { exportable, showingStale } = exportState(appliedQuery, query);

  return (
    <div className="p-6">
      <a href="/reports" className="text-sm text-blue-700 underline">← All reports</a>
      <h1 className="mb-4 mt-2 text-2xl font-semibold">Sales</h1>
      <p className="mb-3 text-sm text-slate-500">Invoiced revenue (ex-tax), by customer/part/month.</p>
      {(error ?? optionsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? optionsError}</p>
      )}

      <div className="mb-3 flex flex-wrap items-end gap-3 text-sm">
        <label className="block">
          Finalized from
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                 className="mt-1 block rounded border px-2 py-1" />
        </label>
        <label className="block">
          Finalized to
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
          Group by
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}
                  className="mt-1 block rounded border px-2 py-1">
            {GROUP_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <ExportLink base="/api/reports/sales/export" query={appliedQuery} ready={exportable} />
        {showingStale && <span className="text-xs text-slate-400">Updating…</span>}
      </div>

      <p className="mb-2 text-sm text-slate-600">
        {result.invoiceCount} document{result.invoiceCount === 1 ? "" : "s"} · net revenue{" "}
        <span className="font-medium">{result.total.toFixed(2)}</span> (ex-tax)
      </p>

      <div className={`overflow-x-auto ${showingStale ? "opacity-60" : ""}`}>
        <table className="w-full rounded border bg-white text-sm">
          <thead>
            <tr className="border-b text-left">
              {isDetail ? (
                <>
                  <th className="p-2">Document</th>
                  <th className="p-2">Type</th>
                  <th className="p-2">Customer</th>
                  <th className="p-2">Finalized</th>
                  <th className="p-2 text-right">Revenue (ex-tax)</th>
                </>
              ) : (
                <>
                  <th className="p-2">{GROUP_HEADER[result.groupBy]}</th>
                  <th className="p-2 text-right">Documents</th>
                  <th className="p-2 text-right">Revenue (ex-tax)</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {result.groupBy === "none" && result.rows.map((r) => (
              <tr key={r.invoiceId} className="border-t">
                <td className="p-2">{r.documentNumber}</td>
                <td className="p-2">{KIND_LABEL[r.kind]}</td>
                <td className="p-2">{r.customerCode} · {r.customerName}</td>
                <td className="p-2">{r.finalizedDate}</td>
                <td className="p-2 text-right">{r.revenue.toFixed(2)}</td>
              </tr>
            ))}
            {result.groupBy !== "none" && result.rows.map((r) => (
              <tr key={r.key} className="border-t">
                <td className="p-2">{r.label}</td>
                <td className="p-2 text-right">{r.invoiceCount}</td>
                <td className="p-2 text-right">{r.revenue.toFixed(2)}</td>
              </tr>
            ))}
            {result.rows.length === 0 && loaded && !error && (
              <tr>
                <td colSpan={isDetail ? 5 : 3} className="p-4 text-center text-slate-400">No invoiced revenue in range</td>
              </tr>
            )}
          </tbody>
          {result.rows.length > 0 && (
            <tfoot>
              <tr className="border-t bg-slate-50 font-medium">
                {isDetail ? (
                  <>
                    <td className="p-2" colSpan={4}>Total</td>
                    <td className="p-2 text-right">{result.total.toFixed(2)}</td>
                  </>
                ) : (
                  <>
                    <td className="p-2">Total</td>
                    <td className="p-2"></td>
                    <td className="p-2 text-right">{result.total.toFixed(2)}</td>
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
