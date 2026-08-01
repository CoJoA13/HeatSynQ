import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createPart } from "@/server/parts";
import {
  listPartFieldDefs, createPartFieldDef, updatePartFieldDef, deletePartFieldDef, partFieldDefBlockers,
} from "@/server/part-field-defs";
import { listPartFieldValues, setPartFieldValues } from "@/server/part-field-values";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Foundry" } });
  const { id: partId } = await asSystem(() =>
    createPart({ customerId: customer.id, partNumber: "12345", eachWeight: 1 }));
  return { customer, partId };
}

describe("part field definitions", () => {
  beforeEach(truncateAll);

  it("creates, lists by sort, partial-unique name among live rows", async () => {
    await asSystem(() => createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 1 }));
    await asSystem(() => createPartFieldDef({ name: "Heat treat date", type: "DATE", sort: 0 }));
    const rows = await listPartFieldDefs();
    expect(rows.map((r) => r.name)).toEqual(["Heat treat date", "Drawing #"]);

    await expect(asSystem(() => createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 2 })))
      .rejects.toThrow("already exists");

    const target = rows.find((r) => r.name === "Drawing #")!;
    await asSystem(() => deletePartFieldDef(target.id));
    const { id: recreated } = await asSystem(() =>
      createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 3 }));
    expect(recreated).not.toBe(target.id);
  });

  it("delete with only empty values succeeds; non-empty value blocks", async () => {
    const { partId } = await fixture();
    const { id: fieldId } = await asSystem(() =>
      createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 }));
    await asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "DWG-100" }]));
    await asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "" }]));
    await asSystem(() => deletePartFieldDef(fieldId));
    expect((await prisma.partFieldDef.findFirst({ where: { id: fieldId } }))!.deletedAt).not.toBeNull();

    const { id: fieldId2 } = await asSystem(() =>
      createPartFieldDef({ name: "Drawing #2", type: "TEXT", sort: 1 }));
    await asSystem(() => setPartFieldValues(partId, [{ fieldId: fieldId2, value: "DWG-200" }]));
    await expect(asSystem(() => deletePartFieldDef(fieldId2)))
      .rejects.toThrow("still holds a value on 1 part(s)");
  });

  it("partFieldDefBlockers names parts as CODE · partNumber with hrefs", async () => {
    const { partId } = await fixture();
    const { id: fieldId } = await asSystem(() =>
      createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 }));
    await asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "DWG-100" }]));
    const blockers = await partFieldDefBlockers(fieldId);
    expect(blockers).toEqual([
      { entityLabel: "Part", name: "ACME · 12345", id: partId, href: `/parts/${partId}` },
    ]);
  });

  it("update edits fields and can toggle active", async () => {
    const { id: fieldId } = await asSystem(() =>
      createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 }));
    await asSystem(() => updatePartFieldDef(fieldId, { active: false, sort: 5 }));
    const rows = await listPartFieldDefs({ includeInactive: true });
    const row = rows.find((r) => r.id === fieldId)!;
    expect(row.active).toBe(false);
    expect(row.sort).toBe(5);
    expect(await listPartFieldDefs()).toHaveLength(0);
  });
});

describe("part field values", () => {
  beforeEach(truncateAll);

  it("sets and lists values; clearing writes empty string", async () => {
    const { partId } = await fixture();
    const { id: fieldId } = await asSystem(() =>
      createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 }));
    await asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "DWG-100" }]));
    expect((await listPartFieldValues(partId)).find((r) => r.fieldId === fieldId)!.value).toBe("DWG-100");
    await asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "" }]));
    expect((await listPartFieldValues(partId)).find((r) => r.fieldId === fieldId)!.value).toBe("");
  });

  it("NUMBER value must be a decimal string", async () => {
    const { partId } = await fixture();
    const { id: fieldId } = await asSystem(() =>
      createPartFieldDef({ name: "Weight", type: "NUMBER", sort: 0 }));
    await expect(asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "abc" }])))
      .rejects.toThrow("is not a valid number");
  });

  it("DATE value must be yyyy-mm-dd", async () => {
    const { partId } = await fixture();
    const { id: fieldId } = await asSystem(() =>
      createPartFieldDef({ name: "Heat date", type: "DATE", sort: 0 }));
    await expect(asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "01/02/2026" }])))
      .rejects.toThrow("is not a valid date");
  });

  it("CHECKBOX value must be true or false", async () => {
    const { partId } = await fixture();
    const { id: fieldId } = await asSystem(() =>
      createPartFieldDef({ name: "Certified", type: "CHECKBOX", sort: 0 }));
    await expect(asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "maybe" }])))
      .rejects.toThrow("must be true or false");
  });

  it("unknown or deleted fieldId is a 400 naming the field", async () => {
    const { partId } = await fixture();
    await expect(asSystem(() => setPartFieldValues(partId, [{ fieldId: "nonexistent", value: "x" }])))
      .rejects.toThrow("That field does not exist");

    const { id: fieldId } = await asSystem(() =>
      createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 }));
    await asSystem(() => deletePartFieldDef(fieldId));
    await expect(asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "x" }])))
      .rejects.toThrow("That field does not exist");
  });

  it("values on inactive defs stay settable and listed", async () => {
    const { partId } = await fixture();
    const { id: fieldId } = await asSystem(() =>
      createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 }));
    await asSystem(() => updatePartFieldDef(fieldId, { active: false }));
    await asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "DWG-100" }]));
    const rows = await listPartFieldValues(partId);
    const row = rows.find((r) => r.fieldId === fieldId)!;
    expect(row.value).toBe("DWG-100");
    expect(row.active).toBe(false);
  });

  it("audit history reads as updates: before A → after B", async () => {
    const { partId } = await fixture();
    const { id: fieldId } = await asSystem(() =>
      createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 }));
    await asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "A" }]));
    await asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "B" }]));
    const valueRow = await prisma.partFieldValue.findFirst({ where: { partId, fieldId } });
    const entries = await prisma.auditLog.findMany({
      where: { entity: "partFieldValue", entityId: valueRow!.id }, orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    expect(entries.map((e) => e.action)).toEqual(["create", "update"]);
    const before = entries[1].before as { value: string };
    const after = entries[1].after as { value: string };
    expect(before.value).toBe("A");
    expect(after.value).toBe("B");
  });

  it("unchanged value writes no audit entry", async () => {
    const { partId } = await fixture();
    const { id: fieldId } = await asSystem(() =>
      createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 }));
    await asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "A" }]));
    await asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "A" }]));
    const valueRow = await prisma.partFieldValue.findFirst({ where: { partId, fieldId } });
    const entries = await prisma.auditLog.findMany({ where: { entity: "partFieldValue", entityId: valueRow!.id } });
    expect(entries.map((e) => e.action)).toEqual(["create"]);
  });
});
