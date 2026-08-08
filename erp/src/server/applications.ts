import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedSoftDelete } from "./audit";
import { decimalField } from "./decimal-field";
import { claimOrder, claimOrdersInOrder, sortedClaimIds } from "./order-locks";
import { invoiceOpenBalance, paymentOnAccount, type ApplicationLite } from "./ar-balances";
import { addDays, formatDateOnly } from "../lib/business-days";

// -------------------------------------------------------------------------------------------
// Task 7 (P5B §4.1/§4.2): the single cash write path. Every reduction of an invoice's open
// balance — a PAYMENT, an early-pay DISCOUNT, or a WRITE_OFF — is one `Application` row, and this
// is the only file that writes them (Task 8 extends it with CREDIT application). No balance is
// ever cached: `ar-balances.ts` derives every open balance / on-account from the live rows, so
// this file's only jobs are the row claims that serialize concurrent applications and the
// over-application / discount-window rules that decide whether a line may be written at all.
//
// THE CLAIM (global-constraints.md, the 5A invoice-mutation discipline). A payment can settle
// several invoices at once — across a parent's divisions, so cross-customer — so the claim is the
// multi-order shape, never a per-invoice loop:
//   1. An UNLOCKED stub read to learn each target invoice's `orderId` and validate it is a live
//      FINALIZED INVOICE (the `shippers.ts`/`claimInvoiceRow` "stub read to learn which order to
//      claim" precedent — `orderId`/`kind` never change once an invoice exists, so a bare read is
//      safe for them; the guarded state is re-read under the locks below).
//   2. `claimOrdersInOrder(tx, orderIds)` — ONE sorted statement over the deduplicated, ascending
//      order ids behind the invoices (order-locks.ts), so a payment touching orders {A,B} and one
//      touching {B,A} can never form the ABBA cycle a per-order loop would.
//   3. The invoice rows themselves, in ONE sorted `FOR UPDATE` statement mirroring
//      `claimOrdersInOrder`'s shape — claimed AFTER the order claims, uniformly (one fixed lock
//      order: orders, then invoices), so no new ABBA window opens. The guarded balance is derived
//      from `Application` rows keyed to the invoice, so the INVOICE ROW is the lock that serializes
//      applications to it — the invoice-row claim, NOT the Serializable isolation, is what makes
//      the over-application check and the write it guards see the same state.
//   4. The payment row `FOR UPDATE`, last and uniform — the payment-on-account invariant
//      (Σ live PAYMENT applications ≤ payment.amount) is keyed to `paymentId`, so two applications
//      spending the SAME payment against DIFFERENT invoices — which share no invoice or order lock
//      — serialize here instead (the house rule: the guarded state must be locked with a claimed
//      row).
// The transaction runs Serializable to pair with the FK-writer reads on the invoice/payment rows,
// exactly as every 5A/5B mutator does — but the row claims, never the isolation level, are what
// protect the invariants (never present isolation as the lock).
// -------------------------------------------------------------------------------------------

type Db = Prisma.TransactionClient;

const cents = (n: number): number => Math.round(n * 100);

/** CRITICAL (Task 5 carry): `Application.amount` is a Prisma `Decimal`; every value crossing into
 *  `ar-balances` must be `.toNumber()`'d first. */
const toLite = (a: { amount: Prisma.Decimal; type: ApplicationLite["type"]; deletedAt: Date | null }): ApplicationLite =>
  ({ amount: a.amount.toNumber(), type: a.type, deletedAt: a.deletedAt });

// -------------------------------------------------------------------------------------------
// discountAvailable — the early-pay window (§4.3). Terms carry a discount iff BOTH `discountPercent`
// and `discountDays` are set; the window is open iff the payment was received on or before
// `invoiceDate + discountDays` calendar days (`addDays`, not business days — a terms deadline is a
// calendar date, the `dueDate` precedent). The eligible amount is `discountPercent% × the invoice's
// open balance`, integer-cent half-up. Zero out of window, zero with no terms discount.
// -------------------------------------------------------------------------------------------

