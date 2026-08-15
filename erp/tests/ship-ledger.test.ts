import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, addLine, getOrder, voidOrder, type OrderDetail } from "@/server/orders";
import { claimOrdersInOrder, sortedClaimIds } from "@/server/order-locks";
import { shippedTotals, recomputeOrderStatus, nextShipmentSequence } from "@/server/ship-ledger";
import type { Customer, Part } from "../prisma/generated/prisma/client";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

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

/** Gives a part revision 1 with one step — the orderability precondition `createOrder` enforces
 *  (spec §5.3) for a LEAD part. Raw prisma on purpose (the certs.test.ts/orders.test.ts
 *  precedent): this file's own coverage must not depend on part-process-steps.ts. */
async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `HT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

/** A live, orderable customer + part, and the ORDER created from it — the certs.test.ts
 *  `savedOrder` precedent, trimmed to what this file needs. */
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

/** `savedOrder`, plus a stable `{ id, orderId }` reference to its one (lead) line — the shape
 *  `shipLine` below and the status tests need, without dragging the whole `OrderDetail` line
 *  entry (which carries no `orderId` of its own) through every call site. */
async function oneLineOrder(opts: { qty?: number } = {}): Promise<{
  order: OrderDetail; line: { id: string; orderId: string }; part: Part; customer: Customer;
}> {
  const { order, part, customer } = await savedOrder(opts);
  return { order, line: { id: order.lines[0].id, orderId: order.id }, part, customer };
}

/** `n` distinct, live orders' ids, sorted ascending. Sequential, deliberately: `createOrder` runs
 *  Serializable and its own `allocateNumber` claim is a write-write conflict under concurrent
 *  callers (orders.test.ts's `createConcurrently` documents this exact, expected 409) — nothing
 *  below needs the orders to exist at the SAME instant, only to exist as distinct rows, so
 *  `Promise.all` here would just be trading determinism for a race this file has no interest in. */
async function savedOrderIds(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) ids.push((await savedOrder()).order.id);
  return ids.sort();
}

/** A second, live, orderable part for `order`'s own customer — riders are exempt from the
 *  orderability (steps) check (orders.test.ts's own `fixture` comment, spec §12.4), so no
 *  `giveSteps` here. */
async function makeRider(order: { customerId: string }): Promise<Part> {
  return makePart(order.customerId);
}

let shipperNumberSeq = 8000;
/** A minimal, live Shipper + ShipperOrder pairing for `order` at `sequence` — raw prisma, on
 *  purpose (fixtures note, task-7-brief.md): `shippers.ts` (Task 8) does not exist yet, and this
 *  file's own coverage of `nextShipmentSequence`/the sorted claim must not depend on it. Mirrors
 *  certs.test.ts's own `makeShipment`. */
async function makeShipment(
  order: { id: string; customerId: string }, sequence: number,
): Promise<{ id: string; shipperNumber: number }> {
  shipperNumberSeq += 1;
  const shipper = await prisma.shipper.create({
    data: { shipperNumber: shipperNumberSeq, customerId: order.customerId, shipDate: new Date() },
  });
  await prisma.shipperOrder.create({
    data: { shipperId: shipper.id, orderId: order.id, sequence, position: sequence },
  });
  return shipper;
}

let shipLineSeq = 0;
/**
 * Ships `opts.qty`/`opts.lineComplete` of `line` on a FRESH Shipper + ShipperOrder — raw prisma,
 * the fixtures-note precedent, standing in for what Task 8's real `createShipper` will do: write
 * the ledger rows AND recompute the order's status in the SAME transaction (spec §5.2,
 * "recomputed inside the same transaction as every shipment mutation"). Each call opens its own
 * Shipper so the SAME order line can be shipped more than once in one test without colliding on
 * `ShipperLine`'s `@@unique([shipperOrderId, orderLineId])`.
 */
async function shipLine(
  line: { id: string; orderId: string }, opts: { qty: number; lineComplete: boolean; weight?: string },
): Promise<{ shipperId: string; shipperOrderId: string; shipperLineId: string }> {
  shipLineSeq += 1;
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: line.orderId }, select: { customerId: true },
    });
    const shipper = await tx.shipper.create({
      data: { shipperNumber: 90_000 + shipLineSeq, customerId: order.customerId, shipDate: new Date() },
    });
    const shipperOrder = await tx.shipperOrder.create({
      data: { shipperId: shipper.id, orderId: line.orderId, sequence: shipLineSeq, position: 1 },
    });
    const shipperLine = await tx.shipperLine.create({
      data: {
        shipperOrderId: shipperOrder.id, orderLineId: line.id, position: 1,
        qty: opts.qty, weight: opts.weight ?? "10.00", lineComplete: opts.lineComplete,
        partNumber: "SL-PART", orderedQty: opts.qty, orderedWeight: opts.weight ?? "10.00",
      },
    });
    await recomputeOrderStatus(tx, [line.orderId]);
    return { shipperId: shipper.id, shipperOrderId: shipperOrder.id, shipperLineId: shipperLine.id };
  });
}

/** A fully-shipped order — its one line shipped line-complete, so `recomputeOrderStatus` derives
 *  SHIPPED. No invoice: Task 13's invoice-owned-state tests set `status` directly and prove the
 *  skip is driven by the stored status, not by any invoice. */
async function shippedOrder(opts: { qty?: number } = {}): Promise<{ order: OrderDetail; line: { id: string; orderId: string } }> {
  const { order, line } = await oneLineOrder({ qty: opts.qty ?? 10 });
  await shipLine(line, { qty: opts.qty ?? 10, lineComplete: true });
  return { order, line };
}

/** One order line, shipped via TWO separate shipments of `qtyA` and `qtyB` — the
 *  `shippedTotals` void-exclusion test's own fixture. */
async function twoShipmentsOf(qtyA: number, qtyB: number): Promise<{
  orderLine: { id: string; orderId: string };
  shipperA: { id: string }; shipperB: { id: string };
}> {
  const { order } = await savedOrder({ qty: qtyA + qtyB });
  const orderLine = { id: order.lines[0].id, orderId: order.id };
  const a = await shipLine(orderLine, { qty: qtyA, lineComplete: false, weight: "3.00" });
  const b = await shipLine(orderLine, { qty: qtyB, lineComplete: false, weight: "2.00" });
  return { orderLine, shipperA: { id: a.shipperId }, shipperB: { id: b.shipperId } };
}

describe("shippedTotals", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("excludes voided shipments from shipped-to-date", async () => {
    const { orderLine, shipperA } = await twoShipmentsOf(300, 200);
    expect((await shippedTotals(prisma, [orderLine.id])).get(orderLine.id)!.qty).toBe(500);
    expect((await shippedTotals(prisma, [orderLine.id])).get(orderLine.id)!.weight).toBeCloseTo(5, 5);

    await prisma.shipper.update({ where: { id: shipperA.id }, data: { deletedAt: new Date() } });

    expect((await shippedTotals(prisma, [orderLine.id])).get(orderLine.id)!.qty).toBe(200);
    expect((await shippedTotals(prisma, [orderLine.id])).get(orderLine.id)!.weight).toBeCloseTo(2, 5);
  });

  it("has no entry for a line with no live shipment at all", async () => {
    const { line } = await oneLineOrder({});
    expect((await shippedTotals(prisma, [line.id])).has(line.id)).toBe(false);
  });

  it("returns an empty map for an empty id list", async () => {
    expect((await shippedTotals(prisma, [])).size).toBe(0);
  });
});

describe("recomputeOrderStatus (via getOrder)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("derives status from ship-line-complete, never from quantity", async () => {
    const { order, line } = await oneLineOrder({ qty: 1000 });

    await shipLine(line, { qty: 1000, lineComplete: false }); // full quantity, NOT complete
    expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");

    await shipLine(line, { qty: 1, lineComplete: true }); // one piece, complete
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
  });

  it("stays OPEN with no live shipper lines at all", async () => {
    const { order } = await oneLineOrder({});
    expect((await getOrder(order.id)).status).toBe("OPEN");
  });

  it("returns a SHIPPED order to PARTIAL_SHIPPED when a rider line is added", async () => {
    const { order, line } = await oneLineOrder({});
    await shipLine(line, { qty: 10, lineComplete: true });
    expect((await getOrder(order.id)).status).toBe("SHIPPED");

    const rider = await makeRider(order);
    await asSystem(() => addLine(order.id, { partId: rider.id, qty: 5, weight: "10.00" }));
    expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
  });

  it("leaves a voided order's status untouched", async () => {
    const { order, line } = await oneLineOrder({});
    const shipped = await shipLine(line, { qty: 10, lineComplete: true });
    expect((await getOrder(order.id)).status).toBe("SHIPPED");

    // Task 10, spec §5.5: `voidOrder` now refuses an order with a LIVE shipment attached — void
    // the shipment first, directly (this file's own `shipLine` is already raw prisma standing in
    // for a real `createShipper` write, the fixtures-note precedent). This does NOT itself call
    // `recomputeOrderStatus`, so the order's `status` column is left exactly SHIPPED, same as the
    // assertion just above — the fixture change has no bearing on what this test is actually
    // proving below.
    await prisma.shipper.update({ where: { id: shipped.shipperId }, data: { deletedAt: new Date() } });

    await asSystem(() => voidOrder(order.id, "test void"));

    // A second, incomplete line, added directly (voidOrder refuses addLine on a voided order, so
    // this bypasses the service on purpose) — if recomputeOrderStatus did NOT skip voided orders,
    // recomputing now would find one line with no live-complete shipper line and flip this order
    // to PARTIAL_SHIPPED. That it does NOT is the proof the skip is real, not incidental.
    const rider = await makeRider(order);
    await prisma.orderLine.create({
      data: { orderId: order.id, position: 2, partId: rider.id, qty: 5, weight: "5.00" },
    });

    await prisma.$transaction((tx) => recomputeOrderStatus(tx, [order.id]));

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id }, select: { status: true, deletedAt: true },
    });
    expect(row.deletedAt).not.toBeNull();
    expect(row.status).toBe("SHIPPED");
  });
});

describe("recomputeOrderStatus — invoice-owned states (Task 13)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("leaves an INVOICED order alone", async () => {
    const { order } = await shippedOrder();
    await prisma.order.update({ where: { id: order.id }, data: { status: "INVOICED" } });
    await prisma.$transaction((tx) => recomputeOrderStatus(tx, [order.id]));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("INVOICED");
  });

  it("leaves a REOPENED order alone", async () => {
    const { order } = await shippedOrder();
    await prisma.order.update({ where: { id: order.id }, data: { status: "REOPENED" } });
    await prisma.$transaction((tx) => recomputeOrderStatus(tx, [order.id]));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REOPENED");
  });

  it("recomputes an order that unlock explicitly releases, even though it is INVOICED", async () => {
    const { order } = await shippedOrder();
    await prisma.order.update({ where: { id: order.id }, data: { status: "INVOICED" } });
    // The `released` escape hatch unlock uses: the skip is lifted for this order only, so it settles
    // back on its ship-derived value (SHIPPED) instead of being skipped INVOICED forever.
    await prisma.$transaction((tx) => recomputeOrderStatus(tx, [order.id], [order.id]));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("SHIPPED");
  });
});

describe("nextShipmentSequence", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("never reissues a shipment sequence after a void", async () => {
    const { order } = await savedOrder();
    await makeShipment(order, 1);
    const second = await makeShipment(order, 2);
    await prisma.shipper.update({ where: { id: second.id }, data: { deletedAt: new Date() } });

    const next = await prisma.$transaction((tx) => nextShipmentSequence(tx, order.id));
    expect(next).toBe(3); // NOT 2 — the voided shipment's number is already on paper
  });

  it("starts at 1 for an order with no shipments yet", async () => {
    const { order } = await savedOrder();
    const next = await prisma.$transaction((tx) => nextShipmentSequence(tx, order.id));
    expect(next).toBe(1);
  });
});

describe("sortedClaimIds", () => {
  it("dedupes and sorts ascending, independent of caller order", () => {
    expect(sortedClaimIds(["c", "a", "b", "a"])).toEqual(["a", "b", "c"]);
  });

  it("is a pure no-op on an already-sorted, deduped list", () => {
    expect(sortedClaimIds(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("claimOrdersInOrder", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("returns every requested order sorted ascending by id, regardless of caller order", async () => {
    const [a, b, c] = await savedOrderIds(3);

    const claimed = await prisma.$transaction((tx) => claimOrdersInOrder(tx, [c, a, b]));
    expect(claimed.map((o) => o.id)).toEqual([a, b, c]);
  });

  it("dedupes a repeated id", async () => {
    const { order } = await savedOrder();
    const claimed = await prisma.$transaction((tx) => claimOrdersInOrder(tx, [order.id, order.id]));
    expect(claimed.map((o) => o.id)).toEqual([order.id]);
  });

  it("returns an empty array for no ids", async () => {
    const claimed = await prisma.$transaction((tx) => claimOrdersInOrder(tx, []));
    expect(claimed).toEqual([]);
  });

  // The hazard this exists to rule out (spec §5.3): two multi-order saves touching {A,B} and
  // {B,A} deadlock if each claims in its OWN (caller) order — save 1 locks A then waits on B,
  // save 2 locks B then waits on A, a classic ABBA cycle Postgres can only resolve by aborting
  // one side after `deadlock_timeout`. `claimOrdersInOrder` avoids the cycle entirely by claiming
  // both rows in ONE statement, ordered ascending by id (order-locks.ts's own comment: confirmed
  // by hand with EXPLAIN that `LockRows` sits ABOVE `Sort` in the plan, so the SQL-level ORDER BY
  // really is the lock-acquisition order, not just the output order) — whichever transaction's
  // statement reaches Postgres first locks BOTH rows in the same pass; the other blocks on the
  // first row alone, never holding the second while it waits, so no cycle can form.
  //
  // Verified by hand (see the task report for both transcripts): swapping this function's body
  // for a loop of single-row `claimOrder` calls IN THE CALLER'S OWN ORDER (the exact anti-pattern
  // spec §5.3 names) reliably deadlocks two genuinely concurrent callers — Postgres aborts one
  // side with a 40P01 error after `deadlock_timeout`, which surfaces as a rejected promise here.
  // Reproducing it needed a short artificial delay BETWEEN the naive loop's two per-row claims
  // (this local Postgres is fast enough that one side's whole two-statement loop often finished
  // before the other's first statement even landed, so the plain swap alone was NOT a reliable
  // RED on its own) — with that delay it deadlocked 3/3 hand-verified runs. Reverting to the
  // single ordered statement below turns it GREEN again, delay or no delay, because that
  // statement has no window between claims for the other side to land a competing lock in.
  it("claims two orders concurrently in either caller order without deadlocking (not a deterministic row-lock regression guard — see comment)", async () => {
    const [a, b] = await savedOrderIds(2);

    const [claimedAB, claimedBA] = await Promise.all([
      prisma.$transaction((tx) => claimOrdersInOrder(tx, [a, b])),
      prisma.$transaction((tx) => claimOrdersInOrder(tx, [b, a])),
    ]);

    expect(claimedAB.map((o) => o.id)).toEqual([a, b]);
    expect(claimedBA.map((o) => o.id)).toEqual([a, b]);
  });
});
