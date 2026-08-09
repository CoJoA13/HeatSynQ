"use client";
// The customer page's A/R section (design spec §11; task-15-brief.md Step 2). The order-hub
// `InvoicesSection.tsx` precedent: fetch-into-state on mount, a `loaded` flag distinct from "the
// array is empty" (HANDOFF §5.15), ticket-gated on both the success and the rejection path
// (`useLatest`). Its data source is `GET /api/customers/[id]/receivables` (this task's own new
// route), which composes Task 10's `agingReport` and Task 13's `openInvoicesForPayer` — no balance
// math lives here either.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { useLatest } from "@/lib/use-latest";
import { AGING_BUCKETS, AGING_BUCKET_LABELS, type AgingBucketValue } from "@/lib/ar-constants";

// Local mirrors of src/server/aging.ts's `AgingRow` and src/server/applications.ts's
// `OpenInvoiceRow` — not imported from src/server/** (CLAUDE.md: a client component pulling from
// there drags node:async_hooks and Prisma into the browser bundle). Composed by
// src/server/customer-receivables.ts's `CustomerReceivablesSummary`.
type AgingRow = {
  customerId: string; customerCode: string; customerName: string;
  current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number;
  unapplied: number; net: number;
};
type OpenInvoiceRow = {
  id: string; orderId: string; orderNumber: number; documentNumber: string;
  customerId: string; customerCode: string; customerName: string;
  invoiceDate: string; dueDate: string | null; total: number; open: number;
};
type ReceivablesSummary = { aging: AgingRow; openItems: OpenInvoiceRow[] };

type MoneyBucketKey = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";
const BUCKET_FIELD: Record<AgingBucketValue, MoneyBucketKey> = {
  CURRENT: "current", D1_30: "d1_30", D31_60: "d31_60", D61_90: "d61_90", D90_PLUS: "d90_plus",
};

export function ReceivablesSection({ customerId, viewGate }: { customerId: string; viewGate: Gate }) {
  const [summary, setSummary] = useState<ReceivablesSummary | null>(null);
  // A `loaded` flag distinct from "no summary yet" — a failed fetch must say so, never render as
  // a genuinely empty, healthy zero-balance customer (HANDOFF §5.15 / InvoicesSection.tsx's own
  // `loaded` precedent).
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allowed = viewGate.allowed;
  const latest = useLatest();
  const load = useCallback(async () => {
    if (!allowed) return;
    const t = latest.next();
    let data: ReceivablesSummary;
    try {
      data = await api<ReceivablesSummary>(`/api/customers/${customerId}/receivables`);
    } catch (e) {
      if (latest.isCurrent(t)) { setError((e as Error).message); setLoaded(true); }
      return;
    }
    if (!latest.isCurrent(t)) return;
    setSummary(data);
    setError(null);
    setLoaded(true);
  }, [customerId, allowed, latest]);
  useEffect(() => { void load(); }, [load]);

  // §5.16: a caller without receivables.view sees the section saying why, never a silently empty one.
  if (!viewGate.allowed) {
    return (
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Receivables</h2>
        <p className="text-sm text-slate-500">{viewGate.title ?? "You do not have permission to view receivables."}</p>
      </section>
    );
  }

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">Receivables</h2>
        <div className="flex items-center gap-3 text-sm">
          <Link href={`/receivables/statements?customerId=${customerId}`} className="text-blue-700 underline">
            Statement
          </Link>
          {/* Applying a payment happens inside the batch it was entered against (BatchDetail.tsx's
              own per-payment Apply panel) — there is no per-customer apply screen to deep-link
              into, so this lands on the batch worklist, the entry point for that flow. */}
          <Link href="/receivables" className="text-blue-700 underline">
            Apply payment
          </Link>
        </div>
      </div>

      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}

      {loaded && !error && summary && (
        <>
          <p className="mb-2 text-sm">
            Net balance: <span className="font-medium">{summary.aging.net.toFixed(2)}</span>
          </p>

          <div className="mb-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500">
                  {AGING_BUCKETS.map((b) => (
                    <th key={b} className="p-1 text-right font-medium">{AGING_BUCKET_LABELS[b]}</th>
                  ))}
                  <th className="p-1 text-right font-medium">Unapplied</th>
                  <th className="p-1 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  {AGING_BUCKETS.map((b) => (
                    <td key={b} className="p-1 text-right">{summary.aging[BUCKET_FIELD[b]].toFixed(2)}</td>
                  ))}
                  <td className="p-1 text-right">{summary.aging.unapplied.toFixed(2)}</td>
                  <td className="p-1 text-right font-medium">{summary.aging.net.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h3 className="mb-1 text-sm font-medium text-slate-600">Open items</h3>
          {summary.openItems.length === 0 ? (
            <p className="text-sm text-slate-500">No open invoices.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="py-1 font-medium">Document</th>
                  <th className="font-medium">Invoice date</th>
                  <th className="font-medium">Due date</th>
                  <th className="font-medium">Total</th>
                  <th className="font-medium">Open</th>
                </tr>
              </thead>
              <tbody>
                {summary.openItems.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="py-1 font-mono">
                      <Link href={`/invoicing/${r.id}`} className="text-blue-700 underline">{r.documentNumber}</Link>
                    </td>
                    <td>{r.invoiceDate}</td>
                    <td>{r.dueDate ?? "—"}</td>
                    <td>{r.total.toFixed(2)}</td>
                    <td>{r.open.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
