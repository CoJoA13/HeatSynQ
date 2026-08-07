import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import {
  storeDocument, listDocumentsForOrder, listDocumentsForShipper, listDocumentsForCert,
  getDocument, documentFilename, assertPrintable, VOIDED_PRINT, type DocumentMeta,
} from "@/server/documents";
import type { PermUser } from "@/server/permissions";
import { GET as documentRoute } from "@/app/api/documents/[docId]/route";
import { GET as orderDocumentsRoute } from "@/app/api/orders/[id]/documents/route";

/** A minimal `PermUser` carrying exactly the given `area.action` permissions — for exercising
 *  `listDocumentsForOrder`'s per-kind filtering directly, without a real session/role/DB round
 *  trip the way `signInWith` needs for a route-level call. */
const permUser = (permissions: string[]): PermUser => ({
  role: { permissions: permissions.map((permission) => ({ permission })) },
  overrides: [],
});

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const req = (url: string, method: string, cookie?: string) =>
  new Request(url, { method, headers: cookie ? { cookie } : {} });

// Several tests compose two of the fixtures below (e.g. a shipment fixture AND a cert fixture) in
// the SAME test, each of which would otherwise create its own customer under the same hard-coded
// code/order number — colliding with Customer's own partial-unique `code` and Order's plain
// `@unique` `orderNumber`. A monotonic counter keeps every fixture call distinct without having to
// thread a seed through every call site; truncateAll (beforeEach) means nothing about the counter
// itself needs resetting between tests.
let seq = 0;
const next = () => (seq += 1);

/** One customer, one part, one order with a line — everything `storeDocument`'s TRAVELER branch
 *  and a plain order-scoped listing need. */
async function oneOrder() {
  const n = next();
  const customer = await prisma.customer.create({ data: { code: `AC${n}`, name: "Acme" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: `P-${n}`, eachWeight: "1.0000" } });
  const order = await prisma.order.create({
    data: {
      orderNumber: 70000 + n, customerId: customer.id,
      receivedDate: new Date("2026-08-01"), requestDate: new Date("2026-08-05"),
    },
  });
  await prisma.orderLine.create({ data: { orderId: order.id, position: 1, partId: part.id, qty: 10, weight: "25.50" } });
  return { customer, part, order };
}

/** A shipment covering TWO orders of the same customer — the shape `listDocumentsForOrder`'s
 *  union has to see through: a BOL owns only `shipperId`, never either order's id directly. */
async function twoOrderShipment() {
  const { customer, part, order: orderA } = await oneOrder();
  const n = next();
  const orderB = await prisma.order.create({
    data: {
      orderNumber: 70000 + n, customerId: customer.id,
      receivedDate: new Date("2026-08-01"), requestDate: new Date("2026-08-05"),
    },
  });
  await prisma.orderLine.create({ data: { orderId: orderB.id, position: 1, partId: part.id, qty: 5, weight: "12.50" } });
  const shipper = await prisma.shipper.create({
    data: { shipperNumber: 80000 + n, customerId: customer.id, shipDate: new Date("2026-08-04") },
  });
  await prisma.shipperOrder.create({ data: { shipperId: shipper.id, orderId: orderA.id, sequence: 1, position: 1 } });
  await prisma.shipperOrder.create({ data: { shipperId: shipper.id, orderId: orderB.id, sequence: 1, position: 2 } });
  return { customer, shipper, orderA, orderB };
}

async function oneCert() {
  const { order } = await oneOrder();
  const cert = await prisma.cert.create({ data: { orderId: order.id, scope: "ORDER" } });
  return { order, cert };
}

const pdf = (marker: string) => Buffer.from(`%PDF-1.4 ${marker}`);

/** One order (`orderA`, part of a two-order shipment) carrying all three per-kind-relevant
 *  documents at once — a TRAVELER of its own, a BOL via its shipment, and a CERT of its own —
 *  the shape both the filename regression test and the permission-filtering tests need. */
