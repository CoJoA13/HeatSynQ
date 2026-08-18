import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { readAudit } from "@/server/audit";
import { createOrder, getOrder, voidOrder, type OrderDetail } from "@/server/orders";
import { storeDocument } from "@/server/documents";
import {
  createShipper, updateShipper, addOrderToShipper, removeOrderFromShipper,
  replaceShipperLines, replaceShipperContainers, replaceShipperSerials,
  overshipWarnings, listShippers, exportShippers, shipmentsForOrder,
  type ShipperDetail, type ShipperOrderDetail,
} from "@/server/shippers";
import type { Customer, Part } from "../prisma/generated/prisma/client";

// House-legal module-boundary mock (CLAUDE.md: never `vi.spyOn` a Prisma delegate — this wraps a
// LEAF service module instead, the `tests/fetcher.test.ts` / `tests/request-context.test.ts`
// precedent for mocking at a boundary rather than a Prisma model method). The wrapped functions
// still run their REAL implementation (`vi.fn(actual.fn)`) — this only adds a call recorder, it
// never changes behaviour, so every ordinary (non-composition) test below exercises the genuine
// row-lock code path.
vi.mock("@/server/order-locks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/order-locks")>();
  return {
    ...actual,
    claimOrdersInOrder: vi.fn(actual.claimOrdersInOrder),
    claimOrder: vi.fn(actual.claimOrder),
  };
});
import * as orderLocks from "@/server/order-locks";

const claimOrdersInOrderMock = vi.mocked(orderLocks.claimOrdersInOrder);
const claimOrderMock = vi.mocked(orderLocks.claimOrder);

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `SC${customerSeq}`, name: `Ship Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({ data: { customerId, partNumber: `SP-${partSeq}`, eachWeight: "1.0000" } });
}

/** Gives a part revision 1 with one step — the orderability precondition createOrder enforces
 *  (spec §5.3), the shippers.test.ts `giveSteps` precedent. */
async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `SHT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

async function orderForCustomer(
  customer: Customer, opts: { qty?: number; weight?: string } = {},
): Promise<OrderDetail> {
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: opts.qty ?? 10, weight: opts.weight ?? "5.00" }],
  }));
  return order;
}

async function savedOrder(
  opts: { qty?: number; weight?: string } = {},
): Promise<{ order: OrderDetail; customer: Customer }> {
  const customer = await makeCustomer();
  const order = await orderForCustomer(customer, opts);
  return { order, customer };
}

type ShipContainerInput = { orderContainerId: string; count: number };
type ShipSerialInput = { orderSerialId: string; printOnShipper?: boolean };

/** One order's worth of `createShipper` input, shipping its lead line in full. */
function orderInput(order: OrderDetail) {
  return {
    orderId: order.id,
    lines: [{
      orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight, lineComplete: false,
    }],
    containers: [] as ShipContainerInput[],
    serials: [] as ShipSerialInput[],
  };
}

function oneOrderInput(order: OrderDetail) {
  return { customerId: order.customerId, shipDate: "2026-08-04", orders: [orderInput(order)] };
}

function multiOrderInput(customerId: string, orders: OrderDetail[]) {
  return { customerId, shipDate: "2026-08-04", orders: orders.map(orderInput) };
}

async function oneOrderShipment(): Promise<{ shipper: ShipperDetail; orderA: OrderDetail; customer: Customer }> {
  const { order, customer } = await savedOrder({ qty: 10 });
  const { shipper } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
  return { shipper, orderA: order, customer };
}

async function twoOrderShipment(): Promise<{
  shipper: ShipperDetail; first: ShipperOrderDetail; second: ShipperOrderDetail;
  customer: Customer; orders: OrderDetail[];
}> {
  const customer = await makeCustomer();
  const a = await orderForCustomer(customer);
  const b = await orderForCustomer(customer);
  const { shipper } = await createShipper(multiOrderInput(customer.id, [a, b]), { canOverrideCreditHold: false });
  return { shipper, first: shipper.orders[0], second: shipper.orders[1], customer, orders: [a, b] };
}

async function threeOrderShipment(): Promise<{
  shipper: ShipperDetail; first: ShipperOrderDetail; second: ShipperOrderDetail; third: ShipperOrderDetail;
  customer: Customer;
}> {
  const customer = await makeCustomer();
  const a = await orderForCustomer(customer);
  const b = await orderForCustomer(customer);
  const c = await orderForCustomer(customer);
  const { shipper } = await createShipper(multiOrderInput(customer.id, [a, b, c]), { canOverrideCreditHold: false });
  return { shipper, first: shipper.orders[0], second: shipper.orders[1], third: shipper.orders[2], customer };
}

