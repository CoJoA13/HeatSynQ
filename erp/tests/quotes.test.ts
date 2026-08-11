import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";

/**
 * Phase 6 Task 1 — SCHEMA smoke only: the quote service (create/list/worklist and its own TDD
 * suite) is Task 3. This proves the data layer the two hand-written migrations built — the
 * Quote → QuoteLine → QuotePrice → QuotePriceBreak tree, the partial uniques, and the
 * allocation-only quoteNumber — actually exists and holds a whole quote, via raw prisma.
 */
describe("quoting schema (Task 1 smoke)", () => {
  beforeEach(truncateAll);

  async function fixtures() {
    const user = await prisma.user.create({
      data: { username: "quoter", passwordHash: "x", displayName: "Quoter" },
    });
    const customer = await prisma.customer.create({ data: { code: "AC1", name: "Acme" } });
    const contact = await prisma.customerContact.create({
      data: { customerId: customer.id, name: "Pat Buyer" },
    });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "P-100", eachWeight: "2.5000" },
    });
    const stepCode = await prisma.processStepCode.create({ data: { code: "HT", name: "Harden" } });
    const statement = await prisma.endingStatement.create({
      data: { name: "Standard", text: "Thank you for the opportunity to quote.", isDefault: true },
    });
    return { user, customer, contact, part, stepCode, statement };
  }

  it("creates a full Quote + line + price + break tree and reads it back", async () => {
    const { user, customer, contact, part, stepCode, statement } = await fixtures();

    const quote = await prisma.quote.create({
      data: {
        quoteNumber: 1000,
        customerId: customer.id,
        contactId: contact.id,
        quoteDate: new Date("2026-08-10"),
        effectiveDate: new Date("2026-08-10"),
        expiryDate: new Date("2026-09-09"),
        rfqNumber: "RFQ-42",
        quotedById: user.id,
        endingStatementId: statement.id,
        notes: "prints",
        internalNotes: "never prints",
        lines: {
          create: [
            {
              position: 1, partId: part.id, quotedQty: 500,
              prices: {
                create: [{
                  processStepCodeId: stepCode.id, position: 1,
                  setupCharge: "2.00", unitPrice: "0.1500", minimumCharge: "100.00", pricePer: "EACH",
                  notes: "per sample",
                  breaks: { create: [{ threshold: "1000.00", price: "0.1200" }] },
                }],
              },
            },
            // A free-text line (ruling 1): paper-only identity, no part.
            {
              position: 2, partNumberText: "FT-1", partNameText: "Widget", materialText: "4140",
              eachWeight: "1.2500", quotedUnlimited: true,
            },
          ],
        },
      },
    });

    const back = await prisma.quote.findFirst({
      where: { id: quote.id, deletedAt: null },
      include: {
        customer: true, contact: true, endingStatement: true, quotedBy: true,
        lines: {
          orderBy: { position: "asc" },
          include: { part: true, prices: { include: { breaks: true, processStepCode: true } } },
        },
      },
    });

    expect(back).not.toBeNull();
    expect(back?.quoteNumber).toBe(1000);
    expect(back?.status).toBe("OPEN"); // the column default
    expect(back?.customer.code).toBe("AC1");
    expect(back?.contact?.name).toBe("Pat Buyer");
    expect(back?.endingStatement?.name).toBe("Standard");
    expect(back?.quotedBy.displayName).toBe("Quoter");
    expect(back?.lines).toHaveLength(2);

    const linked = back!.lines[0];
    expect(linked.part?.partNumber).toBe("P-100");
    expect(linked.quotedQty).toBe(500);
    expect(linked.prices).toHaveLength(1);
    expect(linked.prices[0].processStepCode.code).toBe("HT");
    expect(linked.prices[0].unitPrice?.toString()).toBe("0.15");
    expect(linked.prices[0].breaks).toHaveLength(1);
    expect(linked.prices[0].breaks[0].price?.toString()).toBe("0.12");

    const freeText = back!.lines[1];
    expect(freeText.partId).toBeNull();
    expect(freeText.partNumberText).toBe("FT-1");
    expect(freeText.quotedUnlimited).toBe(true);
    expect(freeText.eachWeight?.toString()).toBe("1.25");
  });

  // Allocation-only, never reused (spec §4.1; the Order.orderNumber precedent and the documented
  // sweep exemption): a deleted quote keeps its number FOREVER — no revival, no reuse.
  it("quoteNumber stays taken after the quote is soft-deleted", async () => {
    const { user, customer } = await fixtures();
    const dates = {
      quoteDate: new Date("2026-08-10"), effectiveDate: new Date("2026-08-10"),
      expiryDate: new Date("2026-09-09"),
    };
    const first = await prisma.quote.create({
      data: { quoteNumber: 1000, customerId: customer.id, quotedById: user.id, ...dates },
    });
    await prisma.quote.update({ where: { id: first.id }, data: { deletedAt: new Date() } });

    await expect(
      prisma.quote.create({
        data: { quoteNumber: 1000, customerId: customer.id, quotedById: user.id, ...dates },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  // The two live-rows-only partial uniques the _quoting migration created: a live duplicate is
  // refused, a soft-deleted row frees its value (the opposite contract from quoteNumber above).
  it("QuotePrice is unique per (quoteLineId, processStepCodeId) among LIVE rows only", async () => {
    const { user, customer, part, stepCode } = await fixtures();
    const quote = await prisma.quote.create({
      data: {
        quoteNumber: 1000, customerId: customer.id, quotedById: user.id,
        quoteDate: new Date("2026-08-10"), effectiveDate: new Date("2026-08-10"),
        expiryDate: new Date("2026-09-09"),
        lines: { create: [{ position: 1, partId: part.id }] },
      },
      include: { lines: true },
    });
    const line = quote.lines[0];

    const row = await prisma.quotePrice.create({
      data: { quoteLineId: line.id, processStepCodeId: stepCode.id, position: 1 },
    });
    await expect(
      prisma.quotePrice.create({
        data: { quoteLineId: line.id, processStepCodeId: stepCode.id, position: 2 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    // Soft-delete the row and the slot frees — a re-priced step is a genuinely NEW row.
    await prisma.quotePrice.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
    const again = await prisma.quotePrice.create({
      data: { quoteLineId: line.id, processStepCodeId: stepCode.id, position: 1 },
    });
    expect(again.id).not.toBe(row.id);
  });

  it("EndingStatement.name is unique among LIVE rows only", async () => {
    const first = await prisma.endingStatement.create({ data: { name: "Standard" } });
    await expect(prisma.endingStatement.create({ data: { name: "Standard" } }))
      .rejects.toMatchObject({ code: "P2002" });
    await prisma.endingStatement.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
    const again = await prisma.endingStatement.create({ data: { name: "Standard" } });
    expect(again.id).not.toBe(first.id);
  });

  // The StoredDocument CHECK gained its QUOTE arm (owner = quoteId alone) and every other arm
  // now also asserts "quoteId" IS NULL. Raw SQL because the generated client's types already
  // make the illegal combinations uncompilable — the point is the DATABASE refusing them.
  it("the kind→owner CHECK accepts a QUOTE document and refuses cross-owner rows", async () => {
    const { user, customer } = await fixtures();
    const quote = await prisma.quote.create({
      data: {
        quoteNumber: 1000, customerId: customer.id, quotedById: user.id,
        quoteDate: new Date("2026-08-10"), effectiveDate: new Date("2026-08-10"),
        expiryDate: new Date("2026-09-09"),
      },
    });
    const checkViolation = { message: expect.stringContaining("StoredDocument_kind_owner_check") };

    await prisma.$executeRaw`
      INSERT INTO "StoredDocument" ("id", "quoteId", "kind", "fileData")
      VALUES ('doc-quote', ${quote.id}, 'QUOTE', decode('70646673', 'hex'))`;

    // QUOTE without its owner.
    await expect(prisma.$executeRaw`
      INSERT INTO "StoredDocument" ("id", "kind", "fileData")
      VALUES ('bad-1', 'QUOTE', decode('70646673', 'hex'))`).rejects.toMatchObject(checkViolation);

    // QUOTE smuggling a second owner column.
    await expect(prisma.$executeRaw`
      INSERT INTO "StoredDocument" ("id", "quoteId", "customerId", "kind", "fileData")
      VALUES ('bad-2', ${quote.id}, ${customer.id}, 'QUOTE', decode('70646673', 'hex'))`)
      .rejects.toMatchObject(checkViolation);

    // An existing arm now also asserts "quoteId" IS NULL — a STATEMENT carrying a quoteId fails.
    await expect(prisma.$executeRaw`
      INSERT INTO "StoredDocument" ("id", "customerId", "quoteId", "kind", "fileData")
      VALUES ('bad-3', ${customer.id}, ${quote.id}, 'STATEMENT', decode('70646673', 'hex'))`)
      .rejects.toMatchObject(checkViolation);
  });
});
