import { describe, it, expect, beforeEach } from "vitest";
import { ZodError } from "zod";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import {
  listCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer,
  customerPartBlockers, customerOrderBlockers, customerQuoteBlockers, customerPaymentBlockers,
} from "@/server/customers";
import { addAddress, listAddresses } from "@/server/customer-addresses";
import { addContact, listContacts } from "@/server/customer-contacts";
import { createPart, deletePart } from "@/server/parts";
import { createOrder, voidOrder } from "@/server/orders";
import { readAudit } from "@/server/audit";
import { HttpError } from "@/server/errors";
import { setSetting } from "@/server/settings";
import { runWithContext } from "@/server/context";
import { parseDateOnly } from "@/lib/business-days";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Task 8: the surcharges.test.ts precedent — an explicit system actor rather than relying on
// context.ts's `{ id: null, name: "system" }` fallback for an unwrapped call, so these tests read
// the same way the customer-surcharge tests beside them (in surcharges.test.ts) do.
const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** Gives a part revision 1 with one step — createOrder's orderability precondition for the LEAD
 *  of an order (spec §5.3), the orders.test.ts/parts.test.ts `giveSteps` shape, built with raw
 *  prisma so this file's fixtures don't depend on the process-steps service. The step code is
 *  keyed off `partId` (a cuid, unique by construction) rather than a fixed literal, since this
 *  test file's own guard test calls `giveSteps` twice against two different parts and a fixed
 *  code would collide on ProcessStepCode's unique `code` column the second time. */
