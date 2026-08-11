import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { setSetting } from "@/server/settings";
import { addDays, formatDateOnly, todayDateOnly } from "@/lib/business-days";
import ExcelJS from "exceljs";
import {
  createQuote, getQuote, listQuotes, quoteWorklist, exportQuotes,
  updateQuote, attachPart, closeQuote, reopenQuote, deleteQuote, quoteOrderBlockers,
} from "@/server/quotes";

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

// ============================================================================================
// Phase 6 Task 3 — the quote SERVICE: createQuote / getQuote / listQuotes / worklist / export.
// ============================================================================================

const asUser = <T>(user: { id: string; displayName: string }, fn: () => Promise<T>) =>
  runWithContext({ actor: { id: user.id, name: user.displayName }, user: null }, fn);
const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const today = () => todayDateOnly();
const iso = (d: Date) => formatDateOnly(d);
const daysFromToday = (n: number) => iso(addDays(todayDateOnly(), n));

/** Everything a quote can reference: a quoter, two customers, parts (one with material + name +
 *  description), a contact, two step codes, and a default ending statement. */
async function serviceFixture() {
  const quoter = await prisma.user.create({
    data: { username: "quoter", passwordHash: "x", displayName: "Quinn Quoter" },
  });
  const second = await prisma.user.create({
    data: { username: "second", passwordHash: "x", displayName: "Sam Second" },
  });
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Foundry" } });
  const other = await prisma.customer.create({ data: { code: "BETA", name: "Beta Co" } });
  const material = await prisma.material.create({ data: { name: "4140" } });
  const part = await prisma.part.create({
    data: {
      customerId: customer.id, partNumber: "P-100", name: "Pinion", description: "A pinion gear",
      eachWeight: "2.5000", materialId: material.id,
    },
  });
  const part2 = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "P-200", eachWeight: "1.0000" },
  });
  const otherPart = await prisma.part.create({
    data: { customerId: other.id, partNumber: "X-900", eachWeight: "1.0000" },
  });
  const contact = await prisma.customerContact.create({
    data: { customerId: customer.id, name: "Pat Buyer" },
  });
  const otherContact = await prisma.customerContact.create({
    data: { customerId: other.id, name: "Robin Rival" },
  });
  const harden = await prisma.processStepCode.create({ data: { code: "HT", name: "Harden" } });
  const temper = await prisma.processStepCode.create({ data: { code: "TMP", name: "Temper" } });
  const statement = await prisma.endingStatement.create({
    data: { name: "Standard", text: "Thank you for the opportunity to quote.", isDefault: true },
  });
  return { quoter, second, customer, other, material, part, part2, otherPart, contact, otherContact,
    harden, temper, statement };
}

/** One valid linked line for `part` with one priced operation — the minimal happy payload. */
function linkedLine(partId: string, stepId: string) {
  return {
    partId,
    prices: [{ processStepCodeId: stepId, setupCharge: "2.00", unitPrice: "0.1500",
      minimumCharge: "100.00", pricePer: "EACH" }],
  };
}

describe("createQuote: defaults and numbering", () => {
  beforeEach(truncateAll);

  it("fills every entry default: today's dates, the settings-driven expiry, the actor, the default ending statement", async () => {
    const f = await serviceFixture();
    const detail = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, lines: [linkedLine(f.part.id, f.harden.id)],
    }));

    expect(detail.quoteNumber).toBe(1000); // the seeded counter default
    expect(detail.status).toBe("OPEN");
    expect(detail.expired).toBe(false);
    expect(detail.quoteDate).toBe(iso(today()));
    expect(detail.effectiveDate).toBe(detail.quoteDate);
    expect(detail.expiryDate).toBe(daysFromToday(30)); // quote_valid_days default
    expect(detail.followUpDate).toBeNull();
    expect(detail.quotedById).toBe(f.quoter.id);
    expect(detail.quotedByName).toBe("Quinn Quoter");
    expect(detail.endingStatementId).toBe(f.statement.id); // the kind's live default row
    expect(detail.endingStatementName).toBe("Standard");
    expect(detail.contactId).toBeNull();
    expect(detail.contactName).toBe("");
    // The counter moved.
    const setting = await prisma.setting.findUniqueOrThrow({ where: { key: "quote_number_next" } });
    expect(setting.value).toBe(1001);
  });

  it("expiry follows quote_valid_days from the QUOTE date, and effective defaults to the quote date", async () => {
    const f = await serviceFixture();
    await asSystem(() => setSetting("quote_valid_days", 45));
    const detail = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, quoteDate: "2026-08-01",
      lines: [linkedLine(f.part.id, f.harden.id)],
    }));
    expect(detail.quoteDate).toBe("2026-08-01");
    expect(detail.effectiveDate).toBe("2026-08-01");
    expect(detail.expiryDate).toBe("2026-09-15"); // 2026-08-01 + 45 calendar days
  });

  it("continues from the configured seed", async () => {
    const f = await serviceFixture();
    await asSystem(() => setSetting("quote_number_next", 5200));
    const detail = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, lines: [linkedLine(f.part.id, f.harden.id)],
    }));
    expect(detail.quoteNumber).toBe(5200);
  });

  it("explicit ending statement beats the default; explicit null means none even when a default exists; no default means none", async () => {
    const f = await serviceFixture();
    const alt = await prisma.endingStatement.create({ data: { name: "Alt", text: "Alt text." } });

    const picked = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, endingStatementId: alt.id,
      lines: [linkedLine(f.part.id, f.harden.id)],
    }));
    expect(picked.endingStatementId).toBe(alt.id);

    const none = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, endingStatementId: null,
      lines: [linkedLine(f.part.id, f.harden.id)],
    }));
    expect(none.endingStatementId).toBeNull();
    expect(none.endingStatementName).toBe("");

    await prisma.endingStatement.update({ where: { id: f.statement.id }, data: { isDefault: false } });
    const defaultless = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, lines: [linkedLine(f.part.id, f.harden.id)],
    }));
    expect(defaultless.endingStatementId).toBeNull();
  });

  it("quotedById is overridable; a deleted user or an actor-less create without one is refused", async () => {
    const f = await serviceFixture();
    const overridden = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, quotedById: f.second.id,
      lines: [linkedLine(f.part.id, f.harden.id)],
    }));
    expect(overridden.quotedById).toBe(f.second.id);
    expect(overridden.quotedByName).toBe("Sam Second");

    await prisma.user.update({ where: { id: f.second.id }, data: { deletedAt: new Date() } });
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, quotedById: f.second.id,
      lines: [linkedLine(f.part.id, f.harden.id)],
    }))).rejects.toThrow("That quoted-by user does not exist");

    await expect(asSystem(() => createQuote({
      customerId: f.customer.id, lines: [linkedLine(f.part.id, f.harden.id)],
    }))).rejects.toThrow("Quoted by is required");
  });

  it("consumes no quote number when the create fails — the whole transaction rolls back", async () => {
    const f = await serviceFixture();
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id,
      lines: [{ partId: f.otherPart.id, prices: [] }], // another customer's part — refused
    }))).rejects.toMatchObject({ status: 400 });
    expect(await prisma.quote.count()).toBe(0);

    const detail = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, lines: [linkedLine(f.part.id, f.harden.id)],
    }));
    expect(detail.quoteNumber).toBe(1000); // the failed attempt left no gap
  });

  // The allocation contract under real concurrency: allocateNumber's SELECT ... FOR UPDATE on the
  // Setting row serializes the two creates. A loser may surface as a clean 409 (Serializable
  // write-write on the counter row) — retried, never absorbed as a duplicate or a gap.
  // RED-verified by replacing the allocateNumber call with a naive unguarded read-then-increment
  // and dropping the transaction to Read Committed: both creates read 1000, one collides on the
  // plain quoteNumber unique and surfaces as a 400 this helper refuses to absorb.
  it("two concurrent creates get distinct, consecutive numbers and never share one", async () => {
    const f = await serviceFixture();
    const input = { customerId: f.customer.id, lines: [linkedLine(f.part.id, f.harden.id)] };

    const settled = await Promise.allSettled(
      [input, input].map((i) => asUser(f.quoter, () => createQuote(i))));
    const numbers: number[] = [];
    for (const [i, result] of settled.entries()) {
      if (result.status === "fulfilled") { numbers.push(result.value.quoteNumber); continue; }
      expect(result.reason).toMatchObject({ status: 409 });
      const retried = await asUser(f.quoter, () => createQuote([input, input][i]));
      numbers.push(retried.quoteNumber);
    }

    expect(new Set(numbers).size).toBe(2);
    expect([...numbers].sort((a, b) => a - b)).toEqual([1000, 1001]);
    const stored = await prisma.quote.findMany({ select: { quoteNumber: true }, orderBy: { quoteNumber: "asc" } });
    expect(stored.map((q) => q.quoteNumber)).toEqual([1000, 1001]);
  });
});

