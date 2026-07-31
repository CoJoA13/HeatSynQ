import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { createCustomer } from "@/server/customers";
import { listAddresses, addAddress, updateAddress, deleteAddress } from "@/server/customer-addresses";
import { listContacts, addContact, updateContact, deleteContact } from "@/server/customer-contacts";
import * as audit from "@/server/audit";
const { readAudit } = audit;

async function customer() {
  return (await createCustomer({ code: "ACME", name: "Acme" })).id;
}

describe("customer addresses", () => {
  beforeEach(async () => await truncateAll());

  it("adds typed addresses and lists them by kind then name", async () => {
    const id = await customer();
    await addAddress(id, { kind: "BILL_TO", name: "Accounts Payable", street: "1 Mill Rd" });
    await addAddress(id, { kind: "SHIP_TO", name: "Dock 2" });
    const rows = await listAddresses(id);
    expect(rows.map((a) => `${a.kind}:${a.name}`)).toEqual(["SHIP_TO:Dock 2", "BILL_TO:Accounts Payable"]);
  });

  it("makes the first address of a kind the default automatically", async () => {
    const id = await customer();
    const { id: first } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 1" });
    expect((await listAddresses(id)).find((a) => a.id === first)?.isDefault).toBe(true);
  });

  it("promoting a new default demotes the previous one of that kind only", async () => {
    const id = await customer();
    const { id: ship1 } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 1" });
    const { id: bill } = await addAddress(id, { kind: "BILL_TO", name: "AP" });
    const { id: ship2 } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 2", isDefault: true });
    const rows = await listAddresses(id);
    const by = (x: string) => rows.find((a) => a.id === x)!;
    expect(by(ship2).isDefault).toBe(true);
    expect(by(ship1).isDefault).toBe(false);
    expect(by(bill).isDefault).toBe(true); // a different kind keeps its own default
  });

  it("rejects an unknown kind and an unknown field", async () => {
    const id = await customer();
    await expect(addAddress(id, { kind: "WAREHOUSE", name: "x" })).rejects.toThrow();
    await expect(addAddress(id, { kind: "SHIP_TO", name: "x", bogus: 1 })).rejects.toThrow();
  });

  it("404s when the customer does not exist", async () => {
    await expect(addAddress("nope", { kind: "SHIP_TO", name: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("soft deletes and audits as its own entity", async () => {
    const id = await customer();
    const { id: addr } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 1" });
    await updateAddress(addr, { city: "Toledo" });
    await deleteAddress(addr);
    expect(await listAddresses(id)).toHaveLength(0);
    expect(await prisma.customerAddress.findUnique({ where: { id: addr } })).not.toBeNull();
    const entries = await readAudit("customerAddress", addr);
    expect(entries.map((e) => e.action)).toEqual(["delete", "update", "create"]);
  });

  it("update audit diff reflects the committed change, not the pre-transaction state", async () => {
    // Regression for Fix 1 (final review): updateAddress runs inside prisma.$transaction, and
    // auditedUpdate used to take its before/after snapshots on the untransacted top-level client,
    // so `after` was read before the transaction committed and came back identical to `before`.
    const id = await customer();
    const { id: addr } = await addAddress(id, { kind: "SHIP_TO", name: "Dock A", city: "Toledo" });
    await updateAddress(addr, { name: "Dock B", city: "Cleveland" });
    const [entry] = await readAudit("customerAddress", addr);
    const before = entry.before as { name: string; city: string };
    const after = entry.after as { name: string; city: string };
    expect(before).not.toEqual(after);
    expect(before).toMatchObject({ name: "Dock A", city: "Toledo" });
    expect(after).toMatchObject({ name: "Dock B", city: "Cleveland" });
  });

  it("promotes a remaining address when the default is deleted", async () => {
    const id = await customer();
    const { id: first } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 1" });
    const { id: second } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 2" });
    await deleteAddress(first);
    expect((await listAddresses(id)).find((a) => a.id === second)?.isDefault).toBe(true);
  });

  it("changing kind on a default promotes a new default in the old kind and resolves duplicates in the new kind", async () => {
    const id = await customer();
    const { id: ship1 } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 1" }); // default
    const { id: ship2 } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 2" });
    await addAddress(id, { kind: "BILL_TO", name: "AP" }); // default
    await updateAddress(ship1, { kind: "BILL_TO" });
    const rows = await listAddresses(id);
    const shipDefaults = rows.filter((r) => r.kind === "SHIP_TO" && r.isDefault);
    const billDefaults = rows.filter((r) => r.kind === "BILL_TO" && r.isDefault);
    expect(shipDefaults.map((r) => r.id)).toEqual([ship2]);
    expect(billDefaults).toHaveLength(1);
  });

  it("clearing isDefault on the sole default of a kind re-promotes it", async () => {
    const id = await customer();
    const { id: first } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 1" }); // default
    await updateAddress(first, { isDefault: false });
    const shipDefaults = (await listAddresses(id)).filter((r) => r.kind === "SHIP_TO" && r.isDefault);
    expect(shipDefaults.map((r) => r.id)).toEqual([first]);
  });

  it("deactivating the default promotes the remaining active address", async () => {
    const id = await customer();
    const { id: first } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 1" }); // default
    const { id: second } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 2" });
    await updateAddress(first, { active: false });
    const rows = await listAddresses(id, { includeInactive: true });
    const by = (x: string) => rows.find((a) => a.id === x)!;
    expect(by(second).isDefault).toBe(true);
    expect(by(first).isDefault).toBe(false);
  });

  it("reactivating an address after its default was deleted recovers the default", async () => {
    const id = await customer();
    const { id: first } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 1" }); // default
    const { id: second } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 2" });
    await updateAddress(second, { active: false }); // only "first" is active now, still default
    await deleteAddress(first); // deletes the default; the only remaining address is inactive
    await updateAddress(second, { active: true });
    const rows = await listAddresses(id);
    expect(rows.find((a) => a.id === second)?.isDefault).toBe(true);
  });

  // Group B1: normalization writes (demoteAllIn/normalizeDefaultsIn) used to write with bare
  // updateMany/update calls that never went through the audited* helpers, so a demoted address's
  // history kept claiming isDefault: true forever after it was actually demoted.
  it("routes the demotion caused by promoting a different address through the audit helpers", async () => {
    const id = await customer();
    const { id: first } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 1" }); // auto-default
    await addAddress(id, { kind: "SHIP_TO", name: "Dock 2", isDefault: true }); // demotes Dock 1

    const actual = await prisma.customerAddress.findUnique({ where: { id: first } });
    expect(actual?.isDefault).toBe(false);

    const [entry] = await readAudit("customerAddress", first);
    expect(entry.action).toBe("update");
    expect((entry.after as { isDefault: boolean }).isDefault).toBe(false);
  });

  // Group B1, second half: a normalization that runs after an explicit auditedUpdate (inside the
  // same transaction) must not leave that update's own "after" snapshot disagreeing with what
  // actually got committed to the row.
  it("an update whose own row gets renormalized still has an after-snapshot matching the committed row", async () => {
    const id = await customer();
    const { id: ship1 } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 1" }); // default
    await addAddress(id, { kind: "SHIP_TO", name: "Dock 2" });
    await addAddress(id, { kind: "BILL_TO", name: "AP" }); // default of BILL_TO

    // Move ship1 (currently the SHIP_TO default) into BILL_TO, which already has a default.
    // Nothing here sets isDefault explicitly, so the primary write leaves it untouched — the
    // *normalization* is what has to resolve the resulting two-defaults-in-BILL_TO conflict.
    await updateAddress(ship1, { kind: "BILL_TO" });

    const actual = await prisma.customerAddress.findUnique({ where: { id: ship1 } });
    const [entry] = await readAudit("customerAddress", ship1);
    expect((entry.after as { isDefault: boolean }).isDefault).toBe(actual?.isDefault);
  });

  // Group C3: deleteAddress's soft delete and its re-normalization used to be two sequential
  // top-level operations. If normalization failed after the delete had already committed on its
  // own, the delete would stick while the kind was left with active addresses and no default.
  // Fusing them into one transaction means a normalization failure must roll the delete back too.
  it("rolls the soft delete back if the fused normalization fails", async () => {
    const id = await customer();
    const { id: first } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 1" }); // default
    await addAddress(id, { kind: "SHIP_TO", name: "Dock 2" }); // promotion candidate on delete

    // normalizeDefaultsIn promotes "Dock 2" through setDefault -> auditedUpdate; force that
    // specific write to fail so the transaction aborts after the soft delete already ran.
    const spy = vi.spyOn(audit, "auditedUpdate").mockRejectedValueOnce(new Error("boom"));
    try {
      await expect(deleteAddress(first)).rejects.toThrow("boom");
    } finally {
      spy.mockRestore();
    }

    const row = await prisma.customerAddress.findUnique({ where: { id: first } });
    expect(row?.deletedAt).toBeNull();
  });
});

describe("customer contacts", () => {
  beforeEach(async () => await truncateAll());

  it("adds contacts with per-document flags, defaulting them off", async () => {
    const id = await customer();
    await addContact(id, { name: "Dana Reed", email: "dana@acme.test", getsInvoices: true });
    const [c] = await listContacts(id);
    expect(c).toMatchObject({
      name: "Dana Reed", email: "dana@acme.test",
      getsInvoices: true, getsShippers: false, getsStatements: false, getsCerts: false,
    });
  });

  it("requires a name and rejects a malformed email", async () => {
    const id = await customer();
    await expect(addContact(id, { email: "x@y.test" })).rejects.toThrow();
    await expect(addContact(id, { name: "X", email: "not-an-email" })).rejects.toThrow();
  });

  it("accepts a blank email — phone-only contacts are normal", async () => {
    const id = await customer();
    await addContact(id, { name: "Shop Phone", phone: "555-0100" });
    expect((await listContacts(id))[0].email).toBe("");
  });

  it("rejects an unknown field", async () => {
    const id = await customer();
    await expect(addContact(id, { name: "X", bogus: 1 })).rejects.toThrow();
  });

  it("404s when the customer does not exist", async () => {
    await expect(addContact("nope", { name: "X" })).rejects.toMatchObject({ status: 404 });
  });

  it("soft deletes and audits as its own entity", async () => {
    const id = await customer();
    const { id: contact } = await addContact(id, { name: "Dana" });
    await updateContact(contact, { getsCerts: true });
    await deleteContact(contact);
    expect(await listContacts(id)).toHaveLength(0);
    expect(await prisma.customerContact.findUnique({ where: { id: contact } })).not.toBeNull();
    expect((await readAudit("customerContact", contact)).map((e) => e.action))
      .toEqual(["delete", "update", "create"]);
  });

  it("update audit diff reflects the committed change", async () => {
    // Content coverage alongside the address regression above — customer-children.test.ts
    // previously asserted only the sequence of audit actions, never their content, for either
    // child entity.
    const id = await customer();
    const { id: contact } = await addContact(id, { name: "Dana", phone: "555-0100" });
    await updateContact(contact, { name: "Dana Reed", phone: "555-0199" });
    const [entry] = await readAudit("customerContact", contact);
    const before = entry.before as { name: string; phone: string };
    const after = entry.after as { name: string; phone: string };
    expect(before).not.toEqual(after);
    expect(before).toMatchObject({ name: "Dana", phone: "555-0100" });
    expect(after).toMatchObject({ name: "Dana Reed", phone: "555-0199" });
  });

  it("rejects whitespace-only names", async () => {
    const id = await customer();
    await expect(addContact(id, { name: "   " })).rejects.toThrow();
  });

  it("stores names trimmed", async () => {
    const id = await customer();
    await addContact(id, { name: "  Dana Reed  " });
    const [c] = await listContacts(id);
    expect(c.name).toBe("Dana Reed");
  });

  it("partial updates preserve untouched flags", async () => {
    const id = await customer();
    const { id: contact } = await addContact(id, {
      name: "Dana",
      getsInvoices: true,
      getsStatements: true,
    });
    await updateContact(contact, { phone: "555-0100" });
    const [c] = await listContacts(id);
    expect(c).toMatchObject({
      getsInvoices: true,
      getsStatements: true,
      getsShippers: false,
      getsCerts: false,
    });
  });
});
