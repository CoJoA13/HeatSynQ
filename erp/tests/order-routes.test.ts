import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { createOrder } from "@/server/orders";
import { addBusinessDays, formatDateOnly, todayDateOnly } from "@/lib/business-days";

import { GET as listRoute, POST as createRoute } from "@/app/api/orders/route";
import { GET as exportRoute } from "@/app/api/orders/export/route";
import { GET as getRoute, PATCH as patchRoute, DELETE as voidRoute } from "@/app/api/orders/[id]/route";
import { POST as addLineRoute } from "@/app/api/orders/[id]/lines/route";
import { PATCH as patchLineRoute, DELETE as removeLineRoute } from "@/app/api/orders/[id]/lines/[lineId]/route";
import { PUT as replaceSerialsRoute } from "@/app/api/orders/[id]/lines/[lineId]/serials/route";
import { PUT as replaceContainersRoute } from "@/app/api/orders/[id]/containers/route";
import { PUT as replaceChargesRoute } from "@/app/api/orders/[id]/charges/route";
import { PUT as replaceLoadsRoute } from "@/app/api/orders/[id]/loads/route";
import { POST as resplitRoute } from "@/app/api/orders/[id]/loads/resplit/route";
import { POST as linkRoute } from "@/app/api/orders/[id]/link/route";
import { POST as unlinkRoute } from "@/app/api/orders/[id]/unlink/route";
import { GET as entryDefaultsRoute } from "@/app/api/orders/entry-defaults/route";

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

/** Revision 1 with one step — the orderability precondition (spec §5.3), built with raw prisma
 *  so this test file does not depend on the process-steps service to construct its own fixture
 *  (the orders.test.ts / part-process-steps.test.ts precedent). */
async function giveSteps(partId: string, codeId: string) {
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId, instruction: "Austenitize at 1650F." },
  });
}

/** ACME + a lead part (step-bearing, orderable) + a rider part (no revision — exempt) + a second
 *  customer (BETA) for cross-customer checks + a container type. Everything a route test needs to
 *  exercise every handler at least once without reaching into orders.ts's own deeper fixtures. */
async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Gear" } });
  const other = await prisma.customer.create({ data: { code: "BETA", name: "Beta Co" } });
  const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
  const lead = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "3541720C3", name: "Ring gear", eachWeight: "13.5000" },
  });
  const rider = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "3541720C4", name: "Ring gear B", eachWeight: "13.5000" },
  });
  await giveSteps(lead.id, code.id);
  const containerType = await prisma.containerType.create({ data: { name: "Basket" } });
  return { customer, other, code, lead, rider, containerType };
}

/** One saved single-line order (through the service, not the route under test — a route bug in
 *  POST /api/orders must never be able to mask a bug in some other route's own test). No
 *  loadQty/loadWeight on the lead, so it auto-splits into exactly one load. */
async function orderFixture() {
  const built = await fixture();
  const { order } = await asSystem(() => createOrder({
    customerId: built.customer.id, lines: [{ partId: built.lead.id, qty: 10, weight: "135.00" }],
  }));
  return { ...built, order };
}

