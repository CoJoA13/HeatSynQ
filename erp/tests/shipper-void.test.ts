import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder, type OrderDetail } from "@/server/orders";
import { createShipper, voidShipper, removeOrderFromShipper, type ShipperDetail } from "@/server/shippers";
import { storeDocument, getDocument } from "@/server/documents";
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
