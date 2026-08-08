import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder, type OrderDetail } from "@/server/orders";
import { createShipper } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { createSurcharge } from "@/server/surcharges";
import { setSetting } from "@/server/settings";
import {
  createInvoice, finalizeInvoice, createCredit, discardInvoice,
  printInvoice, readInvoicePdfData,
} from "@/server/invoices";
import { buildInvoiceDefinition, type InvoicePdfData } from "@/server/pdf/invoice";
import { renderPdf } from "@/server/pdf/render";
import { getDocument, VOIDED_PRINT } from "@/server/documents";
import type { Customer, Part } from "../prisma/generated/prisma/client";

import { POST as printRoute } from "@/app/api/invoices/[id]/print/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const postReq = (url: string, cookie?: string) =>
  new Request(url, { method: "POST", headers: cookie ? { cookie } : {} });

/** Every `text` string anywhere in a document definition, flattened — content pins live on the
 *  DEFINITION, never on rendered bytes (pdfkit writes TTF-subset glyph ids, so a rendered PDF
 *  carries no character text to grep for; the rendered file is pinned STRUCTURALLY instead). Copied
 *  from tests/cert-pdf.test.ts. */
function allText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  if (typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) allText(value, out);
  }
  return out;
}

/** The PDF's own page count, off its `/Type /Pages /Count N` object — the one signal a race test
 *  can check without re-rendering. Copied from tests/traveler.test.ts (see its comment for why this
 *  is safe where a `Buffer.compare` of two fresh renders is not). */
function pageCount(pdf: Buffer): number {
  const match = pdf.toString("latin1").match(/\/Type\s*\/Pages[^>]*\/Count\s+(\d+)/);
  if (!match) throw new Error("Could not find a /Type /Pages /Count marker in the rendered PDF");
  return Number(match[1]);
}

