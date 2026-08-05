import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import type { Customer, Part } from "../prisma/generated/prisma/client";
import type { CertScopeValue } from "@/lib/cert-constants";

import { GET as listRoute, POST as createRoute } from "@/app/api/certs/route";
import { GET as exportRoute } from "@/app/api/certs/export/route";
import { GET as getRoute, PATCH as patchRoute, DELETE as voidRoute } from "@/app/api/certs/[id]/route";
import { PUT as resultsRoute } from "@/app/api/certs/[id]/results/route";
import { GET as certsForOrderRoute, POST as createLoadCertRoute } from "@/app/api/orders/[id]/certs/route";

const noParams = { params: Promise.resolve({}) };
const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}
function bodyReq(url: string, method: string, cookie: string | undefined, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function noBodyReq(url: string, method: string, cookie?: string): Request {
  return new Request(url, { method, headers: cookie ? { cookie } : {} });
}

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `CRT${customerSeq}`, name: `Cert Route Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string, opts: { certRequired?: boolean | null } = {}): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({
    data: { customerId, partNumber: `CRTP-${partSeq}`, eachWeight: "1.0000", certRequired: opts.certRequired ?? null },
  });
}

/** Gives a part revision 1 with one step — the orderability precondition createOrder enforces
 *  (spec §5.3), the certs.test.ts precedent. */
async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `CRTHT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

/** A live, orderable customer + part, and the ORDER created from it — through the SERVICE, not a
 *  route under test (the order-routes.test.ts precedent). `certRequired: null` by default, so
 *  order save creates NO order-scope cert — this file's own routes are what create one instead. */
async function savedOrder(opts: { certRequired?: boolean | null } = {}): Promise<{ order: OrderDetail; part: Part; customer: Customer }> {
  const customer = await makeCustomer();
  const part = await makePart(customer.id, { certRequired: opts.certRequired ?? null });
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: 10, weight: "25.00" }],
  }));
  return { order, part, customer };
}

let shipperSeq = 6000;
/** A minimal, live Shipper + ShipperOrder pairing for `orderId` — raw prisma, the certs.test.ts
 *  `makeShipment` precedent. Used ONLY to prove `shipperId` is never accepted from a client. */
async function makeShipment(customerId: string, orderId: string): Promise<{ id: string }> {
  shipperSeq += 1;
  const shipper = await prisma.shipper.create({ data: { shipperNumber: shipperSeq, customerId, shipDate: new Date() } });
  await prisma.shipperOrder.create({ data: { shipperId: shipper.id, orderId, sequence: 1, position: 1 } });
  return shipper;
}