describe("createQuote: validation", () => {
  beforeEach(truncateAll);

  it("refuses an effective date after the expiry date", async () => {
    const f = await serviceFixture();
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, effectiveDate: "2026-09-01", expiryDate: "2026-08-01",
      lines: [linkedLine(f.part.id, f.harden.id)],
    }))).rejects.toThrow("The effective date must be on or before the expiry date");
    // Equal dates are a one-day window, not an error.
    const oneDay = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, effectiveDate: "2026-08-01", expiryDate: "2026-08-01",
      lines: [linkedLine(f.part.id, f.harden.id)],
    }));
    expect(oneDay.effectiveDate).toBe(oneDay.expiryDate);
  });

  it("refuses a malformed date, field-anchored", async () => {
    const f = await serviceFixture();
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, expiryDate: "not-a-date",
      lines: [linkedLine(f.part.id, f.harden.id)],
    }))).rejects.toThrow("Expiry date");
  });

  it("line identity is partId XOR a non-empty trimmed free-text part number", async () => {
    const f = await serviceFixture();
    // Both.
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id,
      lines: [{ partId: f.part.id, partNumberText: "FT-1", prices: [] }],
    }))).rejects.toThrow("Line 1: a line cannot carry both a part and a free-text part number");
    // Neither.
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, lines: [{ prices: [] }],
    }))).rejects.toThrow("Line 1: each line needs a part or a free-text part number");
    // Whitespace-only free text is empty — still neither.
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, lines: [{ partNumberText: "   ", prices: [] }],
    }))).rejects.toThrow("Line 1: each line needs a part or a free-text part number");
  });

  it("a linked part must exist, be live, and belong to the quote's customer", async () => {
    const f = await serviceFixture();
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, lines: [{ partId: "nope", prices: [] }],
    }))).rejects.toThrow("Line 1: that part does not exist");

    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, lines: [{ partId: f.otherPart.id, prices: [] }],
    }))).rejects.toThrow("Line 1 (BETA · X-900): that part belongs to another customer");

    await prisma.part.update({ where: { id: f.part2.id }, data: { deletedAt: new Date() } });
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, lines: [{ partId: f.part2.id, prices: [] }],
    }))).rejects.toThrow("Line 1: that part does not exist");
  });

  // The rule the DB cannot enforce: the partial unique is per (quoteLineId, processStepCodeId) —
  // two LINES for one part sail straight through it, so the service must catch the payload dup.
  it("refuses two lines for the same part inside one payload (one live line per part per quote)", async () => {
    const f = await serviceFixture();
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id,
      lines: [linkedLine(f.part.id, f.harden.id), { partId: f.part.id, prices: [] }],
    }))).rejects.toThrow("Line 2 (ACME · P-100): that part is already quoted on this quote");
    expect(await prisma.quote.count()).toBe(0);

    // Two DIFFERENT parts, each priced for the same operation, are fine.
    const ok = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id,
      lines: [linkedLine(f.part.id, f.harden.id), linkedLine(f.part2.id, f.harden.id)],
    }));
    expect(ok.lines).toHaveLength(2);
  });

  it("price rows must key to live step codes, once per line", async () => {
    const f = await serviceFixture();
    await prisma.processStepCode.update({ where: { id: f.temper.id }, data: { deletedAt: new Date() } });
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id,
      lines: [{ partId: f.part.id, prices: [{ processStepCodeId: f.temper.id }] }],
    }))).rejects.toThrow("That process step code does not exist");

    // The service message beats the partial unique's P2002.
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id,
      lines: [{ partId: f.part.id, prices: [
        { processStepCodeId: f.harden.id, unitPrice: "1.0000" },
        { processStepCodeId: f.harden.id, unitPrice: "2.0000" },
      ] }],
    }))).rejects.toThrow("Line 1 (ACME · P-100): that operation is already priced on this line");
  });

  it("LOT rows refuse breaks — the part-prices rule and message", async () => {
    const f = await serviceFixture();
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id,
      lines: [{ partId: f.part.id, prices: [{
        processStepCodeId: f.harden.id, pricePer: "LOT", unitPrice: "500.0000",
        breaks: [{ threshold: "1000.00", price: "0.1200" }],
      }] }],
    }))).rejects.toThrow("A LOT-priced operation cannot carry price breaks");
  });

  it("mirrors the part-prices decimal scales exactly, field by field", async () => {
    const f = await serviceFixture();
    const withPrice = (price: object) => ({
      customerId: f.customer.id,
      lines: [{ partId: f.part.id, prices: [{ processStepCodeId: f.harden.id, ...price }] }],
    });
    // unitPrice is Decimal(12, 4): five fractional digits must not silently round.
    await expect(asUser(f.quoter, () => createQuote(withPrice({ unitPrice: "0.12345" }))))
      .rejects.toThrow(/4 digits after the decimal point/);
    // setupCharge is Decimal(12, 2).
    await expect(asUser(f.quoter, () => createQuote(withPrice({ setupCharge: "1.005" }))))
      .rejects.toThrow(/2 digits after the decimal point/);
    // A break threshold must be positive.
    await expect(asUser(f.quoter, () => createQuote(withPrice({
      unitPrice: "1.0000", breaks: [{ threshold: 0, price: "0.9500" }],
    })))).rejects.toThrow("Must be greater than zero");
    // Negative money is refused.
    await expect(asUser(f.quoter, () => createQuote(withPrice({ unitPrice: "-1.0000" }))))
      .rejects.toThrow("Must not be negative");
    // eachWeight mirrors Part.eachWeight's Decimal(10, 4).
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id,
      lines: [{ partNumberText: "FT-1", eachWeight: "1.23456", prices: [] }],
    }))).rejects.toThrow(/4 digits after the decimal point/);
  });

  it("refuses a duplicate break threshold within one price row", async () => {
    const f = await serviceFixture();
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id,
      lines: [{ partId: f.part.id, prices: [{
        processStepCodeId: f.harden.id, unitPrice: "1.0000",
        breaks: [{ threshold: "500.00", price: "0.9500" }, { threshold: "500.00", price: "0.9000" }],
      }] }],
    }))).rejects.toThrow("a price break with that threshold already exists");
  });

  it("refuses an inactive customer — the createOrder rule mirrored", async () => {
    const f = await serviceFixture();
    await prisma.customer.update({ where: { id: f.other.id }, data: { active: false } });
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.other.id, lines: [{ partNumberText: "FT-1", prices: [] }],
    }))).rejects.toThrow("That customer is inactive");
  });

  // The deliberate asymmetry with order entry (which refuses inactive parts): the Task 3 rule is
  // "live", not "active" — inactive hides a part from pick lists, it does not invalidate a
  // standing agreement over it. Policy queued for owner ratification; if the owner rules the
  // other way, this test flips to a `.rejects`.
  it("ACCEPTS a line for an inactive (but live) part", async () => {
    const f = await serviceFixture();
    await prisma.part.update({ where: { id: f.part.id }, data: { active: false } });
    const detail = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, lines: [linkedLine(f.part.id, f.harden.id)],
    }));
    expect(detail.lines[0].partNumber).toBe("P-100");
  });

  it("refuses an explicit ending statement that does not exist or was deleted", async () => {
    const f = await serviceFixture();
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, endingStatementId: "nope",
      lines: [linkedLine(f.part.id, f.harden.id)],
    }))).rejects.toThrow("That ending statement does not exist");

    await prisma.endingStatement.update({
      where: { id: f.statement.id }, data: { deletedAt: new Date() } });
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, endingStatementId: f.statement.id,
      lines: [linkedLine(f.part.id, f.harden.id)],
    }))).rejects.toThrow("That ending statement does not exist");
  });

  it("the contact must be one of the customer's live contacts", async () => {
    const f = await serviceFixture();
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, contactId: f.otherContact.id,
      lines: [linkedLine(f.part.id, f.harden.id)],
    }))).rejects.toThrow("That contact does not exist for this customer");

    await prisma.customerContact.update({ where: { id: f.contact.id }, data: { deletedAt: new Date() } });
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, contactId: f.contact.id,
      lines: [linkedLine(f.part.id, f.harden.id)],
    }))).rejects.toThrow("That contact does not exist for this customer");
  });

  it("a line cannot be quoted for a quantity AND unlimited", async () => {
    const f = await serviceFixture();
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id,
      lines: [{ partId: f.part.id, quotedQty: 500, quotedUnlimited: true, prices: [] }],
    }))).rejects.toThrow("Line 1: a line cannot be both quoted for a quantity and unlimited");
  });

  it("rejects unknown keys — the shape is .strict() end to end", async () => {
    const f = await serviceFixture();
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, bogus: 1, lines: [linkedLine(f.part.id, f.harden.id)],
    }))).rejects.toThrow();
    await expect(asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, lines: [{ ...linkedLine(f.part.id, f.harden.id), bogus: 1 }],
    }))).rejects.toThrow();
    expect(await prisma.quote.count()).toBe(0);
  });

  it("the create audit entry carries the real content — names, dates, lines, prices, breaks", async () => {
    const f = await serviceFixture();
    const detail = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, contactId: f.contact.id, rfqNumber: "RFQ-42",
      quoteDate: "2026-08-10",
      lines: [{
        partId: f.part.id, quotedQty: 500,
        prices: [{ processStepCodeId: f.harden.id, setupCharge: "2.00", unitPrice: "0.1500",
          minimumCharge: "100.00", pricePer: "EACH",
          breaks: [{ threshold: "1000.00", price: "0.1200" }] }],
      }],
    }));

    const entries = await prisma.auditLog.findMany({ where: { entity: "quote", entityId: detail.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("create");
    expect(entries[0].actorName).toBe("Quinn Quoter");
    const after = entries[0].after as {
      quoteNumber: number; customerCode: string; contactName: string; status: string;
      quoteDate: string; effectiveDate: string; expiryDate: string; rfqNumber: string;
      quotedByName: string; endingStatementName: string;
      lines: { position: number; partNumber: string; quotedQty: number | null; prices: {
        stepCode: string; setupCharge: number | null; unitPrice: number | null;
        minimumCharge: number | null; pricePer: string;
        breaks: { threshold: number; price: number }[];
      }[] }[];
    };
    expect(after.quoteNumber).toBe(detail.quoteNumber);
    expect(after.customerCode).toBe("ACME");
    expect(after.contactName).toBe("Pat Buyer");
    expect(after.status).toBe("OPEN");
    expect(after.quoteDate).toBe("2026-08-10");
    expect(after.effectiveDate).toBe("2026-08-10");
    expect(after.rfqNumber).toBe("RFQ-42");
    expect(after.quotedByName).toBe("Quinn Quoter");
    expect(after.endingStatementName).toBe("Standard");
    expect(after.lines).toHaveLength(1);
    expect(after.lines[0].partNumber).toBe("P-100"); // a name, never a cuid
    expect(after.lines[0].quotedQty).toBe(500);
    expect(after.lines[0].prices[0]).toMatchObject({
      stepCode: "HT", setupCharge: 2, unitPrice: 0.15, minimumCharge: 100, pricePer: "EACH",
    });
    expect(after.lines[0].prices[0].breaks).toEqual([{ threshold: 1000, price: 0.12 }]);
  });
});

