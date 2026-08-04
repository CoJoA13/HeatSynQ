import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";

/** Everything the cert and shipment graphs hang off: a customer with a ship-to address, a part,
 *  an order with one line / container / serial, a carrier, and an inspection code + scale. */
async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
  const address = await prisma.customerAddress.create({
    data: { customerId: customer.id, kind: "SHIP_TO", name: "Acme Plant 2", city: "Toledo" },
  });
  const carrier = await prisma.carrier.create({ data: { name: "Yellow Freight" } });
  const scale = await prisma.inspectionScale.create({ data: { name: "HRC" } });
  const code = await prisma.inspectionCode.create({ data: { name: "Hardness", defaultScaleId: scale.id } });
  const part = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "P-1", eachWeight: "1.0000" },
  });
  const containerType = await prisma.containerType.create({ data: { name: "Basket" } });

  const order = await prisma.order.create({
    data: {
      orderNumber: 72036,
      customerId: customer.id,
      receivedDate: new Date("2026-08-01"),
      requestDate: new Date("2026-08-05"),
      customerJobNo: "JOB-9",
      certRequired: true,
      certScope: "SHIPMENT",
    },
  });
  const line = await prisma.orderLine.create({
    data: { orderId: order.id, position: 1, partId: part.id, qty: 10, weight: "25.50" },
  });
  const container = await prisma.orderContainer.create({
    data: {
      orderId: order.id, position: 1, typeId: containerType.id, count: 2,
      customerContainerId: "CUST-BIN-7",
    },
  });
  const serial = await prisma.orderSerial.create({
    data: { orderId: order.id, lineId: line.id, position: 1, serial: "EC001", description: "Heat 42" },
  });

  return { customer, address, carrier, scale, code, part, order, line, container, serial };
}

