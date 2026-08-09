"use client";
// A/R aging report screen (design spec §11 "reports … A/R aging (as-of)"; task-14-brief.md
// Step 1). Consumes Task 10's `GET /api/receivables/aging` (`agingReport`, src/server/aging.ts):
// an as-of date + an optional customer/family filter, a table of `AgingRow`s (the five buckets +
// Unapplied + Net), a totals footer, and an Excel export link mirroring the
// `parts/page.tsx`/`customers/page.tsx` "Export to Excel" `<a href>` precedent. Styling reuses
// those same list pages — no new component framework.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { AGING_BUCKETS, AGING_BUCKET_LABELS, AGING_MONEY_FIELDS, isAgingRowAllZero, type AgingBucketValue } from "@/lib/ar-constants";
import { formatDateOnly, todayDateOnly } from "@/lib/business-days";
import { ReceivablesNav } from "../ReceivablesNav";

// Local mirror of src/server/aging.ts's `AgingRow` — not imported from src/server/** (CLAUDE.md
// "Constraints that will bite you": a client component pulling from there drags node:async_hooks
// and Prisma into the browser bundle).
type AgingRow = {
  customerId: string; customerCode: string; customerName: string;
  current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number;
  unapplied: number; net: number;
  // Set only on a parent-family roll-up's synthesized family-TOTAL row (src/server/aging.ts) — it
  // already sums parent + every child, so it is used AS the footer rather than summed alongside the
  // child rows it contains.
  isFamilyTotal?: boolean;
};

// Slice of CustomerRow needed to populate the customer/family filter — the parts.tsx/
// BatchDetail.tsx `CustomerOption` precedent (id/code/name only, fetched from the plain,
// active-only `/api/customers`).
type CustomerOption = { id: string; code: string; name: string };

type MoneyBucketKey = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";
const BUCKET_FIELD: Record<AgingBucketValue, MoneyBucketKey> = {
  CURRENT: "current", D1_30: "d1_30", D31_60: "d31_60", D61_90: "d61_90", D90_PLUS: "d90_plus",
};

// The all-zero-row filter (`isAgingRowAllZero`) and the money-field list (`AGING_MONEY_FIELDS`)
// are shared from ar-constants.ts so this screen and the Excel export apply the SAME rule (the
// export route filters with the same predicate — they can't drift). DISPLAY-SIDE ONLY;
// `agingReport` itself is untouched.
const ZERO_TOTALS: Record<MoneyBucketKey | "unapplied" | "net", number> = {
  current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, unapplied: 0, net: 0,
};

