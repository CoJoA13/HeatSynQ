import type { Prisma } from "../../../prisma/generated/prisma/client";
import { prisma } from "../db";
import { HttpError } from "../errors";
import { parseDateOnly, formatDateOnly } from "../../lib/business-days";

// -------------------------------------------------------------------------------------------
// Phase 8A Task 5 (spec §4.2): the Payments-received report — cash received by period, sliceable
// by customer / month (of receivedDate) / payment type. `buildPayments` is the PURE core (the
// `buildSales`/`bucketAging` shape — no Prisma, no I/O), `reportPayments` the thin Prisma-reading
// wrapper. A report is a pure READ: no row claim, no audit, no Serializable (main spec §12,
// reports/README.md).
//
// The measure, pinned (do not guess it back into ambiguity):
//   • Population — POSTED-batch payments ONLY. A `Payment` counts iff its `ReceiptBatch.status =
//     POSTED` (`deletedAt: null` on BOTH the payment and its batch). This is the books-consistent
//     basis: it matches the deposit workflow and the month-end close's `paymentTotal`
//     (close-periods.ts reads `batch: { status: "POSTED" }`). Aging counts ALL payments — the two
//     existing consumers deliberately disagree, and this report picks the close's basis so the page
//     never shows cash the books have not recognized. Un-posted (OPEN-batch) cash is real money not
//     yet on the books and is EXCLUDED; the page prints the basis so that exclusion is never read
//     as missing money.
//   • Date anchor — `receivedDate` (`@db.Date`, no time-of-day), inclusive `[from, to]` (unlike
//     Sales' half-open finalizedAt window — receivedDate has no time component, so a plain `lte` at
//     midnight keeps the last-day payments).
//   • Slices — customer · month (of receivedDate) · payment type. There is deliberately NO "by
//     part" slice: a payment pays invoices, not parts, so a part dimension would be meaningless.
//   • Amounts in integer cents (the `buildSales` rule) so fractional dollars don't drift.
// -------------------------------------------------------------------------------------------

/** The population's basis, printed on the page AND in the export (spec §4.2) so an operator can
 *  never mistake un-posted cash for missing money. POSTED batches only — the books-consistent
 *  basis (see the header note). */
export const PAYMENTS_BASIS = "Posted payments only";

/** Money is Decimal(12,2); sum it in integer cents so fractional dollars don't drift (the
 *  `buildSales` integer-cents rule). */
const cents = (n: number): number => Math.round(n * 100);

export type PaymentsGroupBy = "none" | "customer" | "month" | "type";
const GROUP_BYS: readonly PaymentsGroupBy[] = ["none", "customer", "month", "type"];

/** The pure-core input: one POSTED-batch payment with its customer/type identity resolved and its
 *  amount humanized (a plain dollar number, receivedDate a "yyyy-mm-dd" string). */
export type PaymentRow = {
  paymentId: string;
  reference: string; // check #, etc.
  customerId: string;
  customerCode: string;
  customerName: string;
  paymentTypeId: string;
  paymentTypeName: string;
  receivedDate: string; // yyyy-mm-dd
  amount: number; // dollars
};

/** One detail row — a single received payment. */
export type PaymentDetailRow = {
  paymentId: string;
  reference: string;
  customerCode: string;
  customerName: string;
  paymentTypeName: string;
  receivedDate: string;
  amount: number;
};

/** An aggregate over the base grain — one row per customer / received-month / payment type.
 *  `paymentCount` is the number of payments in the group; `amount` their sum. */
export type PaymentGroupRow = {
  key: string;
  label: string;
  paymentCount: number;
  amount: number;
};

/** Every view carries the overall `total` and `paymentCount` over the whole population, plus the
 *  `basis` string (so the JSON response and the export both surface it). */
export type PaymentsResult =
  | { groupBy: "none"; rows: PaymentDetailRow[]; total: number; paymentCount: number; basis: string }
  | { groupBy: "customer" | "month" | "type"; rows: PaymentGroupRow[]; total: number; paymentCount: number; basis: string };

/** The (key, label) a payment contributes to for a grouping dimension. */
function groupKey(p: PaymentRow, groupBy: "customer" | "month" | "type"): { key: string; label: string } {
  if (groupBy === "customer") return { key: p.customerId, label: `${p.customerCode} · ${p.customerName}` };
  if (groupBy === "type") return { key: p.paymentTypeId, label: p.paymentTypeName };
  const m = p.receivedDate.slice(0, 7); // "yyyy-mm"
  return { key: m, label: m };
}

/**
 * PURE. Shapes the received payments into the requested view.
 *   • `none` → one detail row per payment, sorted by received date then customer code
 *     (deterministic).
 *   • `customer`/`month`/`type` → aggregate rows: payment count + Σamount (summed in integer cents
 *     so fractional dollars don't drift), sorted by label.
 * The overall `total`/`paymentCount` are always over the whole population regardless of `groupBy`.
 */
