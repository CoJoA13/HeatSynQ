import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createPart } from "@/server/parts";
import {
  listPartInspections, addPartInspection, updatePartInspection, deletePartInspection,
} from "@/server/part-inspections";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Foundry" } });
  const other = await prisma.customer.create({ data: { code: "BETA", name: "Beta Co" } });
  const code = await prisma.inspectionCode.create({ data: { name: "Brinell" } });
  const scale = await prisma.inspectionScale.create({ data: { name: "HB" } });
  const { id: partId } = await asSystem(() =>
    createPart({ customerId: customer.id, partNumber: "12345", eachWeight: 1 }));
  const { id: otherPartId } = await asSystem(() =>
    createPart({ customerId: other.id, partNumber: "99999", eachWeight: 1 }));
  return { customer, other, code, scale, partId, otherPartId };
}

describe("part inspections", () => {
  beforeEach(truncateAll);

  it("adds a row and lists in sort order with code and scale names", async () => {
    const { code, scale, partId } = await fixture();
    await asSystem(() => addPartInspection(partId, {
      inspectionCodeId: code.id, scaleId: scale.id, sort: 1, location: "hub",
    }));
    await asSystem(() => addPartInspection(partId, {
      inspectionCodeId: code.id, scaleId: scale.id, sort: 0, location: "flange OD",
    }));
    const rows = await listPartInspections(partId);
    expect(rows.map((r) => r.sort)).toEqual([0, 1]);
    expect(rows[0]).toMatchObject({
      inspectionCodeName: "Brinell", scaleName: "HB", location: "flange OD",
    });
  });

  it("scale is optional; min/max are optional decimals(10,4)", async () => {
    const { code, partId } = await fixture();
    const { id } = await asSystem(() => addPartInspection(partId, {
      inspectionCodeId: code.id, sort: 0,
    }));
    expect(id).toBeTruthy();
    await asSystem(() => updatePartInspection(partId, id, { min: "28", max: "32" }));
    const rows = await listPartInspections(partId);
    expect(rows[0].scaleId).toBeNull();
    expect(rows[0].scaleName).toBeNull();
    expect(rows[0].min).toBe(28);
    expect(rows[0].max).toBe(32);
  });

  it("min > max is a field-anchored 400", async () => {
    const { code, partId } = await fixture();
    await expect(asSystem(() => addPartInspection(partId, {
      inspectionCodeId: code.id, sort: 0, min: "40", max: "30",
    }))).rejects.toThrow("min cannot exceed max");
  });

  it("patching only max against a stored min rejects when the merge violates min <= max", async () => {
    const { code, partId } = await fixture();
    const { id } = await asSystem(() => addPartInspection(partId, {
      inspectionCodeId: code.id, sort: 0, min: "10", max: "50",
    }));
    await expect(asSystem(() => updatePartInspection(partId, id, { max: "5" })))
      .rejects.toThrow("min cannot exceed max");
  });

  it("patching only max against a stored min succeeds when the merge still satisfies min <= max", async () => {
    const { code, partId } = await fixture();
    const { id } = await asSystem(() => addPartInspection(partId, {
      inspectionCodeId: code.id, sort: 0, min: "10", max: "50",
    }));
    await asSystem(() => updatePartInspection(partId, id, { max: "20" }));
    const rows = await listPartInspections(partId);
    expect(rows[0].min).toBe(10);
    expect(rows[0].max).toBe(20);
  });

  it("rejects soft-deleted code and scale", async () => {
    const { code, partId } = await fixture();
    const deadCode = await prisma.inspectionCode.create({ data: { name: "Gone", deletedAt: new Date() } });
    const deadScale = await prisma.inspectionScale.create({ data: { name: "GoneScale", deletedAt: new Date() } });
    await expect(asSystem(() => addPartInspection(partId, {
      inspectionCodeId: deadCode.id, sort: 0,
    }))).rejects.toThrow("That inspection code does not exist");
    await expect(asSystem(() => addPartInspection(partId, {
      inspectionCodeId: code.id, scaleId: deadScale.id, sort: 0,
    }))).rejects.toThrow("That inspection scale does not exist");
  });

  it("same code twice with different locations is allowed", async () => {
    const { code, partId } = await fixture();
    await asSystem(() => addPartInspection(partId, { inspectionCodeId: code.id, sort: 0, location: "flange OD" }));
    await asSystem(() => addPartInspection(partId, { inspectionCodeId: code.id, sort: 1, location: "hub" }));
    const rows = await listPartInspections(partId);
    expect(rows).toHaveLength(2);
  });

  it("update and delete scope to the part", async () => {
    const { code, partId, otherPartId } = await fixture();
    const { id } = await asSystem(() => addPartInspection(partId, { inspectionCodeId: code.id, sort: 0 }));
    await expect(asSystem(() => updatePartInspection(otherPartId, id, { location: "x" })))
      .rejects.toThrow("not found");
    await expect(asSystem(() => deletePartInspection(otherPartId, id)))
      .rejects.toThrow("not found");
  });

  it("audits as partInspection with a real diff on update", async () => {
    const { code, partId } = await fixture();
    const { id } = await asSystem(() => addPartInspection(partId, { inspectionCodeId: code.id, sort: 0 }));
    await asSystem(() => updatePartInspection(partId, id, { location: "flange OD" }));
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "partInspection", entityId: id, action: "update" } });
    const before = entry!.before as { location: string }; const after = entry!.after as { location: string };
    expect(before.location).toBe(""); expect(after.location).toBe("flange OD");
  });
});
