"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import {
  INVOICE_STATUSES, INVOICE_STATUS_LABELS, INVOICE_KIND_LABELS,
  type InvoiceStatusValue, type InvoiceKindValue,
} from "@/lib/invoice-constants";

// Local mirrors of src/server/invoices.ts's InvoiceCandidate/InvoiceListRow — not imported from
// src/server/** (CLAUDE.md "Constraints that will bite you": a client component pulling from
// there drags node:async_hooks and Prisma into the browser bundle). Both dates arrive
// pre-formatted "yyyy-mm-dd" strings (`formatDateOnly` runs server-side); `finalizedAt` is the one
// exception — the server hands it back as a full ISO datetime (`toISOString()`), so it is the one
// field this file still runs through `new Date(...)` before display (the audit log / documents
// list precedent).
type InvoiceCandidate = {
  orderId: string; orderNumber: number; customerCode: string; customerName: string;
  poNumber: string; lastShipDate: string | null;
};
type InvoiceListRow = {
  id: string; kind: InvoiceKindValue; status: InvoiceStatusValue;
  orderId: string; orderNumber: number; documentNumber: string;
  customerId: string; customerCode: string; customerName: string;
  invoiceDate: string; total: number; finalizedAt: string | null; deletedAt: string | null;
};

// The orders board / shipping list precedent: only the slice the customer filter picker needs.
type CustomerOption = { id: string; code: string; name: string };

type Filters = { customerId: string; status: InvoiceStatusValue | ""; from: string; to: string };
const DEFAULT_FILTERS: Filters = { customerId: "", status: "", from: "", to: "" };

/** Mirrors `src/app/api/invoices/query.ts`'s `parseInvoiceFilter` in reverse — the
 *  `ShippingList.tsx` `buildQuery` precedent — so the list and its export can never disagree
 *  about what a query string means. Candidates has no filters of its own (task-17-brief.md: only
 *  the "Invoices" section is filterable), so this is only ever built from `Filters`. */
function buildQuery(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.customerId) params.set("customerId", filters.customerId);
  if (filters.status) params.set("status", filters.status);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return params.toString();
}