export function buildPayments(payments: PaymentRow[], opts: { groupBy: PaymentsGroupBy }): PaymentsResult {
  const total = payments.reduce((s, p) => s + cents(p.amount), 0) / 100;
  const paymentCount = payments.length;

  if (opts.groupBy === "none") {
    const rows: PaymentDetailRow[] = payments
      .map((p) => ({
        paymentId: p.paymentId, reference: p.reference,
        customerCode: p.customerCode, customerName: p.customerName,
        paymentTypeName: p.paymentTypeName,
        receivedDate: p.receivedDate, amount: p.amount,
      }))
      .sort((a, b) =>
        a.receivedDate.localeCompare(b.receivedDate)
        || a.customerCode.localeCompare(b.customerCode)
        || a.paymentId.localeCompare(b.paymentId));
    return { groupBy: "none", rows, total, paymentCount, basis: PAYMENTS_BASIS };
  }

  const groupBy = opts.groupBy;
  type Acc = { key: string; label: string; count: number; cents: number };
  const groups = new Map<string, Acc>();
  for (const p of payments) {
    const { key, label } = groupKey(p, groupBy);
    let acc = groups.get(key);
    if (!acc) { acc = { key, label, count: 0, cents: 0 }; groups.set(key, acc); }
    acc.count += 1;
    acc.cents += cents(p.amount);
  }
  const rows: PaymentGroupRow[] = [...groups.values()]
    .map((a) => ({ key: a.key, label: a.label, paymentCount: a.count, amount: a.cents / 100 }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  return { groupBy, rows, total, paymentCount, basis: PAYMENTS_BASIS };
}

// -------------------------------------------------------------------------------------------
// reportPayments — the Prisma-reading wrapper. Read-only: no claim, no transaction, no audit.
// -------------------------------------------------------------------------------------------

export type PaymentsFilter = {
  customerId?: string;
  from?: string; // receivedDate >=
  to?: string; // receivedDate <=
  groupBy?: PaymentsGroupBy;
};

/** `parseDateOnly` at the service boundary — the `buildBacklog`/`buildSales` `parseDate` precedent:
 *  a malformed bound fails as a field-anchored 400, not a status-less 500. */
function parseDate(value: string, field: string): Date {
  try {
    return parseDateOnly(value);
  } catch {
    throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${field}`);
  }
}

/** The received-date window (the `buildBacklog` `receivedRange` shape — INCLUSIVE both ends because
 *  `receivedDate` is a `@db.Date` with no time-of-day). Undefined when neither bound is set, so a
 *  blank filter narrows nothing. */
function receivedRange(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: parseDate(from, "Received from") } : {}),
    ...(to ? { lte: parseDate(to, "Received to") } : {}),
  };
}

/** The service owns groupBy validation (the parse layer passes the raw string through — the
 *  `buildSales` `normalizeGroupBy` discipline), so an unknown value fails as a 400 rather than
 *  silently falling back to a view the caller did not ask for. */
function normalizeGroupBy(value: string | undefined): PaymentsGroupBy {
  if (value === undefined) return "none";
  if ((GROUP_BYS as readonly string[]).includes(value)) return value as PaymentsGroupBy;
  throw new HttpError(400, `Cannot group payments by "${value}"`);
}

export async function reportPayments(filter: PaymentsFilter = {}): Promise<PaymentsResult> {
  const groupBy = normalizeGroupBy(filter.groupBy);
  const received = receivedRange(filter.from, filter.to);

  // A single findMany — atomic on its own, so no RepeatableRead transaction is needed. The
  // load-bearing filter is `batch: { status: "POSTED", deletedAt: null }` — the books-consistent
  // population (the close-periods.ts `paymentTotal` basis); an OPEN-batch payment is un-posted cash
  // and must never appear. `deletedAt: null` on the payment itself drops voided payments.
  const rows = await prisma.payment.findMany({
    where: {
      deletedAt: null,
      batch: { status: "POSTED", deletedAt: null },
      ...(received ? { receivedDate: received } : {}),
      ...(filter.customerId ? { customerId: filter.customerId } : {}),
    },
    select: {
      id: true, reference: true, amount: true, receivedDate: true, customerId: true,
      customer: { select: { code: true, name: true } },
      paymentType: { select: { id: true, name: true } },
    },
  });

  const payments: PaymentRow[] = rows.map((p) => ({
    paymentId: p.id,
    reference: p.reference,
    customerId: p.customerId,
    customerCode: p.customer.code,
    customerName: p.customer.name,
    paymentTypeId: p.paymentType.id,
    paymentTypeName: p.paymentType.name,
    receivedDate: formatDateOnly(p.receivedDate),
    amount: p.amount.toNumber(),
  }));

  return buildPayments(payments, { groupBy });
}