async function shipmentPlusSpareOrder(): Promise<{ shipper: ShipperDetail; orderB: OrderDetail }> {
  const { shipper, customer } = await oneOrderShipment();
  const orderB = await orderForCustomer(customer);
  return { shipper, orderB };
}

async function shipmentPlusForeignOrder(): Promise<{ shipper: ShipperDetail; foreignOrder: OrderDetail }> {
  const { shipper } = await oneOrderShipment();
  const { order: foreignOrder } = await savedOrder();
  return { shipper, foreignOrder };
}

/** A TWO-order shipment whose first order's single line is already marked `lineComplete`, so that
 *  order starts out SHIPPED — the brief's own fixture, adapted two ways from its sample code: (1)
 *  the self-referential `orderA` argument its sample passed (`const { orderA } = await
 *  completeShipmentOf(orderA)` reads its own binding before initialization) is dropped, this
 *  fixture takes none; (2) a SECOND order is added so the removal the test performs is never the
 *  shipment's LAST order — spec §4.2's "at least one line with qty > 0 across all its orders",
 *  enforced at the document level in `removeOrderFromShipper` (coordinator review, this task):
 *  a one-order version of this fixture would make the test exercise the now-forbidden
 *  remove-the-last-order state instead of the status recompute it was written to prove. */
async function completeShipmentOf(): Promise<{
  shipper: ShipperDetail; orderA: OrderDetail; shipperOrderA: ShipperOrderDetail;
}> {
  const customer = await makeCustomer();
  const orderA = await orderForCustomer(customer, { qty: 10 });
  const orderSpare = await orderForCustomer(customer);
  const input = multiOrderInput(customer.id, [orderA, orderSpare]);
  input.orders[0].lines[0].lineComplete = true; // orderA's only line, shipped in full
  const { shipper } = await createShipper(input, { canOverrideCreditHold: false });
  return { shipper, orderA, shipperOrderA: shipper.orders[0] };
}

beforeEach(async () => {
  await truncateAll();
  await seedOrderGatePrereqs();
  claimOrdersInOrderMock.mockClear();
  claimOrderMock.mockClear();
});

describe("addOrderToShipper", () => {
  it("adds another order of the same customer and gives it its own sequence", async () => {
    const { shipper, orderB } = await shipmentPlusSpareOrder();
    const after = await addOrderToShipper(shipper.id, orderB.id);
    expect(after.orders).toHaveLength(2);
    expect(after.orders[1].sequence).toBe(1); // orderB's FIRST shipment
    expect(after.orders[1].position).toBe(2); // second ticket on this shipment
  });

  it("creates the shipment-scope cert for a cert-requiring order, like the initial save", async () => {
    const { shipper, customer } = await oneOrderShipment();
    const part = await makePart(customer.id);
    await prisma.part.update({ where: { id: part.id }, data: { certRequired: true, certScope: "SHIPMENT" } });
    await giveSteps(part.id);
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: part.id, qty: 5, weight: "5.00" }],
    }));

    await addOrderToShipper(shipper.id, order.id);

    const cert = await prisma.cert.findFirst({
      where: { orderId: order.id, shipperId: shipper.id, deletedAt: null },
    });
    expect(cert).not.toBeNull();
  });

  it("refuses an order belonging to a different customer", async () => {
    const { shipper, foreignOrder } = await shipmentPlusForeignOrder();
    await expect(addOrderToShipper(shipper.id, foreignOrder.id)).rejects.toThrow(/same customer/i);
  });

  it("refuses the same order twice on one shipment", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    await expect(addOrderToShipper(shipper.id, orderA.id)).rejects.toThrow(/already on this shipment/i);
  });

  it("refuses a voided order", async () => {
    const { shipper, orderB } = await shipmentPlusSpareOrder();
    await asSystem(() => voidOrder(orderB.id, "wrong part"));
    await expect(addOrderToShipper(shipper.id, orderB.id)).rejects.toThrow(/voided/i);
  });

  it("404s on a voided shipment — a voided shipment is read-only", async () => {
    const { shipper, orderB } = await shipmentPlusSpareOrder();
    await prisma.shipper.update({ where: { id: shipper.id }, data: { deletedAt: new Date() } });
    await expect(addOrderToShipper(shipper.id, orderB.id)).rejects.toThrow(/not found/i);
  });

  it("404s on an unknown shipment id", async () => {
    const { order } = await savedOrder();
    await expect(addOrderToShipper("nope", order.id)).rejects.toThrow(/not found/i);
  });
});

