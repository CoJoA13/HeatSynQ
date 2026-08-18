import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder, type OrderDetail } from "@/server/orders";
import {
  createShipper, voidShipper, reverseShipper, removeOrderFromShipper, getShipper,
  type ShipperDetail,
} from "@/server/shippers";
import { storeDocument, getDocument } from "@/server/documents";
import { addPartPrice } from "@/server/part-prices";
import { createInvoice, finalizeInvoice } from "@/server/invoices";
import type { Customer, Part } from "../prisma/generated/prisma/client";
import type { CertScopeValue } from "@/lib/cert-constants";

// House-legal module-boundary mock (CLAUDE.md: never `vi.spyOn` a Prisma delegate — this wraps a
// LEAF service module instead, the `shipper-children.test.ts` precedent for mocking at a boundary
// rather than a Prisma model method). The wrapped function still runs its REAL implementation
// (`vi.fn(actual.fn)`) — this only adds a call recorder, never changes behaviour. Needed for the
// "voidShipper never claims a previously-removed order" regression test below, which has to
// observe exactly which order ids `voidShipper` claims, not merely what it writes.
vi.mock("@/server/order-locks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/order-locks")>();
  return { ...actual, claimOrdersInOrder: vi.fn(actual.claimOrdersInOrder) };
});
import * as orderLocks from "@/server/order-locks";

// Same boundary wrap for `recomputeOrderStatus` (the shipper-reverse.test.ts precedent) — the #65
// legacy-`[]` test has to prove the void still RECOMPUTES even when it restores nothing, which no
// data assertion alone can show (the status genuinely does not change in that case).
vi.mock("@/server/ship-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/ship-ledger")>();
  return { ...actual, recomputeOrderStatus: vi.fn(actual.recomputeOrderStatus) };
});
import * as shipLedger from "@/server/ship-ledger";
const { shippedTotals } = shipLedger; // the real implementation, spread through the wrap
const recomputeMock = vi.mocked(shipLedger.recomputeOrderStatus);

const claimOrdersInOrderMock = vi.mocked(orderLocks.claimOrdersInOrder);

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

// The shippers.test.ts fixture shape, trimmed to what void coverage needs.
let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `C${customerSeq}`, name: `Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(
  customerId: string, opts: { certRequired?: boolean | null; certScope?: CertScopeValue | null } = {},
): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({
    data: {
      customerId, partNumber: `P-${partSeq}`, eachWeight: "1.0000",
      certRequired: opts.certRequired ?? null, certScope: opts.certScope ?? null,
    },
  });
}

async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `HT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

async function savedOrder(opts: {
  certRequired?: boolean; certScope?: CertScopeValue; qty?: number;
} = {}): Promise<{ order: OrderDetail; part: Part; customer: Customer }> {
  const customer = await makeCustomer();
  const part = await makePart(customer.id, {
    certRequired: opts.certRequired ?? null,
    certScope: opts.certRequired ? (opts.certScope ?? "LOAD") : (opts.certScope ?? null),
  });
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    lines: [{ partId: part.id, qty: opts.qty ?? 10, weight: "25.00" }],
  }));
  return { order, part, customer };
}

function oneOrderInput(order: OrderDetail) {
  return {
    customerId: order.customerId,
    shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: [{
        orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight,
        lineComplete: true,
      }],
      containers: [] as { orderContainerId: string; count: number }[],
      serials: [] as { orderSerialId: string; printOnShipper?: boolean }[],
    }],
  };
}

/** One order, fully shipped in one shipment — the minimal fixture `voidShipper` coverage that
 *  doesn't care about certs needs. */
async function oneOrderShipment(): Promise<{ order: OrderDetail; shipper: ShipperDetail }> {
  const { order } = await savedOrder();
  const { shipper } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
  return { order, shipper };
}

/** `oneOrderShipment`, but the order's resolved cert scope is SHIPMENT, so `createShipper`
 *  auto-creates a shipment-scope cert alongside it (the shippers.test.ts precedent) — the fixture
 *  the cert-cascade test needs. */
