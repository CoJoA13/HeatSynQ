"use client";
// The /quotes worklist + list (spec §5.4, ruling 11): two worklist sections with counts and
// inline actions ABOVE the full searchable/filterable list with Excel export — the house list
// pattern (InvoicingList/ReceivablesList shape), deliberately NOT the order board's saved-views
// machinery. Plus the "New quote" creation path (the ReceivablesList "New batch" precedent:
// a small form section that POSTs and lands on the new record's own detail page, where the
// server-side defaults — quote number, dates, default ending statement — are then visible).
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { QUOTE_STATUS_LABELS, QUOTE_EXPIRED_LABEL, type QuoteStatusValue } from "@/lib/quote-constants";
import type {
  LinkedOrderRef, QuoteCloseResultData, QuoteDetailData, QuoteMutationData, QuoteRowData,
  QuoteWorklistData,
} from "./quote-form";

// The orders board / InvoicingList precedent: only the slice each picker renders.
type CustomerOption = { id: string; code: string; name: string };
type PartOption = { id: string; customerId: string; partNumber: string; name: string; active: boolean };

/** The status filter offers the DERIVED "Expired" display state as a third option beside the two
 *  stored statuses (ruling 3) — it maps to `expired=1`, not to a status token the server would
 *  reject. */
type StatusFilter = "" | QuoteStatusValue | "EXPIRED";

type Filters = {
  search: string; status: StatusFilter; followUpDue: boolean; customerId: string;
  quoteFrom: string; quoteTo: string;
  effectiveFrom: string; effectiveTo: string;
  expiryFrom: string; expiryTo: string;
};
const DEFAULT_FILTERS: Filters = {
  search: "", status: "", followUpDue: false, customerId: "",
  quoteFrom: "", quoteTo: "", effectiveFrom: "", effectiveTo: "", expiryFrom: "", expiryTo: "",
};

/** Mirrors `src/app/api/quotes/query.ts`'s `parseQuoteFilter` in reverse (the InvoicingList
 *  `buildQuery` precedent), shared by the list fetch and the Excel export link so the two can
 *  never disagree about what a query string means. */
function buildQuery(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.status === "EXPIRED") params.set("expired", "1");
  else if (filters.status) params.set("status", filters.status);
  if (filters.followUpDue) params.set("followUpDue", "1");
  if (filters.customerId) params.set("customerId", filters.customerId);
  if (filters.quoteFrom) params.set("quoteFrom", filters.quoteFrom);
  if (filters.quoteTo) params.set("quoteTo", filters.quoteTo);
  if (filters.effectiveFrom) params.set("effectiveFrom", filters.effectiveFrom);
  if (filters.effectiveTo) params.set("effectiveTo", filters.effectiveTo);
  if (filters.expiryFrom) params.set("expiryFrom", filters.expiryFrom);
  if (filters.expiryTo) params.set("expiryTo", filters.expiryTo);
  return params.toString();
}

/** The derived display state, everywhere (ruling 3): an OPEN quote past expiry reads "Expired" —
 *  matching what the server's own Excel export prints for the same row. */
const statusLabel = (r: { status: QuoteStatusValue; expired: boolean }): string =>
  (r.expired ? QUOTE_EXPIRED_LABEL : QUOTE_STATUS_LABELS[r.status]);