describe("removeOrderFromShipper", () => {
  it("recomputes status when an order is removed", async () => {
    const { shipper, orderA, shipperOrderA } = await completeShipmentOf();
    expect((await getOrder(orderA.id)).status).toBe("SHIPPED");
    await removeOrderFromShipper(shipper.id, shipperOrderA.id);
    expect((await getOrder(orderA.id)).status).toBe("OPEN");
  });

  it("closes positions after a removal", async () => {
    const { shipper, second } = await threeOrderShipment();
    const after = await removeOrderFromShipper(shipper.id, second.id);
    expect(after.orders.map((o) => o.position)).toEqual([1, 2]);
  });

  it("refuses to remove an order whose ticket has printed, and allows it before", async () => {
    const { shipper, second } = await twoOrderShipment();
    await expect(removeOrderFromShipper(shipper.id, second.id)).resolves.toBeTruthy(); // nothing printed

    const { shipper: s2, second: sec2 } = await twoOrderShipment();
    await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "SHIPPER", shipperId: s2.id, orderId: sec2.orderId }, Buffer.from("%PDF-1.4 t")));
    await expect(removeOrderFromShipper(s2.id, sec2.id)).rejects.toThrow(/already printed|void the shipment/i);
  });

  it("refuses to remove the order carrying the shipment's only positive-qty line", async () => {
    // Order B joins with NO lines (addOrderToShipper creates only the shell) — removing order A
    // would leave a live shipment with no positive quantity, the §4.2 invariant creation and
    // replaceShipperLines both enforce.
    const { shipper, orderB } = await shipmentPlusSpareOrder();
    await addOrderToShipper(shipper.id, orderB.id);
    await expect(removeOrderFromShipper(shipper.id, shipper.orders[0].id))
      .rejects.toThrow(/positive quantity/i);
  });

  it("refuses to remove an order whose shipment-scope cert has printed", async () => {
    const { shipper, second } = await twoOrderShipment();
    const cert = await prisma.cert.create({
      data: { orderId: second.orderId, shipperId: shipper.id, scope: "SHIPMENT" },
    });
    // The cert printed BEFORE any ticket — the printed paper carries orderNumber-sequence
    // permanently, so the sequence must stay claimed exactly as a printed ticket's would.
    await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "CERT", certId: cert.id }, Buffer.from("%PDF-1.4 c")));
    await expect(removeOrderFromShipper(shipper.id, second.id))
      .rejects.toThrow(/certification.*printed|void the shipment/i);
  });

  it("refuses to remove an order once the BOL has printed — the BOL names its order number permanently", async () => {
    const { shipper, first, second } = await twoOrderShipment();
    await prisma.$transaction((tx) => storeDocument(tx,
      { kind: "BOL", shipperId: shipper.id, coveredOrderIds: [first.orderId, second.orderId] },
      Buffer.from("%PDF-1.4 b")));
    await expect(removeOrderFromShipper(shipper.id, second.id))
      .rejects.toThrow(/already printed|void the shipment/i);
  });

  it("treats a whole-set ticket print as covering every order on the shipment", async () => {
    const { shipper, first, second } = await twoOrderShipment();
    await prisma.$transaction((tx) => storeDocument(tx,
      { kind: "SHIPPER", shipperId: shipper.id, orderId: null, coveredOrderIds: [first.orderId, second.orderId] },
      Buffer.from("%PDF-1.4 t")));
    await expect(removeOrderFromShipper(shipper.id, second.id)).rejects.toThrow(/already printed/i);
  });

  it("404s for a shipperOrderId that belongs to a different shipment", async () => {
    const { shipper: s1 } = await oneOrderShipment();
    const { shipper: s2 } = await oneOrderShipment();
    await expect(removeOrderFromShipper(s1.id, s2.orders[0].id)).rejects.toThrow(/not on this shipment/i);
  });

  // Coordinator review (this task): spec §4.2's "at least one line with qty > 0 across all its
  // orders" is a DOCUMENT-level invariant — removing a shipment's last order would leave
  // `orders: []`, exactly the "document about nothing" the invariant forbids. Refused, naming the
  // real remedy (void the shipment, §5.6 — the correction that keeps every sequence claimed).
  it("refuses to remove the shipment's last remaining order", async () => {
    const { shipper } = await oneOrderShipment();
    await expect(removeOrderFromShipper(shipper.id, shipper.orders[0].id))
      .rejects.toThrow(/void the shipment/i);
  });

  it("allows removing an order that is not the last one on the shipment", async () => {
    const { shipper, second } = await twoOrderShipment();
    await expect(removeOrderFromShipper(shipper.id, second.id)).resolves.toBeTruthy();
  });

  // Step 6 (Task 2's review): assert ShipperOrder's two remaining uniques as BEHAVIOUR, not just
  // trust the service check — a service refactor that dropped the pre-check would still be caught
  // by these.
  it("the database rejects two ShipperOrder rows sharing (shipperId, orderId)", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    await expect(prisma.shipperOrder.create({
      data: { shipperId: shipper.id, orderId: orderA.id, sequence: 99, position: 99 },
    })).rejects.toThrow();
  });

  it("(shipperId, position) stays unique through the two-phase renumber a removal triggers", async () => {
    const { shipper, second } = await threeOrderShipment();
    const after = await removeOrderFromShipper(shipper.id, second.id);
    const positions = after.orders.map((o) => o.position);
    expect(new Set(positions).size).toBe(positions.length); // no duplicate position survived

    const spare = await orderForCustomer(await prisma.customer.findUniqueOrThrow({ where: { id: after.customerId } }));
    await expect(prisma.shipperOrder.create({
      data: { shipperId: shipper.id, orderId: spare.id, sequence: 1, position: after.orders[0].position },
    })).rejects.toThrow();
  });
});

