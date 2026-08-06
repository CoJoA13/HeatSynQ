import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { createOrder, voidOrder, type OrderDetail } from "@/server/orders";
import {
  createCert, printCert, readCertPdfData, certPrintSettings, voidCert, updateCert, type CertDetail,
} from "@/server/certs";
import { replaceReadings } from "@/server/cert-results";
import { createShipper, printShippingTickets } from "@/server/shippers";
import { buildCertDefinition, type CertPdfData } from "@/server/pdf/cert";
import { getDocument, listDocumentsForShipper, VOIDED_PRINT } from "@/server/documents";
import type { Customer, User } from "../prisma/generated/prisma/client";

import { POST as certPrintRoute } from "@/app/api/certs/[id]/print/route";
import { POST as shipperPrintRoute } from "@/app/api/shippers/[id]/print/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const postReq = (url: string, cookie?: string) =>
  new Request(url, { method: "POST", headers: cookie ? { cookie } : {} });

/** Every `text` string anywhere in a document definition, flattened — see bol.test.ts's copy for
 *  why content pins live on the definition (pdfkit writes TTF-subset glyph ids, so rendered bytes
 *  carry no character text to grep; the rendered PDF is pinned structurally instead). */
function allText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  if (typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) allText(value, out);
  }
  return out;
}

// A real 1×1 PNG — pdfkit parses embedded images at render time, so the fixture must be genuine.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64");

// -------------------------------------------------------------------------------------------
// Fixtures.
// -------------------------------------------------------------------------------------------

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({
    data: { code: `CRT${customerSeq}`, name: `Cert Customer ${customerSeq}` },
  });
}

async function makeBillTo(customerId: string) {
  return prisma.customerAddress.create({
    data: {
      customerId, kind: "BILL_TO", name: "Accounts payable", street: "2101 W. 10th St.",
      city: "Anniston", state: "AL", zip: "36201", isDefault: true,
    },
  });
}

async function makeShipTo(customerId: string) {
  return prisma.customerAddress.create({
    data: {
      customerId, kind: "SHIP_TO", name: "AMZ Manufacturing Corporation", street: "2101 W. 10th St.",
      city: "Anniston", state: "AL", zip: "36201", isDefault: true,
    },
  });
}

