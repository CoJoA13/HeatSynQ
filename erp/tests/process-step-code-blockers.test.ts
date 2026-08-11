import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { findBlockers } from "@/server/reference-blockers";
import { assertRefExists } from "@/server/reference-guards";
import { deleteStepCode } from "@/server/process-step-codes";
import { HttpError } from "@/server/errors";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 } });
  const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
  return { customer, part, code };
}
const step = (revisionId: string, codeId: string, position = 1) =>
  prisma.partProcessStep.create({ data: { revisionId, codeId, position, instruction: "" } });

/** A raw-prisma quote whose line(s) price through `codeId` — the QUOTE_VIA_PRICE chain
 *  (price row → line → quote), built raw so the registry entry is proven against arbitrary
 *  states, including ones the quote service itself would refuse to produce. */
async function quotePricing(customerId: string, codeId: string, quoteNumber: number,
                            opts: { lines?: number; quoteDead?: boolean } = {}) {
  const user = await prisma.user.findFirst({ where: { username: "quoter-psc" } })
    ?? await prisma.user.create({
      data: { username: "quoter-psc", passwordHash: "x", displayName: "Quoter" } });
  return prisma.quote.create({
    data: {
      quoteNumber, customerId, quotedById: user.id,
      quoteDate: new Date("2026-08-01"), effectiveDate: new Date("2026-08-01"),
      expiryDate: new Date("2026-08-31"),
      ...(opts.quoteDead ? { deletedAt: new Date() } : {}),
      lines: { create: Array.from({ length: opts.lines ?? 1 }, (_, i) => ({
        position: i + 1, partNumberText: `FT-${quoteNumber}-${i + 1}`,
        prices: { create: [{ position: 1, processStepCodeId: codeId, unitPrice: "1.2500" }] },
      })) },
    },
    include: { lines: { include: { prices: true } } },
  });
}

describe("findBlockers targeting processStepCode", () => {
  beforeEach(truncateAll);

  it("lists a part once even when two revisions use the code, and a template by name", async () => {
    const { part, code } = await fixture();
    const r1 = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1, lockedAt: new Date() } });
    const r2 = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 2 } });
    await step(r1.id, code.id); await step(r2.id, code.id);
    const tpl = await prisma.processTemplate.create({ data: { name: "Austemper" } });
    await prisma.processTemplateStep.create({ data: { templateId: tpl.id, position: 1, codeId: code.id } });

    const blockers = await findBlockers("processStepCode", code.id);
    expect(blockers).toHaveLength(2);
    const labels = blockers.map((b) => `${b.entityLabel}:${b.name}`).sort();
    expect(labels).toEqual(["Part:AC · P-1", "Template:Austemper"]);
    expect(blockers.find((b) => b.entityLabel === "Part")?.href).toBe(`/parts/${part.id}`);
    expect(blockers.find((b) => b.entityLabel === "Template")?.href).toBe(`/processes/templates/${tpl.id}`);
  });

  it("liveWhere: steps under a soft-deleted part or template do not block", async () => {
    const { part, code } = await fixture();
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await step(rev.id, code.id);
    const tpl = await prisma.processTemplate.create({ data: { name: "Austemper" } });
    await prisma.processTemplateStep.create({ data: { templateId: tpl.id, position: 1, codeId: code.id } });
    await prisma.part.update({ where: { id: part.id }, data: { deletedAt: new Date() } });
    await prisma.processTemplate.update({ where: { id: tpl.id }, data: { deletedAt: new Date() } });
    expect(await findBlockers("processStepCode", code.id)).toHaveLength(0);
  });

  // Task 7 (Phase 6): behavioral verification of the QUOTE_VIA_PRICE registry entry Task 1
  // registered (src/lib/reference-links.ts) — the generic findBlockers walk is what gives
  // `QuotePrice.processStepCodeId` its delete protection, with no step-code-side code at all.
  it("a step code priced on a live quote blocks, named the Quote way and deduped per quote; "
    + "deleteStepCode refuses", async () => {
    const { customer, code } = await fixture();
    // TWO lines, each pricing through the same code — the blocker presented is the QUOTE, once.
    const quote = await quotePricing(customer.id, code.id, 1000, { lines: 2 });

    const blockers = await findBlockers("processStepCode", code.id);
    expect(blockers).toEqual([
      { entityLabel: "Quote", name: "Quote · #1000", id: quote.id, href: `/quotes/${quote.id}` },
    ]);
    await expect(asSystem(() => deleteStepCode(code.id)))
      .rejects.toThrow("still in use by 1 record(s)");
    expect((await prisma.processStepCode.findFirst({ where: { id: code.id } }))!.deletedAt).toBeNull();
  });

  // The from-the-grave case (Task 1's whole-chain liveWhere): a price row only blocks while the
  // ENTIRE chain is live — the row itself, its line, and its quote. Each level is pinned
  // separately: a deleted quote whose price rows were left untouched (deleteQuote stamps lines,
  // not price rows — grandchildren stay behind their dead line) must not block from the grave.
  it("a dead price row, a dead line, or a dead quote does not block — deleteStepCode then succeeds", async () => {
    const { customer, code } = await fixture();
    const rowDead = await quotePricing(customer.id, code.id, 1001);
    await prisma.quotePrice.updateMany({
      where: { quoteLine: { quoteId: rowDead.id } }, data: { deletedAt: new Date() } });
    const lineDead = await quotePricing(customer.id, code.id, 1002);
    await prisma.quoteLine.updateMany({ where: { quoteId: lineDead.id }, data: { deletedAt: new Date() } });
    const quoteDead = await quotePricing(customer.id, code.id, 1003, { quoteDead: true });
    // quoteDead's line and price row are deliberately left live-looking — the chain walk alone
    // must exclude them.
    expect((await prisma.quotePrice.findFirst({
      where: { quoteLine: { quoteId: quoteDead.id } } }))!.deletedAt).toBeNull();

    expect(await findBlockers("processStepCode", code.id)).toEqual([]);
    await asSystem(() => deleteStepCode(code.id));
    expect((await prisma.processStepCode.findFirst({ where: { id: code.id } }))!.deletedAt).not.toBeNull();
  });

  it("assertRefExists accepts a live (even inactive) code and 400s a soft-deleted one", async () => {
    const { code } = await fixture();
    await prisma.processStepCode.update({ where: { id: code.id }, data: { active: false } });
    await prisma.$transaction(async (tx) => { await assertRefExists("processStepCode", code.id, tx); });
    await prisma.processStepCode.update({ where: { id: code.id }, data: { deletedAt: new Date() } });
    await expect(
      prisma.$transaction(async (tx) => { await assertRefExists("processStepCode", code.id, tx); }),
    ).rejects.toThrow(HttpError);
  });
});