describe("replaceShipperLines", () => {
  it("replaces the line grid for one order", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    const so = shipper.orders[0];
    const after = await replaceShipperLines(shipper.id, so.id, [
      { orderLineId: orderA.lines[0].id, qty: 3, weight: 7.5, lineComplete: true },
    ]);
    expect(after.orders[0].lines[0]).toMatchObject({ qty: 3, weight: 7.5, lineComplete: true });
  });

  it("refuses a line that does not belong to this order", async () => {
    const { shipper } = await oneOrderShipment();
    const { order: other } = await savedOrder();
    const so = shipper.orders[0];
    await expect(replaceShipperLines(shipper.id, so.id, [
      { orderLineId: other.lines[0].id, qty: 1, weight: 1, lineComplete: false },
    ])).rejects.toThrow(/does not belong/i);
  });

  it("refuses a duplicate line within the replacement set, naming it", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    const so = shipper.orders[0];
    const line = { orderLineId: orderA.lines[0].id, qty: 1, weight: 1, lineComplete: false };
    await expect(replaceShipperLines(shipper.id, so.id, [line, { ...line }]))
      .rejects.toThrow(/line 1.*listed twice/i);
  });

  // Coordinator review (this task): spec §4.2's "at least one line with qty > 0 across all its
  // orders" is a DOCUMENT-level invariant, not a per-line one — a single zeroed line (`qty: 0`,
  // `lineComplete: true`) stays legal ON ITS OWN ("close the line"), but a shipment where EVERY
  // line across EVERY order is zero is a document about nothing.
  it("refuses zeroing a shipment's only line across all its orders", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    const so = shipper.orders[0];
    await expect(replaceShipperLines(shipper.id, so.id, [
      { orderLineId: orderA.lines[0].id, qty: 0, weight: 0, lineComplete: true },
    ])).rejects.toThrow(/at least one line/i);
  });

  it("allows zeroing one order's lines when another order on the shipment still ships something", async () => {
    const { shipper, second, orders } = await twoOrderShipment();
    const orderB = orders[1];
    await expect(replaceShipperLines(shipper.id, second.id, [
      { orderLineId: orderB.lines[0].id, qty: 0, weight: 0, lineComplete: true },
    ])).resolves.toBeTruthy();
  });

  // Step 7: over-ship still warns, never blocks. `replaceShipperLines` itself returns a bare
  // `ShipperDetail` (task-9-brief.md's own literal interface) — `overshipWarnings` is the small,
  // additional pure export that derives the warning straight off that detail's own
  // shippedToDateQty/orderedQty fields (see its doc comment in shippers.ts), so a caller does not
  // need a second `shippedTotals` read to report it.
  it("allows shipping over the remaining quantity, and the warning surfaces via overshipWarnings", async () => {
    const { shipper, orderA } = await oneOrderShipment(); // 10 qty / 5.00 weight ordered
    const so = shipper.orders[0];
    const after = await replaceShipperLines(shipper.id, so.id, [
      { orderLineId: orderA.lines[0].id, qty: 999, weight: 999, lineComplete: false },
    ]);
    expect(after.orders[0].lines[0].qty).toBe(999); // the save still succeeds
    expect(overshipWarnings(after).join(" ")).toMatch(/exceeds/i);
  });

  it("does not warn when shipped-to-date stays within what was ordered", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    const so = shipper.orders[0];
    const after = await replaceShipperLines(shipper.id, so.id, [
      { orderLineId: orderA.lines[0].id, qty: 4, weight: 4, lineComplete: false },
    ]);
    expect(overshipWarnings(after)).toEqual([]);
  });
});