async function giveSteps(partId: string) {
  const code = await prisma.processStepCode.create({
    data: { code: `HT-${partId.slice(0, 10)}`, name: "Austenitize" },
  });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

describe("customers service", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

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

  // H4 (Codex round 3 review, owner ruling 2026-08-01, amends spec §11): the parts refusal now
  // names the count in its message, and a separate blocker list exists for the UI to fetch.
  it("delete refusal message carries the live part count", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    await createPart({ customerId: id, partNumber: "12345", eachWeight: 1 });
    await createPart({ customerId: id, partNumber: "12346", eachWeight: 1 });
    await expect(deleteCustomer(id, "test cleanup")).rejects.toThrow("That customer still has 2 part(s)");
  });

  it("customerPartBlockers lists every live part regardless of active, excludes soft-deleted, "
    + "ordered by partNumber", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    const other = await createCustomer({ code: "BETA", name: "Beta" });
    const { id: p2 } = await createPart({ customerId: id, partNumber: "22222", eachWeight: 1 });
    const { id: p1 } = await createPart({
      customerId: id, partNumber: "11111", eachWeight: 1, active: false,
    });
    const { id: p3 } = await createPart({ customerId: id, partNumber: "33333", eachWeight: 1 });
    await deletePart(p3, "cleanup");
    await createPart({ customerId: other.id, partNumber: "99999", eachWeight: 1 });

    const blockers = await customerPartBlockers(id);
    expect(blockers).toEqual([
      { entityLabel: "Part", name: "ACME · 11111", id: p1, href: `/parts/${p1}` },
      { entityLabel: "Part", name: "ACME · 22222", id: p2, href: `/parts/${p2}` },
    ]);
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

  // Task 15: deleteCustomer is now ALSO guarded by a direct Order.customerId scan, independent of
  // the pre-existing live-parts guard above — a live order can outlive every part it references.
  describe("deleteCustomer is guarded by live orders", () => {
    it("refuses on a live order even with zero live parts, and the blocker list names it "
      + "alongside any blocking parts; a voided order blocks neither the part nor the customer", async () => {
      const { id } = await createCustomer({ code: "ACME", name: "Acme" });
      const { id: partId } = await createPart({ customerId: id, partNumber: "12345", eachWeight: 1 });
      await giveSteps(partId);
      const { order } = await createOrder({
        customerId: id, lines: [{ partId, qty: 10, weight: "100.00" }],
      });

      // Simulate the part having gone away by some path OTHER than deletePart (e.g. data older
      // than deletePart's own Task 15 order-guard, which would otherwise refuse this exact
      // delete) — the point here is deleteCustomer's OWN order guard, independent of its
      // pre-existing parts guard, so the part count must read zero going in.
      await prisma.part.update({ where: { id: partId }, data: { deletedAt: new Date() } });

      await expect(deleteCustomer(id, "test cleanup")).rejects.toThrow(/live order/i);
      expect(await customerOrderBlockers(id)).toEqual([
        { entityLabel: "Order", name: `#${order.orderNumber} · ACME`, id: order.id, href: `/orders/${order.id}` },
      ]);
      // The combined blockers fetch (the customers/[id]/blockers route) shows both categories
      // together regardless of which guard actually threw — customerPartBlockers still reports
      // the (now soft-deleted) part as gone, so only the order blocker survives here.
      expect(await customerPartBlockers(id)).toEqual([]);

      // Now the "voided blocks nothing" half, on a fresh customer/order so the part is still
      // live — deleteCustomer here is refused by the (unrelated, pre-existing) live-parts guard
      // first, so it's deletePart's own order-guard (parts.ts) that is under test on this half.
      const { id: id2 } = await createCustomer({ code: "BETA", name: "Beta" });
      const { id: partId2 } = await createPart({ customerId: id2, partNumber: "999", eachWeight: 1 });
      await giveSteps(partId2);
      const { order: order2 } = await createOrder({
        customerId: id2, lines: [{ partId: partId2, qty: 1, weight: "10.00" }],
      });
      await expect(deletePart(partId2, "test cleanup")).rejects.toThrow(/live order/i);

      await voidOrder(order2.id, "test cleanup");
      await deletePart(partId2, "test cleanup"); // no longer blocked, by the same rule
      await deleteCustomer(id2, "test cleanup"); // zero live parts, zero live orders now
      expect((await prisma.customer.findFirst({ where: { id: id2 } }))!.deletedAt).not.toBeNull();
    });
  });

  // Task 7 (Phase 6 spec §4.2): live quotes join deleteCustomer's blocker list beside children,
  // parts and orders — a quote is the customer's own agreement (customerId is immutable, spec
  // §4.1), so a customer with quotes is refused-and-named, never silently orphaned. Raw-prisma
  // quote fixtures with FREE-TEXT lines: no part rows, so the pre-existing parts guard stays at
  // zero and it is unambiguously the quotes guard under test.
  describe("deleteCustomer is guarded by live quotes", () => {
    async function quoteFor(customerId: string, quoteNumber: number,
                            extra: Record<string, unknown> = {}) {
      const user = await prisma.user.findFirst({ where: { username: "quoter-cust" } })
        ?? await prisma.user.create({
          data: { username: "quoter-cust", passwordHash: "x", displayName: "Quoter" } });
      return prisma.quote.create({ data: {
        quoteNumber, customerId, quotedById: user.id,
        quoteDate: new Date("2026-08-01"), effectiveDate: new Date("2026-08-01"),
        expiryDate: new Date("2026-08-31"),
        lines: { create: [{ position: 1, partNumberText: `FT-${quoteNumber}` }] },
        ...extra,
      } });
    }

    it("refuses on live quotes — OPEN or CLOSED — with a discoverable blocker list named the "
      + "Quote way", async () => {
      const { id } = await createCustomer({ code: "ACME", name: "Acme" });
      const open = await quoteFor(id, 1000);
      // CLOSED is not deleted: closing is reversible and takes nothing with it (spec §5.1), so a
      // closed quote is still a live record and still blocks — "live" is deletedAt, not status.
      const closed = await quoteFor(id, 1001,
        { status: "CLOSED", closeReason: "went elsewhere", closedAt: new Date() });

      await expect(deleteCustomer(id, "test cleanup"))
        .rejects.toThrow("That customer still has 2 live quote(s)");
      expect(await customerQuoteBlockers(id)).toEqual([
        { entityLabel: "Quote", name: "Quote · #1000", id: open.id, href: `/quotes/${open.id}` },
        { entityLabel: "Quote", name: "Quote · #1001", id: closed.id, href: `/quotes/${closed.id}` },
      ]);
      // Refused, not allowed-and-dangled — the customer survives, quotes still point at it.
      expect((await prisma.customer.findFirst({ where: { id } }))!.deletedAt).toBeNull();
    });

    it("a customer with only DELETED quotes deletes cleanly — a dead quote blocks nothing", async () => {
      const { id } = await createCustomer({ code: "BETA", name: "Beta" });
      await quoteFor(id, 1002, { deletedAt: new Date() });
      expect(await customerQuoteBlockers(id)).toEqual([]);
      await deleteCustomer(id, "test cleanup");
      expect((await prisma.customer.findFirst({ where: { id } }))!.deletedAt).not.toBeNull();
    });
  });

  /**
   * Issue #84 (P1) — the guard that STRANDS MONEY when it is missing.
   *
   * Phase 5B added `Payment.customerId`, so a customer can own live receipt cash, but
   * `deleteCustomer` still checked only children, parts, orders and quotes. A customer holding an
   * unapplied payment and NO live order could therefore be soft-deleted — and afterwards
   * `applyPayment` cannot use that cash, because `familyCustomerIds` requires a live payer. The
   * money is stranded with no path back short of a hand-written UPDATE.
   *
   * Note what this does NOT need to check separately. A live INVOICE hangs off an order, and live
   * orders already block; a live APPLICATION needs both an invoice (→ order → blocked) and a
   * payment (→ blocked here), so both are covered transitively rather than by their own guard.
   * Payments are the one A/R row that can exist with no order behind it, which is exactly why this
   * was the gap.
   */
  describe("deleteCustomer is guarded by live payments (#84)", () => {
    async function paymentFor(customerId: string, amount: number, batchNumber: number,
                              extra: Record<string, unknown> = {}) {
      const paymentType = await prisma.paymentType.findFirst({ where: { name: "Check" } })
        ?? await prisma.paymentType.create({ data: { name: "Check" } });
      const batch = await prisma.receiptBatch.create({
        data: { batchNumber, depositDate: parseDateOnly("2026-08-08") },
      });
      return prisma.payment.create({
        data: {
          batchId: batch.id, customerId, paymentTypeId: paymentType.id,
          amount, reference: "1234", receivedDate: parseDateOnly("2026-08-08"),
          ...extra,
        },
      });
    }

    it("refuses a customer holding unapplied cash, and names the payment so it can be found", async () => {
      const { id } = await createCustomer({ code: "ACME", name: "Acme" });
      const pay = await paymentFor(id, 300, 1000);

      await expect(deleteCustomer(id, "test cleanup"))
        .rejects.toThrow("That customer still has 1 live payment(s)");

      // §5.14: a block names its blockers and links to where they live. A Payment has no detail
      // page of its own, so it links to the batch that holds it — where it can actually be voided.
      expect(await customerPaymentBlockers(id, { includeAmounts: true })).toEqual([{
        entityLabel: "Payment", name: "Batch #1000 · 300.00",
        id: pay.id, href: `/receivables/batches/${pay.batchId}`,
      }]);

      // Refused, not allowed-and-stranded — the customer survives and still owns its cash.
      expect((await prisma.customer.findFirst({ where: { id } }))!.deletedAt).toBeNull();
    });

    it("a customer with only VOIDED payments deletes cleanly — voided cash blocks nothing", async () => {
      const { id } = await createCustomer({ code: "BETA", name: "Beta" });
      await paymentFor(id, 300, 1001, { deletedAt: new Date() });
      expect(await customerPaymentBlockers(id, { includeAmounts: true })).toEqual([]);
      await deleteCustomer(id, "test cleanup");
      expect((await prisma.customer.findFirst({ where: { id } }))!.deletedAt).not.toBeNull();
    });

    it("names every live payment, ordered, so a multi-batch payer is fully discoverable", async () => {
      const { id } = await createCustomer({ code: "GAMMA", name: "Gamma" });
      await paymentFor(id, 300, 1003);
      await paymentFor(id, 125.5, 1002);

      await expect(deleteCustomer(id, "test cleanup"))
        .rejects.toThrow("That customer still has 2 live payment(s)");
      const blockers = await customerPaymentBlockers(id, { includeAmounts: true });
      expect(blockers.map((b) => b.name)).toEqual(["Batch #1002 · 125.50", "Batch #1003 · 300.00"]);
    });
  });

  /**
   * SWEEP — the delete-blocker panel's trigger must know every guard the service has (#84).
   *
   * `customers/[id]/page.tsx` decides whether to fetch and show the §5.14 blocker list by
   * PATTERN-MATCHING the refusal text. That coupling degrades silently: add a guard to
   * `deleteCustomer` and forget the UI, and its refusal renders as a bare error banner with no
   * blocker list and no export — a block that names nothing and offers no route out, which is
   * exactly the Visual Shop dead end §5.14 was written to escape. #84 nearly shipped that way.
   *
   * So the coupling is swept rather than commented: every templated "That customer still has …"
   * message in the service must appear in the page's match condition. The plain
   * "still has child customers" refusal is deliberately exempt — there is no blockers route for
   * children (the customer list itself shows them), and the page's comment says so.
   */
  it("every deleteCustomer blocker message is matched by the page's blocker-panel trigger", () => {
    const service = readFileSync(join(process.cwd(), "src/server/customers.ts"), "utf8");
    const page = readFileSync(join(process.cwd(), "src/app/customers/[id]/page.tsx"), "utf8");

    const phrases = [...service.matchAll(/That customer still has \$\{\w+\} ([^`]+)`/g)]
      .map((m) => m[1]);

    // Bite-proof: if the extraction stops finding the guards (a reworded message, a refactor), the
    // sweep would pass vacuously against an empty list.
    expect(phrases).toEqual(
      expect.arrayContaining(["part(s)", "live order(s)", "live quote(s)", "live payment(s)"]));

    const unmatched = phrases.filter((p) => !page.includes(`message.includes("${p}")`));
    expect(unmatched).toEqual([]);
  });

  describe("requestDaysOverride", () => {
    it("round-trips through create and update, clears to null, and rejects a negative value", async () => {
      const { id } = await createCustomer({ code: "ACME", name: "Acme", requestDaysOverride: 10 });
      expect((await getCustomer(id)).requestDaysOverride).toBe(10);

      await updateCustomer(id, { requestDaysOverride: 3 });
      expect((await getCustomer(id)).requestDaysOverride).toBe(3);

      await updateCustomer(id, { requestDaysOverride: null });
      expect((await getCustomer(id)).requestDaysOverride).toBeNull();

      await expect(createCustomer({ code: "BAD", name: "Bad", requestDaysOverride: -1 }))
        .rejects.toBeInstanceOf(ZodError);
      await expect(updateCustomer(id, { requestDaysOverride: -5 })).rejects.toBeInstanceOf(ZodError);
    });

    // Fix-wave finding 5: unbounded, this feeds straight into addBusinessDays' own day-at-a-time
    // loop (src/lib/business-days.ts), which now caps at 3650 — bounding it here too means the
    // rejection is a clean 400 at the customer edit itself, not a generic error surfaced later at
    // order entry.
    it("rejects a value above the 3650-day cap, and allows exactly the boundary", async () => {
      await expect(createCustomer({ code: "CAP1", name: "Cap Co", requestDaysOverride: 3651 }))
        .rejects.toBeInstanceOf(ZodError);
      const { id } = await createCustomer({ code: "CAP2", name: "Cap Co 2", requestDaysOverride: 3650 });
      expect((await getCustomer(id)).requestDaysOverride).toBe(3650);
      await expect(updateCustomer(id, { requestDaysOverride: 3651 })).rejects.toBeInstanceOf(ZodError);
    });

    it("shows in the update audit diff", async () => {
      const { id } = await createCustomer({ code: "ACME", name: "Acme" });
      await updateCustomer(id, { requestDaysOverride: 7 });
      const entry = await prisma.auditLog.findFirst({ where: { entity: "customer", entityId: id, action: "update" } });
      const before = entry!.before as { requestDaysOverride: number | null };
      const after = entry!.after as { requestDaysOverride: number | null };
      expect(before.requestDaysOverride).toBeNull();
      expect(after.requestDaysOverride).toBe(7);
    });
  });

  // Task 4 wiring: the update schema accepts certRequiredDefault/certScopeDefault, and null
  // (inherit the plant setting) stays distinct from an explicit false end to end —
  // resolveCertSettings (certs.ts, tests/cert-resolution.test.ts) is what actually WALKS this
  // chain; this only pins that the customer's own half of it round-trips through
  // create/update/getCustomer untouched.
  describe("certRequiredDefault / certScopeDefault", () => {
    it("round-trips through create and update, and clears back to null (inherit)", async () => {
      const { id } = await createCustomer({
        code: "CD1", name: "Cert Default Co", certRequiredDefault: true, certScopeDefault: "LOAD",
      });
      expect(await getCustomer(id)).toMatchObject({ certRequiredDefault: true, certScopeDefault: "LOAD" });

      await updateCustomer(id, { certRequiredDefault: false, certScopeDefault: "SHIPMENT" });
      expect(await getCustomer(id)).toMatchObject({ certRequiredDefault: false, certScopeDefault: "SHIPMENT" });

      await updateCustomer(id, { certRequiredDefault: null, certScopeDefault: null });
      expect(await getCustomer(id)).toMatchObject({ certRequiredDefault: null, certScopeDefault: null });
    });

    it("defaults to null (inherit) when omitted on create", async () => {
      const { id } = await createCustomer({ code: "CD2", name: "Cert Default Co 2" });
      expect(await getCustomer(id)).toMatchObject({ certRequiredDefault: null, certScopeDefault: null });
    });

    // Task 17: the customer page's three-state control shows what "inherit" currently resolves
    // to — the plant settings — without the client needing a settings seam of its own.
    // Display-only companion values; the customer's own columns stay the unresolved override.
    it("reports what a null default would inherit: the plant settings, on get and on list", async () => {
      await setSetting("cert_required_default", true);
      await setSetting("cert_scope_default", "SHIPMENT");
      const { id } = await createCustomer({ code: "CD3", name: "Cert Default Co 3", certRequiredDefault: false });
      expect(await getCustomer(id)).toMatchObject({
        certRequiredDefault: false, certScopeDefault: null,
        inheritedCertRequired: true, inheritedCertScope: "SHIPMENT",
      });
      const row = (await listCustomers()).find((r) => r.id === id);
      expect(row).toMatchObject({ inheritedCertRequired: true, inheritedCertScope: "SHIPMENT" });
    });
  });

  // Task 8 (P5A): the customer-side half of Task 6/7's surcharge work — this customer's own
  // sales-tax-rate override and certification-charge suppression. salesTaxRate mirrors
  // creditLimit/financeChargeRate's own decimalField-backed round trip; certChargeSuppressed is a
  // plain boolean, the surchargeOptOut shape.
  describe("salesTaxRate / certChargeSuppressed", () => {
    it("stores a per-customer sales tax rate and cert suppression", async () => {
      const { id } = await asSystem(() => createCustomer({ code: "ACME", name: "Acme" }));
      await asSystem(() => updateCustomer(id, { salesTaxRate: "0.045000", certChargeSuppressed: true }));
      const row = await getCustomer(id);
      expect(row.salesTaxRate).toBe(0.045);
      expect(row.certChargeSuppressed).toBe(true);
    });

    it("rejects a sales tax rate with too many decimals", async () => {
      const { id } = await asSystem(() => createCustomer({ code: "ACME", name: "Acme" }));
      await expect(asSystem(() => updateCustomer(id, { salesTaxRate: "0.0450001" })))
        .rejects.toThrow(/at most 3 digits before and 6 digits after/);
    });

    it("defaults to null/false when omitted on create, and round-trips through create too", async () => {
      const { id } = await asSystem(() => createCustomer({ code: "BETA", name: "Beta Co" }));
      expect(await getCustomer(id)).toMatchObject({ salesTaxRate: null, certChargeSuppressed: false });

      const { id: id2 } = await asSystem(() => createCustomer({
        code: "GAMMA", name: "Gamma Co", salesTaxRate: "0.070000", certChargeSuppressed: true,
      }));
      expect(await getCustomer(id2)).toMatchObject({ salesTaxRate: 0.07, certChargeSuppressed: true });
    });

    it("clears the rate back to null (inherit) on update", async () => {
      const { id } = await asSystem(() => createCustomer({
        code: "ACME", name: "Acme", salesTaxRate: "0.045000",
      }));
      await asSystem(() => updateCustomer(id, { salesTaxRate: null }));
      expect((await getCustomer(id)).salesTaxRate).toBeNull();
    });
  });
});
