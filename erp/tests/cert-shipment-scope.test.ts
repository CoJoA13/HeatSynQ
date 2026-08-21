import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import { createCert } from "@/server/certs";
import type { Customer, Part } from "../prisma/generated/prisma/client";

import { POST as createShipmentCertRoute } from "@/app/api/shippers/[id]/certs/route";
import { POST as createCertRoute } from "@/app/api/certs/route";

/**
 * #165, the SHIPMENT half. `POST /api/certs` is `.strict()` and deliberately omits `shipperId`
 * (its own docblock is the record of that decision — Task 11 Step 0), so it "structurally cannot
 * produce a SHIPMENT-scope cert". The fix is NOT to relax that schema but to route around it: a
 * new endpoint that resolves `shipperId` FROM ITS PATH, exactly the way `POST /api/orders/[id]/
 * certs` resolves `orderId` from its path and fixes `scope` to LOAD.
 *
 * `tests/cert-routes.test.ts`'s "POST /api/certs rejects a client-supplied shipperId outright"
 * is the pin that the old decision survived this change; this file pins the new surface.
 */

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

function bodyReq(url: string, method: string, cookie: string | undefined, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `SCC${customerSeq}`, name: `Shipment Cert Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({
    // certRequired: null all the way down — order save creates NO cert of its own, so every cert
    // in this file is one THIS surface raised.
    data: { customerId, partNumber: `SCCP-${partSeq}`, eachWeight: "1.0000", certRequired: null },
  });
}

/** Revision 1 with one step — createOrder's orderability precondition (spec §5.3). */
async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `SCCHT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

async function savedOrder(customer?: Customer): Promise<{ order: OrderDetail; customer: Customer }> {
  const cust = customer ?? (await makeCustomer());
  const part = await makePart(cust.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: cust.id, lines: [{ partId: part.id, qty: 10, weight: "25.00" }],
  }));
  return { order, customer: cust };
}

let shipperSeq = 7000;
/** A live Shipper, optionally paired to `orderIds` — raw prisma, the certs.test.ts `makeShipment`
 *  precedent. `orderIds: []` builds the shipment that carries NOBODY, which is what the pairing
 *  guard below is about. */
async function makeShipment(
  customerId: string, orderIds: string[],
): Promise<{ id: string; shipperNumber: number }> {
  shipperSeq += 1;
  const shipper = await prisma.shipper.create({
    data: { shipperNumber: shipperSeq, customerId, shipDate: new Date() },
  });
  for (const [i, orderId] of orderIds.entries()) {
    // `sequence` is the ORDER's own shipment count (§3.19's "-3" in "72036-3"), unique per order
    // — `@@unique([orderId, sequence])`. `position` is the row's place on THIS shipment.
    const sequence = await prisma.shipperOrder.count({ where: { orderId } }) + 1;
    await prisma.shipperOrder.create({
      data: { shipperId: shipper.id, orderId, sequence, position: i + 1 },
    });
  }
  return shipper;
}

