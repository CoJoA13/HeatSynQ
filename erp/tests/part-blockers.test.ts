import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { findBlockers } from "@/server/reference-blockers";
import { deleteReference } from "@/server/reference";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Foundry" } });
  const material = await prisma.material.create({ data: { name: "Ductile iron" } });
  const code = await prisma.inspectionCode.create({ data: { name: "Brinell" } });
  const scale = await prisma.inspectionScale.create({ data: { name: "HB" } });
  const spec = await prisma.specification.create({ data: { name: "ASTM A536" } });
  const part = await prisma.part.create({ data: {
    customerId: customer.id, partNumber: "12345", eachWeight: "2.5", materialId: material.id,
  } });
  return { customer, material, code, scale, spec, part };
}

describe("parts as blockers", () => {
  beforeEach(truncateAll);

  it("a part blocking its material shows CODE · partNumber linked to the part", async () => {
    const { material, part } = await fixture();
    const blockers = await findBlockers("material", material.id);
    expect(blockers).toEqual([
      { entityLabel: "Part", name: "ACME · 12345", id: part.id, href: `/parts/${part.id}` },
    ]);
  });

  it("two inspection rows on one code dedupe to one part blocker", async () => {
    const { code, part } = await fixture();
    await prisma.partInspection.createMany({ data: [
      { partId: part.id, inspectionCodeId: code.id, sort: 0, location: "flange OD" },
      { partId: part.id, inspectionCodeId: code.id, sort: 1, location: "hub" },
    ] });
    const blockers = await findBlockers("inspectionCode", code.id);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ entityLabel: "Part", name: "ACME · 12345", id: part.id });
  });

  it("scale and specification links present the part too", async () => {
    const { scale, spec, part } = await fixture();
    await prisma.partInspection.create({ data: { partId: part.id, inspectionCodeId:
      (await prisma.inspectionCode.create({ data: { name: "Rockwell" } })).id, scaleId: scale.id, sort: 0 } });
    await prisma.partSpecification.create({ data: { partId: part.id, specificationId: spec.id } });
    expect((await findBlockers("inspectionScale", scale.id))[0].name).toBe("ACME · 12345");
    expect((await findBlockers("specification", spec.id))[0].name).toBe("ACME · 12345");
  });

  it("a soft-deleted child row no longer blocks", async () => {
    const { spec, part } = await fixture();
    await prisma.partSpecification.create({
      data: { partId: part.id, specificationId: spec.id, deletedAt: new Date() } });
    expect(await findBlockers("specification", spec.id)).toEqual([]);
  });

  it("deleteReference refuses while a part points at the row", async () => {
    const { material } = await fixture();
    await expect(asSystem(() => deleteReference("material", material.id)))
      .rejects.toThrow("still in use by 1 record(s)");
  });
});
