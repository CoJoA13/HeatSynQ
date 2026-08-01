import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createPart } from "@/server/parts";
import {
  listPartBreaks, addPartBreak, updatePartBreak, deletePartBreak,
} from "@/server/part-price-breaks";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Foundry" } });
  const other = await prisma.customer.create({ data: { code: "BETA", name: "Beta Co" } });
  const { id: partId } = await asSystem(() =>
    createPart({ customerId: customer.id, partNumber: "12345", eachWeight: 1 }));
  const { id: otherPartId } = await asSystem(() =>
    createPart({ customerId: other.id, partNumber: "99999", eachWeight: 1 }));
  return { customer, other, partId, otherPartId };
}

describe("part price breaks", () => {
  beforeEach(truncateAll);

  it("adds breaks and lists them threshold-ascending", async () => {
    const { partId } = await fixture();
    await asSystem(() => addPartBreak(partId, { threshold: 500, price: "0.95" }));
    await asSystem(() => addPartBreak(partId, { threshold: 100, price: "1.10" }));
    const rows = await listPartBreaks(partId);
    expect(rows.map((r) => r.threshold)).toEqual([100, 500]);
  });

  it("rejects a second live break on the same threshold", async () => {
    const { partId } = await fixture();
    await asSystem(() => addPartBreak(partId, { threshold: 500, price: "0.95" }));
    await expect(asSystem(() => addPartBreak(partId, { threshold: 500, price: "0.90" })))
      .rejects.toThrow("A price break with that threshold already exists");
  });

  it("delete-then-reuse a threshold works (partial unique)", async () => {
    const { partId } = await fixture();
    const { id: first } = await asSystem(() => addPartBreak(partId, { threshold: 500, price: "0.95" }));
    await asSystem(() => deletePartBreak(partId, first));
    const { id: second } = await asSystem(() => addPartBreak(partId, { threshold: 500, price: "0.90" }));
    expect(second).not.toBe(first);
  });

  it("refuses a break on a LOT-priced part", async () => {
    const { customer } = await fixture();
    const { id: lotPartId } = await asSystem(() => createPart({
      customerId: customer.id, partNumber: "LOT1", eachWeight: 1, pricePer: "LOT",
    }));
    await expect(asSystem(() => addPartBreak(lotPartId, { threshold: 500, price: "0.95" })))
      .rejects.toThrow("A LOT-priced part cannot carry price breaks");
  });

  it("threshold must be > 0; price accepts 4 decimals ≥ 0", async () => {
    const { partId } = await fixture();
    await expect(asSystem(() => addPartBreak(partId, { threshold: 0, price: "1.00" })))
      .rejects.toThrow("Must be greater than zero");
    const { id } = await asSystem(() => addPartBreak(partId, { threshold: 100, price: "0.0475" }));
    const rows = await listPartBreaks(partId);
    expect(rows.find((r) => r.id === id)!.price).toBe(0.0475);
  });

  it("scopes update/delete to the part", async () => {
    const { partId, otherPartId } = await fixture();
    const { id } = await asSystem(() => addPartBreak(partId, { threshold: 500, price: "0.95" }));
    await expect(asSystem(() => updatePartBreak(otherPartId, id, { price: "1.00" })))
      .rejects.toThrow("Price break not found");
    await expect(asSystem(() => deletePartBreak(otherPartId, id)))
      .rejects.toThrow("Price break not found");
  });

  it("audits as partPriceBreak", async () => {
    const { partId } = await fixture();
    const { id } = await asSystem(() => addPartBreak(partId, { threshold: 500, price: "0.95" }));
    await asSystem(() => updatePartBreak(partId, id, { price: "1.00" }));
    await asSystem(() => deletePartBreak(partId, id));
    const entries = await prisma.auditLog.findMany({
      where: { entity: "partPriceBreak", entityId: id }, orderBy: [{ at: "asc" }, { id: "asc" }] });
    expect(entries.map((e) => e.action)).toEqual(["create", "update", "delete"]);
    const updateEntry = entries[1];
    const before = updateEntry.before as { price: string }; const after = updateEntry.after as { price: string };
    expect(before.price).not.toBe(after.price);
  });
});
