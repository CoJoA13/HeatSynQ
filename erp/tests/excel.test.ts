import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { truncateAll } from "./helpers/db";
import { toXlsx } from "@/server/excel";
import { createReference } from "@/server/reference";
import { GET as exportRoute } from "@/app/api/admin/reference/[kind]/export/route";
import { signInWith } from "./helpers/auth";

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

  it("the export route returns an xlsx content type and 401s without a session", async () => {
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
    expect(Buffer.from(await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});
