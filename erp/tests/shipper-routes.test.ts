import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import { storeDocument } from "@/server/documents";
import type { Customer, Part } from "../prisma/generated/prisma/client";

import { GET as listRoute, POST as createRoute } from "@/app/api/shippers/route";
import { GET as exportRoute } from "@/app/api/shippers/export/route";
import { GET as getRoute, PATCH as patchRoute, DELETE as voidRoute } from "@/app/api/shippers/[id]/route";
import { POST as addOrderRoute } from "@/app/api/shippers/[id]/orders/route";
import { DELETE as removeOrderRoute } from "@/app/api/shippers/[id]/orders/[shipperOrderId]/route";
import { PUT as replaceLinesRoute } from "@/app/api/shippers/[id]/orders/[shipperOrderId]/lines/route";
import { PUT as replaceContainersRoute } from "@/app/api/shippers/[id]/orders/[shipperOrderId]/containers/route";
import { PUT as replaceSerialsRoute } from "@/app/api/shippers/[id]/orders/[shipperOrderId]/serials/route";
import { GET as shipmentsForOrderRoute } from "@/app/api/orders/[id]/shipments/route";
import { GET as shipperDocumentsRoute } from "@/app/api/shippers/[id]/documents/route";

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
async function makeCustomer(opts: { creditHold?: boolean } = {}): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({
    data: { code: `SRC${customerSeq}`, name: `Ship Route Customer ${customerSeq}`, creditHold: opts.creditHold ?? false },
  });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({ data: { customerId, partNumber: `SRP-${partSeq}`, eachWeight: "1.0000" } });
}

/** Gives a part revision 1 with one step — the orderability precondition createOrder enforces
 *  (spec §5.3), the shippers.test.ts `giveSteps` precedent. */