async function orderWithAllKinds() {
  const { shipper, orderA, orderB } = await twoOrderShipment();
  const cert = await prisma.cert.create({ data: { orderId: orderA.id, scope: "ORDER" } });
  const traveler = await prisma.$transaction((tx) =>
    storeDocument(tx, { kind: "TRAVELER", orderId: orderA.id, loadNumber: null }, pdf("t")));
  const bol = await prisma.$transaction((tx) => storeDocument(tx, { kind: "BOL", shipperId: shipper.id }, pdf("b")));
  const certDoc = await prisma.$transaction((tx) => storeDocument(tx, { kind: "CERT", certId: cert.id }, pdf("c")));
  return { shipper, orderA, orderB, cert, traveler, bol, certDoc };
}

describe("storeDocument / listDocumentsForOrder", () => {
  beforeEach(truncateAll);

  // Brief step 1, test 1.
  it("lists a multi-order shipment's BOL on every order it covers", async () => {
    const { shipper, orderA, orderB } = await twoOrderShipment();
    await prisma.$transaction((tx) => storeDocument(tx, { kind: "BOL", shipperId: shipper.id }, pdf("bol")));
    expect((await listDocumentsForOrder(orderA.id)).map((d) => d.kind)).toEqual(["BOL"]);
    expect((await listDocumentsForOrder(orderB.id)).map((d) => d.kind)).toEqual(["BOL"]);
  });

  it("keeps a sibling order's own ticket off another order's list; whole-set tickets reach both", async () => {
    const { shipper, orderA, orderB } = await twoOrderShipment();
    await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "SHIPPER", shipperId: shipper.id, orderId: orderA.id }, pdf("a")));
    await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "SHIPPER", shipperId: shipper.id, orderId: null }, pdf("all")));

    expect(await listDocumentsForOrder(orderA.id)).toHaveLength(2); // its own ticket + the whole set
    const bDocs = await listDocumentsForOrder(orderB.id);
    expect(bDocs).toHaveLength(1); // ONLY the whole-set ticket — A's own ticket is not B's paper
    expect(bDocs[0].orderId).toBeNull();
  });

  // Brief step 1, test 2.
  it("stores no bytes in the audit payload", async () => {
    const { order } = await oneOrder();
    await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "TRAVELER", orderId: order.id, loadNumber: null }, pdf("x")));
    const entry = await prisma.auditLog.findFirst({ where: { entity: "storedDocument" } });
    expect(JSON.stringify(entry)).not.toContain("fileData");
    expect(JSON.stringify(entry)).not.toContain("%PDF");
  });

  // Brief step 1, test 3.
  it("returns stored bytes byte-for-byte", async () => {
    const bytes = pdf("exact");
    const { order } = await oneOrder();
    const meta = await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "TRAVELER", orderId: order.id, loadNumber: 2 }, bytes));
    expect(Buffer.compare((await getDocument(meta.id)).fileData, bytes)).toBe(0);
  });

  // A SHIPPER document's own sub-scope mechanic (spec §4.3): `orderId` set names one order's
  // ticket out of the set; `orderId` null (the twoOrderShipment case above) is the whole set.
  // Also exercises every owner-column mapping `ownerColumns` performs, one kind at a time.
  it("maps each DocumentOwner kind onto exactly the columns the CHECK allows", async () => {
    const { shipper, orderA } = await twoOrderShipment();
    const { cert } = await oneCert();

    const traveler = await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "TRAVELER", orderId: orderA.id, loadNumber: 3 }, pdf("t")));
    expect(traveler).toMatchObject({
      kind: "TRAVELER", orderId: orderA.id, shipperId: null, certId: null, loadNumber: 3,
    });

    const ticket = await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "SHIPPER", shipperId: shipper.id, orderId: orderA.id }, pdf("s")));
    expect(ticket).toMatchObject({
      kind: "SHIPPER", orderId: orderA.id, shipperId: shipper.id, certId: null, loadNumber: null,
    });

    const bol = await prisma.$transaction((tx) => storeDocument(tx, { kind: "BOL", shipperId: shipper.id }, pdf("b")));
    expect(bol).toMatchObject({ kind: "BOL", orderId: null, shipperId: shipper.id, certId: null, loadNumber: null });

    const certDoc = await prisma.$transaction((tx) => storeDocument(tx, { kind: "CERT", certId: cert.id }, pdf("c")));
    expect(certDoc).toMatchObject({ kind: "CERT", orderId: null, shipperId: null, certId: cert.id, loadNumber: null });
  });

  it("404s a missing order", async () => {
    await expect(listDocumentsForOrder("nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("listDocumentsForShipper / listDocumentsForCert", () => {
  beforeEach(truncateAll);

  it("lists a shipment's SHIPPER and BOL documents, newest first, without a cert document leaking in", async () => {
    const { shipper } = await twoOrderShipment();
    const { cert } = await oneCert();

    const ticket = await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "SHIPPER", shipperId: shipper.id, orderId: null }, pdf("s")));
    const bol = await prisma.$transaction((tx) => storeDocument(tx, { kind: "BOL", shipperId: shipper.id }, pdf("b")));
    await prisma.$transaction((tx) => storeDocument(tx, { kind: "CERT", certId: cert.id }, pdf("c")));

    const docs = await listDocumentsForShipper(shipper.id);
    expect(docs.map((d) => d.id)).toEqual([bol.id, ticket.id]);
    expect(docs.every((d) => !("fileData" in d))).toBe(true);
  });

  it("lists a cert's own documents only", async () => {
    const { cert } = await oneCert();
    const { shipper } = await twoOrderShipment();
    const certDoc = await prisma.$transaction((tx) => storeDocument(tx, { kind: "CERT", certId: cert.id }, pdf("c")));
    await prisma.$transaction((tx) => storeDocument(tx, { kind: "BOL", shipperId: shipper.id }, pdf("b")));

    const docs = await listDocumentsForCert(cert.id);
    expect(docs.map((d) => d.id)).toEqual([certDoc.id]);
  });

  it("404s a missing shipper and a missing cert", async () => {
    await expect(listDocumentsForShipper("nope")).rejects.toMatchObject({ status: 404 });
    await expect(listDocumentsForCert("nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("getDocument", () => {
  beforeEach(truncateAll);

  it("404s a missing document", async () => {
    await expect(getDocument("nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("assertPrintable", () => {
  it("throws 400 VOIDED_PRINT for a voided owner", () => {
    expect(() => assertPrintable({ deletedAt: new Date() })).toThrow(VOIDED_PRINT);
    try {
      assertPrintable({ deletedAt: new Date() });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ status: 400, message: VOIDED_PRINT });
    }
  });

  it("does nothing for a live owner", () => {
    expect(() => assertPrintable({ deletedAt: null })).not.toThrow();
  });
});

describe("documentFilename", () => {
  beforeEach(truncateAll);

  const base = {
    id: "doc1", createdAt: new Date(),
    orderId: null, shipperId: null, certId: null, invoiceId: null, loadNumber: null,
  };

  it("names a TRAVELER by order and, when given one, load number", async () => {
    const meta: DocumentMeta = { ...base, kind: "TRAVELER", orderId: "ord1" };
    expect(documentFilename(meta, 71246)).toBe("traveler-71246.pdf");
    expect(documentFilename({ ...meta, loadNumber: 3 }, 71246)).toBe("traveler-71246-load-3.pdf");
  });

  it("names a SHIPPER ticket by shipper, plus the order when it is a single-order ticket", async () => {
    const meta: DocumentMeta = { ...base, kind: "SHIPPER", shipperId: "shp1" };
    expect(documentFilename(meta, undefined, 72826)).toBe("ticket-72826.pdf");
    expect(documentFilename({ ...meta, orderId: "ord1" }, 71246, 72826)).toBe("ticket-72826-order-71246.pdf");
  });

  it("names a BOL by shipper, and a CERT by its owning order's number (falling back to the cert id)", async () => {
    expect(documentFilename({ ...base, kind: "BOL", shipperId: "shp1" }, undefined, 72826)).toBe("bol-72826.pdf");
    expect(documentFilename({ ...base, kind: "CERT", certId: "cert1" })).toBe("cert-cert1.pdf");
    expect(documentFilename({ ...base, kind: "CERT", certId: "cert1" }, 72036)).toBe("cert-72036.pdf");
  });

  it("falls back to the raw id when no friendly number is supplied", async () => {
    const meta: DocumentMeta = { ...base, kind: "TRAVELER", orderId: "ord1" };
    expect(documentFilename(meta)).toBe("traveler-ord1.pdf");
  });
});

describe("GET /api/documents/[docId] gates on the owning entity's area", () => {
  beforeEach(truncateAll);

  it("a shipping.view-only session can fetch a SHIPPER document and gets 403 on a CERT one", async () => {
    const { shipper } = await twoOrderShipment();
    const { cert } = await oneCert();
    const ticket = await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "SHIPPER", shipperId: shipper.id, orderId: null }, pdf("s")));
    const certDoc = await prisma.$transaction((tx) => storeDocument(tx, { kind: "CERT", certId: cert.id }, pdf("c")));
    const cookie = await signInWith(["shipping.view"]);

    const shipperRes = await documentRoute(
      req(`http://t/api/documents/${ticket.id}`, "GET", cookie), withParams({ docId: ticket.id }));
    expect(shipperRes.status).toBe(200);
    expect(shipperRes.headers.get("content-type")).toBe("application/pdf");

    const certRes = await documentRoute(
      req(`http://t/api/documents/${certDoc.id}`, "GET", cookie), withParams({ docId: certDoc.id }));
    expect(certRes.status).toBe(403);
  });

  it("a certs.view-only session can fetch a CERT document and gets 403 on a BOL one", async () => {
    const { shipper } = await twoOrderShipment();
    const { cert } = await oneCert();
    const certDoc = await prisma.$transaction((tx) => storeDocument(tx, { kind: "CERT", certId: cert.id }, pdf("c")));
    const bol = await prisma.$transaction((tx) => storeDocument(tx, { kind: "BOL", shipperId: shipper.id }, pdf("b")));
    const cookie = await signInWith(["certs.view"]);

    const certRes = await documentRoute(
      req(`http://t/api/documents/${certDoc.id}`, "GET", cookie), withParams({ docId: certDoc.id }));
    expect(certRes.status).toBe(200);

    const bolRes = await documentRoute(
      req(`http://t/api/documents/${bol.id}`, "GET", cookie), withParams({ docId: bol.id }));
    expect(bolRes.status).toBe(403);
  });

  it("401s signed out", async () => {
    const { cert } = await oneCert();
    const certDoc = await prisma.$transaction((tx) => storeDocument(tx, { kind: "CERT", certId: cert.id }, pdf("c")));
    const res = await documentRoute(req(`http://t/x`, "GET"), withParams({ docId: certDoc.id }));
    expect(res.status).toBe(401);
  });
});

// Review round 2, Important 1: the initial extraction called the synchronous `documentFilename`
// with no number argument at the route, so every download regressed to a raw-cuid filename. These
// assert the actual `Content-Disposition` header string — not just status/content-type/"inline" —
// which is exactly the gap that let the regression through undetected the first time.
describe("GET /api/documents/[docId] names the download with a friendly filename", () => {
  beforeEach(truncateAll);

  it("names a TRAVELER download by the order's real number, not its id", async () => {
    const { order } = await oneOrder();
    const doc = await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "TRAVELER", orderId: order.id, loadNumber: null }, pdf("t")));
    const cookie = await signInWith(["orders.view"]);
    const res = await documentRoute(req(`http://t/api/documents/${doc.id}`, "GET", cookie), withParams({ docId: doc.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="traveler-${order.orderNumber}.pdf"`);
  });

  it("appends the load number for a per-load TRAVELER download", async () => {
    const { order } = await oneOrder();
    const doc = await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "TRAVELER", orderId: order.id, loadNumber: 3 }, pdf("t")));
    const cookie = await signInWith(["orders.view"]);
    const res = await documentRoute(req(`http://t/api/documents/${doc.id}`, "GET", cookie), withParams({ docId: doc.id }));
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="traveler-${order.orderNumber}-load-3.pdf"`);
  });

  it("names a whole-set SHIPPER ticket download by the shipper's packing-list number", async () => {
    const { shipper } = await twoOrderShipment();
    const doc = await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "SHIPPER", shipperId: shipper.id, orderId: null }, pdf("s")));
    const cookie = await signInWith(["shipping.view"]);
    const res = await documentRoute(req(`http://t/api/documents/${doc.id}`, "GET", cookie), withParams({ docId: doc.id }));
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="ticket-${shipper.shipperNumber}.pdf"`);
  });

  it("names a single-order SHIPPER ticket download by both the shipper's and the order's numbers", async () => {
    const { shipper, orderA } = await twoOrderShipment();
    const doc = await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "SHIPPER", shipperId: shipper.id, orderId: orderA.id }, pdf("s")));
    const cookie = await signInWith(["shipping.view"]);
    const res = await documentRoute(req(`http://t/api/documents/${doc.id}`, "GET", cookie), withParams({ docId: doc.id }));
    expect(res.headers.get("content-disposition"))
      .toBe(`inline; filename="ticket-${shipper.shipperNumber}-order-${orderA.orderNumber}.pdf"`);
  });

  it("names a BOL download by the shipper's packing-list number", async () => {
    const { shipper } = await twoOrderShipment();
    const doc = await prisma.$transaction((tx) => storeDocument(tx, { kind: "BOL", shipperId: shipper.id }, pdf("b")));
    const cookie = await signInWith(["shipping.view"]);
    const res = await documentRoute(req(`http://t/api/documents/${doc.id}`, "GET", cookie), withParams({ docId: doc.id }));
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="bol-${shipper.shipperNumber}.pdf"`);
  });

  it("names a CERT download by its owning order's number", async () => {
    const { order, cert } = await oneCert();
    const doc = await prisma.$transaction((tx) => storeDocument(tx, { kind: "CERT", certId: cert.id }, pdf("c")));
    const cookie = await signInWith(["certs.view"]);
    const res = await documentRoute(req(`http://t/api/documents/${doc.id}`, "GET", cookie), withParams({ docId: doc.id }));
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="cert-${order.orderNumber}.pdf"`);
  });
});

// Review round 2, Important 2 — owner ruling 2026-08-04: listing an order's documents must show
// only the kinds the viewer may actually open, never disclose that a shipment's BOL or a
// certification exists to someone lacking shipping.view/certs.view.
describe("listDocumentsForOrder drops kinds the caller may not view", () => {
  beforeEach(truncateAll);

  it("service-level: filters per kind against the given PermUser, or returns nothing for none", async () => {
    const { orderA, traveler, bol, certDoc } = await orderWithAllKinds();

    const ordersOnly = await listDocumentsForOrder(orderA.id, permUser(["orders.view"]));
    expect(ordersOnly.map((d) => d.id)).toEqual([traveler.id]);

    const all = await listDocumentsForOrder(orderA.id, permUser(["orders.view", "shipping.view", "certs.view"]));
    expect(new Set(all.map((d) => d.id))).toEqual(new Set([traveler.id, bol.id, certDoc.id]));

    const none = await listDocumentsForOrder(orderA.id, permUser([]));
    expect(none).toEqual([]);
  });

  it("service-level: an omitted viewer stays unfiltered, for trusted/internal callers", async () => {
    const { orderA, traveler, bol, certDoc } = await orderWithAllKinds();
    const docs = await listDocumentsForOrder(orderA.id);
    expect(new Set(docs.map((d) => d.id))).toEqual(new Set([traveler.id, bol.id, certDoc.id]));
  });

  it("GET /api/orders/[id]/documents: an orders.view-only session sees the traveler and not the BOL or the cert", async () => {
    const { orderA, traveler } = await orderWithAllKinds();
    const cookie = await signInWith(["orders.view"]);
    const res = await orderDocumentsRoute(
      req(`http://t/api/orders/${orderA.id}/documents`, "GET", cookie), withParams({ id: orderA.id }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string }[];
    expect(body.map((d) => d.id)).toEqual([traveler.id]);
  });

  it("GET /api/orders/[id]/documents: a session holding all three areas sees every kind", async () => {
    const { orderA, traveler, bol, certDoc } = await orderWithAllKinds();
    const cookie = await signInWith(["orders.view", "shipping.view", "certs.view"]);
    const res = await orderDocumentsRoute(
      req(`http://t/api/orders/${orderA.id}/documents`, "GET", cookie), withParams({ id: orderA.id }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string }[];
    expect(new Set(body.map((d) => d.id))).toEqual(new Set([traveler.id, bol.id, certDoc.id]));
  });

  it("GET /api/orders/[id]/documents: 403s without orders.view even if the caller holds shipping.view/certs.view", async () => {
    const { orderA } = await orderWithAllKinds();
    const cookie = await signInWith(["shipping.view", "certs.view"]);
    const res = await orderDocumentsRoute(
      req(`http://t/api/orders/${orderA.id}/documents`, "GET", cookie), withParams({ id: orderA.id }));
    expect(res.status).toBe(403);
  });
});
