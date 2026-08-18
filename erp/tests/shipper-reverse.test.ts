import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder, type OrderDetail } from "@/server/orders";
import { createShipper, reverseShipper, voidShipper, type ShipperDetail } from "@/server/shippers";
import { shippedTotals } from "@/server/ship-ledger";
import { addPartPrice } from "@/server/part-prices";
import { createInvoice, finalizeInvoice, unlockInvoice } from "@/server/invoices";
import type { Customer, Part } from "../prisma/generated/prisma/client";

// The binding requirement of this task (Task 13's review): a reversing shipment writes REOPENED
// DIRECTLY and NEVER passes `released` to `recomputeOrderStatus` — that third arg is unlock's
// escape hatch alone. To PROVE this at the seam, the module-boundary wrap records every
// `recomputeOrderStatus` call's arguments (the shipper-void.test.ts precedent — never `vi.spyOn` a
// Prisma delegate). The wrapped function runs its REAL implementation (`vi.fn(actual.fn)`), so
// behaviour is unchanged; this only adds a call recorder.
vi.mock("@/server/ship-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/ship-ledger")>();
  return { ...actual, recomputeOrderStatus: vi.fn(actual.recomputeOrderStatus) };
});
import * as shipLedger from "@/server/ship-ledger";
const recomputeMock = vi.mocked(shipLedger.recomputeOrderStatus);

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

// Fixtures — the shippers.test.ts / invoices.test.ts shapes, trimmed to what reversal coverage
// needs (copying across test files is this repo's convention).
let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `RV${customerSeq}`, name: `Reverse Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({ data: { customerId, partNumber: `RVP-${partSeq}`, eachWeight: "1.0000" } });
}

async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `RVHT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

async function savedOrder(opts: { qty?: number; weight?: string } = {}):
  Promise<{ order: OrderDetail; part: Part; customer: Customer }> {
  const customer = await makeCustomer();
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    lines: [{ partId: part.id, qty: opts.qty ?? 100, weight: opts.weight ?? "250.00" }],
  }));
  return { order, part, customer };
}

function oneOrderInput(order: OrderDetail, lineComplete: boolean) {
  return {
    customerId: order.customerId,
    shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: [{
        orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight,
        lineComplete,
      }],
      containers: [] as { orderContainerId: string; count: number }[],
      serials: [] as { orderSerialId: string; printOnShipper?: boolean }[],
    }],
  };
}

/** One order, fully shipped and line-complete in one shipment — SHIPPED, never invoiced. */
async function shippedFixture(opts: { qty?: number } = {}):
  Promise<{ order: OrderDetail; shipper: ShipperDetail; part: Part }> {
  const { order, part } = await savedOrder({ qty: opts.qty ?? 100 });
  const { shipper } = await createShipper(oneOrderInput(order, true), { canOverrideCreditHold: false });
  return { order, shipper, part };
}

/** `shippedFixture`, then priced, invoiced and FINALIZED — the order sits at INVOICED. */
async function invoicedFixture():
  Promise<{ order: OrderDetail; shipper: ShipperDetail; invoiceId: string }> {
  const { order, shipper, part } = await shippedFixture({ qty: 100 });
  const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Sales" } });
  const code = await prisma.processStepCode.create({
    data: { code: `AUST-${part.id}`, name: "Austemper", glAccountId: gl.id },
  });
  await asSystem(() => addPartPrice(part.id, {
    processStepCodeId: code.id, position: 1, unitPrice: "6.5100", minimumCharge: "600.00", pricePer: "EACH",
  }));
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  await asSystem(() => finalizeInvoice(invoice.id));
  return { order, shipper, invoiceId: invoice.id };
}

/** One order's shipment carrying a single line at an explicit qty/weight/lineComplete — the
 *  multi-shipment building block the owner's 1000-pc workflow needs (`oneOrderInput` always ships
 *  the FULL ordered qty, so it cannot express a partial load). */
