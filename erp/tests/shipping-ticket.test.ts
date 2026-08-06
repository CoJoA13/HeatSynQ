import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import { setSetting } from "@/server/settings";
import {
  createShipper, voidShipper, printShippingTickets, readShippingTicketData, ticketSettings,
  type ShipperDetail,
} from "@/server/shippers";
import { buildShippingTicketDefinition, type TicketData } from "@/server/pdf/shipping-ticket";
import { getDocument, listDocumentsForShipper, VOIDED_PRINT } from "@/server/documents";
import type { Customer, Part } from "../prisma/generated/prisma/client";

import { POST as printRoute } from "@/app/api/shippers/[id]/print/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const postReq = (url: string, cookie?: string) =>
  new Request(url, { method: "POST", headers: cookie ? { cookie } : {} });

/** Every `text` string anywhere in a document definition, flattened — the traveler.test.ts
 *  precedent: the definition is plain JSON (spec §10), so assertions check WHAT the ticket says,
 *  not where pdfmake draws it. */
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
// Fixtures — the shippers.test.ts shapes, plus the addresses the ticket layout reads (a default
// BILL_TO for the Sold To block, a SHIP_TO for the Ship To block).
// -------------------------------------------------------------------------------------------

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({
    data: { code: `TKT${customerSeq}`, name: `Ticket Customer ${customerSeq}` },
  });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({
    data: {
      customerId, partNumber: `TP-${partSeq}`, name: `Track Shoe ${partSeq}`,
      description: "T-130", eachWeight: "21.5000",
    },
  });
}

