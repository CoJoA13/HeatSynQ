import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import {
  createShipper, voidShipper, printShippingTickets, printBol, readBolData, bolSettings,
  type ShipperDetail,
} from "@/server/shippers";
import { buildBolDefinition, type BolData } from "@/server/pdf/bol";
import { getDocument, listDocumentsForShipper, VOIDED_PRINT } from "@/server/documents";
import type { Customer } from "../prisma/generated/prisma/client";

import { POST as printRoute } from "@/app/api/shippers/[id]/print/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const postReq = (url: string, cookie?: string) =>
  new Request(url, { method: "POST", headers: cookie ? { cookie } : {} });

/** Every `text` string anywhere in a document definition, flattened — the traveler.test.ts /
 *  shipping-ticket.test.ts precedent: the definition is plain JSON (spec §10), so assertions
 *  check WHAT the BOL says. (Rendered bytes cannot be greped for content — pdfkit writes
 *  TTF-subset glyph ids, not character bytes — so content pins live on the definition and the
 *  rendered PDF is pinned structurally, the house `renderPdf` rule.) */
function allText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  if (typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) allText(value, out);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Fixtures — the shipping-ticket.test.ts shapes.
// -------------------------------------------------------------------------------------------

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({
    data: { code: `BOL${customerSeq}`, name: `Lading Customer ${customerSeq}` },
  });
}

let partSeq = 0;
async function makePart(customerId: string) {
  partSeq += 1;
  return prisma.part.create({
    data: {
      customerId, partNumber: `BP-${partSeq}`, name: `Casting ${partSeq}`,
      description: "I/S", eachWeight: "21.5000",
    },
  });
}

async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `BL-${partId}`, name: "Normalize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Normalize at 1600F." },
  });
}

async function makeShipTo(customerId: string) {
  return prisma.customerAddress.create({
    data: {
      customerId, kind: "SHIP_TO", name: "Max Coating", street: "3653 Industrial Pkwy",
      city: "Birmingham", state: "AL", zip: "35217", isDefault: true,
    },
  });
}

async function orderFor(customer: Customer, opts: { poNumber?: string; qty?: number; weight?: string } = {}): Promise<OrderDetail> {
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    poNumber: opts.poNumber ?? "PT24115",
    lines: [{ partId: part.id, qty: opts.qty ?? 192, weight: opts.weight ?? "4128.00" }],
  }));
  return order;
}

function shipOrderInput(order: OrderDetail) {
  return {
    orderId: order.id,
    lines: [{
      orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight,
      lineComplete: true,
    }],
    containers: [], serials: [],
  };
}

async function oneOrderShipment(): Promise<{ shipper: ShipperDetail; order: OrderDetail; customer: Customer }> {
  const customer = await makeCustomer();
  const shipTo = await makeShipTo(customer.id);
  const order = await orderFor(customer);
  const { shipper } = await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-07-06", shipToAddressId: shipTo.id,
    freightDescription: "Manufactured Castings I/S", freightClass: "70", packageCount: 15,
    proNumber: "PRO-4471", scacCode: "GFMC",
    orders: [shipOrderInput(order)],
  }, { canOverrideCreditHold: false }));
  return { shipper, order, customer };
}

async function twoOrderShipment(): Promise<{
  shipper: ShipperDetail; orderA: OrderDetail; orderB: OrderDetail; customer: Customer;
}> {
  const customer = await makeCustomer();
  const shipTo = await makeShipTo(customer.id);
  const orderA = await orderFor(customer, { poNumber: "PO-A" });
  const orderB = await orderFor(customer, { poNumber: "PO-B", qty: 8, weight: "96.00" });
  const { shipper } = await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-07-06", shipToAddressId: shipTo.id,
    orders: [shipOrderInput(orderA), shipOrderInput(orderB)],
  }, { canOverrideCreditHold: false }));
  return { shipper, orderA, orderB, customer };
}

/** A hand-built BolData for the pure-builder assertions — every field distinctive, the
 *  sampleTicket precedent. */
