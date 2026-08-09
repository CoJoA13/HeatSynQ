import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";

describe("schema", () => {
  beforeAll(async () => await truncateAll());

  it("creates a user with role and override", async () => {
    const role = await prisma.role.create({ data: { name: "Office" } });
    const user = await prisma.user.create({
      data: {
        username: "jane",
        passwordHash: "x",
        displayName: "Jane",
        roleId: role.id,
        overrides: { create: { permission: "orders.view", mode: "GRANT" } },
      },
      include: { overrides: true },
    });
    expect(user.overrides).toHaveLength(1);
    expect(user.active).toBe(true);
  });

  it("writes an audit row", async () => {
    const row = await prisma.auditLog.create({
      data: { actorName: "system", entity: "User", entityId: "u1", action: "create", after: { a: 1 } },
    });
    expect(row.at).toBeInstanceOf(Date);
  });
});

// Phase 5B Task 2 — the A/R receipts ledger (ReceiptBatch -> Payment -> Application) and the
// Application_source_check that keeps each application to exactly one source per type (spec §4.1).
describe("A/R receipts ledger", () => {
  beforeEach(truncateAll);

  /** A finalized INVOICE to apply against, plus a payer, a payment type, and a batch/payment —
   *  everything the Application FKs need. */
  async function ledgerFixture() {
    const customer = await prisma.customer.create({ data: { code: "ARC", name: "AR Co" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "P-1", eachWeight: "1.0000" },
    });
    const order = await prisma.order.create({
      data: {
        orderNumber: 91001, customerId: customer.id,
        receivedDate: new Date("2026-08-01"), requestDate: new Date("2026-08-05"),
      },
    });
    await prisma.orderLine.create({ data: { orderId: order.id, position: 1, partId: part.id, qty: 1, weight: "1.00" } });
    const invoice = await prisma.invoice.create({
      data: {
        orderId: order.id, customerId: customer.id, status: "FINALIZED",
        invoiceDate: new Date("2026-08-01"), finalizedAt: new Date("2026-08-01"), total: "100.00",
      },
    });
    const paymentType = await prisma.paymentType.create({ data: { name: "Check" } });
    const batch = await prisma.receiptBatch.create({
      data: { batchNumber: 1000, depositDate: new Date("2026-08-08"), controlTotal: "100.00" },
    });
    const payment = await prisma.payment.create({
      data: {
        batchId: batch.id, customerId: customer.id, paymentTypeId: paymentType.id,
        amount: "100.00", reference: "1234", receivedDate: new Date("2026-08-08"),
      },
    });
    return { customer, order, invoice, paymentType, batch, payment };
  }

  it("round-trips a ReceiptBatch -> Payment -> Application (type PAYMENT) against a finalized invoice", async () => {
    const { invoice, batch, payment } = await ledgerFixture();
    const application = await prisma.application.create({
      data: {
        invoiceId: invoice.id, paymentId: payment.id, amount: "100.00",
        type: "PAYMENT", appliedDate: new Date("2026-08-08"),
      },
    });

    const read = await prisma.receiptBatch.findUniqueOrThrow({
      where: { id: batch.id },
      include: { payments: { include: { applications: true } } },
    });
    expect(read.status).toBe("OPEN");
    expect(Number(read.controlTotal)).toBe(100);
    expect(read.payments).toHaveLength(1);
    expect(read.payments[0].reference).toBe("1234");
    expect(read.payments[0].applications).toHaveLength(1);
    const app = read.payments[0].applications[0];
    expect(app.id).toBe(application.id);
    expect(app.type).toBe("PAYMENT");
    expect(app.invoiceId).toBe(invoice.id);
    expect(app.creditInvoiceId).toBeNull();
    expect(Number(app.amount)).toBe(100);
  });

  // Application_source_check (spec §4.1): a CREDIT application's source is a credit memo, never a
  // payment — a CREDIT carrying a paymentId must be rejected by the database, not merely the
  // service layer. Raw insert so nothing in the app can quietly "fix" the payload first.
  it("Application_source_check rejects a CREDIT application that carries a paymentId", async () => {
    const { invoice, payment } = await ledgerFixture();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "Application" ("id", "invoiceId", "amount", "type", "paymentId", "appliedDate", "updatedAt")
        VALUES ('app-bad', ${invoice.id}, 10.00, CAST('CREDIT' AS "ApplicationType"),
                ${payment.id}, DATE '2026-08-08', now())`,
    ).rejects.toMatchObject({
      code: "P2010",
      meta: expect.objectContaining({
        driverAdapterError: expect.objectContaining({
          cause: expect.objectContaining({ originalCode: "23514" }),
        }),
      }),
    });
    expect(await prisma.application.count()).toBe(0);
  });

  // Application_source_check (tightened 20260809120000_application_source_requires_payment): a
  // PAYMENT (or DISCOUNT) must name a payment source — a source-less PAYMENT reduces an invoice's
  // open balance while identifying no receipt, so it can never be reconciled. Only a standalone
  // bad-debt WRITE_OFF may be source-less. Raw insert so nothing in the app can "fix" the payload.
  it("Application_source_check rejects a PAYMENT application with a null paymentId", async () => {
    const { invoice } = await ledgerFixture();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "Application" ("id", "invoiceId", "amount", "type", "appliedDate", "updatedAt")
        VALUES ('app-nopay', ${invoice.id}, 10.00, CAST('PAYMENT' AS "ApplicationType"),
                DATE '2026-08-08', now())`,
    ).rejects.toMatchObject({
      code: "P2010",
      meta: expect.objectContaining({
        driverAdapterError: expect.objectContaining({
          cause: expect.objectContaining({ originalCode: "23514" }),
        }),
      }),
    });
    expect(await prisma.application.count()).toBe(0);
  });
});
