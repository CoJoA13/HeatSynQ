"use client";
// The batch entry + apply screen (design spec §11 "/receivables"; task-13-brief.md Step 2).
// Remounted per id by page.tsx's `key={id}` (HANDOFF §5.12) — every field below binds straight
// to `batch`, so a fresh instance per batch id never carries one batch's state onto another's.
//
// THE BINDING STATE MODEL — copied from `InvoiceDetail.tsx` verbatim (task-13-brief.md's explicit
// precedent), not reinvented: one monotonic mutation ticket (`useMutationGate`) shared by every
// write AND by `load` itself, so overlapping calls resolve to whichever is genuinely newest;
// `useEditGuard` merges every arriving server detail over `batch` (there is no free-text header
// field on a `ReceiptBatch` today — `notes` has no edit route — but every "apply a server detail"
// call site still routes through `merge` so a future editable field costs nothing here); the
// apply panel's invoice picker is a `useBulkGrid` instance (below), the `InvoiceLinesGrid`
// "several edited rows submitted as ONE call" shape, even though its rows are not their own
// persisted entities; `gate`/`gateDo` from permission-ui gate every control.
import { Fragment, useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { gate, gateDo, type Gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useMutationGate, useLatest } from "@/lib/use-latest";
import { useEditGuard } from "@/lib/use-edit-guard";
import { useBulkGrid } from "@/lib/bulk-grid";
import { formatDateOnly, todayDateOnly } from "@/lib/business-days";
import { HistoryPanel } from "@/components/HistoryPanel";
import {
  RECEIPT_BATCH_STATUS_LABELS, APPLICATION_TYPE_LABELS,
  type ReceiptBatchStatusValue, type ApplicationTypeValue,
} from "@/lib/ar-constants";

// ---------------------------------------------------------------------------------------------
// Types. Local mirrors of src/server/receipts.ts's `BatchDetail`/`PaymentRow` and
// src/server/applications.ts's `OpenInvoiceRow` — not imported from src/server/** (CLAUDE.md: a
// client component pulling from there drags node:async_hooks and Prisma into the browser
// bundle). Named `BatchDetailData`, not `BatchDetail` — the component below is `BatchDetail`
// (task-13-brief.md's exact file/component name), and the two would collide (the
// `InvoiceDetail.tsx` / `InvoiceDetailData` precedent).
// ---------------------------------------------------------------------------------------------

/** `src/server/receipts.ts`'s `PaymentApplicationRow` — Fix #11 (Round 4 correction-path): the
 *  live applications a payment carries, so this screen can list AND void them (the whole-branch
 *  fix made `voidPayment` refuse a payment with live applications, so this is the only way to
 *  correct a mis-applied payment). */
type PaymentApplicationRow = {
  id: string; type: ApplicationTypeValue; amount: number; invoiceId: string; invoiceDocumentNumber: string;
};

type PaymentRow = {
  id: string; customerId: string; customerCode: string; customerName: string;
  paymentTypeId: string; paymentTypeName: string; amount: number; reference: string; receivedDate: string;
  onAccount: number; applications: PaymentApplicationRow[];
};

type BatchDetailData = {
  id: string; batchNumber: number; depositDate: string; controlTotal: number | null;
  status: ReceiptBatchStatusValue; enteredTotal: number; balance: number; notes: string;
  payments: PaymentRow[]; deletedAt: string | null;
};

/** `src/server/applications.ts`'s `OpenInvoiceRow` — the apply panel's invoice picker. */
type OpenInvoiceRow = {
  id: string; orderId: string; orderNumber: number; documentNumber: string;
  customerId: string; customerCode: string; customerName: string;
  invoiceDate: string; dueDate: string | null; total: number; open: number;
};

type CustomerOption = { id: string; code: string; name: string };
/** `src/server/picklists.ts`'s `PickListRow` — the payment-type picker (`/api/picklists/paymentType`,
 *  session-only gated, the `customers/[id]/page.tsx` Terms-picker precedent). */
type PickListRow = { id: string; name: string; active: boolean };

/** A POSTED batch locks EDITING THE PAYMENT LIST — the 5A `statusLocked` shape (InvoiceDetail.tsx),
 *  applied to `ReceiptBatch.status` rather than an invoice's finalized/discarded pair. Applied to
 *  add-payment/void-payment only — `receipts.ts`'s `refusePosted` covers both directly, so this
 *  screen locks the SAME two controls, never more. Fix #7 (Round 4 correction-path, spec §5.2):
 *  on-account cash "is appliable to a later invoice from the same payment at any time (even after
 *  its batch is POSTED)" — `applyPayment` (applications.ts) itself performs no batch-status check,
 *  and this screen must not add one either, so apply/discount/write-off are deliberately NOT run
 *  through this helper (they stay gated by `receivables.create`/`write_off` alone). Nor is it
 *  applied to voiding one APPLICATION (Fix #11): correcting a misapplication is not editing the
 *  payment list, and `voidApplication` itself performs no batch-status check either.
 *
 *  Voiding the BATCH is now posted-locked too (issue #68) but still computes its own gate below,
 *  because it carries a SECOND reason to be disabled (live payments) and §5.16 wants the tooltip to
 *  name whichever one is actually blocking — "Reopen the batch first" and "Void every payment
 *  first" send the operator to different places. */
function statusLocked(g: Gate, posted: boolean): Gate {
  if (posted) return { allowed: false, disabled: true, title: "Batch is posted" };
  return g;
}

// ---------------------------------------------------------------------------------------------
// ApplyPanel — one payment's apply-and-settle grid (design spec: "apply a payment across one or
// more invoices, including across the divisions of a parent customer"; task-13-brief.md: "an
// amount input, a 'take discount' affordance shown only when discountAvailable > 0, and a
// write-off input (reason required)"). `useBulkGrid` composes the payer's/family's open finalized
// invoices — fetched fresh whenever the panel opens or a submission lands — with whatever the
// operator has typed so far, the `InvoiceLinesGrid` shape (a whole batch of edited rows submitted
// as ONE call), even though these rows are not their own persisted entities: the same "edit
// several rows, then Save sends the lot" architecture applies, and reuses the same
// orphan-detection if the candidate set changes under the operator mid-edit.
// ---------------------------------------------------------------------------------------------

type ApplyLineFields = {
  documentNumber: string; customerCode: string; customerName: string; dueDate: string;
  open: string; discountAvailable: string;
  amount: string; takeDiscount: string; writeOffAmount: string; writeOffReason: string;
};

function toApplyFields(row: OpenInvoiceRow & { discountAvailable: number }): ApplyLineFields {
  return {
    documentNumber: row.documentNumber, customerCode: row.customerCode, customerName: row.customerName,
    dueDate: row.dueDate ?? "", open: String(row.open), discountAvailable: String(row.discountAvailable),
    amount: "", takeDiscount: "false", writeOffAmount: "", writeOffReason: "",
  };
}

function ApplyPanel({
  payment, moneyGate, writeOffGate, voidApplicationGate, onApplied, onError,
}: {
  payment: PaymentRow;
  moneyGate: Gate;
  writeOffGate: Gate;
  /** Fix #11 — gates the per-application "Void" action. Deliberately not `statusLocked`: correcting
   *  a misapplication is not editing the payment list (see `statusLocked`'s own comment). */
  voidApplicationGate: Gate;
  /** Tells the parent to refresh the whole batch (every payment's `onAccount` is derived, so any
   *  successful apply anywhere can move it). */
  onApplied: () => void;
  onError: (message: string | null) => void;
}) {
  const [candidates, setCandidates] = useState<(OpenInvoiceRow & { discountAvailable: number })[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [voidingApplicationId, setVoidingApplicationId] = useState<string | null>(null);
  const latest = useLatest();
  const grid = useBulkGrid<ApplyLineFields>();

  // Two reads per open call: the family's open invoices (`?customerId=`), then — per candidate,
  // in parallel — THIS payment's eligible discount on it (`?paymentId=&invoiceId=`, which also
  // answers with `open`; only `discount` is used here, since the customerId-mode read above is
  // already the fresher of the two open-balance figures at panel-open time).
  const load = useCallback(async () => {
    const t = latest.next();
    let rows: OpenInvoiceRow[];
    try {
      rows = await api<OpenInvoiceRow[]>(`/api/receivables/applications?customerId=${payment.customerId}`);
    } catch (e) {
      if (latest.isCurrent(t)) { setLoadError((e as Error).message); setLoaded(true); }
      return;
    }
    let withDiscount: (OpenInvoiceRow & { discountAvailable: number })[];
    try {
      withDiscount = await Promise.all(rows.map(async (row) => {
        const d = await api<{ open: number; discount: number }>(
          `/api/receivables/applications?paymentId=${payment.id}&invoiceId=${row.id}`);
        return { ...row, discountAvailable: d.discount };
      }));
    } catch (e) {
      if (latest.isCurrent(t)) { setLoadError((e as Error).message); setLoaded(true); }
      return;
    }
    if (!latest.isCurrent(t)) return;
    setCandidates(withDiscount);
    setLoadError(null);
    setLoaded(true);
  }, [payment.customerId, payment.id, latest]);
  useEffect(() => { void load(); }, [load]);

  const rows = grid.compose(candidates, toApplyFields);

  function patchRow(row: { key: string }, patch: Partial<ApplyLineFields>) {
    grid.updateExisting(row.key, patch);
  }

  async function apply() {
    const lines: { invoiceId: string; type: "PAYMENT" | "DISCOUNT" | "WRITE_OFF"; amount: number; reason?: string }[] = [];
    for (const row of rows) {
      const amount = row.amount.trim();
      if (amount !== "") {
        const n = Number(amount);
        if (Number.isNaN(n) || n <= 0) { onError(`${row.documentNumber}: enter a valid payment amount.`); return; }
        lines.push({ invoiceId: row.key, type: "PAYMENT", amount: n });
      }
      if (row.takeDiscount === "true") {
        const d = Number(row.discountAvailable);
        if (d > 0) lines.push({ invoiceId: row.key, type: "DISCOUNT", amount: d });
      }
      const writeOff = row.writeOffAmount.trim();
      if (writeOff !== "") {
        const n = Number(writeOff);
        if (Number.isNaN(n) || n <= 0) { onError(`${row.documentNumber}: enter a valid write-off amount.`); return; }
        if (!row.writeOffReason.trim()) { onError(`${row.documentNumber}: a write-off needs a reason.`); return; }
        lines.push({ invoiceId: row.key, type: "WRITE_OFF", amount: n, reason: row.writeOffReason.trim() });
      }
    }
    if (lines.length === 0) { onError("Enter at least one payment, discount, or write-off amount before applying."); return; }

    setApplying(true);
    try {
      await api("/api/receivables/applications", {
        method: "POST", body: JSON.stringify({ paymentId: payment.id, lines }),
      });
      grid.reset();
      onError(null);
      onApplied();
      await load(); // this payment's own candidates: balances/discounts just moved
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setApplying(false);
    }
  }

  // Fix #11 — void one live application (correcting a mis-applied payment). `voidApplication`
  // (applications.ts) trims and requires the reason itself; this mirrors `voidPaymentAction`'s own
  // prompt/confirm shape below. On success, `onApplied()` refreshes the whole batch — the invoice's
  // open balance and this payment's on-account are both derived, so both update from that one call.
  async function voidApplicationAction(app: PaymentApplicationRow) {
    const reason = prompt(
      `Void the ${APPLICATION_TYPE_LABELS[app.type]} application of ${app.amount.toFixed(2)} against ` +
      `invoice ${app.invoiceDocumentNumber}?\n\nReason for voiding (recorded in the audit history):`,
    );
    if (reason === null) return; // cancelled
    if (!reason.trim()) { onError("A reason is required to void an application."); return; }
    setVoidingApplicationId(app.id);
    try {
      await api(`/api/receivables/applications/${app.id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
      onError(null);
      onApplied();
      await load(); // this payment's own candidates: the voided amount reopens the invoice's balance
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setVoidingApplicationId(null);
    }
  }

  // "the unapplied remainder shown as on-account" (task-13-brief.md) — `onAccount` is already
  // derived server-side (`ar-balances.paymentOnAccount`) and refreshes on every batch reload.
  const applied = payment.amount - payment.onAccount;
  const disabled = applying;

  return (
    <div className="mt-2 rounded border bg-slate-50 p-3">
      <p className="mb-2 text-sm text-slate-600">
        Payment {payment.amount.toFixed(2)} · Applied {applied.toFixed(2)} · On account {payment.onAccount.toFixed(2)}
      </p>
      {payment.applications.length > 0 && (
        <div className="mb-3 overflow-x-auto rounded border bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="py-1 pl-2 pr-2 font-medium">Invoice</th>
                <th className="pr-2 font-medium">Type</th>
                <th className="pr-2 font-medium">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {payment.applications.map((a) => (
                <tr key={a.id} className="border-t">
                  <td className="py-1 pl-2 pr-2 font-mono">{a.invoiceDocumentNumber}</td>
                  <td className="pr-2">{APPLICATION_TYPE_LABELS[a.type]}</td>
                  <td className="pr-2 text-right">{a.amount.toFixed(2)}</td>
                  <td className="pr-2 text-right">
                    <button onClick={() => void voidApplicationAction(a)}
                            disabled={!voidApplicationGate.allowed || voidingApplicationId === a.id}
                            title={voidApplicationGate.title}
                            className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                      {voidingApplicationId === a.id ? "Voiding…" : "Void"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {loadError && <p className="mb-2 text-sm text-red-700">Could not load open invoices: {loadError}</p>}
      {grid.orphanWarning && <p className="mb-2 rounded bg-amber-50 p-2 text-sm text-amber-800">{grid.orphanWarning}</p>}
      {rows.length === 0 && loaded && !loadError && (
        <p className="text-sm text-slate-500">No open invoices for this payer{"'"}s family.</p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="py-1 pr-2 font-medium">Invoice</th>
                <th className="pr-2 font-medium">Customer</th>
                <th className="pr-2 font-medium">Due</th>
                <th className="pr-2 font-medium">Open</th>
                <th className="pr-2 font-medium">Amount</th>
                <th className="pr-2 font-medium">Discount</th>
                <th className="pr-2 font-medium">Write-off</th>
                <th className="pr-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const discountAvailable = Number(row.discountAvailable);
                return (
                  <tr key={row.key} className="border-t">
                    <td className="py-1 pr-2 font-mono">{row.documentNumber}</td>
                    <td className="pr-2">{row.customerCode} · {row.customerName}</td>
                    <td className="pr-2">{row.dueDate}</td>
                    <td className="pr-2 text-right">{Number(row.open).toFixed(2)}</td>
                    <td className="w-24 pr-2">
                      <input value={row.amount} inputMode="decimal" disabled={!moneyGate.allowed || disabled}
                             title={moneyGate.title}
                             onChange={(e) => patchRow(row, { amount: e.target.value })}
                             aria-label={`${row.documentNumber} amount`}
                             className="w-full rounded border px-2 py-1 text-right disabled:cursor-not-allowed disabled:bg-slate-100" />
                    </td>
                    <td className="pr-2">
                      {discountAvailable > 0 && (
                        <label className="flex items-center gap-1 whitespace-nowrap">
                          <input type="checkbox" checked={row.takeDiscount === "true"}
                                 disabled={!moneyGate.allowed || disabled} title={moneyGate.title}
                                 onChange={(e) => patchRow(row, { takeDiscount: e.target.checked ? "true" : "false" })} />
                          Take {discountAvailable.toFixed(2)}
                        </label>
                      )}
                    </td>
                    <td className="w-24 pr-2">
                      <input value={row.writeOffAmount} inputMode="decimal" disabled={!writeOffGate.allowed || disabled}
                             title={writeOffGate.title}
                             onChange={(e) => patchRow(row, { writeOffAmount: e.target.value })}
                             aria-label={`${row.documentNumber} write-off amount`}
                             className="w-full rounded border px-2 py-1 text-right disabled:cursor-not-allowed disabled:bg-slate-100" />
                    </td>
                    <td className="pr-2">
                      <input value={row.writeOffReason} disabled={!writeOffGate.allowed || disabled}
                             title={writeOffGate.title}
                             onChange={(e) => patchRow(row, { writeOffReason: e.target.value })}
                             aria-label={`${row.documentNumber} write-off reason`}
                             className="w-full rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <button onClick={() => void apply()} disabled={!moneyGate.allowed || disabled || rows.length === 0} title={moneyGate.title}
              className="mt-2 rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
        {applying ? "Applying…" : "Apply"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The page itself.
// ---------------------------------------------------------------------------------------------

export function BatchDetail({ id }: { id: string }) {
  const { permissions: perms, error: permsError } = usePermissions();

  const [batch, setBatch] = useState<BatchDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutations = useMutationGate();
  const editGuard = useEditGuard();

  const load = useCallback(async () => {
    const ticket = mutations.next();
    const res = await api<BatchDetailData>(`/api/receivables/batches/${id}`);
    // Captured-session apply inside the accept branch (use-edit-guard.ts, the round-3 fixpoint).
    if (mutations.accept(ticket)) setBatch(editGuard.applyPayload(res));
    return res;
  }, [id, mutations, editGuard]);
  useEffect(() => {
    load().then(() => setError(null)).catch((e) => setError((e as Error).message));
  }, [load]);

  const applyMutation = useCallback(async (run: () => Promise<BatchDetailData>) => {
    const ticket = mutations.next();
    const res = await run();
    if (!mutations.accept(ticket)) return;
    setBatch(editGuard.applyPayload(res));
  }, [mutations, editGuard]);

  const posted = batch?.status === "POSTED";
  const voided = (batch?.deletedAt ?? null) !== null;

  // §5.5/task-13-brief.md Step 2: money-bearing controls take BOTH receivables.create and, for a
  // write-off, `write_off` on top — computed once with the "whichever is actually the blocker"
  // title (the `InvoiceDetail.tsx` moneyGate/priceGate precedent). Apply is an entity-creation
  // (POST /api/receivables/applications gates `create` — owner ruling, review round 1: the apply
  // gate must match the route it calls, not `edit`), consistent with add-payment and create-batch,
  // which already gate on create. Fix #7 (Round 4 correction-path, spec §5.2): NOT run through
  // `statusLocked` — on-account cash stays appliable to a later invoice from the same payment even
  // after the batch is POSTED, and `applyPayment` itself performs no batch-status check (see
  // `statusLocked`'s own comment).
  const applyGateRaw = gate(perms, "receivables.create");
  const writeOffGateRaw = gateDo(perms, "write_off");
  const writeOffDisabled = applyGateRaw.disabled || writeOffGateRaw.disabled;
  const writeOffGateCombined: Gate = {
    allowed: !writeOffDisabled, disabled: writeOffDisabled,
    title: applyGateRaw.disabled ? applyGateRaw.title : writeOffGateRaw.title,
  };
  const moneyGate = applyGateRaw;
  const writeOffGate = writeOffGateCombined;
  const createPaymentGate = statusLocked(gate(perms, "receivables.create"), posted);
  const deletePaymentGate = statusLocked(gate(perms, "receivables.delete"), posted);
  // Fix #11 — void one application (correct a mis-applied payment). Not status-locked: correcting
  // an application is not editing the payment list, and `voidApplication` (applications.ts) itself
  // performs no batch-status check either — matching FIX #7's apply controls, this stays available
  // on a POSTED batch.
  const voidApplicationGate = gate(perms, "receivables.delete");

  const postGate: Gate = voided
    ? { allowed: false, disabled: true, title: "Batch is voided" }
    : posted
      ? { allowed: false, disabled: true, title: "Already posted" }
      : gate(perms, "receivables.edit");
  // The inverse of `postGate` (issue #68) — reopening is only ever available ON a posted batch, and
  // it is the action every other posted-batch refusal now points at, so it must be visible-and-
  // disabled rather than hidden (§5.16) even when there is nothing to reopen.
  const reopenGate: Gate = voided
    ? { allowed: false, disabled: true, title: "Batch is voided" }
    : !posted
      ? { allowed: false, disabled: true, title: "Only a posted batch can be reopened" }
      : gate(perms, "receivables.edit");
  // Two independent blockers, POSTED checked first — the same order `voidBatchInTx` uses, so the
  // tooltip names the guard the server would actually hit. A posted batch told "Void every payment
  // first" would be sent at a control `refusePosted` refuses; "Reopen the batch first" is the one
  // route that unblocks it.
  const voidBatchGate: Gate = voided
    ? { allowed: false, disabled: true, title: "Already voided" }
    : posted
      ? { allowed: false, disabled: true, title: "Reopen the batch first" }
      : (batch?.payments.length ?? 0) > 0
        ? { allowed: false, disabled: true, title: "Void every payment first" }
        : gate(perms, "receivables.delete");

  // Payer picker (Add payment form) — customers.view, the `InvoicingList.tsx` customer-filter
  // precedent: fetched only once the caller is known to hold it, never left silently empty.
  const customersGate = gate(perms, "customers.view");
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers).catch((e) => setError((e as Error).message));
  }, [customersGate.allowed]);

  // Payment-type picker — session-only picklist (`customers/[id]/page.tsx` Terms precedent): any
  // signed-in user, no extra permission beyond having reached this page.
  const [paymentTypes, setPaymentTypes] = useState<PickListRow[]>([]);
  useEffect(() => {
    api<PickListRow[]>("/api/picklists/paymentType").then(setPaymentTypes)
      .catch((e) => setError((e as Error).message));
  }, []);

  // ---- Add payment ----

  const [payCustomerId, setPayCustomerId] = useState("");
  const [payTypeId, setPayTypeId] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payReference, setPayReference] = useState("");
  const [payReceivedDate, setPayReceivedDate] = useState("");
  const [addingPayment, setAddingPayment] = useState(false);

  async function addPayment() {
    if (!payCustomerId || !payTypeId || !payAmount.trim() || !payReceivedDate) {
      setError("Payer customer, payment type, amount, and received date are all required to add a payment.");
      return;
    }
    setAddingPayment(true);
    try {
      await applyMutation(() => api<BatchDetailData>(`/api/receivables/batches/${id}/payments`, {
        method: "POST",
        body: JSON.stringify({
          customerId: payCustomerId, paymentTypeId: payTypeId, amount: payAmount,
          reference: payReference, receivedDate: payReceivedDate,
        }),
      }));
      setPayCustomerId(""); setPayTypeId(""); setPayAmount(""); setPayReference(""); setPayReceivedDate("");
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAddingPayment(false);
    }
  }

  // ---- Void payment ----

  async function voidPaymentAction(payment: PaymentRow) {
    const reason = prompt(
      `Void the ${payment.paymentTypeName} payment of ${payment.amount.toFixed(2)} from ` +
      `${payment.customerCode}?\n\nReason for voiding (recorded in the audit history):`,
    );
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to void a payment."); return; }
    try {
      await applyMutation(() => api<BatchDetailData>(`/api/receivables/batches/${id}/payments/${payment.id}`, {
        method: "DELETE", body: JSON.stringify({ reason }),
      }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // ---- Post / void batch ----

  async function postBatchAction() {
    if (!batch) return;
    if (!confirm(`Post batch #${batch.batchNumber}? Once posted, no further payments can be added or voided.`)) return;
    try {
      await applyMutation(() => api<BatchDetailData>(`/api/receivables/batches/${id}`, { method: "PATCH" }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // POSTED -> OPEN (issue #68). Reason-prompted like `voidBatchAction`, because it un-settles cash
  // and the service refuses a blank one; optimistic like `postBatchAction`, because the route
  // returns the fresh detail.
  async function reopenBatchAction() {
    if (!batch) return;
    const reason = prompt(
      `Reopen batch #${batch.batchNumber}?\n\n` +
      `Its payments stop counting as posted cash until it is posted again.\n\n` +
      `Reason for reopening (recorded in the audit history):`);
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to reopen a batch."); return; }
    try {
      await applyMutation(() => api<BatchDetailData>(`/api/receivables/batches/${id}/reopen`, {
        method: "POST", body: JSON.stringify({ reason }),
      }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Non-optimistic: DELETE returns `{ ok: true }`, not a fresh detail — picking up `deletedAt`
  // needs a follow-up `load()` (the `InvoiceDetail.tsx` `discard` precedent, two separate
  // try/catches so a load failure after a successful void doesn't read as the void itself failing).
  async function voidBatchAction() {
    if (!batch) return;
    const reason = prompt(`Void batch #${batch.batchNumber}?\n\nReason for voiding (recorded in the audit history):`);
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to void a batch."); return; }
    try {
      await api(`/api/receivables/batches/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setError(null);
    try {
      await load();
    } catch (e) {
      setError(`Batch voided, but the page could not be refreshed — reload to see the current state. (${(e as Error).message})`);
    }
  }

  const [expandedPaymentId, setExpandedPaymentId] = useState<string | null>(null);

  if (!batch) return <div className="p-6">{error ?? permsError ?? "Loading…"}</div>;

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">
          Batch #{batch.batchNumber}
          <span className="ml-3 rounded bg-slate-100 px-2 py-0.5 text-base font-normal text-slate-600">
            {RECEIPT_BATCH_STATUS_LABELS[batch.status]}
          </span>
          {voided && (
            <span className="ml-2 rounded bg-slate-200 px-2 py-0.5 text-base font-normal text-slate-700">
              Voided
            </span>
          )}
        </h1>
        <div className="flex items-center gap-2">
          <button onClick={() => void postBatchAction()} disabled={!postGate.allowed} title={postGate.title}
                  className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
            Post
          </button>
          <button onClick={() => void reopenBatchAction()} disabled={!reopenGate.allowed} title={reopenGate.title}
                  className="rounded border border-slate-800 px-3 py-1.5 text-sm text-slate-800 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400">
            Reopen
          </button>
          <button onClick={() => void voidBatchAction()} disabled={!voidBatchGate.allowed} title={voidBatchGate.title}
                  className="rounded border border-red-600 px-3 py-1.5 text-sm text-red-600 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400">
            Void
          </button>
        </div>
      </div>

      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      {voided && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm font-medium text-red-700">
          Voided — see History below for the reason.
        </p>
      )}

      {/* ---- Header / live balance ---- */}
      <section className="mb-6 rounded border bg-white p-4">
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div className="block">
            Deposit date
            <div className="mt-1 rounded border bg-slate-50 px-2 py-1">{batch.depositDate}</div>
          </div>
          <div className="block">
            Control total
            <div className="mt-1 rounded border bg-slate-50 px-2 py-1">
              {batch.controlTotal === null ? "—" : batch.controlTotal.toFixed(2)}
            </div>
          </div>
          <div className="block">
            Entered
            <div className="mt-1 rounded border bg-slate-50 px-2 py-1">{batch.enteredTotal.toFixed(2)}</div>
          </div>
          <div className="block">
            Balance
            <div className={`mt-1 rounded border px-2 py-1 ${batch.balance === 0 ? "bg-slate-50" : "bg-amber-50 text-amber-800"}`}>
              {batch.balance.toFixed(2)}
            </div>
          </div>
        </div>
      </section>

      {/* ---- Add payment ---- */}
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Add payment</h2>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block">
            Payer customer
            <select value={payCustomerId} disabled={!createPaymentGate.allowed || !customersGate.allowed}
                    title={!createPaymentGate.allowed ? createPaymentGate.title : customersGate.title}
                    onChange={(e) => setPayCustomerId(e.target.value)}
                    className="mt-1 block rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
              <option value="">Select…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </select>
          </label>
          <label className="block">
            Payment type
            <select value={payTypeId} disabled={!createPaymentGate.allowed} title={createPaymentGate.title}
                    onChange={(e) => setPayTypeId(e.target.value)}
                    className="mt-1 block rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100">
              <option value="">Select…</option>
              {paymentTypes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="block">
            Amount
            <input value={payAmount} inputMode="decimal" disabled={!createPaymentGate.allowed} title={createPaymentGate.title}
                   onChange={(e) => setPayAmount(e.target.value)}
                   className="mt-1 block rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100" />
          </label>
          <label className="block">
            Check #
            <input value={payReference} disabled={!createPaymentGate.allowed} title={createPaymentGate.title}
                   onChange={(e) => setPayReference(e.target.value)}
                   className="mt-1 block rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100" />
          </label>
          <label className="block">
            Received date
            {/* #73: the server refuses a future receivedDate (payments post after the deposit is
                in hand) — `max` keeps the picker honest up front. */}
            <input type="date" value={payReceivedDate} max={formatDateOnly(todayDateOnly())}
                   disabled={!createPaymentGate.allowed} title={createPaymentGate.title}
                   onChange={(e) => setPayReceivedDate(e.target.value)}
                   className="mt-1 block rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100" />
          </label>
          <button onClick={() => void addPayment()} disabled={!createPaymentGate.allowed || addingPayment} title={createPaymentGate.title}
                  className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
            {addingPayment ? "Adding…" : "Add payment"}
          </button>
        </div>
      </section>

      {/* ---- Payments + apply ---- */}
      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Payments</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="py-1 pr-2 font-medium">Customer</th>
                <th className="pr-2 font-medium">Type</th>
                <th className="pr-2 font-medium">Amount</th>
                <th className="pr-2 font-medium">Check #</th>
                <th className="pr-2 font-medium">Received</th>
                <th className="pr-2 font-medium">On account</th>
                <th />
                <th />
              </tr>
            </thead>
            <tbody>
              {batch.payments.map((p) => (
                <Fragment key={p.id}>
                  <tr className="border-t">
                    <td className="py-1 pr-2">{p.customerCode} · {p.customerName}</td>
                    <td className="pr-2">{p.paymentTypeName}</td>
                    <td className="pr-2 text-right">{p.amount.toFixed(2)}</td>
                    <td className="pr-2">{p.reference}</td>
                    <td className="pr-2">{p.receivedDate}</td>
                    <td className="pr-2 text-right">{p.onAccount.toFixed(2)}</td>
                    <td className="pr-2">
                      {/* Not permission-gated: expanding shows a read-only view built from
                          receivables.view-gated data the operator already needed to reach this
                          page — the write-side controls inside are what carry the money gates. */}
                      <button onClick={() => setExpandedPaymentId(expandedPaymentId === p.id ? null : p.id)}
                              className="text-xs text-blue-700 underline">
                        {expandedPaymentId === p.id ? "Hide" : "Apply"}
                      </button>
                    </td>
                    <td>
                      <button onClick={() => void voidPaymentAction(p)} disabled={!deletePaymentGate.allowed} title={deletePaymentGate.title}
                              className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                        Void
                      </button>
                    </td>
                  </tr>
                  {expandedPaymentId === p.id && (
                    <tr>
                      <td colSpan={8}>
                        <ApplyPanel payment={p} moneyGate={moneyGate} writeOffGate={writeOffGate}
                                    voidApplicationGate={voidApplicationGate}
                                    onApplied={() => {
                                      // #146 — the outer `load` rethrows (only its mount effect
                                      // catches), so a network blip HERE after a successful
                                      // apply was an unhandled rejection + a silently stale
                                      // page. Reported the way voidBatchAction's own second
                                      // try/catch does; wording is generic because both
                                      // apply() and voidApplicationAction() fire this.
                                      load().catch((e) => setError(
                                        `The operation succeeded, but the page could not be refreshed — reload to see the current state. (${(e as Error).message})`,
                                      ));
                                    }} onError={setError} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {batch.payments.length === 0 && (
                <tr><td colSpan={8} className="p-4 text-center text-slate-400">No payments yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="mb-6">
        <HistoryPanel entity="receiptBatch" entityId={id} />
      </div>
    </div>
  );
}