export function Quotes() {
  const router = useRouter();
  const { permissions: perms, error: permsError } = usePermissions();
  const editGate = gate(perms, "quotes.edit");
  const createGate = gate(perms, "quotes.create");
  const customersGate = gate(perms, "customers.view");
  const partsGate = gate(perms, "parts.view");

  const [error, setError] = useState<string | null>(null);

  // Close-with-reason's warn-and-list (ruling 6): the response's linkedOpenOrders rendered with
  // order links after the close lands. Empty list = closed clean, no banner.
  const [closeWarning, setCloseWarning] =
    useState<{ quoteNumber: number; orders: LinkedOrderRef[] } | null>(null);

  // ---------------------------------------------------------------------------------------
  // Worklist — the two §5.4 sections, one request (`worklist=1`).
  // ---------------------------------------------------------------------------------------
  const [worklist, setWorklist] = useState<QuoteWorklistData | null>(null);
  const [worklistError, setWorklistError] = useState<string | null>(null);
  const worklistLatest = useLatest();
  const loadWorklist = useCallback(async () => {
    const t = worklistLatest.next();
    let data: QuoteWorklistData;
    try {
      data = await api<QuoteWorklistData>("/api/quotes?worklist=1");
    } catch (e) {
      if (worklistLatest.isCurrent(t)) setWorklistError((e as Error).message);
      return;
    }
    if (!worklistLatest.isCurrent(t)) return;
    setWorklist(data);
    setWorklistError(null);
  }, [worklistLatest]);
  useEffect(() => { void loadWorklist(); }, [loadWorklist]);

  // ---------------------------------------------------------------------------------------
  // The full list — search + filters + export.
  // ---------------------------------------------------------------------------------------
  const [rows, setRows] = useState<QuoteRowData[]>([]);
  // A `loaded` flag distinct from "the array is empty" (HANDOFF §5.15) — a failed fetch must say
  // so, never render as a genuinely empty, healthy list.
  const [loaded, setLoaded] = useState(false);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const query = buildQuery(filters);

  const listLatest = useLatest();
  // Ticket-gated on BOTH the success and the rejection path (the parts/page.tsx F7 rule): a
  // superseded request's rejection must not overwrite fresh rows with a stale failure.
  const loadList = useCallback(async () => {
    const t = listLatest.next();
    let data: QuoteRowData[];
    try {
      data = await api<QuoteRowData[]>(`/api/quotes${query ? `?${query}` : ""}`);
    } catch (e) {
      if (listLatest.isCurrent(t)) { setError((e as Error).message); setLoaded(true); }
      return;
    }
    if (!listLatest.isCurrent(t)) return;
    setRows(data);
    setError(null);
    setLoaded(true);
  }, [query, listLatest]);
  useEffect(() => { void loadList(); }, [loadList]);

  function updateFilters(patch: Partial<Filters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
  }

  // Customer picker (filter + New quote): fetched only once the caller is known to hold
  // customers.view, never left silently empty for someone who lacks it (§5.16 — the
  // InvoicingList precedent).
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers).catch((e) => setError((e as Error).message));
  }, [customersGate.allowed]);

  // ---------------------------------------------------------------------------------------
  // Inline worklist actions: bump follow-up (a date picker that PATCHes the quote) and
  // close-with-reason. Both reload worklist AND list — a bumped or closed quote moves in both.
  // ---------------------------------------------------------------------------------------
  const reloadAll = useCallback(async () => { await Promise.all([loadWorklist(), loadList()]); }, [loadWorklist, loadList]);

  // #145 (the processes/templates togglingActive precedent, per row): <input type="date"> fires
  // onChange per segment, so without an in-flight guard two unordered PATCHes for the SAME quote
  // can persist the EARLIER pick. Keyed by quote id — a Set, not a scalar, because different
  // rows' bumps are independent and a scalar would forget row A's in-flight PATCH the moment row
  // B started — and checked per row at the one render site, which serves BOTH worklist sections:
  // the same quote can sit in each, so the row-id key disables both of its renders for free.
  const [bumpingIds, setBumpingIds] = useState<Set<string>>(new Set());

  async function bumpFollowUp(row: QuoteRowData, value: string) {
    if (bumpingIds.has(row.id)) return; // belt to the disabled input's braces
    setBumpingIds((cur) => new Set(cur).add(row.id));
    // Optimistic in both sections (the same quote may sit in each — §5.4); rolled back to server
    // truth FIRST on failure, then reported (§5.13).
    setWorklist((cur) => (cur === null ? cur : {
      followUpDue: {
        ...cur.followUpDue,
        rows: cur.followUpDue.rows.map((r) => (r.id === row.id ? { ...r, followUpDate: value || null } : r)),
      },
      expired: {
        ...cur.expired,
        rows: cur.expired.rows.map((r) => (r.id === row.id ? { ...r, followUpDate: value || null } : r)),
      },
    }));
    try {
      await api<QuoteDetailData>(`/api/quotes/${row.id}`, {
        method: "PATCH", body: JSON.stringify({ followUpDate: value || null }),
      });
      await reloadAll();
      setError(null);
    } catch (e) {
      await reloadAll();
      setError((e as Error).message);
    } finally {
      setBumpingIds((cur) => { const next = new Set(cur); next.delete(row.id); return next; });
    }
  }

  async function closeQuote(row: QuoteRowData) {
    // prompt() is the house reason dialog (the parts/[id] removePart / InvoiceDetail unlock
    // precedent) — §5.17: the reason is required and recorded in the audit history.
    const reason = prompt(
      `Close quote #${row.quoteNumber}?\n\nIt stops pricing new orders; orders already linked keep ` +
      `their pricing. Closing is reversible (Reopen on the quote page).\n\n` +
      `Reason for closing (recorded in the audit history):`,
    );
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to close a quote."); return; }
    try {
      const res = await api<QuoteCloseResultData>(`/api/quotes/${row.id}/close`, {
        method: "POST", body: JSON.stringify({ reason }),
      });
      setCloseWarning(res.linkedOpenOrders.length > 0
        ? { quoteNumber: res.quote.quoteNumber, orders: res.linkedOpenOrders }
        : null);
      await reloadAll();
      setError(null);
    } catch (e) {
      await reloadAll();
      setError((e as Error).message);
    }
  }

  // ---------------------------------------------------------------------------------------
  // New quote (the ReceivablesList "New batch" precedent). createQuote requires a customer and
  // at least one line (spec §5.1); the first line is either a memorized part or a free-text
  // part number (ruling 1) — everything else (dates, number, ending statement, quotedBy) is
  // server-defaulted and surfaced on the detail page this navigates to.
  // ---------------------------------------------------------------------------------------
  const [parts, setParts] = useState<PartOption[]>([]);
  useEffect(() => {
    if (!partsGate.allowed) return;
    api<PartOption[]>("/api/parts").then(setParts).catch((e) => setError((e as Error).message));
  }, [partsGate.allowed]);

  const [draft, setDraft] = useState({ customerId: "", partId: "", partNumberText: "" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Set only when the create SUCCEEDS with non-empty ruling-7 overlap warnings — the NewShipment
  // `savedShipment` precedent (§5.7: a warning returned alongside a successful save must be
  // SEEN, never raced past by an immediate navigate). Zero warnings navigates immediately,
  // exactly as before; navigating away (Go to quote) is what dismisses the panel.
  const [createdQuote, setCreatedQuote] =
    useState<{ id: string; quoteNumber: number; warnings: string[] } | null>(null);
  const customerParts = draft.customerId
    ? parts.filter((p) => p.customerId === draft.customerId && p.active) : [];

  async function createQuote() {
    if (!draft.customerId) { setCreateError("Pick a customer first."); return; }
    if (!draft.partId && !draft.partNumberText.trim()) {
      setCreateError("Pick a part or enter a free-text part number for the first line.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api<QuoteMutationData>("/api/quotes", {
        method: "POST",
        body: JSON.stringify({
          customerId: draft.customerId,
          lines: [draft.partId
            ? { partId: draft.partId, prices: [] }
            : { partNumberText: draft.partNumberText.trim(), prices: [] }],
        }),
      });
      if (created.warnings.length > 0) {
        setCreating(false);
        setCreatedQuote({ id: created.id, quoteNumber: created.quoteNumber, warnings: created.warnings });
        void reloadAll(); // the quote is real — the worklists and list below should show it
      } else {
        router.push(`/quotes/${created.id}`);
      }
    } catch (e) {
      setCreateError((e as Error).message);
      setCreating(false);
    }
  }

  const createTitle = !createGate.allowed ? createGate.title : creating ? "Creating…" : undefined;

  // ---------------------------------------------------------------------------------------
  // Rendering.
  // ---------------------------------------------------------------------------------------

  function worklistTable(rows2: QuoteRowData[], empty: string) {
    return (
      <div className="overflow-x-auto">
        <table className="w-full rounded border bg-white text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2">Quote #</th>
              <th className="p-2">Customer</th>
              <th className="p-2">Effective</th>
              <th className="p-2">Expires</th>
              <th className="p-2">Follow-up</th>
              <th className="p-2">RFQ</th>
              <th className="p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows2.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="p-2 font-mono">
                  <Link href={`/quotes/${r.id}`} className="text-blue-700 underline">{r.quoteNumber}</Link>
                </td>
                <td className="p-2">{r.customerCode} · {r.customerName}</td>
                <td className="p-2">{r.effectiveDate}</td>
                <td className="p-2">{r.expiryDate}</td>
                <td className="p-2">
                  {/* Bump follow-up: a date picker that PATCHes the quote (ruling 11), gated
                      quotes.edit with the §5.16 tooltip. Clearing the date is legal (null).
                      Disabled while this row's own PATCH is in flight (#145). */}
                  <input type="date" value={r.followUpDate ?? ""}
                         disabled={editGate.disabled || bumpingIds.has(r.id)}
                         title={bumpingIds.has(r.id) ? "Saving…" : editGate.title}
                         aria-label={`Quote ${r.quoteNumber} follow-up date`}
                         onChange={(e) => void bumpFollowUp(r, e.target.value)}
                         className="rounded border px-1 py-0.5 disabled:cursor-not-allowed disabled:bg-slate-100" />
                </td>
                <td className="p-2">{r.rfqNumber}</td>
                <td className="p-2">
                  <button onClick={() => void closeQuote(r)} disabled={editGate.disabled} title={editGate.title}
                          className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                    Close…
                  </button>
                </td>
              </tr>
            ))}
            {rows2.length === 0 && (
              <tr><td colSpan={7} className="p-3 text-center text-slate-400">{empty}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Quotes</h1>

      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      {closeWarning && (
        <div className="mb-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="mb-1 font-medium">
            Quote #{closeWarning.quoteNumber} is closed, but {closeWarning.orders.length} open
            order(s) still price from it and are not yet fully invoiced:
          </p>
          <ul className="mb-2 flex flex-wrap gap-2">
            {closeWarning.orders.map((o) => (
              <li key={o.id}>
                <Link href={`/orders/${o.id}`} className="text-blue-700 underline">#{o.orderNumber}</Link>
              </li>
            ))}
          </ul>
          <p className="mb-2 text-slate-700">
            Their stored links keep pricing them — invoices for these orders will still use this
            quote&apos;s rows (ruling 6: judged at link time).
          </p>
          <button onClick={() => setCloseWarning(null)} className="text-slate-600">dismiss</button>
        </div>
      )}
      {worklistError && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">
          Could not load the worklist: {worklistError}
        </p>
      )}

      {/* ------------------------- Worklist (spec §5.4) ------------------------- */}
      <section className="mb-6">
        <h2 className="mb-2 text-lg font-medium">
          Follow-up due{worklist ? ` (${worklist.followUpDue.count})` : ""}
        </h2>
        {worklistTable(worklist?.followUpDue.rows ?? [], worklist ? "No follow-ups due" : "Loading…")}
      </section>
      <section className="mb-8">
        {/* A quote may appear in BOTH sections (overdue follow-up on an already-expired quote) —
            information, not a bug (spec §5.4). */}
        <h2 className="mb-2 text-lg font-medium">
          Expired{worklist ? ` (${worklist.expired.count})` : ""}
        </h2>
        {worklistTable(worklist?.expired.rows ?? [], worklist ? "No expired quotes" : "Loading…")}
      </section>

      {/* ------------------------------ New quote ------------------------------ */}
      <section className="mb-8 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">New quote</h2>
        {createError && <p className="mb-2 text-sm text-red-700">{createError}</p>}
        {createdQuote ? (
          // A create that succeeded WITH ruling-7 overlap warnings stops here instead of
          // navigating straight past them (the NewShipment precedent). The form is gone — the
          // quote exists, and a stray second "New quote" from a kept-alive form is exactly what
          // this panel prevents. The warnings warn; they never block.
          <div className="rounded border border-green-300 bg-green-50 p-4">
            <p className="mb-2 font-medium">Quote #{createdQuote.quoteNumber} created.</p>
            <ul className="mb-3 list-disc space-y-0.5 pl-5 text-sm text-amber-800">
              {createdQuote.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => router.push(`/quotes/${createdQuote.id}`)}
                      className="rounded bg-slate-800 px-4 py-2 text-sm text-white">
                Go to quote
              </button>
              {/* The dismiss affordance (#100 item 8): stay put, drop the panel, and refresh the
                  worklists so the created quote shows below. The draft is cleared with it — the
                  panel exists to prevent a stray second "New quote" from a kept-alive form. */}
              <button type="button"
                      onClick={() => {
                        setCreatedQuote(null);
                        setDraft({ customerId: "", partId: "", partNumberText: "" });
                        void reloadAll();
                      }}
                      className="text-sm text-slate-600 underline">
                Stay on this page
              </button>
            </div>
          </div>
        ) : (
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block">
            Customer
            <select value={draft.customerId}
                    disabled={createGate.disabled || !customersGate.allowed}
                    title={createGate.disabled ? createGate.title : customersGate.allowed ? undefined : customersGate.title}
                    onChange={(e) => setDraft({ customerId: e.target.value, partId: "", partNumberText: draft.partNumberText })}
                    className="mt-1 block rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
              <option value="">Customer…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </select>
          </label>
          <label className="block">
            First line: part
            <select value={draft.partId}
                    disabled={createGate.disabled || !partsGate.allowed || !draft.customerId || draft.partNumberText.trim() !== ""}
                    title={createGate.disabled ? createGate.title
                      : !partsGate.allowed ? partsGate.title
                        : !draft.customerId ? "Pick a customer first"
                          : draft.partNumberText.trim() !== "" ? "Clear the free-text part number to pick a memorized part"
                            : undefined}
                    onChange={(e) => setDraft({ ...draft, partId: e.target.value })}
                    className="mt-1 block rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
              <option value="">Part…</option>
              {customerParts.map((p) => <option key={p.id} value={p.id}>{p.partNumber} — {p.name}</option>)}
            </select>
          </label>
          <label className="block">
            …or free-text part number
            <input value={draft.partNumberText}
                   disabled={createGate.disabled || draft.partId !== ""}
                   title={createGate.disabled ? createGate.title
                     : draft.partId !== "" ? "Clear the part pick to enter a free-text line" : undefined}
                   onChange={(e) => setDraft({ ...draft, partNumberText: e.target.value })}
                   placeholder="e.g. GEAR-77 REV B"
                   className="mt-1 block rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100" />
          </label>
          <button onClick={() => void createQuote()} disabled={createTitle !== undefined} title={createTitle}
                  className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
            {creating ? "Creating…" : "New quote"}
          </button>
        </div>
        )}
      </section>

      {/* ------------------------------ All quotes ------------------------------ */}
      <section>
        <h2 className="mb-2 text-lg font-medium">All quotes</h2>

        <div className="mb-3 flex flex-wrap items-end gap-4 rounded border bg-white p-2 text-sm">
          <div>
            <label className="block text-xs text-slate-500">Search</label>
            <input value={filters.search} onChange={(e) => updateFilters({ search: e.target.value })}
                   placeholder="Number, customer, RFQ, part"
                   className="w-56 rounded border px-2 py-1" />
          </div>
          <div>
            <label className="block text-xs text-slate-500">Status</label>
            <select value={filters.status}
                    onChange={(e) => updateFilters({ status: e.target.value as StatusFilter })}
                    className="rounded border px-2 py-1">
              <option value="">All statuses</option>
              <option value="OPEN">{QUOTE_STATUS_LABELS.OPEN}</option>
              <option value="CLOSED">{QUOTE_STATUS_LABELS.CLOSED}</option>
              <option value="EXPIRED">{QUOTE_EXPIRED_LABEL} (derived)</option>
            </select>
          </div>
          <label className="flex items-center gap-1 pb-1">
            <input type="checkbox" checked={filters.followUpDue}
                   onChange={(e) => updateFilters({ followUpDue: e.target.checked })} />
            Follow-up due
          </label>
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
            <label className="block text-xs text-slate-500">Quote date</label>
            <div className="flex items-center gap-1">
              <input type="date" value={filters.quoteFrom} onChange={(e) => updateFilters({ quoteFrom: e.target.value })}
                     className="rounded border px-2 py-1" />
              <span>&ndash;</span>
              <input type="date" value={filters.quoteTo} onChange={(e) => updateFilters({ quoteTo: e.target.value })}
                     className="rounded border px-2 py-1" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-500">Effective</label>
            <div className="flex items-center gap-1">
              <input type="date" value={filters.effectiveFrom} onChange={(e) => updateFilters({ effectiveFrom: e.target.value })}
                     className="rounded border px-2 py-1" />
              <span>&ndash;</span>
              <input type="date" value={filters.effectiveTo} onChange={(e) => updateFilters({ effectiveTo: e.target.value })}
                     className="rounded border px-2 py-1" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-500">Expires</label>
            <div className="flex items-center gap-1">
              <input type="date" value={filters.expiryFrom} onChange={(e) => updateFilters({ expiryFrom: e.target.value })}
                     className="rounded border px-2 py-1" />
              <span>&ndash;</span>
              <input type="date" value={filters.expiryTo} onChange={(e) => updateFilters({ expiryTo: e.target.value })}
                     className="rounded border px-2 py-1" />
            </div>
          </div>
          <a href={`/api/quotes/export${query ? `?${query}` : ""}`} className="pb-1 text-blue-700 underline">
            Export to Excel
          </a>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full rounded border bg-white text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">Quote #</th>
                <th className="p-2">Customer</th>
                <th className="p-2">Status</th>
                <th className="p-2">Quote date</th>
                <th className="p-2">Effective</th>
                <th className="p-2">Expires</th>
                <th className="p-2">Follow-up</th>
                <th className="p-2">RFQ</th>
                <th className="p-2">Lines</th>
                <th className="p-2">Quoted by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2 font-mono">
                    <Link href={`/quotes/${r.id}`} className="text-blue-700 underline">{r.quoteNumber}</Link>
                  </td>
                  <td className="p-2">{r.customerCode} · {r.customerName}</td>
                  <td className="p-2">
                    <span className={r.expired ? "rounded bg-amber-100 px-1.5 py-0.5 text-amber-800" : undefined}>
                      {statusLabel(r)}
                    </span>
                  </td>
                  <td className="p-2">{r.quoteDate}</td>
                  <td className="p-2">{r.effectiveDate}</td>
                  <td className="p-2">{r.expiryDate}</td>
                  <td className="p-2">{r.followUpDate ?? ""}</td>
                  <td className="p-2">{r.rfqNumber}</td>
                  <td className="p-2">{r.lineCount}</td>
                  <td className="p-2">{r.quotedByName}</td>
                </tr>
              ))}
              {rows.length === 0 && loaded && !error && (
                <tr><td colSpan={10} className="p-4 text-center text-slate-400">No quotes</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
