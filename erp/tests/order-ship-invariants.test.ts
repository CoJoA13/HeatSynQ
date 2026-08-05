import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, addLine, removeLine, updateLine, voidOrder, type OrderDetail } from "@/server/orders";
import { createShipper, voidShipper } from "@/server/shippers";
import type { Customer, Part } from "../prisma/generated/prisma/client";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

// The shippers.test.ts / ship-ledger.test.ts fixture shape, trimmed to what this file needs.
let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `C${customerSeq}`, name: `Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({ data: { customerId, partNumber: `P-${partSeq}`, eachWeight: "1.0000" } });
}

async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `HT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

async function savedOrder(opts: { qty?: number } = {}): Promise<{ order: OrderDetail; part: Part; customer: Customer }> {
  const customer = await makeCustomer();
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    lines: [{ partId: part.id, qty: opts.qty ?? 10, weight: "25.00" }],
  }));
  return { order, part, customer };
}

/** A second, live, orderable part for `order`'s own customer — riders are exempt from the
 *  orderability (steps) check (orders.test.ts's `fixture` precedent, spec §12.4). */
async function addRiderLine(order: OrderDetail, opts: { qty: number; weight: string }): Promise<OrderDetail> {
  const rider = await prisma.part.create({
    data: { customerId: order.customerId, partNumber: `R-${order.id}`, eachWeight: "1.0000" },
  });
  const { order: updated } = await asSystem(() => addLine(order.id, { partId: rider.id, qty: opts.qty, weight: opts.weight }));
  return updated;
}

/** One RIDER order line, shipped `opts.shipped` (default: half of `opts.ordered`) of
 *  `opts.ordered` (default 10) via ONE real shipment through `createShipper` (never raw prisma)
 *  — this file's own coverage is exactly of the invariants `createShipper`'s callers rely on, so
 *  the fixture goes through the same service every real caller does. A RIDER, deliberately, not
 *  the lead (position 1): `removeLine` refuses the lead outright regardless of shipments ("void
 *  the order instead"), which would make the shipment-blocker refusal this fixture exists to
 *  drive unreachable — the lead's own line stays at a trivial qty of 1, never the line under
 *  test. */
async function shipmentOfOneLine(opts: { ordered?: number; shipped?: number } = {}): Promise<{
  order: OrderDetail; line: { id: string; orderId: string }; shipper: { id: string; shipperNumber: number };
}> {
  const ordered = opts.ordered ?? 10;
  const shipped = opts.shipped ?? Math.floor(ordered / 2);
  const { order: base } = await savedOrder({ qty: 1 });
  const order = await addRiderLine(base, { qty: ordered, weight: "25.00" });
  const line = order.lines[1];

  const { shipper } = await createShipper({
    customerId: order.customerId,
    shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: [{ orderLineId: line.id, qty: shipped, weight: "5.00", lineComplete: false }],
      containers: [],
      serials: [],
    }],
  }, { canOverrideCreditHold: false });

  return {
    order, line: { id: line.id, orderId: order.id },
    shipper: { id: shipper.id, shipperNumber: shipper.shipperNumber },
  };
}

describe("order edit invariants after a shipment (spec §5.5)", () => {
  beforeEach(truncateAll);

  it("refuses removing a line that has shipments, naming the shipment", async () => {
    const { order, line, shipper } = await shipmentOfOneLine();
    await expect(asSystem(() => removeLine(order.id, line.id)))
      .rejects.toThrow(new RegExp(`Packing List ${shipper.shipperNumber}`));
  });

  it("allows removing a rider line that has no shipments", async () => {
    const { order } = await savedOrder();
    const withRider = await addRiderLine(order, { qty: 5, weight: "10.00" });
    const rider = withRider.lines[1];
    await expect(asSystem(() => removeLine(order.id, rider.id))).resolves.toBeTruthy();
  });

  it("refuses reducing a line below its shipped-to-date", async () => {
    const { order, line } = await shipmentOfOneLine({ ordered: 1000, shipped: 400 });
    await expect(asSystem(() => updateLine(order.id, line.id, { qty: 300 })))
      .rejects.toThrow(/400 already shipped/i);
    await expect(asSystem(() => updateLine(order.id, line.id, { qty: 400 }))).resolves.toBeTruthy();
  });

  it("refuses reducing a line's weight below its shipped-to-date", async () => {
    // `shipmentOfOneLine` always ships a flat 5.00 lbs (qty is the only thing `opts` varies) — the
    // qty-only mirror of the test above, exercising the SAME `data.weight !== undefined` branch in
    // `updateLine` (orders.ts) that the qty test above never touches.
    const { order, line } = await shipmentOfOneLine({ ordered: 1000, shipped: 400 });
    await expect(asSystem(() => updateLine(order.id, line.id, { weight: 4 })))
      .rejects.toThrow(/5 lbs already shipped/i);
    await expect(asSystem(() => updateLine(order.id, line.id, { weight: 5 }))).resolves.toBeTruthy();
  });

  it("allows increasing a line above its shipped-to-date freely", async () => {
    const { order, line } = await shipmentOfOneLine({ ordered: 1000, shipped: 400 });
    await expect(asSystem(() => updateLine(order.id, line.id, { qty: 2000 }))).resolves.toBeTruthy();
  });

  it("refuses voiding an order with live shipments, and allows it after the shipment is voided", async () => {
    const { order, shipper } = await shipmentOfOneLine();
    await expect(asSystem(() => voidOrder(order.id, "cancelled"))).rejects.toThrow(/live shipment/i);
    await asSystem(() => voidShipper(shipper.id, "cancelled too"));
    await expect(asSystem(() => voidOrder(order.id, "cancelled"))).resolves.toBeUndefined();
  });
});