describe("order routes", () => {
  beforeEach(async () => await truncateAll());

  // ---------------------------------------------------------------------------------------
  // GET /api/orders (board), POST /api/orders (create)
  // ---------------------------------------------------------------------------------------

  it("GET /api/orders requires orders.view; POST requires orders.create", async () => {
    const { customer, lead } = await fixture();

    expect((await listRoute(getReq("http://t/api/orders"), noParams)).status).toBe(401);
    expect((await createRoute(bodyReq("http://t/api/orders", "POST", undefined, {}), noParams)).status).toBe(401);

    const wrong = await signInWith(["customers.view"], "list-wrong-1");
    expect((await listRoute(getReq("http://t/api/orders", wrong), noParams)).status).toBe(403);

    const viewOnly = await signInWith(["orders.view"], "list-view-1");
    expect((await listRoute(getReq("http://t/api/orders", viewOnly), noParams)).status).toBe(200);
    expect((await createRoute(
      bodyReq("http://t/api/orders", "POST", viewOnly, { customerId: customer.id, lines: [] }), noParams,
    )).status).toBe(403);

    const creator = await signInWith(["orders.create"], "list-create-1");
    const created = await createRoute(bodyReq("http://t/api/orders", "POST", creator, {
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }), noParams);
    expect(created.status).toBe(200);
    const body = await created.json();
    expect(typeof body.order.orderNumber).toBe("number");
    expect(body.warnings).toEqual([]);
  });

  it("POST /api/orders with a non-object JSON body is 400, not 500", async () => {
    const creator = await signInWith(["orders.create"], "create-null-1");
    const res = await createRoute(bodyReq("http://t/api/orders", "POST", creator, null), noParams);
    expect(res.status).toBe(400);
  });

  it("GET /api/orders: status accepts repeatable or comma-separated values, rejects an unknown one", async () => {
    const { order } = await orderFixture();
    const viewer = await signInWith(["orders.view"], "status-viewer-1");

    const comma = await listRoute(getReq("http://t/api/orders?status=OPEN,SHIPPED", viewer), noParams);
    expect(comma.status).toBe(200);
    expect((await comma.json()).map((r: { id: string }) => r.id)).toContain(order.id);

    const repeatable = await listRoute(
      getReq("http://t/api/orders?status=OPEN&status=SHIPPED", viewer), noParams);
    expect(repeatable.status).toBe(200);
    expect((await repeatable.json()).map((r: { id: string }) => r.id)).toContain(order.id);

    const excluded = await listRoute(getReq("http://t/api/orders?status=SHIPPED", viewer), noParams);
    expect(excluded.status).toBe(200);
    expect(await excluded.json()).toEqual([]);

    const bogus = await listRoute(getReq("http://t/api/orders?status=BOGUS", viewer), noParams);
    expect(bogus.status).toBe(400);
    expect((await bogus.json()).error).toMatch(/BOGUS/);
  });

  it("GET /api/orders: a blank date query param is absent, not a parse failure", async () => {
    const { order } = await orderFixture();
    const viewer = await signInWith(["orders.view"], "date-viewer-1");

    const blank = await listRoute(
      getReq("http://t/api/orders?receivedFrom=&receivedTo=", viewer), noParams);
    expect(blank.status).toBe(200);
    expect((await blank.json()).map((r: { id: string }) => r.id)).toContain(order.id);

    const malformed = await listRoute(
      getReq("http://t/api/orders?receivedFrom=not-a-date", viewer), noParams);
    expect(malformed.status).toBe(400);
  });

  // ---------------------------------------------------------------------------------------
  // GET /api/orders/export
  // ---------------------------------------------------------------------------------------

  it("GET /api/orders/export requires orders.view and streams an xlsx", async () => {
    await orderFixture();
    expect((await exportRoute(getReq("http://t/api/orders/export"), noParams)).status).toBe(401);

    const wrong = await signInWith(["customers.view"], "export-wrong-1");
    expect((await exportRoute(getReq("http://t/api/orders/export", wrong), noParams)).status).toBe(403);

    const viewer = await signInWith(["orders.view"], "export-viewer-1");
    const res = await exportRoute(getReq("http://t/api/orders/export", viewer), noParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain(".xlsx");
  });

  // ---------------------------------------------------------------------------------------
  // GET / PATCH /api/orders/[id]
  // ---------------------------------------------------------------------------------------

  it("GET /api/orders/[id] requires orders.view; PATCH requires orders.edit", async () => {
    const { order } = await orderFixture();

    expect((await getRoute(getReq(`http://t/api/orders/${order.id}`), withParams({ id: order.id }))).status)
      .toBe(401);
    expect((await patchRoute(
      bodyReq(`http://t/api/orders/${order.id}`, "PATCH", undefined, { notes: "x" }),
      withParams({ id: order.id }))).status).toBe(401);

    const viewOnly = await signInWith(["orders.view"], "detail-view-1");
    expect((await getRoute(getReq(`http://t/api/orders/${order.id}`, viewOnly), withParams({ id: order.id })))
      .status).toBe(200);
    expect((await patchRoute(
      bodyReq(`http://t/api/orders/${order.id}`, "PATCH", viewOnly, { notes: "x" }),
      withParams({ id: order.id }))).status).toBe(403);

    const editor = await signInWith(["orders.edit"], "detail-edit-1");
    const patched = await patchRoute(
      bodyReq(`http://t/api/orders/${order.id}`, "PATCH", editor, { notes: "updated" }),
      withParams({ id: order.id }));
    expect(patched.status).toBe(200);
    expect((await patched.json()).order.notes).toBe("updated");
  });

  it("PATCH /api/orders/[id] rejects an empty body with 400 rather than a no-op 200", async () => {
    const { order } = await orderFixture();
    const editor = await signInWith(["orders.edit"], "detail-empty-1");
    const res = await patchRoute(
      bodyReq(`http://t/api/orders/${order.id}`, "PATCH", editor, {}), withParams({ id: order.id }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at least one change/);
  });

  it("PATCH /api/orders/[id] with a non-object JSON body is 400, not 500", async () => {
    const { order } = await orderFixture();
    const editor = await signInWith(["orders.edit"], "detail-nullbody-1");
    const res = await patchRoute(
      bodyReq(`http://t/api/orders/${order.id}`, "PATCH", editor, null), withParams({ id: order.id }));
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------------------
  // DELETE /api/orders/[id] (void) — mustDo("void_order"), never orders.* CRUD
  // ---------------------------------------------------------------------------------------

  it("DELETE /api/orders/[id]: void_order is required even with the full orders CRUD set", async () => {
    const { order } = await orderFixture();

    expect((await voidRoute(
      noBodyReq(`http://t/api/orders/${order.id}`, "DELETE"), withParams({ id: order.id }))).status).toBe(401);

    const fullCrud = await signInWith(["orders.view", "orders.create", "orders.edit"], "void-fullcrud-1");
    const denied = await voidRoute(
      bodyReq(`http://t/api/orders/${order.id}`, "DELETE", fullCrud, { reason: "wrong part" }),
      withParams({ id: order.id }));
    expect(denied.status).toBe(403);
  });

  it("DELETE /api/orders/[id]: void_order ALONE (no orders.* at all) is sufficient", async () => {
    const { order } = await orderFixture();
    const voider = await signInWith(["action.void_order"], "void-only-1");

    const noReason = await voidRoute(
      noBodyReq(`http://t/api/orders/${order.id}`, "DELETE", voider), withParams({ id: order.id }));
    expect(noReason.status).toBe(400);

    const nullBody = await voidRoute(
      bodyReq(`http://t/api/orders/${order.id}`, "DELETE", voider, null), withParams({ id: order.id }));
    expect(nullBody.status).toBe(400);
    expect((await nullBody.json()).error).toMatch(/reason/i);

    const ok = await voidRoute(
      bodyReq(`http://t/api/orders/${order.id}`, "DELETE", voider, { reason: "keyed wrong part" }),
      withParams({ id: order.id }));
    expect(ok.status).toBe(200);

    const row = await prisma.order.findFirst({ where: { id: order.id } });
    expect(row!.deletedAt).not.toBeNull();
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "order", entityId: order.id, action: "delete" },
    });
    expect(entry?.reason).toBe("keyed wrong part");
  });

  // ---------------------------------------------------------------------------------------
  // POST /api/orders/[id]/lines, PATCH/DELETE .../lines/[lineId]
  // ---------------------------------------------------------------------------------------

  it("POST .../lines requires orders.edit and adds a rider", async () => {
    const { order, rider } = await orderFixture();
    const body = { partId: rider.id, qty: 5, weight: "67.50" };

    expect((await addLineRoute(
      bodyReq(`http://t/api/orders/${order.id}/lines`, "POST", undefined, body),
      withParams({ id: order.id }))).status).toBe(401);

    const viewOnly = await signInWith(["orders.view"], "line-add-view-1");
    expect((await addLineRoute(
      bodyReq(`http://t/api/orders/${order.id}/lines`, "POST", viewOnly, body),
      withParams({ id: order.id }))).status).toBe(403);

    const editor = await signInWith(["orders.edit"], "line-add-edit-1");
    const added = await addLineRoute(
      bodyReq(`http://t/api/orders/${order.id}/lines`, "POST", editor, body), withParams({ id: order.id }));
    expect(added.status).toBe(200);
    const addedOrder = await added.json();
    expect(addedOrder.order.lines).toHaveLength(2);
    expect(addedOrder.order.lines[1]).toMatchObject({ partId: rider.id, qty: 5 });
  });

  it("PATCH/DELETE .../lines/[lineId] requires orders.edit; PATCH rejects an empty body", async () => {
    const { order, rider } = await orderFixture();
    const editor = await signInWith(["orders.edit"], "line-edit-1");
    const added = await addLineRoute(
      bodyReq(`http://t/api/orders/${order.id}/lines`, "POST", editor, { partId: rider.id, qty: 5, weight: "67.50" }),
      withParams({ id: order.id }));
    const lineId: string = (await added.json()).order.lines[1].id;

    expect((await patchLineRoute(
      bodyReq(`http://t/api/orders/${order.id}/lines/${lineId}`, "PATCH", undefined, { qty: 6 }),
      withParams({ id: order.id, lineId }))).status).toBe(401);
    expect((await removeLineRoute(
      noBodyReq(`http://t/api/orders/${order.id}/lines/${lineId}`, "DELETE"),
      withParams({ id: order.id, lineId }))).status).toBe(401);

    const viewOnly = await signInWith(["orders.view"], "line-edit-view-1");
    expect((await patchLineRoute(
      bodyReq(`http://t/api/orders/${order.id}/lines/${lineId}`, "PATCH", viewOnly, { qty: 6 }),
      withParams({ id: order.id, lineId }))).status).toBe(403);

    const emptyPatch = await patchLineRoute(
      bodyReq(`http://t/api/orders/${order.id}/lines/${lineId}`, "PATCH", editor, {}),
      withParams({ id: order.id, lineId }));
    expect(emptyPatch.status).toBe(400);

    const patched = await patchLineRoute(
      bodyReq(`http://t/api/orders/${order.id}/lines/${lineId}`, "PATCH", editor, { qty: 6 }),
      withParams({ id: order.id, lineId }));
    expect(patched.status).toBe(200);
    expect((await patched.json()).order.lines[1].qty).toBe(6);

    const removed = await removeLineRoute(
      noBodyReq(`http://t/api/orders/${order.id}/lines/${lineId}`, "DELETE", editor),
      withParams({ id: order.id, lineId }));
    expect(removed.status).toBe(200);
    expect((await removed.json()).lines).toHaveLength(1);
  });

  it("PATCH/DELETE .../lines/[lineId] 404 a line that belongs to a different order", async () => {
    const { order, rider, customer, lead } = await orderFixture();
    const editor = await signInWith(["orders.edit"], "line-cross-1");
    const added = await addLineRoute(
      bodyReq(`http://t/api/orders/${order.id}/lines`, "POST", editor, { partId: rider.id, qty: 5, weight: "67.50" }),
      withParams({ id: order.id }));
    const lineId: string = (await added.json()).order.lines[1].id;

    const { order: otherOrder } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));

    const crossPatch = await patchLineRoute(
      bodyReq(`http://t/api/orders/${otherOrder.id}/lines/${lineId}`, "PATCH", editor, { qty: 9 }),
      withParams({ id: otherOrder.id, lineId }));
    expect(crossPatch.status).toBe(404);

    const crossDelete = await removeLineRoute(
      noBodyReq(`http://t/api/orders/${otherOrder.id}/lines/${lineId}`, "DELETE", editor),
      withParams({ id: otherOrder.id, lineId }));
    expect(crossDelete.status).toBe(404);
  });

  // ---------------------------------------------------------------------------------------
  // PUT .../serials, .../containers, .../charges
  // ---------------------------------------------------------------------------------------

  it("PUT .../lines/[lineId]/serials requires orders.edit and replaces the line's serials", async () => {
    const { order } = await orderFixture();
    const lineId = order.lines[0].id;
    const body = [{ serial: "EC001" }, { serial: "EC002" }];

    expect((await replaceSerialsRoute(
      bodyReq(`http://t/api/orders/${order.id}/lines/${lineId}/serials`, "PUT", undefined, body),
      withParams({ id: order.id, lineId }))).status).toBe(401);

    const viewOnly = await signInWith(["orders.view"], "serials-view-1");
    expect((await replaceSerialsRoute(
      bodyReq(`http://t/api/orders/${order.id}/lines/${lineId}/serials`, "PUT", viewOnly, body),
      withParams({ id: order.id, lineId }))).status).toBe(403);

    const editor = await signInWith(["orders.edit"], "serials-edit-1");
    const res = await replaceSerialsRoute(
      bodyReq(`http://t/api/orders/${order.id}/lines/${lineId}/serials`, "PUT", editor, body),
      withParams({ id: order.id, lineId }));
    expect(res.status).toBe(200);
    expect((await res.json()).serials.map((s: { serial: string }) => s.serial)).toEqual(["EC001", "EC002"]);
  });

  it("PUT .../containers requires orders.edit and replaces the order's containers", async () => {
    const { order, containerType } = await orderFixture();
    const body = [{ typeId: containerType.id, count: 2, tareWeight: "10.00" }];

    expect((await replaceContainersRoute(
      bodyReq(`http://t/api/orders/${order.id}/containers`, "PUT", undefined, body),
      withParams({ id: order.id }))).status).toBe(401);

    const viewOnly = await signInWith(["orders.view"], "containers-view-1");
    expect((await replaceContainersRoute(
      bodyReq(`http://t/api/orders/${order.id}/containers`, "PUT", viewOnly, body),
      withParams({ id: order.id }))).status).toBe(403);

    const editor = await signInWith(["orders.edit"], "containers-edit-1");
    const res = await replaceContainersRoute(
      bodyReq(`http://t/api/orders/${order.id}/containers`, "PUT", editor, body), withParams({ id: order.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).containers).toMatchObject([{ count: 2, tareWeight: 10 }]);
  });

  it("PUT .../charges requires orders.edit and replaces the order's charges", async () => {
    const { order } = await orderFixture();
    const body = [{ description: "Freight", amount: "50.00" }];

    expect((await replaceChargesRoute(
      bodyReq(`http://t/api/orders/${order.id}/charges`, "PUT", undefined, body),
      withParams({ id: order.id }))).status).toBe(401);

    const viewOnly = await signInWith(["orders.view"], "charges-view-1");
    expect((await replaceChargesRoute(
      bodyReq(`http://t/api/orders/${order.id}/charges`, "PUT", viewOnly, body),
      withParams({ id: order.id }))).status).toBe(403);

    const editor = await signInWith(["orders.edit"], "charges-edit-1");
    const res = await replaceChargesRoute(
      bodyReq(`http://t/api/orders/${order.id}/charges`, "PUT", editor, body), withParams({ id: order.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).charges).toMatchObject([{ description: "Freight", amount: 50 }]);
  });

  // ---------------------------------------------------------------------------------------
  // PUT .../loads, POST .../loads/resplit
  // ---------------------------------------------------------------------------------------

  it("PUT .../loads requires orders.edit and rewrites the order's loads", async () => {
    const { order } = await orderFixture();
    const body = [{ loadNumber: 1, qty: 10, weight: "135.00" }];

    expect((await replaceLoadsRoute(
      bodyReq(`http://t/api/orders/${order.id}/loads`, "PUT", undefined, body),
      withParams({ id: order.id }))).status).toBe(401);

    const viewOnly = await signInWith(["orders.view"], "loads-view-1");
    expect((await replaceLoadsRoute(
      bodyReq(`http://t/api/orders/${order.id}/loads`, "PUT", viewOnly, body),
      withParams({ id: order.id }))).status).toBe(403);

    const editor = await signInWith(["orders.edit"], "loads-edit-1");
    const res = await replaceLoadsRoute(
      bodyReq(`http://t/api/orders/${order.id}/loads`, "PUT", editor, body), withParams({ id: order.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).order.loads).toMatchObject([{ loadNumber: 1, qty: 10, weight: 135 }]);
  });

  it("POST .../loads/resplit requires orders.edit and recomputes from current totals", async () => {
    const { order } = await orderFixture();

    expect((await resplitRoute(
      noBodyReq(`http://t/api/orders/${order.id}/loads/resplit`, "POST"),
      withParams({ id: order.id }))).status).toBe(401);

    const viewOnly = await signInWith(["orders.view"], "resplit-view-1");
    expect((await resplitRoute(
      noBodyReq(`http://t/api/orders/${order.id}/loads/resplit`, "POST", viewOnly),
      withParams({ id: order.id }))).status).toBe(403);

    const editor = await signInWith(["orders.edit"], "resplit-edit-1");
    const res = await resplitRoute(
      noBodyReq(`http://t/api/orders/${order.id}/loads/resplit`, "POST", editor), withParams({ id: order.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).order.loads).toMatchObject([{ loadNumber: 1, qty: 10, weight: 135 }]);
  });

  // ---------------------------------------------------------------------------------------
  // POST .../link, .../unlink
  // ---------------------------------------------------------------------------------------

  it("POST .../link requires orders.edit, validates otherId, and unions the two groups", async () => {
    const { order, customer, lead } = await orderFixture();
    const { order: order2 } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 2, weight: "27.00" }],
    }));

    expect((await linkRoute(
      bodyReq(`http://t/api/orders/${order.id}/link`, "POST", undefined, { otherId: order2.id }),
      withParams({ id: order.id }))).status).toBe(401);

    const viewOnly = await signInWith(["orders.view"], "link-view-1");
    expect((await linkRoute(
      bodyReq(`http://t/api/orders/${order.id}/link`, "POST", viewOnly, { otherId: order2.id }),
      withParams({ id: order.id }))).status).toBe(403);

    const editor = await signInWith(["orders.edit"], "link-edit-1");
    const missingOther = await linkRoute(
      bodyReq(`http://t/api/orders/${order.id}/link`, "POST", editor, {}), withParams({ id: order.id }));
    expect(missingOther.status).toBe(400);

    const nullBody = await linkRoute(
      bodyReq(`http://t/api/orders/${order.id}/link`, "POST", editor, null), withParams({ id: order.id }));
    expect(nullBody.status).toBe(400);

    const linked = await linkRoute(
      bodyReq(`http://t/api/orders/${order.id}/link`, "POST", editor, { otherId: order2.id }),
      withParams({ id: order.id }));
    expect(linked.status).toBe(200);
    expect((await linked.json()).linkedOrders.map((o: { id: string }) => o.id)).toEqual([order2.id]);
  });

  it("POST .../link 400s across customers", async () => {
    const { order, other } = await orderFixture();
    const code2 = await prisma.processStepCode.create({ data: { code: "HT-02", name: "Temper" } });
    const betaPart = await prisma.part.create({
      data: { customerId: other.id, partNumber: "B-1", name: "Beta part", eachWeight: "1.0000" },
    });
    await giveSteps(betaPart.id, code2.id);
    const { order: betaOrder } = await asSystem(() => createOrder({
      customerId: other.id, lines: [{ partId: betaPart.id, qty: 1, weight: "1.00" }],
    }));

    const editor = await signInWith(["orders.edit"], "link-cross-cust-1");
    const res = await linkRoute(
      bodyReq(`http://t/api/orders/${order.id}/link`, "POST", editor, { otherId: betaOrder.id }),
      withParams({ id: order.id }));
    expect(res.status).toBe(400);
  });

  it("POST .../unlink requires orders.edit and clears the group", async () => {
    const { order, customer, lead } = await orderFixture();
    const { order: order2 } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 2, weight: "27.00" }],
    }));
    const editor = await signInWith(["orders.edit"], "unlink-edit-1");
    await linkRoute(
      bodyReq(`http://t/api/orders/${order.id}/link`, "POST", editor, { otherId: order2.id }),
      withParams({ id: order.id }));

    expect((await unlinkRoute(
      noBodyReq(`http://t/api/orders/${order.id}/unlink`, "POST"), withParams({ id: order.id }))).status).toBe(401);

    const viewOnly = await signInWith(["orders.view"], "unlink-view-1");
    expect((await unlinkRoute(
      noBodyReq(`http://t/api/orders/${order.id}/unlink`, "POST", viewOnly),
      withParams({ id: order.id }))).status).toBe(403);

    const res = await unlinkRoute(
      noBodyReq(`http://t/api/orders/${order.id}/unlink`, "POST", editor), withParams({ id: order.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).linkedOrders).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------
  // GET /api/orders/entry-defaults
  // ---------------------------------------------------------------------------------------

  it("GET .../entry-defaults requires orders.view and needs a customerId", async () => {
    const { customer } = await fixture();
    expect((await entryDefaultsRoute(
      getReq(`http://t/api/orders/entry-defaults?customerId=${customer.id}`), noParams)).status).toBe(401);

    const wrong = await signInWith(["customers.view"], "entry-wrong-1");
    expect((await entryDefaultsRoute(
      getReq(`http://t/api/orders/entry-defaults?customerId=${customer.id}`, wrong), noParams)).status).toBe(403);

    const viewer = await signInWith(["orders.view"], "entry-viewer-1");
    const missing = await entryDefaultsRoute(getReq("http://t/api/orders/entry-defaults", viewer), noParams);
    expect(missing.status).toBe(400);

    const bogus = await entryDefaultsRoute(
      getReq("http://t/api/orders/entry-defaults?customerId=nope", viewer), noParams);
    expect(bogus.status).toBe(400);
  });

  it("GET .../entry-defaults computes the most-specific-wins request date and rejects a mismatched part", async () => {
    const { customer, other, lead } = await fixture();
    await prisma.setting.upsert({
      where: { key: "request_days_default" },
      create: { key: "request_days_default", value: 3 },
      update: { value: 3 },
    });
    await prisma.customer.update({ where: { id: customer.id }, data: { requestDaysOverride: 7 } });
    const viewer = await signInWith(["orders.view"], "entry-viewer-2");

    // customerId only -> the customer's own override (7), not the plant default (3).
    const byCustomer = await entryDefaultsRoute(
      getReq(`http://t/api/orders/entry-defaults?customerId=${customer.id}`, viewer), noParams);
    expect(byCustomer.status).toBe(200);
    expect((await byCustomer.json()).requestDate).toBe(formatDateOnly(addBusinessDays(todayDateOnly(), 7)));

    // A blank partId is absent, not an error, and still resolves through the customer's override.
    const blankPart = await entryDefaultsRoute(
      getReq(`http://t/api/orders/entry-defaults?customerId=${customer.id}&partId=`, viewer), noParams);
    expect(blankPart.status).toBe(200);
    expect((await blankPart.json()).requestDate).toBe(formatDateOnly(addBusinessDays(todayDateOnly(), 7)));

    // The lead part's own override (2) beats the customer's (7).
    await prisma.part.update({ where: { id: lead.id }, data: { requestDaysOverride: 2 } });
    const byPart = await entryDefaultsRoute(
      getReq(`http://t/api/orders/entry-defaults?customerId=${customer.id}&partId=${lead.id}`, viewer), noParams);
    expect(byPart.status).toBe(200);
    expect((await byPart.json()).requestDate).toBe(formatDateOnly(addBusinessDays(todayDateOnly(), 2)));

    // A part belonging to a DIFFERENT customer than the one asked about is refused, not silently
    // used.
    const mismatched = await entryDefaultsRoute(
      getReq(`http://t/api/orders/entry-defaults?customerId=${other.id}&partId=${lead.id}`, viewer), noParams);
    expect(mismatched.status).toBe(400);
  });
});
