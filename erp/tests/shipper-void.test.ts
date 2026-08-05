import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder, type OrderDetail } from "@/server/orders";
import { createShipper, voidShipper, type ShipperDetail } from "@/server/shippers";
import { storeDocument, getDocument } from "@/server/documents";
import type { Customer, Part } from "../prisma/generated/prisma/client";
import type { CertScopeValue } from "@/lib/cert-constants";

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

describe("voidShipper", () => {
  beforeEach(truncateAll);

  it("restores order status, keeps the number, and voids shipment-scoped certs", async () => {
    const { shipper, order, cert } = await completeShipmentWithShipmentCert();
    await asSystem(() => voidShipper(shipper.id, "loaded onto the wrong truck"));
    expect((await getOrder(order.id)).status).toBe("OPEN");
    expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).deletedAt).not.toBeNull();
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).shipperNumber)
      .toBe(shipper.shipperNumber);
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