let partSeq = 0;
/** A part with a material and one inspection requirement (min/max on an HRC scale). */
async function makeInspectedPart(customerId: string, opts: {
  min?: string | null; max?: string | null;
  certRequired?: boolean; certScope?: "ORDER" | "LOAD" | "SHIPMENT";
} = {}) {
  partSeq += 1;
  // Registry names are live-unique (partial @@unique) — suffixed so two parts can coexist in one test.
  const material = await prisma.material.create({ data: { name: `steel ${partSeq}` } });
  const scale = await prisma.inspectionScale.create({ data: { name: `HRC${partSeq}` } });
  const code = await prisma.inspectionCode.create({
    data: { name: `Were heat treated as per P.O. NONE (${partSeq})`, defaultScaleId: scale.id },
  });
  const part = await prisma.part.create({
    data: {
      customerId, partNumber: `500031-HT-${partSeq}`, name: "Track Shoe, Vehicular",
      description: "T-130", eachWeight: "21.5000", materialId: material.id,
      ...(opts.certRequired !== undefined ? { certRequired: opts.certRequired } : {}),
      ...(opts.certScope !== undefined ? { certScope: opts.certScope } : {}),
    },
  });
  await prisma.partInspection.create({
    data: {
      partId: part.id, inspectionCodeId: code.id, scaleId: scale.id,
      min: opts.min === undefined ? "28.0000" : opts.min,
      max: opts.max === undefined ? "32.0000" : opts.max,
      sampleQty: "9", location: "flange OD", sort: 1,
    },
  });
  const stepCode = await prisma.processStepCode.create({ data: { code: `CP-${partSeq}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: stepCode.id, instruction: "Austenitize at 1650F." },
  });
  return part;
}

let userSeq = 0;
async function makeSigner(signature: "png" | "bmp" | null): Promise<User> {
  userSeq += 1;
  return prisma.user.create({
    data: {
      username: `quality${userSeq}`, displayName: "Quality Signer", passwordHash: "x",
      ...(signature === "png" ? { signatureImage: TINY_PNG, signatureMimeType: "image/png" } : {}),
      ...(signature === "bmp" ? { signatureImage: TINY_PNG, signatureMimeType: "image/bmp" } : {}),
    },
  });
}

async function certWithReadings(opts: {
  min?: number | null; max?: number | null; readings?: number[];
  internalNotes?: string; freeform?: string; signature?: "png" | "bmp" | null;
} = {}): Promise<{ cert: CertDetail; user: User; order: OrderDetail; customer: Customer }> {
  const customer = await makeCustomer();
  await makeBillTo(customer.id);
  const part = await makeInspectedPart(customer.id, {
    min: opts.min === null ? null : (opts.min ?? 28).toFixed(4),
    max: opts.max === null ? null : (opts.max ?? 32).toFixed(4),
  });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "PT24115",
    lines: [{ partId: part.id, qty: 192, weight: "4128.00" }],
  }));
  let cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
  if (opts.readings !== undefined) {
    cert = await asSystem(() => replaceReadings(cert.id, {
      requirements: [{ id: cert.requirements[0].id, readings: opts.readings!.map((value) => ({ value })) }],
    }, { afterPrint: false }));
  }
  if (opts.internalNotes !== undefined || opts.freeform !== undefined) {
    cert = await asSystem(() => updateCert(cert.id, {
      ...(opts.internalNotes !== undefined ? { internalNotes: opts.internalNotes } : {}),
      ...(opts.freeform !== undefined ? { freeform: opts.freeform } : {}),
    }));
  }
  const user = await makeSigner(opts.signature === undefined ? "png" : opts.signature);
  return { cert, user, order, customer };
}

/** A hand-built CertPdfData for the pure-builder assertions. */
function sampleCert(overrides: Partial<CertPdfData> = {}): CertPdfData {
  return {
    company: { name: "American Heat Treating - Alabama, LLC", address: "3008 Red Morris Parkway  Anniston  AL  36207", phone: "256-835-3370" },
    orderLabel: "72036-3",
    printDate: "2026-08-03",
    entryDate: "2026-07-29",
    to: { name: "AMZ Manufacturing Corporation", street: "2101 W. 10th St.", city: "Anniston", state: "AL", zip: "36201" },
    poNumber: "PT24115",
    packingListNo: 72826,
    material: "steel",
    parts: [{ qty: 192, partNumber: "500031-HT", partName: "Track Shoe, Vehicular", partDescription: "T-130", pounds: 4128 }],
    statement: "We certify that the listed Parts / Materials were heat treated in accordance with the QAM and customer requirements as follows:",
    requirements: [{ specification: "Were heat treated as per P.O. NONE", scale: "HRC", readings: [28, 30, 29, 30, 29, 30.1, 29.7, 25.6, 27.1] }],
    serialBlocks: [{ partNumber: "500031-HT", serials: [{ serial: "SN-0001", description: "Heat A1" }] }],
    freeform: "FREEFORM BLOCK UNDER TEST",
    signer: { name: "Colton Jones", title: "", company: "American Heat Treating - Alabama, LLC", signatureDataUri: `data:image/png;base64,${TINY_PNG.toString("base64")}` },
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------
// The builder — pure, plain-JSON, and it says what the sample says (and nothing more, §3.21).
// -------------------------------------------------------------------------------------------

describe("buildCertDefinition", () => {
  it("returns a plain-JSON definition (the template-as-data contract, spec §10)", () => {
    const def = buildCertDefinition(sampleCert());
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
  });

  it("prints every block the sample carries", () => {
    const text = allText(buildCertDefinition(sampleCert())).join("\n");
    expect(text).toContain("Certification");
    expect(text).toContain("American Heat Treating - Alabama, LLC");
    expect(text).toContain("Order No.: 72036-3");
    expect(text).toContain("Date: 08/03/2026");
    expect(text).toContain("Entry Date: 07/29/2026");
    expect(text).toContain("To:");
    expect(text).toContain("AMZ Manufacturing Corporation");
    expect(text).toContain("2101 W. 10th St.");
    expect(text).toContain("36201");
    expect(text).toContain("Purchase Order No.:");
    expect(text).toContain("PT24115");
    expect(text).toContain("Packing List No.:");
    expect(text).toContain("072826");                          // zero-padded, the ticket's own style
    expect(text).toContain("Material:");
    expect(text).toContain("steel");
    expect(text).toContain("Quantity");
    expect(text).toContain("Part Number  /  Part Name  /  Part Description");
    expect(text).toContain("Pounds");
    expect(text).toContain("500031-HT");
    expect(text).toContain("Track Shoe, Vehicular");
    expect(text).toContain("T-130");
    expect(text).toContain("4,128");
    expect(text).toContain("We certify that the listed Parts / Materials");
    expect(text).toContain("Were heat treated as per P.O. NONE to HRC:");   // spec + scale line
    expect(text).toContain("30.0");                            // readings as bare values (§3.21)
    expect(text).toContain("25.6");
    expect(text).toContain("SN-0001");
    expect(text).toContain("Heat A1");
    expect(text).toContain("FREEFORM BLOCK UNDER TEST");
    expect(text).toContain("Colton Jones");
    expect(text).toContain("3008 Red Morris Parkway");         // footer: company address
    expect(text).toContain("Phone: 256-835-3370");
  });

  it("embeds the signature image above the typed block when one is on file", () => {
    const def = buildCertDefinition(sampleCert());
    expect(JSON.stringify(def)).toContain(`data:image/png;base64,${TINY_PNG.toString("base64")}`);
  });

  it("types the display name over the signature rule when no image is on file (§3.11)", () => {
    const def = buildCertDefinition(sampleCert({
      signer: { name: "Colton Jones", title: "", company: "American Heat Treating - Alabama, LLC", signatureDataUri: null },
    }));
    expect(JSON.stringify(def)).not.toContain('"image"');
    // The name appears both over the rule and typed beneath it.
    const names = allText(def).filter((t) => t === "Colton Jones");
    expect(names.length).toBeGreaterThanOrEqual(2);
  });

  it("blank packing list for a cert without a shipment, without dropping the field label", () => {
    const text = allText(buildCertDefinition(sampleCert({ packingListNo: null, orderLabel: "72036" }))).join("\n");
    expect(text).toContain("Order No.: 72036");
    expect(text).toContain("Packing List No.:");
    expect(text).not.toContain("072826");
  });
});

// -------------------------------------------------------------------------------------------
// The real data path — §3.21 asserted against the document built from a real cert.
// -------------------------------------------------------------------------------------------

describe("printCert", () => {
  beforeEach(truncateAll);

  it("prints readings but never min, max, scale column or pass/fail (§3.21)", async () => {
    const { cert, user } = await certWithReadings({ min: 28, max: 32, readings: [30.0, 25.6] });
    const { pdf } = await asSystem(() => printCert(cert.id, user.id));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // Content asserted on the exact definition the print renders from (bol.test.ts's allText note).
    const settings = await certPrintSettings();
    const signer = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const { data } = await readCertPdfData(prisma, cert.id, settings, signer, "2026-08-05");
    const text = allText(buildCertDefinition(data)).join("\n");
    expect(text).toContain("30.0");
    expect(text).toContain("25.6");
    expect(text).not.toMatch(/\bPass\b|\bFail\b/);
    expect(text).not.toContain("Min");            // §3.21 — the sample carries no requirements table
    expect(text).not.toContain("Max");
    expect(text).not.toContain("Override");
    // The computed verdict (25.6 fails the 28–32 band) exists in the model, on screen only.
    const stored = await prisma.certReading.findMany({ where: { requirement: { certId: cert.id } } });
    expect(stored.some((r) => r.passed === false)).toBe(true);
  });

  it("never prints internal notes", async () => {
    const { cert, user } = await certWithReadings({ internalNotes: "SECRET-INTERNAL-STRING", freeform: "PUBLIC-FREEFORM" });
    await asSystem(() => printCert(cert.id, user.id));
    const settings = await certPrintSettings();
    const signer = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const { data } = await readCertPdfData(prisma, cert.id, settings, signer, "2026-08-05");
    const text = allText(buildCertDefinition(data)).join("\n");
    expect(text).not.toContain("SECRET-INTERNAL-STRING");
    expect(text).toContain("PUBLIC-FREEFORM");
    expect(JSON.stringify(data)).not.toContain("SECRET-INTERNAL-STRING");
  });

  it("falls back to the display name when the signer has no signature on file", async () => {
    const { cert, user } = await certWithReadings({ signature: null });
    await asSystem(() => printCert(cert.id, user.id));   // renders without an image, no error
    const settings = await certPrintSettings();
    const signer = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const { data } = await readCertPdfData(prisma, cert.id, settings, signer, "2026-08-05");
    expect(data.signer.signatureDataUri).toBeNull();
    expect(allText(buildCertDefinition(data)).join("\n")).toContain(user.displayName);
  });

  it("treats a non-embeddable (bmp) signature as no image rather than failing the render", async () => {
    const { cert, user } = await certWithReadings({ signature: "bmp" });
    const { pdf } = await asSystem(() => printCert(cert.id, user.id));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const settings = await certPrintSettings();
    const signer = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const { data } = await readCertPdfData(prisma, cert.id, settings, signer, "2026-08-05");
    expect(data.signer.signatureDataUri).toBeNull();
  });

  it("sets printedAt on the first print only", async () => {
    const { cert, user } = await certWithReadings({});
    await asSystem(() => printCert(cert.id, user.id));
    const first = (await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt;
    expect(first).not.toBeNull();
    await asSystem(() => printCert(cert.id, user.id));
    expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt).toEqual(first);
  });

  it("archives kind CERT, reprints stored bytes exactly, audits metadata without the bytes", async () => {
    const { cert, user } = await certWithReadings({ readings: [30] });
    const printed = await asSystem(() => printCert(cert.id, user.id));
    const doc = await getDocument(printed.documentId);
    expect(doc.kind).toBe("CERT");
    expect(doc.certId).toBe(cert.id);
    expect(doc.orderId).toBeNull();
    expect(doc.shipperId).toBeNull();
    expect(Buffer.compare(doc.fileData, printed.pdf)).toBe(0);

    const entry = await prisma.auditLog.findFirst({ where: { entity: "storedDocument", entityId: printed.documentId } });
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry!.after)).not.toContain("fileData");
  });

  it("refuses to print a voided cert but keeps the stored one readable", async () => {
    const { cert, user } = await certWithReadings({});
    const printed = await asSystem(() => printCert(cert.id, user.id));
    await asSystem(() => voidCert(cert.id, "typed against the wrong order"));
    await expect(asSystem(() => printCert(cert.id, user.id))).rejects.toThrow(VOIDED_PRINT);
    expect((await getDocument(printed.documentId)).fileData.length).toBeGreaterThan(0);
  });

  it("404s a cert that does not exist", async () => {
    const user = await makeSigner("png");
    await expect(asSystem(() => printCert("nope", user.id))).rejects.toThrow(/not found/i);
  });

  it("refuses to print a live cert whose OWNING ORDER is voided, keeping stored prints readable", async () => {
    const { cert, order, user } = await certWithReadings({});
    const printed = await asSystem(() => printCert(cert.id, user.id));
    // voidOrder leaves ORDER/LOAD-scope certs live — but a voided order must produce no NEW
    // paper of any kind (spec §5.6's voided-print rule, the same one the cert's own void gets).
    await asSystem(() => voidOrder(order.id, "customer cancelled"));
    await expect(asSystem(() => printCert(cert.id, user.id))).rejects.toThrow(VOIDED_PRINT);
    expect((await getDocument(printed.documentId)).fileData.length).toBeGreaterThan(0);
  });

  it("prints shipment-scope quantities and the sequenced order label", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const shipTo = await makeShipTo(customer.id);
    const part = await makeInspectedPart(customer.id, { certRequired: true, certScope: "SHIPMENT" });
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "PT24115",
      lines: [{ partId: part.id, qty: 192, weight: "4128.00" }],
    }));
    const { shipper } = await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id,
      orders: [{
        orderId: order.id,
        lines: [{ orderLineId: order.lines[0].id, qty: 50, weight: "1075.00", lineComplete: false }],
        containers: [], serials: [],
      }],
    }, { canOverrideCreditHold: false }));

    const cert = await prisma.cert.findFirstOrThrow({ where: { orderId: order.id, scope: "SHIPMENT" } });
    expect(cert.shipperId).toBe(shipper.id);

    const settings = await certPrintSettings();
    const signer = await makeSigner("png");
    const signerRow = await prisma.user.findUniqueOrThrow({ where: { id: signer.id } });
    const { data, orderNumber } = await readCertPdfData(prisma, cert.id, settings, signerRow, "2026-08-05");
    expect(orderNumber).toBe(order.orderNumber);
    expect(data.orderLabel).toBe(`${order.orderNumber}-1`);
    expect(data.packingListNo).toBe(shipper.shipperNumber);
    expect(data.parts).toEqual([{
      qty: 50, partNumber: part.partNumber, partName: part.name, partDescription: "T-130", pounds: 1075,
    }]);
  });
});

// -------------------------------------------------------------------------------------------
// POST /api/certs/[id]/print — gate certs.view (spec §9).
// -------------------------------------------------------------------------------------------

describe("POST /api/certs/[id]/print", () => {
  beforeEach(truncateAll);

  it("401s without a session", async () => {
    const { cert } = await certWithReadings({});
    const res = await certPrintRoute(
      postReq(`http://t/api/certs/${cert.id}/print`), withParams({ id: cert.id }));
    expect(res.status).toBe(401);
  });

  it("requires certs.view", async () => {
    const { cert } = await certWithReadings({});
    const cookie = await signInWith(["shipping.view"]);
    const res = await certPrintRoute(
      postReq(`http://t/api/certs/${cert.id}/print`, cookie), withParams({ id: cert.id }));
    expect(res.status).toBe(403);
  });

  it("streams the cert PDF with a friendly filename, archives it and sets printedAt", async () => {
    const { cert, order } = await certWithReadings({ readings: [30] });
    const cookie = await signInWith(["certs.view"]);
    const res = await certPrintRoute(
      postReq(`http://t/api/certs/${cert.id}/print`, cookie), withParams({ id: cert.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="cert-${order.orderNumber}.pdf"`);
    const documentId = res.headers.get("x-document-id")!;
    const stored = await getDocument(documentId);
    expect(stored.kind).toBe("CERT");
    expect(Buffer.compare(stored.fileData, Buffer.from(await res.arrayBuffer()))).toBe(0);
    expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt).not.toBeNull();
  });
});

// -------------------------------------------------------------------------------------------
// The cert=1 combined path on the shipment print route (§3.14): each covered order's cert prints
// alongside the tickets, each stored as its own document.
// -------------------------------------------------------------------------------------------

describe("POST /api/shippers/[id]/print?doc=ticket&cert=1", () => {
  beforeEach(truncateAll);

  async function shipmentScopeShipment() {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const shipTo = await makeShipTo(customer.id);
    const part = await makeInspectedPart(customer.id, { certRequired: true, certScope: "SHIPMENT" });
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "PT24115",
      lines: [{ partId: part.id, qty: 192, weight: "4128.00" }],
    }));
    const { shipper } = await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id,
      orders: [{
        orderId: order.id,
        lines: [{ orderLineId: order.lines[0].id, qty: 192, weight: "4128.00", lineComplete: true }],
        containers: [], serials: [],
      }],
    }, { canOverrideCreditHold: false }));
    return { customer, order, shipper };
  }

  it("requires certs.view on top of shipping.view when cert=1", async () => {
    const { shipper } = await shipmentScopeShipment();
    const cookie = await signInWith(["shipping.view"]);
    const res = await shipperPrintRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=ticket&cert=1`, cookie), withParams({ id: shipper.id }));
    expect(res.status).toBe(403);
    expect(await listDocumentsForShipper(shipper.id)).toEqual([]);
  });

  it("resolves the cert bundle inside the ticket print itself, under its claims", async () => {
    // Round-3 finding (2026-08-06): resolving certs in a separate, unlocked read let shipment
    // membership change between resolution and the ticket transaction — the permanent bundle
    // could describe two different shipment states. The resolution now rides printShippingTickets'
    // own claimed transaction and returns with the print.
    const { shipper, order } = await shipmentScopeShipment();
    const printed = await asSystem(() => printShippingTickets(shipper.id, undefined, { withCerts: true }));
    expect(printed.certs).toHaveLength(1);
    expect(printed.certs[0].orderNumber).toBe(order.orderNumber);
    expect(printed.warnings).toEqual([]);
  });

  it("prints the tickets and each covered order's cert, each stored as its own document", async () => {
    const { shipper, order } = await shipmentScopeShipment();
    const cookie = await signInWith(["shipping.view", "certs.view"]);
    const res = await shipperPrintRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=ticket&cert=1`, cookie), withParams({ id: shipper.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");

    // The response body is the ticket; the certs are their own archived documents, named here.
    const ticketDoc = await getDocument(res.headers.get("x-document-id")!);
    expect(ticketDoc.kind).toBe("SHIPPER");
    const certDocIds = res.headers.get("x-cert-document-ids")!.split(",");
    expect(certDocIds).toHaveLength(1);
    const certDoc = await getDocument(certDocIds[0]);
    expect(certDoc.kind).toBe("CERT");

    const cert = await prisma.cert.findFirstOrThrow({ where: { orderId: order.id, scope: "SHIPMENT" } });
    expect(certDoc.certId).toBe(cert.id);
    expect(cert.printedAt).not.toBeNull();
  });

  it("archives the ticket and warns when a cert print fails, instead of failing the request", async () => {
    const { shipper, order } = await shipmentScopeShipment();
    const cookie = await signInWith(["shipping.view", "certs.view"]);
    // Corrupt signature bytes declared as PNG: the printing user's signature is what embeds
    // (§3.11), so THIS user's cert render throws at pdf time. The ticket has already archived
    // permanently by then — the request must report the cert failure as a warning, not fail a
    // print that half-succeeded (and invite a retry that archives a duplicate ticket).
    await prisma.user.update({
      where: { username: "root" },
      data: { signatureImage: Buffer.from("not a png"), signatureMimeType: "image/png" },
    });

    const res = await shipperPrintRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=ticket&cert=1`, cookie), withParams({ id: shipper.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");

    // The ticket archived; the failed cert archived nothing.
    const docs = await listDocumentsForShipper(shipper.id);
    expect(docs.map((d) => d.kind)).toEqual(["SHIPPER"]);
    expect(await prisma.storedDocument.count({ where: { kind: "CERT" } })).toBe(0);
    expect(res.headers.get("x-cert-document-ids")).toBeNull();

    const warnings = JSON.parse(decodeURIComponent(res.headers.get("x-print-warnings")!)) as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`#${order.orderNumber}`);
    expect(warnings[0]).toMatch(/certification.*(fail|could not)/i);
  });

  it("prints an ORDER-scope cert for a covered order whose scope is by order", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const shipTo = await makeShipTo(customer.id);
    const part = await makeInspectedPart(customer.id, { certRequired: true, certScope: "ORDER" });
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "PT24115",
      lines: [{ partId: part.id, qty: 192, weight: "4128.00" }],
    }));
    const orderCert = await prisma.cert.findFirstOrThrow({ where: { orderId: order.id, scope: "ORDER" } });
    const { shipper } = await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id,
      orders: [{
        orderId: order.id,
        lines: [{ orderLineId: order.lines[0].id, qty: 192, weight: "4128.00", lineComplete: true }],
        containers: [], serials: [],
      }],
    }, { canOverrideCreditHold: false }));

    const cookie = await signInWith(["shipping.view", "certs.view"]);
    const res = await shipperPrintRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=ticket&cert=1`, cookie), withParams({ id: shipper.id }));
    expect(res.status).toBe(200);
    const certDocIds = res.headers.get("x-cert-document-ids")!.split(",");
    expect(certDocIds).toHaveLength(1);
    expect((await getDocument(certDocIds[0])).certId).toBe(orderCert.id);
  });

  it("prints the tickets and WARNS when a covered order requires a cert and none exists (§9 amendment 2026-08-05)", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const shipTo = await makeShipTo(customer.id);
    // LOAD scope: created on demand only (§3.17) — nothing exists yet.
    const part = await makeInspectedPart(customer.id, { certRequired: true, certScope: "LOAD" });
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "PT24115",
      lines: [{ partId: part.id, qty: 192, weight: "4128.00" }],
    }));
    const { shipper } = await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id,
      orders: [{
        orderId: order.id,
        lines: [{ orderLineId: order.lines[0].id, qty: 192, weight: "4128.00", lineComplete: true }],
        containers: [], serials: [],
      }],
    }, { canOverrideCreditHold: false }));

    const cookie = await signInWith(["shipping.view", "certs.view"]);
    const res = await shipperPrintRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=ticket&cert=1`, cookie), withParams({ id: shipper.id }));
    // §3.13's "warns and never blocks" honored in the pre-ticked flow: the tickets print and
    // archive exactly as a cert-less print would; no cert is archived; the warning names the order.
    expect(res.status).toBe(200);
    const docs = await listDocumentsForShipper(shipper.id);
    expect(docs.map((d) => d.kind)).toEqual(["SHIPPER"]);
    // A CERT document never carries shipperId (the DB CHECK), so assert its absence directly.
    expect(await prisma.storedDocument.count({ where: { kind: "CERT" } })).toBe(0);
    expect(res.headers.get("x-cert-document-ids")).toBeNull();
    const warnings = JSON.parse(decodeURIComponent(res.headers.get("x-print-warnings")!)) as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`#${order.orderNumber}`);
    expect(warnings[0]).toMatch(/requires a certification/i);
  });

  it("prints the covered order that HAS a cert and warns for the one that lacks one, on the same request", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const shipTo = await makeShipTo(customer.id);
    const partWith = await makeInspectedPart(customer.id, { certRequired: true, certScope: "SHIPMENT" });
    const partWithout = await makeInspectedPart(customer.id, { certRequired: true, certScope: "LOAD" });
    const { order: orderWith } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "PO-HAS",
      lines: [{ partId: partWith.id, qty: 192, weight: "4128.00" }],
    }));
    const { order: orderWithout } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "PO-LACKS",
      lines: [{ partId: partWithout.id, qty: 8, weight: "96.00" }],
    }));
    const { shipper } = await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id,
      orders: [
        {
          orderId: orderWith.id,
          lines: [{ orderLineId: orderWith.lines[0].id, qty: 192, weight: "4128.00", lineComplete: true }],
          containers: [], serials: [],
        },
        {
          orderId: orderWithout.id,
          lines: [{ orderLineId: orderWithout.lines[0].id, qty: 8, weight: "96.00", lineComplete: true }],
          containers: [], serials: [],
        },
      ],
    }, { canOverrideCreditHold: false }));

    const cookie = await signInWith(["shipping.view", "certs.view"]);
    const res = await shipperPrintRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=ticket&cert=1`, cookie), withParams({ id: shipper.id }));
    expect(res.status).toBe(200);

    // The first order's SHIPMENT-scope cert printed and archived; the second only warned.
    const certDocIds = res.headers.get("x-cert-document-ids")!.split(",");
    expect(certDocIds).toHaveLength(1);
    const shipmentCert = await prisma.cert.findFirstOrThrow({ where: { orderId: orderWith.id, scope: "SHIPMENT" } });
    expect((await getDocument(certDocIds[0])).certId).toBe(shipmentCert.id);

    const warnings = JSON.parse(decodeURIComponent(res.headers.get("x-print-warnings")!)) as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`#${orderWithout.orderNumber}`);
    expect(warnings[0]).not.toContain(`#${orderWith.orderNumber}`);

    // Exactly one CERT archived on the whole request — the covered order that had one.
    expect(await prisma.storedDocument.count({ where: { kind: "CERT" } })).toBe(1);
  });

  it("treats cert=0 as not requested (the honest parse) and refuses other values", async () => {
    const { shipper } = await shipmentScopeShipment();
    const cookie = await signInWith(["shipping.view"]);   // no certs.view needed when not requested

    const zero = await shipperPrintRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=ticket&cert=0`, cookie), withParams({ id: shipper.id }));
    expect(zero.status).toBe(200);
    expect(zero.headers.get("x-cert-document-ids")).toBeNull();
    const docs = await listDocumentsForShipper(shipper.id);
    expect(docs.map((d) => d.kind)).toEqual(["SHIPPER"]);

    const junk = await shipperPrintRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=ticket&cert=yes`, cookie), withParams({ id: shipper.id }));
    expect(junk.status).toBe(400);
  });
});