type DiscountTerms = { discountPercent: Prisma.Decimal | null; discountDays: number | null };

/** Pure over already-read state — one definition shared by the public `discountAvailable` (which
 *  reads that state) and the DISCOUNT guard inside `applyPayment` (which already holds it under the
 *  claim), so the two can never drift. `settledOpen` is the invoice's open balance in dollars. */
function discountFor(terms: DiscountTerms | null, invoiceDate: Date, receivedDate: Date, settledOpen: number): number {
  if (!terms || terms.discountPercent === null || terms.discountDays === null) return 0;
  const deadline = addDays(invoiceDate, terms.discountDays);
  if (receivedDate.getTime() > deadline.getTime()) return 0;
  // Integer-cent, half-up: percent (2 = 2%) on the open-balance cents, then back to dollars.
  return Math.round((cents(settledOpen) * terms.discountPercent.toNumber()) / 100) / 100;
}

export async function discountAvailable(paymentId: string, invoiceId: string): Promise<number> {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId }, select: { receivedDate: true },
  });
  if (!payment) throw new HttpError(404, "Payment not found");
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId },
    select: {
      invoiceDate: true, total: true,
      customer: { select: { terms: { select: { discountPercent: true, discountDays: true } } } },
      applications: { where: { deletedAt: null }, select: { amount: true, type: true, deletedAt: true } },
    },
  });
  if (!invoice) throw new HttpError(404, "Invoice not found");
  const open = invoiceOpenBalance(invoice.total.toNumber(), invoice.applications.map(toLite));
  return discountFor(invoice.customer.terms, invoice.invoiceDate, payment.receivedDate, open);
}

// -------------------------------------------------------------------------------------------
// applyPayment — one call, one claim, many lines. See THE CLAIM above.
// -------------------------------------------------------------------------------------------

const APPLY = z.object({
  paymentId: z.string().min(1),
  lines: z.array(z.object({
    invoiceId: z.string().min(1),
    type: z.enum(["PAYMENT", "DISCOUNT", "WRITE_OFF"]),
    amount: decimalField(12, 2, { required: true, min: "positive" }),
    reason: z.string().max(4000).optional(),
  })).min(1),
}).strict();

type ApplyInput = z.infer<typeof APPLY>;
type ApplyLine = ApplyInput["lines"][number];

const INVOICE_CLAIM_SELECT = {
  id: true, total: true, invoiceDate: true,
  customer: { select: { terms: { select: { discountPercent: true, discountDays: true } } } },
  order: { select: { orderNumber: true } },
  applications: { where: { deletedAt: null }, select: { amount: true, type: true, deletedAt: true } },
} satisfies Prisma.InvoiceSelect;

type ClaimedInvoice = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_CLAIM_SELECT }>;

