import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { customerReceivablesSummary } from "@/server/customer-receivables";
import { parseDateOnly, todayDateOnly } from "@/lib/business-days";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

beforeEach(async () => await truncateAll());

let seq = 0;

/** A finalized INVOICE of `total` on its own order, for `customerId`. The dates are overridable
 *  (#174 needs two invoices in DIFFERENT months so one write-off's month can be closed while the
 *  other's stays open); every other caller takes the defaults, which the aging buckets are cut to. */
async function invoice(
  customerId: string, total: number,
  dates: { invoiceDate?: string; dueDate?: string } = {},
): Promise<string> {
  seq += 1;
  const invoiceDate = parseDateOnly(dates.invoiceDate ?? "2026-08-08");
  const order = await prisma.order.create({
    data: {
      orderNumber: 810000 + seq, customerId, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
    },
  });
  const row = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId,
      invoiceDate, dueDate: parseDateOnly(dates.dueDate ?? "2026-09-07"),
      total, finalizedAt: invoiceDate,
    },
  });
  return row.id;
}

/** One STANDALONE (null-payment) bad-debt write-off, dated wherever the test needs it —
 *  `writeOffInvoice` stamps `todayDateOnly()` on purpose, so a dated one is raw by necessity. */
async function standaloneWriteOff(invoiceId: string, amount: number, dateStr: string): Promise<string> {
  const row = await prisma.application.create({
    data: {
      invoiceId, amount, type: "WRITE_OFF", reason: "uncollectable",
      paymentId: null, appliedDate: parseDateOnly(dateStr),
    },
  });
  return row.id;
}

/** A CLOSED month with no roll-forward machinery behind it (`write-offs.test.ts`'s own helper) —
 *  the retention read and `assertPeriodOpen` both look for exactly this row. */
async function closeMonthRaw(year: number, month: number): Promise<void> {
  await prisma.closePeriod.create({
    data: { year, month, beginningAr: 0, invoicedTotal: 0, creditTotal: 0, paymentTotal: 0,
      discountTotal: 0, writeOffTotal: 0, endingAr: 0, agingEndingAr: 0 },
  });
}

/** A finalized CREDIT of `total` (stored NEGATIVE, as `createCredit` writes it). */
async function credit(customerId: string, total: number): Promise<string> {
  seq += 1;
  const order = await prisma.order.create({
    data: {
      orderNumber: 820000 + seq, customerId, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
    },
  });
  const row = await prisma.invoice.create({
    data: {
      kind: "CREDIT", status: "FINALIZED", orderId: order.id, customerId,
      creditNumber: 3000 + seq,
      invoiceDate: parseDateOnly("2026-08-10"), total: -total, finalizedAt: parseDateOnly("2026-08-10"),
    },
  });
  return row.id;
}

/** A payment sitting wholly on account — no applications against it. */
async function onAccountPayment(customerId: string, amount: number, reference = ""): Promise<string> {
  seq += 1;
  const batch = await prisma.receiptBatch.create({
    data: { batchNumber: 830000 + seq, depositDate: parseDateOnly("2026-08-12") },
  });
  const paymentType = await prisma.paymentType.create({ data: { name: `PT-cr-${seq}` } });
  const row = await prisma.payment.create({
    data: {
      batchId: batch.id, customerId, paymentTypeId: paymentType.id,
      amount, reference, receivedDate: parseDateOnly("2026-08-12"),
    },
  });
  return row.id;
}

async function makeCustomer(): Promise<string> {
  seq += 1;
  return (await prisma.customer.create({ data: { code: `CR${seq}`, name: `Customer ${seq}` } })).id;
}

const cents = (n: number) => Math.round(n * 100);

