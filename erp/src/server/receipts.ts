import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors, retryAllocation } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";
import { allocateNumber, getSetting } from "./settings";
import { parseDateOnly, formatDateOnly, todayDateOnly } from "../lib/business-days";
import { paymentOnAccount, type ApplicationLite } from "./ar-balances";
import { assertPeriodOpen } from "./period-locks";
import type { ReceiptBatchStatusValue, ApplicationTypeValue } from "../lib/ar-constants";

// -------------------------------------------------------------------------------------------
// Task 6 (P5B §4.1/§4.2): a ReceiptBatch is a deposit session holding many Payments. Neither
// table stores a balance — `enteredTotal` (Σ live payment amounts) and `balance`
// (`controlTotal ?? enteredTotal` minus `enteredTotal`, zero when it foots or no control total
// was set) are recomputed on every read, the same "derive from live rows" rule ar-balances.ts
// enforces for Invoice/Payment/Credit. A payment's own `onAccount` is `ar-balances.
// paymentOnAccount` over its (currently always empty — Task 7 builds applications) live
// Application rows.
//
// `ReceiptBatch.status` is a plain `String` column, not a Prisma enum (schema comment) — POSTED
// locks payment entry, enforced under a row claim taken the same way `claimOrder` takes one
// (order-locks.ts): a raw `SELECT … FOR UPDATE` by id, then the ordinary client reads the row
// that lock now guards. `createBatch`/`addPayment` run Serializable to pair with `assertRefExists`
// on every FK a payment assigns (the FK-writer pattern; the claim, not the isolation level, is
// what actually serializes concurrent posts/adds/voids against the same batch).
// -------------------------------------------------------------------------------------------

type Db = Prisma.TransactionClient;

