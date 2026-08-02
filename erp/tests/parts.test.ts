import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createPart, updatePart, deletePart, getPart, listParts } from "@/server/parts";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

async function twoCustomers() {
  const acme = await prisma.customer.create({ data: { code: "ACME", name: "Acme Foundry" } });
  const beta = await prisma.customer.create({ data: { code: "BETA", name: "Beta Co" } });
  return { acme, beta };
}

describe("parts core", () => {
  beforeEach(truncateAll);

  it("creates with required fields and lists with customer + material names resolved", async () => {
    const { acme } = await twoCustomers();
    const mat = await prisma.material.create({ data: { name: "Ductile iron" } });
    await asSystem(() => createPart({
      customerId: acme.id, partNumber: "12345", eachWeight: "2.5000", materialId: mat.id,
    }));
    const rows = await listParts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      partNumber: "12345", customerCode: "ACME", customerName: "Acme Foundry",
      materialName: "Ductile iron", eachWeight: 2.5, pricePer: "EACH", active: true,
    });
  });

  it("same part number coexists under two customers; duplicate under one 400s", async () => {
    const { acme, beta } = await twoCustomers();
    await asSystem(() => createPart({ customerId: acme.id, partNumber: "12345", eachWeight: 1 }));
    await asSystem(() => createPart({ customerId: beta.id, partNumber: "12345", eachWeight: 1 }));
    expect(await prisma.part.count()).toBe(2);
    await expect(asSystem(() => createPart({ customerId: acme.id, partNumber: "12345", eachWeight: 1 })))
      .rejects.toThrow("A part with that part number already exists for that customer");
  });

  it("delete-then-rekey creates a genuinely new row with fresh history (no revival)", async () => {
    const { acme } = await twoCustomers();
    const { id: first } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "77", eachWeight: 1 }));
    await asSystem(() => deletePart(first, "typo"));
    const { id: second } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "77", eachWeight: 2 }));
    expect(second).not.toBe(first);
    const history = await prisma.auditLog.findMany({ where: { entity: "part", entityId: second } });
    expect(history.map((h) => h.action)).toEqual(["create"]);
  });

  it("eachWeight must be > 0 and fit Decimal(10,4); prices carry 4 decimals", async () => {
    const { acme } = await twoCustomers();
    await expect(asSystem(() => createPart({ customerId: acme.id, partNumber: "A", eachWeight: 0 })))
      .rejects.toThrow("Must be greater than zero");
    await expect(asSystem(() => createPart({ customerId: acme.id, partNumber: "A", eachWeight: "1.00001" })))
      .rejects.toThrow("4 digits after the decimal point");
    const { id } = await asSystem(() => createPart({
      customerId: acme.id, partNumber: "A", eachWeight: "0.0500", unitPrice: "0.0575", pricePer: "LB",
    }));
    expect((await getPart(id)).unitPrice).toBe(0.0575);
  });

  it("customerId is immutable after create", async () => {
    const { acme, beta } = await twoCustomers();
    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "M1", eachWeight: 1 }));
    await expect(asSystem(() => updatePart(id, { customerId: beta.id })))
      .rejects.toThrow("A part cannot move to another customer");
  });

  it("materialId must reference a live material, on create and update", async () => {
    const { acme } = await twoCustomers();
    const dead = await prisma.material.create({ data: { name: "Gone", deletedAt: new Date() } });
    await expect(asSystem(() => createPart({
      customerId: acme.id, partNumber: "X", eachWeight: 1, materialId: dead.id,
    }))).rejects.toThrow("That material does not exist");

    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "X2", eachWeight: 1 }));
    await expect(asSystem(() => updatePart(id, { materialId: dead.id })))
      .rejects.toThrow("That material does not exist");
  });

  it("switching pricePer to LOT with live breaks is refused", async () => {
    const { acme } = await twoCustomers();
    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "L", eachWeight: 1 }));
    await prisma.partPriceBreak.create({ data: { partId: id, threshold: "500", price: "0.95" } });
    await expect(asSystem(() => updatePart(id, { pricePer: "LOT" })))
      .rejects.toThrow("delete the price breaks first");
  });

  it("delete requires a reason and cascades children in one transaction", async () => {
    const { acme } = await twoCustomers();
    const spec = await prisma.specification.create({ data: { name: "ASTM A536" } });
    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "D", eachWeight: 1 }));
    await prisma.partSpecification.create({ data: { partId: id, specificationId: spec.id } });
    await expect(asSystem(() => deletePart(id, "  "))).rejects.toThrow("A reason is required");
    await asSystem(() => deletePart(id, "keyed wrong"));
    expect((await prisma.part.findFirst({ where: { id } }))!.deletedAt).not.toBeNull();
    expect((await prisma.partSpecification.findFirst({ where: { partId: id } }))!.deletedAt).not.toBeNull();
    const entry = await prisma.auditLog.findFirst({ where: { entity: "part", entityId: id, action: "delete" } });
    expect(entry!.reason).toBe("keyed wrong");
  });

  it("search matches part number, customer code, and customer name", async () => {
    const { acme, beta } = await twoCustomers();
    await asSystem(() => createPart({ customerId: acme.id, partNumber: "GEAR-9", eachWeight: 1 }));
    await asSystem(() => createPart({ customerId: beta.id, partNumber: "PIN-1", eachWeight: 1 }));
    expect((await listParts({ search: "gear" })).map((p) => p.partNumber)).toEqual(["GEAR-9"]);
    expect((await listParts({ search: "beta" })).map((p) => p.partNumber)).toEqual(["PIN-1"]);
    expect((await listParts({ search: "ACME" })).map((p) => p.partNumber)).toEqual(["GEAR-9"]);
  });

  it("update audit entries carry a real diff", async () => {
    const { acme } = await twoCustomers();
    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "AU", eachWeight: 1 }));
    await asSystem(() => updatePart(id, { name: "Ring gear" }));
    const entry = await prisma.auditLog.findFirst({ where: { entity: "part", entityId: id, action: "update" } });
    const before = entry!.before as { name: string }; const after = entry!.after as { name: string };
    expect(before.name).toBe(""); expect(after.name).toBe("Ring gear");
  });

  it("inactive parts hide by default and appear with includeInactive", async () => {
    const { acme } = await twoCustomers();
    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "IN", eachWeight: 1 }));
    await asSystem(() => updatePart(id, { active: false }));
    expect(await listParts()).toHaveLength(0);
    expect(await listParts({ includeInactive: true })).toHaveLength(1);
  });
});
