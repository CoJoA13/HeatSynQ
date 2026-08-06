import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import {
  createOrder, addLine, removeLine, updateLine, voidOrder, replaceContainers, replaceSerials,
  type OrderDetail,
} from "@/server/orders";
import { createShipper, voidShipper, getShipper, overshipWarnings } from "@/server/shippers";
import { createCert, getCert } from "@/server/certs";
import { addPartInspection } from "@/server/part-inspections";
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

  // Fix-wave (whole-branch review 2026-08-06, Important #2): `shippedTotals` accumulated weight in
  // raw floats, so 0.10 + 0.20 summed to 0.30000000000000004 — turning the §5.5 guard into a hard
  // FALSE refusal of the legal edit-to-exactly-shipped, and making an exactly-complete line warn
  // as over-shipped. The fix sums in integer cents (the `toShipperRow` idiom) and divides once.
  it("0.10 + 0.20 shipped across two shipments: the line edits to exactly 0.30 and no over-ship warning fires", async () => {
    const { order: base } = await savedOrder({ qty: 1 });
    const order = await addRiderLine(base, { qty: 2, weight: "0.30" });
    const line = order.lines[1];

    const shipOnce = (qty: number, weight: string) => asSystem(() => createShipper({
      customerId: order.customerId, shipDate: "2026-08-04",
      orders: [{
        orderId: order.id,
        lines: [{ orderLineId: line.id, qty, weight, lineComplete: false }],
        containers: [], serials: [],
      }],
    }, { canOverrideCreditHold: false }));
    await shipOnce(1, "0.10");
    const second = await shipOnce(1, "0.20");

    // §5.5 permits reducing to EXACTLY the shipped-to-date (the qty/weight tests above pin the
    // same boundary at integer values) — pre-fix this refused with "0.30000000000000004 lbs".
    await expect(asSystem(() => updateLine(order.id, line.id, { weight: 0.3 }))).resolves.toBeTruthy();

    // And the exactly-complete line is NOT over-shipped (§5.7 warns only past the ordered figure)
    // — pre-fix the float artifact pushed shipped-to-date a hair past 0.30 and warned.
    expect(overshipWarnings(await getShipper(second.shipper.id))).toEqual([]);
  });

  it("refuses voiding an order with live shipments, and allows it after the shipment is voided", async () => {
    const { order, shipper } = await shipmentOfOneLine();
    await expect(asSystem(() => voidOrder(order.id, "cancelled"))).rejects.toThrow(/live shipment/i);
    await asSystem(() => voidShipper(shipper.id, "cancelled too"));
    await expect(asSystem(() => voidOrder(order.id, "cancelled"))).resolves.toBeUndefined();
  });

  // Minor 2 (Task 10 review, 2026-08-04): `shipmentBlockerTail`'s pluralized branch ("Packing
  // List X, Packing List Y — void the shipmentS first") was written but never exercised — every
  // other test here blocks on exactly one shipment. Two SEPARATE shipments of the SAME order line
  // (over-shipping only warns, never blocks — spec §5.1/§5.7) is the minimal fixture that puts two
  // live blockers on one `voidOrder` call.
  it("names every live shipment, pluralized, when more than one blocks the same order", async () => {
    const { order } = await savedOrder({ qty: 20 });
    const line = order.lines[0];

    const shipSome = async (qty: number) => {
      const { shipper } = await createShipper({
        customerId: order.customerId,
        shipDate: "2026-08-04",
        orders: [{
          orderId: order.id,
          lines: [{ orderLineId: line.id, qty, weight: "5.00", lineComplete: false }],
          containers: [],
          serials: [],
        }],
      }, { canOverrideCreditHold: false });
      return shipper;
    };

    const first = await shipSome(5);
    const second = await shipSome(5);

    await expect(asSystem(() => voidOrder(order.id, "cancelled"))).rejects.toThrow(
      new RegExp(`Packing List ${first.shipperNumber}.*Packing List ${second.shipperNumber}.*shipments`));
  });
});

