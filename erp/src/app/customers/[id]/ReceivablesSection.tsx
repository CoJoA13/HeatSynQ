"use client";
// The customer page's A/R section (design spec §11; task-15-brief.md Step 2). The order-hub
// `InvoicesSection.tsx` precedent: fetch-into-state on mount, a `loaded` flag distinct from "the
// array is empty" (HANDOFF §5.15), ticket-gated on both the success and the rejection path
// (`useLatest`). Its data source is `GET /api/customers/[id]/receivables` (this task's own new
// route), which composes the SINGLE-customer `customerOwnAgingRow` (aging.ts) and
// `openItemsForCustomer` (applications.ts) via `customer-receivables.ts` — never the
// family-scoped `agingReport`/`openInvoicesForPayer`, whose payer-family rollup would leak a
// division's siblings into this one customer's section (Task 15 fix). No balance math lives here.
//
// The open-items table lists all THREE kinds since #83 — invoices, open credit memos, and
// on-account cash, the last two negative — so the rows sum to the Net printed above them. Before
// that a customer holding only a credit read a negative net over the words "No open invoices".
// Applying a credit happens here too (#75, owner ruling 2026-08-17): this is the one screen showing
// a credit and the invoices it could pay down side by side.
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
type OpenItemKind = "INVOICE" | "CREDIT" | "PAYMENT";
type CustomerOpenItem = {
  kind: OpenItemKind; id: string; documentNumber: string;
  date: string; dueDate: string | null; original: number; open: number;
};
type ReceivablesSummary = { aging: AgingRow; openItems: CustomerOpenItem[] };

const KIND_LABEL: Record<OpenItemKind, string> = {
  INVOICE: "Invoice", CREDIT: "Credit", PAYMENT: "On account",
};

type MoneyBucketKey = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";
const BUCKET_FIELD: Record<AgingBucketValue, MoneyBucketKey> = {
  CURRENT: "current", D1_30: "d1_30", D31_60: "d31_60", D61_90: "d61_90", D90_PLUS: "d90_plus",
};

export function ReceivablesSection(
  { customerId, viewGate, applyGate }: { customerId: string; viewGate: Gate; applyGate: Gate },
) {
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

  // Computed ONCE rather than per row — every credit row needs the same list of invoices it could
  // be applied to.
  const openInvoices = (summary?.openItems ?? []).filter((i) => i.kind === "INVOICE");

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
            <p className="text-sm text-slate-500">Nothing open — this customer is settled.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="py-1 font-medium">Document</th>
                  <th className="font-medium">Type</th>
                  <th className="font-medium">Date</th>
                  <th className="font-medium">Due date</th>
                  <th className="font-medium">Original</th>
                  <th className="font-medium">Open</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {summary.openItems.map((r) => (
                  <OpenItemRow
                    key={`${r.kind}-${r.id}`}
                    item={r}
                    invoices={openInvoices}
                    applyGate={applyGate}
                    onApplied={() => void load()}
                    onError={setError}
                  />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

/** One open item. A CREDIT with remaining balance carries the Apply control (#75): the credit and
 *  the invoices it can pay down are both on this screen, so applying is a two-field act rather than
 *  a trip to another page. An on-account PAYMENT has no document page to link to, and is applied
 *  through its receipt batch (`BatchDetail.tsx`), which is a different flow. */
function OpenItemRow({ item, invoices, applyGate, onApplied, onError }: {
  item: CustomerOpenItem;
  invoices: CustomerOpenItem[];
  applyGate: Gate;
  onApplied: () => void;
  onError: (message: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);

  const remaining = Math.abs(item.open);
  const canApply = item.kind === "CREDIT" && invoices.length > 0;

  function start() {
    // Default to the OLDEST open invoice and the smaller of the two balances — the applying an
    // operator would otherwise type by hand, and never an amount the save would refuse.
    const first = invoices[0];
    setInvoiceId(first.id);
    setAmount(Math.min(remaining, first.open).toFixed(2));
    setOpen(true);
    onError(null);
  }

  async function submit() {
    setSaving(true);
    try {
      await api("/api/receivables/credit-applications", {
        method: "POST",
        body: JSON.stringify({ creditInvoiceId: item.id, invoiceId, amount: Number(amount) }),
      });
      setOpen(false);
      onApplied();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <tr className="border-t">
        <td className="py-1 font-mono">
          {item.kind === "PAYMENT" ? (
            item.documentNumber
          ) : (
            <Link href={`/invoicing/${item.id}`} className="text-blue-700 underline">{item.documentNumber}</Link>
          )}
        </td>
        <td>{KIND_LABEL[item.kind]}</td>
        <td>{item.date}</td>
        <td>{item.dueDate ?? "—"}</td>
        <td className="text-right tabular-nums">{item.original.toFixed(2)}</td>
        <td className="text-right tabular-nums">{item.open.toFixed(2)}</td>
        <td className="text-right">
          {item.kind === "CREDIT" && (
            <button
              type="button"
              onClick={() => (open ? setOpen(false) : start())}
              disabled={!applyGate.allowed || !canApply || saving}
              title={!applyGate.allowed ? applyGate.title
                : !canApply ? "No open invoice to apply this credit to"
                  : undefined}
              className="text-xs text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400"
            >
              {open ? "Cancel" : "Apply"}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-t bg-slate-50">
          <td colSpan={7} className="p-2">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="mr-2">Apply to</span>
                <select
                  value={invoiceId}
                  onChange={(e) => {
                    const next = invoices.find((i) => i.id === e.target.value);
                    setInvoiceId(e.target.value);
                    if (next) setAmount(Math.min(remaining, next.open).toFixed(2));
                  }}
                  className="rounded border px-2 py-1"
                  aria-label="Invoice to apply the credit to"
                >
                  {invoices.map((i) => (
                    <option key={i.id} value={i.id}>{i.documentNumber} — {i.open.toFixed(2)} open</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="mr-2">Amount</span>
                <input
                  value={amount}
                  inputMode="decimal"
                  onChange={(e) => setAmount(e.target.value)}
                  aria-label="Amount to apply"
                  className="w-28 rounded border px-2 py-1 text-right"
                />
              </label>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={saving}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:bg-slate-400"
              >
                {saving ? "Applying…" : "Apply credit"}
              </button>
              <span className="text-xs text-slate-500">{remaining.toFixed(2)} remaining on this credit</span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
