import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { createCustomer, deleteCustomer } from "@/server/customers";
import { addAddress } from "@/server/customer-addresses";
import { addContact } from "@/server/customer-contacts";
import { createPart, deletePart } from "@/server/parts";
import { PUT as putAddress, DELETE as deleteAddressRoute } from "@/app/api/customers/[id]/addresses/[addressId]/route";
import { PUT as putContact, DELETE as deleteContactRoute } from "@/app/api/customers/[id]/contacts/[contactId]/route";

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

function bodyReq(url: string, method: string, cookie: string, body: unknown): Request {
  return new Request(url, {
    method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
function noBodyReq(url: string, method: string, cookie: string): Request {
  return new Request(url, { method, headers: { cookie } });
}

async function twoCustomers() {
  const x = (await createCustomer({ code: "X", name: "X Co" })).id;
  const y = (await createCustomer({ code: "Y", name: "Y Co" })).id;
  return { x, y };
}

describe("customer child-route scoping", () => {
  beforeEach(async () => await truncateAll());

  it("an address of customer X is not editable through customer Y's URL", async () => {
    const { x, y } = await twoCustomers();
    const { id: addressId } = await addAddress(x, { kind: "SHIP_TO", name: "Dock 1" });
    const cookie = await signInWith(["customers.view", "customers.edit"]);

    const res = await putAddress(
      bodyReq(`http://t/api/customers/${y}/addresses/${addressId}`, "PUT", cookie, { city: "Toledo" }),
      withParams({ id: y, addressId }));
    expect(res.status).toBe(404);

    const row = await prisma.customerAddress.findUnique({ where: { id: addressId } });
    expect(row?.city).not.toBe("Toledo");
    expect(row?.deletedAt).toBeNull();
  });

  it("nor deletable", async () => {
    const { x, y } = await twoCustomers();
    const { id: addressId } = await addAddress(x, { kind: "SHIP_TO", name: "Dock 1" });
    const cookie = await signInWith(["customers.view", "customers.edit"]);

    const res = await deleteAddressRoute(
      noBodyReq(`http://t/api/customers/${y}/addresses/${addressId}`, "DELETE", cookie),
      withParams({ id: y, addressId }));
    expect(res.status).toBe(404);

    const row = await prisma.customerAddress.findUnique({ where: { id: addressId } });
    expect(row?.deletedAt).toBeNull();
  });

  it("contacts: same two assertions", async () => {
    const { x, y } = await twoCustomers();
    const { id: contactId } = await addContact(x, { name: "Dana" });
    const cookie = await signInWith(["customers.view", "customers.edit"]);

    const putRes = await putContact(
      bodyReq(`http://t/api/customers/${y}/contacts/${contactId}`, "PUT", cookie, { name: "Hijacked" }),
      withParams({ id: y, contactId }));
    expect(putRes.status).toBe(404);

    const deleteRes = await deleteContactRoute(
      noBodyReq(`http://t/api/customers/${y}/contacts/${contactId}`, "DELETE", cookie),
      withParams({ id: y, contactId }));
    expect(deleteRes.status).toBe(404);

    const row = await prisma.customerContact.findUnique({ where: { id: contactId } });
    expect(row?.name).toBe("Dana");
    expect(row?.deletedAt).toBeNull();
  });

  it("deleteCustomer refuses while live parts exist", async () => {
    const id = (await createCustomer({ code: "ACME", name: "Acme" })).id;
    await createPart({ customerId: id, partNumber: "12345", eachWeight: 1 });
    await expect(deleteCustomer(id, "cleanup")).rejects.toThrow("That customer still has parts");
  });

  it("deleteCustomer succeeds once its parts are deleted", async () => {
    const id = (await createCustomer({ code: "ACME", name: "Acme" })).id;
    const { id: partId } = await createPart({ customerId: id, partNumber: "12345", eachWeight: 1 });
    await deletePart(partId, "cleanup");
    await expect(deleteCustomer(id, "cleanup")).resolves.toBeUndefined();
    const row = await prisma.customer.findUnique({ where: { id } });
    expect(row?.deletedAt).not.toBeNull();
  });
});