// -------------------------------------------------------------------------------------------
// Fixtures — copied in shape from tests/invoices.test.ts (copying across test files is this repo's
// convention).
// -------------------------------------------------------------------------------------------

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `IPD${customerSeq}`, name: `Invoice Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({
    data: { customerId, partNumber: `P-${partSeq}`, name: "EQUALIZER-RR SUSP", eachWeight: "21.0000" },
  });
}

async function makeBillTo(customerId: string) {
  return prisma.customerAddress.create({
    data: {
      customerId, kind: "BILL_TO", name: "GFMCO - Columbus LLC", street: "600 12th Street",
      city: "Columbus", state: "GA", zip: "31902-0096", isDefault: true,
    },
  });
}

async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `HT-${partId}`, name: "Austemper" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austemper at 1650F." },
  });
}

async function savedOrder(): Promise<{ order: OrderDetail; part: Part; customer: Customer }> {
  const customer = await makeCustomer();
  await makeBillTo(customer.id);
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "49499",
    lines: [{ partId: part.id, qty: 144, weight: "3024.00" }],
  }));
  return { order, part, customer };
}

function oneOrderInput(order: OrderDetail) {
  return {
    customerId: order.customerId,
    shipDate: "2026-07-29",
    orders: [{
      orderId: order.id,
      lines: [{ orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight, lineComplete: true }],
      containers: [] as { orderContainerId: string; count: number }[],
      serials: [] as { orderSerialId: string; printOnShipper?: boolean }[],
    }],
  };
}

/** A fully-shipped order priced at $6.51/each with a $600 minimum — the sample invoice's numbers. */
async function pricedShippedOrder() {
  const { order, part, customer } = await savedOrder();
  const { shipper } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
  const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Sales" } });
  const code = await prisma.processStepCode.create({ data: { code: "AUST", name: "Austemper", glAccountId: gl.id } });
  await asSystem(() => addPartPrice(part.id, {
    processStepCodeId: code.id, position: 1, unitPrice: "6.5100", minimumCharge: "600.00", pricePer: "EACH",
  }));
  return { order: await getOrder(order.id), part, customer, shipper, stepCode: code, glAccount: gl };
}

async function draftFixture() {
  const fixture = await pricedShippedOrder();
  const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
  return { ...fixture, invoice };
}

async function finalizedFixture() {
  const d = await draftFixture();
  const invoice = await asSystem(() => finalizeInvoice(d.invoice.id));
  return { ...d, invoice };
}

/** The owner's own invoice as plain builder input (order 72026), so the golden numbers here and in
 *  tests/pricing.test.ts describe the same document. billTo/shipTo/remitTo are line arrays — an
 *  invoice's billTo/shipTo are FROZEN snapshot strings (invoices.ts), split here into lines. */
function sampleData(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    company: { name: "American Heat Treating - Alabama, LLC", address: "3008 Red Morris Parkway\nAnniston AL 36207", phone: "256-835-3370" },
    remitTo: { name: "American Heat Treating - Alabama, LLC", lines: ["3008 Red Morris Parkway", "Anniston AL 36207"] },
    billTo: ["GFMCO - Columbus LLC", "PO Box 96", "600 12th Street", "Columbus  GA  31902-0096"],
    shipTo: ["GFMCO - Columbus LLC", "PO Box 96", "600 12th Street", "Columbus  GA  31902-0096"],
    title: "Invoice",
    documentNumber: "7 - 72026", invoiceDate: "2026-07-29", termsName: "Net 30",
    orderNumber: 72026, poNumber: "49499",
    materialName: "Ductile Iron", processNames: "Austemper",
    parts: [{ qty: 144, partNumber: "A16-21591-000", partName: "EQUALIZER-RR SUSP", partDescription: "", eachWeight: 21, totalWeight: 3024 }],
    priceRows: [{ description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: null, amount: 937.44 }],
    subtotal: 937.44,
    surchargeRows: [{ description: "EnergySur", amount: 37.5 }],
    chargeRows: [], certRow: null, freightRow: null, taxRow: null,
    total: 974.94,
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------
// The builder — pure, plain-JSON, and it says what the sample says (spec §10).
// -------------------------------------------------------------------------------------------

describe("buildInvoiceDefinition", () => {
  it("is a pure builder — the definition survives a JSON round trip", () => {
    const def = buildInvoiceDefinition(sampleData());
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
  });

  it("prints the sample's identity block, parts, price rows and totals", async () => {
    const text = allText(buildInvoiceDefinition(sampleData())).join(" ");
    expect(text).toContain("Invoice");
    expect(text).toContain("American Heat Treating - Alabama, LLC");
    expect(text).toContain("7 - 72026");
    expect(text).toContain("Net 30");
    expect(text).toContain("Remit To");
    expect(text).toContain("GFMCO - Columbus LLC");
    expect(text).toContain("72026");                 // Our Order #
    expect(text).toContain("49499");                 // Your PO #
    expect(text).toContain("Ductile Iron");
    expect(text).toContain("Austemper");
    expect(text).toContain("A16-21591-000");
    expect(text).toContain("EQUALIZER-RR SUSP");
    expect(text).toContain("Price per Each");
    expect(text).toContain("6.51");
    expect(text).toContain("Minimum Charge");
    expect(text).toContain("600.00");
    expect(text).toContain("Sub Total Amount");
    expect(text).toContain("937.44");
    expect(text).toContain("EnergySur");
    expect(text).toContain("37.50");
    expect(text).toContain("Total Amount Due");
    expect(text).toContain("974.94");
    // No "Page N of M" — the pure-JSON deviation (the shipping ticket's / cert's own).
    expect(text).not.toContain("Page No.");
    expect(text).not.toMatch(/Page\s+\d+\s+of\s+\d+/);

    // Structural pins on the REAL file — the `%PDF-` header and the page count, never a
    // `Buffer.compare` of two fresh renders (CLAUDE.md).
    const pdf = await renderPdf(buildInvoiceDefinition(sampleData()));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pageCount(pdf)).toBe(1);
  });

  it("titles a credit 'Credit' and prints its negative amounts", () => {
    const text = allText(buildInvoiceDefinition(sampleData({
      title: "Credit", documentNumber: "1000",
      priceRows: [{ description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: null, amount: -937.44 }],
      subtotal: -937.44, surchargeRows: [{ description: "EnergySur", amount: -37.5 }], total: -974.94,
    }))).join(" ");
    expect(text).toContain("Credit");
    expect(text).toContain("1000");
    expect(text).toContain("-937.44");
    expect(text).toContain("-974.94");
  });
});

// -------------------------------------------------------------------------------------------
// The real data path + the print/archive mechanics.
// -------------------------------------------------------------------------------------------

describe("printInvoice", () => {
  beforeEach(truncateAll);

  it("builds the print payload off the frozen invoice detail (parts, price grid, surcharge, total)", async () => {
    await asSystem(() => setSetting("company_name", "American Heat Treating - Alabama, LLC"));
    await asSystem(() => setSetting("company_address", "3008 Red Morris Parkway\nAnniston AL 36207"));
    await asSystem(() => createSurcharge({ name: "EnergySur", kind: "FLAT", amount: "37.50", position: 1, scope: "ALL" }));
    const { order, part } = await pricedShippedOrder();
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));

    const data = await readInvoicePdfData(prisma, invoice.id);
    expect(data.title).toBe("Invoice");
    expect(data.company.name).toBe("American Heat Treating - Alabama, LLC");
    expect(data.remitTo.lines).toContain("3008 Red Morris Parkway");
    expect(data.billTo).toContain("GFMCO - Columbus LLC");           // the FROZEN snapshot, split into lines
    expect(data.parts).toEqual([
      { qty: 144, partNumber: part.partNumber, partName: "EQUALIZER-RR SUSP", partDescription: "", eachWeight: 21, totalWeight: 3024 },
    ]);
    expect(data.priceRows[0]).toMatchObject({ description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, amount: 937.44 });
    expect(data.subtotal).toBe(937.44);
    expect(data.surchargeRows).toEqual([{ description: "EnergySur", amount: 37.5 }]);
    expect(data.total).toBe(974.94);

    const text = allText(buildInvoiceDefinition(data)).join(" ");
    expect(text).toContain("937.44");
    expect(text).toContain("EnergySur");
    expect(text).toContain("974.94");
  });

  it("archives kind INVOICE and reprints the identical stored bytes", async () => {
    const { invoice } = await finalizedFixture();
    const first = await asSystem(() => printInvoice(invoice.id));
    const stored = await getDocument(first.documentId);
    expect(stored.kind).toBe("INVOICE");
    expect(stored.invoiceId).toBe(invoice.id);
    expect(stored.orderId).toBeNull();
    expect(Buffer.compare(stored.fileData, first.pdf)).toBe(0);   // STORED bytes — exact by design

    // A reprint is a byte-for-byte reissue of the STORED bytes, never a re-render.
    const reprint = await getDocument(first.documentId);
    expect(Buffer.compare(reprint.fileData, first.pdf)).toBe(0);
  });

  it("keeps no byte in the audit payload", async () => {
    const { invoice } = await draftFixture();
    const printed = await asSystem(() => printInvoice(invoice.id));
    const entry = await prisma.auditLog.findFirst({ where: { entity: "storedDocument", entityId: printed.documentId } });
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry!.after)).not.toContain("fileData");
    expect(JSON.stringify(entry!.after)).not.toContain("%PDF");
  });

  it("refuses a new print on a discarded draft, and keeps old prints downloadable", async () => {
    const { invoice } = await draftFixture();
    const printed = await asSystem(() => printInvoice(invoice.id));
    // Discard is refused once printed (Task 12) — swallow it, then force the discarded state.
    await asSystem(() => discardInvoice(invoice.id, "raised in error")).catch(() => {});
    await prisma.invoice.update({ where: { id: invoice.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => printInvoice(invoice.id))).rejects.toThrow(/voided/i);
    await expect(getDocument(printed.documentId)).resolves.toBeTruthy();
  });

  it("refuses a new print for a voided ORDER, keeping stored prints readable", async () => {
    const { invoice, order } = await draftFixture();
    const printed = await asSystem(() => printInvoice(invoice.id));
    await prisma.order.update({ where: { id: order.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => printInvoice(invoice.id))).rejects.toThrow(VOIDED_PRINT);
    expect((await getDocument(printed.documentId)).fileData.length).toBeGreaterThan(0);
  });

  it("404s an invoice that does not exist", async () => {
    await expect(asSystem(() => printInvoice("nope"))).rejects.toThrow(/not found/i);
  });

  it("prints a credit with its credit number and negative amounts", async () => {
    const { invoice } = await finalizedFixture();
    const credit = await asSystem(() => createCredit(invoice.id));
    const { documentNumber, documentId, pdf } = await asSystem(() => printInvoice(credit.id));
    expect(documentNumber).toBe(String(credit.creditNumber));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // The number and negatives are pinned on the DEFINITION (the glyph-id reason) — built from the
    // same data the print used.
    const text = allText(buildInvoiceDefinition(await readInvoicePdfData(prisma, credit.id))).join(" ");
    expect(text).toContain("Credit");
    expect(text).toContain(String(credit.creditNumber));
    expect(text).toContain("-937.44");

    const stored = await prisma.storedDocument.findUniqueOrThrow({ where: { id: documentId } });
    expect(stored.kind).toBe("CREDIT");          // the kind follows the invoice row's own kind
    expect(stored.invoiceId).toBe(credit.id);
  });

  // -----------------------------------------------------------------------------------------
  // The binding concurrency requirement (task-19-brief.md, folded in from Task 12's review):
  // printInvoice must claim the invoice row (via `claimInvoiceForPrint`: the order row, then the
  // invoice row) BEFORE it inserts the StoredDocument, so a print and a discard serialize — the
  // discard's "is it printed?" read and print's archive write cannot interleave. Discriminating
  // shape copied from `createInvoice`/`finalizeInvoice`'s own concurrency tests: the competing
  // caller (print) runs at Read Committed via a manually-opened tx, so ONLY the row lock — not SSI
  // — can order the two.
  //
  // The holder mimics discardInvoice holding its claim: it claims the Order row and the Invoice
  // row, then soft-deletes the invoice, all before committing. WITH the claim, print blocks on the
  // holder's order-row lock, then reads the freshly-discarded invoice and refuses — no doc
  // archived. WITHOUT it (RED, verified by hand — see the task report), print reads the invoice
  // through an unlocked snapshot (still live), renders, and its insert lands AFTER the holder
  // commits the delete: a discarded invoice with an archived PDF, and printInvoice RESOLVES instead
  // of rejecting.
  it("claims the invoice row before archiving: a discard-holder makes print refuse, no doc (row-lock discipline)", async () => {
    const { invoice, order } = await draftFixture();

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${invoice.id} FOR UPDATE`;
      await tx.invoice.update({ where: { id: invoice.id }, data: { deletedAt: new Date() } });
      hasClaimed();
      await release;
    }, { timeout: 20000 });

    await claimed;
    // Print at Read Committed — printInvoice called against a manually-opened tx rather than through
    // the public no-`tx` API (which always forces Serializable).
    const printCall = asSystem(() => prisma.$transaction((tx) => printInvoice(invoice.id, tx), { timeout: 20000 }));

    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      printCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);          // blocked on the holder's row claim

    mayRelease();
    await holder;

    // With the claim: print reads the freshly-discarded invoice under the lock and refuses; no doc.
    await expect(printCall).rejects.toThrow(/voided/i);
    expect(await prisma.storedDocument.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// POST /api/invoices/[id]/print — gate invoicing.view (spec §9).
// -------------------------------------------------------------------------------------------

describe("POST /api/invoices/[id]/print", () => {
  beforeEach(truncateAll);

  it("401s without a session", async () => {
    const { invoice } = await draftFixture();
    const res = await printRoute(postReq(`http://t/api/invoices/${invoice.id}/print`), withParams({ id: invoice.id }));
    expect(res.status).toBe(401);
  });

  it("requires invoicing.view", async () => {
    const { invoice } = await draftFixture();
    const cookie = await signInWith(["shipping.view"]);
    const res = await printRoute(postReq(`http://t/api/invoices/${invoice.id}/print`, cookie), withParams({ id: invoice.id }));
    expect(res.status).toBe(403);
  });

  it("streams the invoice PDF with a friendly filename and archives it", async () => {
    const { invoice, order } = await finalizedFixture();
    const cookie = await signInWith(["invoicing.view"]);
    const res = await printRoute(postReq(`http://t/api/invoices/${invoice.id}/print`, cookie), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="invoice-${order.orderNumber}.pdf"`);
    const documentId = res.headers.get("x-document-id")!;
    const stored = await getDocument(documentId);
    expect(stored.kind).toBe("INVOICE");
    expect(Buffer.compare(stored.fileData, Buffer.from(await res.arrayBuffer()))).toBe(0);
  });

  it("names a credit download by its credit number", async () => {
    const { invoice } = await finalizedFixture();
    const credit = await asSystem(() => createCredit(invoice.id));
    const cookie = await signInWith(["invoicing.view"]);
    const res = await printRoute(postReq(`http://t/api/invoices/${credit.id}/print`, cookie), withParams({ id: credit.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="credit-${credit.creditNumber}.pdf"`);
  });
});