describe("customerReceivablesSummary — the customer page's A/R section", () => {
  // #83 is one property, and this is it. `customerOwnAgingRow` folds open credits and on-account
  // cash into `unapplied`/`net`, but the open-items list was built from finalized INVOICES alone —
  // so the number printed above the table could not be arrived at from the rows in it.
  it("open items SUM to the net shown above them (#83)", async () => {
    const customerId = await makeCustomer();
    await invoice(customerId, 1000);
    await credit(customerId, 200);
    await onAccountPayment(customerId, 150, "CHK 8891");

    const { aging, openItems } = await asSystem(() => customerReceivablesSummary(customerId));

    expect(cents(aging.net)).toBe(cents(650)); // 1000 − 200 − 150
    const summed = openItems.reduce((total, i) => total + cents(i.open), 0);
    expect(summed).toBe(cents(aging.net));

    // ...and each kind is actually THERE, signed the way it affects the net.
    const byKind = new Map(openItems.map((i) => [i.kind, i]));
    expect(cents(byKind.get("INVOICE")!.open)).toBe(cents(1000));
    expect(cents(byKind.get("CREDIT")!.open)).toBe(cents(-200));
    expect(cents(byKind.get("PAYMENT")!.open)).toBe(cents(-150));
  });

  // Review round 1, found independently by both reviewers. The aging strip cuts point-in-time —
  // payments `receivedDate <= asOf`, applications `appliedDate <= asOf`, invoices `finalizedAt <=
  // asOf` — and the open-items read did not cut at all. A post-dated check (nothing stops one: the
  // receipt form takes a bare date) therefore appeared as a row the net did not count, breaking the
  // one property #83 exists to establish.
  it("applies the SAME point-in-time cut as the aging strip, so a post-dated check cannot break the sum (#83)", async () => {
    const customerId = await makeCustomer();
    await invoice(customerId, 1000);
    // Dated well into the future — the aging strip ignores it; the table must too.
    seq += 1;
    const batch = await prisma.receiptBatch.create({
      data: { batchNumber: 840000 + seq, depositDate: parseDateOnly("2099-01-01") } });
    const paymentType = await prisma.paymentType.create({ data: { name: `PT-future-${seq}` } });
    await prisma.payment.create({
      data: {
        batchId: batch.id, customerId, paymentTypeId: paymentType.id,
        amount: 150, reference: "POST-DATED", receivedDate: parseDateOnly("2099-01-01"),
      },
    });

    const { aging, openItems } = await asSystem(() => customerReceivablesSummary(customerId));
    expect(cents(aging.net)).toBe(cents(1000)); // the strip does not see it
    expect(openItems.some((i) => i.documentNumber === "POST-DATED")).toBe(false);
    expect(openItems.reduce((t, i) => t + cents(i.open), 0)).toBe(cents(aging.net));
  });

  it("ignores a post-dated APPLICATION too, so the invoice reads open on both sides (#83)", async () => {
    // The worse half: `appliedDate` follows the payment's `receivedDate`, so a post-dated settlement
    // reduced the table's invoice while the strip still showed it fully open — a net of 1000 over an
    // empty table claiming the customer was settled.
    const customerId = await makeCustomer();
    const invoiceId = await invoice(customerId, 1000);
    seq += 1;
    const batch = await prisma.receiptBatch.create({
      data: { batchNumber: 850000 + seq, depositDate: parseDateOnly("2099-01-01") } });
    const paymentType = await prisma.paymentType.create({ data: { name: `PT-fut-app-${seq}` } });
    const payment = await prisma.payment.create({
      data: {
        batchId: batch.id, customerId, paymentTypeId: paymentType.id,
        amount: 1000, receivedDate: parseDateOnly("2099-01-01"),
      },
    });
    await prisma.application.create({
      data: {
        invoiceId, paymentId: payment.id, type: "PAYMENT", amount: 1000,
        appliedDate: parseDateOnly("2099-01-01"),
      },
    });

    const { aging, openItems } = await asSystem(() => customerReceivablesSummary(customerId));
    expect(cents(aging.net)).toBe(cents(1000));
    expect(openItems).toHaveLength(1);
    expect(cents(openItems[0].open)).toBe(cents(1000)); // still fully open, as the strip says
    expect(openItems.reduce((t, i) => t + cents(i.open), 0)).toBe(cents(aging.net));
  });

  // Review round 2. `finalizedAt` is a bare DateTime carrying a TIME OF DAY, while `asOf` is
  // midnight — so an inclusive `lte` drops everything finalized since midnight TODAY, while the
  // aging strip compares date-only and includes it. Finalize an invoice this morning and the net
  // counts it while the table omits it. CLAUDE.md documents this precise trap for the GL export's
  // month bound ("an inclusive `lte monthEnd`-at-midnight would drop a last-day finalize"); this is
  // the same bug one scope down, and the same fix: a half-open upper bound.
  it("includes an invoice finalized EARLIER TODAY, not just before midnight (#83)", async () => {
    const customerId = await makeCustomer();
    seq += 1;
    const order = await prisma.order.create({
      data: {
        orderNumber: 870000 + seq, customerId, status: "SHIPPED",
        receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
      },
    });
    await prisma.invoice.create({
      data: {
        kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId,
        invoiceDate: todayDateOnly(), dueDate: todayDateOnly(),
        total: 700,
        finalizedAt: new Date(), // right now — a time of day, exactly as `finalizeInvoice` stamps it
      },
    });

    const { aging, openItems } = await asSystem(() => customerReceivablesSummary(customerId));
    expect(cents(aging.net)).toBe(cents(700));
    expect(openItems).toHaveLength(1);
    expect(openItems.reduce((t, i) => t + cents(i.open), 0)).toBe(cents(aging.net));
  });

  it("ignores an invoice finalized in the future, matching the strip (#83)", async () => {
    const customerId = await makeCustomer();
    seq += 1;
    const order = await prisma.order.create({
      data: {
        orderNumber: 860000 + seq, customerId, status: "SHIPPED",
        receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
      },
    });
    await prisma.invoice.create({
      data: {
        kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId,
        invoiceDate: parseDateOnly("2099-01-01"), dueDate: parseDateOnly("2099-02-01"),
        total: 500, finalizedAt: parseDateOnly("2099-01-01"),
      },
    });

    const { aging, openItems } = await asSystem(() => customerReceivablesSummary(customerId));
    expect(cents(aging.net)).toBe(0);
    expect(openItems).toEqual([]);
  });

  it("shows a credit-only customer their credit, not an empty table under a negative net (#83)", async () => {
    // The issue's own example: a customer with nothing but a $200 credit read "−$200.00" above the
    // words "No open invoices."
    const customerId = await makeCustomer();
    await credit(customerId, 200);

    const { aging, openItems } = await asSystem(() => customerReceivablesSummary(customerId));
    expect(cents(aging.net)).toBe(cents(-200));
    expect(openItems).toHaveLength(1);
    expect(openItems[0].kind).toBe("CREDIT");
    expect(cents(openItems[0].open)).toBe(cents(-200));
  });

  it("labels an on-account payment by its reference, falling back when it has none", async () => {
    const customerId = await makeCustomer();
    await onAccountPayment(customerId, 100, "CHK 4402");
    await onAccountPayment(customerId, 50);

    const { openItems } = await asSystem(() => customerReceivablesSummary(customerId));
    const labels = openItems.map((i) => i.documentNumber).sort();
    expect(labels).toEqual(["CHK 4402", "Payment on account"]);
  });

  it("omits settled items entirely — a fully applied credit and a fully applied payment", async () => {
    const customerId = await makeCustomer();
    const invoiceId = await invoice(customerId, 1000);
    const creditId = await credit(customerId, 200);
    const paymentId = await onAccountPayment(customerId, 800);

    // Apply the credit and the cash in full, leaving the invoice settled and nothing on account.
    await prisma.application.create({
      data: {
        invoiceId, creditInvoiceId: creditId, type: "CREDIT", amount: 200,
        appliedDate: parseDateOnly("2026-08-13"),
      },
    });
    await prisma.application.create({
      data: {
        invoiceId, paymentId, type: "PAYMENT", amount: 800,
        appliedDate: parseDateOnly("2026-08-13"),
      },
    });

    const { aging, openItems } = await asSystem(() => customerReceivablesSummary(customerId));
    expect(cents(aging.net)).toBe(0);
    expect(openItems).toEqual([]);
  });

  it("scopes to the ONE customer, never the family (the Task 15 fix round, still true)", async () => {
    const parentId = await makeCustomer();
    seq += 1;
    const divisionId = (await prisma.customer.create({
      data: { code: `DIV${seq}`, name: `Division ${seq}`, parentId },
    })).id;
    await invoice(parentId, 1000);
    await invoice(divisionId, 400);
    await credit(divisionId, 100);

    const division = await asSystem(() => customerReceivablesSummary(divisionId));
    expect(cents(division.aging.net)).toBe(cents(300)); // 400 − 100, the parent's 1000 excluded
    expect(division.openItems.reduce((t, i) => t + cents(i.open), 0)).toBe(cents(300));

    const parent = await asSystem(() => customerReceivablesSummary(parentId));
    expect(cents(parent.aging.net)).toBe(cents(1000)); // its own only, no roll-up
    expect(parent.openItems).toHaveLength(1);
  });

  // #174 — the per-write-off `voidable` flag has to survive the COMPOSITION, because this is the
  // function the route hands straight to `NextResponse.json` and the A/R section renders from. The
  // flag is what turns a Void that always 409s into a disabled control naming the month to reopen
  // (§5.16), so a field lost between `openItemsForCustomer` and here would put the dead control back
  // with nothing to show for it. Both invoices are retained on their OWN open balances — #157's
  // retention bound never gets a say — which is exactly the shape #174 is about.
  it("carries each write-off's `voidable` through the composed read (#174)", async () => {
    const customerId = await makeCustomer();
    const openMonth = await invoice(customerId, 1000);
    const closedMonth = await invoice(customerId, 500,
      { invoiceDate: "2026-07-05", dueDate: "2026-08-04" });
    await standaloneWriteOff(openMonth, 400, "2026-08-13");
    await standaloneWriteOff(closedMonth, 200, "2026-07-20");
    await closeMonthRaw(2026, 7); // only the July one loses its undo

    const { aging, openItems } = await asSystem(() => customerReceivablesSummary(customerId));
    const byId = new Map(openItems.map((i) => [i.id, i]));
    expect(cents(byId.get(openMonth)!.open)).toBe(cents(600));
    expect(byId.get(openMonth)!.writeOffs.map((w) => w.voidable)).toEqual([true]);
    expect(cents(byId.get(closedMonth)!.open)).toBe(cents(300));
    expect(byId.get(closedMonth)!.writeOffs.map((w) => w.voidable)).toEqual([false]);
    // …and #83's property is untouched: a flag moves no money.
    expect(openItems.reduce((t, i) => t + cents(i.open), 0)).toBe(cents(aging.net));
  });
});