async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `TK-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

async function makeAddresses(customerId: string) {
  await prisma.customerAddress.create({
    data: {
      customerId, kind: "BILL_TO", name: "Accounts payable", street: "2101 W. 10th St.",
      city: "Anniston", state: "AL", zip: "36201", isDefault: true,
    },
  });
  return prisma.customerAddress.create({
    data: {
      customerId, kind: "SHIP_TO", name: "AMZ Manufacturing Corporation", street: "2101 W. 10th St.",
      city: "Anniston", state: "AL", zip: "36201", isDefault: true,
    },
  });
}

async function orderFor(customer: Customer, opts: { poNumber?: string; qty?: number; weight?: string } = {}): Promise<OrderDetail> {
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    poNumber: opts.poNumber ?? "PT24115",
    customerJobNo: "JOB-9",
    lines: [{ partId: part.id, qty: opts.qty ?? 192, weight: opts.weight ?? "4128.00" }],
  }));
  return order;
}

function shipOrderInput(order: OrderDetail, lineComplete = true) {
  return {
    orderId: order.id,
    lines: [{
      orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight,
      lineComplete,
    }],
    containers: [] as { orderContainerId: string; count: number }[],
    serials: [] as { orderSerialId: string; printOnShipper?: boolean }[],
  };
}

async function oneOrderShipment(): Promise<{ shipper: ShipperDetail; order: OrderDetail; customer: Customer }> {
  const customer = await makeCustomer();
  const shipTo = await makeAddresses(customer.id);
  const order = await orderFor(customer);
  const { shipper } = await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id, route: "South",
    orders: [shipOrderInput(order)],
  }, { canOverrideCreditHold: false }));
  return { shipper, order, customer };
}

async function twoOrderShipment(): Promise<{
  shipper: ShipperDetail; orderA: OrderDetail; orderB: OrderDetail; customer: Customer;
}> {
  const customer = await makeCustomer();
  const shipTo = await makeAddresses(customer.id);
  const orderA = await orderFor(customer, { poNumber: "PO-A" });
  const orderB = await orderFor(customer, { poNumber: "PO-B", qty: 8, weight: "96.00" });
  const { shipper } = await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id,
    orders: [shipOrderInput(orderA), shipOrderInput(orderB, false)],
  }, { canOverrideCreditHold: false }));
  return { shipper, orderA, orderB, customer };
}

/** A hand-built TicketData for the pure-builder assertions — every field carries a distinctive
 *  value so `allText` misses nothing by accident. */
function sampleTicket(overrides: Partial<TicketData> = {}): TicketData {
  return {
    company: {
      name: "American Heat Treating - Alabama,", address: "1201 Front St", phone: "(256) 555-0100",
      liabilityText: "FIRST LIABILITY PARAGRAPH.\n\nSECOND LIABILITY PARAGRAPH.",
    },
    soldTo: { code: "3054", name: "AMZ Manufacturing Corporation", street: "2101 W. 10th St.", city: "Anniston", state: "AL", zip: "36201" },
    shipTo: { code: "", name: "Max Coating", street: "88 Dock Rd.", city: "Oxford", state: "AL", zip: "36203" },
    orderLabel: "72036-3", orderNumber: 72036, shipDate: "2026-07-29",
    poNumber: "PT24115", packingListNo: 72826, customerJobNo: "JOB-9", route: "South", carrierName: "Customer",
    lines: [{ qty: 192, partNumber: "500031-HT", partName: "Track Shoe, Vehicular", partDescription: "T-130", pounds: 4128 }],
    containers: [{ typeName: "Bin", count: 3, customerContainerId: "AMZ-77" }],
    serials: [{ serial: "SN-0001", description: "Heat A1" }],
    shippedComplete: true, totalQty: 192, totalWeight: 4128,
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------
// The builder — pure, plain-JSON, and it says what the sample says.
// -------------------------------------------------------------------------------------------

describe("buildShippingTicketDefinition", () => {
  it("returns a plain-JSON definition (the template-as-data contract, spec §10)", () => {
    const def = buildShippingTicketDefinition([sampleTicket()]);
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
  });

  it("prints every block the sample carries", () => {
    const text = allText(buildShippingTicketDefinition([sampleTicket()])).join("\n");
    expect(text).toContain("Shipping Ticket");
    expect(text).toContain("Order No.: 72036-3");
    expect(text).toContain("Ship Date: 7/29/2026");
    expect(text).toContain("Sold To:");
    expect(text).toContain("3054");                       // customer code in the Sold To corner
    expect(text).toContain("Ship To:");
    expect(text).toContain("Max Coating");                // the ship-to address's own name
    expect(text).toContain("Purchase Order Number");
    expect(text).toContain("PT24115");
    expect(text).toContain("Packing List No");
    expect(text).toContain("072826");                     // zero-padded exactly as the sample prints it
    expect(text).toContain("Customer Job No");
    expect(text).toContain("JOB-9");
    expect(text).toContain("Route");
    expect(text).toContain("South");
    expect(text).toContain("Carrier");
    expect(text).toContain("Customer");
    expect(text).toContain("500031-HT");
    expect(text).toContain("Track Shoe, Vehicular");
    expect(text).toContain("T-130");
    expect(text).toContain("Container Type");
    expect(text).toContain("# Of Containers");
    expect(text).toContain("Cust Cont Id");
    expect(text).toContain("Bin");
    expect(text).toContain("AMZ-77");
    expect(text).toContain("SN-0001");
    expect(text).toContain("Heat A1");
    expect(text).toContain("FIRST LIABILITY PARAGRAPH.");
    expect(text).toContain("SECOND LIABILITY PARAGRAPH.");
    expect(text).toContain("Shipped Complete");
    expect(text).toContain("Quantity Shipped:");
    expect(text).toContain("Pounds Shipped:");
    expect(text).toContain("4,128.00");
    expect(text).toContain("Received By:");
    expect(text).toContain("Order No.: 72036");           // the tear-off's bare order number
    expect(text).toContain("Shipped ON: 07/29/2026");
    expect(text).toContain("Sold To: AMZ Manufacturing Corporation");
  });

  it("omits Shipped Complete when a line is still open", () => {
    const text = allText(buildShippingTicketDefinition([sampleTicket({ shippedComplete: false })])).join("\n");
    expect(text).not.toContain("Shipped Complete");
  });
});

// -------------------------------------------------------------------------------------------
// The print mechanic — one sheet per order, stored byte-for-byte, voided shipments refuse.
// -------------------------------------------------------------------------------------------

describe("printShippingTickets", () => {
  beforeEach(truncateAll);

  it("renders one sheet per order on the shipment", async () => {
    const { shipper } = await twoOrderShipment();
    const { pdf } = await asSystem(() => printShippingTickets(shipper.id));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("/Count 2");     // uncompressed page marker, P3's rule
  });

  it("renders one sheet when a single order is named", async () => {
    const { shipper, orderA } = await twoOrderShipment();
    const { pdf } = await asSystem(() => printShippingTickets(shipper.id, orderA.id));
    expect(pdf.toString("latin1")).toContain("/Count 1");
  });

  it("archives the whole-set print with orderId null and a single-order print with the order id", async () => {
    const { shipper, orderA } = await twoOrderShipment();
    const whole = await asSystem(() => printShippingTickets(shipper.id));
    const single = await asSystem(() => printShippingTickets(shipper.id, orderA.id));

    const wholeDoc = await getDocument(whole.documentId);
    expect(wholeDoc.kind).toBe("SHIPPER");
    expect(wholeDoc.shipperId).toBe(shipper.id);
    expect(wholeDoc.orderId).toBeNull();
    const singleDoc = await getDocument(single.documentId);
    expect(singleDoc.orderId).toBe(orderA.id);

    const listed = await listDocumentsForShipper(shipper.id);
    expect(listed.map((d) => d.id).sort()).toEqual([whole.documentId, single.documentId].sort());
  });

  it("records the archive as an audited create carrying metadata, never the bytes", async () => {
    const { shipper } = await oneOrderShipment();
    const { documentId } = await asSystem(() => printShippingTickets(shipper.id));
    const entry = await prisma.auditLog.findFirst({ where: { entity: "storedDocument", entityId: documentId } });
    expect(entry).not.toBeNull();
    const payload = JSON.stringify(entry!.after);
    expect(payload).toContain("SHIPPER");
    expect(payload).toContain(shipper.id);
    expect(payload).not.toContain("fileData");
  });

  it("reprints stored bytes exactly", async () => {
    const { shipper } = await oneOrderShipment();
    const first = await asSystem(() => printShippingTickets(shipper.id));
    const stored = await getDocument(first.documentId);
    expect(Buffer.compare(stored.fileData, first.pdf)).toBe(0);   // STORED vs original: exact
  });

  it("refuses to print a voided shipment but keeps the stored one readable", async () => {
    const { shipper } = await oneOrderShipment();
    const printed = await asSystem(() => printShippingTickets(shipper.id));
    await asSystem(() => voidShipper(shipper.id, "wrong truck"));
    await expect(asSystem(() => printShippingTickets(shipper.id))).rejects.toThrow(/voided/i);
    await expect(asSystem(() => printShippingTickets(shipper.id))).rejects.toThrow(VOIDED_PRINT);
    expect((await getDocument(printed.documentId)).fileData.length).toBeGreaterThan(0);
  });

  it("404s a shipment that does not exist and an order that is not on the shipment", async () => {
    const { shipper } = await oneOrderShipment();
    const other = await makeCustomer();
    const elsewhere = await orderFor(other);
    await expect(asSystem(() => printShippingTickets("nope"))).rejects.toThrow(/not found/i);
    await expect(asSystem(() => printShippingTickets(shipper.id, elsewhere.id)))
      .rejects.toThrow(/not on this shipment/i);
  });

  // Fix-wave (whole-branch review 2026-08-06, Important #1): the review's genuinely UNPROTECTED
  // interleaving — a print writes only a StoredDocument row nothing in the void ever reads, so no
  // write-write conflict and no SSI cycle could rescue it incidentally, and `Shipper.deletedAt`
  // lives on a row the print's order claims never covered. The voider is scripted at DEFAULT
  // (Read Committed) isolation — the certs.test.ts T5 technique — so the ONLY thing that can stop
  // the print archiving new paper against a voided shipment (§5.6) is the print path's own FOR
  // UPDATE on the Shipper row. Verified RED against the pre-fix code (order claims alone): the
  // print resolved and archived a document against the voided shipment — transcript in the
  // fix-wave report.
  it("racing a Read-Committed voidShipper, a void committed while the print blocked on the order claims archives NOTHING (fix-wave Important #1)", async () => {
    const { shipper, order } = await oneOrderShipment();

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    // voidShipper's own claim-then-void sequence, signalling ONLY once its FOR UPDATE is held
    // (the real happens-before edge — never a sleep).
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      hasClaimed();
      await release;
      await tx.shipper.update({ where: { id: shipper.id }, data: { deletedAt: new Date() } });
    }, { timeout: 20000 });

    await claimed;
    const printCall = asSystem(() => printShippingTickets(shipper.id));

    // The probe (certs.test.ts race shape): the print must be genuinely blocked on the holder's
    // order lock before the void is released — not itself the discriminator.
    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      printCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);

    mayRelease();
    await holder;

    // The discriminator: the Serializable print's FOR UPDATE on the now-voided Shipper row raises
    // 40001 → withDbErrors' honest "try again" 409 — and NOTHING was archived. (A retry then gets
    // the ordinary voided-print 400 off a fresh snapshot.) Pre-fix the print resolves: its
    // snapshot fixed before the void committed, so assertPrintable read stale `deletedAt: null`
    // and a NEW document landed against a voided shipment.
    await expect(printCall).rejects.toMatchObject({ status: 409 });
    expect(await listDocumentsForShipper(shipper.id)).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// The collector — what the payload says.
// -------------------------------------------------------------------------------------------

describe("readShippingTicketData", () => {
  beforeEach(truncateAll);

  it("assembles the sample's blocks: parties, field strip, lines, containers, printable serials", async () => {
    await asSystem(async () => {
      await setSetting("company_name", "American Heat Treating - Alabama,");
      await setSetting("shipper_liability_text", "LIABILITY TEXT UNDER TEST");
    });
    const customer = await makeCustomer();
    const shipTo = await makeAddresses(customer.id);
    const order = await orderFor(customer);

    const binType = await prisma.containerType.create({ data: { name: "Bin" } });
    const container = await prisma.orderContainer.create({
      data: { orderId: order.id, position: 1, typeId: binType.id, count: 3, customerContainerId: "AMZ-77" },
    });
    const printable = await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: "SN-1", description: "Heat A1" },
    });
    const hidden = await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 2, serial: "SN-2", description: "Heat A2" },
    });

    const { shipper } = await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id,
      route: "South", carrierId: null,
      orders: [{
        ...shipOrderInput(order),
        containers: [{ orderContainerId: container.id, count: 3 }],
        serials: [
          { orderSerialId: printable.id, printOnShipper: true },
          { orderSerialId: hidden.id, printOnShipper: false },
        ],
      }],
    }, { canOverrideCreditHold: false }));

    const settings = await ticketSettings();
    const [ticket] = await readShippingTicketData(prisma, shipper.id, settings);

    expect(ticket.company.name).toBe("American Heat Treating - Alabama,");
    expect(ticket.company.liabilityText).toBe("LIABILITY TEXT UNDER TEST");
    expect(ticket.soldTo.code).toBe(customer.code);
    expect(ticket.soldTo.name).toBe(customer.name);
    expect(ticket.soldTo.street).toBe("2101 W. 10th St.");   // the default BILL_TO address
    expect(ticket.shipTo.name).toBe("AMZ Manufacturing Corporation");
    expect(ticket.shipTo.zip).toBe("36201");
    expect(ticket.orderLabel).toBe(`${order.orderNumber}-1`);
    expect(ticket.shipDate).toBe("2026-07-29");
    expect(ticket.poNumber).toBe("PT24115");
    expect(ticket.packingListNo).toBe(shipper.shipperNumber);
    expect(ticket.customerJobNo).toBe("JOB-9");
    expect(ticket.route).toBe("South");
    expect(ticket.lines).toEqual([{
      qty: 192, partNumber: order.lines[0].part.partNumber, partName: order.lines[0].part.name,
      partDescription: "T-130", pounds: 4128,
    }]);
    expect(ticket.containers).toEqual([{ typeName: "Bin", count: 3, customerContainerId: "AMZ-77" }]);
    expect(ticket.serials).toEqual([{ serial: "SN-1", description: "Heat A1" }]);  // printOnShipper only
    expect(ticket.shippedComplete).toBe(true);
    expect(ticket.totalQty).toBe(192);
    expect(ticket.totalWeight).toBe(4128);
  });

  it("marks the ticket incomplete when any line is still open", async () => {
    const { shipper } = await twoOrderShipment();
    const settings = await ticketSettings();
    const tickets = await readShippingTicketData(prisma, shipper.id, settings);
    expect(tickets).toHaveLength(2);
    expect(tickets[0].shippedComplete).toBe(true);
    expect(tickets[1].shippedComplete).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// The route — POST /api/shippers/[id]/print, gated shipping.view (spec §9).
// -------------------------------------------------------------------------------------------

describe("POST /api/shippers/[id]/print", () => {
  beforeEach(truncateAll);

  it("requires shipping.view", async () => {
    const { shipper } = await oneOrderShipment();
    const cookie = await signInWith(["orders.view"]);
    const res = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=ticket`, cookie), withParams({ id: shipper.id }));
    expect(res.status).toBe(403);
  });

  it("streams the whole-set ticket PDF with a friendly filename and the stored document id", async () => {
    const { shipper } = await oneOrderShipment();
    const cookie = await signInWith(["shipping.view"]);
    const res = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=ticket`, cookie), withParams({ id: shipper.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition"))
      .toBe(`inline; filename="ticket-${shipper.shipperNumber}.pdf"`);
    const documentId = res.headers.get("x-document-id")!;
    const stored = await getDocument(documentId);
    expect(Buffer.compare(stored.fileData, Buffer.from(await res.arrayBuffer()))).toBe(0);
  });

  it("prints one order's ticket when ?order names it", async () => {
    const { shipper, orderA } = await twoOrderShipment();
    const cookie = await signInWith(["shipping.view"]);
    const res = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=ticket&order=${orderA.id}`, cookie),
      withParams({ id: shipper.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition"))
      .toBe(`inline; filename="ticket-${shipper.shipperNumber}-order-${orderA.orderNumber}.pdf"`);
    expect(Buffer.from(await res.arrayBuffer()).toString("latin1")).toContain("/Count 1");
  });

  // The Task 18 version of this test also pinned the temporary bol/cert refusals; those became
  // the real print paths with Task 19 and are covered in tests/bol.test.ts / tests/cert-pdf.test.ts.
  it("rejects an unknown or missing doc kind, archiving nothing", async () => {
    const { shipper } = await oneOrderShipment();
    const cookie = await signInWith(["shipping.view"]);

    const missing = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print`, cookie), withParams({ id: shipper.id }));
    expect(missing.status).toBe(400);

    const unknown = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=nope`, cookie), withParams({ id: shipper.id }));
    expect(unknown.status).toBe(400);

    // The refusal archived nothing: an honest no is a no.
    expect(await listDocumentsForShipper(shipper.id)).toEqual([]);
  });

  it("refuses a voided shipment with the shared refusal", async () => {
    const { shipper } = await oneOrderShipment();
    await asSystem(() => voidShipper(shipper.id, "wrong truck"));
    const cookie = await signInWith(["shipping.view"]);
    const res = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=ticket`, cookie), withParams({ id: shipper.id }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(VOIDED_PRINT);
  });
});
