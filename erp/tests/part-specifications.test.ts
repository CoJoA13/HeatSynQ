import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createPart, deletePart } from "@/server/parts";
import { listPartSpecs, addPartSpec, removePartSpec } from "@/server/part-specifications";
import { deleteReference } from "@/server/reference";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Foundry" } });
  const other = await prisma.customer.create({ data: { code: "BETA", name: "Beta Co" } });
  const spec = await prisma.specification.create({ data: { name: "ASTM A536" } });
  const { id: partId } = await asSystem(() =>
    createPart({ customerId: customer.id, partNumber: "12345", eachWeight: 1 }));
  const { id: otherPartId } = await asSystem(() =>
    createPart({ customerId: other.id, partNumber: "99999", eachWeight: 1 }));
  return { customer, other, spec, partId, otherPartId };
}

describe("part specifications", () => {
  beforeEach(truncateAll);

  it("adds a spec and lists it with its name", async () => {
    const { spec, partId } = await fixture();
    await asSystem(() => addPartSpec(partId, spec.id));
    const rows = await listPartSpecs(partId);
    expect(rows[0].specificationName).toBe("ASTM A536");
  });

  it("rejects a soft-deleted specification", async () => {
    const { partId } = await fixture();
    const dead = await prisma.specification.create({ data: { name: "Gone", deletedAt: new Date() } });
    await expect(asSystem(() => addPartSpec(partId, dead.id)))
      .rejects.toThrow("That specification does not exist");
  });

  it("rejects a duplicate live link", async () => {
    const { spec, partId } = await fixture();
    await asSystem(() => addPartSpec(partId, spec.id));
    await expect(asSystem(() => addPartSpec(partId, spec.id)))
      .rejects.toThrow("already on this part");
  });

  it("remove-then-re-add works (partial unique on live rows)", async () => {
    const { spec, partId } = await fixture();
    const { id: linkId } = await asSystem(() => addPartSpec(partId, spec.id));
    await asSystem(() => removePartSpec(partId, linkId));
    const { id: newLinkId } = await asSystem(() => addPartSpec(partId, spec.id));
    expect(newLinkId).not.toBe(linkId);
    const rows = await listPartSpecs(partId);
    expect(rows).toHaveLength(1);
  });

  it("scopes to the part: removing via the wrong partId 404s", async () => {
    const { spec, partId, otherPartId } = await fixture();
    const { id: linkId } = await asSystem(() => addPartSpec(partId, spec.id));
    await expect(asSystem(() => removePartSpec(otherPartId, linkId)))
      .rejects.toThrow("not found");
  });

  it("audits add and remove as partSpecification entries", async () => {
    const { spec, partId } = await fixture();
    const { id: linkId } = await asSystem(() => addPartSpec(partId, spec.id));
    await asSystem(() => removePartSpec(partId, linkId));
    const entries = await prisma.auditLog.findMany({
      where: { entity: "partSpecification", entityId: linkId }, orderBy: { at: "asc" } });
    expect(entries.map((e) => e.action)).toEqual(["create", "delete"]);
  });

  it("add to a deleted part 404s", async () => {
    const { spec, partId } = await fixture();
    await asSystem(() => deletePart(partId, "keyed wrong"));
    await expect(asSystem(() => addPartSpec(partId, spec.id)))
      .rejects.toThrow("Part not found");
  });

  it("deleteReference refuses while a part points at the spec through the service", async () => {
    const { spec, partId } = await fixture();
    await asSystem(() => addPartSpec(partId, spec.id));
    await expect(asSystem(() => deleteReference("specification", spec.id)))
      .rejects.toThrow("still in use by 1 record(s)");
  });
});