describe("getQuote", () => {
  beforeEach(truncateAll);

  it("linked lines read the part live; free-text lines read their own fields; prices and breaks come back ordered", async () => {
    const f = await serviceFixture();
    const created = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, contactId: f.contact.id,
      lines: [
        {
          partId: f.part.id, quotedQty: 500,
          prices: [
            { processStepCodeId: f.temper.id, unitPrice: "0.0500" },
            { processStepCodeId: f.harden.id, setupCharge: "2.00", unitPrice: "0.1500",
              minimumCharge: "100.00", notes: "per sample",
              breaks: [{ threshold: "5000.00", price: "0.1000" }, { threshold: "1000.00", price: "0.1200" }] },
          ],
        },
        { partNumberText: "FT-1", partNameText: "Widget", partDescriptionText: "Free-text widget",
          materialText: "1045", eachWeight: "1.2500", quotedUnlimited: true, prices: [] },
      ],
    }));

    const detail = await getQuote(created.id);
    expect(detail.customerCode).toBe("ACME");
    expect(detail.contactName).toBe("Pat Buyer");
    expect(detail.quotedByName).toBe("Quinn Quoter");
    expect(detail.endingStatementText).toBe("Thank you for the opportunity to quote.");

    const linked = detail.lines[0];
    expect(linked.position).toBe(1);
    expect(linked.partId).toBe(f.part.id);
    expect(linked.partNumber).toBe("P-100");
    expect(linked.partName).toBe("Pinion");
    expect(linked.partDescription).toBe("A pinion gear");
    expect(linked.material).toBe("4140"); // the part's material reference, live
    expect(linked.eachWeight).toBe(2.5); // the PART's weight, not the line's own column
    expect(linked.quotedQty).toBe(500);
    // Payload order is print order (position), not entry-id order.
    expect(linked.prices.map((p) => p.stepCode)).toEqual(["TMP", "HT"]);
    expect(linked.prices[1]).toMatchObject({
      stepCode: "HT", stepName: "Harden", setupCharge: 2, unitPrice: 0.15, minimumCharge: 100,
      pricePer: "EACH", notes: "per sample",
    });
    expect(linked.prices[1].breaks.map((b) => b.threshold)).toEqual([1000, 5000]); // threshold asc

    const freeText = detail.lines[1];
    expect(freeText.partId).toBeNull();
    expect(freeText.partNumber).toBe("FT-1");
    expect(freeText.partName).toBe("Widget");
    expect(freeText.partDescription).toBe("Free-text widget");
    expect(freeText.material).toBe("1045");
    expect(freeText.eachWeight).toBe(1.25);
    expect(freeText.quotedUnlimited).toBe(true);
  });

  it("reflects a later part rename — the linked line is a live join, never a snapshot", async () => {
    const f = await serviceFixture();
    const created = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, lines: [linkedLine(f.part.id, f.harden.id)],
    }));
    await prisma.part.update({ where: { id: f.part.id }, data: { partNumber: "P-100-REV-B" } });
    const detail = await getQuote(created.id);
    expect(detail.lines[0].partNumber).toBe("P-100-REV-B");
  });

  it("renders a deleted contact blank — deletion is not blocked, the stored PDFs keep the printed name", async () => {
    const f = await serviceFixture();
    const created = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, contactId: f.contact.id,
      lines: [linkedLine(f.part.id, f.harden.id)],
    }));
    await prisma.customerContact.update({ where: { id: f.contact.id }, data: { deletedAt: new Date() } });
    const detail = await getQuote(created.id);
    expect(detail.contactId).toBe(f.contact.id); // the stored FK survives
    expect(detail.contactName).toBe(""); // the render goes blank
  });

  it("derives expired: OPEN past expiry is expired; expiring today is not; CLOSED past expiry is closed, not expired", async () => {
    const f = await serviceFixture();
    const make = (expiryDate: string) => asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, effectiveDate: daysFromToday(-60), expiryDate,
      lines: [linkedLine(f.part.id, f.harden.id)],
    }));
    const past = await make(daysFromToday(-1));
    const todayQuote = await make(daysFromToday(0));
    const closed = await make(daysFromToday(-1));
    await prisma.quote.update({ where: { id: closed.id }, data: { status: "CLOSED" } });

    expect((await getQuote(past.id)).expired).toBe(true);
    expect((await getQuote(todayQuote.id)).expired).toBe(false); // expiryDate < today, strictly
    expect((await getQuote(closed.id)).expired).toBe(false);
  });

  it("summarizes linked orders per line — distinct live orders, voided ones excluded", async () => {
    const f = await serviceFixture();
    const created = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id,
      lines: [linkedLine(f.part.id, f.harden.id), linkedLine(f.part2.id, f.harden.id)],
    }));
    const [lineA, lineB] = created.lines;

    // Fabricated links (Task 5 owns the real auto-link): two live orders on line A — one of them
    // linking through TWO of its own lines, which must still count as ONE order — plus a voided one.
    const mkOrder = async (orderNumber: number, quoteLineIds: string[], voided = false) =>
      prisma.order.create({
        data: {
          orderNumber, customerId: f.customer.id,
          receivedDate: today(), requestDate: today(),
          deletedAt: voided ? new Date() : null,
          lines: { create: quoteLineIds.map((qlId, i) => ({
            position: i + 1, partId: f.part.id, qty: 5, weight: "10.00", quoteLineId: qlId,
          })) },
        },
      });
    await mkOrder(7001, [lineA.id, lineA.id]);
    await mkOrder(7002, [lineA.id]);
    await mkOrder(7003, [lineA.id], true); // voided — not shown

    const detail = await getQuote(created.id);
    const a = detail.lines.find((l) => l.id === lineA.id)!;
    const b = detail.lines.find((l) => l.id === lineB.id)!;
    expect(a.linkedOrderCount).toBe(2);
    expect(a.linkedOrders.map((o) => o.orderNumber)).toEqual([7001, 7002]);
    expect(b.linkedOrderCount).toBe(0);
    expect(b.linkedOrders).toEqual([]);
  });

  it("404s an unknown id", async () => {
    await expect(getQuote("nope")).rejects.toMatchObject({ status: 404 });
  });
});