describe("replaceShipperContainers", () => {
  it("replaces the container grid for one order", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    const containerType = await prisma.containerType.create({ data: { name: "Basket" } });
    const container = await prisma.orderContainer.create({
      data: { orderId: orderA.id, position: 1, typeId: containerType.id, count: 2 },
    });
    const so = shipper.orders[0];
    const after = await replaceShipperContainers(shipper.id, so.id, [{ orderContainerId: container.id, count: 2 }]);
    expect(after.orders[0].containers[0]).toMatchObject({ typeName: "Basket", count: 2 });
  });

  it("refuses a container that does not belong to this order", async () => {
    const { shipper } = await oneOrderShipment();
    const { order: other } = await savedOrder();
    const containerType = await prisma.containerType.create({ data: { name: "Basket" } });
    const container = await prisma.orderContainer.create({
      data: { orderId: other.id, position: 1, typeId: containerType.id, count: 2 },
    });
    const so = shipper.orders[0];
    await expect(replaceShipperContainers(shipper.id, so.id, [{ orderContainerId: container.id, count: 1 }]))
      .rejects.toThrow(/does not belong/i);
  });
});

describe("replaceShipperSerials", () => {
  it("replaces the serial grid for one order", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    const serial = await prisma.orderSerial.create({
      data: { orderId: orderA.id, lineId: orderA.lines[0].id, position: 1, serial: "S-1", description: "Heat 1" },
    });
    const so = shipper.orders[0];
    const after = await replaceShipperSerials(shipper.id, so.id, [{ orderSerialId: serial.id, printOnShipper: false }]);
    expect(after.orders[0].serials[0]).toMatchObject({ serial: "S-1", printOnShipper: false });
  });

  it("refuses a serial that does not belong to this order", async () => {
    const { shipper } = await oneOrderShipment();
    const { order: other } = await savedOrder();
    const serial = await prisma.orderSerial.create({
      data: { orderId: other.id, lineId: other.lines[0].id, position: 1, serial: "S-2", description: "" },
    });
    const so = shipper.orders[0];
    await expect(replaceShipperSerials(shipper.id, so.id, [{ orderSerialId: serial.id }]))
      .rejects.toThrow(/does not belong/i);
  });
});

describe("updateShipper", () => {
  it("patches header fields, leaving the rest untouched", async () => {
    const { shipper } = await oneOrderShipment();
    const carrier = await prisma.carrier.create({ data: { name: "ACME Freight" } });
    const after = await updateShipper(shipper.id, { carrierId: carrier.id, route: "I-80 west", proNumber: "PRO-1" });
    expect(after.carrierName).toBe("ACME Freight");
    expect(after.route).toBe("I-80 west");
    expect(after.proNumber).toBe("PRO-1");
    expect(after.comments).toBe(shipper.comments); // untouched
  });

  it("refuses a ship-to address that does not belong to this customer", async () => {
    const { shipper } = await oneOrderShipment();
    const { customer: other } = await savedOrder();
    const addr = await prisma.customerAddress.create({ data: { customerId: other.id, kind: "SHIP_TO", name: "Dock 1" } });
    await expect(updateShipper(shipper.id, { shipToAddressId: addr.id })).rejects.toThrow(/ship-to address/i);
  });

  it("404s on missing or voided shipments", async () => {
    await expect(updateShipper("nope", { route: "x" })).rejects.toThrow(/not found/i);
    const { shipper } = await oneOrderShipment();
    await prisma.shipper.update({ where: { id: shipper.id }, data: { deletedAt: new Date() } });
    await expect(updateShipper(shipper.id, { route: "x" })).rejects.toThrow(/not found/i);
  });

  it("refuses an unknown carrierId", async () => {
    const { shipper } = await oneOrderShipment();
    await expect(updateShipper(shipper.id, { carrierId: "nope" })).rejects.toThrow(/carrier/i);
  });

  // Step 5b (carried from Task 8's review): `updateShipper` is `SNAPSHOT_INCLUDE.shipper`'s FIRST
  // real consumer — `auditedCreate` writes a hand-built payload and never reads the include.
  // Assert the snapshot's actual CONTENT: the customer by CODE, the carrier and ship-to by NAME —
  // raw cuids in a history diff are the unreadable-history shape issue #24 exists to prevent.
  it("the update audit snapshot names the customer by code and the carrier/ship-to by name", async () => {
    const { shipper, customer } = await oneOrderShipment();
    const carrier = await prisma.carrier.create({ data: { name: "ACME Freight" } });
    const address = await prisma.customerAddress.create({ data: { customerId: customer.id, kind: "SHIP_TO", name: "Dock 4" } });

    await updateShipper(shipper.id, { carrierId: carrier.id, shipToAddressId: address.id, route: "I-80 west" });

    const [entry] = await readAudit("shipper", shipper.id); // newest first
    expect(entry.action).toBe("update");
    const after = entry.after as { customer?: { code?: string }; carrier?: { name?: string }; shipToAddress?: { name?: string } };
    expect(after.customer?.code).toBe(customer.code);
    expect(after.carrier?.name).toBe("ACME Freight");
    expect(after.shipToAddress?.name).toBe("Dock 4");
  });
});