async function completeShipmentWithShipmentCert(): Promise<{
  order: OrderDetail; shipper: ShipperDetail; cert: { id: string };
}> {
  const { order } = await savedOrder({ certRequired: true, certScope: "SHIPMENT" });
  const { shipper } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
  const cert = await prisma.cert.findFirstOrThrow({
    where: { orderId: order.id, shipperId: shipper.id }, select: { id: true },
  });
  return { order, shipper, cert };
}

function twoOrderInput(customerId: string, a: OrderDetail, b: OrderDetail) {
  const line = (order: OrderDetail) => ({
    orderId: order.id,
    lines: [{
      orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight,
      lineComplete: true,
    }],
    containers: [] as { orderContainerId: string; count: number }[],
    serials: [] as { orderSerialId: string; printOnShipper?: boolean }[],
  });
  return { customerId, shipDate: "2026-08-04", orders: [line(a), line(b)] };
}

/** A two-order shipment where ONLY `orderA`'s resolved cert scope is SHIPMENT — `orderB` is a
 *  plain rider order of the same customer, present only so the shipment has a SECOND order to
 *  still be attached to after `orderA` is removed (spec §5.5 refuses removing the LAST order —
 *  `removeOrderFromShipper`'s own guard). The fixture the Important review finding's regression
 *  test needs: it must be possible to remove `orderA` (the cert-bearing one) WITHOUT voiding the
 *  whole shipment, so the removed-order's-cert-is-orphaned case is actually reachable. */
async function twoOrderShipmentWithShipmentCertOnFirst(): Promise<{
  shipper: ShipperDetail; orderA: OrderDetail; orderB: OrderDetail; cert: { id: string };
}> {
  const { order: orderA, customer } = await savedOrder({ certRequired: true, certScope: "SHIPMENT" });
  const partB = await makePart(customer.id);
  await giveSteps(partB.id);
  const { order: orderB } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: partB.id, qty: 10, weight: "25.00" }],
  }));
  const { shipper } = await createShipper(
    twoOrderInput(customer.id, orderA, orderB), { canOverrideCreditHold: false });
  const cert = await prisma.cert.findFirstOrThrow({
    where: { orderId: orderA.id, shipperId: shipper.id }, select: { id: true },
  });
  return { shipper, orderA, orderB, cert };
}

