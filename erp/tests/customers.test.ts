import { describe, it, expect, beforeEach } from "vitest";
import { ZodError } from "zod";
import { prisma, truncateAll } from "./helpers/db";
import {
  listCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer,
} from "@/server/customers";
import { addAddress, listAddresses } from "@/server/customer-addresses";
import { addContact, listContacts } from "@/server/customer-contacts";
import { readAudit } from "@/server/audit";
import { HttpError } from "@/server/errors";

describe("customers service", () => {
  beforeEach(async () => await truncateAll());

  it("creates and lists by code", async () => {
    await createCustomer({ code: "BETA", name: "Beta Co" });
    await createCustomer({ code: "ACME", name: "Acme Foundry" });
    expect((await listCustomers()).map((c) => c.code)).toEqual(["ACME", "BETA"]);
  });

  it("requires both code and name", async () => {
    await expect(createCustomer({ code: "X" })).rejects.toThrow();
    await expect(createCustomer({ name: "No code" })).rejects.toThrow();
  });

  it("rejects a whitespace-only code", async () => {
    await expect(createCustomer({ code: "   ", name: "Acme" })).rejects.toThrow();
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    await expect(updateCustomer(id, { code: "   " })).rejects.toThrow();
  });

  it("rejects a whitespace-only name", async () => {
    await expect(createCustomer({ code: "ACME", name: "   " })).rejects.toThrow();
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    await expect(updateCustomer(id, { name: "   " })).rejects.toThrow();
  });

  it("rejects a duplicate code and an unknown field", async () => {
    await createCustomer({ code: "ACME", name: "Acme" });
    await expect(createCustomer({ code: "ACME", name: "Other" })).rejects.toThrow(HttpError);
    await expect(createCustomer({ code: "NEW", name: "N", bogus: 1 })).rejects.toThrow();
  });

  it("revives a soft-deleted code and brings it back active", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    await updateCustomer(id, { active: false });
    await deleteCustomer(id);
    const again = await createCustomer({ code: "ACME", name: "Acme Reborn" });
    expect(again.id).toBe(id);
    const rows = await listCustomers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: "ACME", name: "Acme Reborn", active: true });
  });

  it("stores the Phase 5 commercial fields and returns decimals as numbers", async () => {
    const terms = await prisma.terms.create({ data: { name: "Net 30" } });
    const { id } = await createCustomer({
      code: "ACME", name: "Acme", termsId: terms.id, creditLimit: "25000.00",
      creditHold: true, cod: false, taxable: false, defaultPo: "BLANKET-7",
      orderNotes: "call before shipping", surchargeOptOut: true, financeChargeRate: "0.015",
    });
    const c = await getCustomer(id);
    expect(c.creditLimit).toBe(25000);
    expect(c.financeChargeRate).toBe(0.015);
    expect(c).toMatchObject({ creditHold: true, taxable: false, defaultPo: "BLANKET-7", surchargeOptOut: true });
  });

  it("links a parent and exposes its code for display", async () => {
    const parent = await createCustomer({ code: "ACME", name: "Acme Corp" });
    const child = await createCustomer({ code: "ACME-OH", name: "Acme Ohio", parentId: parent.id });
    expect((await getCustomer(child.id)).parentCode).toBe("ACME");
  });

  it("refuses to make a customer its own ancestor", async () => {
    const a = await createCustomer({ code: "A", name: "A" });
    const b = await createCustomer({ code: "B", name: "B", parentId: a.id });
    await expect(updateCustomer(a.id, { parentId: b.id })).rejects.toThrow(/circular|ancestor|itself/i);
    await expect(updateCustomer(a.id, { parentId: a.id })).rejects.toThrow(/circular|ancestor|itself/i);
  });

  it("refuses to delete a customer that still has non-deleted children", async () => {
    const parent = await createCustomer({ code: "ACME", name: "Acme" });
    const child = await createCustomer({ code: "ACME-OH", name: "Ohio", parentId: parent.id });
    await expect(deleteCustomer(parent.id)).rejects.toThrow(/child/i);
    await deleteCustomer(child.id);
    await deleteCustomer(parent.id);
    expect(await listCustomers()).toHaveLength(0);
  });

  it("searches on code and name", async () => {
    await createCustomer({ code: "ACME", name: "Acme Foundry" });
    await createCustomer({ code: "BETA", name: "Beta Castings" });
    expect((await listCustomers({ search: "acm" })).map((c) => c.code)).toEqual(["ACME"]);
    expect((await listCustomers({ search: "castings" })).map((c) => c.code)).toEqual(["BETA"]);
  });

  it("hides inactive unless asked, and soft delete leaves the row", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    await updateCustomer(id, { active: false });
    expect(await listCustomers()).toHaveLength(0);
    expect(await listCustomers({ includeInactive: true })).toHaveLength(1);
    await deleteCustomer(id);
    expect(await listCustomers({ includeInactive: true })).toHaveLength(0);
    expect(await prisma.customer.findUnique({ where: { id } })).not.toBeNull();
  });

  it("audits create and update with a usable diff", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    await updateCustomer(id, { name: "Acme Foundry" });
    const entries = await readAudit("customer", id);
    expect(entries.map((e) => e.action)).toEqual(["update", "create"]);
    expect((entries[0].before as { name: string }).name).toBe("Acme");
    expect((entries[0].after as { name: string }).name).toBe("Acme Foundry");
  });

  it("404s on an unknown id", async () => {
    await expect(getCustomer("nope")).rejects.toMatchObject({ status: 404 });
    await expect(updateCustomer("nope", { name: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("deleting a customer soft-deletes its addresses and contacts, so a reused code does not resurrect them", async () => {
    // Fix 2 (final review): paste only ever supplies the four CUSTOMER_PASTE_COLUMNS and cannot
    // touch addresses, so a re-pasted deleted code must not silently ship to the previous
    // customer's dock or email their contact.
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    const { id: addressId } = await addAddress(id, { kind: "SHIP_TO", name: "Dock B" });
    const { id: contactId } = await addContact(id, { name: "New Contact" });

    await deleteCustomer(id);

    // The old rows survive as soft-deleted, not hard-deleted.
    const oldAddress = await prisma.customerAddress.findUnique({ where: { id: addressId } });
    const oldContact = await prisma.customerContact.findUnique({ where: { id: contactId } });
    expect(oldAddress).not.toBeNull();
    expect(oldAddress?.deletedAt).toBeInstanceOf(Date);
    expect(oldContact).not.toBeNull();
    expect(oldContact?.deletedAt).toBeInstanceOf(Date);

    const revived = await createCustomer({ code: "ACME", name: "Brand New Co" });
    expect(revived.id).toBe(id);
    expect(await listAddresses(revived.id)).toHaveLength(0);
    expect(await listContacts(revived.id)).toHaveLength(0);
  });

  // Group B2: createCustomer skips assertNoCycle entirely, reasoning that a row that doesn't
  // exist yet cannot be in anyone's parent chain — true for a fresh create, false for the
  // revival path, where the row (and its id) already exists.
  it("guards against a cycle introduced by reviving a customer as its own parent", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    await deleteCustomer(id);
    await expect(createCustomer({ code: "ACME", name: "Acme Reborn", parentId: id }))
      .rejects.toThrow(/circular|ancestor/i);
  });

  // Group B3: the hierarchy walk resolves a requested parent with a bare findUnique, and a fresh
  // create relies only on the physical foreign key — both succeed against a soft-deleted parent
  // because soft deletion leaves the row present, producing an active child whose parent appears
  // in no customer list.
  it("refuses a soft-deleted customer as a parent on create", async () => {
    const { id: parentId } = await createCustomer({ code: "GONE", name: "Gone" });
    await deleteCustomer(parentId);
    await expect(createCustomer({ code: "NEW", name: "New", parentId }))
      .rejects.toThrow(/parent/i);
  });

  it("refuses a soft-deleted customer as a parent on update", async () => {
    const { id: parentId } = await createCustomer({ code: "GONE", name: "Gone" });
    const { id: childId } = await createCustomer({ code: "CHILD", name: "Child" });
    await deleteCustomer(parentId);
    await expect(updateCustomer(childId, { parentId })).rejects.toThrow(/parent/i);
  });

  it("refuses a soft-deleted customer as a parent on revival", async () => {
    const { id: parentId } = await createCustomer({ code: "GONE", name: "Gone" });
    await deleteCustomer(parentId);
    const { id: dupId } = await createCustomer({ code: "DUP", name: "Dup" });
    await deleteCustomer(dupId);
    await expect(createCustomer({ code: "DUP", name: "Dup Reborn", parentId }))
      .rejects.toThrow(/parent/i);
  });

  // Group C1: creditLimit/financeChargeRate accepted any string, so an invalid one sailed
  // through zod and blew up inside Prisma with a PrismaClientValidationError — which has no
  // HTTP status and escapes handle() as a bare 500 instead of a field-anchored 400.
  it("rejects a non-numeric decimal string as a validation error rather than a raw Prisma failure", async () => {
    await expect(createCustomer({ code: "X", name: "X", creditLimit: "not-a-number" }))
      .rejects.toBeInstanceOf(ZodError);
    await expect(createCustomer({ code: "Y", name: "Y", financeChargeRate: "abc" }))
      .rejects.toBeInstanceOf(ZodError);
  });

  it("accepts a decimal string or a plain number for the money fields", async () => {
    const { id } = await createCustomer({ code: "X", name: "X", creditLimit: "1234.56", financeChargeRate: 0.02 });
    const c = await getCustomer(id);
    expect(c.creditLimit).toBe(1234.56);
    expect(c.financeChargeRate).toBe(0.02);
  });

  it("revival resets every field a genuine create would default, not just active", async () => {
    const fresh = await createCustomer({ code: "FRESH", name: "Fresh Co" });
    const freshRow = await getCustomer(fresh.id);

    const { id } = await createCustomer({
      code: "ACME", name: "Acme", creditHold: true, taxable: false, surchargeOptOut: true,
      cod: true, defaultPo: "OLD-PO", orderNotes: "old notes", shippingNotes: "old ship notes",
      invoiceNotes: "old invoice notes", creditLimit: "9999.00", financeChargeRate: "0.02",
    });
    await deleteCustomer(id);

    const revived = await createCustomer({ code: "ACME", name: "Acme Reborn" });
    expect(revived.id).toBe(id);
    const revivedRow = await getCustomer(revived.id);

    const identityFields = ["id", "code", "name"] as const;
    const omitIdentity = (row: typeof freshRow) =>
      Object.fromEntries(Object.entries(row).filter(([k]) => !(identityFields as readonly string[]).includes(k)));
    expect(omitIdentity(revivedRow)).toEqual(omitIdentity(freshRow));
  });
});