describe("listShippers / exportShippers / shipmentsForOrder", () => {
  it("filters by customer, search term and includeVoided", async () => {
    const { shipper: a, customer: customerA } = await oneOrderShipment();
    const { shipper: b } = await oneOrderShipment();
    await prisma.shipper.update({ where: { id: b.id }, data: { deletedAt: new Date() } });

    const byCustomer = await listShippers({ customerId: customerA.id });
    expect(byCustomer.map((r) => r.id)).toEqual([a.id]);

    const bySearch = await listShippers({ search: customerA.code });
    expect(bySearch.map((r) => r.id)).toEqual([a.id]);

    const withoutVoided = await listShippers({});
    expect(withoutVoided.map((r) => r.id)).not.toContain(b.id);

    const withVoided = await listShippers({ includeVoided: true });
    expect(withVoided.map((r) => r.id)).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it("reports order labels, count and totals", async () => {
    const { shipper } = await oneOrderShipment(); // ships its one line in full: qty 10 / weight 5.00
    const [row] = await listShippers({});
    expect(row.orderCount).toBe(1);
    expect(row.orderLabels).toEqual(shipper.orders.map((o) => o.label));
    expect(row.totalQty).toBe(10);
    expect(row.totalWeight).toBe(5);
  });

  it("orders a multi-order shipment's labels by print position, not scan order", async () => {
    const { shipper } = await twoOrderShipment();
    const [row] = await listShippers({});
    expect(row.orderLabels).toEqual(shipper.orders.map((o) => o.label));
    expect(row.orderCount).toBe(2);
  });

  it("exportShippers produces a non-empty workbook for the same filter", async () => {
    await oneOrderShipment();
    const buf = await exportShippers({});
    expect(buf.length).toBeGreaterThan(0);
  });

  it("shipmentsForOrder returns every shipment for that order, voided included", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    await prisma.shipper.update({ where: { id: shipper.id }, data: { deletedAt: new Date() } });
    const rows = await shipmentsForOrder(orderA.id);
    expect(rows.map((r) => r.id)).toEqual([shipper.id]);
    expect(rows[0].deletedAt).not.toBeNull();
  });

  // Task 17 (order hub Shipments section): the hub row shows THIS order's own label (`72036-3`),
  // its own quantities, and whether its lines shipped complete — none of which the shipment-wide
  // totals can answer for a multi-order shipment. The per-order breakdown is additive on
  // `ShipperRow`, in print (position) order like `orderLabels`.
  it("rows carry a per-order breakdown: id, number, sequence, quantities and the complete flag", async () => {
    const { shipper, orders } = await twoOrderShipment();
    const [row] = await shipmentsForOrder(orders[0].id);
    expect(row.orders).toHaveLength(2);
    expect(row.orders[0]).toMatchObject({
      orderId: orders[0].id, orderNumber: orders[0].orderNumber, sequence: 1,
      qty: 10, weight: 5, complete: false,
    });
    expect(row.orders[1]).toMatchObject({ orderId: orders[1].id, sequence: 1, complete: false });

    // Marking the first order's only line complete flips ITS flag and only its flag.
    await replaceShipperLines(shipper.id, shipper.orders[0].id, [
      { orderLineId: orders[0].lines[0].id, qty: 10, weight: 5, lineComplete: true },
    ]);
    const [after] = await shipmentsForOrder(orders[0].id);
    expect(after.orders[0].complete).toBe(true);
    expect(after.orders[1].complete).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// Step 5a (carried from Task 8's review): lock the claim CALL SITE, not concurrency timing —
// timing cannot discriminate ABBA deadlock at this layer (the sorted claim is one statement), so
// what's deterministically testable is that each mutator claims through `claimOrdersInOrder` with
// the full affected id set, as the FIRST lock call. `createShipper` also calls `certs.ts`'s
// `claimOrder` (via `createCert`, for a SHIPMENT-scope cert) — asserted here as "first call comes
// before claimOrder", never "claimOrder is never called".
// -------------------------------------------------------------------------------------------
describe("composition: claim discipline (module-boundary mock)", () => {
  it("createShipper claims through claimOrdersInOrder before certs.ts's claimOrder", async () => {
    const customer = await makeCustomer();
    const part = await makePart(customer.id);
    await prisma.part.update({ where: { id: part.id }, data: { certRequired: true, certScope: "SHIPMENT" } });
    await giveSteps(part.id);
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: part.id, qty: 5, weight: "5.00" }],
    }));

    await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });

    expect(claimOrdersInOrderMock).toHaveBeenCalled();
    expect(claimOrderMock).toHaveBeenCalled(); // createCert's own claim, transitively
    expect(claimOrdersInOrderMock.mock.invocationCallOrder[0])
      .toBeLessThan(claimOrderMock.mock.invocationCallOrder[0]);
    expect(claimOrdersInOrderMock.mock.calls[0][1]).toEqual([order.id]);
  });

  it("updateShipper's first lock call claims every order on the shipment", async () => {
    const { shipper, orders } = await twoOrderShipment();
    claimOrdersInOrderMock.mockClear();
    await updateShipper(shipper.id, { route: "x" });
    expect(claimOrdersInOrderMock.mock.calls[0][1].slice().sort())
      .toEqual(orders.map((o) => o.id).sort());
  });

  it("addOrderToShipper's first lock call claims the existing order plus the new one", async () => {
    const { shipper, orderB } = await shipmentPlusSpareOrder();
    const existingOrderId = shipper.orders[0].orderId;
    claimOrdersInOrderMock.mockClear();
    await addOrderToShipper(shipper.id, orderB.id);
    expect(claimOrdersInOrderMock.mock.calls[0][1].slice().sort())
      .toEqual([existingOrderId, orderB.id].sort());
  });

  it("removeOrderFromShipper's first lock call claims every order on the shipment", async () => {
    const { shipper, orders } = await twoOrderShipment();
    claimOrdersInOrderMock.mockClear();
    await removeOrderFromShipper(shipper.id, shipper.orders[0].id);
    expect(claimOrdersInOrderMock.mock.calls[0][1].slice().sort())
      .toEqual(orders.map((o) => o.id).sort());
  });

  it("replaceShipperLines' first lock call claims every order on the shipment", async () => {
    const { shipper, orders } = await twoOrderShipment();
    claimOrdersInOrderMock.mockClear();
    await replaceShipperLines(shipper.id, shipper.orders[0].id, [
      { orderLineId: orders[0].lines[0].id, qty: 1, weight: 1, lineComplete: false },
    ]);
    expect(claimOrdersInOrderMock.mock.calls[0][1].slice().sort())
      .toEqual(orders.map((o) => o.id).sort());
  });

  it("replaceShipperContainers' first lock call claims every order on the shipment", async () => {
    const { shipper, orders } = await twoOrderShipment();
    claimOrdersInOrderMock.mockClear();
    await replaceShipperContainers(shipper.id, shipper.orders[0].id, []);
    expect(claimOrdersInOrderMock.mock.calls[0][1].slice().sort())
      .toEqual(orders.map((o) => o.id).sort());
  });

  it("replaceShipperSerials' first lock call claims every order on the shipment", async () => {
    const { shipper, orders } = await twoOrderShipment();
    claimOrdersInOrderMock.mockClear();
    await replaceShipperSerials(shipper.id, shipper.orders[0].id, []);
    expect(claimOrdersInOrderMock.mock.calls[0][1].slice().sort())
      .toEqual(orders.map((o) => o.id).sort());
  });
});