describe("voidShipper", () => {
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    claimOrdersInOrderMock.mockClear();
  });

  it("restores order status, keeps the number, and voids shipment-scoped certs with the same reason", async () => {
    const { shipper, order, cert } = await completeShipmentWithShipmentCert();
    await asSystem(() => voidShipper(shipper.id, "loaded onto the wrong truck"));
    expect((await getOrder(order.id)).status).toBe("OPEN");
    expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).deletedAt).not.toBeNull();
    // Same reason as the shipper's own delete entry — an observed fact (spec §5.6's "with the
    // same reason"), not merely inferred from the source sharing one `why` variable.
    const certAudit = await prisma.auditLog.findFirst({
      where: { entity: "cert", entityId: cert.id, action: "delete" },
    });
    expect(certAudit?.reason).toBe("loaded onto the wrong truck");
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).shipperNumber)
      .toBe(shipper.shipperNumber);
  });

  // The Important review finding (2026-08-04): the first version of `voidShipper` computed its
  // claim from the shipment's CURRENT orders only, then soft-deleted every LIVE cert with
  // `shipperId = id` — including one belonging to an order that had been REMOVED from the shipment
  // earlier (`removeOrderFromShipper`, legal before any ticket prints), whose row was therefore
  // never claimed. Fixed at the source (spec §5.6, 2026-08-04 amendment): `removeOrderFromShipper`
  // now voids that order's own shipment-scope cert AT REMOVAL TIME, under the claim it already
  // holds for that order — so by the time `voidShipper` runs, a still-live shipment-scope cert can
  // only belong to an order still ON the shipment, i.e. inside its own claim.
  it("a removed order's shipment-scope cert is voided at removal, so voidShipper's later claim never has to reach it (spec §5.6, 2026-08-04 amendment)", async () => {
    const { shipper, orderA, orderB, cert } = await twoOrderShipmentWithShipmentCertOnFirst();
    const soA = shipper.orders.find((so) => so.orderId === orderA.id)!;

    // Legal per spec §5.5: neither of removeOrderFromShipper's own guards applies yet — this is
    // not the shipment's last order, and no shipping ticket has printed.
    await asSystem(() => removeOrderFromShipper(shipper.id, soA.id));
    expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).deletedAt).not.toBeNull();

    claimOrdersInOrderMock.mockClear();
    await asSystem(() => voidShipper(shipper.id, "consolidating loads"));

    // voidShipper's own claim covers only the shipment's CURRENT orders — orderA left earlier and
    // is never among them, which is exactly what makes the cert cascade above safe: nothing this
    // call writes (including the certs it soft-deletes) belongs to an order outside this claim.
    const claimedIds = claimOrdersInOrderMock.mock.calls.flatMap((call) => call[1]);
    expect(claimedIds).toEqual([orderB.id]);

    expect((await getOrder(orderB.id)).status).toBe("OPEN");
  });

  it("keeps stored PDFs readable after a void", async () => {
    const { shipper } = await oneOrderShipment();
    const bytes = Buffer.from("%PDF-1.4 ticket");
    // storeDocument directly — printShippingTickets arrives in Task 18, and the refusal-to-reprint
    // assertion lives there with it. This task owns only the survival half.
    const doc = await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "SHIPPER", shipperId: shipper.id, orderId: null }, bytes));
    await asSystem(() => voidShipper(shipper.id, "wrong truck"));
    expect(Buffer.compare((await getDocument(doc.id)).fileData, bytes)).toBe(0);
  });

  it("requires a reason", async () => {
    const { shipper } = await oneOrderShipment();
    await expect(asSystem(() => voidShipper(shipper.id, "\t "))).rejects.toThrow(/reason/i);
  });

  it("404s an unknown shipment", async () => {
    await expect(asSystem(() => voidShipper("nope", "reason"))).rejects.toMatchObject({ status: 404 });
  });

  it("404s an already-voided shipment", async () => {
    const { shipper } = await oneOrderShipment();
    await asSystem(() => voidShipper(shipper.id, "first void"));
    await expect(asSystem(() => voidShipper(shipper.id, "second void"))).rejects.toMatchObject({ status: 404 });
  });

  it("writes a delete audit entry carrying the reason", async () => {
    const { shipper } = await oneOrderShipment();
    await asSystem(() => voidShipper(shipper.id, "loaded onto the wrong truck"));
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "shipper", entityId: shipper.id, action: "delete" },
    });
    expect(entry?.reason).toBe("loaded onto the wrong truck");
  });
});