describe("certs and shipping schema", () => {
  beforeEach(truncateAll);

  it("stores the cert graph — cert → requirement (code + scale) → readings", async () => {
    const { order, line, code, scale } = await fixture();

    const cert = await prisma.cert.create({
      data: {
        orderId: order.id,
        scope: "ORDER",
        freeform: "Parts were processed per spec.",
        internalNotes: "operator note — never prints",
      },
    });
    const requirement = await prisma.certRequirement.create({
      data: {
        certId: cert.id, orderLineId: line.id, position: 1,
        inspectionCodeId: code.id, scaleId: scale.id,
        min: "45.0000", max: "52.5000", sampleQty: "100%", location: "flange OD",
      },
    });
    await prisma.certReading.createMany({
      data: [
        { requirementId: requirement.id, position: 1, value: "48.2500", passed: true },
        { requirementId: requirement.id, position: 2, value: "53.0000", passed: false, overridden: true, note: "retest ok" },
      ],
    });

    const back = await prisma.cert.findFirst({
      where: { id: cert.id },
      include: {
        order: true,
        requirements: {
          orderBy: { position: "asc" },
          include: { inspectionCode: true, scale: true, readings: { orderBy: { position: "asc" } } },
        },
      },
    });
    expect(back?.scope).toBe("ORDER");
    expect(back?.order.orderNumber).toBe(72036);
    expect(back?.printedAt).toBeNull();
    expect(back?.requirements[0]?.inspectionCode.name).toBe("Hardness");
    expect(back?.requirements[0]?.scale?.name).toBe("HRC");
    // Decimal(10, 4) round-trips the stored value; Prisma's Decimal normalizes trailing zeros on
    // toString(), so compare numerically rather than coupling to that rendering.
    expect(back?.requirements[0]?.readings.map((r) => Number(r.value))).toEqual([48.25, 53]);
    expect(back?.requirements[0]?.readings.map((r) => r.passed)).toEqual([true, false]);
    expect(Number(back?.requirements[0]?.min)).toBe(45);
    expect(Number(back?.requirements[0]?.max)).toBe(52.5);
    expect(back?.requirements[0]?.sampleQty).toBe("100%"); // free text, never a number (§3.9)
    expect(back?.requirements[0]?.readings[1]?.overridden).toBe(true);
  });

  // §4.1: a LOAD-scope cert pins the load NUMBER, not a Load row — loads are renumbered and
  // re-split by design, and a cert that followed the row would silently describe a different
  // physical load than the one on its paper.
  it("a LOAD-scope cert carries a bare loadNumber, and a SHIPMENT-scope cert carries a shipper", async () => {
    const { order, customer } = await fixture();

    const byLoad = await prisma.cert.create({
      data: { orderId: order.id, scope: "LOAD", loadNumber: 3 },
    });
    expect(byLoad.loadNumber).toBe(3);
    expect(byLoad.shipperId).toBeNull();

    const shipper = await prisma.shipper.create({
      data: { shipperNumber: 72826, customerId: customer.id, shipDate: new Date("2026-08-04") },
    });
    const byShipment = await prisma.cert.create({
      data: { orderId: order.id, scope: "SHIPMENT", shipperId: shipper.id },
    });
    const shipperBack = await prisma.shipper.findFirst({ where: { id: shipper.id }, include: { certs: true } });
    expect(shipperBack?.certs[0]?.id).toBe(byShipment.id);
  });

  it("stores the shipment graph — shipper → shipperOrder → line / container / serial", async () => {
    const { customer, address, carrier, order, line, container, serial } = await fixture();

    const shipper = await prisma.shipper.create({
      data: {
        shipperNumber: 72826,
        customerId: customer.id,
        shipToAddressId: address.id,
        shipDate: new Date("2026-08-04"),
        carrierId: carrier.id,
        route: "R-12",
        comments: "call ahead",
        billFreight: true,
        freightAmount: "125.00",
        freightTerms: "COLLECT",
        freightClass: "92.5",
        freightDescription: "Manufactured Castings I/S",
        packageCount: 2,
        proNumber: "PRO-1",
        scacCode: "YFSY",
      },
    });
    const shipperOrder = await prisma.shipperOrder.create({
      data: { shipperId: shipper.id, orderId: order.id, sequence: 3, position: 1 },
    });
    await prisma.shipperLine.create({
      data: {
        shipperOrderId: shipperOrder.id, orderLineId: line.id, position: 1,
        qty: 4, weight: "10.25", lineComplete: false,
      },
    });
    await prisma.shipperContainer.create({
      data: { shipperOrderId: shipperOrder.id, orderContainerId: container.id, position: 1, count: 2 },
    });
    await prisma.shipperSerial.create({
      data: { shipperOrderId: shipperOrder.id, orderSerialId: serial.id },
    });

    const back = await prisma.shipper.findFirst({
      where: { id: shipper.id },
      include: {
        customer: true,
        shipToAddress: true,
        carrier: true,
        orders: {
          orderBy: { position: "asc" },
          include: {
            order: true,
            lines: { include: { orderLine: true } },
            containers: { include: { orderContainer: true } },
            serials: { include: { orderSerial: true } },
          },
        },
      },
    });
    expect(back?.bolNumber).toBeNull(); // allocated lazily at first BOL print (§3.19)
    expect(back?.carrier?.name).toBe("Yellow Freight");
    expect(back?.shipToAddress?.name).toBe("Acme Plant 2");
    // "72036-3" — the printed Order No. on this shipment's ticket.
    expect(`${back?.orders[0]?.order.orderNumber}-${back?.orders[0]?.sequence}`).toBe("72036-3");
    expect(back?.freightTerms).toBe("COLLECT");
    expect(back?.freightClass).toBe("92.5"); // text, never math — NMFC classes include 92.5
    expect(Number(back?.freightAmount)).toBe(125);
    expect(back?.orders[0]?.lines[0]?.qty).toBe(4);
    expect(Number(back?.orders[0]?.lines[0]?.weight)).toBe(10.25);
    expect(back?.orders[0]?.lines[0]?.orderLine.id).toBe(line.id);
    expect(back?.orders[0]?.containers[0]?.orderContainer.customerContainerId).toBe("CUST-BIN-7");
    expect(back?.orders[0]?.serials[0]?.printOnShipper).toBe(true);
    expect(back?.orders[0]?.serials[0]?.orderSerial.serial).toBe("EC001");

    const orderBack = await prisma.order.findFirst({
      where: { id: order.id }, include: { shipperOrders: true, certs: true },
    });
    expect(orderBack?.shipperOrders[0]?.id).toBe(shipperOrder.id);
    expect(orderBack?.customerJobNo).toBe("JOB-9");
    expect(orderBack?.certScope).toBe("SHIPMENT");
  });

  // §4.2's no-reuse contract: the "-3" in "72036-3" is already on paper in a customer's hands, so
  // voiding shipment 3 must never let a later shipment claim that sequence back. This is the
  // opposite of every partial-unique column elsewhere in the schema, and exactly why
  // @@unique([orderId, sequence]) is a bare block-level unique.
  it("@@unique([orderId, sequence]) rejects a duplicate sequence even when the first shipment is voided", async () => {
    const { customer, order } = await fixture();

    const first = await prisma.shipper.create({
      data: { shipperNumber: 900, customerId: customer.id, shipDate: new Date("2026-08-04") },
    });
    await prisma.shipperOrder.create({
      data: { shipperId: first.id, orderId: order.id, sequence: 1, position: 1 },
    });
    await prisma.shipper.update({ where: { id: first.id }, data: { deletedAt: new Date() } }); // voided

    const second = await prisma.shipper.create({
      data: { shipperNumber: 901, customerId: customer.id, shipDate: new Date("2026-08-05") },
    });
    await expect(
      prisma.shipperOrder.create({
        data: { shipperId: second.id, orderId: order.id, sequence: 1, position: 1 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    // The next sequence is still free — only the used one is gone forever.
    const ok = await prisma.shipperOrder.create({
      data: { shipperId: second.id, orderId: order.id, sequence: 2, position: 1 },
    });
    expect(ok.sequence).toBe(2);
  });

  // Same no-reuse contract one level up: a voided shipment keeps its packing-list number and its
  // idempotency nonce forever (the three documented plain-@unique sweep exemptions).
  it("shipperNumber, bolNumber and clientRequestId stay taken after a shipment is voided", async () => {
    const { customer } = await fixture();
    const base = { customerId: customer.id, shipDate: new Date("2026-08-04") };

    const first = await prisma.shipper.create({
      data: { shipperNumber: 910, bolNumber: 5000, clientRequestId: "nonce-1", ...base },
    });
    await prisma.shipper.update({ where: { id: first.id }, data: { deletedAt: new Date() } }); // voided

    await expect(prisma.shipper.create({ data: { shipperNumber: 910, ...base } }))
      .rejects.toMatchObject({ code: "P2002" });
    await expect(prisma.shipper.create({ data: { shipperNumber: 911, bolNumber: 5000, ...base } }))
      .rejects.toMatchObject({ code: "P2002" });
    await expect(prisma.shipper.create({ data: { shipperNumber: 912, clientRequestId: "nonce-1", ...base } }))
      .rejects.toMatchObject({ code: "P2002" });

    // NULLs never collide in a Postgres unique index — two shipments with no BOL and no nonce
    // are the normal case and must stay legal.
    await prisma.shipper.create({ data: { shipperNumber: 913, ...base } });
    await prisma.shipper.create({ data: { shipperNumber: 914, ...base } });
  });
});

// StoredDocument widened from one owner (order) to three (order, shipper, cert), and which one is
// required is decided by `kind`. Prisma's schema language has no check-constraint syntax (the
// Part.loadQty precedent), so the pairing is a hand-written DB CHECK — and the generated client's
// types make the illegal combinations uncompilable, which is why every case below goes through
// $executeRaw. The point is proving the DATABASE refuses them, not that TypeScript does.
describe("StoredDocument kind/owner CHECK constraint", () => {
  beforeEach(truncateAll);

  /** Raw INSERT of one StoredDocument row with the exact owner columns given. */
  function insertDocument(
    id: string, kind: string,
    owners: { orderId?: string | null; shipperId?: string | null; certId?: string | null },
  ) {
    return prisma.$executeRaw`
      INSERT INTO "StoredDocument" ("id", "orderId", "shipperId", "certId", "kind", "fileData")
      VALUES (${id}, ${owners.orderId ?? null}, ${owners.shipperId ?? null}, ${owners.certId ?? null},
              CAST(${kind} AS "DocumentKind"), decode('70646673', 'hex'))`;
  }

  const checkViolation = {
    code: "P2010",
    meta: expect.objectContaining({
      driverAdapterError: expect.objectContaining({
        cause: expect.objectContaining({ originalCode: "23514" }),
      }),
    }),
  };

  async function owners() {
    const { customer, order } = await fixture();
    const shipper = await prisma.shipper.create({
      data: { shipperNumber: 800, customerId: customer.id, shipDate: new Date("2026-08-04") },
    });
    const cert = await prisma.cert.create({ data: { orderId: order.id, scope: "ORDER" } });
    return { order, shipper, cert };
  }

  it("accepts every legal kind/owner pairing, including a SHIPPER document scoped to one order", async () => {
    const { order, shipper, cert } = await owners();

    await insertDocument("doc-traveler", "TRAVELER", { orderId: order.id });
    // orderId does double duty for SHIPPER exactly as loadNumber does for TRAVELER: which order's
    // ticket this is, null = the whole set.
    await insertDocument("doc-shipper-set", "SHIPPER", { shipperId: shipper.id });
    await insertDocument("doc-shipper-one", "SHIPPER", { shipperId: shipper.id, orderId: order.id });
    await insertDocument("doc-bol", "BOL", { shipperId: shipper.id });
    await insertDocument("doc-cert", "CERT", { certId: cert.id });

    expect(await prisma.storedDocument.count()).toBe(5);
    const one = await prisma.storedDocument.findFirst({ where: { id: "doc-shipper-one" } });
    expect(one?.orderId).toBe(order.id);
    expect(one?.shipperId).toBe(shipper.id);
  });

  it("rejects a CERT document that also names an order", async () => {
    const { order, cert } = await owners();
    await expect(insertDocument("bad-1", "CERT", { certId: cert.id, orderId: order.id }))
      .rejects.toMatchObject(checkViolation);
    expect(await prisma.storedDocument.count()).toBe(0);
  });

  it("rejects a BOL document that also names an order", async () => {
    const { order, shipper } = await owners();
    await expect(insertDocument("bad-2", "BOL", { shipperId: shipper.id, orderId: order.id }))
      .rejects.toMatchObject(checkViolation);
    expect(await prisma.storedDocument.count()).toBe(0);
  });

  it("rejects a TRAVELER document that also names a shipment", async () => {
    const { order, shipper } = await owners();
    await expect(insertDocument("bad-3", "TRAVELER", { orderId: order.id, shipperId: shipper.id }))
      .rejects.toMatchObject(checkViolation);
    expect(await prisma.storedDocument.count()).toBe(0);
  });

  it("rejects a document with no owner at all", async () => {
    await owners();
    await expect(insertDocument("bad-4", "TRAVELER", {})).rejects.toMatchObject(checkViolation);
    await expect(insertDocument("bad-5", "SHIPPER", {})).rejects.toMatchObject(checkViolation);
    await expect(insertDocument("bad-6", "BOL", {})).rejects.toMatchObject(checkViolation);
    await expect(insertDocument("bad-7", "CERT", {})).rejects.toMatchObject(checkViolation);
    expect(await prisma.storedDocument.count()).toBe(0);
  });

  it("rejects a CERT document owned by a shipment, and a SHIPPER document owned by a cert", async () => {
    const { shipper, cert } = await owners();
    await expect(insertDocument("bad-8", "CERT", { certId: cert.id, shipperId: shipper.id }))
      .rejects.toMatchObject(checkViolation);
    await expect(insertDocument("bad-9", "SHIPPER", { shipperId: shipper.id, certId: cert.id }))
      .rejects.toMatchObject(checkViolation);
    expect(await prisma.storedDocument.count()).toBe(0);
  });
});