/** `parseDateOnly` at the service boundary — the `invoices.ts`/`shippers.ts` `parseDate` precedent. */
function parseDate(value: string, field: string): Date {
  try {
    return parseDateOnly(value);
  } catch {
    throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${field}`);
  }
}

/** One live application against a payment — Fix #11 (Round 4 correction-path): the batch-apply
 *  screen has no way to show, let alone void, what a payment has already settled without this.
 *  `invoiceDocumentNumber` is the `invoices.ts`/`applications.ts` prefix + order-number rule,
 *  duplicated here (private in both already; the established precedent for this small a
 *  computation rather than a cross-module import) — a DISCOUNT/WRITE_OFF targets an invoice the
 *  same way a PAYMENT does, so all three read it identically. */
export type PaymentApplicationRow = {
  id: string; type: ApplicationTypeValue; amount: number; invoiceId: string; invoiceDocumentNumber: string;
};

export type PaymentRow = {
  id: string; customerId: string; customerCode: string; customerName: string;
  paymentTypeId: string; paymentTypeName: string; amount: number; reference: string; receivedDate: string;
  onAccount: number; applications: PaymentApplicationRow[];
};

export type BatchDetail = {
  id: string; batchNumber: number; depositDate: string; controlTotal: number | null;
  status: ReceiptBatchStatusValue; enteredTotal: number; balance: number; notes: string;
  payments: PaymentRow[]; deletedAt: string | null;
};

// -------------------------------------------------------------------------------------------
// Read side — live payments only (a voided payment carries no `deletedAt` field on `PaymentRow`
// to render as struck-through; it simply drops out, the way a voided Application drops out of
// every ar-balances sum). `enteredTotal`/`balance` are therefore plain sums over what this
// include already filtered to live rows.
// -------------------------------------------------------------------------------------------

const DETAIL_INCLUDE = {
  payments: {
    where: { deletedAt: null },
    orderBy: { createdAt: "asc" },
    include: {
      customer: { select: { code: true, name: true } },
      paymentType: { select: { name: true } },
      // Unfiltered (no `where: { deletedAt: null }`) — `paymentOnAccount` needs every application,
      // live or voided, to filter internally (its own documented behavior); the LIVE-only list the
      // UI shows (`PaymentRow.applications`, Fix #11) is filtered from this same fetch in
      // `toPaymentRow` rather than run as a second query. `invoice.order.orderNumber` is what
      // `invoiceDocumentNumber` is built from below.
      applications: {
        select: {
          id: true, amount: true, type: true, deletedAt: true, invoiceId: true,
          invoice: { select: { order: { select: { orderNumber: true } } } },
        },
      },
    },
  },
} satisfies Prisma.ReceiptBatchInclude;

type DetailRow = Prisma.ReceiptBatchGetPayload<{ include: typeof DETAIL_INCLUDE }>;
type PaymentRowShape = DetailRow["payments"][number];

const cents = (n: number): number => Math.round(n * 100);

/** CRITICAL (Task 5 carry): `Payment.amount`/`Application.amount` are Prisma `Decimal` — every
 *  value crossing into `ar-balances` or a `number`-typed row must be `.toNumber()`'d first.
 *  `prefix` is the `invoice_number_prefix` setting, read once per batch (`readBatchDetail`) and
 *  threaded through — a blank prefix prints the bare order number, the `invoices.ts`/
 *  `applications.ts` rule. */
function toPaymentRow(p: PaymentRowShape, prefix: string): PaymentRow {
  const apps: ApplicationLite[] = p.applications.map((a) => ({
    amount: a.amount.toNumber(), type: a.type, deletedAt: a.deletedAt,
  }));
  const amount = p.amount.toNumber();
  const applications: PaymentApplicationRow[] = p.applications
    .filter((a) => a.deletedAt === null)
    .map((a) => ({
      id: a.id, type: a.type, amount: a.amount.toNumber(), invoiceId: a.invoiceId,
      invoiceDocumentNumber: prefix === "" ? String(a.invoice.order.orderNumber) : `${prefix} - ${a.invoice.order.orderNumber}`,
    }));
  return {
    id: p.id, customerId: p.customerId, customerCode: p.customer.code, customerName: p.customer.name,
    paymentTypeId: p.paymentTypeId, paymentTypeName: p.paymentType.name,
    amount, reference: p.reference, receivedDate: formatDateOnly(p.receivedDate),
    onAccount: paymentOnAccount(amount, apps), applications,
  };
}

/** `enteredTotal` = Σ live payment amounts (integer-cents, the `ar-balances` rounding rule);
 *  `balance` = `(controlTotal ?? enteredTotal) − enteredTotal`, zero when it foots or no control
 *  total was ever set. */
function toBatchDetail(row: DetailRow, prefix: string): BatchDetail {
  const payments = row.payments.map((p) => toPaymentRow(p, prefix));
  const enteredCents = payments.reduce((sum, p) => sum + cents(p.amount), 0);
  const enteredTotal = enteredCents / 100;
  const controlTotal = row.controlTotal === null ? null : row.controlTotal.toNumber();
  const controlCents = controlTotal === null ? enteredCents : cents(controlTotal);
  const balance = (controlCents - enteredCents) / 100;
  return {
    id: row.id, batchNumber: row.batchNumber, depositDate: formatDateOnly(row.depositDate),
    controlTotal, status: row.status as ReceiptBatchStatusValue,
    enteredTotal, balance, notes: row.notes,
    payments, deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

/** Exported-shape reader on either the top-level client or a `tx` — the `readInvoiceDetail`
 *  precedent (invoices.ts). Never filters `deletedAt` at the batch level: a voided batch stays
 *  readable (the `discardInvoice`/`readInvoiceDetail` "frozen paper stays visible" rule). */
async function readBatchDetail(db: Db, id: string): Promise<BatchDetail> {
  const [row, prefix] = await Promise.all([
    db.receiptBatch.findFirst({ where: { id }, include: DETAIL_INCLUDE }),
    getSetting("invoice_number_prefix", db),
  ]);
  if (!row) throw new HttpError(404, "Receipt batch not found");
  return toBatchDetail(row, prefix);
}

export async function getBatch(id: string): Promise<BatchDetail> {
  return readBatchDetail(prisma, id);
}

// -------------------------------------------------------------------------------------------
// listBatches — Task 13's worklist ("open batches + a filter, each row linking to the batch
// detail"). Not part of the original Task 6 surface: `createBatch`/`getBatch` cover opening one
// batch and reading it back by id, but nothing before this listed them — the same gap
// `listInvoices` (invoices.ts) fills for Invoice, added here after the fact for the same reason.
// A leaner row than `BatchDetail` — no per-payment detail, just the batch-level totals the
// worklist table shows — the `InvoiceListRow`/`listInvoices` precedent (thin summary row; the
// single-batch GET is still the source of full detail). Filters to live batches only (a voided
// batch drops off the worklist but stays readable at its own url — the `listInvoices`
// `deletedAt: null` precedent, invoices.ts's own comment: "a discarded draft is never shown in
// the list but its own page still reads it").
// -------------------------------------------------------------------------------------------

export type BatchListRow = {
  id: string; batchNumber: number; depositDate: string; controlTotal: number | null;
  status: ReceiptBatchStatusValue; enteredTotal: number; balance: number;
};

export type BatchFilter = { status?: ReceiptBatchStatusValue };

const LIST_INCLUDE = {
  payments: { where: { deletedAt: null }, select: { amount: true } },
} satisfies Prisma.ReceiptBatchInclude;

type ListRow = Prisma.ReceiptBatchGetPayload<{ include: typeof LIST_INCLUDE }>;

function toBatchListRow(row: ListRow): BatchListRow {
  const enteredCents = row.payments.reduce((sum, p) => sum + cents(p.amount.toNumber()), 0);
  const enteredTotal = enteredCents / 100;
  const controlTotal = row.controlTotal === null ? null : row.controlTotal.toNumber();
  const controlCents = controlTotal === null ? enteredCents : cents(controlTotal);
  const balance = (controlCents - enteredCents) / 100;
  return {
    id: row.id, batchNumber: row.batchNumber, depositDate: formatDateOnly(row.depositDate),
    controlTotal, status: row.status as ReceiptBatchStatusValue, enteredTotal, balance,
  };
}

/** Newest deposit first — the worklist's natural order (most recent activity at the top, the
 *  `listInvoices` `orderBy: invoiceDate desc` precedent). */
export async function listBatches(filter: BatchFilter = {}): Promise<BatchListRow[]> {
  const rows = await prisma.receiptBatch.findMany({
    where: { deletedAt: null, ...(filter.status ? { status: filter.status } : {}) },
    include: LIST_INCLUDE,
    orderBy: [{ depositDate: "desc" }, { batchNumber: "desc" }],
  });
  return rows.map(toBatchListRow);
}

// -------------------------------------------------------------------------------------------
// The batch claim — every mutator (`addPayment`, `voidPayment`, `postBatch`, `voidBatch`) takes
// this FIRST, then reads `status`/live payments off the row it now holds. Raw id-only lock, then
// the ordinary client reads the full row — exactly `claimOrder`'s shape (order-locks.ts).
// -------------------------------------------------------------------------------------------

async function claimBatch(
  tx: Db, id: string,
): Promise<{ id: string; status: string; controlTotal: Prisma.Decimal | null; deletedAt: Date | null } | null> {
  await tx.$queryRaw`SELECT "id" FROM "ReceiptBatch" WHERE "id" = ${id} FOR UPDATE`;
  return tx.receiptBatch.findFirst({
    where: { id }, select: { id: true, status: true, controlTotal: true, deletedAt: true } });
}

/** The claim plus the ordinary "not found" liveness check every mutator needs before it acts. */
async function claimLiveBatch(
  tx: Db, id: string,
): Promise<{ id: string; status: string; controlTotal: Prisma.Decimal | null }> {
  const batch = await claimBatch(tx, id);
  if (!batch || batch.deletedAt !== null) throw new HttpError(404, "Receipt batch not found");
  return batch;
}

/** POSTED locks payment entry (§4.1) — shared by `addPayment` and `voidPayment`, verbatim message.
 *  The message named `reopen` for two phases before one existed, and pointed at "void a payment" as
 *  the escape hatch from the very guard refusing it — a dead end (issue #68). `reopenBatch` below is
 *  the owner's ruling (option b, 2026-08-16), so the message now names the action that exists. */
function refusePosted(status: string): void {
  if (status === "POSTED") {
    throw new HttpError(400, "This batch is posted — reopen it first to change it");
  }
}

/**
 * Guard EVERY month this batch's live payments land in, in ASCENDING order.
 *
 * Shared by `postBatch` and `reopenBatch` — the two mutations that flip whether those payments are
 * recognized cash at all — precisely so the ordering rule below is stated once. A batch can span
 * months, and the `claimOrdersInOrder` rule applies to advisory mutexes too: an unsorted per-payment
 * loop would let two concurrent calls over batches sharing two months take those months' locks in
 * opposite order and deadlock (Postgres 40P01). The sort/dedup is also what dedups the `ClosePeriod`
 * reads per month; `assertPeriodOpen`'s own advisory lock only closes the phantom-row race, not this.
 *
 * Call UNDER the batch claim, before the status write.
 */
async function assertBatchMonthsOpen(tx: Db, batchId: string): Promise<void> {
  const dates = await tx.payment.findMany({
    where: { batchId, deletedAt: null }, select: { receivedDate: true },
  });
  const months = [...new Map(dates.map((d) => {
    const key = d.receivedDate.getUTCFullYear() * 100 + (d.receivedDate.getUTCMonth() + 1);
    return [key, d.receivedDate] as const;
  })).entries()].sort((a, b) => a[0] - b[0]);
  for (const [, d] of months) await assertPeriodOpen(tx, d);
}

// -------------------------------------------------------------------------------------------
// createBatch — allocates `batchNumber` under the transaction (the `createOrder`/`createShipper`
// `allocateNumber` precedent). No FK to guard (a bare batch carries none), so this is Serializable
// only to pair with `allocateNumber`'s own `FOR UPDATE` on the Setting row, not a writer FK.
// -------------------------------------------------------------------------------------------

const CREATE_BATCH = z.object({
  depositDate: z.string().min(1),
  controlTotal: decimalField(12, 2),
  notes: z.string().max(4000).optional(),
}).strict();

async function createBatchInTx(tx: Db, data: z.infer<typeof CREATE_BATCH>): Promise<BatchDetail> {
  const depositDate = parseDate(data.depositDate, "Deposit date");
  const batchNumber = await allocateNumber("receipt_batch_number_next", tx);
  const controlTotal = data.controlTotal ?? null;
  const notes = data.notes ?? "";

  const auditData = {
    batchNumber, depositDate: formatDateOnly(depositDate), controlTotal, status: "OPEN", notes,
  };
  const created = await auditedCreate("receiptBatch", auditData, () => tx.receiptBatch.create({
    data: { batchNumber, depositDate, controlTotal, notes },
    select: { id: true },
  }), { tx });

  return readBatchDetail(tx, created.id);
}

export async function createBatch(input: unknown): Promise<BatchDetail> {
  const data = CREATE_BATCH.parse(input);
  // `retryAllocation` (#115): the Serializable claim inside `allocateNumber` aborts with 40001 the
  // moment a concurrent allocation commits, so without this exactly ONE of N simultaneous batch
  // creates would succeed. Inside withDbErrors, outside $transaction — each attempt needs its own
  // snapshot.
  return withDbErrors({ entity: "ReceiptBatch" }, () => retryAllocation(() => prisma.$transaction(
    (tx) => createBatchInTx(tx, data),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )));
}

// -------------------------------------------------------------------------------------------
// addPayment — the FK-writer pattern: `assertRefExists` on `customerId`/`paymentTypeId` before
// the audited create, under the batch claim so a concurrent post sees this write or this write
// sees POSTED, never a race between the two.
// -------------------------------------------------------------------------------------------

const ADD_PAYMENT = z.object({
  customerId: z.string().min(1),
  paymentTypeId: z.string().min(1),
  amount: decimalField(12, 2, { required: true, min: "positive" }),
  reference: z.string().max(200).optional(),
  receivedDate: z.string().min(1),
  notes: z.string().max(4000).optional(),
}).strict();

async function addPaymentInTx(tx: Db, batchId: string, data: z.infer<typeof ADD_PAYMENT>): Promise<BatchDetail> {
  const batch = await claimLiveBatch(tx, batchId);
  refusePosted(batch.status);

  // The FK-writer pattern (CLAUDE.md) — Serializable pairs WITH this, it is NOT the lock.
  // `paymentType` is a registered `ReferenceKind` (reference-constants.ts), so `assertRefExists`
  // covers it directly. `customer` is NOT — Customer is a full entity with its own service
  // (customers.ts), never one of the generic reference-admin lookup tables `assertRefExists`'
  // label table describes — so this checks it exactly the way `createOrder` checks the identical
  // FK (orders.ts:637-638): a direct live `findFirst`, same message.
  const customer = await tx.customer.findFirst({
    where: { id: data.customerId, deletedAt: null }, select: { code: true, name: true } });
  if (!customer) throw new HttpError(400, "That customer does not exist");
  await assertRefExists("paymentType", data.paymentTypeId, tx);
  const paymentType = await tx.paymentType.findFirst({ where: { id: data.paymentTypeId }, select: { name: true } });
  if (!paymentType) throw new HttpError(404, "Payment type not found"); // unreachable after assertRefExists

  const receivedDate = parseDate(data.receivedDate, "Received date");
  // #73 (owner answer Q16: "No, not yet" — payments post after the deposit is in hand): a future
  // receivedDate is refused at this, the column's SOLE writer (there is no updatePayment;
  // voidPayment only stamps deletedAt). One clock sample, compared date-only — the
  // `createCredit`/`todayDateOnly` precedent (invoices.ts).
  if (receivedDate.getTime() > todayDateOnly().getTime()) {
    throw new HttpError(400, "The received date must be on or before today — payments are entered after the deposit is in hand");
  }
  const reference = data.reference ?? "";
  const notes = data.notes ?? "";

  // The FK-with-live-name pattern (invoices.ts's own auditData): history reads "ACME"/"Check",
  // never a bare cuid.
  const auditData = {
    batchId, customerId: data.customerId, customerCode: customer.code, customerName: customer.name,
    paymentTypeId: data.paymentTypeId, paymentTypeName: paymentType.name,
    amount: data.amount, reference, receivedDate: formatDateOnly(receivedDate), notes,
  };

  await auditedCreate("payment", auditData, () => tx.payment.create({
    data: {
      batchId, customerId: data.customerId, paymentTypeId: data.paymentTypeId,
      amount: data.amount, reference, receivedDate, notes,
    },
    select: { id: true },
  }), { tx });

  return readBatchDetail(tx, batchId);
}

export async function addPayment(batchId: string, input: unknown): Promise<BatchDetail> {
  const data = ADD_PAYMENT.parse(input);
  return withDbErrors({ entity: "Payment" }, () => prisma.$transaction(
    (tx) => addPaymentInTx(tx, batchId, data),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

// -------------------------------------------------------------------------------------------
// voidPayment — soft-delete with a reason, trimmed IN THE SERVICE (the `discardInvoice`
// precedent), under the same batch claim and the same POSTED refusal as `addPayment`. Also
// refuses a payment that still has live `Application` rows (the symmetric guard — see below).
// -------------------------------------------------------------------------------------------

async function voidPaymentInTx(tx: Db, batchId: string, paymentId: string, reason: string): Promise<BatchDetail> {
  const batch = await claimLiveBatch(tx, batchId);
  refusePosted(batch.status);

  const payment = await tx.payment.findFirst({
    where: { id: paymentId, batchId, deletedAt: null }, select: { id: true, receivedDate: true } });
  if (!payment) throw new HttpError(404, "Payment not found");

  // Claim the PAYMENT row — the SAME row `applyPaymentInTx` claims last (order → invoice → payment).
  // Without this, voidPayment holds only the BATCH lock while applyPayment holds only the PAYMENT
  // lock, so the two never serialize on a shared row: the live-applications check below could read
  // zero apps while a concurrent `applyPayment(P→I)` is mid-write, then void P and strand the
  // application. SSI catches it today, but the house rule forbids leaning on it ("SSI only saves you
  // by accident; the guarded state must be locked with the claimed row"). Payment is acquired LAST
  // in both paths (voidPayment: Batch→Payment; applyPayment: Order→Invoice→Payment), so the two
  // share only Payment and no lock cycle can form.
  await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${paymentId} FOR UPDATE`;

  // The symmetric guard to `voidBatch`'s "void its payments first" and the invoice side's A/R-
  // activity refusal (`unlockInvoice`/`discardInvoice`/`voidOrder`): a payment with live
  // applications must not be voided out from under them. Voiding it here would strand every live
  // `Application` sourced from it — the invoice still reads settled over its live applications —
  // while the payment's cash vanishes from on-account. The correction is to void the applications
  // first, then the payment. Read UNDER the payment-row claim above, so it and a racing
  // `applyPayment` see one consistent state.
  const liveApplication = await tx.application.findFirst({
    where: { paymentId, deletedAt: null }, select: { id: true } });
  if (liveApplication) throw new HttpError(400, "This payment has applications — void them first");

  // §4.1: a payment is CASH-journal paper effective at its `receivedDate`; voiding it reverses that
  // cash event, so it is refused into a CLOSED period. Under the payment-row claim above, before the
  // soft-delete — the advisory lock serializes it against a concurrent close (period-locks.ts).
  await assertPeriodOpen(tx, payment.receivedDate);

  await auditedSoftDelete("payment", paymentId, reason, tx);
  return readBatchDetail(tx, batchId);
}

export async function voidPayment(
  batchId: string, paymentId: string, reason: string, tx?: Prisma.TransactionClient,
): Promise<BatchDetail> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to void a payment");
  // `tx` optional — the discriminating concurrency test passes a manually-opened (Read Committed)
  // transaction so the payment-row claim, not SSI, is what serializes voidPayment against a racing
  // `applyPayment` (the `applyPayment`/`unlockInvoice` precedent). The public no-`tx` path runs
  // Serializable, pairing with the claim.
  if (tx) return voidPaymentInTx(tx, batchId, paymentId, why);
  return withDbErrors({ entity: "Payment" }, () => prisma.$transaction(
    (fresh) => voidPaymentInTx(fresh, batchId, paymentId, why),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

// -------------------------------------------------------------------------------------------
// postBatch — OPEN -> POSTED, idempotent-refusal shape (the `finalizeInvoice` "already
// finalized" precedent): a repeat post is a 400 naming the state, never a second write.
// -------------------------------------------------------------------------------------------

async function postBatchInTx(tx: Db, id: string): Promise<BatchDetail> {
  const batch = await claimLiveBatch(tx, id);
  if (batch.status === "POSTED") throw new HttpError(400, "already posted");

  // #80 (owner answer Q18: refusing is the safer default): a NON-NULL controlTotal must foot
  // against the live payment sum before the batch posts. `controlTotal` is read off the claimed
  // row and the sum is taken under that same claim — `addPayment`/`voidPayment` claim this row
  // too, so the figure cannot move mid-check. Integer cents, `toBatchDetail`'s own arithmetic;
  // voided payments never count (every sum in this file filters `deletedAt: null`). A null
  // controlTotal posts freely — balance is defined 0 (file header). The message names the two
  // ways out (§5.14): controlTotal is immutable (createBatch is its only writer; the batch
  // header has no edit path), so it is enter-the-rest or void-and-re-key. The difference prints
  // as its absolute value — over vs under is readable from the two figures beside it.
  if (batch.controlTotal !== null) {
    const controlCents = cents(batch.controlTotal.toNumber());
    const payments = await tx.payment.findMany({
      where: { batchId: id, deletedAt: null }, select: { amount: true } });
    const enteredCents = payments.reduce((sum, p) => sum + cents(p.amount.toNumber()), 0);
    if (enteredCents !== controlCents) {
      throw new HttpError(400,
        `This batch does not balance — control total ${(controlCents / 100).toFixed(2)}, ` +
        `payments entered ${(enteredCents / 100).toFixed(2)} ` +
        `(difference ${(Math.abs(controlCents - enteredCents) / 100).toFixed(2)}). ` +
        "Enter the missing payments, or void this batch and re-key it with the correct control total.");
    }
  }

  // §4.1: posting a batch makes its payments live CASH-journal paper effective at each payment's
  // `receivedDate`, so posting is refused if ANY of them falls in a CLOSED period. Read under the
  // batch claim above, before the status write. See `assertBatchMonthsOpen` for why the months are
  // taken in ascending order.
  await assertBatchMonthsOpen(tx, id);

  await auditedUpdate("receiptBatch", id,
    () => tx.receiptBatch.update({ where: { id }, data: { status: "POSTED" } }), { tx });
  return readBatchDetail(tx, id);
}

export async function postBatch(id: string): Promise<BatchDetail> {
  return withDbErrors({ entity: "ReceiptBatch" }, () => prisma.$transaction(
    (tx) => postBatchInTx(tx, id),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

// -------------------------------------------------------------------------------------------
// reopenBatch — POSTED -> OPEN. Owner ruling, 2026-08-16 (issue #68, option b): a mis-keyed deposit
// must be correctable without a compensating entry, and this is the escape hatch `refusePosted`'s
// message already promised for two phases before it existed.
//
// It is the exact inverse of `postBatch`, and it is a POSTING MUTATION — reopening un-recognizes
// every payment on the batch as cash (`buildCurrentJournal` recognizes a payment only while its
// batch is `POSTED`), which is what finally makes a posted payment reachable by the GL-export
// delta: reopen the period, reopen the batch, correct it, re-close, and the re-export reverses the
// prior posting. That path was dead code for PAYMENT keys before this (the 5C consequence recorded
// on #68).
//
// So it carries the full posting-mutation discipline: Serializable, the batch claim, and
// `assertBatchMonthsOpen` — reopening INTO a frozen month would silently change closed figures,
// which is the precise leak the period lock exists to close. CLAUDE.md standing invariant:
// downgrading any posting mutation to Read Committed silently breaks that lock (SSI only tracks
// all-Serializable transactions).
//
// Gated on `receivables.edit`, symmetric with `postBatch` — reopening is undoing an edit, not a
// delete. The reason is required and trimmed IN THE SERVICE (the `voidBatch`/`discardInvoice`
// precedent) so no future caller can bypass it, and it rides into the audit entry: un-settling cash
// is exactly the kind of act §5.17 wants a justification for.
// -------------------------------------------------------------------------------------------

async function reopenBatchInTx(tx: Db, id: string, reason: string): Promise<BatchDetail> {
  const batch = await claimLiveBatch(tx, id);
  // The `postBatch` idempotent-refusal shape: a repeat is a 400 naming the state, never a second
  // write (and never a silent no-op that would log an empty-diff audit row).
  if (batch.status !== "POSTED") throw new HttpError(400, "already open");

  await assertBatchMonthsOpen(tx, id);

  await auditedUpdate("receiptBatch", id,
    () => tx.receiptBatch.update({ where: { id }, data: { status: "OPEN" } }), { tx, reason });
  return readBatchDetail(tx, id);
}

export async function reopenBatch(id: string, reason: string): Promise<BatchDetail> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to reopen a receipt batch");
  return withDbErrors({ entity: "ReceiptBatch" }, () => prisma.$transaction(
    (tx) => reopenBatchInTx(tx, id, why),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

// -------------------------------------------------------------------------------------------
// voidBatch — refuses while any payment on it is still live ("void its payments first"); with
// none, soft-deletes with the reason trimmed IN THE SERVICE (the `discardInvoice` precedent).
// -------------------------------------------------------------------------------------------

async function voidBatchInTx(tx: Db, id: string, reason: string): Promise<void> {
  const batch = await claimLiveBatch(tx, id);
  // The matching POSTED guard `voidBatch` lacked (issue #68). Without it an EMPTY posted batch was
  // voidable while a NON-EMPTY one was frozen solid — its payments un-voidable by `refusePosted` and
  // the batch un-voidable by the live-payment guard below. Two states of the same posted batch
  // behaving oppositely is the inconsistency the ruling closes.
  //
  // Checked BEFORE the live-payment guard, and the order is the point: a posted non-empty batch told
  // "void its payments first" would be sent to an action `refusePosted` immediately refuses — the
  // same dead end that message used to create. Naming `reopen` here routes the caller to the one
  // action that actually unblocks them (§5.14: a block must name what unblocks it).
  if (batch.status === "POSTED") {
    throw new HttpError(400, "This batch is posted — reopen it first to void it");
  }
  const livePayment = await tx.payment.findFirst({ where: { batchId: id, deletedAt: null }, select: { id: true } });
  if (livePayment) throw new HttpError(400, "This batch has payments — void its payments first");
  await auditedSoftDelete("receiptBatch", id, reason, tx);
}

export async function voidBatch(id: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to void a receipt batch");
  await withDbErrors({ entity: "ReceiptBatch" }, () => prisma.$transaction(
    (tx) => voidBatchInTx(tx, id, why),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}
