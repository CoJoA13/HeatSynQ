import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { truncateAll } from "./helpers/db";
import { createReference, deleteReference, listReference } from "@/server/reference";
import { createCustomer, deleteCustomer } from "@/server/customers";
import { createStepCode } from "@/server/process-step-codes";
import { findBlockers } from "@/server/reference-blockers";
import { HttpError } from "@/server/errors";
import { signInWith } from "./helpers/auth";
import { GET as blockersRoute } from "@/app/api/admin/reference/[kind]/[id]/blockers/route";
import { GET as blockersExportRoute } from "@/app/api/admin/reference/[kind]/[id]/blockers/export/route";

describe("reference delete guard", () => {
  beforeEach(async () => await truncateAll());

  it("refuses to delete a row something points at, and names what", async () => {
    const terms = await createReference("terms", { name: "Net 30" });
    await createCustomer({ code: "ACME", name: "Acme Foundry", termsId: terms.id });

    await expect(deleteReference("terms", terms.id)).rejects.toThrow(HttpError);
    await expect(deleteReference("terms", terms.id)).rejects.toThrow(/still (in use|used)/i);

    // The row survives — refused, not allowed-and-cleared, not allowed-and-dangled.
    expect((await listReference("terms")).map((r) => r.id)).toContain(terms.id);
  });

  it("lists each blocker with a link where a detail page exists", async () => {
    const terms = await createReference("terms", { name: "Net 30" });
    const c = await createCustomer({ code: "ACME", name: "Acme Foundry", termsId: terms.id });

    expect(await findBlockers("terms", terms.id)).toEqual([
      { entityLabel: "Customer", name: "Acme Foundry", id: c.id, href: `/customers/${c.id}` },
    ]);
  });

  it("gives no href for an entity with no detail page", async () => {
    const gl = await createReference("glAccount", { name: "4010" });
    const code = await createStepCode({ code: "HT-01", name: "Austenitize", glAccountId: gl.id });

    expect(await findBlockers("glAccount", gl.id)).toEqual([
      { entityLabel: "Process step code", name: expect.stringContaining("HT-01"), id: code.id, href: null },
    ]);
  });

  it("gathers blockers across every registered link, not just the first", async () => {
    const gl = await createReference("glAccount", { name: "4010" });
    await createStepCode({ code: "HT-01", name: "Austenitize", glAccountId: gl.id });
    await createReference("paymentType", { name: "Check", glAccountId: gl.id });

    const labels = (await findBlockers("glAccount", gl.id)).map((b) => b.entityLabel).sort();
    expect(labels).toEqual(["Payment type", "Process step code"]);
  });

  it("ignores soft-deleted blockers — a deleted customer must not block forever", async () => {
    const terms = await createReference("terms", { name: "Net 30" });
    const c = await createCustomer({ code: "ACME", name: "Acme", termsId: terms.id });
    await deleteCustomer(c.id, "closed the account");

    expect(await findBlockers("terms", terms.id)).toEqual([]);
    await expect(deleteReference("terms", terms.id)).resolves.toBeUndefined();
  });

  it("still deletes a row nothing points at — the guard must not obstruct a typo cleanup", async () => {
    const t = await createReference("terms", { name: "Typo" });
    await expect(deleteReference("terms", t.id)).resolves.toBeUndefined();
  });

  it("serves the blocker list to an admin and 403s a non-admin", async () => {
    const terms = await createReference("terms", { name: "Net 30" });
    await createCustomer({ code: "ACME", name: "Acme Foundry", termsId: terms.id });
    const ctx = { params: Promise.resolve({ kind: "terms", id: terms.id }) };

    // signInWith resolves to the session cookie itself (a plain string), not an object to
    // destructure — see tests/helpers/auth.ts.
    const admin = await signInWith(["admin.view"]);
    const ok = await blockersRoute(new Request("http://x", { headers: { cookie: admin } }), ctx);
    expect(ok.status).toBe(200);
    expect((await ok.json())[0].entityLabel).toBe("Customer");

    const nobody = await signInWith([], "nobody");
    const denied = await blockersRoute(new Request("http://x", { headers: { cookie: nobody } }),
                                       { params: Promise.resolve({ kind: "terms", id: terms.id }) });
    expect(denied.status).toBe(403);
  });

  it("exports the blocker list to Excel", async () => {
    const terms = await createReference("terms", { name: "Net 30" });
    await createCustomer({ code: "ACME", name: "Acme Foundry", termsId: terms.id });

    const cookie = await signInWith(["admin.view"]);
    const res = await blockersExportRoute(new Request("http://x", { headers: { cookie } }),
                                          { params: Promise.resolve({ kind: "terms", id: terms.id }) });
    expect(res.headers.get("content-type")).toContain("spreadsheetml");

    const wb = new ExcelJS.Workbook();
    // See tests/excel.test.ts: exceljs's own type declarations shadow the global `Buffer` with
    // a bare, module-local `interface Buffer extends ArrayBuffer {}` that Node's real Buffer no
    // longer structurally satisfies under this project's `lib: ["esnext"]`. The cast is only for
    // the type checker; the bytes are unchanged.
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
    const row = wb.getWorksheet(1)!.getRow(2).values as unknown[];
    expect(row).toContain("Customer");
    expect(row).toContain("Acme Foundry");
  });
});
