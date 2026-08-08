"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import {
  INVOICE_KIND_LABELS, INVOICE_STATUS_LABELS,
  type InvoiceKindValue, type InvoiceStatusValue,
} from "@/lib/invoice-constants";
import type { OrderStatusValue } from "@/lib/order-constants";

/** Local mirror of src/server/invoices.ts's `InvoiceListRow` — not imported from src/server/**
 *  (CLAUDE.md). Same shape `GET /api/orders/[id]/invoices` (`invoicesForOrder`, Task 16) and
 *  `/invoicing`'s own list share. */
type InvoiceRow = {
  id: string; kind: InvoiceKindValue; status: InvoiceStatusValue;
  orderId: string; orderNumber: number; documentNumber: string;
  customerId: string; customerCode: string; customerName: string;
  invoiceDate: string; total: number; finalizedAt: string | null; deletedAt: string | null;
};

/**
 * The hub's Invoices section (design spec §6/§11, Task 18): every invoice/credit ever raised
 * against this order — discarded drafts included, dimmed rather than hidden — the
 * ShipmentsSection.tsx precedent. Rows link to `/invoicing/[id]`; a Create invoice button appears
 * when the order is SHIPPED with no live invoice (`createInvoice`'s own refusal reasons, named
 * here proactively rather than left to a guaranteed-400 click — §5.16).
 */
export function InvoicesSection({
  orderId, orderStatus, viewGate, createGate,
}: {
  orderId: string;
  orderStatus: OrderStatusValue;
  viewGate: Gate;
  createGate: Gate;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const allowed = viewGate.allowed;
  const load = useCallback(async () => {
    if (!allowed) return;
    setRows(await api<InvoiceRow[]>(`/api/orders/${orderId}/invoices`));
  }, [orderId, allowed]);
  useEffect(() => { load().then(() => setError(null)).catch((e) => setError((e as Error).message)); }, [load]);

  const hasLiveInvoice = rows.some((r) => r.kind === "INVOICE" && r.deletedAt === null);
  const createTitle = !createGate.allowed
    ? createGate.title
    : orderStatus !== "SHIPPED"
      ? "Only a fully shipped order can be invoiced"
      : hasLiveInvoice
        ? "This order already has an invoice — open it below"
        : creating ? "Creating…" : undefined;

  async function createInvoice() {
    setCreating(true);
    try {
      const res = await api<{ invoice: { id: string } }>("/api/invoices", {
        method: "POST", body: JSON.stringify({ orderId }),
      });
      router.push(`/invoicing/${res.invoice.id}`);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  // §5.16: a caller without invoicing.view sees the section saying why, never a silently empty one.
  if (!viewGate.allowed) {
    return (
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Invoices</h2>
        <p className="text-sm text-slate-500">{viewGate.title ?? "You do not have permission to view invoices."}</p>
      </section>
    );
  }

  return (
    <section className="mb-6 rounded border bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">Invoices</h2>
        <button onClick={() => void createInvoice()} disabled={createTitle !== undefined} title={createTitle}
                className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
          {creating ? "Creating…" : "Create invoice"}
        </button>
      </div>

      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">No invoices raised against this order yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 font-medium">Document</th>
              <th className="font-medium">Kind</th>
              <th className="font-medium">Status</th>
              <th className="font-medium">Invoice date</th>
              <th className="font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`border-t ${r.deletedAt ? "text-slate-400" : ""}`}>
                <td className="py-1 font-mono">
                  <Link href={`/invoicing/${r.id}`} className="text-blue-700 underline">{r.documentNumber}</Link>
                  {r.deletedAt && <span className="ml-2 rounded bg-slate-200 px-1 text-xs text-slate-700">discarded</span>}
                </td>
                <td>{INVOICE_KIND_LABELS[r.kind]}</td>
                <td>{INVOICE_STATUS_LABELS[r.status]}</td>
                <td>{r.invoiceDate}</td>
                <td>{r.total.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
