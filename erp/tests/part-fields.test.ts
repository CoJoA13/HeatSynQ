import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createPart, deletePart } from "@/server/parts";
import {
  listPartFieldDefs, createPartFieldDef, updatePartFieldDef, deletePartFieldDef, partFieldDefBlockers,
} from "@/server/part-field-defs";
import { listPartFieldValues, setPartFieldValues } from "@/server/part-field-values";
import { readAudit } from "@/server/audit";

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

  it("blocks a type change while a live part holds a non-empty value; allowed once cleared", async () => {
    const { partId } = await fixture();
    const { id: fieldId } = await asSystem(() =>
      createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 }));
    await asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "DWG-100" }]));

    await expect(asSystem(() => updatePartFieldDef(fieldId, { type: "NUMBER" })))
      .rejects.toThrow("still holds a value on 1 part(s) — its type cannot change");
    expect((await listPartFieldDefs({ includeInactive: true })).find((r) => r.id === fieldId)!.type)
      .toBe("TEXT");

    await asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "" }]));
    await asSystem(() => updatePartFieldDef(fieldId, { type: "NUMBER" }));
    expect((await listPartFieldDefs({ includeInactive: true })).find((r) => r.id === fieldId)!.type)
      .toBe("NUMBER");
  });

  it("a same-type `type` key in the patch is not a change and passes despite a non-empty value", async () => {
    const { partId } = await fixture();
    const { id: fieldId } = await asSystem(() =>
      createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 }));
    await asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "DWG-100" }]));

    await asSystem(() => updatePartFieldDef(fieldId, { type: "TEXT", sort: 9 }));
    const row = (await listPartFieldDefs({ includeInactive: true })).find((r) => r.id === fieldId)!;
    expect(row.type).toBe("TEXT");
    expect(row.sort).toBe(9);
  });

  it("name/sort/active edits are unaffected by values on the field", async () => {
    const { partId } = await fixture();
    const { id: fieldId } = await asSystem(() =>
      createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 }));
    await asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "DWG-100" }]));

    await asSystem(() => updatePartFieldDef(fieldId, { name: "Drawing number", sort: 3, active: false }));
    const row = (await listPartFieldDefs({ includeInactive: true })).find((r) => r.id === fieldId)!;
    expect(row.name).toBe("Drawing number");
    expect(row.sort).toBe(3);
    expect(row.active).toBe(false);
  });

  // F3: a patch that never touches `type` used to write via a bare `update({ where: { id } })`
  // with no liveness claim, so a stale PUT arriving after a delete edited the soft-deleted row
  // and appended a post-delete "update" audit entry. Claim-live (updateMany + deletedAt: null)
  // makes that a 404 instead, same as every other claim-live write in this codebase.
  it("a stale non-type PUT after delete 404s and writes no audit entry", async () => {
    const { id: fieldId } = await asSystem(() =>
      createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 }));
    await asSystem(() => deletePartFieldDef(fieldId));
    const before = await readAudit("partFieldDef", fieldId);

    await expect(asSystem(() => updatePartFieldDef(fieldId, { name: "Drawing number" })))
      .rejects.toMatchObject({ status: 404 });

    const after = await readAudit("partFieldDef", fieldId);
    expect(after).toHaveLength(before.length);
  });

  // Same claim on the type-change path: its pre-check already reads deletedAt: null, but the
  // write it fed into was the same unguarded `update`. Route the write through the identical
  // claim-live helper so both patch shapes share one liveness guarantee.
  it("a stale type-change PUT after delete 404s and writes no audit entry", async () => {
    const { id: fieldId } = await asSystem(() =>
      createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 }));
    await asSystem(() => deletePartFieldDef(fieldId));
    const before = await readAudit("partFieldDef", fieldId);

    await expect(asSystem(() => updatePartFieldDef(fieldId, { type: "NUMBER" })))
      .rejects.toMatchObject({ status: 404 });

    const after = await readAudit("partFieldDef", fieldId);
    expect(after).toHaveLength(before.length);
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

  // F4: Date.parse rolls a nonexistent calendar date over into the next valid one instead of
  // rejecting it (Date.parse("2025-02-29") does not return NaN — it silently becomes March 1),
  // so the regex + Date.parse combination let a shop floor date like "the 29th of a non-leap
  // February" slip through as valid. 2024 IS a leap year, so 2024-02-29 is genuinely valid and
  // must still be accepted.
  it("DATE rejects a rollover date (2025-02-29, not a leap year) but accepts a real leap day", async () => {
    const { partId } = await fixture();
    const { id: fieldId } = await asSystem(() =>
      createPartFieldDef({ name: "Heat date", type: "DATE", sort: 0 }));
    await expect(asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "2025-02-29" }])))
      .rejects.toThrow("is not a valid date");
    await asSystem(() => setPartFieldValues(partId, [{ fieldId, value: "2024-02-29" }]));
    expect((await listPartFieldValues(partId)).find((r) => r.fieldId === fieldId)!.value).toBe("2024-02-29");
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

  it("listing values for a soft-deleted part is a 404", async () => {
    const { partId } = await fixture();
    await asSystem(() => deletePart(partId, "cleanup"));
    await expect(asSystem(() => listPartFieldValues(partId))).rejects.toThrow("Part not found");
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
