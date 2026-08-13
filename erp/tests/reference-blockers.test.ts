import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { truncateAll, prisma } from "./helpers/db";
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

  // The label is a registry concern, not a findBlockers concern (final-branch-review item 3):
  // findBlockers used to branch on `link.model === "processStepCode"` to build "code — name",
  // which made findBlockers itself a second place every future linking model had to edit. Now
  // the formatting lives on the registry entry's `displayName`, and this asserts the exact
  // string (not just stringContaining, as above) to lock the rendered format down.
  it("uses the registry's displayName to format a blocker's label", async () => {
    const gl = await createReference("glAccount", { name: "4020" });
    const code = await createStepCode({ code: "HT-02", name: "Quench", glAccountId: gl.id });

    expect(await findBlockers("glAccount", gl.id)).toEqual([
      { entityLabel: "Process step code", name: "HT-02 — Quench", id: code.id, href: null },
    ]);
  });

  // Links with no displayName (every registered link except processStepCode) fall back to the
  // row's plain `name` — proven above by the Customer/Terms blocker test, which asserts
  // `name: "Acme Foundry"` with no prefix.

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

  // F1: findBlockers and the soft delete it guards now run inside one Serializable transaction
  // (see reference.ts's deleteReference). A genuine concurrency test isn't practical against a
  // single test DB connection, so this locks down the one thing that IS testable here: the
  // happy path — refuse-when-referenced, delete-when-not — is unchanged by the transaction wrap.
  it("still refuses a referenced row and still deletes an unreferenced one, now inside one transaction", async () => {
    const free = await createReference("terms", { name: "Unreferenced" });
    await expect(deleteReference("terms", free.id)).resolves.toBeUndefined();
    expect((await listReference("terms")).map((r) => r.id)).not.toContain(free.id);

    const used = await createReference("terms", { name: "Still used" });
    await createCustomer({ code: "TXN1", name: "Txn Co", termsId: used.id });
    await expect(deleteReference("terms", used.id)).rejects.toThrow(/still (in use|used)/i);
    expect((await listReference("terms")).map((r) => r.id)).toContain(used.id);
  });

  // Locks down the new optional third parameter's contract: a caller-supplied transaction client
  // is honored rather than findBlockers silently falling back to the top-level `prisma` client.
  it("findBlockers accepts an explicit transaction client", async () => {
    const terms = await createReference("terms", { name: "Net 30" });
    const c = await createCustomer({ code: "ACME3", name: "Acme Three", termsId: terms.id });

    const blockers = await prisma.$transaction((tx) => findBlockers("terms", terms.id, tx));
    expect(blockers).toEqual([
      { entityLabel: "Customer", name: "Acme Three", id: c.id, href: `/customers/${c.id}` },
    ]);
  });

  // Task 7 (Phase 6): behavioral verification of the `quote.endingStatementId` registry entry
  // Task 1 registered — `endingStatement` is a genuine ReferenceKind (ruling 13), so its guarded
  // delete path is the generic deleteReference above, with no quote-side code at all. Quote holds
  // the FK itself, so `liveWhere` stays the default `{ deletedAt: null }`.
  it("a live quote blocks its ending statement's deletion, named the Quote way; a deleted quote "
    + "does not, and the statement then deletes", async () => {
    const statement = await createReference("endingStatement", { name: "Standard", text: "Thanks." });
    const customer = await prisma.customer.create({ data: { code: "QAC", name: "Quote Acme" } });
    const user = await prisma.user.create({
      data: { username: "quoter-ref", passwordHash: "x", displayName: "Quoter" } });
    const quote = await prisma.quote.create({ data: {
      quoteNumber: 1000, customerId: customer.id, quotedById: user.id,
      endingStatementId: statement.id,
      quoteDate: new Date("2026-08-01"), effectiveDate: new Date("2026-08-01"),
      expiryDate: new Date("2026-08-31"),
    } });

    expect(await findBlockers("endingStatement", statement.id)).toEqual([
      { entityLabel: "Quote", name: "Quote · #1000", id: quote.id, href: `/quotes/${quote.id}` },
    ]);
    await expect(deleteReference("endingStatement", statement.id))
      .rejects.toThrow("still in use by 1 record(s)");
    // Refused, not allowed-and-cleared: the quote keeps its statement.
    expect((await listReference("endingStatement")).map((r) => r.id)).toContain(statement.id);

    // A deleted quote keeps its endingStatementId forever, but blocks nothing from the grave.
    await prisma.quote.update({ where: { id: quote.id }, data: { deletedAt: new Date() } });
    expect(await findBlockers("endingStatement", statement.id)).toEqual([]);
    await expect(deleteReference("endingStatement", statement.id)).resolves.toBeUndefined();
    expect((await listReference("endingStatement")).map((r) => r.id)).not.toContain(statement.id);
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