async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `SRHT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

/** A live, orderable customer + part, and the ORDER created from it — through the SERVICE, not a
 *  route under test (the order-routes.test.ts `orderFixture` precedent: a bug in some order route
 *  must never be able to mask a bug in the shipment route this file actually tests). */
async function orderFixture(opts: { creditHold?: boolean; qty?: number } = {}) {
  const customer = await makeCustomer({ creditHold: opts.creditHold });
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: opts.qty ?? 10, weight: "25.00" }],
  }));
  return { customer, part, order };
}

function oneOrderInput(order: OrderDetail, qty?: number) {
  return {
    customerId: order.customerId,
    shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: [{
        orderLineId: order.lines[0].id, qty: qty ?? order.lines[0].qty, weight: order.lines[0].weight,
        lineComplete: false,
      }],
      containers: [] as { orderContainerId: string; count: number }[],
      serials: [] as { orderSerialId: string; printOnShipper?: boolean }[],
    }],
  };
}

describe("shipper routes", () => {
  beforeEach(async () => await truncateAll());

  // ---------------------------------------------------------------------------------------
  // GET /api/shippers, POST /api/shippers
  // ---------------------------------------------------------------------------------------

  it("GET /api/shippers requires shipping.view; POST requires shipping.create", async () => {
    const { order } = await orderFixture();

    expect((await listRoute(getReq("http://t/api/shippers"), noParams)).status).toBe(401);
    expect((await createRoute(bodyReq("http://t/api/shippers", "POST", undefined, {}), noParams)).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "ship-wrong-1");
    expect((await listRoute(getReq("http://t/api/shippers", wrong), noParams)).status).toBe(403);
    expect((await createRoute(
      bodyReq("http://t/api/shippers", "POST", wrong, oneOrderInput(order)), noParams,
    )).status).toBe(403);

    const viewer = await signInWith(["shipping.view"], "ship-view-1");
    expect((await listRoute(getReq("http://t/api/shippers", viewer), noParams)).status).toBe(200);

    const creator = await signInWith(["shipping.create"], "ship-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);
    expect(created.status).toBe(200);
    const body = await created.json();
    expect(typeof body.shipper.shipperNumber).toBe("number");
    expect(body.warnings).toEqual([]);
    expect(body.deduped).toBe(false);
  });

  it("POST /api/shippers: a session without override_credit_hold is refused on a held customer even with a reason", async () => {
    const { order } = await orderFixture({ creditHold: true });
    const creator = await signInWith(["shipping.create"], "ship-hold-1");

    const withReason = await createRoute(bodyReq("http://t/api/shippers", "POST", creator, {
      ...oneOrderInput(order), creditHoldReason: "trust me",
    }), noParams);
    expect(withReason.status).toBe(400);
    expect((await withReason.json()).error).toMatch(/credit hold/i);

    const overrider = await signInWith(["shipping.create", "action.override_credit_hold"], "ship-hold-2");

    const noReason = await createRoute(
      bodyReq("http://t/api/shippers", "POST", overrider, oneOrderInput(order)), noParams);
    expect(noReason.status).toBe(400);
    expect((await noReason.json()).error).toMatch(/reason/i);

    const ok = await createRoute(bodyReq("http://t/api/shippers", "POST", overrider, {
      ...oneOrderInput(order), creditHoldReason: "owner approved",
    }), noParams);
    expect(ok.status).toBe(200);
  });

  it("GET /api/shippers/export requires shipping.view and streams an xlsx", async () => {
    expect((await exportRoute(getReq("http://t/api/shippers/export"), noParams)).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "ship-export-wrong-1");
    expect((await exportRoute(getReq("http://t/api/shippers/export", wrong), noParams)).status).toBe(403);

    const viewer = await signInWith(["shipping.view"], "ship-export-view-1");
    const res = await exportRoute(getReq("http://t/api/shippers/export", viewer), noParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/spreadsheetml/);
  });

  // ---------------------------------------------------------------------------------------
  // GET/PATCH/DELETE /api/shippers/[id]
  // ---------------------------------------------------------------------------------------

  it("GET /api/shippers/[id] requires shipping.view; PATCH requires shipping.edit", async () => {
    const { order } = await orderFixture();
    const creator = await signInWith(["shipping.create"], "ship-detail-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);
    const { shipper } = await created.json();

    expect((await getRoute(getReq(`http://t/api/shippers/${shipper.id}`), withParams({ id: shipper.id }))).status).toBe(401);
    expect((await patchRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}`, "PATCH", undefined, { route: "Dock 3" }),
      withParams({ id: shipper.id }))).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "ship-detail-wrong-1");
    expect((await getRoute(
      getReq(`http://t/api/shippers/${shipper.id}`, wrong), withParams({ id: shipper.id }))).status).toBe(403);
    expect((await patchRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}`, "PATCH", wrong, { route: "Dock 3" }),
      withParams({ id: shipper.id }))).status).toBe(403);

    const viewer = await signInWith(["shipping.view"], "ship-detail-view-1");
    const got = await getRoute(getReq(`http://t/api/shippers/${shipper.id}`, viewer), withParams({ id: shipper.id }));
    expect(got.status).toBe(200);
    const gotBody = await got.json();
    // GET is wrapped through `shipperResponse` too (review round 2, 2026-08-04): the shipment
    // page remounts per id and renders §5.7's warnings on a plain load, not only right after an
    // edit, so GET carries the same { shipper, warnings } shape every mutator does.
    expect(gotBody.shipper.id).toBe(shipper.id);
    expect(gotBody.warnings).toEqual([]);

    const editor = await signInWith(["shipping.edit"], "ship-detail-edit-1");
    const patched = await patchRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}`, "PATCH", editor, { route: "Dock 3" }),
      withParams({ id: shipper.id }));
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    // Step 0b: PATCH wraps its response in the same { shipper, warnings } shape POST established.
    expect(patchedBody.shipper.route).toBe("Dock 3");
    expect(patchedBody.warnings).toEqual([]);
  });

  it("GET /api/shippers/[id] surfaces an over-ship warning that was created in an earlier request, with no mutation of its own", async () => {
    const { order } = await orderFixture({ qty: 10 });
    const creator = await signInWith(["shipping.create"], "ship-getwarn-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);
    const { shipper } = await created.json();
    const shipperOrderId = shipper.orders[0].id;

    // Over-ship the line in one request (PUT .../lines) — a separate request from the GET below,
    // so the GET's warning cannot be riding on anything this test's own call just wrote.
    const editor = await signInWith(["shipping.edit"], "ship-getwarn-edit-1");
    const linesBody = [{ orderLineId: order.lines[0].id, qty: 999, weight: order.lines[0].weight, lineComplete: false }];
    const putRes = await replaceLinesRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}/orders/${shipperOrderId}/lines`, "PUT", editor, linesBody),
      withParams({ id: shipper.id, shipperOrderId }));
    expect(putRes.status).toBe(200);

    // A FRESH GET, as a plain read with no body of its own — this is the property being bought:
    // the warning is visible on load, not only in the response of the mutation that created it.
    const viewer = await signInWith(["shipping.view"], "ship-getwarn-view-1");
    const res = await getRoute(getReq(`http://t/api/shippers/${shipper.id}`, viewer), withParams({ id: shipper.id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings.join(" ")).toMatch(/exceeds/i);
  });

  it("DELETE /api/shippers/[id]: void_shipper is required even with all four shipping.* CRUD grants, and a reason is required", async () => {
    const { order } = await orderFixture();
    const creator = await signInWith(["shipping.create"], "ship-void-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);
    const { shipper } = await created.json();

    expect((await voidRoute(
      noBodyReq(`http://t/api/shippers/${shipper.id}`, "DELETE"), withParams({ id: shipper.id }))).status).toBe(401);

    const fullCrud = await signInWith(
      ["shipping.view", "shipping.create", "shipping.edit", "shipping.delete"], "ship-void-fullcrud-1");
    const denied = await voidRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}`, "DELETE", fullCrud, { reason: "wrong order" }),
      withParams({ id: shipper.id }));
    expect(denied.status).toBe(403);

    const voider = await signInWith(["action.void_shipper"], "ship-void-only-1");

    const noReason = await voidRoute(
      noBodyReq(`http://t/api/shippers/${shipper.id}`, "DELETE", voider), withParams({ id: shipper.id }));
    expect(noReason.status).toBe(400);
    expect((await noReason.json()).error).toMatch(/reason/i);

    const ok = await voidRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}`, "DELETE", voider, { reason: "shipped to wrong customer" }),
      withParams({ id: shipper.id }));
    expect(ok.status).toBe(200);

    const row = await prisma.shipper.findFirst({ where: { id: shipper.id } });
    expect(row!.deletedAt).not.toBeNull();
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "shipper", entityId: shipper.id, action: "delete" },
    });
    expect(entry?.reason).toBe("shipped to wrong customer");
  });

  // ---------------------------------------------------------------------------------------
  // POST/DELETE .../orders, PUT .../lines /containers /serials
  // ---------------------------------------------------------------------------------------

  it("POST/DELETE .../orders require shipping.edit and both return the wrapped { shipper, warnings } shape", async () => {
    const { customer, order: orderA } = await orderFixture();
    const partB = await makePart(customer.id);
    await giveSteps(partB.id);
    const { order: orderB } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: partB.id, qty: 10, weight: "25.00" }],
    }));

    const creator = await signInWith(["shipping.create"], "ship-mos-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(orderA)), noParams);
    const { shipper } = await created.json();

    // ---- POST .../orders (add orderB) ----
    expect((await addOrderRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}/orders`, "POST", undefined, { orderId: orderB.id }),
      withParams({ id: shipper.id }))).status).toBe(401);

    const wrong = await signInWith(["shipping.view"], "ship-mos-wrong-1");
    expect((await addOrderRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}/orders`, "POST", wrong, { orderId: orderB.id }),
      withParams({ id: shipper.id }))).status).toBe(403);

    const editor = await signInWith(["shipping.edit"], "ship-mos-edit-1");
    const added = await addOrderRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}/orders`, "POST", editor, { orderId: orderB.id }),
      withParams({ id: shipper.id }));
    expect(added.status).toBe(200);
    const addedBody = await added.json();
    expect(addedBody.shipper.orders.map((o: { orderId: string }) => o.orderId)).toContain(orderB.id);
    expect(addedBody.warnings).toEqual([]);
    const shipperOrderB = addedBody.shipper.orders.find((o: { orderId: string }) => o.orderId === orderB.id).id;

    // ---- DELETE .../orders/[shipperOrderId] (remove orderB again — orderA remains, so this is legal) ----
    const removeUrl = `http://t/api/shippers/${shipper.id}/orders/${shipperOrderB}`;
    expect((await removeOrderRoute(
      noBodyReq(removeUrl, "DELETE"), withParams({ id: shipper.id, shipperOrderId: shipperOrderB }))).status).toBe(401);
    expect((await removeOrderRoute(
      noBodyReq(removeUrl, "DELETE", wrong), withParams({ id: shipper.id, shipperOrderId: shipperOrderB }))).status).toBe(403);

    const removed = await removeOrderRoute(
      noBodyReq(removeUrl, "DELETE", editor), withParams({ id: shipper.id, shipperOrderId: shipperOrderB }));
    expect(removed.status).toBe(200);
    const removedBody = await removed.json();
    expect(removedBody.shipper.orders.map((o: { orderId: string }) => o.orderId)).not.toContain(orderB.id);
    expect(removedBody.warnings).toEqual([]);
  });

  it("PUT .../lines requires shipping.edit, returns the wrapped shape, and surfaces an over-ship warning through the route", async () => {
    const { order } = await orderFixture({ qty: 10 });
    const creator = await signInWith(["shipping.create"], "ship-lines-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);
    const { shipper } = await created.json();
    const shipperOrderId = shipper.orders[0].id;
    const url = `http://t/api/shippers/${shipper.id}/orders/${shipperOrderId}/lines`;
    const linesBody = [{ orderLineId: order.lines[0].id, qty: 999, weight: order.lines[0].weight, lineComplete: false }];

    expect((await replaceLinesRoute(
      bodyReq(url, "PUT", undefined, linesBody), withParams({ id: shipper.id, shipperOrderId }))).status).toBe(401);

    const wrong = await signInWith(["shipping.view"], "ship-lines-wrong-1");
    expect((await replaceLinesRoute(
      bodyReq(url, "PUT", wrong, linesBody), withParams({ id: shipper.id, shipperOrderId }))).status).toBe(403);

    const editor = await signInWith(["shipping.edit"], "ship-lines-edit-1");
    const res = await replaceLinesRoute(
      bodyReq(url, "PUT", editor, linesBody), withParams({ id: shipper.id, shipperOrderId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Step 0b, the brief's own named requirement: over-shipping surfaces through the ROUTE
    // response, not only through the service's separately-exported `overshipWarnings`.
    expect(body.shipper.orders[0].lines[0].qty).toBe(999);
    expect(body.warnings.join(" ")).toMatch(/exceeds/i);
  });

  it("edit responses recompute missing-serialization warnings, not only over-ship (#54)", async () => {
    const { part, order } = await orderFixture();
    await prisma.part.update({ where: { id: part.id }, data: { serializationRequired: true } });
    const orderSerial = await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: "SR-W-1", description: "" },
    });

    const creator = await signInWith(["shipping.create"], "ship-warn-create");
    const input = oneOrderInput(order);
    input.orders[0].serials = [{ orderSerialId: orderSerial.id, printOnShipper: true }];
    const created = await createRoute(bodyReq("http://t/api/shippers", "POST", creator, input), noParams);
    const createdBody = await created.json();
    expect(createdBody.warnings.join(" ")).not.toMatch(/no serial numbers/i); // serial selected

    // Removing the LAST selected serial via the route must re-raise the §5.7 warning creation
    // would have raised — the detail page swaps its banner for exactly this array.
    const editor = await signInWith(["shipping.edit"], "ship-warn-edit");
    const shipperOrderId = createdBody.shipper.orders[0].id;
    const serialsUrl = `http://t/api/shippers/${createdBody.shipper.id}/orders/${shipperOrderId}/serials`;
    const res = await replaceSerialsRoute(
      bodyReq(serialsUrl, "PUT", editor, []), withParams({ id: createdBody.shipper.id, shipperOrderId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings.join(" ")).toMatch(/no serial numbers/i);
  });

  it("PUT .../containers and .../serials require shipping.edit and return the wrapped shape", async () => {
    const { order } = await orderFixture();
    const containerType = await prisma.containerType.create({ data: { name: "SR Basket" } });
    const orderContainer = await prisma.orderContainer.create({
      data: { orderId: order.id, typeId: containerType.id, position: 1, count: 2 },
    });
    const orderSerial = await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: "SR-SER-1", description: "" },
    });

    const creator = await signInWith(["shipping.create"], "ship-cs-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);
    const { shipper } = await created.json();
    const shipperOrderId = shipper.orders[0].id;

    const containersUrl = `http://t/api/shippers/${shipper.id}/orders/${shipperOrderId}/containers`;
    const containersBody = [{ orderContainerId: orderContainer.id, count: 2 }];
    expect((await replaceContainersRoute(
      bodyReq(containersUrl, "PUT", undefined, containersBody),
      withParams({ id: shipper.id, shipperOrderId }))).status).toBe(401);
    const wrong = await signInWith(["shipping.view"], "ship-cs-wrong-1");
    expect((await replaceContainersRoute(
      bodyReq(containersUrl, "PUT", wrong, containersBody),
      withParams({ id: shipper.id, shipperOrderId }))).status).toBe(403);
    const editor = await signInWith(["shipping.edit"], "ship-cs-edit-1");
    const containersRes = await replaceContainersRoute(
      bodyReq(containersUrl, "PUT", editor, containersBody), withParams({ id: shipper.id, shipperOrderId }));
    expect(containersRes.status).toBe(200);
    const containersJson = await containersRes.json();
    expect(containersJson.shipper.orders[0].containers).toHaveLength(1);
    expect(containersJson.warnings).toEqual([]);

    const serialsUrl = `http://t/api/shippers/${shipper.id}/orders/${shipperOrderId}/serials`;
    const serialsBody = [{ orderSerialId: orderSerial.id, printOnShipper: true }];
    expect((await replaceSerialsRoute(
      bodyReq(serialsUrl, "PUT", undefined, serialsBody),
      withParams({ id: shipper.id, shipperOrderId }))).status).toBe(401);
    expect((await replaceSerialsRoute(
      bodyReq(serialsUrl, "PUT", wrong, serialsBody),
      withParams({ id: shipper.id, shipperOrderId }))).status).toBe(403);
    const serialsRes = await replaceSerialsRoute(
      bodyReq(serialsUrl, "PUT", editor, serialsBody), withParams({ id: shipper.id, shipperOrderId }));
    expect(serialsRes.status).toBe(200);
    const serialsJson = await serialsRes.json();
    expect(serialsJson.shipper.orders[0].serials).toHaveLength(1);
    expect(serialsJson.warnings).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------
  // GET /api/orders/[id]/shipments
  // ---------------------------------------------------------------------------------------

  it("GET /api/orders/[id]/shipments requires shipping.view", async () => {
    const { order } = await orderFixture();
    const creator = await signInWith(["shipping.create"], "ship-forord-create-1");
    await createRoute(bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);

    expect((await shipmentsForOrderRoute(
      getReq(`http://t/api/orders/${order.id}/shipments`), withParams({ id: order.id }))).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "ship-forord-wrong-1");
    expect((await shipmentsForOrderRoute(
      getReq(`http://t/api/orders/${order.id}/shipments`, wrong), withParams({ id: order.id }))).status).toBe(403);

    const viewer = await signInWith(["shipping.view"], "ship-forord-view-1");
    const res = await shipmentsForOrderRoute(
      getReq(`http://t/api/orders/${order.id}/shipments`, viewer), withParams({ id: order.id }));
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------------------
  // GET /api/shippers/[id]/documents (Task 14: the shipment page's stored-documents list —
  // `listDocumentsForShipper` (documents.ts, Task 3) had no HTTP caller before this route).
  // ---------------------------------------------------------------------------------------

  it("GET /api/shippers/[id]/documents requires shipping.view and lists this shipment's SHIPPER/BOL documents", async () => {
    const { order } = await orderFixture();
    const creator = await signInWith(["shipping.create"], "ship-docs-create-1");
    const created = await createRoute(bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);
    const { shipper } = await created.json();

    const url = `http://t/api/shippers/${shipper.id}/documents`;
    expect((await shipperDocumentsRoute(getReq(url), withParams({ id: shipper.id }))).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "ship-docs-wrong-1");
    expect((await shipperDocumentsRoute(getReq(url, wrong), withParams({ id: shipper.id }))).status).toBe(403);

    const viewer = await signInWith(["shipping.view"], "ship-docs-view-1");
    const empty = await shipperDocumentsRoute(getReq(url, viewer), withParams({ id: shipper.id }));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    const bol = await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "BOL", shipperId: shipper.id }, Buffer.from("%PDF-1.4 bol")));

    const withDoc = await shipperDocumentsRoute(getReq(url, viewer), withParams({ id: shipper.id }));
    expect(withDoc.status).toBe(200);
    const docs = await withDoc.json();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ id: bol.id, kind: "BOL", shipperId: shipper.id, orderId: null, certId: null });
    // Metadata only, never the bytes — the cert sibling's own assertion (cert-routes.test.ts),
    // mirrored here (fix-wave 2026-08-06): a route that started selecting `fileData` would ship
    // every stored PDF's bytes with every list render.
    expect("fileData" in docs[0]).toBe(false);

    // An unknown shipper is a 404, not an empty list (the cert sibling's case, mirrored).
    expect((await shipperDocumentsRoute(
      getReq("http://t/api/shippers/nope/documents", viewer), withParams({ id: "nope" }))).status).toBe(404);
  });
});
