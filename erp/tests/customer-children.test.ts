import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { createCustomer } from "@/server/customers";
import { listAddresses, addAddress, updateAddress, deleteAddress } from "@/server/customer-addresses";
import { readAudit } from "@/server/audit";

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

  it("promotes a remaining address when the default is deleted", async () => {
    const id = await customer();
    const { id: first } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 1" });
    const { id: second } = await addAddress(id, { kind: "SHIP_TO", name: "Dock 2" });
    await deleteAddress(first);
    expect((await listAddresses(id)).find((a) => a.id === second)?.isDefault).toBe(true);
  });
});
