import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import {
  INVOICE_KINDS, INVOICE_STATUSES, INVOICE_LINE_KINDS,
  PRICE_SOURCES, SURCHARGE_KINDS, SURCHARGE_SCOPES,
} from "@/lib/invoice-constants";

/** Everything the pricing and invoicing graphs hang off: a customer, a part, a process step code,
 *  a GL account and an order with one line. */
async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
  const glAccount = await prisma.glAccount.create({ data: { name: "4010" } });
  const stepCode = await prisma.processStepCode.create({
    data: { code: "HT-01", name: "Austenitize", glAccountId: glAccount.id },
  });
  const part = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "500031-HT", name: "Yoke", eachWeight: "1.2500" },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: 72026,
      customerId: customer.id,
      receivedDate: new Date("2026-08-01"),
      requestDate: new Date("2026-08-05"),
    },
  });
  const line = await prisma.orderLine.create({
    data: { orderId: order.id, position: 1, partId: part.id, qty: 10, weight: "12.50" },
  });
  return { customer, glAccount, stepCode, part, order, line };
}

const invoiceBase = (orderId: string, customerId: string) => ({
  orderId, customerId, invoiceDate: new Date("2026-08-06"),
});

describe("pricing and invoicing schema", () => {
  beforeEach(truncateAll);

  // §4.1: a part is priced PER PROCESS STEP CODE, and a break belongs to one priced operation —
  // not to the part as a whole, which is what the PartPriceBreak re-parent is for.
  it("stores the price graph — part → PartPrice (per step code) → PartPriceBreak", async () => {
    const { part, stepCode } = await fixture();

    const price = await prisma.partPrice.create({
      data: {
        partId: part.id, processStepCodeId: stepCode.id, position: 1,
        setupCharge: "75.00", unitPrice: "0.0575", minimumCharge: "125.00", pricePer: "LB",
      },
    });
    await prisma.partPriceBreak.createMany({
      data: [
        { partPriceId: price.id, threshold: "1000.00", price: "0.0500" },
        { partPriceId: price.id, threshold: "500.00", price: "0.0525" },
      ],
    });

    const back = await prisma.part.findFirst({
      where: { id: part.id },
      include: {
        prices: {
          orderBy: { position: "asc" },
          include: {
            processStepCode: { select: { code: true, name: true } },
            breaks: { orderBy: { threshold: "asc" } },
          },
        },
      },
    });
    expect(back?.prices).toHaveLength(1);
    expect(back?.prices[0]?.processStepCode.code).toBe("HT-01");
    expect(back?.prices[0]?.pricePer).toBe("LB");
    // Decimal(12, 4) round-trips; Prisma's Decimal normalizes trailing zeros on toString(), so
    // compare numerically rather than coupling to that rendering (the certs-schema precedent).
    expect(Number(back?.prices[0]?.unitPrice)).toBe(0.0575);
    expect(Number(back?.prices[0]?.setupCharge)).toBe(75);
    expect(Number(back?.prices[0]?.minimumCharge)).toBe(125);
    expect(back?.prices[0]?.breaks.map((b) => Number(b.threshold))).toEqual([500, 1000]);
    expect(back?.prices[0]?.breaks.map((b) => Number(b.price))).toEqual([0.0525, 0.05]);
  });

  // The live-rows-only unique is on ([partPriceId, threshold]) now, so the SAME threshold on two
  // different priced operations of one part is legal — it was not, when breaks hung off the part.
  it("the same threshold is legal on two different price rows of one part", async () => {
    const { part, stepCode } = await fixture();
    const other = await prisma.processStepCode.create({ data: { code: "HT-02", name: "Temper" } });

    const a = await prisma.partPrice.create({
      data: { partId: part.id, processStepCodeId: stepCode.id, position: 1 },
    });
    const b = await prisma.partPrice.create({
      data: { partId: part.id, processStepCodeId: other.id, position: 2 },
    });
    await prisma.partPriceBreak.create({ data: { partPriceId: a.id, threshold: "500", price: "0.95" } });
    await prisma.partPriceBreak.create({ data: { partPriceId: b.id, threshold: "500", price: "0.80" } });

    await expect(
      prisma.partPriceBreak.create({ data: { partPriceId: a.id, threshold: "500", price: "0.90" } }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.partPriceBreak.count()).toBe(2);
  });

  // §4.3: OPERATION lines hang off their PART line by a self-relation, never by a parent POSITION
  // — a draft edit can renumber positions, and grouping identity must not rest on a reusable value.
  it("stores the invoice graph — invoice → lines, with a child line hanging off its parent", async () => {
    const { order, customer, line, stepCode, glAccount } = await fixture();

    const invoice = await prisma.invoice.create({
      data: {
        ...invoiceBase(order.id, customer.id),
        poNumber: "PO-77", termsName: "Net 30", billTo: "Acme\n1 Main St", shipTo: "Acme Plant 2",
        materialName: "Ductile iron", processNames: "Austenitize, Temper",
        taxRate: "0.065000", subtotal: "500.00", surchargeTotal: "20.00", total: "553.00",
      },
    });
    const partLine = await prisma.invoiceLine.create({
      data: {
        invoiceId: invoice.id, position: 1, kind: "PART", orderLineId: line.id,
        partNumber: "500031-HT", partName: "Yoke", qty: 10, weight: "12.50", eachWeight: "1.2500",
      },
    });
    const opLine = await prisma.invoiceLine.create({
      data: {
        invoiceId: invoice.id, position: 2, kind: "OPERATION", parentLineId: partLine.id,
        processStepCodeId: stepCode.id, glAccountId: glAccount.id, glAccountName: "4010",
        description: "Austenitize", pricePer: "LB", unitPrice: "0.0575", setupCharge: "75.00",
        minimumCharge: "125.00", breakThreshold: "500.00", minimumApplied: true,
        priceSource: "PART_PRICE", amount: "500.00",
      },
    });

    const back = await prisma.invoice.findFirst({
      where: { id: invoice.id },
      include: {
        customer: { select: { code: true } },
        order: { select: { orderNumber: true } },
        lines: {
          orderBy: { position: "asc" },
          include: {
            children: true,
            processStepCode: { select: { code: true } },
            glAccount: { select: { name: true } },
            orderLine: { select: { position: true } },
          },
        },
      },
    });
    expect(back?.kind).toBe("INVOICE");
    expect(back?.status).toBe("DRAFT");
    expect(back?.creditNumber).toBeNull();
    expect(back?.customer.code).toBe("AC");
    expect(back?.order.orderNumber).toBe(72026);
    expect(Number(back?.taxRate)).toBe(0.065);
    expect(Number(back?.total)).toBe(553);
    expect(Number(back?.certTotal)).toBe(0); // defaults to 0, never null
    expect(back?.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION"]);
    expect(back?.lines[0]?.orderLine?.position).toBe(1);
    expect(back?.lines[0]?.children.map((c) => c.id)).toEqual([opLine.id]);
    expect(back?.lines[1]?.parentLineId).toBe(partLine.id);
    expect(back?.lines[1]?.processStepCode?.code).toBe("HT-01");
    expect(back?.lines[1]?.glAccount?.name).toBe("4010");
    expect(back?.lines[1]?.minimumApplied).toBe(true);
    expect(back?.lines[1]?.priceSource).toBe("PART_PRICE");
    expect(Number(back?.lines[1]?.unitPrice)).toBe(0.0575);
  });

  // Ruling 5, enforced by the DATABASE rather than by a service check a race could slip past:
  // @@unique([orderId], where: "deletedAt IS NULL AND kind = 'INVOICE'").
  it("one live INVOICE per order — a second is rejected", async () => {
    const { order, customer } = await fixture();
    await prisma.invoice.create({ data: invoiceBase(order.id, customer.id) });
    await expect(prisma.invoice.create({ data: invoiceBase(order.id, customer.id) }))
      .rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.invoice.count()).toBe(1);
  });

  // §5.5: discarding a DRAFT soft-deletes it, and that must free the order to be invoiced again —
  // the whole reason the index is filtered on deletedAt.
  it("a discarded (soft-deleted) invoice frees the order for a new one", async () => {
    const { order, customer } = await fixture();
    const first = await prisma.invoice.create({ data: invoiceBase(order.id, customer.id) });
    await prisma.invoice.update({ where: { id: first.id }, data: { deletedAt: new Date() } });

    const second = await prisma.invoice.create({ data: invoiceBase(order.id, customer.id) });
    expect(second.id).not.toBe(first.id);
    expect(await prisma.invoice.count({ where: { deletedAt: null } })).toBe(1);
  });

  // Credits are excluded from that index on purpose: an invoice may be credited more than once.
  it("credits sit alongside a live invoice on the same order, and more than one is legal", async () => {
    const { order, customer } = await fixture();
    const invoice = await prisma.invoice.create({ data: invoiceBase(order.id, customer.id) });

    const creditA = await prisma.invoice.create({
      data: { ...invoiceBase(order.id, customer.id), kind: "CREDIT", creditNumber: 1000, sourceInvoiceId: invoice.id },
    });
    const creditB = await prisma.invoice.create({
      data: { ...invoiceBase(order.id, customer.id), kind: "CREDIT", creditNumber: 1001, sourceInvoiceId: invoice.id },
    });

    const back = await prisma.invoice.findFirst({ where: { id: invoice.id }, include: { credits: true } });
    expect(back?.credits.map((c) => c.id).sort()).toEqual([creditA.id, creditB.id].sort());
    expect(await prisma.invoice.count()).toBe(3);
  });

  // The two documented sweep exemptions, proved rather than merely asserted in a comment: a
  // discarded draft must never hand its credit number or its idempotency nonce back.
  it("creditNumber and clientRequestId stay taken after an invoice is discarded", async () => {
    const { order, customer } = await fixture();
    const other = await prisma.order.create({
      data: {
        orderNumber: 72027, customerId: customer.id,
        receivedDate: new Date("2026-08-01"), requestDate: new Date("2026-08-05"),
      },
    });

    const first = await prisma.invoice.create({
      data: { ...invoiceBase(order.id, customer.id), kind: "CREDIT", creditNumber: 2000, clientRequestId: "nonce-1" },
    });
    await prisma.invoice.update({ where: { id: first.id }, data: { deletedAt: new Date() } });

    await expect(prisma.invoice.create({
      data: { ...invoiceBase(other.id, customer.id), kind: "CREDIT", creditNumber: 2000 },
    })).rejects.toMatchObject({ code: "P2002" });
    await expect(prisma.invoice.create({
      data: { ...invoiceBase(other.id, customer.id), clientRequestId: "nonce-1" },
    })).rejects.toMatchObject({ code: "P2002" });

    // NULLs never collide in a Postgres unique index — an ordinary invoice carries neither.
    await prisma.invoice.create({ data: invoiceBase(other.id, customer.id) });
  });

  // Rulings 23-24 (snapshot + release), extended to invoice lines: an order correction must never
  // be blocked by an invoice that already billed the line, and the snapshot keeps rendering it.
  it("an invoice line releases its order line rather than blocking the delete", async () => {
    const { order, customer, line } = await fixture();
    const invoice = await prisma.invoice.create({ data: invoiceBase(order.id, customer.id) });
    const billed = await prisma.invoiceLine.create({
      data: {
        invoiceId: invoice.id, position: 1, kind: "PART", orderLineId: line.id,
        partNumber: "500031-HT", partName: "Yoke", qty: 10,
      },
    });

    await prisma.orderLine.delete({ where: { id: line.id } });

    const back = await prisma.invoiceLine.findFirst({ where: { id: billed.id } });
    expect(back?.orderLineId).toBeNull();     // released, not cascaded away
    expect(back?.partNumber).toBe("500031-HT"); // the snapshot still prints
  });

  // The enum members and their ORDER are the contract Task 1's constant arrays and every later
  // task's zod schemas are written against. Compared against pg_enum, not against the generated
  // client, because the database's own sort order is what a mis-ordered ALTER TYPE would corrupt.
  it("every new Postgres enum matches its src/lib/invoice-constants.ts array, in order", async () => {
    const expected: Record<string, readonly string[]> = {
      InvoiceKind: INVOICE_KINDS,
      InvoiceStatus: INVOICE_STATUSES,
      InvoiceLineKind: INVOICE_LINE_KINDS,
      PriceSource: PRICE_SOURCES,
      SurchargeKind: SURCHARGE_KINDS,
      SurchargeScope: SURCHARGE_SCOPES,
    };
    for (const [typeName, members] of Object.entries(expected)) {
      const rows = await prisma.$queryRaw<{ enumlabel: string }[]>`
        SELECT e.enumlabel FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = ${typeName}
        ORDER BY e.enumsortorder`;
      expect(rows.map((r) => r.enumlabel), typeName).toEqual([...members]);
    }
  });

  // DocumentKind's two new values live in their own migration for the transaction reason spelled
  // out there; this pins that they landed, and landed after the Phase 4 four.
  it("DocumentKind carries INVOICE and CREDIT, appended after the Phase 4 values", async () => {
    const rows = await prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'DocumentKind'
      ORDER BY e.enumsortorder`;
    expect(rows.map((r) => r.enumlabel)).toEqual([
      "TRAVELER", "SHIPPER", "BOL", "CERT", "INVOICE", "CREDIT",
    ]);
  });
});

// StoredDocument widened from three owner columns to four, and which one is required is decided by
// `kind`. Prisma's schema language has no check-constraint syntax, so the pairing is a hand-written
// DB CHECK — and the generated client's types make the illegal combinations uncompilable, which is
// why every case below goes through $executeRaw. The point is proving the DATABASE refuses them.
describe("StoredDocument kind/owner CHECK constraint — the INVOICE and CREDIT arm", () => {
  beforeEach(truncateAll);

  function insertDocument(
    id: string, kind: string,
    owners: { orderId?: string | null; shipperId?: string | null; certId?: string | null; invoiceId?: string | null },
  ) {
    return prisma.$executeRaw`
      INSERT INTO "StoredDocument" ("id", "orderId", "shipperId", "certId", "invoiceId", "kind", "fileData")
      VALUES (${id}, ${owners.orderId ?? null}, ${owners.shipperId ?? null}, ${owners.certId ?? null},
              ${owners.invoiceId ?? null}, CAST(${kind} AS "DocumentKind"), decode('70646673', 'hex'))`;
  }

  const checkViolation = {
    code: "P2010",
    meta: expect.objectContaining({
      driverAdapterError: expect.objectContaining({
        cause: expect.objectContaining({ originalCode: "23514" }),
      }),
    }),
  };

  async function owners() {
    const { order, customer } = await fixture();
    const cert = await prisma.cert.create({ data: { orderId: order.id, scope: "ORDER" } });
    const invoice = await prisma.invoice.create({ data: invoiceBase(order.id, customer.id) });
    return { order, cert, invoice };
  }

  it("accepts an INVOICE and a CREDIT owned by invoiceId alone", async () => {
    const { invoice } = await owners();
    await insertDocument("doc-invoice", "INVOICE", { invoiceId: invoice.id });
    await insertDocument("doc-credit", "CREDIT", { invoiceId: invoice.id });
    expect(await prisma.storedDocument.count()).toBe(2);
  });

  it("rejects an INVOICE document that also names an order", async () => {
    const { order, invoice } = await owners();
    await expect(insertDocument("bad-1", "INVOICE", { invoiceId: invoice.id, orderId: order.id }))
      .rejects.toMatchObject(checkViolation);
    expect(await prisma.storedDocument.count()).toBe(0);
  });

  it("rejects an INVOICE (and a CREDIT) document with no invoice at all", async () => {
    await owners();
    await expect(insertDocument("bad-2", "INVOICE", {})).rejects.toMatchObject(checkViolation);
    await expect(insertDocument("bad-3", "CREDIT", {})).rejects.toMatchObject(checkViolation);
    expect(await prisma.storedDocument.count()).toBe(0);
  });

  it("rejects a CERT document that also names an invoice", async () => {
    const { cert, invoice } = await owners();
    await expect(insertDocument("bad-4", "CERT", { certId: cert.id, invoiceId: invoice.id }))
      .rejects.toMatchObject(checkViolation);
    expect(await prisma.storedDocument.count()).toBe(0);
  });

  // The four Phase 4 arms gained an `"invoiceId" IS NULL` clause each; this pins that the
  // re-statement did not quietly loosen the one that is deliberately loose on orderId.
  it("still rejects a TRAVELER carrying an invoice, and a SHIPPER with no shipment", async () => {
    const { order, invoice } = await owners();
    await expect(insertDocument("bad-5", "TRAVELER", { orderId: order.id, invoiceId: invoice.id }))
      .rejects.toMatchObject(checkViolation);
    await expect(insertDocument("bad-6", "SHIPPER", { orderId: order.id }))
      .rejects.toMatchObject(checkViolation);
    expect(await prisma.storedDocument.count()).toBe(0);
  });
});

// §4.5: BillingConfig is a singleton by construction, not by convention. The row itself is seeded
// by the migration (and restored by truncateAll, which would otherwise delete it) so that
// getBillingConfig stays a plain findFirst rather than a lazy create.
describe("BillingConfig singleton", () => {
  beforeEach(truncateAll);

  it("carries exactly the seeded row after a truncate", async () => {
    const rows = await prisma.billingConfig.findMany();
    expect(rows.map((r) => r.id)).toEqual(["singleton"]);
    expect(rows[0].billForCertDefault).toBe(false);
    expect(rows[0].salesTaxGlAccountId).toBeNull();
  });

  it("BillingConfig_singleton_check rejects any other id", async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "BillingConfig" ("id", "updatedAt") VALUES ('other', now())`,
    ).rejects.toMatchObject({
      code: "P2010",
      meta: expect.objectContaining({
        driverAdapterError: expect.objectContaining({
          cause: expect.objectContaining({ originalCode: "23514" }),
        }),
      }),
    });
    expect(await prisma.billingConfig.count()).toBe(1);
  });

  it("holds real foreign keys, not cuids in JSON — so a delete guard can name its blockers", async () => {
    const { glAccount, stepCode } = await fixture();
    await prisma.billingConfig.update({
      where: { id: "singleton" },
      data: {
        salesTaxRate: "0.065000", salesTaxGlAccountId: glAccount.id,
        freightGlAccountId: glAccount.id, otherChargeGlAccountId: glAccount.id,
        certChargeStepCodeId: stepCode.id, certChargeDefault: "35.00", billForCertDefault: true,
      },
    });
    const back = await prisma.billingConfig.findFirst({
      include: {
        salesTaxGlAccount: { select: { name: true } },
        freightGlAccount: { select: { name: true } },
        otherChargeGlAccount: { select: { name: true } },
        certChargeStepCode: { select: { code: true } },
      },
    });
    expect(back?.salesTaxGlAccount?.name).toBe("4010");
    expect(back?.freightGlAccount?.name).toBe("4010");
    expect(back?.otherChargeGlAccount?.name).toBe("4010");
    expect(back?.certChargeStepCode?.code).toBe("HT-01");
    expect(Number(back?.salesTaxRate)).toBe(0.065);
    expect(back?.billForCertDefault).toBe(true);
  });
});