export function AgingReport() {
  const { permissions: perms, error: permsError } = usePermissions();
  const viewGate = gate(perms, "receivables.view");
  const customersGate = gate(perms, "customers.view");

  const [asOf, setAsOf] = useState(() => formatDateOnly(todayDateOnly()));
  const [customerId, setCustomerId] = useState("");
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [rows, setRows] = useState<AgingRow[]>([]);
  // A `loaded` flag distinct from "the array is empty" (HANDOFF §5.15): a failed fetch must say
  // so, never render as a genuinely empty, healthy report.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allowed = viewGate.allowed;
  const query = `asOf=${encodeURIComponent(asOf)}${customerId ? `&customerId=${encodeURIComponent(customerId)}` : ""}`;

  // Named `latest`, not `gate` — this file also imports `gate` from permission-ui for the
  // held-permission checks above, and shadowing that binding with the stale-response gate would
  // break every `gate(perms, ...)` call here (ReceivablesList.tsx / CustomersPage precedent).
  const latest = useLatest();
  const load = useCallback(async () => {
    if (!allowed) return;
    const t = latest.next();
    let data: AgingRow[];
    try {
      data = await api<AgingRow[]>(`/api/receivables/aging?${query}`);
    } catch (e) {
      if (latest.isCurrent(t)) { setError((e as Error).message); setLoaded(true); }
      return;
    }
    if (!latest.isCurrent(t)) return;
    setRows(data);
    setError(null);
    setLoaded(true);
  }, [query, allowed, latest]);
  useEffect(() => { void load(); }, [load]);

  // Customer/family filter options — fetched only once the caller is known to hold
  // customers.view (§5.16: a blocked control must say why, not just refuse silently), never
  // left in a `.catch(() => {})` silent-empty state — a failed fetch surfaces through `error`,
  // same as the aging fetch itself.
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers).catch((e) => setError((e as Error).message));
  }, [customersGate.allowed]);

  // §5.16: a caller without receivables.view sees the page saying why, never a silently empty one.
  if (!viewGate.allowed) {
    return (
      <div className="p-6">
        <ReceivablesNav />
        <h1 className="mb-4 text-2xl font-semibold">A/R Aging</h1>
        <p className="text-sm text-slate-500">{viewGate.title ?? "You do not have permission to view A/R aging."}</p>
      </div>
    );
  }

  const visibleRows = rows.filter((r) => !isAgingRowAllZero(r));
  // A parent-family roll-up returns per-child rows PLUS a synthesized family-total row that already
  // sums parent + every child (src/server/aging.ts). Summing every visible row would double-count,
  // so the family-total row is pulled out and used AS the footer; the child rows render on their
  // own, and any other view (standalone/unfiltered) has no family-total row and sums its leaf rows.
  const familyTotalRow = visibleRows.find((r) => r.isFamilyTotal) ?? null;
  const leafRows = visibleRows.filter((r) => !r.isFamilyTotal);
  const totals: Record<MoneyBucketKey | "unapplied" | "net", number> = familyTotalRow ?? leafRows.reduce((sum, r) => {
    const next = { ...sum };
    for (const k of AGING_MONEY_FIELDS) next[k] = sum[k] + r[k];
    return next;
  }, { ...ZERO_TOTALS });

  return (
    <div className="p-6">
      <ReceivablesNav />
      <h1 className="mb-4 text-2xl font-semibold">A/R Aging</h1>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}

      <div className="mb-3 flex flex-wrap items-end gap-3 text-sm">
        <label className="block">
          As of
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
                 className="mt-1 block rounded border px-2 py-1" />
        </label>
        <label className="block">
          Customer / family
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}
                  disabled={!customersGate.allowed} title={customersGate.allowed ? undefined : customersGate.title}
                  className="mt-1 block rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
            <option value="">All customers</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
            ))}
          </select>
        </label>
        <a href={`/api/receivables/aging/export?${query}`} className="text-blue-700 underline">
          Export to Excel
        </a>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full rounded border bg-white text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2">Customer</th>
              {AGING_BUCKETS.map((b) => (
                <th key={b} className="p-2 text-right">{AGING_BUCKET_LABELS[b]}</th>
              ))}
              <th className="p-2 text-right">Unapplied</th>
              <th className="p-2 text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {leafRows.map((r) => (
              <tr key={r.customerId} className="border-t">
                <td className="p-2">{r.customerCode} · {r.customerName}</td>
                {AGING_BUCKETS.map((b) => (
                  <td key={b} className="p-2 text-right">{r[BUCKET_FIELD[b]].toFixed(2)}</td>
                ))}
                <td className="p-2 text-right">{r.unapplied.toFixed(2)}</td>
                <td className="p-2 text-right">{r.net.toFixed(2)}</td>
              </tr>
            ))}
            {visibleRows.length === 0 && loaded && !error && (
              <tr>
                <td colSpan={AGING_BUCKETS.length + 3} className="p-4 text-center text-slate-400">
                  No aging activity
                </td>
              </tr>
            )}
          </tbody>
          {visibleRows.length > 0 && (
            <tfoot>
              {/* When a family-total row is present it IS the footer (already sums parent + every
                  child), labeled distinctly; otherwise the footer is the sum of the leaf rows. */}
              <tr className="border-t bg-slate-50 font-medium">
                <td className="p-2">{familyTotalRow ? "Family total" : "Total"}</td>
                {AGING_BUCKETS.map((b) => (
                  <td key={b} className="p-2 text-right">{totals[BUCKET_FIELD[b]].toFixed(2)}</td>
                ))}
                <td className="p-2 text-right">{totals.unapplied.toFixed(2)}</td>
                <td className="p-2 text-right">{totals.net.toFixed(2)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
