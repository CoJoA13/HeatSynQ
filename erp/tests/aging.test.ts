import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { bucketAging, agingReport, type CustomerRef } from "@/server/aging";
import { parseDateOnly, formatDateOnly, addDays, todayDateOnly } from "@/lib/business-days";

// Task 10 (P5B §6): point-in-time A/R aging. `bucketAging` is the pure core — bucketed by due
// date, unapplied credit/on-account in a separate column (owner ruling 8), point-in-time filtered
// on `finalizedAt`/`appliedDate` vs. `asOf` (the correctness heart: a past `asOf` must reproduce
// the same figures every time it's re-run — §13's parallel-run acceptance test depends on it).
// `agingReport` is the thin Prisma wrapper, including the parent-family roll-up.

beforeEach(truncateAll);

let seq = 0;

const ASOF = "2026-08-08";
const back = (n: number) => formatDateOnly(addDays(parseDateOnly(ASOF), -n));
const fwd = (n: number) => formatDateOnly(addDays(parseDateOnly(ASOF), n));

const customer: CustomerRef = { id: "cust-1", code: "C1", name: "Customer One" };

// -------------------------------------------------------------------------------------------
// Step 1/3: buckets by due date (pure — no DB).
// -------------------------------------------------------------------------------------------

describe("bucketAging — buckets by due date", () => {
  it("buckets an open invoice's balance by days past due vs. asOf, and a not-yet-due invoice as current", () => {
    const snap = {
      invoices: [
        // due 15 days before asOf -> d1_30
        { id: "inv-15", customerId: customer.id, kind: "INVOICE" as const, total: 1000, dueDate: back(15), finalizedAt: back(30) },
        // due 40 days before asOf -> d31_60
        { id: "inv-40", customerId: customer.id, kind: "INVOICE" as const, total: 1000, dueDate: back(40), finalizedAt: back(60) },
        // due after asOf -> current
        { id: "inv-future", customerId: customer.id, kind: "INVOICE" as const, total: 1000, dueDate: fwd(10), finalizedAt: back(5) },
      ],
      applications: [],
      payments: [],
    };

    const [row] = bucketAging(snap, ASOF, [customer]);
    expect(row.d1_30).toBe(1000);
    expect(row.d31_60).toBe(1000);
    expect(row.current).toBe(1000);
    expect(row.d61_90).toBe(0);
    expect(row.d90_plus).toBe(0);
    expect(row.unapplied).toBe(0);
    expect(row.net).toBe(3000); // Σ buckets − unapplied
  });

  it("buckets d61_90 and d90_plus at their boundaries", () => {
    const snap = {
      invoices: [
        { id: "inv-90", customerId: customer.id, kind: "INVOICE" as const, total: 200, dueDate: back(90), finalizedAt: back(120) },
        { id: "inv-91", customerId: customer.id, kind: "INVOICE" as const, total: 300, dueDate: back(91), finalizedAt: back(120) },
      ],
      applications: [],
      payments: [],
    };
    const [row] = bucketAging(snap, ASOF, [customer]);
    expect(row.d61_90).toBe(200); // exactly 90 days past due is still in d61_90
    expect(row.d90_plus).toBe(300);
  });

  it("drops a fully-settled invoice out of every bucket", () => {
    const snap = {
      invoices: [
        { id: "inv-paid", customerId: customer.id, kind: "INVOICE" as const, total: 500, dueDate: back(15), finalizedAt: back(30) },
      ],
      applications: [
        { invoiceId: "inv-paid", creditInvoiceId: null, type: "PAYMENT" as const, amount: 500, appliedDate: back(5) },
      ],
      payments: [],
    };
    const [row] = bucketAging(snap, ASOF, [customer]);
    expect(row.current + row.d1_30 + row.d31_60 + row.d61_90 + row.d90_plus).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// Step 4/5: point-in-time reconstruction — the correctness heart of the file.
// -------------------------------------------------------------------------------------------

describe("bucketAging — point-in-time", () => {
  it("excludes an invoice finalized after asOf, and ignores an application dated after asOf — the SAME fixture ages differently at two asOf dates", () => {
    const snap = {
      invoices: [
        // finalized the day AFTER asOf — must not appear at all when aged as of ASOF.
        { id: "inv-late", customerId: customer.id, kind: "INVOICE" as const, total: 1000, dueDate: back(20), finalizedAt: fwd(1) },
        { id: "inv-early", customerId: customer.id, kind: "INVOICE" as const, total: 1000, dueDate: back(20), finalizedAt: back(30) },
      ],
      applications: [
        // applied the day AFTER asOf — must not reduce inv-early's balance when aged as of ASOF.
        { invoiceId: "inv-early", creditInvoiceId: null, type: "PAYMENT" as const, amount: 400, appliedDate: fwd(1) },
      ],
      payments: [],
    };

    const rowAtAsOf = bucketAging(snap, ASOF, [customer])[0];
    const totalAtAsOf = rowAtAsOf.current + rowAtAsOf.d1_30 + rowAtAsOf.d31_60 + rowAtAsOf.d61_90 + rowAtAsOf.d90_plus;
    expect(totalAtAsOf).toBe(1000); // only inv-early, full balance — inv-late excluded, payment not yet counted

    const later = fwd(1);
    const rowAtLater = bucketAging(snap, later, [customer])[0];
    const totalAtLater = rowAtLater.current + rowAtLater.d1_30 + rowAtLater.d31_60 + rowAtLater.d61_90 + rowAtLater.d90_plus;
    expect(totalAtLater).toBe(1000 + 600); // inv-late now included (full 1000); inv-early now paid down to 600
  });
});

// -------------------------------------------------------------------------------------------
// The separate unapplied column: open credit remaining + payment on-account, never a bucket.
// -------------------------------------------------------------------------------------------

describe("bucketAging — unapplied column", () => {
  it("rolls open credit remaining and payment on-account into unapplied, never into a bucket", () => {
    const snap = {
      invoices: [
        { id: "cred-1", customerId: customer.id, kind: "CREDIT" as const, total: -300, dueDate: null, finalizedAt: back(10) },
      ],
      applications: [],
      payments: [
        { customerId: customer.id, amount: 200, appliedPaymentTotal: 50 },
      ],
    };
    const [row] = bucketAging(snap, ASOF, [customer]);
    expect(row.current + row.d1_30 + row.d31_60 + row.d61_90 + row.d90_plus).toBe(0);
    expect(row.unapplied).toBe(300 + 150); // credit remaining 300 + on-account 150
    expect(row.net).toBe(-450); // 0 buckets − 450 unapplied
  });

  it("excludes a fully-applied credit and a fully-applied payment from unapplied", () => {
    const snap = {
      invoices: [
        { id: "cred-1", customerId: customer.id, kind: "CREDIT" as const, total: -300, dueDate: null, finalizedAt: back(10) },
      ],
      applications: [
        { invoiceId: "target-inv-x", creditInvoiceId: "cred-1", type: "CREDIT" as const, amount: 300, appliedDate: back(1) },
      ],
      payments: [
        { customerId: customer.id, amount: 200, appliedPaymentTotal: 200 },
      ],
    };
    const [row] = bucketAging(snap, ASOF, [customer]);
    expect(row.unapplied).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// Integer-cent correctness — no float drift, the ar-balances precedent.
// -------------------------------------------------------------------------------------------

describe("bucketAging — integer-cent correctness", () => {
  it("has no float drift on fractional-cent amounts", () => {
    const snap = {
      invoices: [
        { id: "inv-frac", customerId: customer.id, kind: "INVOICE" as const, total: 0.3, dueDate: back(5), finalizedAt: back(20) },
      ],
      applications: [
        { invoiceId: "inv-frac", creditInvoiceId: null, type: "PAYMENT" as const, amount: 0.1, appliedDate: back(1) },
      ],
      payments: [],
    };
    const [row] = bucketAging(snap, ASOF, [customer]);
    expect(row.d1_30).toBe(0.2); // 0.3 − 0.1, not 0.19999999999999998
  });
});

// -------------------------------------------------------------------------------------------
// Step 6/7: agingReport — the Prisma wrapper, including the parent-family roll-up.
// -------------------------------------------------------------------------------------------

async function makeCustomer(opts: { parentId?: string } = {}): Promise<{ id: string; code: string; name: string }> {
  seq += 1;
  return prisma.customer.create({
    data: { code: `AGC${seq}`, name: `Aging Customer ${seq}`, parentId: opts.parentId },
  });
}

async function finalizedInvoiceFor(
  customerId: string, opts: { total: number; dueDate: string; finalizedAt?: string },
): Promise<{ invoiceId: string; orderId: string; orderNumber: number }> {
  seq += 1;
  const orderNumber = 800000 + seq;
  const order = await prisma.order.create({
    data: {
      orderNumber, customerId, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-01-01"), requestDate: parseDateOnly("2026-01-01"),
    },
  });
  const finalizedAt = opts.finalizedAt ?? formatDateOnly(todayDateOnly());
  const invoice = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId,
      invoiceDate: parseDateOnly(finalizedAt),
      dueDate: parseDateOnly(opts.dueDate),
      total: opts.total,
      finalizedAt: parseDateOnly(finalizedAt),
    },
  });
  return { invoiceId: invoice.id, orderId: order.id, orderNumber };
}

describe("agingReport — service wiring", () => {
  it("ages one customer's finalized invoice off real Decimal fields, and performs no writes", async () => {
    const cust = await makeCustomer();
    const dueDate = formatDateOnly(addDays(todayDateOnly(), -10));
    await finalizedInvoiceFor(cust.id, { total: 750.5, dueDate });

    const rows = await agingReport({ customerId: cust.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].d1_30).toBe(750.5);
    expect(rows[0].net).toBe(750.5);
    expect(rows[0].customerCode).toBe(cust.code);

    expect(await prisma.auditLog.count()).toBe(0); // aging is a read — no mutation, no audit
  });

  it("defaults asOf to today, and the unfiltered report excludes a customer with no A/R history", async () => {
    const noHistory = await makeCustomer();
    const cust = await makeCustomer();
    const dueDate = formatDateOnly(addDays(todayDateOnly(), -5));
    await finalizedInvoiceFor(cust.id, { total: 100, dueDate });

    const rows = await agingReport({});
    expect(rows.some((r) => r.customerId === cust.id)).toBe(true);
    expect(rows.some((r) => r.customerId === noHistory.id)).toBe(false);
  });

  it("404s a customerId naming no live customer", async () => {
    await expect(agingReport({ customerId: "nope" })).rejects.toMatchObject({ status: 404 });
  });

  it("400s a malformed asOf", async () => {
    const cust = await makeCustomer();
    await expect(agingReport({ customerId: cust.id, asOf: "not-a-date" }))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe("agingReport — parent-family roll-up", () => {
  it("returns per-child rows plus a synthesized family-total row keyed on the parent", async () => {
    const parent = await makeCustomer();
    const childA = await makeCustomer({ parentId: parent.id });
    const childB = await makeCustomer({ parentId: parent.id });

    const dueDate = formatDateOnly(addDays(todayDateOnly(), -40)); // past due -> d31_60
    await finalizedInvoiceFor(childA.id, { total: 500, dueDate });
    await finalizedInvoiceFor(childB.id, { total: 500, dueDate });

    const rows = await agingReport({ customerId: parent.id });
    expect(rows).toHaveLength(3); // 2 children + 1 family-total row

    const rowA = rows.find((r) => r.customerId === childA.id)!;
    const rowB = rows.find((r) => r.customerId === childB.id)!;
    expect(rowA.d31_60).toBe(500);
    expect(rowB.d31_60).toBe(500);
    // Only the synthesized total carries `isFamilyTotal` — the child rows must NOT, so a footer can
    // use the total row alone and never double-count the children it already sums (Fix #13).
    expect(rowA.isFamilyTotal).toBeUndefined();
    expect(rowB.isFamilyTotal).toBeUndefined();

    const totalRow = rows.find((r) => r.customerId === parent.id)!;
    expect(totalRow.d31_60).toBe(1000); // family total across both children
    expect(totalRow.net).toBe(1000);
    expect(totalRow.customerCode).toBe(parent.code);
    expect(totalRow.customerName).toBe(parent.name);
    expect(totalRow.isFamilyTotal).toBe(true);
  });

  it("a plain customer with no children returns just its own single row (no family total)", async () => {
    const cust = await makeCustomer();
    const dueDate = formatDateOnly(addDays(todayDateOnly(), -5));
    await finalizedInvoiceFor(cust.id, { total: 300, dueDate });

    const rows = await agingReport({ customerId: cust.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].customerId).toBe(cust.id);
    expect(rows[0].isFamilyTotal).toBeUndefined(); // a standalone row is never a family total
  });
});