async function applyPaymentInTx(tx: Db, data: ApplyInput): Promise<void> {
  // (1) UNLOCKED stub reads — learn each target invoice's order, validate its liveness/kind/status.
  // `orderId`/`kind`/`status` cannot be trusted from here for the WRITE, but `orderId` never
  // changes (nothing updates it) so it is safe to CLAIM on; the guarded state (total + live
  // applications) is re-read under the locks below. A discarded/draft/credit target is refused now
  // so no lock is taken for a target that can never be paid.
  const invoiceIds = [...new Set(data.lines.map((l) => l.invoiceId))];
  const stubs = await tx.invoice.findMany({
    where: { id: { in: invoiceIds } },
    select: { id: true, orderId: true, kind: true, status: true, deletedAt: true },
  });
  const stubById = new Map(stubs.map((s) => [s.id, s]));
  for (const id of invoiceIds) {
    const stub = stubById.get(id);
    if (!stub || stub.deletedAt !== null) throw new HttpError(404, "Invoice not found");
    if (stub.kind !== "INVOICE") {
      throw new HttpError(400, "That document is a credit, not an invoice — a payment applies to an invoice");
    }
    if (stub.status !== "FINALIZED") {
      throw new HttpError(400, "That invoice is not finalized — only a finalized invoice can take a payment");
    }
  }

  const paymentStub = await tx.payment.findFirst({
    where: { id: data.paymentId }, select: { id: true, deletedAt: true },
  });
  if (!paymentStub || paymentStub.deletedAt !== null) throw new HttpError(404, "Payment not found");

  // (2) Claim the orders behind the invoices — one sorted statement, dedup + ascending.
  await claimOrdersInOrder(tx, stubs.map((s) => s.orderId));

  // (3) Claim the invoice rows — one sorted `FOR UPDATE` statement, the SAME shape (this is the
  // lock that serializes applications to each invoice). `sortedClaimIds` dedups + sorts so the
  // statement is identical in form to `claimOrdersInOrder`'s.
  const sortedInvoiceIds = sortedClaimIds(invoiceIds);
  await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ANY(${sortedInvoiceIds}) ORDER BY "id" FOR UPDATE`;

  // (4) Claim the payment row last — the payment-on-account invariant is keyed here.
  await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${data.paymentId} FOR UPDATE`;

  // Now read the state the locks guard: the payment's amount + received date, and each invoice's
  // total, invoiceDate, terms, order number, and LIVE applications.
  const payment = await tx.payment.findFirstOrThrow({
    where: { id: data.paymentId }, select: { amount: true, receivedDate: true },
  });
  const invoices = await tx.invoice.findMany({ where: { id: { in: invoiceIds } }, select: INVOICE_CLAIM_SELECT });
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));

  // (5) Validate every line BEFORE any write — a refusal rolls the whole call back, and the
  // over-application message must name the open balance available to the offending line. Running
  // applied-cents per invoice starts from the existing live sum and grows as this call's earlier
  // lines settle the same invoice.
  const appliedCents = new Map<string, number>(); // invoiceId -> Σ live + this-call-so-far, in cents
  for (const inv of invoices) {
    appliedCents.set(inv.id, inv.applications.reduce((s, a) => s + cents(a.amount.toNumber()), 0));
  }

  const resolved: { line: ApplyLine; invoice: ClaimedInvoice; reason: string }[] = [];
  let paymentLinesCents = 0;

  for (const line of data.lines) {
    const inv = invoiceById.get(line.invoiceId)!; // present — validated in the stub pass
    const lineCents = cents(line.amount);

    // Over-application against the invoice: Σ applications must never exceed the invoice total.
    const totalCents = cents(inv.total.toNumber());
    const alreadyCents = appliedCents.get(inv.id)!;
    const openCents = totalCents - alreadyCents;
    if (lineCents > openCents) {
      throw new HttpError(400, `That exceeds the invoice's open balance of ${openCents / 100}`);
    }

    const reason = resolveReason(line, inv, payment.receivedDate);

    if (line.type === "PAYMENT") paymentLinesCents += lineCents;
    appliedCents.set(inv.id, alreadyCents + lineCents);
    resolved.push({ line, invoice: inv, reason });
  }

  // Over-application of the payment: Σ new PAYMENT lines must fit the payment's remaining
  // on-account (amount − Σ existing live PAYMENT applications). No prepayments — on-account is only
  // ever an unapplied receipt, never a negative payment.
  const paymentApps = await tx.application.findMany({
    where: { paymentId: data.paymentId, deletedAt: null }, select: { amount: true, type: true, deletedAt: true },
  });
  const availableCents = cents(paymentOnAccount(payment.amount.toNumber(), paymentApps.map(toLite)));
  if (paymentLinesCents > availableCents) {
    throw new HttpError(400, `That exceeds the payment's unapplied amount of ${availableCents / 100}`);
  }

  // (6) Write every line. `appliedDate` = the payment's received date — the A/R-effective date the
  // point-in-time aging filter reads (Task 10). (A standalone bad-debt WRITE_OFF with NO payment
  // would use `todayDateOnly()`; `applyPayment` always carries a payment, so it is the received
  // date here.)
  const appliedDate = payment.receivedDate;
  for (const { line, invoice, reason } of resolved) {
    const auditData = {
      invoiceId: line.invoiceId, invoiceOrderNumber: invoice.order.orderNumber,
      type: line.type, amount: line.amount, reason,
      paymentId: data.paymentId, appliedDate: formatDateOnly(appliedDate),
    };
    await auditedCreate("application", auditData, () => tx.application.create({
      data: {
        invoiceId: line.invoiceId, amount: line.amount, type: line.type, reason,
        paymentId: data.paymentId, appliedDate,
      },
      select: { id: true },
    }), { tx });
  }
}