/** Four quotes spanning the list's search/filter axes:
 *  - open:    ACME, part P-100, RFQ-A, in-date window, follow-up tomorrow
 *  - freeText: BETA, free-text "FT-9", in-date window
 *  - closed:  ACME, part P-200, past expiry but CLOSED (so never "Expired")
 *  - expired: ACME, part P-200, OPEN with expiry yesterday and follow-up yesterday (in BOTH
 *    worklist sections). */
async function seedListQuotes(f: Awaited<ReturnType<typeof serviceFixture>>) {
  const open = await asUser(f.quoter, () => createQuote({
    customerId: f.customer.id, rfqNumber: "RFQ-A",
    quoteDate: daysFromToday(-10), expiryDate: daysFromToday(20), followUpDate: daysFromToday(1),
    lines: [linkedLine(f.part.id, f.harden.id)],
  }));
  const freeText = await asUser(f.quoter, () => createQuote({
    customerId: f.other.id, quoteDate: daysFromToday(-5), expiryDate: daysFromToday(25),
    lines: [{ partNumberText: "FT-9", prices: [] }],
  }));
  const closed = await asUser(f.quoter, () => createQuote({
    customerId: f.customer.id, quoteDate: daysFromToday(-40),
    effectiveDate: daysFromToday(-40), expiryDate: daysFromToday(-10),
    lines: [linkedLine(f.part2.id, f.harden.id)],
  }));
  await prisma.quote.update({ where: { id: closed.id }, data: { status: "CLOSED" } });
  const expired = await asUser(f.quoter, () => createQuote({
    customerId: f.customer.id, quoteDate: daysFromToday(-30),
    effectiveDate: daysFromToday(-30), expiryDate: daysFromToday(-1), followUpDate: daysFromToday(-1),
    lines: [linkedLine(f.part2.id, f.harden.id)],
  }));
  return { open, freeText, closed, expired };
}

describe("listQuotes", () => {
  beforeEach(truncateAll);

  it("orders newest-first by quote number and derives each row's expired state", async () => {
    const f = await serviceFixture();
    const q = await seedListQuotes(f);
    const rows = await listQuotes({});
    expect(rows.map((r) => r.quoteNumber)).toEqual(
      [q.expired, q.closed, q.freeText, q.open].map((x) => x.quoteNumber));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(q.open.id)).toMatchObject({ status: "OPEN", expired: false, customerCode: "ACME" });
    expect(byId.get(q.expired.id)).toMatchObject({ status: "OPEN", expired: true });
    expect(byId.get(q.closed.id)).toMatchObject({ status: "CLOSED", expired: false }); // closed, never "Expired"
    expect(byId.get(q.open.id)?.quotedByName).toBe("Quinn Quoter");
  });

  it("searches by quote number digits, customer code/name, RFQ, and part number including free-text", async () => {
    const f = await serviceFixture();
    const q = await seedListQuotes(f);
    const idsFor = async (search: string) => (await listQuotes({ search })).map((r) => r.id);

    expect(await idsFor(String(q.open.quoteNumber))).toEqual([q.open.id]);
    expect(await idsFor("BETA")).toEqual([q.freeText.id]);
    expect(await idsFor("acme foundry")).toEqual([q.expired.id, q.closed.id, q.open.id]);
    expect(await idsFor("RFQ-A")).toEqual([q.open.id]);
    expect(await idsFor("P-100")).toEqual([q.open.id]); // a LINKED line's live part number
    expect(await idsFor("FT-9")).toEqual([q.freeText.id]); // a free-text line's own text
    expect(await idsFor("no-such-thing")).toEqual([]);
    // A digit string too long for Int4 must not blow up the quoteNumber clause.
    expect(await idsFor("99999999999999999999")).toEqual([]);
  });

  it("filters by status, derived expired, follow-up due, customer, and date ranges", async () => {
    const f = await serviceFixture();
    const q = await seedListQuotes(f);
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

    expect(ids(await listQuotes({ status: "CLOSED" }))).toEqual([q.closed.id]);
    expect(ids(await listQuotes({ status: "OPEN" })))
      .toEqual([q.expired.id, q.freeText.id, q.open.id]);
    expect(ids(await listQuotes({ customerId: f.other.id }))).toEqual([q.freeText.id]);

    expect(ids(await listQuotes({ expired: true }))).toEqual([q.expired.id]);
    expect(ids(await listQuotes({ expired: false })))
      .toEqual([q.closed.id, q.freeText.id, q.open.id]);

    expect(ids(await listQuotes({ followUpDue: true }))).toEqual([q.expired.id]);
    // The FALSE branch is explicit OR arms, never Prisma NOT{}: freeText's followUpDate is NULL,
    // and NOT(followUpDate <= today) is three-valued NULL in SQL — a "simplification" to NOT{}
    // silently drops that row from "not due" and goes red right here. closed (CLOSED) and open
    // (future follow-up) belong too; only the genuinely-due quote is excluded.
    expect(ids(await listQuotes({ followUpDue: false })))
      .toEqual([q.closed.id, q.freeText.id, q.open.id]);

    expect(ids(await listQuotes({ quoteFrom: daysFromToday(-12), quoteTo: daysFromToday(-4) })))
      .toEqual([q.freeText.id, q.open.id]);
    expect(ids(await listQuotes({ effectiveFrom: daysFromToday(-20) })))
      .toEqual([q.freeText.id, q.open.id]);
    expect(ids(await listQuotes({ expiryTo: daysFromToday(0) })))
      .toEqual([q.expired.id, q.closed.id]);
  });

  it("expired: false includes a quote expiring exactly today — the strict < today boundary", async () => {
    const f = await serviceFixture();
    const edge = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, effectiveDate: daysFromToday(-10), expiryDate: daysFromToday(0),
      lines: [linkedLine(f.part.id, f.harden.id)],
    }));
    expect((await listQuotes({ expired: false })).map((r) => r.id)).toContain(edge.id);
    expect((await listQuotes({ expired: true })).map((r) => r.id)).not.toContain(edge.id);
  });

  it("hides soft-deleted quotes and counts only live lines", async () => {
    const f = await serviceFixture();
    const q = await seedListQuotes(f);
    await prisma.quote.update({ where: { id: q.freeText.id }, data: { deletedAt: new Date() } });

    const rows = await listQuotes({});
    expect(rows.map((r) => r.id)).not.toContain(q.freeText.id);

    const twoLines = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id,
      lines: [linkedLine(f.part.id, f.harden.id), { partNumberText: "FT-2", prices: [] }],
    }));
    await prisma.quoteLine.update({
      where: { id: twoLines.lines[1].id }, data: { deletedAt: new Date() } });
    const row = (await listQuotes({})).find((r) => r.id === twoLines.id);
    expect(row?.lineCount).toBe(1);
  });
});

describe("quoteWorklist (spec §5.4)", () => {
  beforeEach(truncateAll);

  const make = (f: Awaited<ReturnType<typeof serviceFixture>>, dates: {
    expiryDate: string; followUpDate?: string | null;
  }) => asUser(f.quoter, () => createQuote({
    customerId: f.customer.id, effectiveDate: daysFromToday(-60), ...dates,
    lines: [linkedLine(f.part.id, f.harden.id)],
  }));

  it("follow-up due is followUpDate ≤ today (inclusive); expired is expiryDate < today (exclusive)", async () => {
    const f = await serviceFixture();
    const dueYesterday = await make(f, { expiryDate: daysFromToday(30), followUpDate: daysFromToday(-1) });
    const dueToday = await make(f, { expiryDate: daysFromToday(30), followUpDate: daysFromToday(0) });
    const dueTomorrow = await make(f, { expiryDate: daysFromToday(30), followUpDate: daysFromToday(1) });
    const noFollowUp = await make(f, { expiryDate: daysFromToday(30) });
    const expiredYesterday = await make(f, { expiryDate: daysFromToday(-1) });
    const expiresToday = await make(f, { expiryDate: daysFromToday(0) });

    const wl = await quoteWorklist();
    const dueIds = wl.followUpDue.rows.map((r) => r.id);
    expect(dueIds).toContain(dueYesterday.id);
    expect(dueIds).toContain(dueToday.id); // ≤ today — today itself is DUE
    expect(dueIds).not.toContain(dueTomorrow.id);
    expect(dueIds).not.toContain(noFollowUp.id);

    const expiredIds = wl.expired.rows.map((r) => r.id);
    expect(expiredIds).toContain(expiredYesterday.id);
    expect(expiredIds).not.toContain(expiresToday.id); // < today — today's expiry is still in-date
    expect(wl.followUpDue.count).toBe(dueIds.length);
    expect(wl.expired.count).toBe(expiredIds.length);
  });

  it("both sections require OPEN and live; one quote may appear in BOTH", async () => {
    const f = await serviceFixture();
    const both = await make(f, { expiryDate: daysFromToday(-1), followUpDate: daysFromToday(-1) });
    const closed = await make(f, { expiryDate: daysFromToday(-1), followUpDate: daysFromToday(-1) });
    await prisma.quote.update({ where: { id: closed.id }, data: { status: "CLOSED" } });
    const deleted = await make(f, { expiryDate: daysFromToday(-1), followUpDate: daysFromToday(-1) });
    await prisma.quote.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

    const wl = await quoteWorklist();
    expect(wl.followUpDue.rows.map((r) => r.id)).toEqual([both.id]);
    expect(wl.expired.rows.map((r) => r.id)).toEqual([both.id]); // the same quote, both sections
    expect(wl.followUpDue.count).toBe(1);
    expect(wl.expired.count).toBe(1);
    expect(wl.expired.rows[0].expired).toBe(true);
  });

  it("orders follow-ups most-overdue first and expiries oldest first", async () => {
    const f = await serviceFixture();
    const newer = await make(f, { expiryDate: daysFromToday(-1), followUpDate: daysFromToday(-1) });
    const older = await make(f, { expiryDate: daysFromToday(-9), followUpDate: daysFromToday(-9) });

    const wl = await quoteWorklist();
    expect(wl.followUpDue.rows.map((r) => r.id)).toEqual([older.id, newer.id]);
    expect(wl.expired.rows.map((r) => r.id)).toEqual([older.id, newer.id]);
  });
});