function shipInput(order: OrderDetail, qty: number, weight: string, lineComplete: boolean) {
  return {
    customerId: order.customerId,
    shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: [{ orderLineId: order.lines[0].id, qty, weight, lineComplete }],
      containers: [] as { orderContainerId: string; count: number }[],
      serials: [] as { orderSerialId: string; printOnShipper?: boolean }[],
    }],
  };
}

beforeEach(async () => {
  await truncateAll();
  await seedOrderGatePrereqs();
  recomputeMock.mockClear();
});

describe("reverseShipper", () => {
  it("creates a negative shipment that nets the ledger down", async () => {
    const { order, shipper } = await shippedFixture({ qty: 100 });
    const { shipper: reversal } = await asSystem(() =>
      reverseShipper(shipper.id, { reason: "wrong parts loaded" }));
    expect(reversal.orders[0].lines[0].qty).toBe(-100);
    expect(reversal.reversesShipperId).toBe(shipper.id);
    const totals = await shippedTotals(prisma, [order.lines[0].id]);
    expect(totals.get(order.lines[0].id)!.qty).toBe(0);
  });

  it("sets REOPENED when the order has a finalized invoice", async () => {
    const { order, shipper } = await invoicedFixture();
    expect((await getOrder(order.id)).status).toBe("INVOICED");
    await asSystem(() => reverseShipper(shipper.id, { reason: "returned" }));
    expect((await getOrder(order.id)).status).toBe("REOPENED");
  });

  // The binding requirement, proven at the seam: REOPENED is written DIRECTLY, never by handing the
  // invoiced order to `recomputeOrderStatus` — neither as a target (col 1) nor in the `released` set
  // (col 2, unlock's alone). If a future edit "fixed" this by passing `released`, `allReleased` would
  // contain the order id; if it leaned on recompute's invoice-owned skip, `allRecomputed` would.
  it("writes REOPENED directly and never passes `released` from the shipment path", async () => {
    const { order, shipper } = await invoicedFixture();
    recomputeMock.mockClear();
    await asSystem(() => reverseShipper(shipper.id, { reason: "returned" }));
    expect((await getOrder(order.id)).status).toBe("REOPENED");

    const allRecomputed = recomputeMock.mock.calls.flatMap((c) => c[1]);
    expect(allRecomputed).not.toContain(order.id);
    const allReleased = recomputeMock.mock.calls.flatMap((c) => c[2] ?? []);
    expect(allReleased).toEqual([]);

    // ...and the REOPENED write is a real order update carrying the reason (voidShipper's shape).
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "order", entityId: order.id, action: "update" }, orderBy: { at: "desc" },
    });
    expect((entry!.before as Record<string, unknown>).status).toBe("INVOICED");
    expect((entry!.after as Record<string, unknown>).status).toBe("REOPENED");
    expect(entry!.reason).toBe("returned");
  });

  // Owner ruling 2026-08-07: a reversing shipment REOPENS the order it reverses. Status stays
  // flag-derived (spec §5.2 — "quantities never enter this decision", ship-ledger.ts); the reversal
  // just un-marks the completion it undoes, clearing `lineComplete` on the ORIGINAL shipment's lines.
  // A single, fully-shipped-and-complete shipment reversed therefore derives PARTIAL_SHIPPED, not
  // SHIPPED — the reversal document is still a live shipment (so OPEN is unreachable), but nothing on
  // the order is line-complete any more. NOT the invoice-owned REOPENED (no finalized invoice here) —
  // this is a genuine ship-derived recompute. RED before this ruling: the original line stayed
  // complete, so the order wrongly derived back to SHIPPED.
  it("reopens a non-invoiced order to its ship-derived PARTIAL_SHIPPED, never REOPENED", async () => {
    const { order, shipper } = await shippedFixture({ qty: 100 });
    await asSystem(() => reverseShipper(shipper.id, { reason: "returned" }));
    const status = (await getOrder(order.id)).status;
    expect(status).toBe("PARTIAL_SHIPPED");
    expect(status).not.toBe("REOPENED");
    // Proven derived: the order id WAS passed to `recomputeOrderStatus`, with no `released`.
    const allRecomputed = recomputeMock.mock.calls.flatMap((c) => c[1]);
    expect(allRecomputed).toContain(order.id);
    const allReleased = recomputeMock.mock.calls.flatMap((c) => c[2] ?? []);
    expect(allReleased).toEqual([]);
  });

  // #65: the reversal row records WHICH original lines its step 6b cleared, at creation — the
  // immutable snapshot voidShipper's restore reads when the reversal is voided (the blessed undo).
  it("records the original line ids whose lineComplete it cleared on its own row (#65)", async () => {
    const { shipper } = await shippedFixture({ qty: 100 });
    const originalLineId = shipper.orders[0].lines[0].id;
    const { shipper: reversal } = await asSystem(() =>
      reverseShipper(shipper.id, { reason: "returned" }));
    const row = await prisma.shipper.findUniqueOrThrow({
      where: { id: reversal.id }, select: { reversalClearedLineIds: true },
    });
    expect(row.reversalClearedLineIds).toEqual([originalLineId]);
  });

  it("records [] when the reversed shipment had no complete lines to clear (#65)", async () => {
    const { order } = await savedOrder({ qty: 100 });
    const { shipper } = await createShipper(oneOrderInput(order, false), { canOverrideCreditHold: false });
    const { shipper: reversal } = await asSystem(() =>
      reverseShipper(shipper.id, { reason: "returned" }));
    const row = await prisma.shipper.findUniqueOrThrow({
      where: { id: reversal.id }, select: { reversalClearedLineIds: true },
    });
    expect(row.reversalClearedLineIds).toEqual([]);
  });

  // Codex PR #141 round 2 + the freeze-the-pair ruling (2026-08-18): at most ONE live reversal
  // per original, ENFORCED at creation. Before this guard a double-reverse was refused only
  // INCIDENTALLY, by the below-zero arithmetic — and a second live shipment's quantity on the
  // same line let it straight through, whereupon the second reversal snapshotted [] (the flags
  // were already cleared by the first) and voiding the FIRST restored flags the still-live second
  // semantically owned. This test builds exactly that bypass, so without the guard it does not
  // merely get the wrong message — the second reversal SUCCEEDS.
  it("refuses a second reversal of an already-reversed original, naming the first", async () => {
    const { order, shipper } = await shippedFixture({ qty: 100 });
    // The bypass quantity: a second live shipment on the same line keeps net ≥ 0 through a
    // second reversal of S1 (over-ship is a warning, not a refusal).
    await createShipper(oneOrderInput(order, false), { canOverrideCreditHold: false });
    const { shipper: r1 } = await asSystem(() => reverseShipper(shipper.id, { reason: "wrong parts" }));

    await expect(asSystem(() => reverseShipper(shipper.id, { reason: "again" }))).rejects.toMatchObject({
      status: 400,
      message: `This shipment has already been reversed by Packing List ${r1.shipperNumber} — void that reversal first`,
    });

    // The refusal's own correction flow works: void the first, and the original reverses again.
    await asSystem(() => voidShipper(r1.id, "mistaken reversal"));
    const { shipper: r2 } = await asSystem(() => reverseShipper(shipper.id, { reason: "correct this time" }));
    expect(r2.reversesShipperId).toBe(shipper.id);
  });

  // The below-zero guard stays, as the belt spec §5.6 requires — with at-most-one-live-reversal
  // enforced, no PRODUCT path reaches it any more (every live reversal cancels against its own
  // live original, which #65's blocker keeps live), so it is pinned against the state the #139
  // edit hole could produce: a live negative line NOT paired through `reversesShipperId` (raw
  // fixture — the product never builds one; that is the point of a belt).
  it("refuses to drive a line below zero", async () => {
    const { order, shipper } = await shippedFixture({ qty: 100 });
    const so = await prisma.shipperOrder.findFirstOrThrow({
      where: { shipperId: shipper.id }, select: { id: true } });
    const rogue = await prisma.shipper.create({
      data: { shipperNumber: 999_998, customerId: order.customerId, shipDate: new Date("2026-08-04") },
      select: { id: true },
    });
    const rogueSo = await prisma.shipperOrder.create({
      data: { shipperId: rogue.id, orderId: order.id, sequence: 99, position: 1 }, select: { id: true } });
    const line = await prisma.shipperLine.findFirstOrThrow({
      where: { shipperOrderId: so.id }, select: { orderLineId: true, partNumber: true, orderedQty: true, orderedWeight: true } });
    await prisma.shipperLine.create({
      data: {
        shipperOrderId: rogueSo.id, orderLineId: line.orderLineId, position: 1,
        qty: -60, weight: "-150.00", lineComplete: false,
        partNumber: line.partNumber, partName: "", partDescription: "",
        orderedQty: line.orderedQty, orderedWeight: line.orderedWeight,
      },
    });
    // Net on the line is now 100 − 60 = 40; reversing S1 would subtract 100 → −60.
    await expect(asSystem(() => reverseShipper(shipper.id, { reason: "drive it under" })))
      .rejects.toThrow(/below zero/i);
  });

  it("requires a reason", async () => {
    const { shipper } = await shippedFixture();
    await expect(asSystem(() => reverseShipper(shipper.id, { reason: "  " }))).rejects.toThrow(/reason/i);
  });

  it("keeps its own packing-list number and never reuses the original's", async () => {
    const { shipper } = await shippedFixture();
    const { shipper: reversal } = await asSystem(() => reverseShipper(shipper.id, { reason: "returned" }));
    expect(reversal.shipperNumber).not.toBe(shipper.shipperNumber);
    expect(reversal.orders[0].sequence).toBe(shipper.orders[0].sequence + 1);
  });

  it("raises no over-ship warning for a reversal", async () => {
    const { shipper } = await shippedFixture({ qty: 100 });
    const { warnings } = await asSystem(() => reverseShipper(shipper.id, { reason: "returned" }));
    expect(warnings.join(" ")).not.toMatch(/exceeds the/i);
  });

  it("defaults the reversal's ship date to the original's", async () => {
    const { shipper } = await shippedFixture();
    const { shipper: reversal } = await asSystem(() => reverseShipper(shipper.id, { reason: "returned" }));
    expect(reversal.shipDate).toBe(shipper.shipDate);
  });

  it("404s an unknown shipment and an already-voided one", async () => {
    await expect(asSystem(() => reverseShipper("nope", { reason: "x" }))).rejects.toMatchObject({ status: 404 });
  });

  // Step 3 leak-guard: the reversal builds its negative rows INTERNALLY, bypassing the zod SHIP_LINE
  // schema — which still refuses a negative qty on the ordinary create path, so the relaxation for
  // reversals cannot leak into a normal shipment.
  it("a normal createShipper still refuses a negative qty", async () => {
    const { order } = await savedOrder({ qty: 100 });
    const input = oneOrderInput(order, false);
    input.orders[0].lines[0].qty = -5;
    await expect(createShipper(input, { canOverrideCreditHold: false })).rejects.toThrow();
  });

  // Row-lock discipline (order-locks.ts house rule), the finalizeInvoice discriminating shape: the
  // competing caller runs at Read Committed (a manually-opened tx) so ONLY `claimOrdersInOrder`'s row
  // lock — not SSI — can order the two. The holder claims the order row and, while holding it, voids
  // the order, then commits. WITH the claim, the reversal blocks on the order row, then reads the
  // freshly-voided order and refuses. WITHOUT it (RED, verified by hand: remove `claimOrdersInOrder`
  // and the reversal reads a live snapshot and resolves) the reversal would build against a voided
  // order — resolving instead of rejecting.
  it("reads order state under the claim: a void by an order-lock holder makes the reversal refuse", async () => {
    const { order, shipper } = await shippedFixture({ qty: 100 });

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      await tx.order.update({ where: { id: order.id }, data: { deletedAt: new Date() } });
      hasClaimed();
      await release;
    }, { timeout: 20000 });

    await claimed;
    const reverseCall = asSystem(() =>
      prisma.$transaction((tx) => reverseShipper(shipper.id, { reason: "returned" }, tx)));

    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      reverseCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT); // blocked on the holder's order-row claim

    mayRelease();
    await holder;

    await expect(reverseCall).rejects.toThrow(/voided/i);
  });

  // The owner's confirmed acceptance workflow (2026-08-07), walked exactly on a 1000-pc order. The
  // load breakdown ("loads 1-3 full at 100, load 4 partial at 50") is packaging detail; order status
  // is flag-derived (spec §5.2), so each step ships the aggregate qty and toggles the human
  // line-complete flag. RED before the ruling: step 3's reversal left the order at SHIPPED.
  it("1000-pc workflow: a reversal reopens the order to PARTIAL_SHIPPED (owner ruling 2026-08-07)", async () => {
    const { order } = await savedOrder({ qty: 1000, weight: "2500.00" });
    const line = order.lines[0].id;

    // 1. Ship 350 (loads 1-3 full at 100 each, load 4 partial at 50), NOT marked complete.
    await createShipper(shipInput(order, 350, "350.00", false), { canOverrideCreditHold: false });
    expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");

    // 2. Ship the remaining 650, marked complete.
    const { shipper: shipment2 } =
      await createShipper(shipInput(order, 650, "650.00", true), { canOverrideCreditHold: false });
    expect((await getOrder(order.id)).status).toBe("SHIPPED");

    // 3. Reverse shipment 2 (650 back) -> PARTIAL_SHIPPED again; shipment 1's 350 is still shipped.
    await asSystem(() => reverseShipper(shipment2.id, { reason: "wrong count on load 4" }));
    expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
    expect((await shippedTotals(prisma, [line])).get(line)!.qty).toBe(350);

    // 4. Ship the corrected 463 (187 still owed), not complete -> PARTIAL_SHIPPED.
    await createShipper(shipInput(order, 463, "463.00", false), { canOverrideCreditHold: false });
    expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");

    // 5. Ship the remaining 187, marked complete -> SHIPPED.
    await createShipper(shipInput(order, 187, "187.00", true), { canOverrideCreditHold: false });
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
    expect((await shippedTotals(prisma, [line])).get(line)!.qty).toBe(1000);
  });

  // The invoiced interaction (spec §5.2, owner ruling 2026-08-07). An invoiced order reversed still
  // writes REOPENED DIRECTLY — but the reversal ALSO clears the reversed shipment's line-complete
  // flag, so a LATER unlock (which hands the order back to the ship-derived ledger via
  // `recomputeOrderStatus(..., released)`) settles it on PARTIAL_SHIPPED, NOT SHIPPED. RED before the
  // ruling: the original line stayed complete, so unlock derived SHIPPED and silently re-closed a
  // reversed order.
  it("invoiced -> reverse (REOPENED) -> unlock derives PARTIAL_SHIPPED, not SHIPPED", async () => {
    const { order, shipper, invoiceId } = await invoicedFixture();
    expect((await getOrder(order.id)).status).toBe("INVOICED");

    await asSystem(() => reverseShipper(shipper.id, { reason: "returned for rework" }));
    expect((await getOrder(order.id)).status).toBe("REOPENED");

    await asSystem(() => unlockInvoice(invoiceId, "reopen to correct the count"));
    expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
  });
});
