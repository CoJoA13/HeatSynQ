import { describe, it, expect, beforeEach } from "vitest";
import { ZodError } from "zod";
import { prisma, truncateAll } from "./helpers/db";
import {
  listCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer,
} from "@/server/customers";
import { addAddress, listAddresses } from "@/server/customer-addresses";
import { addContact, listContacts } from "@/server/customer-contacts";
import { createPart } from "@/server/parts";
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

  it("re-creating a deleted code makes a NEW row with its own history, not a revival", async () => {
    const first = await createCustomer({
      code: "ACME", name: "Acme Original", creditHold: true, orderNotes: "old notes",
    });
    await deleteCustomer(first.id, "keyed by mistake");

    const second = await createCustomer({ code: "ACME", name: "Acme Industries" });

    // A new identity, not the dead row wearing a new name.
    expect(second.id).not.toBe(first.id);

    // Nothing of the predecessor leaks through.
    const row = await getCustomer(second.id);
    expect(row.name).toBe("Acme Industries");
    expect(row.creditHold).toBe(false);
    expect(row.orderNotes).toBe("");
    expect(row.active).toBe(true);

    // The audit trail says "create", and carries none of the predecessor's entries.
    expect((await readAudit("customer", second.id)).map((e) => e.action)).toEqual(["create"]);

    // And the archived row keeps its own value, its own id, and its own history.
    const archived = await prisma.customer.findUnique({ where: { id: first.id } });
    expect(archived?.code).toBe("ACME");
    expect(archived?.deletedAt).not.toBeNull();
    expect((await readAudit("customer", first.id)).map((e) => e.action).sort())
      .toEqual(["create", "delete"]);
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
    await expect(deleteCustomer(parent.id, "test cleanup")).rejects.toThrow(/child/i);
    await deleteCustomer(child.id, "test cleanup");
    await deleteCustomer(parent.id, "test cleanup");
    expect(await listCustomers()).toHaveLength(0);
  });

  // F1: the children/parts guard counts moved from bare `prisma` reads into the delete
  // transaction (on `tx`, Serializable) so a concurrent createPart can't slip a live part under a
  // customer this same instant found "childless and partless". This pins the functional behavior
  // — both guards still fire, in the same order (children before parts) — that the move must not
  // disturb, even though the race itself isn't something a sequential test can exercise.
  it("still refuses on both guards, in order, with the counts read inside the transaction", async () => {
    const parent = await createCustomer({ code: "ACME", name: "Acme" });
    await createCustomer({ code: "ACME-OH", name: "Ohio", parentId: parent.id });
    await createPart({ customerId: parent.id, partNumber: "12345", eachWeight: 1 });
    // Both guards would fire; the child guard must win, same as before the counts moved.
    await expect(deleteCustomer(parent.id, "test cleanup")).rejects.toThrow(/child/i);
    const row = await prisma.customer.findUnique({ where: { id: parent.id } });
    expect(row?.deletedAt).toBeNull();
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
    await deleteCustomer(id, "test cleanup");
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

    await deleteCustomer(id, "test cleanup");

    // The old rows survive as soft-deleted, not hard-deleted, still attached to the dead customer.
    const oldAddress = await prisma.customerAddress.findUnique({ where: { id: addressId } });
    const oldContact = await prisma.customerContact.findUnique({ where: { id: contactId } });
    expect(oldAddress).not.toBeNull();
    expect(oldAddress?.deletedAt).toBeInstanceOf(Date);
    expect(oldContact).not.toBeNull();
    expect(oldContact?.deletedAt).toBeInstanceOf(Date);

    // Re-using the code makes a brand new row (see createCustomer) — it starts with no
    // addresses or contacts of its own, and the dead customer's records stay behind under the
    // dead customer's own id.
    const reused = await createCustomer({ code: "ACME", name: "Brand New Co" });
    expect(reused.id).not.toBe(id);
    expect(await listAddresses(reused.id)).toHaveLength(0);
    expect(await listContacts(reused.id)).toHaveLength(0);
  });

  // Group B3: the hierarchy walk resolves a requested parent with a bare findUnique, and a fresh
  // create relies only on the physical foreign key — both succeed against a soft-deleted parent
  // because soft deletion leaves the row present, producing an active child whose parent appears
  // in no customer list.
  it("refuses a soft-deleted customer as a parent on create", async () => {
    const { id: parentId } = await createCustomer({ code: "GONE", name: "Gone" });
    await deleteCustomer(parentId, "test cleanup");
    await expect(createCustomer({ code: "NEW", name: "New", parentId }))
      .rejects.toThrow(/parent/i);
  });

  it("refuses a soft-deleted customer as a parent on update", async () => {
    const { id: parentId } = await createCustomer({ code: "GONE", name: "Gone" });
    const { id: childId } = await createCustomer({ code: "CHILD", name: "Child" });
    await deleteCustomer(parentId, "test cleanup");
    await expect(updateCustomer(childId, { parentId })).rejects.toThrow(/parent/i);
  });

  // Group B4 (round-4 review): termsId was validated as nothing but a string, so the physical
  // foreign key was the only check — and a soft-deleted Terms row is still physically present,
  // so it passed. The customer then held a termsId that every reference list filters out: the
  // detail page's Terms select renders blank (misrepresenting stored data, exactly like the
  // soft-deleted parent above) and Phase 5 billing would inherit a hidden terms record.
  it("refuses a soft-deleted terms record on create", async () => {
    const terms = await prisma.terms.create({ data: { name: "Net 30" } });
    await prisma.terms.update({ where: { id: terms.id }, data: { deletedAt: new Date() } });
    await expect(createCustomer({ code: "ACME", name: "Acme", termsId: terms.id }))
      .rejects.toThrow(/terms/i);
  });

  it("refuses a soft-deleted terms record on update", async () => {
    const terms = await prisma.terms.create({ data: { name: "Net 30" } });
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    await prisma.terms.update({ where: { id: terms.id }, data: { deletedAt: new Date() } });
    await expect(updateCustomer(id, { termsId: terms.id })).rejects.toThrow(/terms/i);
  });

  it("refuses a soft-deleted terms record on revival", async () => {
    const terms = await prisma.terms.create({ data: { name: "Net 30" } });
    await prisma.terms.update({ where: { id: terms.id }, data: { deletedAt: new Date() } });
    const { id } = await createCustomer({ code: "DUP", name: "Dup" });
    await deleteCustomer(id, "test cleanup");
    await expect(createCustomer({ code: "DUP", name: "Dup Reborn", termsId: terms.id }))
      .rejects.toThrow(/terms/i);
  });

  it("reports an unknown terms id as a field-anchored 400, not a raw foreign-key failure", async () => {
    await expect(createCustomer({ code: "ACME", name: "Acme", termsId: "not-a-real-id" }))
      .rejects.toThrow(/terms/i);
  });

  // An INACTIVE terms record is still assignable — inactive hides a row from the default pick
  // list, it does not retire the assignment. The detail page fetches includeInactive=1 and
  // labels such an option rather than dropping it (the same rule the parent selector follows).
  it("accepts an inactive terms record", async () => {
    const terms = await prisma.terms.create({ data: { name: "Net 30", active: false } });
    const { id } = await createCustomer({ code: "ACME", name: "Acme", termsId: terms.id });
    expect((await getCustomer(id)).termsId).toBe(terms.id);
  });

  // Group B5 (round-5 review): assertNoCycle read the parent chain outside any transaction, so
  // two concurrent updates setting A.parent = B and B.parent = A could each observe the other
  // row still parentless, both pass validation, and both commit — writing the exact cycle the
  // guard exists to prevent. Whichever request wins, the pair must never end up pointing at
  // each other.
  // Repeated because the interleaving is timing-dependent: against the unguarded code the cycle
  // formed on roughly one attempt in four, so a single attempt would let a regression through
  // three times out of four. Ten independent pairs make detection ~94% while staying
  // deterministic once the guard is in place.
  it("cannot form a reciprocal parent cycle from two concurrent updates", async () => {
    for (let i = 0; i < 10; i++) {
      const a = await createCustomer({ code: `A${i}`, name: `A${i}` });
      const b = await createCustomer({ code: `B${i}`, name: `B${i}` });
      await Promise.allSettled([
        updateCustomer(a.id, { parentId: b.id }),
        updateCustomer(b.id, { parentId: a.id }),
      ]);
      const [rowA, rowB] = await Promise.all([
        prisma.customer.findUnique({ where: { id: a.id }, select: { parentId: true } }),
        prisma.customer.findUnique({ where: { id: b.id }, select: { parentId: true } }),
      ]);
      expect(rowA?.parentId === b.id && rowB?.parentId === a.id, `cycle formed on attempt ${i}`).toBe(false);
    }
  });

  // Group B6 (round-6 review): spec §9 — "destructive-ish actions require a reason". The delete
  // wrote reason: null, leaving no way to tell a typo cleanup from an intentional removal in an
  // operation that also soft-deletes every address and contact and frees the code for reuse.
  it("requires a reason to delete a customer and records it on the audit entry", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    await expect(deleteCustomer(id, "")).rejects.toThrow(/reason/i);
    await expect(deleteCustomer(id, "   ")).rejects.toThrow(/reason/i);

    await deleteCustomer(id, "  keyed twice by mistake  ");
    const entries = await readAudit("customer", id);
    expect(entries[0].action).toBe("delete");
    // Trimmed, so a reason of pure whitespace can never masquerade as a real one.
    expect(entries[0].reason).toBe("keyed twice by mistake");
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

  // F1 (Phase 2B round-2 fix wave): the shared `money` validator checked that a value IS a
  // decimal but never that it FITS its column's precision/scale. financeChargeRate is
  // Decimal(6,4) (max 99.9999) — "100" sails past the old validator's generic bounds check and
  // blows up inside Prisma with a status-less error that escapes handle() as a bare 500 instead
  // of the field-anchored 400 spec S12 promises.
  it("rejects a finance charge rate that overflows Decimal(6,4) as a field-anchored validation error, not a 500", async () => {
    await expect(createCustomer({ code: "X", name: "X", financeChargeRate: "100" }))
      .rejects.toBeInstanceOf(ZodError);
  });

  // F1: creditLimit is Decimal(12,2) — the old validator allowed up to 4 fractional digits (it
  // was shared with financeChargeRate), so "1.005" sailed through validation and was silently
  // rounded by Postgres to 1.01 on write. Silent rounding of money is never acceptable; a value
  // with more precision than the column can hold must be rejected, not munged.
  it("rejects a credit limit with more precision than Decimal(12,2) can hold, rather than silently rounding it", async () => {
    await expect(createCustomer({ code: "Y", name: "Y", creditLimit: "1.005" }))
      .rejects.toBeInstanceOf(ZodError);
  });

  // F2 (Phase 2B round-2 fix wave): customer-addresses.ts and customer-contacts.ts guard their
  // update path on deletedAt: null and 404; customers.ts never got the same guard, so updating a
  // soft-deleted customer silently succeeds and mutates a row that appears in no list.
  it("404s when updating a soft-deleted customer instead of silently mutating the hidden row", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    await deleteCustomer(id, "test cleanup");
    await expect(updateCustomer(id, { name: "Acme Renamed" })).rejects.toMatchObject({ status: 404 });
  });

  // F2: deleteCustomer had the same gap — nothing stopped a second delete of an already-deleted
  // row, which would silently re-stamp deletedAt and mint a duplicate audit "delete" entry.
  it("404s when deleting an already soft-deleted customer", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    await deleteCustomer(id, "test cleanup");
    await expect(deleteCustomer(id, "test cleanup")).rejects.toMatchObject({ status: 404 });
  });

  it("allows renaming a customer's code onto one only a deleted row still holds", async () => {
    const dead = await createCustomer({ code: "OLD", name: "Gone" });
    await deleteCustomer(dead.id, "no longer a customer");
    const live = await createCustomer({ code: "KEEP", name: "Still here" });

    await updateCustomer(live.id, { code: "OLD" });

    expect((await getCustomer(live.id)).code).toBe("OLD");
  });
});
