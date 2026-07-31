import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import {
  listCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer,
} from "@/server/customers";
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

  it("refuses to delete a customer that still has active children", async () => {
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
});