function sampleBol(overrides: Partial<BolData> = {}): BolData {
  return {
    company: { name: "American Heat Treating - Alabama, LLC", address: "3008 Red Morris Parkway  Anniston  AL  36207" },
    bolNumber: 12795,
    proNumber: "PRO-4471",
    scacCode: "GFMC",
    carrierName: "GFMCO Truck",
    shipDate: "2026-07-06",
    consignee: { name: "Max Coating", street: "3653 Industrial Pkwy", city: "Birmingham", state: "AL", zip: "35217" },
    orderNumbers: [71955, 71957, 71959, 71960, 71961],
    poNumbers: ["PT24115", "PT24116"],
    packageCount: 15,
    freightDescription: "Manufactured Castings I/S",
    totalWeight: 11415,
    freightClass: "70",
    freightTerms: "PREPAID",
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------
// The builder — pure, plain-JSON, and it says what the sample says.
// -------------------------------------------------------------------------------------------

describe("buildBolDefinition", () => {
  it("returns a plain-JSON definition (the template-as-data contract, spec §10)", () => {
    const def = buildBolDefinition(sampleBol());
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
  });

  it("prints every block the sample carries", () => {
    const text = allText(buildBolDefinition(sampleBol())).join("\n");
    expect(text).toContain("Original - Not Negotiable");
    expect(text).toContain("STRAIGHT BILL OF LADING");
    expect(text).toContain("Carrier's Pro No.");
    expect(text).toContain("PRO-4471");
    expect(text).toContain("Shipper's Bill of Lading No.");
    expect(text).toContain("12795");
    expect(text).toContain("Consignee's Ref/PO No.");
    expect(text).toContain("PT24115, PT24116");
    expect(text).toContain("Carrier's Code (SCAC)");
    expect(text).toContain("GFMC");
    expect(text).toContain("GFMCO Truck");
    expect(text).toContain("(Name of Carrier)");
    expect(text).toContain("RECEIVED, subject to");                 // the UDSBL boilerplate opens
    expect(text).toContain("3008 Red Morris Parkway");              // ship-from = company settings
    expect(text).toContain("Jul - 06 - 2026");                      // the sample's own date style
    expect(text).toContain("American Heat Treating - Alabama, LLC");
    expect(text).toContain("Uniform Domestic Straight Bill of Lading");
    expect(text).toContain("Shipper hereby certifies");
    expect(text).toContain("Consigned to");
    expect(text).toContain("Max Coating");
    expect(text).toContain("3653 Industrial Pkwy");
    expect(text).toContain("Destination");
    expect(text).toContain("Birmingham");
    expect(text).toContain("35217");
    expect(text).toContain("TRV NO.");
    expect(text).toContain("71955,71957,71959,71960,71961");        // every order number, the §3.20 point
    expect(text).toContain("Delivering Carrier");
    expect(text).toContain("Car or Vehicle Initials");
    expect(text).toContain("Kind Of Package, Description of Articles");
    expect(text).toContain("Manufactured Castings I/S");
    expect(text).toContain("11,415");
    expect(text).toContain("Class or Rate");
    expect(text).toContain("Check Column");
    expect(text).toContain("Subject to Section 7");
    expect(text).toContain("(Signature of consignor)");
    expect(text).toContain("Freight charges are PREPAID unless marked collect");
    expect(text).toContain("CHECK BOX IF COLLECT");
    expect(text).toContain("RECEIVED $");
    expect(text).toContain("Agent or Cashier");
    expect(text).toContain("Charges Advanced:");
    expect(text).toContain("49 U.S.C.");                            // the liability-limitation note
    expect(text).toContain("Shipper, Per");
    expect(text).toContain("Agent, Per");
    expect(text).toContain("Permanent Post-office address of shipper");
    // Exact cell values, matched on the flattened array so "70"/"15" can't pass by substring.
    const texts = allText(buildBolDefinition(sampleBol()));
    expect(texts).toContain("70");
    expect(texts).toContain("15");
  });

  it("marks the collect box only for COLLECT terms (spec §10.2's prepaid/collect block)", () => {
    expect(allText(buildBolDefinition(sampleBol({ freightTerms: "COLLECT" })))).toContain("X");
    expect(allText(buildBolDefinition(sampleBol({ freightTerms: "PREPAID" })))).not.toContain("X");
  });
});

// -------------------------------------------------------------------------------------------
// printBol — lazy allocation (§3.19), stable across reprints, never freed by a void.
// -------------------------------------------------------------------------------------------

describe("printBol", () => {
  beforeEach(truncateAll);

  it("allocates the BOL number on first print and reuses it on reprint", async () => {
    const { shipper } = await twoOrderShipment();
    const a = await asSystem(() => printBol(shipper.id));
    const b = await asSystem(() => printBol(shipper.id));
    expect(b.bolNumber).toBe(a.bolNumber);
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).bolNumber).toBe(a.bolNumber);
  });

  it("does not allocate a BOL number for a shipment that never prints one", async () => {
    const { shipper } = await oneOrderShipment();
    await asSystem(() => printShippingTickets(shipper.id));
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).bolNumber).toBeNull();
  });

  it("lists every order number on the shipment", async () => {
    const { shipper, orderA, orderB } = await twoOrderShipment();
    const { bolNumber, pdf } = await asSystem(() => printBol(shipper.id));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("/Count 1");       // one sheet — pinned marker, P3's rule

    // Content is asserted on the definition the print rendered from (see allText's own comment).
    const settings = await bolSettings();
    const data = await readBolData(prisma, shipper.id, bolNumber, settings);
    expect(data.orderNumbers).toEqual([orderA.orderNumber, orderB.orderNumber]);
    const text = allText(buildBolDefinition(data)).join("\n");
    expect(text).toContain(`${orderA.orderNumber},${orderB.orderNumber}`);
    expect(text).toContain(String(orderA.orderNumber));
    expect(text).toContain(String(orderB.orderNumber));
  });

  it("defaults packageCount to the shipment's container-count sum when none was entered", async () => {
    const customer = await makeCustomer();
    const shipTo = await makeShipTo(customer.id);
    const order = await orderFor(customer);
    const containerType = await prisma.containerType.create({ data: { name: "Basket" } });
    const bin = await prisma.orderContainer.create({
      data: { orderId: order.id, position: 1, typeId: containerType.id, count: 3 },
    });
    const pallet = await prisma.orderContainer.create({
      data: { orderId: order.id, position: 2, typeId: containerType.id, count: 4 },
    });
    const input = {
      orderId: order.id,
      lines: [{
        orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight,
        lineComplete: true,
      }],
      containers: [{ orderContainerId: bin.id, count: 3 }, { orderContainerId: pallet.id, count: 4 }],
      serials: [],
    };
    // No packageCount — the forms promise "Blank uses the current container count".
    const { shipper } = await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-07-06", shipToAddressId: shipTo.id, orders: [input],
    }, { canOverrideCreditHold: false }));

    const { bolNumber } = await asSystem(() => printBol(shipper.id));
    const data = await readBolData(prisma, shipper.id, bolNumber, await bolSettings());
    expect(data.packageCount).toBe(7);
  });

  it("assembles the consignee from the ship-to address and the orders' POs and weight total", async () => {
    const { shipper, orderA, orderB } = await twoOrderShipment();
    const { bolNumber } = await asSystem(() => printBol(shipper.id));
    const data = await readBolData(prisma, shipper.id, bolNumber, await bolSettings());
    expect(data.consignee.name).toBe("Max Coating");
    expect(data.consignee.zip).toBe("35217");
    expect(data.poNumbers).toEqual(["PO-A", "PO-B"]);
    expect(data.totalWeight).toBe(4128 + 96);
    expect(data.bolNumber).toBe(bolNumber);
    void orderA; void orderB;
  });

  it("allocates sequentially across shipments, and a voided shipment never frees its number", async () => {
    const first = await oneOrderShipment();
    const a = await asSystem(() => printBol(first.shipper.id));
    await asSystem(() => voidShipper(first.shipper.id, "wrong truck"));

    const second = await oneOrderShipment();
    const b = await asSystem(() => printBol(second.shipper.id));
    expect(b.bolNumber).toBe(a.bolNumber + 1);   // never the freed one
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: first.shipper.id } })).bolNumber).toBe(a.bolNumber);
  });

  it("archives kind BOL owned by the shipment alone, audited as metadata without the bytes", async () => {
    const { shipper } = await oneOrderShipment();
    const { documentId, pdf } = await asSystem(() => printBol(shipper.id));

    const doc = await getDocument(documentId);
    expect(doc.kind).toBe("BOL");
    expect(doc.shipperId).toBe(shipper.id);
    expect(doc.orderId).toBeNull();
    expect(Buffer.compare(doc.fileData, pdf)).toBe(0);          // STORED vs original: exact

    const entry = await prisma.auditLog.findFirst({ where: { entity: "storedDocument", entityId: documentId } });
    expect(entry).not.toBeNull();
    const payload = JSON.stringify(entry!.after);
    expect(payload).toContain("BOL");
    expect(payload).not.toContain("fileData");

    // The lazy allocation is itself an audited shipper update carrying the number (spec §5).
    const shipperEntries = await prisma.auditLog.findMany({ where: { entity: "shipper", entityId: shipper.id } });
    const bolEntry = shipperEntries.find((e) => JSON.stringify(e.after ?? {}).includes('"bolNumber"'));
    expect(bolEntry).toBeDefined();
  });

  it("refuses to print a voided shipment but keeps the stored BOL readable", async () => {
    const { shipper } = await oneOrderShipment();
    const printed = await asSystem(() => printBol(shipper.id));
    await asSystem(() => voidShipper(shipper.id, "wrong truck"));
    await expect(asSystem(() => printBol(shipper.id))).rejects.toThrow(VOIDED_PRINT);
    expect((await getDocument(printed.documentId)).fileData.length).toBeGreaterThan(0);
  });

  it("404s a shipment that does not exist", async () => {
    await expect(asSystem(() => printBol("nope"))).rejects.toThrow(/not found/i);
  });
});

