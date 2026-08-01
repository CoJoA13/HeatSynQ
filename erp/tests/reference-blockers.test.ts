import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { createReference, deleteReference, listReference } from "@/server/reference";
import { createCustomer, deleteCustomer } from "@/server/customers";
import { createStepCode } from "@/server/process-step-codes";
import { findBlockers } from "@/server/reference-blockers";
import { HttpError } from "@/server/errors";

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
});