describe("exportQuotes", () => {
  beforeEach(truncateAll);

  it("exports exactly what listQuotes returns for the same filter, humanized — derived Expired included", async () => {
    const f = await serviceFixture();
    const q = await seedListQuotes(f);

    const buf = await exportQuotes({ customerId: f.customer.id });
    const wb = new ExcelJS.Workbook();
    // See tests/excel.test.ts for why exceljs's own Buffer type needs this cast.
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Quotes")!;

    const header = (sheet.getRow(1).values as (string | undefined)[]).slice(1);
    expect(header).toEqual(["Quote #", "Customer code", "Customer name", "Status", "Quote date",
      "Effective", "Expires", "Follow-up", "RFQ", "Lines", "Quoted by"]);

    // Three ACME quotes, newest-first — the same rows, same order, as the filtered list.
    expect(sheet.rowCount).toBe(4);
    const row = (n: number) => (sheet.getRow(n).values as unknown[]).slice(1);
    expect(row(2)[0]).toBe(q.expired.quoteNumber);
    expect(row(2)[3]).toBe("Expired"); // the derived display state, not the stored status
    expect(row(3)[0]).toBe(q.closed.quoteNumber);
    expect(row(3)[3]).toBe("Closed");
    expect(row(4)[0]).toBe(q.open.quoteNumber);
    expect(row(4)[3]).toBe("Open");
    expect(row(4)[1]).toBe("ACME");
    expect(row(4)[8]).toBe("RFQ-A");
    expect(row(4)[9]).toBe(1); // live line count
    expect(row(4)[10]).toBe("Quinn Quoter");
  });
});

// ============================================================================================
// Phase 6 Task 4 — the MUTATION half: updateQuote / attachPart / closeQuote / reopenQuote /
// deleteQuote + quoteOrderBlockers. Every mutation claims the Quote row (SELECT … FOR UPDATE)
// before reading the state it acts on; the §5.14 refusals name their blocking orders.
// ============================================================================================

/** A created quote plus the ids the update payloads need. Two lines — one part-linked and
 *  priced, one free-text — so every mutation test starts from the same realistic document. */
async function updatableQuote(f: Awaited<ReturnType<typeof serviceFixture>>) {
  const detail = await asUser(f.quoter, () => createQuote({
    customerId: f.customer.id,
    contactId: f.contact.id,
    rfqNumber: "RFQ-U",
    lines: [
      {
        partId: f.part.id, quotedQty: 500,
        prices: [{
          processStepCodeId: f.harden.id, setupCharge: "2.00", unitPrice: "0.1500",
          minimumCharge: "100.00", pricePer: "EACH", notes: "per sample",
          breaks: [{ threshold: "1000.00", price: "0.1200" }],
        }],
      },
      { partNumberText: "FT-1", partNameText: "Widget", materialText: "4140", prices: [] },
    ],
  }));
  return detail;
}

/** Echoes a QuoteDetail back as an update `lines` payload — the round-trip a real client makes:
 *  ids kept, linked lines send blank free-text (the detail reads identity live from the part). */
function linesPayloadFrom(detail: Awaited<ReturnType<typeof getQuote>>) {
  return detail.lines.map((l) => ({
    id: l.id,
    partId: l.partId,
    partNumberText: l.partId ? "" : l.partNumber,
    partNameText: l.partId ? "" : l.partName,
    partDescriptionText: l.partId ? "" : l.partDescription,
    materialText: l.partId ? "" : l.material,
    quotedQty: l.quotedQty,
    quotedUnlimited: l.quotedUnlimited,
    prices: l.prices.map((p) => ({
      id: p.id,
      processStepCodeId: p.processStepCodeId,
      setupCharge: p.setupCharge, unitPrice: p.unitPrice, minimumCharge: p.minimumCharge,
      pricePer: p.pricePer, notes: p.notes,
      breaks: p.breaks.map((b) => ({ id: b.id, threshold: b.threshold, price: b.price })),
    })),
  }));
}

/** Fabricates a live order whose lines link the given quote lines (Task 5 owns the real
 *  auto-link) — the linked-order-summary test's own shape, reused for the §5.14 refusals. */
async function linkOrderTo(
  f: Awaited<ReturnType<typeof serviceFixture>>,
  orderNumber: number, quoteLineIds: string[], opts?: { voided?: boolean },
) {
  return prisma.order.create({
    data: {
      orderNumber, customerId: f.customer.id,
      receivedDate: today(), requestDate: today(),
      deletedAt: opts?.voided ? new Date() : null,
      lines: { create: quoteLineIds.map((qlId, i) => ({
        position: i + 1, partId: f.part.id, qty: 5, weight: "10.00", quoteLineId: qlId,
      })) },
    },
  });
}

const latestAudit = async (entityId: string) =>
  (await prisma.auditLog.findMany({
    where: { entity: "quote", entityId }, orderBy: [{ at: "desc" }, { id: "desc" }], take: 1,
  }))[0];

describe("updateQuote: guards and header fields", () => {
  beforeEach(truncateAll);

  it("404s an unknown or deleted quote; 400s a CLOSED one", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);

    await expect(asUser(f.quoter, () => updateQuote("nope", { notes: "x" })))
      .rejects.toMatchObject({ status: 404 });

    await prisma.quote.update({ where: { id: q.id }, data: { status: "CLOSED" } });
    await expect(asUser(f.quoter, () => updateQuote(q.id, { notes: "x" })))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("closed") });

    await prisma.quote.update({
      where: { id: q.id }, data: { status: "OPEN", deletedAt: new Date() },
    });
    await expect(asUser(f.quoter, () => updateQuote(q.id, { notes: "x" })))
      .rejects.toMatchObject({ status: 404 });
  });

  it("customerId is immutable — a different id 400s, the same id is a no-op key", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);

    await expect(asUser(f.quoter, () => updateQuote(q.id, { customerId: f.other.id })))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("customer") });

    const same = await asUser(f.quoter, () =>
      updateQuote(q.id, { customerId: f.customer.id, notes: "kept" }));
    expect(same.customerId).toBe(f.customer.id);
    expect(same.notes).toBe("kept");
  });

  it("patches header fields; omitted keys stay untouched; explicit nulls clear the nullables", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);

    const edited = await asUser(f.quoter, () => updateQuote(q.id, {
      rfqNumber: "RFQ-2", notes: "prints", internalNotes: "never prints",
      quoteDate: "2026-08-01", effectiveDate: "2026-08-02", expiryDate: "2026-12-31",
      followUpDate: "2026-09-01", quotedById: f.second.id,
    }));
    expect(edited.rfqNumber).toBe("RFQ-2");
    expect(edited.notes).toBe("prints");
    expect(edited.internalNotes).toBe("never prints");
    expect(edited.quoteDate).toBe("2026-08-01");
    expect(edited.effectiveDate).toBe("2026-08-02");
    expect(edited.expiryDate).toBe("2026-12-31");
    expect(edited.followUpDate).toBe("2026-09-01");
    expect(edited.quotedByName).toBe("Sam Second");
    expect(edited.contactName).toBe("Pat Buyer"); // untouched
    expect(edited.lines).toHaveLength(2); // untouched — no lines key, no line writes

    const cleared = await asUser(f.quoter, () => updateQuote(q.id, {
      followUpDate: null, contactId: null, endingStatementId: null,
    }));
    expect(cleared.followUpDate).toBeNull();
    expect(cleared.contactId).toBeNull();
    expect(cleared.endingStatementId).toBeNull();
    expect(cleared.rfqNumber).toBe("RFQ-2"); // still untouched by the second patch
  });

  it("validates the MERGED date window — moving effectiveDate past the stored expiry 400s", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);
    const past = iso(addDays(todayDateOnly(), 40)); // default expiry is +30 days
    await expect(asUser(f.quoter, () => updateQuote(q.id, { effectiveDate: past })))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("effective") });
  });

  it("re-validates contact, quotedBy, and endingStatement like create; absent endingStatement keeps the stored pick, never re-defaults", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);

    await expect(asUser(f.quoter, () => updateQuote(q.id, { contactId: f.otherContact.id })))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("contact") });

    const gone = await prisma.user.create({
      data: { username: "gone", passwordHash: "x", displayName: "Gone", deletedAt: new Date() },
    });
    await expect(asUser(f.quoter, () => updateQuote(q.id, { quotedById: gone.id })))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("quoted-by") });

    await expect(asUser(f.quoter, () => updateQuote(q.id, { endingStatementId: "nope" })))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("ending statement") });

    // Clear the pick, then edit something else with the key ABSENT: the null must survive even
    // though the kind still has a live default — the default is an ENTRY default (spec §5.1).
    await asUser(f.quoter, () => updateQuote(q.id, { endingStatementId: null }));
    const after = await asUser(f.quoter, () => updateQuote(q.id, { notes: "still no statement" }));
    expect(after.endingStatementId).toBeNull();
  });
});

