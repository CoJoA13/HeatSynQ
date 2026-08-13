import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, templateVersionId } from "./helpers/db";
import { drawnPages, drawnText, pageCount, paintedImageCounts } from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder, type OrderDetail } from "@/server/orders";
import { createShipper } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { createSurcharge } from "@/server/surcharges";
import { setSetting } from "@/server/settings";
import {
  createInvoice, finalizeInvoice, createCredit, replaceInvoiceLines, printInvoice,
  readInvoicePdfData,
} from "@/server/invoices";
import { buildInvoiceDefinition, type InvoicePdfData } from "@/server/pdf/invoice";
import { renderPdf } from "@/server/pdf/render";
import { getDocument } from "@/server/documents";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { barcodePng } from "@/server/pdf/render";
import { INVOICE_DEFAULT_CONFIG, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import type { Customer, Part } from "../prisma/generated/prisma/client";

/**
 * Phase 7 Task 12 — the invoice/credit conversion. `buildInvoiceDefinition` becomes a
 * config-consumer over FROZEN snapshot data (spec §5.4/§5.6) — the OPPOSITE snapshot rule from the
 * cert/shipper: `InvoicePdfData` is built exclusively from the invoice row's frozen columns, and the
 * config controls placement/labels/widths/fonts/formats/logo over that frozen data. It introduces NO
 * live re-join. This file also covers the `processName` create-time snapshot source (§5.7, ruling 4)
 * and issue #98 (the `sourceQuoteNumber`-requires-QUOTE refine). The golden 5A suites
 * (invoice-pdf/invoices/invoice-routes/invoice-guards) stay UNTOUCHED — all Task-12 tests live here.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

// ------------------------------------------------------------------------------------------------
// Real-data fixtures — copied in shape from tests/invoice-pdf.test.ts (copying across test files is
// this repo's convention).
// ------------------------------------------------------------------------------------------------

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `ITP${customerSeq}`, name: `Invoice Template Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string, processName = ""): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({
    data: { customerId, partNumber: `P-${partSeq}`, name: "EQUALIZER-RR SUSP", eachWeight: "21.0000", processName },
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

async function savedOrder(processName = ""): Promise<{ order: OrderDetail; part: Part; customer: Customer }> {
  const customer = await makeCustomer();
  await makeBillTo(customer.id);
  const part = await makePart(customer.id, processName);
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
async function pricedShippedOrder(processName = "") {
  const { order, part, customer } = await savedOrder(processName);
  const { shipper } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
  const gl = await prisma.glAccount.create({ data: { name: `4010-${partSeq}`, description: "Sales" } });
  const code = await prisma.processStepCode.create({ data: { code: `AUST-${partSeq}`, name: "Austemper", glAccountId: gl.id } });
  await asSystem(() => addPartPrice(part.id, {
    processStepCodeId: code.id, position: 1, unitPrice: "6.5100", minimumCharge: "600.00", pricePer: "EACH",
  }));
  return { order: await getOrder(order.id), part, customer, shipper, stepCode: code, glAccount: gl };
}

async function draftFixture(processName = "") {
  const fixture = await pricedShippedOrder(processName);
  const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
  return { ...fixture, invoice };
}

async function finalizedFixture(processName = "") {
  const d = await draftFixture(processName);
  const invoice = await asSystem(() => finalizeInvoice(d.invoice.id));
  return { ...d, invoice };
}

// ================================================================================================
// Issue #98 — LINE_INPUT gains a refine: sourceQuoteNumber only alongside priceSource === "QUOTE".
// The manual invoice-lines save (replaceInvoiceLines) is the trust surface; the refine is shape-
// tightening (permission-gated, audited), NOT authenticity verification against live quotes — a
// frozen-paper deliberate non-goal. The echo-back for genuine QUOTE lines must keep working.
// ================================================================================================

describe("replaceInvoiceLines — #98: sourceQuoteNumber requires priceSource QUOTE", () => {
  beforeEach(truncateAll);

  it("refuses a MANUAL line that carries a sourceQuoteNumber", async () => {
    const { invoice } = await draftFixture();
    await expect(asSystem(() => replaceInvoiceLines(invoice.id, [
      { kind: "CHARGE", description: "Hand-typed", amount: "25.00", priceSource: "MANUAL", sourceQuoteNumber: 999 },
    ]))).rejects.toMatchObject({ name: "ZodError" });
  });

  it("refuses a null-priceSource line that carries a sourceQuoteNumber", async () => {
    const { invoice } = await draftFixture();
    await expect(asSystem(() => replaceInvoiceLines(invoice.id, [
      { kind: "CHARGE", description: "No source", amount: "10.00", sourceQuoteNumber: 42 },
    ]))).rejects.toMatchObject({ name: "ZodError" });
  });

  it("allows a QUOTE line to carry its sourceQuoteNumber (the echo-back survives)", async () => {
    const { invoice } = await draftFixture();
    const edited = await asSystem(() => replaceInvoiceLines(invoice.id, [
      { kind: "OPERATION", description: "Austemper", amount: "937.44", priceSource: "QUOTE", sourceQuoteNumber: 1006 },
    ]));
    const op = edited.lines.find((l) => l.kind === "OPERATION")!;
    expect(op.priceSource).toBe("QUOTE");
    expect(op.sourceQuoteNumber).toBe(1006);
  });

  it("allows a MANUAL line with no sourceQuoteNumber (the ordinary manual charge)", async () => {
    const { invoice } = await draftFixture();
    const edited = await asSystem(() => replaceInvoiceLines(invoice.id, [
      { kind: "CHARGE", description: "Hand-typed", amount: "25.00", priceSource: "MANUAL" },
    ]));
    expect(edited.lines.some((l) => l.description === "Hand-typed")).toBe(true);
  });
});

// ================================================================================================
// processName snapshot source (spec §5.7, ruling 4 — CREATE-TIME): the invoice's `processNames`
// snapshot is `part.processName` when non-blank, else the priced-operation comma-join. Prints read
// the snapshot UNCONDITIONALLY, so a processName edit after finalize provably changes nothing on
// raised paper (the load-bearing frozen-paper proof). Pre-existing invoices are untouched.
// ================================================================================================

describe("invoice processNames — create-time source (spec §5.7)", () => {
  beforeEach(truncateAll);

  it("snapshots part.processName when it is non-blank", async () => {
    const { invoice } = await draftFixture("MARQUENCHZONE");
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { processNames: true } });
    expect(row.processNames).toBe("MARQUENCHZONE");
  });

  it("falls back to the priced-operation comma-join when part.processName is blank", async () => {
    const { invoice } = await draftFixture(""); // blank
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { processNames: true } });
    expect(row.processNames).toBe("Austemper"); // the lead line's priced operation name
  });

  it("a processName edit after finalize changes NOTHING on raised paper (the frozen-paper proof)", async () => {
    const { invoice, part } = await finalizedFixture("MARQUENCHZONE");
    await asSystem(() => setSetting("company_name", "American Heat Treating - Alabama, LLC"));
    await asSystem(() => setSetting("company_address", "3008 Red Morris Parkway\nAnniston AL 36207"));

    // Print once: the paper carries the frozen snapshot value.
    const first = await asSystem(() => printInvoice(invoice.id));
    expect(drawnText(first.pdf)).toContain("MARQUENCHZONE");

    // Edit the live part's processName to a DISTINCT marker AFTER the invoice was raised.
    await prisma.part.update({ where: { id: part.id }, data: { processName: "EDITEDAFTERWARD" } });

    // The frozen column is unchanged...
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { processNames: true } });
    expect(row.processNames).toBe("MARQUENCHZONE");

    // ...a fresh render still prints the frozen value, never the live edit (no re-join)...
    const reprint = await asSystem(() => printInvoice(invoice.id));
    const text = drawnText(reprint.pdf);
    expect(text).toContain("MARQUENCHZONE");
    expect(text).not.toContain("EDITEDAFTERWARD");

    // ...and the STORED bytes of the first print decode to the frozen value too.
    const stored = await getDocument(first.documentId);
    expect(drawnText(stored.fileData)).toContain("MARQUENCHZONE");
  });

  it("a credit copies the source invoice's frozen processNames snapshot (unchanged today)", async () => {
    const { invoice } = await finalizedFixture("MARQUENCHZONE");
    const credit = await asSystem(() => createCredit(invoice.id));
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: credit.id }, select: { processNames: true } });
    expect(row.processNames).toBe("MARQUENCHZONE");
  });
});
