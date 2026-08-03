import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";

import { GET as getDraftRoute, PUT as putDraftRoute, DELETE as clearDraftRoute } from "@/app/api/order-drafts/route";
import { GET as listViewsRoute, POST as createViewRoute } from "@/app/api/saved-views/route";
import { PATCH as patchViewRoute, DELETE as deleteViewRoute } from "@/app/api/saved-views/[id]/route";
import { GET as searchRoute } from "@/app/api/search/route";

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

// ---------------------------------------------------------------------------------------
// GET / PUT / DELETE /api/order-drafts — session only, own row via requireUser().id, no
// permission gate at all (order-drafts.ts's own header comment: "readable/writable only by
// its own user").
// ---------------------------------------------------------------------------------------

describe("order-drafts routes", () => {
  beforeEach(async () => await truncateAll());

  it("requires a session for GET, PUT, and DELETE alike", async () => {
    expect((await getDraftRoute(getReq("http://t/api/order-drafts"), noParams)).status).toBe(401);
    expect((await putDraftRoute(
      bodyReq("http://t/api/order-drafts", "PUT", undefined, { payload: { a: 1 } }), noParams)).status).toBe(401);
    expect((await clearDraftRoute(noBodyReq("http://t/api/order-drafts", "DELETE"), noParams)).status).toBe(401);
  });

  it("has no permission gate: a session with zero role grants still succeeds", async () => {
    const noPerms = await signInWith([], "draft-noperm-1");

    expect((await getDraftRoute(getReq("http://t/api/order-drafts", noPerms), noParams)).status).toBe(200);
    expect((await putDraftRoute(
      bodyReq("http://t/api/order-drafts", "PUT", noPerms, { payload: { a: 1 } }), noParams)).status).toBe(200);
    expect((await clearDraftRoute(noBodyReq("http://t/api/order-drafts", "DELETE", noPerms), noParams)).status)
      .toBe(200);
  });

  it("round-trips a payload through PUT/GET and clears it (to null) through DELETE", async () => {
    const cookie = await signInWith([], "draft-roundtrip-1");
    const payload = { customerId: "c1", lines: [{ partId: "p1", qty: 5 }] };

    // No draft yet.
    const empty = await getDraftRoute(getReq("http://t/api/order-drafts", cookie), noParams);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toBeNull();

    const put = await putDraftRoute(
      bodyReq("http://t/api/order-drafts", "PUT", cookie, { payload }), noParams);
    expect(put.status).toBe(200);

    const got = await getDraftRoute(getReq("http://t/api/order-drafts", cookie), noParams);
    expect(got.status).toBe(200);
    expect((await got.json()).payload).toEqual(payload);

    const cleared = await clearDraftRoute(noBodyReq("http://t/api/order-drafts", "DELETE", cookie), noParams);
    expect(cleared.status).toBe(200);

    const afterClear = await getDraftRoute(getReq("http://t/api/order-drafts", cookie), noParams);
    expect((await afterClear.json()).payload).toBeNull();
  });

  it("PUT with a non-object JSON body is 400, not 500", async () => {
    const cookie = await signInWith([], "draft-badbody-1");
    const res = await putDraftRoute(bodyReq("http://t/api/order-drafts", "PUT", cookie, null), noParams);
    expect(res.status).toBe(400);
  });

  it("isolates drafts per user THROUGH THE ROUTE: user A's PUT is invisible to user B's GET", async () => {
    const a = await signInWith([], "draft-a-1");
    const b = await signInWith([], "draft-b-1");

    await putDraftRoute(bodyReq("http://t/api/order-drafts", "PUT", a, { payload: { who: "a" } }), noParams);

    // B has never written a draft — A's write must not be visible under B's session.
    const bGet = await getDraftRoute(getReq("http://t/api/order-drafts", b), noParams);
    expect(bGet.status).toBe(200);
    expect(await bGet.json()).toBeNull();

    await putDraftRoute(bodyReq("http://t/api/order-drafts", "PUT", b, { payload: { who: "b" } }), noParams);

    const aGet = await getDraftRoute(getReq("http://t/api/order-drafts", a), noParams);
    expect((await aGet.json()).payload).toEqual({ who: "a" });
    const bGet2 = await getDraftRoute(getReq("http://t/api/order-drafts", b), noParams);
    expect((await bGet2.json()).payload).toEqual({ who: "b" });

    // B clearing their own draft must never reach A's row.
    await clearDraftRoute(noBodyReq("http://t/api/order-drafts", "DELETE", b), noParams);
    const aStillThere = await getDraftRoute(getReq("http://t/api/order-drafts", a), noParams);
    expect((await aStillThere.json()).payload).toEqual({ who: "a" });
    const bCleared = await getDraftRoute(getReq("http://t/api/order-drafts", b), noParams);
    expect((await bCleared.json()).payload).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// GET / POST /api/saved-views, PATCH / DELETE /api/saved-views/[id] — gated on orders.view;
// ownership is enforced by the service (own rows structurally), so a wrong-owner id and a
// missing id must both come back 404, never 403 (no existence leak).
// ---------------------------------------------------------------------------------------

describe("saved-views routes", () => {
  beforeEach(async () => await truncateAll());

  it("GET requires a session and orders.view", async () => {
    expect((await listViewsRoute(getReq("http://t/api/saved-views"), noParams)).status).toBe(401);

    const wrong = await signInWith(["parts.view"], "views-list-wrong-1");
    expect((await listViewsRoute(getReq("http://t/api/saved-views", wrong), noParams)).status).toBe(403);

    const viewer = await signInWith(["orders.view"], "views-list-viewer-1");
    const res = await listViewsRoute(getReq("http://t/api/saved-views", viewer), noParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("POST requires a session and orders.view, and creates a view", async () => {
    expect((await createViewRoute(
      bodyReq("http://t/api/saved-views", "POST", undefined, { name: "A", config: {} }), noParams)).status)
      .toBe(401);

    const wrong = await signInWith(["parts.view"], "views-create-wrong-1");
    expect((await createViewRoute(
      bodyReq("http://t/api/saved-views", "POST", wrong, { name: "A", config: {} }), noParams)).status).toBe(403);

    const viewer = await signInWith(["orders.view"], "views-create-viewer-1");
    const created = await createViewRoute(
      bodyReq("http://t/api/saved-views", "POST", viewer, { name: "My board", config: { columns: ["a"] } }),
      noParams);
    expect(created.status).toBe(200);
    const body = await created.json();
    expect(body).toMatchObject({ name: "My board", config: { columns: ["a"] }, isDefault: false });

    const listed = await listViewsRoute(getReq("http://t/api/saved-views", viewer), noParams);
    expect((await listed.json()).map((v: { id: string }) => v.id)).toEqual([body.id]);
  });

  it("GET only ever returns the caller's own rows, never another user's", async () => {
    const a = await signInWith(["orders.view"], "views-scope-a-1");
    const b = await signInWith(["orders.view"], "views-scope-b-1");
    await createViewRoute(bodyReq("http://t/api/saved-views", "POST", a, { name: "A's board", config: {} }), noParams);

    const bList = await listViewsRoute(getReq("http://t/api/saved-views", b), noParams);
    expect(bList.status).toBe(200);
    expect(await bList.json()).toEqual([]);
  });

  it("PATCH/DELETE [id] require a session and orders.view on the caller's own view", async () => {
    const owner = await signInWith(["orders.view"], "views-crud-owner-1");
    const created = await createViewRoute(
      bodyReq("http://t/api/saved-views", "POST", owner, { name: "Mine", config: {} }), noParams);
    const { id } = await created.json();

    expect((await patchViewRoute(
      bodyReq(`http://t/api/saved-views/${id}`, "PATCH", undefined, { name: "New" }), withParams({ id })))
      .status).toBe(401);
    expect((await deleteViewRoute(
      noBodyReq(`http://t/api/saved-views/${id}`, "DELETE"), withParams({ id }))).status).toBe(401);

    const wrong = await signInWith(["parts.view"], "views-crud-wrong-1");
    expect((await patchViewRoute(
      bodyReq(`http://t/api/saved-views/${id}`, "PATCH", wrong, { name: "New" }), withParams({ id })))
      .status).toBe(403);
    expect((await deleteViewRoute(
      noBodyReq(`http://t/api/saved-views/${id}`, "DELETE", wrong), withParams({ id }))).status).toBe(403);

    const patched = await patchViewRoute(
      bodyReq(`http://t/api/saved-views/${id}`, "PATCH", owner, { name: "Renamed" }), withParams({ id }));
    expect(patched.status).toBe(200);
    expect((await patched.json()).name).toBe("Renamed");

    // No `reason` in the body at all — a saved view's DELETE never requires one (spec §5.17).
    const deleted = await deleteViewRoute(
      noBodyReq(`http://t/api/saved-views/${id}`, "DELETE", owner), withParams({ id }));
    expect(deleted.status).toBe(200);
    expect(await listViewsRoute(getReq("http://t/api/saved-views", owner), noParams).then((r) => r.json()))
      .toEqual([]);
  });

  it("[id] routes 404 on another user's view — never 403, no existence leak", async () => {
    const owner = await signInWith(["orders.view"], "views-leak-owner-1");
    const other = await signInWith(["orders.view"], "views-leak-other-1");
    const created = await createViewRoute(
      bodyReq("http://t/api/saved-views", "POST", owner, { name: "A's board", config: {} }), noParams);
    const { id } = await created.json();

    // `other` HAS orders.view — the only thing standing between them and the row is ownership,
    // so a wrong-owner id must read exactly like a missing one: 404, not 403.
    const patch = await patchViewRoute(
      bodyReq(`http://t/api/saved-views/${id}`, "PATCH", other, { name: "Hijacked" }), withParams({ id }));
    expect(patch.status).toBe(404);

    const del = await deleteViewRoute(
      noBodyReq(`http://t/api/saved-views/${id}`, "DELETE", other), withParams({ id }));
    expect(del.status).toBe(404);

    // A missing id entirely takes the identical 404 under the same session.
    const missingPatch = await patchViewRoute(
      bodyReq("http://t/api/saved-views/nonexistent-id", "PATCH", other, { name: "x" }),
      withParams({ id: "nonexistent-id" }));
    expect(missingPatch.status).toBe(404);

    // Untouched by any of `other`'s attempts.
    const stillThere = await listViewsRoute(getReq("http://t/api/saved-views", owner), noParams);
    expect(await stillThere.json()).toMatchObject([{ name: "A's board" }]);
  });
});

// ---------------------------------------------------------------------------------------
// GET /api/search — requireUser only, no area permission gate on the route itself; the
// service groups results and filters each group by the caller's own *.view permission.
// ---------------------------------------------------------------------------------------

describe("search route", () => {
  beforeEach(async () => await truncateAll());

  it("requires a session", async () => {
    expect((await searchRoute(getReq("http://t/api/search?q=anything"), noParams)).status).toBe(401);
  });

  it("a parts.view-only session gets an empty orders group but real parts hits, through the route", async () => {
    const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Gear" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "MATCH-1", name: "Match part", eachWeight: "1.0000" },
    });
    await prisma.order.create({
      data: {
        orderNumber: 5001, customerId: customer.id, poNumber: "MATCH-1",
        receivedDate: new Date("2026-08-01"), requestDate: new Date("2026-08-05"),
        lines: { create: [{ position: 1, partId: part.id, qty: 1, weight: "1.00" }] },
      },
    });

    const partsOnly = await signInWith(["parts.view"], "search-parts-only-1");
    const res = await searchRoute(getReq("http://t/api/search?q=MATCH-1", partsOnly), noParams);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.orders).toEqual([]); // no orders.view -> empty, not a 403
    expect(body.parts.length).toBeGreaterThan(0);
    expect(body.parts[0]).toMatchObject({ id: part.id, partNumber: "MATCH-1" });
  });

  it("passes the caller's real permissions through: full access fills every group", async () => {
    const customer = await prisma.customer.create({ data: { code: "GLOBEX", name: "Globex Co" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "GBX-1", name: "Globex part", eachWeight: "1.0000" },
    });
    await prisma.order.create({
      data: {
        orderNumber: 5002, customerId: customer.id, poNumber: "GLOBEX-PO",
        receivedDate: new Date("2026-08-01"), requestDate: new Date("2026-08-05"),
        lines: { create: [{ position: 1, partId: part.id, qty: 1, weight: "1.00" }] },
      },
    });

    const full = await signInWith(["orders.view", "parts.view", "customers.view"], "search-full-1");
    const res = await searchRoute(getReq("http://t/api/search?q=GLOBEX", full), noParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customers.length).toBeGreaterThan(0);
    expect(body.orders.length).toBeGreaterThan(0);
  });
});