describe("updateQuote: line/price/break array-replace", () => {
  beforeEach(truncateAll);

  it("keeps ids STABLE for kept lines and price rows, re-derives positions from array order, creates and soft-deletes the rest", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);
    const [linked, freeText] = q.lines;

    // Reverse the two lines, edit the price, drop nothing, add a third (new part) line.
    const payload = linesPayloadFrom(q);
    const edited = await asUser(f.quoter, () => updateQuote(q.id, {
      lines: [
        payload[1], // free-text first now
        { ...payload[0], prices: [{ ...payload[0].prices[0], unitPrice: "0.2000" }] },
        { partId: f.part2.id, prices: [] },
      ],
    }));

    expect(edited.lines).toHaveLength(3);
    expect(edited.lines.map((l) => l.position)).toEqual([1, 2, 3]);
    expect(edited.lines[0].id).toBe(freeText.id); // kept, new position, SAME id
    expect(edited.lines[1].id).toBe(linked.id);
    expect(edited.lines[1].prices[0].id).toBe(linked.prices[0].id); // price row id stable too
    expect(edited.lines[1].prices[0].unitPrice).toBe(0.2);
    expect(edited.lines[1].prices[0].breaks[0].id).toBe(linked.prices[0].breaks[0].id);
    expect(edited.lines[2].partNumber).toBe("P-200");

    // Now DROP the free-text line: it soft-deletes (still in the DB, out of every live read).
    const dropped = await asUser(f.quoter, () => updateQuote(q.id, {
      lines: linesPayloadFrom(edited).filter((l) => l.id !== freeText.id),
    }));
    expect(dropped.lines.map((l) => l.id)).toEqual([linked.id, edited.lines[2].id]);
    const row = await prisma.quoteLine.findFirst({ where: { id: freeText.id } });
    expect(row?.deletedAt).not.toBeNull();
  });

  it("refuses unknown, foreign, and duplicate row ids at every level", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);
    const other = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, lines: [{ partNumberText: "OTHER", prices: [] }],
    }));
    const payload = linesPayloadFrom(q);

    // A line id that is not this quote's.
    await expect(asUser(f.quoter, () => updateQuote(q.id, {
      lines: [{ ...payload[1], id: other.lines[0].id }],
    }))).rejects.toMatchObject({ status: 400, message: expect.stringContaining("line") });

    // The same line twice.
    await expect(asUser(f.quoter, () => updateQuote(q.id, {
      lines: [payload[1], { ...payload[1], partNumberText: "FT-2" }],
    }))).rejects.toMatchObject({ status: 400, message: expect.stringContaining("twice") });

    // A price-row id from a different line.
    await expect(asUser(f.quoter, () => updateQuote(q.id, {
      lines: [
        payload[0],
        { ...payload[1], prices: [{ ...payload[0].prices[0] }] },
      ],
    }))).rejects.toMatchObject({ status: 400, message: expect.stringContaining("price row") });

    // A break id that does not belong to the row.
    await expect(asUser(f.quoter, () => updateQuote(q.id, {
      lines: [
        {
          ...payload[0],
          prices: [{
            ...payload[0].prices[0],
            breaks: [{ id: "nope", threshold: "5.00", price: "0.1000" }],
          }],
        },
        payload[1],
      ],
    }))).rejects.toMatchObject({ status: 400, message: expect.stringContaining("break") });
  });

  it("re-validates everything create validates — XOR, part ownership, payload part dup, step dup, LOT-with-breaks", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);
    const payload = linesPayloadFrom(q);

    await expect(asUser(f.quoter, () => updateQuote(q.id, {
      lines: [{ prices: [] }],
    }))).rejects.toMatchObject({ status: 400, message: expect.stringContaining("part") });

    await expect(asUser(f.quoter, () => updateQuote(q.id, {
      lines: [{ partId: f.otherPart.id, prices: [] }],
    }))).rejects.toMatchObject({ status: 400, message: expect.stringContaining("another customer") });

    await expect(asUser(f.quoter, () => updateQuote(q.id, {
      lines: [payload[0], { partId: f.part.id, prices: [] }],
    }))).rejects.toMatchObject({ status: 400, message: expect.stringContaining("already quoted") });

    await expect(asUser(f.quoter, () => updateQuote(q.id, {
      lines: [{
        ...payload[0],
        prices: [payload[0].prices[0], { processStepCodeId: f.harden.id, unitPrice: "0.9000" }],
      }, payload[1]],
    }))).rejects.toMatchObject({ status: 400, message: expect.stringContaining("already priced") });

    await expect(asUser(f.quoter, () => updateQuote(q.id, {
      lines: [{
        ...payload[0],
        prices: [{
          ...payload[0].prices[0], pricePer: "LOT",
        }],
      }, payload[1]],
    }))).rejects.toMatchObject({
      status: 400, message: expect.stringContaining("LOT-priced operation cannot carry price breaks"),
    });
  });

  it("a kept row's step-code change re-mints the row (stamp + recreate — the partial unique's swap hazard); a swap of two rows' codes lands cleanly", async () => {
    const f = await serviceFixture();
    const q = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id,
      lines: [{
        partId: f.part.id,
        prices: [
          { processStepCodeId: f.harden.id, unitPrice: "0.1000" },
          { processStepCodeId: f.temper.id, unitPrice: "0.2000" },
        ],
      }],
    }));
    const [ht, tmp] = q.lines[0].prices;
    const payload = linesPayloadFrom(q);

    // Swap the two rows' step codes in place — with naive in-place updates the first write
    // collides with the second row's still-live (quoteLineId, processStepCodeId) partial unique.
    const swapped = await asUser(f.quoter, () => updateQuote(q.id, {
      lines: [{
        ...payload[0],
        prices: [
          { ...payload[0].prices[0], processStepCodeId: f.temper.id },
          { ...payload[0].prices[1], processStepCodeId: f.harden.id },
        ],
      }],
    }));
    const prices = swapped.lines[0].prices;
    expect(prices.map((p) => p.stepCode)).toEqual(["TMP", "HT"]);
    expect(prices.map((p) => p.unitPrice)).toEqual([0.1, 0.2]); // values followed the rows
    expect(prices[0].id).not.toBe(ht.id); // re-minted — a re-keyed row is a different agreement row
    expect(prices[1].id).not.toBe(tmp.id);
    const old = await prisma.quotePrice.findFirst({ where: { id: ht.id } });
    expect(old?.deletedAt).not.toBeNull();
  });

  it("breaks: price edits in place (id stable), threshold changes re-mint, removals soft-delete", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);
    const payload = linesPayloadFrom(q);
    const brk = q.lines[0].prices[0].breaks[0];

    const priceEdited = await asUser(f.quoter, () => updateQuote(q.id, {
      lines: [{
        ...payload[0],
        prices: [{
          ...payload[0].prices[0],
          breaks: [
            { id: brk.id, threshold: brk.threshold, price: "0.1100" },
            { threshold: "5000.00", price: "0.1000" },
          ],
        }],
      }, payload[1]],
    }));
    const edited = priceEdited.lines[0].prices[0].breaks;
    expect(edited).toHaveLength(2);
    expect(edited[0].id).toBe(brk.id); // price-only edit: id stable
    expect(edited[0].price).toBe(0.11);
    expect(edited[1].threshold).toBe(5000);

    const rethresholded = await asUser(f.quoter, () => updateQuote(q.id, {
      lines: [{
        ...payload[0],
        prices: [{
          ...payload[0].prices[0],
          breaks: [{ id: brk.id, threshold: "2000.00", price: "0.1100" }],
        }],
      }, payload[1]],
    }));
    const only = rethresholded.lines[0].prices[0].breaks;
    expect(only).toHaveLength(1);
    expect(only[0].threshold).toBe(2000);
    expect(only[0].id).not.toBe(brk.id); // threshold change re-mints (partial-unique swap hazard)
    const goneRow = await prisma.quotePriceBreak.findFirst({ where: { id: brk.id } });
    expect(goneRow?.deletedAt).not.toBeNull();
  });
});