// -------------------------------------------------------------------------------------------
// Snapshot + release (owner ruling 2026-08-06, PR #47 review round 2): shipper children snapshot
// the identity they print, and their FKs to the order-side rows release (SET NULL) instead of
// blocking the order-correction APIs. A voided shipment's history survives through the snapshot;
// the order stays correctable through the same APIs it always had.
// -------------------------------------------------------------------------------------------
describe("snapshot + release: order corrections after shipment references", () => {
  beforeEach(truncateAll);

  it("removeLine succeeds once every referencing shipment is voided, and the voided shipment still names the part", async () => {
    const { line, shipper } = await shipmentOfOneLine();
    await asSystem(() => voidShipper(shipper.id, "wrong truck"));

    const removed = await asSystem(() => removeLine(line.orderId, line.id));
    expect(removed.order.lines.map((l) => l.id)).not.toContain(line.id);

    // The voided shipment's grid still renders what shipped — the snapshot, not the dead join.
    const detail = await getShipper(shipper.id);
    const shipLine = detail.orders[0].lines.find((l) => l.qty === 5)!;
    expect(shipLine.partNumber).toMatch(/^R-/);   // the rider part's number, snapshotted
    expect(shipLine.orderLineId).toBeNull();
  });

  it("removeLine succeeds when a cert's frozen requirements reference the line, keeping their identity", async () => {
    // No shipments at all — the FK from CertRequirement alone must not block the removal (round-3
    // finding, 2026-08-06; ruling 23 extended). The requirement keeps rendering from its snapshot.
    const { order } = await savedOrder();
    const withRider = await addRiderLine(order, { qty: 5, weight: "10.00" });
    const rider = withRider.lines[1];
    const code = await prisma.inspectionCode.create({ data: { name: "SSR-Hardness" } });
    await asSystem(() => addPartInspection(rider.partId, { inspectionCodeId: code.id, sort: 0, min: 28, max: 32 }));
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
    expect(cert.requirements.some((r) => r.orderLineId === rider.id)).toBe(true);

    const removed = await asSystem(() => removeLine(order.id, rider.id));
    expect(removed.order.lines.map((l) => l.id)).not.toContain(rider.id);

    const after = await getCert(cert.id);
    const frozen = after.requirements.find((r) => r.orderLineId === null);
    expect(frozen).toBeTruthy();
    expect(frozen!.partNumber).toMatch(/^R-/);   // the rider part's number, snapshotted at seed
    expect(frozen!.linePosition).toBe(2);
  });

  it("replaceContainers keeps working on an order a live shipment references, and the shipment keeps the container's identity", async () => {
    const { order: base } = await savedOrder({ qty: 10 });
    const containerType = await prisma.containerType.create({ data: { name: "Basket" } });
    const bin = await prisma.orderContainer.create({
      data: { orderId: base.id, position: 1, typeId: containerType.id, count: 2, customerContainerId: "BIN-9" },
    });
    const { shipper } = await createShipper({
      customerId: base.customerId, shipDate: "2026-08-04",
      orders: [{
        orderId: base.id,
        lines: [{ orderLineId: base.lines[0].id, qty: 5, weight: "5.00", lineComplete: false }],
        containers: [{ orderContainerId: bin.id, count: 2 }],
        serials: [],
      }],
    }, { canOverrideCreditHold: false });

    // Pre-Phase-4, container corrections were free at any time — they must stay so.
    await expect(asSystem(() => replaceContainers(base.id, []))).resolves.toBeTruthy();

    const detail = await getShipper(shipper.id);
    expect(detail.orders[0].containers).toHaveLength(1);
    expect(detail.orders[0].containers[0].typeName).toBe("Basket");
    expect(detail.orders[0].containers[0].customerContainerId).toBe("BIN-9");
    expect(detail.orders[0].containers[0].orderContainerId).toBeNull();
  });

  it("replaceSerials keeps working on a line a live shipment's serials reference, and the shipment keeps the serial", async () => {
    const { order: base } = await savedOrder({ qty: 10 });
    const serial = await prisma.orderSerial.create({
      data: { orderId: base.id, lineId: base.lines[0].id, position: 1, serial: "SN-77", description: "Heat A1" },
    });
    const { shipper } = await createShipper({
      customerId: base.customerId, shipDate: "2026-08-04",
      orders: [{
        orderId: base.id,
        lines: [{ orderLineId: base.lines[0].id, qty: 5, weight: "5.00", lineComplete: false }],
        containers: [],
        serials: [{ orderSerialId: serial.id, printOnShipper: true }],
      }],
    }, { canOverrideCreditHold: false });

    await expect(asSystem(() => replaceSerials(base.id, base.lines[0].id, []))).resolves.toBeTruthy();

    const detail = await getShipper(shipper.id);
    expect(detail.orders[0].serials).toHaveLength(1);
    expect(detail.orders[0].serials[0].serial).toBe("SN-77");
    expect(detail.orders[0].serials[0].description).toBe("Heat A1");
    expect(detail.orders[0].serials[0].orderSerialId).toBeNull();
  });
});
