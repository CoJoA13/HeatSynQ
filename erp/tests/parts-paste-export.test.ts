import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { pasteParts, listParts } from "@/server/parts";
import { PART_PASTE_COLUMNS } from "@/lib/part-constants";
import { GET as exportRoute } from "@/app/api/parts/export/route";
import { POST as pasteRoute } from "@/app/api/parts/paste/route";

const noParams = { params: Promise.resolve({}) };

type Cell = (typeof PART_PASTE_COLUMNS)[number];

/** Builds one TSV row in PART_PASTE_COLUMNS order, defaulting every unspecified cell to "". */
function tsvRow(vals: Partial<Record<Cell, string>>): string {
  return PART_PASTE_COLUMNS.map((c) => vals[c] ?? "").join("\t");
}

async function acme() {
  return prisma.customer.create({ data: { code: "ACME", name: "Acme Foundry" } });
}

async function beta() {
  return prisma.customer.create({ data: { code: "BETA", name: "Beta Co" } });
}

async function ductileIron() {
  return prisma.material.create({ data: { name: "Ductile iron" } });
}

describe("parts paste and export", () => {
  beforeEach(async () => await truncateAll());

  it("pastes rows resolving customer by code and material by name", async () => {
    await acme();
    await ductileIron();
    const text = [
      tsvRow({ customerCode: "ACME", partNumber: "100", name: "Widget", materialName: "Ductile iron", eachWeight: "2.5" }),
      tsvRow({ customerCode: "ACME", partNumber: "200", materialName: "Ductile iron", eachWeight: "1" }),
    ].join("\n");

    const result = await pasteParts(text);
    expect(result.errors).toEqual([]);
    expect(result.created).toBe(2);

    const rows = await listParts();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.materialName).toBe("Ductile iron");
    expect(rows.map((r) => r.partNumber).sort()).toEqual(["100", "200"]);
  });

  it("unknown customer code and unknown material are per-row errors", async () => {
    await acme();
    await ductileIron();
    const text = [
      tsvRow({ customerCode: "ZZZ", partNumber: "1", eachWeight: "1" }),
      tsvRow({ customerCode: "ACME", partNumber: "2", eachWeight: "1", materialName: "Unobtainium" }),
    ].join("\n");

    const result = await pasteParts(text);
    expect(result.created).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].message).toMatch(/Customer "ZZZ" does not exist/);
    expect(result.errors[1].message).toMatch(/Material "Unobtainium" does not exist/);
  });

  it("serialization accepts yes/no (case-insensitive), errors otherwise", async () => {
    await acme();
    const text = [
      tsvRow({ customerCode: "ACME", partNumber: "S1", eachWeight: "1", serializationRequired: "YES" }),
      tsvRow({ customerCode: "ACME", partNumber: "S2", eachWeight: "1", serializationRequired: "no" }),
      tsvRow({ customerCode: "ACME", partNumber: "S3", eachWeight: "1", serializationRequired: "maybe" }),
    ].join("\n");

    const result = await pasteParts(text);
    expect(result.created).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/must be Yes or No/i);

    const rows = await listParts();
    const s1 = rows.find((r) => r.partNumber === "S1")!;
    const s2 = rows.find((r) => r.partNumber === "S2")!;
    expect(s1.serializationRequired).toBe(true);
    expect(s2.serializationRequired).toBe(false);
  });

  it("one bad row does not discard the rest; blank rows skipped; row numbers are 1-based lines", async () => {
    await acme();
    await beta();
    const text = [
      tsvRow({ customerCode: "ACME", partNumber: "A1", eachWeight: "1" }),
      tsvRow({ customerCode: "ZZZP", partNumber: "A2", eachWeight: "1" }),
      "",
      tsvRow({ customerCode: "BETA", partNumber: "B1", eachWeight: "1" }),
    ].join("\n");

    const result = await pasteParts(text);
    expect(result.created).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(2);
    expect(result.errors[0].message).toMatch(/Customer "ZZZP" does not exist/);
    expect((await listParts()).map((r) => r.partNumber).sort()).toEqual(["A1", "B1"]);
  });

  it("eachWeight ≤ 0 is a per-row error", async () => {
    await acme();
    const text = tsvRow({ customerCode: "ACME", partNumber: "Z1", eachWeight: "0" });

    const result = await pasteParts(text);
    expect(result.created).toBe(0);
    expect(result.errors[0].message).toMatch(/greater than zero/i);
  });

  it("export writes names not cuids and includes Active", async () => {
    const customer = await acme();
    const material = await ductileIron();
    await pasteParts(tsvRow({
      customerCode: "ACME", partNumber: "E1", eachWeight: "1", materialName: "Ductile iron",
    }));

    const anon = await exportRoute(new Request("http://t/api/parts/export"), noParams);
    expect(anon.status).toBe(401);

    const wrong = await signInWith(["customers.view"], "export-wrong-1");
    const denied = await exportRoute(new Request("http://t/api/parts/export", { headers: { cookie: wrong } }), noParams);
    expect(denied.status).toBe(403);

    const cookie = await signInWith(["parts.view"]);
    const res = await exportRoute(new Request("http://t/api/parts/export", { headers: { cookie } }), noParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/Parts\.xlsx/);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Parts")!;
    expect(sheet.getRow(1).values).toEqual([
      undefined,
      "Customer code", "Customer name", "Part number", "Name", "Description", "Process name",
      "Material", "Each wt", "Load qty", "Load wt", "Request days override", "Serialization", "Active",
    ]);
    const dataRow = sheet.getRow(2).values as ExcelJS.CellValue[];
    expect(dataRow).toContain("Ductile iron");
    expect(dataRow).not.toContain(customer.id);
    expect(dataRow).not.toContain(material.id);
    expect(dataRow).toContain("yes"); // Active
  });

  // Phase 7 Task 15: processName (spec §5.7 ruling 4) joins BOTH the paste-accepted columns and
  // the export columns, in the same relative position (after Description) — so a part pasted with
  // a process name survives export → edit → paste back. Do not let export emit a column paste
  // rejects (the HANDOFF "Export/paste round-trip" contract).
  it("paste accepts processName, and it round-trips out through export", async () => {
    await acme();
    expect(PART_PASTE_COLUMNS).toContain("processName");

    const result = await pasteParts(tsvRow({
      customerCode: "ACME", partNumber: "P1", eachWeight: "1", processName: "Austemper",
    }));
    expect(result.errors).toEqual([]);
    expect(result.created).toBe(1);

    const rows = await listParts();
    expect(rows.find((r) => r.partNumber === "P1")!.processName).toBe("Austemper");

    const cookie = await signInWith(["parts.view"], "pn-export");
    const res = await exportRoute(new Request("http://t/api/parts/export", { headers: { cookie } }), noParams);
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Parts")!;
    // "Process name" is column 6 (1-based, after Description); ExcelJS row.values is 1-based with
    // a leading undefined, so the header sits at index 6 and the value at the same index.
    expect((sheet.getRow(1).values as ExcelJS.CellValue[])[6]).toBe("Process name");
    expect((sheet.getRow(2).values as ExcelJS.CellValue[])[6]).toBe("Austemper");
  });

  // Phase 5A removed pricing from the paste contract entirely (design spec §4.1) — price rows
  // are keyed per process step code and edited on their own grid — so the route's only gate is
  // parts.create, and change_prices no longer has anything to say about a paste.
  it("paste route: parts.create required", async () => {
    await acme();
    const body = JSON.stringify({ text: tsvRow({ customerCode: "ACME", partNumber: "R1", eachWeight: "1" }) });

    const anon = await pasteRoute(new Request("http://t/api/parts/paste", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }), noParams);
    expect(anon.status).toBe(401);

    const viewer = await signInWith(["parts.view"], "viewer");
    const denied = await pasteRoute(new Request("http://t/api/parts/paste", {
      method: "POST", headers: { cookie: viewer, "content-type": "application/json" }, body,
    }), noParams);
    expect(denied.status).toBe(403);

    const creator = await signInWith(["parts.create"], "creator");
    const res = await pasteRoute(new Request("http://t/api/parts/paste", {
      method: "POST", headers: { cookie: creator, "content-type": "application/json" }, body,
    }), noParams);
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.errors).toEqual([]);
    expect(result.created).toBe(1);
  });
});