describe("cert routes", () => {
  beforeEach(async () => await truncateAll());

  // ---------------------------------------------------------------------------------------
  // GET /api/certs, POST /api/certs
  // ---------------------------------------------------------------------------------------

  it("GET /api/certs requires certs.view; POST requires certs.create", async () => {
    const { order } = await savedOrder();

    expect((await listRoute(getReq("http://t/api/certs"), noParams)).status).toBe(401);
    expect((await createRoute(
      bodyReq("http://t/api/certs", "POST", undefined, { orderId: order.id, scope: "ORDER" }), noParams,
    )).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "cert-wrong-1");
    expect((await listRoute(getReq("http://t/api/certs", wrong), noParams)).status).toBe(403);
    expect((await createRoute(
      bodyReq("http://t/api/certs", "POST", wrong, { orderId: order.id, scope: "ORDER" }), noParams,
    )).status).toBe(403);

    const viewer = await signInWith(["certs.view"], "cert-view-1");
    expect((await listRoute(getReq("http://t/api/certs", viewer), noParams)).status).toBe(200);

    const creator = await signInWith(["certs.create"], "cert-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/certs", "POST", creator, { orderId: order.id, scope: "ORDER" }), noParams);
    expect(created.status).toBe(200);
    const body = await created.json();
    expect(body.orderId).toBe(order.id);
    expect(body.scope).toBe("ORDER");
  });

  // Task 11 Step 0: the cert-create route must not accept `shipperId` from the client at all —
  // `scope` is resolved server-side (ORDER at order save, SHIPMENT at shipment save, LOAD on
  // demand), and this HTTP surface never mints a SHIPMENT-scope cert.
  it("POST /api/certs rejects a client-supplied shipperId outright", async () => {
    const { order, customer } = await savedOrder();
    const shipper = await makeShipment(customer.id, order.id);
    const creator = await signInWith(["certs.create"], "cert-noshipper-1");

    const res = await createRoute(bodyReq("http://t/api/certs", "POST", creator, {
      orderId: order.id, scope: "ORDER", shipperId: shipper.id,
    }), noParams);
    expect(res.status).toBe(400);
    expect(await prisma.cert.count({ where: { orderId: order.id, shipperId: shipper.id } })).toBe(0);
  });

  it("GET /api/certs/export requires certs.view and streams an xlsx", async () => {
    expect((await exportRoute(getReq("http://t/api/certs/export"), noParams)).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "cert-export-wrong-1");
    expect((await exportRoute(getReq("http://t/api/certs/export", wrong), noParams)).status).toBe(403);

    const viewer = await signInWith(["certs.view"], "cert-export-view-1");
    const res = await exportRoute(getReq("http://t/api/certs/export", viewer), noParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/spreadsheetml/);
  });

  // ---------------------------------------------------------------------------------------
  // GET/PATCH/DELETE /api/certs/[id]
  // ---------------------------------------------------------------------------------------

  it("GET /api/certs/[id] requires certs.view; PATCH requires certs.edit", async () => {
    const { order } = await savedOrder();
    const creator = await signInWith(["certs.create"], "cert-detail-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/certs", "POST", creator, { orderId: order.id, scope: "ORDER" }), noParams);
    const cert = await created.json();

    expect((await getRoute(getReq(`http://t/api/certs/${cert.id}`), withParams({ id: cert.id }))).status).toBe(401);
    expect((await patchRoute(
      bodyReq(`http://t/api/certs/${cert.id}`, "PATCH", undefined, { freeform: "hi" }),
      withParams({ id: cert.id }))).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "cert-detail-wrong-1");
    expect((await getRoute(getReq(`http://t/api/certs/${cert.id}`, wrong), withParams({ id: cert.id }))).status).toBe(403);
    expect((await patchRoute(
      bodyReq(`http://t/api/certs/${cert.id}`, "PATCH", wrong, { freeform: "hi" }),
      withParams({ id: cert.id }))).status).toBe(403);

    const viewer = await signInWith(["certs.view"], "cert-detail-view-1");
    const got = await getRoute(getReq(`http://t/api/certs/${cert.id}`, viewer), withParams({ id: cert.id }));
    expect(got.status).toBe(200);

    const editor = await signInWith(["certs.edit"], "cert-detail-edit-1");
    const patched = await patchRoute(
      bodyReq(`http://t/api/certs/${cert.id}`, "PATCH", editor, { freeform: "Heat 1234" }),
      withParams({ id: cert.id }));
    expect(patched.status).toBe(200);
    expect((await patched.json()).freeform).toBe("Heat 1234");
  });

  it("DELETE /api/certs/[id] requires certs.delete and a reason", async () => {
    const { order } = await savedOrder();
    const creator = await signInWith(["certs.create"], "cert-void-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/certs", "POST", creator, { orderId: order.id, scope: "ORDER" }), noParams);
    const cert = await created.json();

    expect((await voidRoute(
      noBodyReq(`http://t/api/certs/${cert.id}`, "DELETE"), withParams({ id: cert.id }))).status).toBe(401);

    const wrong = await signInWith(["certs.view", "certs.edit"], "cert-void-wrong-1");
    expect((await voidRoute(
      bodyReq(`http://t/api/certs/${cert.id}`, "DELETE", wrong, { reason: "duplicate" }),
      withParams({ id: cert.id }))).status).toBe(403);

    const deleter = await signInWith(["certs.delete"], "cert-void-1");
    const noReason = await voidRoute(
      noBodyReq(`http://t/api/certs/${cert.id}`, "DELETE", deleter), withParams({ id: cert.id }));
    expect(noReason.status).toBe(400);

    const ok = await voidRoute(
      bodyReq(`http://t/api/certs/${cert.id}`, "DELETE", deleter, { reason: "duplicate cert" }),
      withParams({ id: cert.id }));
    expect(ok.status).toBe(200);

    const row = await prisma.cert.findFirst({ where: { id: cert.id } });
    expect(row!.deletedAt).not.toBeNull();
    const entry = await prisma.auditLog.findFirst({ where: { entity: "cert", entityId: cert.id, action: "delete" } });
    expect(entry?.reason).toBe("duplicate cert");
  });

  // ---------------------------------------------------------------------------------------
  // PUT /api/certs/[id]/results
  // ---------------------------------------------------------------------------------------

  it("PUT /api/certs/[id]/results requires certs.edit, and once printed additionally requires edit_cert_results_after_print", async () => {
    const { order } = await savedOrder();
    const creator = await signInWith(["certs.create"], "cert-results-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/certs", "POST", creator, { orderId: order.id, scope: "ORDER" }), noParams);
    const cert = await created.json();
    const url = `http://t/api/certs/${cert.id}/results`;

    expect((await resultsRoute(
      bodyReq(url, "PUT", undefined, { requirements: [] }), withParams({ id: cert.id }))).status).toBe(401);

    const wrong = await signInWith(["certs.view"], "cert-results-wrong-1");
    expect((await resultsRoute(
      bodyReq(url, "PUT", wrong, { requirements: [] }), withParams({ id: cert.id }))).status).toBe(403);

    const editor = await signInWith(["certs.edit"], "cert-results-edit-1");
    const ok = await resultsRoute(
      bodyReq(url, "PUT", editor, { requirements: [] }), withParams({ id: cert.id }));
    expect(ok.status).toBe(200);

    // Once printed, plain certs.edit is no longer enough.
    await prisma.cert.update({ where: { id: cert.id }, data: { printedAt: new Date() } });
    const blocked = await resultsRoute(
      bodyReq(url, "PUT", editor, { requirements: [] }), withParams({ id: cert.id }));
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).error).toMatch(/already been printed/i);

    const afterPrintEditor = await signInWith(
      ["certs.edit", "action.edit_cert_results_after_print"], "cert-results-afterprint-1");
    const allowed = await resultsRoute(
      bodyReq(url, "PUT", afterPrintEditor, { requirements: [] }), withParams({ id: cert.id }));
    expect(allowed.status).toBe(200);
  });

  // ---------------------------------------------------------------------------------------
  // GET/POST /api/orders/[id]/certs
  // ---------------------------------------------------------------------------------------

  it("GET /api/orders/[id]/certs requires certs.view; POST (load-scope) requires certs.create", async () => {
    const { order } = await savedOrder();

    expect((await certsForOrderRoute(
      getReq(`http://t/api/orders/${order.id}/certs`), withParams({ id: order.id }))).status).toBe(401);
    expect((await createLoadCertRoute(
      bodyReq(`http://t/api/orders/${order.id}/certs`, "POST", undefined, { loadNumber: 1 }),
      withParams({ id: order.id }))).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "cert-forord-wrong-1");
    expect((await certsForOrderRoute(
      getReq(`http://t/api/orders/${order.id}/certs`, wrong), withParams({ id: order.id }))).status).toBe(403);
    expect((await createLoadCertRoute(
      bodyReq(`http://t/api/orders/${order.id}/certs`, "POST", wrong, { loadNumber: 1 }),
      withParams({ id: order.id }))).status).toBe(403);

    const viewer = await signInWith(["certs.view"], "cert-forord-view-1");
    const list = await certsForOrderRoute(
      getReq(`http://t/api/orders/${order.id}/certs`, viewer), withParams({ id: order.id }));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);

    const creator = await signInWith(["certs.create"], "cert-forord-create-1");
    const created = await createLoadCertRoute(
      bodyReq(`http://t/api/orders/${order.id}/certs`, "POST", creator, { loadNumber: 1 }),
      withParams({ id: order.id }));
    expect(created.status).toBe(200);
    const body = await created.json();
    expect(body.scope).toBe("LOAD");
    expect(body.loadNumber).toBe(1);
  });

  // Task 11 Step 0, applied to the load-scope route too: `scope` is fixed to `"LOAD"` and
  // `shipperId` is never a field this route's schema even recognizes.
  it("POST /api/orders/[id]/certs rejects an attempt to smuggle scope or shipperId in the body", async () => {
    const { order, customer } = await savedOrder();
    const shipper = await makeShipment(customer.id, order.id);
    const creator = await signInWith(["certs.create"], "cert-forord-noshipper-1");

    const res = await createLoadCertRoute(bodyReq(`http://t/api/orders/${order.id}/certs`, "POST", creator, {
      loadNumber: 1, scope: "SHIPMENT" as CertScopeValue, shipperId: shipper.id,
    }), withParams({ id: order.id }));
    expect(res.status).toBe(400);
    expect(await prisma.cert.count({ where: { orderId: order.id, shipperId: shipper.id } })).toBe(0);
  });
});
