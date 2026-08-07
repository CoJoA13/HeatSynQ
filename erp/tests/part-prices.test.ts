import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createPart } from "@/server/parts";
import {
  listPartPrices, addPartPrice, updatePartPrice, deletePartPrice,
  addPriceBreak, updatePriceBreak, deletePriceBreak, reorderPartPrices,
} from "@/server/part-prices";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Foundry" } });
  const other = await prisma.customer.create({ data: { code: "BETA", name: "Beta Co" } });
  const { id: partId } = await asSystem(() =>
    createPart({ customerId: customer.id, partNumber: "12345", eachWeight: 1 }));
  const { id: otherPartId } = await asSystem(() =>
    createPart({ customerId: other.id, partNumber: "99999", eachWeight: 1 }));
  const austemper = await prisma.processStepCode.create({ data: { code: "AUST", name: "Austemper" } });
  const straighten = await prisma.processStepCode.create({ data: { code: "STRT", name: "Straighten" } });
  return { customer, other, partId, otherPartId, austemper, straighten };
}

describe("part prices", () => {
  beforeEach(truncateAll);

  it("adds two priced operations and lists them in position order", async () => {
    const { partId, austemper, straighten } = await fixture();
    await asSystem(() => addPartPrice(partId, {
      processStepCodeId: straighten.id, position: 2, unitPrice: "1.0000", pricePer: "EACH" }));
    await asSystem(() => addPartPrice(partId, {
      processStepCodeId: austemper.id, position: 1, unitPrice: "6.5100",
      minimumCharge: "600.00", pricePer: "EACH" }));
    const rows = await listPartPrices(partId);
    expect(rows.map((r) => r.stepCode)).toEqual(["AUST", "STRT"]);
    expect(rows[0].unitPrice).toBe(6.51);
    expect(rows[0].minimumCharge).toBe(600);
  });

  it("refuses a second live price row for the same operation", async () => {
    const { partId, austemper } = await fixture();
    await asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 }));
    await expect(asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 2 })))
      .rejects.toThrow("That operation is already priced on this part");
  });

  it("re-prices an operation after its row is deleted (partial unique)", async () => {
    const { partId, austemper } = await fixture();
    const { id: first } = await asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 }));
    await asSystem(() => deletePartPrice(partId, first));
    const { id: second } = await asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 }));
    expect(second).not.toBe(first);
  });

  it("refuses a break on a LOT-priced row, and refuses LOT while breaks exist", async () => {
    const { partId, austemper, straighten } = await fixture();
    const { id: lotId } = await asSystem(() => addPartPrice(partId, {
      processStepCodeId: austemper.id, position: 1, pricePer: "LOT", unitPrice: "500.0000" }));
    await expect(asSystem(() => addPriceBreak(partId, lotId, { threshold: 500, price: "0.95" })))
      .rejects.toThrow("A LOT-priced operation cannot carry price breaks");

    const { id: eachId } = await asSystem(() => addPartPrice(partId, {
      processStepCodeId: straighten.id, position: 2, pricePer: "EACH", unitPrice: "1.0000" }));
    await asSystem(() => addPriceBreak(partId, eachId, { threshold: 500, price: "0.95" }));
    await expect(asSystem(() => updatePartPrice(partId, eachId, { pricePer: "LOT" })))
      .rejects.toThrow("A LOT-priced operation cannot carry price breaks");
  });

  it("refuses a soft-deleted step code", async () => {
    const { partId, austemper } = await fixture();
    await prisma.processStepCode.update({ where: { id: austemper.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 })))
      .rejects.toThrow("That process step code does not exist");
  });

  it("scopes every mutator to its part and its price row", async () => {
    const { partId, otherPartId, austemper } = await fixture();
    const { id } = await asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 }));
    await expect(asSystem(() => updatePartPrice(otherPartId, id, { position: 2 })))
      .rejects.toThrow("Price row not found");
    await expect(asSystem(() => deletePartPrice(otherPartId, id)))
      .rejects.toThrow("Price row not found");
  });

  it("audits a price row create/update/delete with a real diff", async () => {
    const { partId, austemper } = await fixture();
    const { id } = await asSystem(() => addPartPrice(partId, {
      processStepCodeId: austemper.id, position: 1, unitPrice: "6.5100" }));
    await asSystem(() => updatePartPrice(partId, id, { unitPrice: "7.0000" }));
    await asSystem(() => deletePartPrice(partId, id));
    const entries = await prisma.auditLog.findMany({
      where: { entity: "partPrice", entityId: id }, orderBy: [{ at: "asc" }, { id: "asc" }] });
    expect(entries.map((e) => e.action)).toEqual(["create", "update", "delete"]);
    const before = entries[1].before as { unitPrice: string };
    const after = entries[1].after as { unitPrice: string };
    expect(Number(before.unitPrice)).toBe(6.51);
    expect(Number(after.unitPrice)).toBe(7);
  });

  it("adds, updates, and deletes a price break, scoped to its price row", async () => {
    const { partId, otherPartId, austemper, straighten } = await fixture();
    const { id: priceId } = await asSystem(() =>
      addPartPrice(partId, { processStepCodeId: austemper.id, position: 1, pricePer: "EACH" }));
    const { id: otherPriceId } = await asSystem(() =>
      addPartPrice(otherPartId, { processStepCodeId: straighten.id, position: 1, pricePer: "EACH" }));

    const { id: breakId } = await asSystem(() =>
      addPriceBreak(partId, priceId, { threshold: 500, price: "0.95" }));
    let rows = await listPartPrices(partId);
    expect(rows[0].breaks).toEqual([{ id: breakId, threshold: 500, price: 0.95 }]);

    // Wrong price row (belongs to another part) must 404, not resolve.
    await expect(asSystem(() => updatePriceBreak(partId, otherPriceId, breakId, { price: "1.00" })))
      .rejects.toThrow("Price row not found");
    await expect(asSystem(() => deletePriceBreak(partId, otherPriceId, breakId)))
      .rejects.toThrow("Price row not found");

    await asSystem(() => updatePriceBreak(partId, priceId, breakId, { price: "1.00" }));
    rows = await listPartPrices(partId);
    expect(rows[0].breaks[0].price).toBe(1);

    await asSystem(() => deletePriceBreak(partId, priceId, breakId));
    rows = await listPartPrices(partId);
    expect(rows[0].breaks).toEqual([]);
  });

  // Fix wave 1, finding 2: the existing "scoped to its price row" test above only exercises the
  // FIRST scoping tier (a price row belonging to a different PART), so both rejections there
  // actually assert "Price row not found". This covers the second tier: a break id that belongs
  // to a DIFFERENT price row on the SAME part — where a wrong-row edit would otherwise succeed.
  it("404s 'Price break not found' for a break on a different price row of the same part", async () => {
    const { partId, austemper, straighten } = await fixture();
    const { id: priceA } = await asSystem(() =>
      addPartPrice(partId, { processStepCodeId: austemper.id, position: 1, pricePer: "EACH" }));
    const { id: priceB } = await asSystem(() =>
      addPartPrice(partId, { processStepCodeId: straighten.id, position: 2, pricePer: "EACH" }));
    const { id: breakId } = await asSystem(() => addPriceBreak(partId, priceA, { threshold: 500, price: "0.95" }));

    await expect(asSystem(() => updatePriceBreak(partId, priceB, breakId, { price: "1.00" })))
      .rejects.toThrow("Price break not found");
    await expect(asSystem(() => deletePriceBreak(partId, priceB, breakId)))
      .rejects.toThrow("Price break not found");
  });

  // Fix wave 1, finding 3: exercises the step-code-change branch (part-prices.ts:126-135) — both
  // the happy path (change + read-back) and the duplicate re-check that branch performs. The
  // helper's declared param type omits processStepCodeId, so only a runtime test catches a wrong
  // FK field name here (see part-prices.ts:103's comment).
  it("changes a price row's step code, and the duplicate re-check catches a collision on that change", async () => {
    const { partId, austemper, straighten } = await fixture();
    const temper = await prisma.processStepCode.create({ data: { code: "TEMP", name: "Temper" } });
    const { id: priceId } = await asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 }));

    await asSystem(() => updatePartPrice(partId, priceId, { processStepCodeId: temper.id }));
    const rows = await listPartPrices(partId);
    expect(rows[0].processStepCodeId).toBe(temper.id);
    expect(rows[0].stepCode).toBe("TEMP");

    const { id: otherPriceId } = await asSystem(() =>
      addPartPrice(partId, { processStepCodeId: straighten.id, position: 2 }));
    await expect(asSystem(() => updatePartPrice(partId, otherPriceId, { processStepCodeId: temper.id })))
      .rejects.toThrow("That operation is already priced on this part");
  });

  // Fix wave 1, finding 5: breaks now hang off a price row rather than the part, so the
  // duplicate-threshold refusal deserves its own case on both addPriceBreak and updatePriceBreak.
  it("refuses a duplicate threshold on add and on update", async () => {
    const { partId, austemper } = await fixture();
    const { id: priceId } = await asSystem(() =>
      addPartPrice(partId, { processStepCodeId: austemper.id, position: 1, pricePer: "EACH" }));
    await asSystem(() => addPriceBreak(partId, priceId, { threshold: 500, price: "0.95" }));
    await expect(asSystem(() => addPriceBreak(partId, priceId, { threshold: 500, price: "0.90" })))
      .rejects.toThrow("A price break with that threshold already exists");

    const { id: otherBreakId } = await asSystem(() =>
      addPriceBreak(partId, priceId, { threshold: 1000, price: "0.85" }));
    await expect(asSystem(() => updatePriceBreak(partId, priceId, otherBreakId, { threshold: 500 })))
      .rejects.toThrow("A price break with that threshold already exists");
  });

  // Fix-wave 1, finding 1: mirrors reorderPartInspections' own test suite (tests/part-inspections.
  // test.ts) exactly — same atomic-reorder shape, same set-check refusals, same "only touched rows
  // are audited" and 404 cases. reorderPartPrices exists precisely because the UI's old two-PATCH
  // position swap could leave two rows permanently tied (see PricingSection.tsx's move() comment
  // and part-prices.ts's own doc comment on this function).
  describe("reorderPartPrices", () => {
    async function threeRows() {
      const { partId, otherPartId, austemper, straighten } = await fixture();
      const temper = await prisma.processStepCode.create({ data: { code: "TEMP", name: "Temper" } });
      const a = await asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 0 }));
      const b = await asSystem(() => addPartPrice(partId, { processStepCodeId: straighten.id, position: 1 }));
      const c = await asSystem(() => addPartPrice(partId, { processStepCodeId: temper.id, position: 2 }));
      return { partId, otherPartId, a: a.id, b: b.id, c: c.id };
    }

    it("persists the new order atomically and lists in it", async () => {
      const { partId, a, b, c } = await threeRows();
      await asSystem(() => reorderPartPrices(partId, [c, a, b]));
      const rows = await listPartPrices(partId);
      expect(rows.map((r) => r.id)).toEqual([c, a, b]);
      expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
    });

    it("rejects a missing id with the exactly-once message", async () => {
      const { partId, a, b } = await threeRows();
      await expect(asSystem(() => reorderPartPrices(partId, [a, b])))
        .rejects.toThrow("The order must list every price row exactly once");
    });

    it("rejects a duplicate id (even at the right count) with the exactly-once message", async () => {
      const { partId, a, b } = await threeRows();
      await expect(asSystem(() => reorderPartPrices(partId, [a, a, b])))
        .rejects.toThrow("The order must list every price row exactly once");
    });

    it("rejects an extra/unknown id with the exactly-once message", async () => {
      const { partId, a, b, c } = await threeRows();
      await expect(asSystem(() => reorderPartPrices(partId, [a, b, c, "not-a-real-id"])))
        .rejects.toThrow("The order must list every price row exactly once");
    });

    // Deliberate: the URL's part is live, so the part-liveness check passes; the set check then
    // compares orderedIds against THAT part's own live price ids (empty, here), not the ids'
    // actual owning part — so this is the set check's 400, not a 404.
    it("wrong-part scoping: part B's URL with part A's row ids is the set check's 400, not a 404", async () => {
      const { otherPartId, a, b, c } = await threeRows();
      await expect(asSystem(() => reorderPartPrices(otherPartId, [a, b, c])))
        .rejects.toThrow("The order must list every price row exactly once");
    });

    it("only writes and audits rows whose position actually changes", async () => {
      const { partId, a, b, c } = await threeRows();
      // Swap only a and b; c (already at index 2) is unchanged and must not be touched.
      await asSystem(() => reorderPartPrices(partId, [b, a, c]));
      const entries = await prisma.auditLog.findMany({
        where: { entity: "partPrice", action: "update" }, orderBy: { at: "asc" } });
      expect(entries).toHaveLength(2);
      expect(new Set(entries.map((e) => e.entityId))).toEqual(new Set([a, b]));
      expect(entries.some((e) => e.entityId === c)).toBe(false);
    });

    it("404s a part that no longer exists / is soft-deleted", async () => {
      const { partId, a, b, c } = await threeRows();
      await prisma.part.update({ where: { id: partId }, data: { deletedAt: new Date() } });
      await expect(asSystem(() => reorderPartPrices(partId, [a, b, c])))
        .rejects.toThrow("Part not found");
    });
  });
});
