import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { invoiceOpenBalance, creditRemaining, paymentOnAccount, type ApplicationLite } from "./ar-balances";
import type { ApplicationTypeValue } from "../lib/ar-constants";
import { parseDateOnly, formatDateOnly, todayDateOnly } from "../lib/business-days";

// -------------------------------------------------------------------------------------------
// Task 10 (P5B §6): point-in-time A/R aging. `bucketAging` is the PURE core (the `ar-balances.ts`
// shape — no Prisma, no I/O) that buckets each finalized INVOICE's open balance by due date as of
// a chosen `asOf`, with unapplied credit/on-account cash rolled into a separate `unapplied` column
// rather than folded into a bucket (owner ruling 8). `agingReport` is the thin Prisma-reading
// wrapper: read a snapshot of the relevant finalized invoices/credits, their live applications,
// and the relevant live payments, then hand it to `bucketAging`. Aging is a READ — no mutation, no
// audit, no row claim; the only invariant is that re-running a PAST `asOf` reproduces the same
// figures every time (spec §6, and the §13 parallel-run acceptance test / 5C's month-end close
// depend on it), which is why the point-in-time filters below are the load-bearing part of this
// file, not the bucket-boundary arithmetic.
// -------------------------------------------------------------------------------------------

export type AgingRow = {
  customerId: string; customerCode: string; customerName: string;
  current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number;
  unapplied: number; net: number; // net = Σ buckets − unapplied
  // Set ONLY on the synthesized family-TOTAL row of a parent-family roll-up (`agingReport` below),
  // which already sums parent + every child. Every other row — a standalone customer, a childless
  // customer, a per-child row, or an unfiltered-report row — leaves it undefined. Consumers must
  // NOT add a `isFamilyTotal` row into a totals footer alongside the child rows it already sums, or
  // the family total double-counts.
  isFamilyTotal?: boolean;
};

/** The minimal customer identity `bucketAging` labels each output row with — never a full
 *  `CustomerRow` (customers.ts); this module only ever needs id/code/name. */
export type CustomerRef = { id: string; code: string; name: string };

type SnapshotInvoice = {
  id: string; customerId: string; kind: "INVOICE" | "CREDIT"; total: number;
  dueDate: string | null; finalizedAt: string | null;
};
type SnapshotApplication = {
  invoiceId: string; creditInvoiceId: string | null; type: ApplicationTypeValue;
  amount: number; appliedDate: string;
};
/** `appliedPaymentTotal` is pre-summed by the caller (live PAYMENT-type applications sourced from
 *  this payment, point-in-time filtered at the query — see `agingReport` below): the snapshot
 *  carries no per-payment application list, so this is the only shape `bucketAging` needs to
 *  derive on-account (`payment.amount − appliedPaymentTotal`, the `ar-balances.paymentOnAccount`
 *  formula applied to one pre-aggregated row). */
type SnapshotPayment = { customerId: string; amount: number; appliedPaymentTotal: number };