describe("POST /api/shippers/[id]/certs — the SHIPMENT-scope cert surface (#165)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("requires certs.create, the same gate its LOAD-scope sibling uses", async () => {
    const { order, customer } = await savedOrder();
    const shipper = await makeShipment(customer.id, [order.id]);
    const url = `http://t/api/shippers/${shipper.id}/certs`;

    expect((await createShipmentCertRoute(
      bodyReq(url, "POST", undefined, { orderId: order.id }), withParams({ id: shipper.id }),
    )).status).toBe(401);

    const wrong = await signInWith(["certs.view", "shipping.create"], "scc-wrong-1");
    expect((await createShipmentCertRoute(
      bodyReq(url, "POST", wrong, { orderId: order.id }), withParams({ id: shipper.id }),
    )).status).toBe(403);

    const creator = await signInWith(["certs.create"], "scc-create-1");
    expect((await createShipmentCertRoute(
      bodyReq(url, "POST", creator, { orderId: order.id }), withParams({ id: shipper.id }),
    )).status).toBe(200);
  });

  it("mints a SHIPMENT-scope cert whose shipper is the PATH's, never the body's", async () => {
    const { order, customer } = await savedOrder();
    const shipper = await makeShipment(customer.id, [order.id]);
    const creator = await signInWith(["certs.create"], "scc-create-2");

    const res = await createShipmentCertRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}/certs`, "POST", creator, { orderId: order.id }),
      withParams({ id: shipper.id }),
    );
    expect(res.status).toBe(200);
    const cert = await res.json();
    expect(cert.scope).toBe("SHIPMENT");
    expect(cert.orderId).toBe(order.id);
    expect(cert.shipperId).toBe(shipper.id);
    expect(cert.shipperNumber).toBe(shipper.shipperNumber);
    expect(cert.sequence).toBe(1); // resolved off the ShipperOrder pairing (§3.19's "72036-1")
    expect(cert.loadNumber).toBeNull();
  });

  // The whole point of the new route: `shipperId` is STILL never read off a body. A client that
  // tries to name one — or to name a different scope — gets a 400 naming the extra key, exactly
  // as the sibling routes do.
  it("refuses any extra body key, shipperId and scope included (.strict())", async () => {
    const { order, customer } = await savedOrder();
    const shipper = await makeShipment(customer.id, [order.id]);
    const other = await makeShipment(customer.id, [order.id]);
    const creator = await signInWith(["certs.create"], "scc-strict-1");

    for (const extra of [{ shipperId: other.id }, { scope: "ORDER" }, { loadNumber: 1 }]) {
      const res = await createShipmentCertRoute(
        bodyReq(`http://t/api/shippers/${shipper.id}/certs`, "POST", creator, { orderId: order.id, ...extra }),
        withParams({ id: shipper.id }),
      );
      expect(res.status).toBe(400);
    }
    expect(await prisma.cert.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("refuses a voided shipment", async () => {
    const { order, customer } = await savedOrder();
    const shipper = await makeShipment(customer.id, [order.id]);
    await prisma.shipper.update({ where: { id: shipper.id }, data: { deletedAt: new Date() } });
    const creator = await signInWith(["certs.create"], "scc-voided-1");

    const res = await createShipmentCertRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}/certs`, "POST", creator, { orderId: order.id }),
      withParams({ id: shipper.id }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not exist or has been voided/i);
  });

  it("refuses a second live cert for the same order+shipment, in the service's own words", async () => {
    const { order, customer } = await savedOrder();
    const shipper = await makeShipment(customer.id, [order.id]);
    const creator = await signInWith(["certs.create"], "scc-dup-1");
    const url = `http://t/api/shippers/${shipper.id}/certs`;

    expect((await createShipmentCertRoute(
      bodyReq(url, "POST", creator, { orderId: order.id }), withParams({ id: shipper.id }),
    )).status).toBe(200);

    const second = await createShipmentCertRoute(
      bodyReq(url, "POST", creator, { orderId: order.id }), withParams({ id: shipper.id }));
    expect(second.status).toBe(400);
    // The exact sentence the section's collision notice sits beside — uniqueness stays
    // service-enforced under the order claim, never re-decided by the client (CLAUDE.md).
    expect((await second.json()).error).toBe("This order already has a certification for that scope");
    expect(await prisma.cert.count({ where: { orderId: order.id, deletedAt: null } })).toBe(1);
  });

  it("still refuses a SHIPMENT scope on POST /api/certs — that decision is routed around, not relaxed", async () => {
    const { order, customer } = await savedOrder();
    const shipper = await makeShipment(customer.id, [order.id]);
    const creator = await signInWith(["certs.create"], "scc-old-route-1");

    const res = await createCertRoute(
      bodyReq("http://t/api/certs", "POST", creator, { orderId: order.id, scope: "SHIPMENT" }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/shipper is required/i);
    expect(await prisma.cert.count({ where: { shipperId: shipper.id } })).toBe(0);
  });
});

/**
 * The guard the new route makes load-bearing. Until #165 the only callers of SHIPMENT scope were
 * `saveNewShipper`/`addOrderToShipper`, which by construction pass a shipment that carries the
 * order. A hand-raised cert can name any pair, and a cert for a shipment that never carried the
 * order prints zero shipped quantities under a bare order label — "a printable record of
 * nothing", which is the reasoning `createCertInTx`'s LOAD-number check already states in as many
 * words. Checked under the order claim, beside that one, so a concurrent add/remove of the order
 * on the shipment serializes with it.
 */
describe("createCert SHIPMENT scope — the shipment must actually carry the order (#165)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("refuses a shipment that does not carry the order", async () => {
    const { order, customer } = await savedOrder();
    const { order: other } = await savedOrder(customer);
    const carriesOther = await makeShipment(customer.id, [other.id]);

    await expect(asSystem(() => createCert({
      orderId: order.id, scope: "SHIPMENT", shipperId: carriesOther.id,
    }))).rejects.toThrow(/does not carry this order/i);
    expect(await prisma.cert.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("accepts a shipment carrying several orders, for each of them", async () => {
    const { order: a, customer } = await savedOrder();
    const { order: b } = await savedOrder(customer);
    const shipper = await makeShipment(customer.id, [a.id, b.id]);

    const certA = await asSystem(() => createCert({ orderId: a.id, scope: "SHIPMENT", shipperId: shipper.id }));
    const certB = await asSystem(() => createCert({ orderId: b.id, scope: "SHIPMENT", shipperId: shipper.id }));
    // Each cert reads ITS OWN order's shipment sequence off the pairing — both orders' first
    // shipment, so both are "-1"; they are distinguished by orderId, never by the shipment.
    expect(certA.sequence).toBe(1);
    expect(certB.sequence).toBe(1);
    expect(certA.shipperId).toBe(shipper.id);
    expect(certB.shipperId).toBe(shipper.id);
  });
});
