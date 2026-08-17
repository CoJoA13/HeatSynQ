import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { customerReceivablesSummary } from "@/server/customer-receivables";
import { parseDateOnly } from "@/lib/business-days";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

beforeEach(async () => await truncateAll());

let seq = 0;

/** A finalized INVOICE of `total` on its own order, for `customerId`. */
async function invoice(customerId: string, total: number): Promise<string> {
  seq += 1;
  const order = await prisma.order.create({
    data: {
      orderNumber: 810000 + seq, customerId, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
    },
  });
  const row = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId,
      invoiceDate: parseDateOnly("2026-08-08"), dueDate: parseDateOnly("2026-09-07"),
      total, finalizedAt: parseDateOnly("2026-08-08"),
    },
  });
  return row.id;
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
});