describe("updateQuote: §5.14 linked-line guards (ruling 8)", () => {
  beforeEach(truncateAll);

  it("refuses to drop a linked line, naming every blocking order number", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);
    const linked = q.lines[0];
    await linkOrderTo(f, 7001, [linked.id]);
    await linkOrderTo(f, 7002, [linked.id]);

    const withoutLinked = linesPayloadFrom(q).filter((l) => l.id !== linked.id);
    await expect(asUser(f.quoter, () => updateQuote(q.id, { lines: withoutLinked })))
      .rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(/#7001.*#7002/),
      });
  });

  it("refuses to re-point (or detach) a linked line's part, naming the orders; a voided order never blocks", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);
    const linked = q.lines[0];
    await linkOrderTo(f, 7003, [linked.id]);
    const payload = linesPayloadFrom(q);

    await expect(asUser(f.quoter, () => updateQuote(q.id, {
      lines: [{ ...payload[0], partId: f.part2.id }, payload[1]],
    }))).rejects.toMatchObject({ status: 400, message: expect.stringContaining("#7003") });

    await expect(asUser(f.quoter, () => updateQuote(q.id, {
      lines: [{ ...payload[0], partId: null, partNumberText: "NOW-TEXT" }, payload[1]],
    }))).rejects.toMatchObject({ status: 400, message: expect.stringContaining("#7003") });

    // Void the order: the same edits sail through — voided blocks nothing (house rule).
    await prisma.order.updateMany({ where: { orderNumber: 7003 }, data: { deletedAt: new Date() } });
    const ok = await asUser(f.quoter, () => updateQuote(q.id, {
      lines: [{ ...payload[0], partId: f.part2.id }, payload[1]],
    }));
    expect(ok.lines[0].partNumber).toBe("P-200");
  });

  it("free-text and price-row edits on a linked line stay allowed — including emptying its price rows", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);
    const linked = q.lines[0];
    await linkOrderTo(f, 7004, [linked.id]);
    const payload = linesPayloadFrom(q);

    const edited = await asUser(f.quoter, () => updateQuote(q.id, {
      lines: [{
        ...payload[0],
        quotedQty: 900,
        prices: [{ ...payload[0].prices[0], unitPrice: "0.2500", notes: "renegotiated" }],
      }, payload[1]],
    }));
    expect(edited.lines[0].id).toBe(linked.id); // the id OrderLine.quoteLineId points at survives
    expect(edited.lines[0].quotedQty).toBe(900);
    expect(edited.lines[0].prices[0].unitPrice).toBe(0.25);

    // Emptying the linked line's rows is legal too (an empty agreement = needs-price, ruling 4).
    const emptied = await asUser(f.quoter, () => updateQuote(q.id, {
      lines: [{ ...payload[0], quotedQty: 900, prices: [] }, payload[1]],
    }));
    expect(emptied.lines[0].id).toBe(linked.id);
    expect(emptied.lines[0].prices).toEqual([]);
    const link = await prisma.orderLine.findFirst({ where: { quoteLineId: linked.id } });
    expect(link).not.toBeNull();
  });
});

describe("updateQuote: audit content — SNAPSHOT_INCLUDE.quote's first exercise", () => {
  beforeEach(truncateAll);

  it("a price edit shows in the before/after diff, with the step code named, not a cuid", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);
    const payload = linesPayloadFrom(q);

    await asUser(f.quoter, () => updateQuote(q.id, {
      lines: [{
        ...payload[0],
        prices: [{ ...payload[0].prices[0], unitPrice: "0.2000" }],
      }, payload[1]],
    }));

    const entry = await latestAudit(q.id);
    expect(entry.action).toBe("update");
    type Snap = { lines: { prices: {
      unitPrice: string; processStepCode: { code: string; name: string };
      breaks: { threshold: string }[];
    }[] }[] };
    const before = entry.before as unknown as Snap;
    const after = entry.after as unknown as Snap;
    expect(before.lines[0].prices[0].unitPrice).toBe("0.15");
    expect(after.lines[0].prices[0].unitPrice).toBe("0.2");
    expect(after.lines[0].prices[0].processStepCode.code).toBe("HT"); // the relation tree rode in
    expect(after.lines[0].prices[0].breaks[0].threshold).toBe("1000"); // breaks nested under rows
  });

  it("a break add shows in the diff; a dropped line is EXCLUDED from the after snapshot (live rows only)", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);
    const payload = linesPayloadFrom(q);

    await asUser(f.quoter, () => updateQuote(q.id, {
      lines: [{
        ...payload[0],
        prices: [{
          ...payload[0].prices[0],
          breaks: [...payload[0].prices[0].breaks, { threshold: "5000.00", price: "0.1000" }],
        }],
      }], // the free-text line is DROPPED in the same edit
    }));

    const entry = await latestAudit(q.id);
    type Snap = { lines: { partNumberText: string; prices: { breaks: unknown[] }[] }[] };
    const before = entry.before as unknown as Snap;
    const after = entry.after as unknown as Snap;
    expect(before.lines).toHaveLength(2);
    expect(before.lines[1].partNumberText).toBe("FT-1");
    expect(after.lines).toHaveLength(1); // the soft-deleted child is gone from the snapshot
    expect(before.lines[0].prices[0].breaks).toHaveLength(1);
    expect(after.lines[0].prices[0].breaks).toHaveLength(2); // the break add shows
  });
});

describe("attachPart", () => {
  beforeEach(truncateAll);

  it("sets partId on a live free-text line, keeps the text columns as dormant history, and audits", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);
    const freeText = q.lines[1];

    const detail = await asUser(f.quoter, () =>
      attachPart(q.id, { lineId: freeText.id, partId: f.part2.id }));
    const line = detail.lines[1];
    expect(line.id).toBe(freeText.id);
    expect(line.partId).toBe(f.part2.id);
    expect(line.partNumber).toBe("P-200"); // reads live from the part now

    const row = await prisma.quoteLine.findFirst({ where: { id: freeText.id } });
    expect(row?.partNumberText).toBe("FT-1"); // dormant, untouched (spec §4.1)
    expect(row?.materialText).toBe("4140");

    const entry = await latestAudit(q.id);
    expect(entry.action).toBe("update");
    type Snap = { lines: { partId: string | null }[] };
    expect((entry.before as unknown as Snap).lines[1].partId).toBeNull();
    expect((entry.after as unknown as Snap).lines[1].partId).toBe(f.part2.id);
  });

  it("refuses: a line that already carries a part, a foreign part, a duplicate part, a closed quote, a missing line", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);
    const [linked, freeText] = q.lines;

    await expect(asUser(f.quoter, () => attachPart(q.id, { lineId: linked.id, partId: f.part2.id })))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("already carries") });

    await expect(asUser(f.quoter, () => attachPart(q.id, { lineId: freeText.id, partId: f.otherPart.id })))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("another customer") });

    await expect(asUser(f.quoter, () => attachPart(q.id, { lineId: freeText.id, partId: f.part.id })))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("already quoted") });

    await expect(asUser(f.quoter, () => attachPart(q.id, { lineId: "nope", partId: f.part2.id })))
      .rejects.toMatchObject({ status: 404 });

    // A line of some OTHER quote is "not found" on this one.
    const other = await asUser(f.quoter, () => createQuote({
      customerId: f.customer.id, lines: [{ partNumberText: "ELSEWHERE", prices: [] }],
    }));
    await expect(asUser(f.quoter, () => attachPart(q.id, { lineId: other.lines[0].id, partId: f.part2.id })))
      .rejects.toMatchObject({ status: 404 });

    await prisma.quote.update({ where: { id: q.id }, data: { status: "CLOSED" } });
    await expect(asUser(f.quoter, () => attachPart(q.id, { lineId: freeText.id, partId: f.part2.id })))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("closed") });
  });
});