export function InvoicingList() {
  const { permissions: perms, error: permsError } = usePermissions();
  const customersGate = gate(perms, "customers.view");
  const createGate = gate(perms, "invoicing.create");

  // ---------------------------------------------------------------------------------------
  // Ready to invoice — candidates (order at SHIPPED, no live invoice), each row a checkbox.
  // ---------------------------------------------------------------------------------------
  const [candidates, setCandidates] = useState<InvoiceCandidate[]>([]);
  // A `loaded` flag distinct from "the array is empty" (HANDOFF §5.15 / Task 8's headline
  // defect): a failed fetch must say so, never render as a genuinely empty, healthy list.
  const [candidatesLoaded, setCandidatesLoaded] = useState(false);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [createErrors, setCreateErrors] = useState<Map<string, string>>(new Map());

  const candidatesLatest = useLatest();
  // Ticket-gated on BOTH the success and the rejection path (issues #5/#15 — a stale response
  // must never overwrite a newer one, in either direction). No `.catch(() => {})` anywhere.
  const loadCandidates = useCallback(async () => {
    const t = candidatesLatest.next();
    let data: InvoiceCandidate[];
    try {
      data = await api<InvoiceCandidate[]>("/api/invoices?candidates=1");
    } catch (e) {
      if (candidatesLatest.isCurrent(t)) {
        setCandidatesError((e as Error).message);
        setCandidatesLoaded(true);
      }
      return;
    }
    if (!candidatesLatest.isCurrent(t)) return;
    setCandidates(data);
    setCandidatesError(null);
    setCandidatesLoaded(true);
  }, [candidatesLatest]);
  useEffect(() => { void loadCandidates(); }, [loadCandidates]);

  function toggleTicked(orderId: string, checked: boolean) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (checked) next.add(orderId); else next.delete(orderId);
      return next;
    });
  }

  // ---------------------------------------------------------------------------------------
  // Invoices — the filtered list + export.
  // ---------------------------------------------------------------------------------------
  const [invoices, setInvoices] = useState<InvoiceListRow[]>([]);
  const [invoicesLoaded, setInvoicesLoaded] = useState(false);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);

  // Customer filter picker: fetched only once the caller is known to hold customers.view, never
  // left silently empty for someone who lacks it (§5.16) — the ShippingList precedent.
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers).catch((e) => setInvoicesError((e as Error).message));
  }, [customersGate.allowed]);

  function updateFilters(patch: Partial<Filters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
  }

  const query = buildQuery(filters);
  const invoicesLatest = useLatest();
  const loadInvoices = useCallback(async () => {
    const t = invoicesLatest.next();
    let data: InvoiceListRow[];
    try {
      data = await api<InvoiceListRow[]>(`/api/invoices${query ? `?${query}` : ""}`);
    } catch (e) {
      if (invoicesLatest.isCurrent(t)) {
        setInvoicesError((e as Error).message);
        setInvoicesLoaded(true);
      }
      return;
    }
    if (!invoicesLatest.isCurrent(t)) return;
    setInvoices(data);
    setInvoicesError(null);
    setInvoicesLoaded(true);
  }, [query, invoicesLatest]);
  useEffect(() => { void loadInvoices(); }, [loadInvoices]);

  // Stale-closure guard (Task 7): `createInvoices` can run a while (one sequential POST per
  // ticked order), and its captured `loadInvoices` closes over the filter query as of the click —
  // the post-run reload would re-ask that OLD query with the NEWEST ticket, defeating the gate
  // and leaving the table disagreeing with the filter controls. The reload goes through this
  // ref, updated every render (in an effect — the `react-hooks/refs` rule forbids a render-time
  // write), so it always closes over the CURRENT query. `loadCandidates` has no query axis, so
  // its captured closure cannot go stale — left as-is.
  const loadInvoicesRef = useRef(loadInvoices);
  useEffect(() => { loadInvoicesRef.current = loadInvoices; });

  // Task 11's create is per-order and independent: each ticked order POSTs on its own turn, and a
  // failure on one must never abort the run or hide behind one shared banner — it is reported
  // BESIDE that order's own row (task-17-brief.md). Sequential ("in turn"), not Promise.all, so
  // several ticked orders never race each other into `allocateNumber`'s shared counter for no
  // reason.
  async function createInvoices() {
    const orderIds = [...ticked];
    if (orderIds.length === 0 || creating) return;
    setCreating(true);
    const failures = new Map<string, string>();
    for (const orderId of orderIds) {
      try {
        await api("/api/invoices", { method: "POST", body: JSON.stringify({ orderId }) });
      } catch (e) {
        failures.set(orderId, e instanceof ApiError ? e.message : (e as Error).message);
      }
    }
    // §5.13: roll back to server truth FIRST, then report why. Reloading both lists before
    // setting the per-order failures means a succeeded order's row is never left stranded in
    // "Ready to invoice" for even a moment after the server has already moved it into "Invoices".
    await Promise.all([loadCandidates(), loadInvoicesRef.current()]);
    setTicked(new Set(failures.keys()));
    setCreateErrors(failures);
    setCreating(false);
  }

  const createTitle = !createGate.allowed
    ? createGate.title
    : creating
      ? "Creating invoices…"
      : ticked.size === 0
        ? "Tick at least one order first"
        : undefined;

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Invoicing</h1>

      {permsError && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{permsError}</p>}

      {/* ----------------------------- Ready to invoice ----------------------------- */}
      <section className="mb-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-medium">Ready to invoice</h2>
          <button onClick={() => void createInvoices()} disabled={createTitle !== undefined} title={createTitle}
                  className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
            {creating ? "Creating…" : "Create invoices"}
          </button>
        </div>

        {candidatesError && (
          <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">
            Could not load candidates: {candidatesError}
          </p>
        )}

        <div className="overflow-x-auto">
          <table className="w-full rounded border bg-white text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2"></th>
                <th className="p-2">Order No</th>
                <th className="p-2">Customer</th>
                <th className="p-2">PO</th>
                <th className="p-2">Last Ship Date</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.orderId} className="border-t align-top">
                  <td className="p-2">
                    <input type="checkbox" checked={ticked.has(c.orderId)}
                           disabled={!createGate.allowed} title={createGate.allowed ? undefined : createGate.title}
                           onChange={(e) => toggleTicked(c.orderId, e.target.checked)} />
                  </td>
                  <td className="p-2 font-mono">
                    <Link href={`/orders/${c.orderId}`} className="text-blue-700 underline">{c.orderNumber}</Link>
                    {createErrors.has(c.orderId) && (
                      <p className="mt-1 max-w-xs text-xs text-red-700">{createErrors.get(c.orderId)}</p>
                    )}
                  </td>
                  <td className="p-2">{c.customerCode} · {c.customerName}</td>
                  <td className="p-2">{c.poNumber}</td>
                  <td className="p-2">{c.lastShipDate ?? ""}</td>
                </tr>
              ))}
              {candidates.length === 0 && candidatesLoaded && !candidatesError && (
                <tr><td colSpan={5} className="p-4 text-center text-slate-400">No orders ready to invoice</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ------------------------------- Invoices ------------------------------- */}
      <section>
        <h2 className="mb-2 text-lg font-medium">Invoices</h2>

        {invoicesError && (
          <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">
            Could not load invoices: {invoicesError}
          </p>
        )}

        <div className="mb-3 flex flex-wrap items-end gap-4 rounded border bg-white p-2 text-sm">
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
            <label className="block text-xs text-slate-500">Status</label>
            <select value={filters.status}
                    onChange={(e) => updateFilters({ status: e.target.value as InvoiceStatusValue | "" })}
                    className="rounded border px-2 py-1">
              <option value="">All statuses</option>
              {INVOICE_STATUSES.map((s) => <option key={s} value={s}>{INVOICE_STATUS_LABELS[s]}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs text-slate-500">Invoice date</label>
            <div className="flex items-center gap-1">
              <input type="date" value={filters.from} onChange={(e) => updateFilters({ from: e.target.value })}
                     className="rounded border px-2 py-1" />
              <span>&ndash;</span>
              <input type="date" value={filters.to} onChange={(e) => updateFilters({ to: e.target.value })}
                     className="rounded border px-2 py-1" />
            </div>
          </div>

          <a href={`/api/invoices/export${query ? `?${query}` : ""}`} className="text-blue-700 underline">
            Export to Excel
          </a>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full rounded border bg-white text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">Document No</th>
                <th className="p-2">Order No</th>
                <th className="p-2">Customer</th>
                <th className="p-2">Kind</th>
                <th className="p-2">Invoice Date</th>
                <th className="p-2">Status</th>
                <th className="p-2">Total</th>
                <th className="p-2">Finalized</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-t">
                  <td className="p-2 font-mono">
                    <Link href={`/invoicing/${inv.id}`} className="text-blue-700 underline">{inv.documentNumber}</Link>
                  </td>
                  <td className="p-2 font-mono">{inv.orderNumber}</td>
                  <td className="p-2">{inv.customerCode} · {inv.customerName}</td>
                  <td className="p-2">{INVOICE_KIND_LABELS[inv.kind]}</td>
                  <td className="p-2">{inv.invoiceDate}</td>
                  <td className="p-2">{INVOICE_STATUS_LABELS[inv.status]}</td>
                  <td className="p-2">{inv.total.toFixed(2)}</td>
                  <td className="p-2">{inv.finalizedAt ? new Date(inv.finalizedAt).toLocaleString() : ""}</td>
                </tr>
              ))}
              {invoices.length === 0 && invoicesLoaded && !invoicesError && (
                <tr><td colSpan={8} className="p-4 text-center text-slate-400">No invoices</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
