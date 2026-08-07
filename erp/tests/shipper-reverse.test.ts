import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder, type OrderDetail } from "@/server/orders";
import { createShipper, reverseShipper, type ShipperDetail } from "@/server/shippers";
import { shippedTotals } from "@/server/ship-ledger";
import { addPartPrice } from "@/server/part-prices";
import { createInvoice, finalizeInvoice } from "@/server/invoices";
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
  Promise<{ order: OrderDetail; shipper: ShipperDetail }> {
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
  return { order, shipper };
}

beforeEach(async () => {
  await truncateAll();
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

  // Spec §5.2 is explicit: OPEN/PARTIAL_SHIPPED/SHIPPED stay ship-derived from the human
  // line-complete flags — "quantities never enter this decision" (ship-ledger.ts). A reversing
  // shipment against an order with NO finalized invoice is therefore left to `recomputeOrderStatus`,
  // two-arg. The original shipment's line is still live AND still line-complete, so the derived
  // value is SHIPPED — NOT OPEN. (The brief's illustrative test guessed OPEN on a net-quantity
  // intuition the spec rejects; a reversal always leaves at least one live shipper line, so `anyLive`
  // is always true and OPEN is unreachable through recompute. What matters is that the status is
  // DERIVED, never forced to the invoice-owned REOPENED.)
  it("leaves a non-invoiced order at its ship-derived status (SHIPPED), never REOPENED", async () => {
    const { order, shipper } = await shippedFixture({ qty: 100 });
    await asSystem(() => reverseShipper(shipper.id, { reason: "returned" }));
    const status = (await getOrder(order.id)).status;
    expect(status).toBe("SHIPPED");
    expect(status).not.toBe("REOPENED");
    // Proven derived: the order id WAS passed to `recomputeOrderStatus`, with no `released`.
    const allRecomputed = recomputeMock.mock.calls.flatMap((c) => c[1]);
    expect(allRecomputed).toContain(order.id);
    const allReleased = recomputeMock.mock.calls.flatMap((c) => c[2] ?? []);
    expect(allReleased).toEqual([]);
  });

  it("refuses to drive a line below zero", async () => {
    const { shipper } = await shippedFixture({ qty: 100 });
    await asSystem(() => reverseShipper(shipper.id, { reason: "first" }));
    await expect(asSystem(() => reverseShipper(shipper.id, { reason: "second" })))
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
});
