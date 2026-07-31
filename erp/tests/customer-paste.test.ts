import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { createCustomer, listCustomers, pasteCustomers } from "@/server/customers";
import { GET as exportRoute } from "@/app/api/customers/export/route";
import { POST as pasteRoute } from "@/app/api/customers/paste/route";

const noParams = { params: Promise.resolve({}) };

describe("customer paste", () => {
  beforeEach(async () => await truncateAll());

  it("creates every valid row and reports failures by 1-based line", async () => {
    await createCustomer({ code: "ACME", name: "Acme" });
    const result = await pasteCustomers("ACME\tDup Co\nBETA\tBeta Castings\n\n\tNo code");
    expect(result.created).toBe(1);
    expect(result.errors.map((e) => e.row)).toEqual([1, 4]);
    expect(result.errors[0].message).toMatch(/already exists/i);
    expect((await listCustomers()).map((c) => c.code)).toEqual(["ACME", "BETA"]);
  });

  it("handles Excel quoting the same way reference paste does", async () => {
    const r = await pasteCustomers('ACME\t"Acme ""Heat Treat"" Inc"\t\t"line one\nline two"');
    expect(r.errors).toEqual([]);
    const [c] = await listCustomers();
    expect(c.name).toBe('Acme "Heat Treat" Inc');
    expect(c.orderNotes).toBe("line one\nline two");
  });

  it("tolerates a trailing tab but rejects genuine extra columns", async () => {
    expect((await pasteCustomers("ACME\tAcme\t\t\t")).errors).toEqual([]);
    await truncateAll();
    const r = await pasteCustomers("BETA\tBeta\t\t\tEXTRA");
    expect(r.created).toBe(0);
    expect(r.errors[0].message).toMatch(/Too many columns/);
  });

  it("exports a real workbook whose header matches the paste columns", async () => {
    const cookie = await signInWith(["customers.view"]);
    await createCustomer({ code: "ACME", name: "Acme Foundry" });
    const res = await exportRoute(new Request("http://t/api/customers/export", { headers: { cookie } }), noParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/Customers\.xlsx/);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Customers")!;
    expect(sheet.getRow(1).values).toEqual([undefined, "Code", "Name", "Default PO", "Order notes", "Active"]);
    expect((sheet.getRow(2).values as ExcelJS.CellValue[])[1]).toBe("ACME");
  });

  it("401s and 403s on both routes", async () => {
    expect((await exportRoute(new Request("http://t/api/customers/export"), noParams)).status).toBe(401);
    const viewer = await signInWith(["customers.view"]);
    const denied = await pasteRoute(new Request("http://t/api/customers/paste", {
      method: "POST", headers: { cookie: viewer, "content-type": "application/json" },
      body: JSON.stringify({ text: "ACME\tAcme" }),
    }), noParams);
    expect(denied.status).toBe(403);
  });
});