/** The per-type reason rule: a WRITE_OFF requires a trimmed reason (§4.1); a DISCOUNT must fall
 *  inside the early-pay window and always carries "early-pay terms"; a PAYMENT carries whatever
 *  (optional) note was sent. */
function resolveReason(line: ApplyLine, invoice: ClaimedInvoice, receivedDate: Date): string {
  if (line.type === "WRITE_OFF") {
    const why = (line.reason ?? "").trim();
    if (!why) throw new HttpError(400, "a write-off needs a reason");
    return why;
  }
  if (line.type === "DISCOUNT") {
    const open = invoiceOpenBalance(invoice.total.toNumber(), invoice.applications.map(toLite));
    if (discountFor(invoice.customer.terms, invoice.invoiceDate, receivedDate, open) <= 0) {
      throw new HttpError(400, "no early-pay discount applies");
    }
    return "early-pay terms";
  }
  return (line.reason ?? "").trim();
}

/**
 * `applyPayment` (§4.1). `tx` is optional — the public path opens its own Serializable transaction;
 * the discriminating concurrency test passes a manually-opened (Read Committed) transaction so the
 * INVOICE-ROW claim, not SSI, is what serializes a competing caller (the `createInvoice`/
 * `finalizeInvoice` shape).
 */
export async function applyPayment(input: unknown, tx?: Prisma.TransactionClient): Promise<void> {
  const data = APPLY.parse(input);
  if (tx) { await applyPaymentInTx(tx, data); return; }
  await withDbErrors({ entity: "Application" }, () => prisma.$transaction(
    (fresh) => applyPaymentInTx(fresh, data),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

// -------------------------------------------------------------------------------------------
// voidApplication — soft-delete under the invoice claim; the voided row drops out of every
// ar-balances sum, restoring the invoice open balance and (for a PAYMENT) the payment on-account,
// with no compensating write. Claim the invoice's order then the invoice row — the same order/
// invoice discipline every application takes — before re-reading and deleting.
// -------------------------------------------------------------------------------------------

async function voidApplicationInTx(tx: Db, id: string, reason: string): Promise<void> {
  // Unlocked stub — learn which invoice (hence which order) to claim; `invoiceId` never changes.
  const stub = await tx.application.findFirst({ where: { id }, select: { invoiceId: true } });
  if (!stub) throw new HttpError(404, "Application not found");
  const invoiceStub = await tx.invoice.findFirst({ where: { id: stub.invoiceId }, select: { orderId: true } });
  if (!invoiceStub) throw new HttpError(404, "Application not found");

  await claimOrder(tx, invoiceStub.orderId);
  await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${stub.invoiceId} FOR UPDATE`;

  // Re-read under the claim: the ordinary "already voided" 404 (auditedSoftDelete's own atomic
  // `updateMany` is the real guard, but the pre-check gives the well-labelled 404).
  const live = await tx.application.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!live) throw new HttpError(404, "Application not found");

  await auditedSoftDelete("application", id, reason, tx);
}

export async function voidApplication(id: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to void an application");
  await withDbErrors({ entity: "Application" }, () => prisma.$transaction(
    (tx) => voidApplicationInTx(tx, id, why),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}
