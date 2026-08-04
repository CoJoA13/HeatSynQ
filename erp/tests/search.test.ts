import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { globalSearch } from "@/server/search";
import type { SessionUser } from "@/server/sessions";

/**
 * A `SessionUser`-shaped fixture built directly (this is a SERVICE test, not a route test — no
 * `signInWith`/login round trip needed). Mirrors permissions.test.ts's `user()` helper, fleshed
 * out to the full `SessionUser` shape `getSessionUser` returns (`sessions.ts`): the scalar User
 * columns plus `role` (with its `permissions`) and `overrides`, both of which is all `can()`
 * (permissions.ts) ever actually reads. No overrides needed for this file's cases — every test
 * here is a pure role-grant question — so `overrides` is always empty.
 */
let nextUserSeq = 0;
function sessionUser(rolePermissions: string[]): SessionUser {
  const n = nextUserSeq++;
  return {
    id: `search-user-${n}`, username: `search-user-${n}`, passwordHash: "x",
    displayName: "Test User", roleId: `search-role-${n}`, signatureImage: null,
    active: true, deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    role: {
      id: `search-role-${n}`, name: `search-role-${n}`, deletedAt: null,
      permissions: rolePermissions.map((permission, i) => (
        { id: `search-role-${n}-p${i}`, roleId: `search-role-${n}`, permission })),
    },
    overrides: [],
  };
}

/** ACME/BETA plus one part on ACME ("3541720C3") most tests key their order's lead line to. */
async function baseFixture() {
  const acme = await prisma.customer.create({ data: { code: "ACME", name: "Acme Gear" } });
  const beta = await prisma.customer.create({ data: { code: "BETA", name: "Beta Co" } });
  const leadPart = await prisma.part.create({
    data: { customerId: acme.id, partNumber: "3541720C3", name: "Ring gear", eachWeight: "1.0000" },
  });
  return { acme, beta, leadPart };
}

/** Raw `prisma.order.create` (the orders-schema.test.ts precedent) — search.ts never touches
 *  orderability/loads/containers, so there is no reason to route fixtures through the full
 *  `createOrder` service and its process-revision preconditions. */
