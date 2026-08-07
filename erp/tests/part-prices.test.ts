import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createPart } from "@/server/parts";
import {
  listPartPrices, addPartPrice, updatePartPrice, deletePartPrice,
  addPriceBreak, updatePriceBreak, deletePriceBreak,
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
});
