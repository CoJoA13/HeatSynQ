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
//
// The standalone bad-debt WRITE-OFF lives here for the same reason (#77): the invoice page has no
// A/R panel and no open balance at all, so putting it there would mean building that panel first,
// while this screen already prints the live open balance the operator is deciding about. Its amount
// is EDITABLE, defaulting to the whole open balance (owner ruling 2026-08-19) — a partial bad-debt
// write-off is ordinary, and the operator should not have to reach for another screen for it.
//
// And the VOID is here too, which is the less obvious half (owner ruling, same day). A fully
// written-off invoice has a zero open balance, so it used to fall straight out of this table — and
// `BatchDetail` lists applications per PAYMENT, so a write-off with no payment appeared on no screen
// at all. A mis-keyed bad debt was uncorrectable outside SQL. `openItemsForCustomer` now retains such
// an invoice (at zero, carrying its `writeOffs`), and each one renders with a Void control: §5.14's
// rule that a block must name a route out of itself, applied to an action instead of an error.
//
// That retention is BOUNDED (#157, owner ruling 2026-08-19): the server keeps the row only while the
// write-off's own month is open, because `voidApplication` refuses once it closes and the row would
// then be advertising an undo that no longer works. Nothing to do here — the row simply stops
// arriving — but do not "restore" it in the client when a zero-balance invoice goes missing.
import { useCallback, useEffect, useRef, useState } from "react";
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
/** One standalone (null-payment) write-off against an invoice — the flag the row renders and the
 *  `Application` id its Void control acts on (#77). Empty on CREDIT and PAYMENT rows. */