async function makeOrder(opts: {
  orderNumber: number; customerId: string; partId: string;
  poNumber?: string; vsOrderNumber?: string; voided?: boolean;
}) {
  return prisma.order.create({
    data: {
      orderNumber: opts.orderNumber, customerId: opts.customerId,
      poNumber: opts.poNumber ?? "", vsOrderNumber: opts.vsOrderNumber ?? "",
      receivedDate: new Date("2026-08-01"), requestDate: new Date("2026-08-05"),
      deletedAt: opts.voided ? new Date() : null,
      lines: { create: [{ position: 1, partId: opts.partId, qty: 1, weight: "1.00" }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  });
}

describe("globalSearch", () => {
  beforeEach(truncateAll);

  it("resolves exactOrderId from a live order's number and still fills the orders group", async () => {
    const { acme, leadPart } = await baseFixture();
    const order = await makeOrder({
      orderNumber: 1042, customerId: acme.id, partId: leadPart.id, poNumber: "PO-8891",
    });
    const user = sessionUser(["orders.view", "parts.view", "customers.view"]);

    const result = await globalSearch(user, "1042");

    expect(result.exactOrderId).toBe(order.id);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]).toMatchObject({
      id: order.id, orderNumber: 1042, customerCode: "ACME",
      poNumber: "PO-8891", leadPartNumber: "3541720C3",
    });
  });

  it("exactOrderId resolves even without orders.view — only the group array is permission-gated", async () => {
    const { acme, leadPart } = await baseFixture();
    const order = await makeOrder({ orderNumber: 1090, customerId: acme.id, partId: leadPart.id });
    const user = sessionUser([]); // no permissions at all

    const result = await globalSearch(user, "1090");

    expect(result.exactOrderId).toBe(order.id);
    expect(result.orders).toEqual([]);
  });

  it("a serial hit surfaces the order that owns it", async () => {
    const { acme, leadPart } = await baseFixture();
    const order = await makeOrder({ orderNumber: 1050, customerId: acme.id, partId: leadPart.id });
    await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: "EC-9001" },
    });
    const user = sessionUser(["orders.view"]);

    const result = await globalSearch(user, "ec-9001"); // case-insensitive

    expect(result.orders.map((o) => o.id)).toEqual([order.id]);
  });

  it("matches PO number and VS order number, case-insensitively", async () => {
    const { acme, leadPart } = await baseFixture();
    const order = await makeOrder({
      orderNumber: 1060, customerId: acme.id, partId: leadPart.id,
      poNumber: "PO-8891", vsOrderNumber: "VS-4410",
    });
    const user = sessionUser(["orders.view"]);

    expect((await globalSearch(user, "po-8891")).orders.map((o) => o.id)).toEqual([order.id]);
    expect((await globalSearch(user, "vs-4410")).orders.map((o) => o.id)).toEqual([order.id]);
  });

  it("a lead-part-number hit surfaces the order, but a rider's part number does not", async () => {
    const { acme, leadPart } = await baseFixture();
    const rider = await prisma.part.create({
      data: { customerId: acme.id, partNumber: "RIDER-9", eachWeight: "1.0000" },
    });
    const order = await makeOrder({ orderNumber: 1065, customerId: acme.id, partId: leadPart.id });
    await prisma.orderLine.create({
      data: { orderId: order.id, position: 2, partId: rider.id, qty: 1, weight: "1.00" },
    });
    const user = sessionUser(["orders.view"]);

    expect((await globalSearch(user, "3541720C3")).orders.map((o) => o.id)).toEqual([order.id]);
    expect(await globalSearch(user, "RIDER-9")).toMatchObject({ orders: [] });
  });

  it("returns per-customer duplicate part numbers as separate rows with their own customer codes", async () => {
    const { acme, beta } = await baseFixture();
    const acmePart = await prisma.part.create({
      data: { customerId: acme.id, partNumber: "DUP-1", name: "Acme dup", eachWeight: "1.0000" },
    });
    const betaPart = await prisma.part.create({
      data: { customerId: beta.id, partNumber: "DUP-1", name: "Beta dup", eachWeight: "1.0000" },
    });
    const user = sessionUser(["parts.view"]);

    const result = await globalSearch(user, "DUP-1");

    expect(result.parts).toHaveLength(2);
    expect(result.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: acmePart.id, partNumber: "DUP-1", customerCode: "ACME" }),
      expect.objectContaining({ id: betaPart.id, partNumber: "DUP-1", customerCode: "BETA" }),
    ]));
  });

  it("matches customers by code or name, case-insensitively", async () => {
    const { acme } = await baseFixture();
    const user = sessionUser(["customers.view"]);

    expect((await globalSearch(user, "acme")).customers.map((c) => c.id)).toEqual([acme.id]);
    expect((await globalSearch(user, "GEAR")).customers.map((c) => c.id)).toEqual([acme.id]);
  });

  it("permission filtering empties exactly the groups the caller cannot view", async () => {
    const customer = await prisma.customer.create({ data: { code: "MATCHX", name: "Match Co" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "MATCHX", name: "Match part", eachWeight: "1.0000" },
    });
    await makeOrder({ orderNumber: 1070, customerId: customer.id, partId: part.id });

    const full = await globalSearch(
      sessionUser(["orders.view", "parts.view", "customers.view"]), "MATCHX",
    );
    expect(full.orders.length).toBeGreaterThan(0);
    expect(full.parts.length).toBeGreaterThan(0);
    expect(full.customers.length).toBeGreaterThan(0);

    const partsOnly = await globalSearch(sessionUser(["parts.view"]), "MATCHX");
    expect(partsOnly.orders).toEqual([]);
    expect(partsOnly.customers).toEqual([]);
    expect(partsOnly.parts.length).toBeGreaterThan(0);

    const ordersOnly = await globalSearch(sessionUser(["orders.view"]), "MATCHX");
    expect(ordersOnly.parts).toEqual([]);
    expect(ordersOnly.customers).toEqual([]);
    expect(ordersOnly.orders.length).toBeGreaterThan(0);

    const customersOnly = await globalSearch(sessionUser(["customers.view"]), "MATCHX");
    expect(customersOnly.orders).toEqual([]);
    expect(customersOnly.parts).toEqual([]);
    expect(customersOnly.customers.length).toBeGreaterThan(0);

    const none = await globalSearch(sessionUser([]), "MATCHX");
    expect(none).toEqual({ exactOrderId: null, orders: [], parts: [], customers: [] });
  });

  it("excludes voided orders from both the orders group and exactOrderId", async () => {
    const { acme, leadPart } = await baseFixture();
    await makeOrder({
      orderNumber: 1080, customerId: acme.id, partId: leadPart.id, poNumber: "PO-VOID", voided: true,
    });
    const user = sessionUser(["orders.view"]);

    expect((await globalSearch(user, "PO-VOID")).orders).toEqual([]);

    const byNumber = await globalSearch(user, "1080");
    expect(byNumber.exactOrderId).toBeNull();
    expect(byNumber.orders).toEqual([]);
  });

  it("excludes soft-deleted parts and customers", async () => {
    const { acme } = await baseFixture();
    await prisma.part.create({
      data: { customerId: acme.id, partNumber: "GONE-1", eachWeight: "1.0000", deletedAt: new Date() },
    });
    await prisma.customer.create({ data: { code: "GONE-C", name: "Gone Co", deletedAt: new Date() } });
    const user = sessionUser(["parts.view", "customers.view"]);

    expect((await globalSearch(user, "GONE-1")).parts).toEqual([]);
    expect((await globalSearch(user, "GONE-C")).customers).toEqual([]);
  });

  it("survives a search term too large for an Int order number", async () => {
    const user = sessionUser(["orders.view"]);

    const result = await globalSearch(user, "99999999999999");

    expect(result.exactOrderId).toBeNull();
    expect(result.orders).toEqual([]);
  });

  it("a query shorter than 1 trimmed character returns every group empty and a null exact match", async () => {
    const user = sessionUser(["orders.view", "parts.view", "customers.view"]);

    expect(await globalSearch(user, "")).toEqual({ exactOrderId: null, orders: [], parts: [], customers: [] });
    expect(await globalSearch(user, "   ")).toEqual({ exactOrderId: null, orders: [], parts: [], customers: [] });
  });

  it("caps each group at 10 rows", async () => {
    const { acme } = await baseFixture();
    for (let i = 0; i < 12; i++) {
      await prisma.part.create({
        data: { customerId: acme.id, partNumber: `CAP-${i}`, eachWeight: "1.0000" },
      });
    }
    const user = sessionUser(["parts.view"]);

    expect((await globalSearch(user, "CAP-")).parts).toHaveLength(10);
  });
});
