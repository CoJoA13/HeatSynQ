import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import { createShipper, listShippers, type ShipperDetail } from "@/server/shippers";
import type { Customer, Part } from "../prisma/generated/prisma/client";

// Task 13's own service-level coverage of the shipping list's filter contract (spec §11): customer,
// ship-date range, includeVoided defaulting off, and search over packing-list number / BOL number /
// order number / customer code. `listShippers` itself was built in Task 9 (shippers.ts's own header
// comment) and shipper-children.test.ts already exercises customer/basic-search/includeVoided in
// passing — this file is the dedicated, exhaustive pass the page (ShippingList.tsx) leans on.

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `SL${customerSeq}`, name: `Ship List Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({ data: { customerId, partNumber: `SLP-${partSeq}`, eachWeight: "1.0000" } });
}

/** Gives a part revision 1 with one step — the orderability precondition createOrder enforces
 *  (spec §5.3), the shipper-children.test.ts `giveSteps` precedent. */
async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `SL-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

async function orderForCustomer(customer: Customer): Promise<OrderDetail> {
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: 10, weight: "5.00" }],
  }));
  return order;
}

/** One order's worth of `createShipper` input, shipping its lead line in full — the
 *  shipper-children.test.ts `orderInput` precedent. */
async function shipmentFor(customer: Customer, order: OrderDetail, shipDate: string): Promise<ShipperDetail> {
  const { shipper } = await createShipper({
    customerId: customer.id,
    shipDate,
    orders: [{
      orderId: order.id,
      lines: [{
        orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight, lineComplete: false,
      }],
      containers: [],
      serials: [],
    }],
  }, { canOverrideCreditHold: false });
  return shipper;
}

beforeEach(async () => {
  await truncateAll();
  await seedOrderGatePrereqs();
});

describe("listShippers filters (spec §11 shipping list)", () => {
  it("filters by customerId", async () => {
    const customerA = await makeCustomer();
    const customerB = await makeCustomer();
    const shipperA = await shipmentFor(customerA, await orderForCustomer(customerA), "2026-08-04");
    await shipmentFor(customerB, await orderForCustomer(customerB), "2026-08-04");

    const rows = await listShippers({ customerId: customerA.id });
    expect(rows.map((r) => r.id)).toEqual([shipperA.id]);
  });

  it("filters by ship-date range (from/to inclusive)", async () => {
    const customer = await makeCustomer();
    const early = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-01");
    const mid = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-10");
    const late = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-20");

    const midOnly = await listShippers({ from: "2026-08-05", to: "2026-08-15" });
    expect(midOnly.map((r) => r.id)).toEqual([mid.id]);

    const fromOnly = await listShippers({ from: "2026-08-10" });
    expect(fromOnly.map((r) => r.id).sort()).toEqual([late.id, mid.id].sort());

    const toOnly = await listShippers({ to: "2026-08-10" });
    expect(toOnly.map((r) => r.id).sort()).toEqual([early.id, mid.id].sort());
  });

  it("excludes voided shipments by default and includes them only with includeVoided", async () => {
    const customer = await makeCustomer();
    const live = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-04");
    const voided = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-04");
    await prisma.shipper.update({ where: { id: voided.id }, data: { deletedAt: new Date() } });

    const defaultRows = await listShippers({});
    expect(defaultRows.map((r) => r.id)).toEqual([live.id]);

    const explicitOff = await listShippers({ includeVoided: false });
    expect(explicitOff.map((r) => r.id)).toEqual([live.id]);

    const withVoided = await listShippers({ includeVoided: true });
    expect(withVoided.map((r) => r.id).sort()).toEqual([live.id, voided.id].sort());
  });

  it("search matches the packing-list number", async () => {
    const customer = await makeCustomer();
    const shipper = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-04");

    const rows = await listShippers({ search: String(shipper.shipperNumber) });
    expect(rows.map((r) => r.id)).toEqual([shipper.id]);
  });

  it("search matches the BOL number", async () => {
    const customer = await makeCustomer();
    const shipper = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-04");
    // No BOL print flow exists yet in this branch (only shippers.ts reads/writes bolNumber) — set
    // it directly, the certs-schema.test.ts precedent for exercising a bolNumber-bearing row.
    await prisma.shipper.update({ where: { id: shipper.id }, data: { bolNumber: 88123 } });

    const rows = await listShippers({ search: "88123" });
    expect(rows.map((r) => r.id)).toEqual([shipper.id]);
  });

  it("search matches an order number carried on the shipment", async () => {
    const customer = await makeCustomer();
    const order = await orderForCustomer(customer);
    const shipper = await shipmentFor(customer, order, "2026-08-04");

    const rows = await listShippers({ search: String(order.orderNumber) });
    expect(rows.map((r) => r.id)).toEqual([shipper.id]);
  });

  it("search matches the customer code", async () => {
    const customer = await makeCustomer();
    const shipper = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-04");

    const rows = await listShippers({ search: customer.code });
    expect(rows.map((r) => r.id)).toEqual([shipper.id]);
  });

  it("search does not cross customers — a different customer's number does not match", async () => {
    const customerA = await makeCustomer();
    const customerB = await makeCustomer();
    await shipmentFor(customerA, await orderForCustomer(customerA), "2026-08-04");
    await shipmentFor(customerB, await orderForCustomer(customerB), "2026-08-04");

    const rows = await listShippers({ search: customerA.code });
    expect(rows.every((r) => r.customerCode === customerA.code)).toBe(true);
  });
});
