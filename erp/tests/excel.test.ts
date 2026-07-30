import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { truncateAll } from "./helpers/db";
import { toXlsx } from "@/server/excel";
import { createReference, updateReference } from "@/server/reference";
import { GET as exportRoute } from "@/app/api/admin/reference/[kind]/export/route";
import { signInWith } from "./helpers/auth";

/**
 * Parses a Response body back into a real workbook, proving the bytes that reached the wire
 * are a working .xlsx — not merely a non-empty buffer. Isolates the `Buffer`/`ArrayBuffer`
 * typing quirk (see the comment on the first test below) to one place.
 */
async function loadWorkbook(res: Response): Promise<ExcelJS.Workbook> {
  const bytes = Buffer.from(await res.arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  return wb;
}

describe("excel export", () => {
  beforeEach(async () => await truncateAll());

  it("produces a real workbook with a header row and the data", async () => {
    const buf = await toXlsx("GL accounts",
      [{ key: "name", header: "Account number" }, { key: "description", header: "Description" }],
      [{ name: "4010", description: "Heat Treat Revenue" }]);

    const wb = new ExcelJS.Workbook();
    // exceljs's own type declarations shadow the global `Buffer` with a bare, module-local
    // `interface Buffer extends ArrayBuffer {}` used only for this parameter's type — under
    // this project's `lib: ["esnext"]`, Node's real Buffer (a Uint8Array subclass, not an
    // ArrayBuffer) no longer structurally satisfies that shadowed interface's newer
    // resizable-ArrayBuffer members. The value itself is unchanged; only the type needs help.
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("GL accounts")!;
    expect(sheet.getRow(1).values).toEqual([undefined, "Account number", "Description"]);
    expect(sheet.getRow(2).values).toEqual([undefined, "4010", "Heat Treat Revenue"]);
  });

  it("the export route returns a parseable xlsx and 401s without a session", async () => {
    const ctx = { params: Promise.resolve({ kind: "glAccount" }) };
    const anon = await exportRoute(new Request("http://t/api/admin/reference/glAccount/export"), ctx);
    expect(anon.status).toBe(401);

    const cookie = await signInWith(["admin.view"]);
    await createReference("glAccount", { name: "4010", description: "Heat Treat Revenue" });
    const res = await exportRoute(
      new Request("http://t/api/admin/reference/glAccount/export", { headers: { cookie } }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/spreadsheetml/);
    expect(res.headers.get("content-disposition")).toMatch(/glAccount.*\.xlsx/);
    expect(Buffer.from(await res.clone().arrayBuffer()).byteLength).toBeGreaterThan(0);

    // Prove a genuinely working workbook reached the wire — the seam the brief warned about
    // (NextResponse + Uint8Array) — not merely that some bytes came back.
    const wb = await loadWorkbook(res);
    const sheet = wb.getWorksheet("GL accounts")!;
    expect(sheet.getRow(1).values).toEqual([undefined, "Account number", "Description", "Active"]);
    expect(sheet.getRow(2).values).toEqual([undefined, "4010", "Heat Treat Revenue", true]);
  });

  it("mirrors the on-screen includeInactive filter: omitted excludes inactive rows, ?includeInactive=1 includes them", async () => {
    const ctx = { params: Promise.resolve({ kind: "glAccount" }) };
    const cookie = await signInWith(["admin.view"]);
    await createReference("glAccount", { name: "4010", description: "Active account" });
    const inactiveRow = await createReference("glAccount", { name: "4030", description: "Also inactive" });
    await updateReference("glAccount", inactiveRow.id, { active: false });

    const withoutFlag = await loadWorkbook(await exportRoute(
      new Request("http://t/api/admin/reference/glAccount/export", { headers: { cookie } }), ctx));
    const namesWithoutFlag = withoutFlag.getWorksheet("GL accounts")!.getColumn(1).values.slice(2);
    expect(namesWithoutFlag).toEqual(["4010"]);
    expect(namesWithoutFlag).not.toContain("4030");

    const withFlag = await loadWorkbook(await exportRoute(
      new Request("http://t/api/admin/reference/glAccount/export?includeInactive=1", { headers: { cookie } }), ctx));
    const namesWithFlag = withFlag.getWorksheet("GL accounts")!.getColumn(1).values.slice(2);
    expect(namesWithFlag).toEqual(["4010", "4030"]);
  });
});