// -------------------------------------------------------------------------------------------
// Credit hold gates shipment EXTENSION (owner ruling 2026-08-06, PR #47 round 3): a hold set
// after a shipment exists must not be bypassable by adding orders or replacing lines — the two
// paths that add shipped work. Same §5.4 shape as creation: named + linked refusal;
// override_credit_hold + a reason (recorded in the audit entry) proceeds.
// -------------------------------------------------------------------------------------------
describe("credit hold gates shipment extension", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  async function heldShipmentPlusSpare() {
    const { shipper, orderB } = await shipmentPlusSpareOrder();
    await prisma.customer.update({
      where: { id: (await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).customerId },
      data: { creditHold: true },
    });
    return { shipper, orderB };
  }

  it("addOrderToShipper refuses on a held customer without the override, naming the customer", async () => {
    const { shipper, orderB } = await heldShipmentPlusSpare();
    await expect(addOrderToShipper(shipper.id, orderB.id)).rejects.toThrow(/credit hold/i);
  });

  it("addOrderToShipper proceeds with the override and records the reason in the audit entry", async () => {
    const { shipper, orderB } = await heldShipmentPlusSpare();
    const after = await addOrderToShipper(shipper.id, orderB.id,
      { canOverrideCreditHold: true }, "owner approved by phone");
    expect(after.orders).toHaveLength(2);
    const [entry] = await readAudit("shipper", shipper.id);
    expect(entry.reason).toBe("owner approved by phone");
  });

  it("addOrderToShipper with the override still requires a reason", async () => {
    const { shipper, orderB } = await heldShipmentPlusSpare();
    await expect(addOrderToShipper(shipper.id, orderB.id, { canOverrideCreditHold: true }))
      .rejects.toThrow(/reason/i);
  });

  it("replaceShipperLines refuses on a held customer without the override", async () => {
    const { shipper } = await heldShipmentPlusSpare();
    const so = shipper.orders[0];
    await expect(replaceShipperLines(shipper.id, so.id,
      [{ orderLineId: so.lines[0].orderLineId!, qty: 9, weight: "9.00", lineComplete: false }]))
      .rejects.toThrow(/credit hold/i);
  });

  it("replaceShipperLines proceeds with the override + reason, recording it", async () => {
    const { shipper } = await heldShipmentPlusSpare();
    const so = shipper.orders[0];
    const after = await replaceShipperLines(shipper.id, so.id, {
      lines: [{ orderLineId: so.lines[0].orderLineId!, qty: 9, weight: "9.00", lineComplete: false }],
      creditHoldReason: "owner approved",
    }, { canOverrideCreditHold: true });
    expect(after.orders[0].lines[0].qty).toBe(9);
    const [entry] = await readAudit("shipper", shipper.id);
    expect(entry.reason).toBe("owner approved");
  });

  // Round-6 finding, the order-locks.ts house rule applied to the hold: `creditHold` lives on
  // the Customer row, which the gate read WITHOUT a claim — a hold committed concurrently (its
  // own transaction touches no claimed row) was invisible, and the extension slipped through
  // un-overridden. The gate now claims the Customer row (always LAST: Orders → Shipper →
  // Customer), so this holder-transaction race is deterministic: the extension must BLOCK on the
  // held customer lock and then refuse — under Serializable the post-commit read raises the
  // honest 40001→409, and a Read Committed caller would see the fresh hold's 400. Pre-fix, the
  // extension sails through and COMMITS while the holder still holds the customer row.
  it("blocks the extension until a concurrent hold-set commits, then refuses (row-lock discipline)", async () => {
    const { shipper, orderB } = await shipmentPlusSpareOrder();
    const { customerId } = await prisma.shipper.findUniqueOrThrow({
      where: { id: shipper.id }, select: { customerId: true },
    });

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
      hasClaimed();
      await release;
      await tx.customer.update({ where: { id: customerId }, data: { creditHold: true } });
    }, { timeout: 20000 });

    await claimed;
    const addCall = addOrderToShipper(shipper.id, orderB.id)
      .then(() => "resolved" as const, (e: unknown) => e as Error);
    await new Promise((r) => setTimeout(r, 300)); // ample time to reach the gate either way
    mayRelease();
    await holder;

    const settled = await addCall;
    expect(settled).not.toBe("resolved");
    expect(await prisma.shipperOrder.count({ where: { shipperId: shipper.id, orderId: orderB.id } })).toBe(0);
  });

  it("stays un-gated for a customer not on hold", async () => {
    const { shipper, orderB } = await shipmentPlusSpareOrder();
    await expect(addOrderToShipper(shipper.id, orderB.id)).resolves.toBeTruthy();
  });
});