// -------------------------------------------------------------------------------------------
// The route — POST /api/shippers/[id]/print?doc=bol (spec §9).
// -------------------------------------------------------------------------------------------

describe("POST /api/shippers/[id]/print?doc=bol", () => {
  beforeEach(truncateAll);

  it("401s without a session", async () => {
    const { shipper } = await oneOrderShipment();
    const res = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=bol`), withParams({ id: shipper.id }));
    expect(res.status).toBe(401);
  });

  it("requires shipping.view", async () => {
    const { shipper } = await oneOrderShipment();
    const cookie = await signInWith(["orders.view"]);
    const res = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=bol`, cookie), withParams({ id: shipper.id }));
    expect(res.status).toBe(403);
  });

  it("streams the BOL with a friendly filename, the stored document id and the allocated number", async () => {
    const { shipper } = await oneOrderShipment();
    const cookie = await signInWith(["shipping.view"]);
    const res = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=bol`, cookie), withParams({ id: shipper.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition"))
      .toBe(`inline; filename="bol-${shipper.shipperNumber}.pdf"`);
    const documentId = res.headers.get("x-document-id")!;
    const stored = await getDocument(documentId);
    expect(stored.kind).toBe("BOL");
    expect(Buffer.compare(stored.fileData, Buffer.from(await res.arrayBuffer()))).toBe(0);
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).bolNumber).not.toBeNull();
  });

  it("refuses cert=1 on a BOL print — certifications ride with the tickets (§3.14)", async () => {
    const { shipper } = await oneOrderShipment();
    const cookie = await signInWith(["shipping.view", "certs.view"]);
    const res = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=bol&cert=1`, cookie), withParams({ id: shipper.id }));
    expect(res.status).toBe(400);
    expect(await listDocumentsForShipper(shipper.id)).toEqual([]);
  });
});