describe("closeQuote / reopenQuote", () => {
  beforeEach(truncateAll);

  it("close needs a non-blank reason, stamps status/closedAt/closedBy/closeReason, audits with the reason; a second close 400s", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);

    await expect(asUser(f.quoter, () => closeQuote(q.id, "   ")))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("reason") });

    const { quote } = await asUser(f.quoter, () => closeQuote(q.id, "  won elsewhere  "));
    expect(quote.status).toBe("CLOSED");
    expect(quote.closeReason).toBe("won elsewhere"); // trimmed IN THE SERVICE (§5.17)
    expect(quote.closedAt).not.toBeNull();
    expect(quote.closedByName).toBe("Quinn Quoter");
    expect(quote.expired).toBe(false); // CLOSED never renders as Expired

    const entry = await latestAudit(q.id);
    expect(entry.action).toBe("update");
    expect(entry.reason).toBe("won elsewhere");

    await expect(asUser(f.quoter, () => closeQuote(q.id, "again")))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("already closed") });
    await expect(asUser(f.quoter, () => closeQuote("nope", "x")))
      .rejects.toMatchObject({ status: 404 });
  });

  it("close WARNS-AND-LISTS the open, not-yet-fully-invoiced linked orders — deduped, sorted, voided and invoiced ones excluded — and never blocks", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);
    const linked = q.lines[0];

    // Four linked orders: one open (linking twice — must list ONCE), one voided, one carrying a
    // live FINALIZED invoice, and a second open one to prove the ascending sort.
    await linkOrderTo(f, 7020, [linked.id, linked.id]);
    await linkOrderTo(f, 7018, [linked.id]);
    const voided = await linkOrderTo(f, 7021, [linked.id], { voided: true });
    const invoiced = await linkOrderTo(f, 7019, [linked.id]);
    await prisma.invoice.create({
      data: {
        orderId: invoiced.id, customerId: f.customer.id,
        kind: "INVOICE", status: "FINALIZED", invoiceDate: today(), finalizedAt: new Date(),
      },
    });

    const { quote, linkedOpenOrders } = await asUser(f.quoter, () => closeQuote(q.id, "expiring"));
    expect(quote.status).toBe("CLOSED"); // warn, NEVER block (ruling 6)
    expect(linkedOpenOrders.map((o) => o.orderNumber)).toEqual([7018, 7020]);
    expect(linkedOpenOrders.map((o) => o.id)).not.toContain(voided.id);
    expect(linkedOpenOrders.map((o) => o.id)).not.toContain(invoiced.id);
  });

  it("reopen needs a reason, returns the quote to OPEN, CLEARS the close fields, and audits with the reason", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);

    await expect(asUser(f.quoter, () => reopenQuote(q.id, "not closed yet")))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("not closed") });

    await asUser(f.quoter, () => closeQuote(q.id, "mistake"));
    await expect(asUser(f.quoter, () => reopenQuote(q.id, " ")))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("reason") });

    const reopened = await asUser(f.second, () => reopenQuote(q.id, "customer came back"));
    expect(reopened.status).toBe("OPEN");
    expect(reopened.closedAt).toBeNull();
    expect(reopened.closedByName).toBe("");
    expect(reopened.closeReason).toBe("");

    const entry = await latestAudit(q.id);
    expect(entry.reason).toBe("customer came back");
    // The close's own story is not lost: the reopen entry's BEFORE snapshot carries it.
    expect((entry.before as { closeReason: string }).closeReason).toBe("mistake");

    // And the quote is editable again.
    const edited = await asUser(f.quoter, () => updateQuote(q.id, { notes: "back in play" }));
    expect(edited.notes).toBe("back in play");
  });
});

describe("deleteQuote + quoteOrderBlockers", () => {
  beforeEach(truncateAll);

  it("requires a reason; a clean delete stamps the quote AND its live lines (price rows left behind the dead line), audited", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);

    await expect(asUser(f.quoter, () => deleteQuote(q.id, "  ")))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("reason") });

    await asUser(f.quoter, () => deleteQuote(q.id, "typo — rekeyed as 1001"));

    const quote = await prisma.quote.findFirst({ where: { id: q.id } });
    expect(quote?.deletedAt).not.toBeNull();
    const lines = await prisma.quoteLine.findMany({ where: { quoteId: q.id } });
    expect(lines.every((l) => l.deletedAt !== null)).toBe(true);
    // Grandchildren stay unstamped — unreachable behind the dead line (the deletePartPrice rule).
    const price = await prisma.quotePrice.findFirst({ where: { quoteLineId: q.lines[0].id } });
    expect(price?.deletedAt).toBeNull();

    const entry = await latestAudit(q.id);
    expect(entry.action).toBe("delete");
    expect(entry.reason).toBe("typo — rekeyed as 1001");
    // The before snapshot preserved the LIVE tree the delete took away.
    expect((entry.before as { lines: unknown[] }).lines).toHaveLength(2);

    // Shown-never-hidden on the detail; gone from the list.
    expect((await getQuote(q.id)).deletedAt).not.toBeNull();
    expect(await listQuotes({})).toEqual([]);

    await expect(asUser(f.quoter, () => deleteQuote(q.id, "again")))
      .rejects.toMatchObject({ status: 404 });
  });

  it("is refused-and-named while ANY live order line references any of its lines; voided orders never block; CLOSED deletes fine", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);
    const linked = q.lines[0];
    await linkOrderTo(f, 7031, [linked.id]);
    await linkOrderTo(f, 7030, [linked.id]);

    await expect(asUser(f.quoter, () => deleteQuote(q.id, "try")))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/#7030.*#7031/) });

    await prisma.order.updateMany({
      where: { orderNumber: { in: [7030, 7031] } }, data: { deletedAt: new Date() },
    });
    await asUser(f.quoter, () => closeQuote(q.id, "closing before delete"));
    await asUser(f.quoter, () => deleteQuote(q.id, "voided orders never block"));
    expect((await getQuote(q.id)).deletedAt).not.toBeNull();
  });

  it("quoteOrderBlockers lists each blocking order once — named, linked, ascending", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);
    const [linked, freeText] = q.lines;
    const b = await linkOrderTo(f, 7041, [linked.id]);
    const a = await linkOrderTo(f, 7040, [linked.id, freeText.id]); // two links, ONE row
    await linkOrderTo(f, 7042, [linked.id], { voided: true });

    expect(await quoteOrderBlockers(q.id)).toEqual([
      { entityLabel: "Order", name: "#7040 · ACME", id: a.id, href: `/orders/${a.id}` },
      { entityLabel: "Order", name: "#7041 · ACME", id: b.id, href: `/orders/${b.id}` },
    ]);
  });
});

// The close-vs-update race (the certs.test.ts scripted-holder technique): the CLOSER is a
// hand-scripted DEFAULT-isolation (Read Committed) transaction running closeQuote's own
// claim-then-write sequence, so SSI is off the table for it — the ONLY thing that can stop a
// header-only updateQuote (itself Read Committed: no lines, no FK assignment) from writing
// through the close is updateQuote's own FOR UPDATE claim on the Quote row. RED-verified with
// the claim removed (a bare findFirst): the update read OPEN from its pre-close snapshot,
// blocked on the row lock at its WRITE instead, and after the close committed the edit landed
// on the CLOSED quote — the exact stale-read shape the claim exists to prevent.
describe("close-vs-update race: the row claim is the guard", () => {
  beforeEach(truncateAll);

  it("an update racing a Read-Committed close blocks on the claim, then refuses on the fresh read — nothing lands on the closed quote", async () => {
    const f = await serviceFixture();
    const q = await updatableQuote(f);

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    // The closer: claim, signal, hold, then commit the close — Read Committed throughout.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Quote" WHERE "id" = ${q.id} FOR UPDATE`;
      hasClaimed();
      await release;
      await tx.quote.update({
        where: { id: q.id },
        data: { status: "CLOSED", closedAt: new Date(), closeReason: "raced" },
      });
    }, { timeout: 20000 });

    await claimed;
    const updateCall = asUser(f.quoter, () => updateQuote(q.id, { notes: "sneaky edit" }));

    // Not the discriminator — just proof the update is genuinely BLOCKED on the holder's claim
    // before the close is released (the certs.test.ts probe shape).
    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      updateCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);

    mayRelease();
    await holder;

    // The discriminator: the post-claim re-read sees CLOSED and refuses; the notes never land.
    await expect(updateCall).rejects.toMatchObject({
      status: 400, message: expect.stringContaining("closed"),
    });
    const after = await prisma.quote.findFirst({ where: { id: q.id } });
    expect(after?.status).toBe("CLOSED");
    expect(after?.notes).toBe("");
  });
});