type Snapshot = {
  invoices: SnapshotInvoice[];
  applications: SnapshotApplication[];
  payments: SnapshotPayment[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const cents = (n: number): number => Math.round(n * 100);

type BucketKey = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";

/** `daysPastDue = asOf − dueDate` (spec §6): `≤0` (not yet due, or due today) → `current`;
 *  `1..30 → d1_30`; `31..60 → d31_60`; `61..90 → d61_90`; `>90 → d90_plus`. */
function bucketFor(daysPastDue: number): BucketKey {
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "d1_30";
  if (daysPastDue <= 60) return "d31_60";
  if (daysPastDue <= 90) return "d61_90";
  return "d90_plus";
}

/** The appliedDate ≤ asOf half of the point-in-time cut. Everything in `snap.applications` is
 *  already LIVE by construction — `agingReport` only ever queries `deletedAt: null` rows into the
 *  snapshot — so this is the only filtering `bucketAging` itself owns; `deletedAt` isn't even a
 *  field on `SnapshotApplication`. A truly retroactive void (voided today, but dated before a past
 *  `asOf`) is therefore NOT un-counted when re-running that past `asOf` — accepted per spec §6,
 *  which keys point-in-time reconstruction on `appliedDate`, not on `deletedAt` vs. `asOf`. */
function liveAsOf(apps: SnapshotApplication[], asOfMs: number, match: (a: SnapshotApplication) => boolean): ApplicationLite[] {
  return apps
    .filter((a) => match(a) && parseDateOnly(a.appliedDate).getTime() <= asOfMs)
    .map((a) => ({ amount: a.amount, type: a.type, deletedAt: null }));
}

/**
 * PURE. Buckets each finalized INVOICE's open balance by due date vs. `asOf`; open credit
 * remaining and payment on-account roll into the separate `unapplied` column (owner ruling 8 —
 * never folded into a bucket). Point-in-time (spec §6, the correctness heart): an invoice counts
 * only if `finalizedAt ≤ asOf`, and its open balance is derived from only the live applications
 * whose `appliedDate ≤ asOf` — so the SAME snapshot ages differently at two different `asOf`
 * values, which is exactly what makes a past `asOf` reproducible. One `AgingRow` per entry in
 * `customers`, in that order.
 */
export function bucketAging(snap: Snapshot, asOf: string, customers: CustomerRef[]): AgingRow[] {
  const asOfMs = parseDateOnly(asOf).getTime();

  return customers.map((customer) => {
    const buckets: Record<BucketKey, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
    let unappliedCents = 0;

    for (const inv of snap.invoices) {
      if (inv.customerId !== customer.id) continue;
      // Point-in-time: not yet finalized as of this asOf never appears at all.
      if (!inv.finalizedAt || parseDateOnly(inv.finalizedAt).getTime() > asOfMs) continue;

      if (inv.kind === "INVOICE") {
        const apps = liveAsOf(snap.applications, asOfMs, (a) => a.invoiceId === inv.id);
        const openCents = cents(invoiceOpenBalance(inv.total, apps));
        if (openCents <= 0) continue; // fully settled as of this asOf — not an open item

        // An INVOICE always carries a dueDate once finalized (set at finalize — Task 3); the
        // null fallback below is defensive only and buckets as `current` rather than throwing.
        const dueMs = inv.dueDate ? parseDateOnly(inv.dueDate).getTime() : asOfMs;
        const daysPastDue = Math.round((asOfMs - dueMs) / DAY_MS);
        buckets[bucketFor(daysPastDue)] += openCents;
      } else {
        // CREDIT: its own open remaining is unapplied cash sitting on the account, not a bucketed
        // open item — it carries no dueDate (schema comment: "a CREDIT gets none").
        const apps = liveAsOf(snap.applications, asOfMs, (a) => a.creditInvoiceId === inv.id);
        const remainingCents = cents(creditRemaining(inv.total, apps));
        if (remainingCents > 0) unappliedCents += remainingCents;
      }
    }

    for (const p of snap.payments) {
      if (p.customerId !== customer.id) continue;
      const onAccount = paymentOnAccount(p.amount, [
        { amount: p.appliedPaymentTotal, type: "PAYMENT", deletedAt: null },
      ]);
      const onAccountCents = cents(onAccount);
      if (onAccountCents > 0) unappliedCents += onAccountCents;
    }

    const bucketCents = buckets.current + buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.d90_plus;

    return {
      customerId: customer.id, customerCode: customer.code, customerName: customer.name,
      current: buckets.current / 100, d1_30: buckets.d1_30 / 100, d31_60: buckets.d31_60 / 100,
      d61_90: buckets.d61_90 / 100, d90_plus: buckets.d90_plus / 100,
      unapplied: unappliedCents / 100,
      net: (bucketCents - unappliedCents) / 100,
    };
  });
}

// -------------------------------------------------------------------------------------------
// agingReport — the Prisma-reading wrapper. Filterable by `customerId` (a plain customer, or a
// parent — which additionally rolls up its family) and `asOf` (defaults to today). Read-only: no
// claim, no transaction, no audit (nothing here mutates).
// -------------------------------------------------------------------------------------------

export type AgingFilter = { customerId?: string; asOf?: string };

/** `parseDateOnly` at the service boundary — the `orders.ts`/`receipts.ts` `parseDate` precedent,
 *  one field. */
function parseAsOf(value: string): Date {
  try {
    return parseDateOnly(value);
  } catch {
    throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for As-of date`);
  }
}

const CUSTOMER_REF_SELECT = { id: true, code: true, name: true } satisfies Prisma.CustomerSelect;

/** Reads the snapshot `bucketAging` needs for exactly the given customer ids: every live finalized
 *  invoice/credit they hold (any `finalizedAt` — `bucketAging` itself decides inclusion vs.
 *  `asOf`), every live application against those rows (any `appliedDate` — same reason), and every
 *  live payment they hold. A payment's `appliedPaymentTotal` and its own inclusion ARE point-in-time
 *  filtered here (by `receivedDate`/`appliedDate` ≤ `asOfDate`) — unlike invoices/applications, the
 *  `SnapshotPayment` shape carries no per-application detail for `bucketAging` to filter itself, so
 *  this is the one point-in-time cut that has to happen at the query rather than in the pure core. */
async function readSnapshot(customerIds: string[], asOfDate: Date): Promise<Snapshot> {
  if (customerIds.length === 0) return { invoices: [], applications: [], payments: [] };
  // ONE consistent DB view for all three component reads. Issued as separate autocommit reads, a
  // commit landing between them could mix states — e.g. see a payment's cash off-account but miss
  // the matching invoice reduction — transiently mis-stating net. RepeatableRead pins a single
  // snapshot across the callback. Read-only: no writes, no claim.
  return prisma.$transaction(
    (tx) => readSnapshotIn(tx, customerIds, asOfDate),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

async function readSnapshotIn(tx: Prisma.TransactionClient, customerIds: string[], asOfDate: Date): Promise<Snapshot> {
  const invoiceRows = await tx.invoice.findMany({
    where: { customerId: { in: customerIds }, deletedAt: null, status: "FINALIZED" },
    select: { id: true, customerId: true, kind: true, total: true, dueDate: true, finalizedAt: true },
  });
  const invoiceIds = invoiceRows.map((i) => i.id);

  const applicationRows = invoiceIds.length === 0 ? [] : await tx.application.findMany({
    where: { deletedAt: null, OR: [{ invoiceId: { in: invoiceIds } }, { creditInvoiceId: { in: invoiceIds } }] },
    select: { invoiceId: true, creditInvoiceId: true, type: true, amount: true, appliedDate: true },
  });

  const paymentRows = await tx.payment.findMany({
    where: { customerId: { in: customerIds }, deletedAt: null, receivedDate: { lte: asOfDate } },
    select: {
      customerId: true, amount: true,
      applications: {
        where: { deletedAt: null, type: "PAYMENT", appliedDate: { lte: asOfDate } },
        select: { amount: true },
      },
    },
  });

  return {
    invoices: invoiceRows.map((i) => ({
      id: i.id, customerId: i.customerId, kind: i.kind, total: i.total.toNumber(),
      dueDate: i.dueDate ? formatDateOnly(i.dueDate) : null,
      finalizedAt: i.finalizedAt ? formatDateOnly(i.finalizedAt) : null,
    })),
    applications: applicationRows.map((a) => ({
      invoiceId: a.invoiceId, creditInvoiceId: a.creditInvoiceId, type: a.type,
      amount: a.amount.toNumber(), appliedDate: formatDateOnly(a.appliedDate),
    })),
    payments: paymentRows.map((p) => ({
      customerId: p.customerId, amount: p.amount.toNumber(),
      appliedPaymentTotal: p.applications.reduce((sum, a) => sum + a.amount.toNumber(), 0),
    })),
  };
}

/** Sums a set of `AgingRow`s into one, in integer cents (the shared rounding rule) — used only to
 *  build the synthesized family-total row; every field but the three identity fields is additive. */
function sumRows(rows: AgingRow[], as: CustomerRef): AgingRow {
  const sum = (key: Exclude<keyof AgingRow, "customerId" | "customerCode" | "customerName" | "isFamilyTotal">): number =>
    rows.reduce((total, r) => total + cents(r[key]), 0) / 100;
  return {
    customerId: as.id, customerCode: as.code, customerName: as.name,
    current: sum("current"), d1_30: sum("d1_30"), d31_60: sum("d31_60"),
    d61_90: sum("d61_90"), d90_plus: sum("d90_plus"),
    unapplied: sum("unapplied"), net: sum("net"),
  };
}

/**
 * `agingReport` (§6). No `customerId` — every customer with any A/R history (a live finalized
 * invoice/credit or a live payment), one row each. A plain `customerId` — that one customer's own
 * row. A `customerId` naming a customer with live children — the family roll-up (owner ruling
 * "parent-family roll-up"): one row per CHILD plus a synthesized family-total row keyed on the
 * parent (summing every family member, parent included, even though the parent gets no row of its
 * own — the brief's chosen shape over "combine everything into the parent's single row").
 */
export async function agingReport(filter: AgingFilter = {}): Promise<AgingRow[]> {
  const asOf = filter.asOf ?? formatDateOnly(todayDateOnly());
  const asOfDate = parseAsOf(asOf);

  if (filter.customerId) {
    const customer = await prisma.customer.findFirst({
      where: { id: filter.customerId, deletedAt: null }, select: CUSTOMER_REF_SELECT,
    });
    if (!customer) throw new HttpError(404, "Customer not found");

    const children = await prisma.customer.findMany({
      where: { parentId: filter.customerId, deletedAt: null }, select: CUSTOMER_REF_SELECT,
    });

    if (children.length === 0) {
      const snap = await readSnapshot([customer.id], asOfDate);
      return bucketAging(snap, asOf, [customer]);
    }

    const familyIds = [customer.id, ...children.map((c) => c.id)];
    const snap = await readSnapshot(familyIds, asOfDate);
    const childRows = bucketAging(snap, asOf, children);
    const parentOwnRow = bucketAging(snap, asOf, [customer])[0];
    // `isFamilyTotal` marks this as the pre-summed family total (parent + every child) so a totals
    // footer can use it instead of re-summing the child rows it already contains (double-count fix).
    const totalRow: AgingRow = { ...sumRows([parentOwnRow, ...childRows], customer), isFamilyTotal: true };
    return [...childRows, totalRow];
  }

  const [invoicedCustomers, paidCustomers] = await Promise.all([
    prisma.invoice.findMany({
      where: { deletedAt: null, status: "FINALIZED" }, select: { customerId: true }, distinct: ["customerId"],
    }),
    prisma.payment.findMany({
      where: { deletedAt: null }, select: { customerId: true }, distinct: ["customerId"],
    }),
  ]);
  const customerIds = [...new Set([
    ...invoicedCustomers.map((r) => r.customerId), ...paidCustomers.map((r) => r.customerId),
  ])];
  if (customerIds.length === 0) return [];

  // Deliberately NOT filtered to deletedAt: null — a customer can be soft-deleted only once it
  // has zero live orders (customers.ts's deleteCustomer), which a finalized invoice with residual
  // A/R would still be attached to (voiding that order is itself blocked by hasReceivableActivity,
  // Task 9), so a deleted customer can only ever surface here with a fully zero row. Point-in-time
  // reconstruction of a PAST asOf (spec §6) must not silently drop a customer's history just
  // because the customer entity was deleted after the fact.
  const customers = await prisma.customer.findMany({
    where: { id: { in: customerIds } }, select: CUSTOMER_REF_SELECT, orderBy: { code: "asc" },
  });
  const snap = await readSnapshot(customerIds, asOfDate);
  return bucketAging(snap, asOf, customers);
}

/**
 * Exactly ONE customer's OWN aging row — never rolled up into its family, even when that customer
 * is a PARENT with live children (Task 15 fix round 1: the customer A/R section's own scope,
 * `customer-receivables.ts`). `agingReport({ customerId })` above deliberately answers a
 * different question for a parent (the synthesized family-TOTAL row, still keyed on the parent's
 * own id — the aging *report* screen's own rollup, owner ruling "parent-family roll-up") and must
 * keep doing so; this is the single-customer sibling it was missing, not a behavior change to it.
 *
 * Reuses the same private `readSnapshot`/pure `bucketAging` core `agingReport` uses — scoped to a
 * ONE-element customer id list, which is exactly what `agingReport`'s own childless branch above
 * already does for a plain (non-parent) customer; the only difference here is that a live
 * children set never widens the query.
 */
export async function customerOwnAgingRow(customerId: string, asOf?: string): Promise<AgingRow> {
  const asOfResolved = asOf ?? formatDateOnly(todayDateOnly());
  const asOfDate = parseAsOf(asOfResolved);
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, deletedAt: null }, select: CUSTOMER_REF_SELECT,
  });
  if (!customer) throw new HttpError(404, "Customer not found");
  const snap = await readSnapshot([customer.id], asOfDate);
  return bucketAging(snap, asOfResolved, [customer])[0];
}