type OpenItemWriteOff = { id: string; amount: number; appliedDate: string; reason: string | null };
type CustomerOpenItem = {
  kind: OpenItemKind; id: string; documentNumber: string;
  date: string; dueDate: string | null; original: number; open: number;
  writeOffs: OpenItemWriteOff[];
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
  { customerId, viewGate, applyGate, writeOffGate, voidGate }: {
    customerId: string;
    viewGate: Gate;
    applyGate: Gate;
    /** #77: `receivables.create` AND the `write_off` special action, combined by the caller so the
     *  tooltip names whichever one the server would actually refuse on (§5.16). */
    writeOffGate: Gate;
    /** #77: `receivables.delete` — what `DELETE /api/receivables/applications/[id]` enforces. */
    voidGate: Gate;
  },
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
  // be applied to. `open > 0` is load-bearing since #77: an invoice retained purely because it was
  // written off sits at ZERO, and offering it as a credit target would prefill an amount of 0.00
  // that `applyCredit` refuses (its schema requires a positive amount).
  const openInvoices = (summary?.openItems ?? []).filter((i) => i.kind === "INVOICE" && i.open > 0);

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
                    writeOffGate={writeOffGate}
                    voidGate={voidGate}
                    onApplied={() => void load()}
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
 *  a trip to another page. An INVOICE carries the Write off control and, once written off, the Void
 *  that undoes it (#77). An on-account PAYMENT has no document page to link to, and is applied
 *  through its receipt batch (`BatchDetail.tsx`), which is a different flow.
 *
 *  The two forms have separate `open` flags rather than one union, because they are already mutually
 *  exclusive by ROW KIND — the Apply form exists only on a CREDIT row and the write-off form only on
 *  an INVOICE row, so neither can ever be showing while the other is. They share ONE `inFlight` ref
 *  and ONE `applyError`, which is correct: a row does one thing at a time, and every failure belongs
 *  in the same place beneath it. */
function OpenItemRow({ item, invoices, applyGate, writeOffGate, voidGate, onApplied }: {
  item: CustomerOpenItem;
  invoices: CustomerOpenItem[];
  applyGate: Gate;
  writeOffGate: Gate;
  voidGate: Gate;
  onApplied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState("");
  const [writeOffOpen, setWriteOffOpen] = useState(false);
  const [writeOffAmount, setWriteOffAmount] = useState("");
  const [writeOffReason, setWriteOffReason] = useState("");
  const [saving, setSaving] = useState(false);
  // SYNCHRONOUS single-flight. `disabled={saving}` is not one: `setSaving(true)` schedules a render,
  // so two clicks landing in the same tick both pass the check and both POST. `applyCredit`
  // serializes them but treats each as legitimate, so with enough remaining on both sides the credit
  // applies TWICE and the receivable drops by double the intended amount — real money, from a
  // double-click. A ref flips before the first `await` and is therefore already set when the second
  // handler runs.
  const inFlight = useRef(false);
  // The APPLY's own failure, kept here rather than in the section's `error`. That one gates the
  // whole summary (`loaded && !error && summary`), so routing a rejected amount into it unmounted
  // this very form — taking away the only control that could clear it and leaving a page reload as
  // the operator's only way back. A refused amount must stay correctable in place (§5.14's rule that
  // a block names a route out of itself, applied to a form).
  const [applyError, setApplyError] = useState<string | null>(null);

  const remaining = Math.abs(item.open);
  const canApply = item.kind === "CREDIT" && invoices.length > 0;
  // Nothing left to write off is a real, non-permission reason to disable the control — and the one
  // a retained written-off row is always in (#77): it is listed for its Void, not for another
  // write-off.
  const canWriteOff = item.kind === "INVOICE" && item.open > 0;

  function start() {
    // Default to the OLDEST open invoice and the smaller of the two balances — the applying an
    // operator would otherwise type by hand, and never an amount the save would refuse.
    const first = invoices[0];
    setInvoiceId(first.id);
    setAmount(Math.min(remaining, first.open).toFixed(2));
    setOpen(true);
    setApplyError(null);
  }

  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      await api("/api/receivables/credit-applications", {
        method: "POST",
        body: JSON.stringify({ creditInvoiceId: item.id, invoiceId, amount: Number(amount) }),
      });
      setOpen(false);
      setApplyError(null);
      onApplied();
    } catch (e) {
      setApplyError((e as Error).message); // stays open, with the amount the operator typed
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  function startWriteOff() {
    // Owner ruling 2026-08-19: the amount is EDITABLE, defaulting to the FULL open balance — the
    // bad-debt case in one click, the partial one by typing over it.
    setWriteOffAmount(item.open.toFixed(2));
    setWriteOffReason("");
    setWriteOffOpen(true);
    setApplyError(null);
  }

  async function submitWriteOff() {
    if (inFlight.current) return; // the same synchronous single-flight the credit apply uses
    inFlight.current = true;
    setSaving(true);
    try {
      // The amount goes as the TYPED STRING, not `Number(...)`: `decimalField` accepts either, and a
      // string carries a typo to the field-anchored decimal message instead of collapsing to NaN →
      // null → "expected a number". The reason is sent as typed; the service trims it and is the
      // one place that decides an empty one is a refusal.
      await api("/api/receivables/write-offs", {
        method: "POST",
        body: JSON.stringify({ invoiceId: item.id, amount: writeOffAmount.trim(), reason: writeOffReason }),
      });
      setWriteOffOpen(false);
      setApplyError(null);
      onApplied();
    } catch (e) {
      setApplyError((e as Error).message); // stays open, correctable in place
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  /** Undo one standalone write-off (#77). `prompt`-then-DELETE is `BatchDetail`'s own
   *  `voidApplicationAction` shape — the reason is required by `voidApplication` itself, and this
   *  pre-check only saves a round trip. The prompt is synchronous, so no second click can be
   *  processed while it is up; the `inFlight` ref still flips before the first `await`. */
  async function voidWriteOff(w: OpenItemWriteOff) {
    const reason = prompt(
      `Void the write-off of ${w.amount.toFixed(2)} against ${item.documentNumber}?\n\n`
      + "The invoice's open balance comes back.\n\nReason for voiding (recorded in the audit history):",
    );
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setApplyError("A reason is required to void a write-off."); return; }
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      await api(`/api/receivables/applications/${w.id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
      setApplyError(null);
      onApplied();
    } catch (e) {
      setApplyError((e as Error).message);
    } finally {
      inFlight.current = false;
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
        <td>
          {KIND_LABEL[item.kind]}
          {item.writeOffs.length > 0 && (
            // The flag that explains why this row reads the way it does — and, when the balance is
            // zero, why it is still here at all (#77).
            <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-xs text-amber-800">Written off</span>
          )}
        </td>
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
          {item.kind === "INVOICE" && (
            // §5.16: rendered visible-and-disabled, naming whichever blocker the server would
            // actually hit — the permission pair first (that is what the route refuses on), then
            // the "nothing left" case.
            <button
              type="button"
              onClick={() => (writeOffOpen ? setWriteOffOpen(false) : startWriteOff())}
              disabled={!writeOffGate.allowed || !canWriteOff || saving}
              title={!writeOffGate.allowed ? writeOffGate.title
                : !canWriteOff ? "Nothing left to write off on this invoice"
                  : undefined}
              className="text-xs text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400"
            >
              {writeOffOpen ? "Cancel" : "Write off"}
            </button>
          )}
        </td>
      </tr>
      {item.writeOffs.length > 0 && (
        // Every standalone write-off on this invoice, each with the Void that undoes it. This is the
        // ONLY screen that can reach one: `voidApplication` has always accepted a null-payment row,
        // but `BatchDetail` lists applications per payment, so before #77 nothing rendered these.
        <tr className="border-t bg-amber-50">
          <td colSpan={7} className="p-2">
            <ul className="space-y-1 text-xs text-slate-700">
              {item.writeOffs.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center gap-2">
                  <span className="tabular-nums">Written off {w.amount.toFixed(2)}</span>
                  <span className="text-slate-500">on {w.appliedDate}</span>
                  {w.reason && <span className="text-slate-500">— {w.reason}</span>}
                  <button
                    type="button"
                    onClick={() => void voidWriteOff(w)}
                    disabled={!voidGate.allowed || saving}
                    title={voidGate.allowed ? undefined : voidGate.title}
                    className="text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    Void
                  </button>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
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
      {writeOffOpen && (
        <tr className="border-t bg-slate-50">
          <td colSpan={7} className="p-2">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="mr-2">Amount</span>
                <input
                  value={writeOffAmount}
                  inputMode="decimal"
                  onChange={(e) => setWriteOffAmount(e.target.value)}
                  aria-label="Amount to write off"
                  className="w-28 rounded border px-2 py-1 text-right"
                />
              </label>
              <label className="flex-1 text-sm">
                <span className="mr-2">Reason</span>
                <input
                  value={writeOffReason}
                  onChange={(e) => setWriteOffReason(e.target.value)}
                  aria-label="Reason for the write-off"
                  placeholder="why this balance is being written off"
                  className="w-full min-w-48 rounded border px-2 py-1"
                />
              </label>
              <button
                type="button"
                onClick={() => void submitWriteOff()}
                disabled={saving}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:bg-slate-400"
              >
                {saving ? "Writing off…" : "Write off balance"}
              </button>
              <span className="text-xs text-slate-500">{item.open.toFixed(2)} open on this invoice</span>
            </div>
          </td>
        </tr>
      )}
      {applyError && (
        // ONE error row for the whole item, rather than one inside each form. It used to live inside
        // the credit form's expanded row, which cannot serve the two actions #77 adds: a failed VOID
        // has no form open at all, and its message would have rendered into nothing. Still local to
        // the row (never the section's `error`, which gates the whole summary and would unmount the
        // very form holding the amount that needs correcting).
        <tr className="border-t">
          <td colSpan={7} className="px-2 pb-2">
            <p className="rounded bg-red-50 p-2 text-sm text-red-700">{applyError}</p>
          </td>
        </tr>
      )}
    </>
  );
}