// ---------------------------------------------------------------------------------------------
// #65 — void is reversal-aware (owner ruling 2026-08-17, spec §15). Voiding the ORIGINAL of a live
// reversal pair is refused naming the reversal (§5.14's name-the-blocker shape) — that blocker is
// what makes the net ship ledger non-negative GLOBALLY, not just at reversal creation. Voiding the
// REVERSAL is the blessed undo: it restores the `lineComplete` flags the reversal itself cleared
// (`reversalClearedLineIds`, stored at creation) and recomputes status. Invoiced pairs stay behind
// `refuseIfInvoiced` — unlock is their correction route (§5.7).
// ---------------------------------------------------------------------------------------------
describe("voidShipper — reversal-aware (#65)", () => {
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    claimOrdersInOrderMock.mockClear();
    recomputeMock.mockClear();
  });

  /** `oneOrderShipment` (SHIPPED), then reversed — the live pair every test below starts from.
   *  After the reversal the original's line flags are cleared, so the order sits PARTIAL_SHIPPED. */
  async function reversedPair(): Promise<{
    order: OrderDetail; original: ShipperDetail; reversal: ShipperDetail;
  }> {
    const { order, shipper: original } = await oneOrderShipment();
    const { shipper: reversal } = await asSystem(() =>
      reverseShipper(original.id, { reason: "wrong parts loaded" }));
    return { order, original, reversal };
  }

  /** `oneOrderShipment`, then priced, invoiced and FINALIZED — the shipper-reverse.test.ts
   *  `invoicedFixture` shape (copying across test files is this repo's convention). */
  async function invoicedShipment(): Promise<{ order: OrderDetail; shipper: ShipperDetail }> {
    const { order, part } = await savedOrder();
    const { shipper } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
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

  // The stuck-PARTIAL_SHIPPED half of the issue: before the fix, voiding the reversal left the
  // original's `lineComplete` flags cleared, so a fully shipped order stayed PARTIAL_SHIPPED
  // forever while the ledger read fully shipped.
  it("voiding a reversal restores the original's cleared flags and the order returns to SHIPPED", async () => {
    const { order, original, reversal } = await reversedPair();
    const originalLineId = original.orders[0].lines[0].id;
    expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
    expect((await prisma.shipperLine.findUniqueOrThrow({ where: { id: originalLineId } })).lineComplete)
      .toBe(false);

    await asSystem(() => voidShipper(reversal.id, "mistaken reversal"));

    expect((await prisma.shipperLine.findUniqueOrThrow({ where: { id: originalLineId } })).lineComplete)
      .toBe(true);
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
  });

  // The restore is the MIRROR of the clear: an audited update on the ORIGINAL's own history,
  // carrying the void reason (the step-6b shape, reversed) — and the CONTENT rule (§5 conventions:
  // assert the diff, not just that an entry exists): the before/after snapshots must actually show
  // the flag flipping, or a stale-diff bug could hide behind a green existence check.
  it("the restore lands as an audited update on the original carrying the void reason", async () => {
    const { original, reversal } = await reversedPair();
    const originalLineId = original.orders[0].lines[0].id;
    await asSystem(() => voidShipper(reversal.id, "mistaken reversal"));
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "shipper", entityId: original.id, action: "update" }, orderBy: { at: "desc" },
    });
    expect(entry?.reason).toBe("mistaken reversal");

    type Snap = { orders?: { lines?: { id: string; lineComplete: boolean }[] }[] } | null;
    const lineIn = (snap: Snap) =>
      snap?.orders?.flatMap((o) => o.lines ?? []).find((l) => l.id === originalLineId);
    expect(lineIn(entry?.before as Snap)?.lineComplete).toBe(false);
    expect(lineIn(entry?.after as Snap)?.lineComplete).toBe(true);
  });

  // #65 review round 1 (Important): the restore must not assume the cleared lines' orders still
  // sit on the reversal's own `ShipperOrder` rows. No product path shrinks a reversal's membership
  // TODAY — `removeOrderFromShipper` on a reversal is refused, but only INCIDENTALLY, by the
  // at-least-one-positive-line survivor invariant (every reversal line is negative), the same
  // accidental-protection shape #65 itself existed to close (#139 records the class). So the void
  // DISCOVERS the cleared lines' orders and unions them into its claim/recompute set, and this
  // test pins that by shrinking the membership directly (raw deletes — the state any future
  // relaxation of that unrelated guard would produce), not through a mutator.
  it("restores and recomputes an order no longer on the reversal's membership at void time", async () => {
    const { order: orderA, customer } = await savedOrder();
    const partB = await makePart(customer.id);
    await giveSteps(partB.id);
    const { order: orderB } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: partB.id, qty: 10, weight: "25.00" }],
    }));
    const { shipper: original } = await createShipper(
      twoOrderInput(customer.id, orderA, orderB), { canOverrideCreditHold: false });
    const { shipper: reversal } = await asSystem(() =>
      reverseShipper(original.id, { reason: "wrong parts loaded" }));

    // Shrink the reversal's membership to order A only. B's cleared flag stays cleared on the
    // ORIGINAL, so B sits PARTIAL_SHIPPED going into the void.
    const soB = reversal.orders.find((so) => so.orderId === orderB.id)!;
    await prisma.shipperLine.deleteMany({ where: { shipperOrderId: soB.id } });
    await prisma.shipperOrder.delete({ where: { id: soB.id } });
    expect((await getOrder(orderB.id)).status).toBe("PARTIAL_SHIPPED");

    claimOrdersInOrderMock.mockClear();
    await asSystem(() => voidShipper(reversal.id, "mistaken reversal"));

    // Both orders return to SHIPPED — including B, whose ShipperOrder row the reversal no longer
    // carries — and B's id was genuinely in the void's claim (the union, not luck: the restore
    // write alone would flip the flag without the claim, but the recompute would never reach B).
    expect((await getOrder(orderA.id)).status).toBe("SHIPPED");
    expect((await getOrder(orderB.id)).status).toBe("SHIPPED");
    expect(claimOrdersInOrderMock.mock.calls.at(-1)![1]).toContain(orderB.id);
  });

  // The other half of the issue: voiding the original of a live pair dropped its positive lines
  // from `shippedTotals` while the reversal's negatives stayed live — net below zero. Refused,
  // naming the blocker (§5.14).
  it("refuses to void an original with a live reversal, naming the reversal's packing list", async () => {
    const { order, original, reversal } = await reversedPair();
    await expect(asSystem(() => voidShipper(original.id, "clearing out"))).rejects.toMatchObject({
      status: 400,
      message: `This shipment has been reversed by Packing List ${reversal.shipperNumber} — void the reversal first`,
    });
    // Nothing moved: both documents still live, ledger still netted to zero.
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: original.id } })).deletedAt).toBeNull();
    const line = order.lines[0].id;
    expect((await shippedTotals(prisma, [line])).get(line)!.qty).toBe(0);
  });

  it("voiding the original is allowed once the reversal is voided", async () => {
    const { order, original, reversal } = await reversedPair();
    await asSystem(() => voidShipper(reversal.id, "mistaken reversal"));
    await asSystem(() => voidShipper(original.id, "shipment cancelled after all"));
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: original.id } })).deletedAt).not.toBeNull();
    expect((await getOrder(order.id)).status).toBe("OPEN");
  });

  // The invariant the blocker exists for, walked through the whole legal sequence: with every live
  // reversal fully covered by its live original, net shipped-to-date never dips below zero.
  it("net shippedTotals never goes negative through the legal void sequence", async () => {
    const { order, shipper: original } = await oneOrderShipment(); // ships qty 10
    const line = order.lines[0].id;
    const net = async () => (await shippedTotals(prisma, [line])).get(line)?.qty ?? 0;
    expect(await net()).toBe(10);

    const { shipper: reversal } = await asSystem(() =>
      reverseShipper(original.id, { reason: "returned" }));
    expect(await net()).toBe(0);

    await expect(asSystem(() => voidShipper(original.id, "no"))).rejects.toMatchObject({ status: 400 });
    expect(await net()).toBe(0); // refused — NOT -10

    await asSystem(() => voidShipper(reversal.id, "undo the return"));
    expect(await net()).toBe(10);

    await asSystem(() => voidShipper(original.id, "now genuinely voidable"));
    expect(await net()).toBe(0);
  });

  // Pre-#65 reversals carry the migration's [] default (dev/practice data only — the shop is not
  // live): voiding one restores nothing, but the existing recompute still runs as today.
  it("a legacy reversal with [] restores nothing but still recomputes", async () => {
    const { order, original, reversal } = await reversedPair();
    await prisma.shipper.update({ where: { id: reversal.id }, data: { reversalClearedLineIds: [] } });
    const originalLineId = original.orders[0].lines[0].id;
    const updatesBefore = await prisma.auditLog.count({
      where: { entity: "shipper", entityId: original.id, action: "update" },
    });

    recomputeMock.mockClear();
    await asSystem(() => voidShipper(reversal.id, "undo"));

    // No restore: the flag stays cleared, and no new audited update landed on the original.
    expect((await prisma.shipperLine.findUniqueOrThrow({ where: { id: originalLineId } })).lineComplete)
      .toBe(false);
    expect(await prisma.auditLog.count({
      where: { entity: "shipper", entityId: original.id, action: "update" },
    })).toBe(updatesBefore);
    // ...but the void itself succeeded and the recompute ran over the order (two-arg — the
    // shipment path never passes `released`, spec §5.2).
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: reversal.id } })).deletedAt).not.toBeNull();
    const allRecomputed = recomputeMock.mock.calls.flatMap((c) => c[1]);
    expect(allRecomputed).toContain(order.id);
    const allReleased = recomputeMock.mock.calls.flatMap((c) => c[2] ?? []);
    expect(allReleased).toEqual([]);
    expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
  });

  // Guard ORDER, proven by the message: an invoiced pair is refused on BOTH sides by
  // `refuseIfInvoiced` — its invoice-naming sentence, not the reversal blocker's — so the blocker
  // check cannot shadow the §5.7 rule whose correction route (unlock) the operator needs.
  it("an invoiced pair is refused on both sides with refuseIfInvoiced's message", async () => {
    const { order, shipper: original } = await invoicedShipment();
    const { shipper: reversal } = await asSystem(() =>
      reverseShipper(original.id, { reason: "returned" }));
    expect((await getOrder(order.id)).status).toBe("REOPENED");

    const invoiceRefusal = new RegExp(`Invoice ${order.orderNumber} is finalized`);
    await expect(asSystem(() => voidShipper(original.id, "x"))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(invoiceRefusal),
    });
    await expect(asSystem(() => voidShipper(original.id, "x"))).rejects.not.toMatchObject({
      message: expect.stringMatching(/reversed by Packing List/),
    });
    await expect(asSystem(() => voidShipper(reversal.id, "x"))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(invoiceRefusal),
    });
  });

  // The detail's §5.16 signal: the shipment page renders Void disabled-with-title (naming the
  // blocker) for an original with a live reversal — `voidShipper`'s refusal above stays the
  // enforcement; this flag is the UI's honesty.
  it("the detail carries the live reversal's packing-list number, cleared once the reversal voids", async () => {
    const { original, reversal } = await reversedPair();
    expect((await getShipper(original.id)).reversedByShipperNumber).toBe(reversal.shipperNumber);
    // The reversal document itself always carries null (a reversal cannot be reversed), so its
    // own Void button stays enabled — voiding a reversal is the blessed undo.
    expect((await getShipper(reversal.id)).reversedByShipperNumber).toBeNull();
    await asSystem(() => voidShipper(reversal.id, "mistaken reversal"));
    expect((await getShipper(original.id)).reversedByShipperNumber).toBeNull();
  });

  // The pair-void lock shape (the shipper-reverse.test.ts claim-test technique): the competing
  // holder runs at Read Committed holding ONLY the ORIGINAL's Shipper row, so the only thing that
  // can make the reversal's void wait is `claimShipperRows` genuinely claiming the PAIR row — not
  // SSI, not the order claims (the holder takes neither). RED by hand: claim only the target's own
  // row and the void sails past the holder instead of blocking.
  it("voiding a reversal claims the pair: it blocks on a holder of the original's shipper row", async () => {
    const { order, original, reversal } = await reversedPair();

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Shipper" WHERE "id" = ${original.id} FOR UPDATE`;
      hasClaimed();
      await release;
    }, { timeout: 20000 });

    await claimed;
    const voidCall = asSystem(() => voidShipper(reversal.id, "mistaken reversal"));

    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      voidCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT); // blocked on the holder's pair-row claim

    mayRelease();
    await holder;
    await voidCall; // completes once the pair row frees — holder wrote nothing, so no 40001

    // ...and the restore then ran to completion under the claim it waited for.
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
  });
});
