import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, templateVersionId, seedOrderGatePrereqs } from "./helpers/db";
import { drawnPages, drawnText, pageCount, paintedImageCounts } from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder, type OrderDetail } from "@/server/orders";
import { createShipper } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { setSetting } from "@/server/settings";
import {
  createInvoice, finalizeInvoice, createCredit, replaceInvoiceLines, printInvoice,
} from "@/server/invoices";
import { buildInvoiceDefinition, type InvoicePdfData } from "@/server/pdf/invoice";
import { renderPdf, barcodePng } from "@/server/pdf/render";
import { getDocument } from "@/server/documents";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
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
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

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
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

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

// ================================================================================================
// The builder as a CONFIG-CONSUMER over FROZEN data (spec §5.4/§5.6). Pure, plain-JSON fixtures —
// the golden suite's sampleData, kept value-distinctive. The config maps placement/labels/widths/
// fonts/formats/logo over the frozen data; it introduces NO live re-join.
// ================================================================================================

/** The owner's own invoice as plain builder input (order 72026) — billTo/shipTo/remitTo are line
 *  arrays (an invoice's billTo/shipTo are FROZEN snapshot strings, split here into lines). */
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

/** A credit-shaped fixture — negative amounts, the credit number as the bare document number. */
function creditData(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return sampleData({
    title: "Credit", documentNumber: "1000",
    priceRows: [{ description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: null, amount: -937.44 }],
    subtotal: -937.44, surchargeRows: [{ description: "EnergySur", amount: -37.5 }], total: -974.94,
    ...overrides,
  });
}

const cfg = (): TemplateConfig => structuredClone(INVOICE_DEFAULT_CONFIG);
/** Round-trips a tweaked config through the REAL validator — every config a test feeds the builder
 *  (the raw omission-belt shapes excepted, deliberately) is one a template could store. */
const checked = (c: TemplateConfig): TemplateConfig => validateConfig("INVOICE", c);
const sectionOf = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
const fieldOf = (c: TemplateConfig, section: string, key: string) =>
  sectionOf(c, section).fields.find((f) => f.key === key)!;

/** Every `text` string/number in a definition, flattened (skips `image` so a data-URI never
 *  pollutes a text assertion). */
function allText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "image") continue;
      allText(value, out);
    }
  }
  return out;
}
const textOf = (def: unknown): string => allText(def).join("\n");

/** Every node in a definition matching `pred` — structural assertions (font sizes, widths). */
function findNodes(node: unknown, pred: (n: Record<string, unknown>) => boolean,
  out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const n of node) findNodes(n, pred, out); return out; }
  const obj = node as Record<string, unknown>;
  if (pred(obj)) out.push(obj);
  for (const value of Object.values(obj)) findNodes(value, pred, out);
  return out;
}

/** Every table's `widths` array in the definition. */
function allWidths(def: unknown): (number | string)[][] {
  return findNodes(def, (n) => typeof n.table === "object" && n.table !== null)
    .map((n) => (n.table as { widths?: (number | string)[] }).widths)
    .filter((w): w is (number | string)[] => Array.isArray(w));
}

describe("buildInvoiceDefinition — config-driven over frozen data", () => {
  it("a label override prints in place of the contract default", () => {
    const c = cfg();
    fieldOf(c, "identity", "invoice_no").label = "INV NO:";
    fieldOf(c, "order_strip", "material").label = "Alloy:";
    fieldOf(c, "totals", "total").label = "Balance Due:";
    const text = textOf(buildInvoiceDefinition(sampleData(), checked(c)));
    expect(text).toContain("INV NO:");
    expect(text).not.toContain("Invoice No.:");
    expect(text).toContain("Alloy: ");
    expect(text).toContain("Balance Due:");
    expect(text).not.toContain("Total Amount Due:");
    // The FROZEN values are untouched by the relabel — the config maps over frozen data.
    expect(text).toContain("7 - 72026");
    expect(text).toContain("$974.94");
  });

  it("a width override lands in the column-header strip's widths array", () => {
    const c = cfg();
    fieldOf(c, "column_header", "col_each_weight").width = 90;
    const def = buildInvoiceDefinition(sampleData(), checked(c));
    expect(allWidths(def)).toContainEqual([52, "*", 90, 84]);
    // …the default keeps the sample's [52, "*", 66, 84].
    expect(allWidths(buildInvoiceDefinition(sampleData()))).toContainEqual([52, "*", 66, 84]);
  });

  it("a hidden section is omitted from the stack; the default still prints it", () => {
    const c = cfg();
    sectionOf(c, "totals").visible = false;
    const text = textOf(buildInvoiceDefinition(sampleData(), checked(c)));
    expect(text).not.toContain("Sub Total Amount:");
    expect(text).not.toContain("Total Amount Due:");
    expect(textOf(buildInvoiceDefinition(sampleData()))).toContain("Sub Total Amount:");
  });

  it("a hidden column field drops the strip header AND the parts cell; width frees the budget", () => {
    const c = cfg();
    fieldOf(c, "column_header", "col_each_weight").visible = false;
    const def = buildInvoiceDefinition(sampleData(), checked(c));
    expect(textOf(def)).not.toContain("Each weight");
    expect(allWidths(def)).toContainEqual([52, "*", 84]); // the each-weight column is gone from the grid
  });

  it("a hidden non-column field drops its slice of the order strip", () => {
    const c = cfg();
    fieldOf(c, "order_strip", "your_po").visible = false;
    const text = textOf(buildInvoiceDefinition(sampleData(), checked(c)));
    expect(text).not.toContain("Your PO #:");
    expect(text).not.toContain("49499");
    expect(text).toContain("Our Order #:"); // its sibling on the same line survives
  });

  it("stack order follows the config's section order", () => {
    const c = cfg();
    const i = c.sections.findIndex((s) => s.key === "parties");
    const j = c.sections.findIndex((s) => s.key === "identity");
    [c.sections[i], c.sections[j]] = [c.sections[j], c.sections[i]];
    const text = textOf(buildInvoiceDefinition(sampleData(), checked(c)));
    expect(text.indexOf("Billto:")).toBeLessThan(text.indexOf("Remit To"));
    // …the default order is the other way around.
    const dflt = textOf(buildInvoiceDefinition(sampleData()));
    expect(dflt.indexOf("Remit To")).toBeLessThan(dflt.indexOf("Billto:"));
  });

  it("field order follows the config WITHIN the identity block", () => {
    const c = cfg();
    const identity = sectionOf(c, "identity");
    const terms = identity.fields.find((f) => f.key === "terms")!;
    identity.fields = [terms, ...identity.fields.filter((f) => f.key !== "terms")];
    const text = textOf(buildInvoiceDefinition(sampleData(), checked(c)));
    expect(text.indexOf("Terms:")).toBeLessThan(text.indexOf("Invoice No.:"));
  });
});

describe("buildInvoiceDefinition — fonts and number formats", () => {
  it("family, base size and role sizes map into the definition", () => {
    const c = cfg();
    c.fonts = { family: "Liberation Serif", baseSize: 8, headingSize: 26, smallSize: 5 };
    const def = buildInvoiceDefinition(sampleData(), checked(c));
    expect(def.defaultStyle).toEqual({ font: "Liberation Serif", fontSize: 8 });
    // headingSize drives the "Invoice" title; smallSize the footer strip's fine print.
    expect(findNodes(def, (n) => n.text === "Invoice")[0].fontSize).toBe(26);
    expect(findNodes(def, (n) => n.text === "Contact: Accounts Receivable")[0].fontSize).toBe(5);
    // …the default keeps today's literals.
    const dflt = buildInvoiceDefinition(sampleData());
    expect(dflt.defaultStyle).toEqual({ font: "Roboto", fontSize: 9 });
    expect(findNodes(dflt, (n) => n.text === "Invoice")[0].fontSize).toBe(20);
    expect(findNodes(dflt, (n) => n.text === "Contact: Accounts Receivable")[0].fontSize).toBe(7.5);
  });

  it("thousandsSeparator: false ungroups quantities, weights and money", () => {
    const c = cfg();
    c.formats.thousandsSeparator = false;
    const big = sampleData({
      parts: [{ qty: 1440, partNumber: "X", partName: "Y", partDescription: "", eachWeight: 21, totalWeight: 30240 }],
      priceRows: [{ description: "Op", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: null, setupCharge: null, amount: 9374.4 }],
      subtotal: 9374.4, surchargeRows: [], total: 9374.4,
    });
    const text = textOf(buildInvoiceDefinition(big, checked(c)));
    expect(text).toContain("1440");
    expect(text).toContain("30240.00");
    expect(text).toContain("$9374.40");
    expect(text).not.toContain("1,440");
    expect(text).not.toContain("$9,374.40");
  });
});

describe("buildInvoiceDefinition — the date knob (the sample's long full-month style)", () => {
  it.each([
    ["M/D/YYYY", "7/29/2026"],
    ["MM/DD/YYYY", "07/29/2026"],
    ["YYYY-MM-DD", "2026-07-29"],
    ["MMMM D, YYYY", "July 29, 2026"],
    ["MMM - DD - YYYY", "Jul - 29 - 2026"],
  ])("renders the invoice date as %s", (format, expected) => {
    const c = cfg();
    c.formats.dateFormat = format as TemplateConfig["formats"]["dateFormat"];
    expect(textOf(buildInvoiceDefinition(sampleData(), checked(c)))).toContain(expected);
  });

  it("defaults to the sample's 'July 29, 2026' style", () => {
    expect(textOf(buildInvoiceDefinition(sampleData()))).toContain("July 29, 2026");
  });
});

describe("buildInvoiceDefinition — the negativeStyle knob formats a credit (ruling 3)", () => {
  it.each([
    ["SIGN_AFTER_SYMBOL", "$-937.44", "$-974.94"],
    ["LEADING_MINUS", "-$937.44", "-$974.94"],
    ["PARENTHESES", "($937.44)", "($974.94)"],
  ])("renders %s on a credit's negative amounts", (style, amount, total) => {
    const c = cfg();
    c.formats.negativeStyle = style as TemplateConfig["formats"]["negativeStyle"];
    const text = textOf(buildInvoiceDefinition(creditData(), checked(c)));
    expect(text).toContain("Credit");
    expect(text).toContain(amount);
    expect(text).toContain(total);
  });

  it("defaults to SIGN_AFTER_SYMBOL — today's '$-937.44'; a positive invoice is unchanged", () => {
    expect(textOf(buildInvoiceDefinition(creditData()))).toContain("$-937.44");
    expect(textOf(buildInvoiceDefinition(sampleData()))).toContain("$937.44");
  });
});

describe("buildInvoiceDefinition — the §5.6 belt, both halves", () => {
  it("nothing on this contract is locked: a validated config may hide ANY section and the builder honors it", () => {
    const c = cfg();
    sectionOf(c, "parties").visible = false;
    sectionOf(c, "footer").visible = false;
    const validated = checked(c);
    const text = textOf(buildInvoiceDefinition(sampleData(), validated));
    expect(text).not.toContain("Billto:");
    expect(text).not.toContain("Contact: Accounts Receivable");
  });

  it("a raw config OMITTING the totals section entry still renders it (the omission half)", () => {
    const c = cfg();
    c.sections = c.sections.filter((s) => s.key !== "totals");
    const text = textOf(buildInvoiceDefinition(sampleData(), c));
    expect(text).toContain("Sub Total Amount:");
    expect(text).toContain("Total Amount Due:");
  });

  it("a raw config OMITTING a field entry inside a present section still renders it", () => {
    const c = cfg();
    const order = sectionOf(c, "order_strip");
    order.fields = order.fields.filter((f) => f.key !== "process");
    const text = textOf(buildInvoiceDefinition(sampleData(), c));
    expect(text).toContain("Process: ");
  });
});

const LOGO_URI = "data:image/png;base64,INVOICELOGOFIXTURE";

describe("buildInvoiceDefinition — logo placement (spec §6.3)", () => {
  const placedConfig = (placement: "header-left" | "header-center" | "header-right") => {
    const c = cfg();
    c.logo = { placement, width: 90 };
    return checked(c);
  };
  const header = (def: unknown) => (def as { content: Record<string, unknown>[] }).content[0];

  it("a header-center logo unshifts into the centered header stack", () => {
    const h = header(buildInvoiceDefinition(sampleData(), placedConfig("header-center"), LOGO_URI));
    expect((h.stack as { image?: string }[])[0]).toEqual({ image: LOGO_URI, width: 90 });
  });

  it("a header-left logo rides the left column at its configured width", () => {
    const h = header(buildInvoiceDefinition(sampleData(), placedConfig("header-left"), LOGO_URI));
    const cols = h.columns as { width?: number; stack?: { image?: string }[] }[];
    expect(cols[0].stack![0]).toEqual({ image: LOGO_URI, width: 90 });
  });

  it("a header-right logo rides the right column", () => {
    const h = header(buildInvoiceDefinition(sampleData(), placedConfig("header-right"), LOGO_URI));
    const cols = h.columns as { width?: number; stack?: { image?: string }[] }[];
    expect(cols[cols.length - 1].stack![0]).toEqual({ image: LOGO_URI, width: 90 });
  });

  it("config placement without bytes, and bytes without placement, both fall back to the text-only header", () => {
    expect(JSON.stringify(buildInvoiceDefinition(sampleData(), placedConfig("header-center")))).not.toContain(LOGO_URI);
    expect(JSON.stringify(buildInvoiceDefinition(sampleData(), cfg(), LOGO_URI))).not.toContain(LOGO_URI);
  });
});

describe("buildInvoiceDefinition — pageFooter knob and continuation band", () => {
  it("the knob OFF keeps the static company-strip footer; the margins are today's", () => {
    const dflt = buildInvoiceDefinition(sampleData());
    expect(dflt.pageFooterSpec).toBeUndefined();
    expect(textOf(dflt.footer)).toContain("Phone: 256-835-3370");
    expect(dflt.pageMargins).toEqual([24, 24, 24, 44]);
  });

  it("the knob ON moves the company strip onto the pageNofM footer's `above` slot, dropping the plain footer", () => {
    const c = cfg();
    c.pageFooter = true;
    const def = buildInvoiceDefinition(sampleData(), checked(c));
    expect(def.footer).toBeUndefined();
    expect(def.pageFooterSpec!.kind).toBe("pageNofM");
    expect(textOf(def.pageFooterSpec!.above)).toContain("Phone: 256-835-3370");
    expect(def.pageMargins).toEqual([24, 24, 24, 44]);
  });

  it("the knob ON with the footer section hidden carries the page line alone", () => {
    const c = cfg();
    c.pageFooter = true;
    sectionOf(c, "footer").visible = false;
    const def = buildInvoiceDefinition(sampleData(), checked(c));
    expect(def.pageFooterSpec).toEqual({ kind: "pageNofM" });
    expect(def.footer).toBeUndefined();
  });

  it("the definition carries the invoice's identity band for continuation pages", () => {
    const def = buildInvoiceDefinition(sampleData());
    const band = allText(def.continuationHeaderSpec!.content).join("\n");
    expect(band).toContain("Invoice No.: 7 - 72026");
    expect(band).toContain("(continued)");
    expect(def.continuationHeaderSpec!.overflowTopMargin).toBeGreaterThanOrEqual(36);
  });

  it("the band carries an invoice_no label override but ignores its visibility flag — identity on paper is locked", () => {
    const c = cfg();
    fieldOf(c, "identity", "invoice_no").label = "Job No.:";
    fieldOf(c, "identity", "invoice_no").visible = false;
    const def = buildInvoiceDefinition(sampleData(), checked(c));
    const band = allText(def.continuationHeaderSpec!.content).join("\n");
    expect(band).toContain("Job No.: 7 - 72026");
    // …while the sheet body honours the hide.
    expect(textOf(def.content)).not.toContain("Job No.:");
  });

  it("a many-part invoice overflows LETTER and repeats its identity on the last page (the live overflow path)", async () => {
    const parts = Array.from({ length: 40 }, (_, i) => ({
      qty: 144, partNumber: `A16-${i}`, partName: "EQUALIZER-RR SUSP", partDescription: "SUSP", eachWeight: 21, totalWeight: 3024,
    }));
    const pdf = await renderPdf(buildInvoiceDefinition(sampleData({ parts })));
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
    const pages = drawnPages(pdf);
    expect(pages[0]).not.toContain("(continued)");
    expect(pages[pages.length - 1]).toContain("(continued)");
  });
});

describe("buildInvoiceDefinition — purity, config included", () => {
  it("a config-driven definition survives the JSON round trip and is deterministic", () => {
    const c = cfg();
    c.logo = { placement: "header-right", width: 80 };
    fieldOf(c, "identity", "invoice_no").label = "INV:";
    c.formats.dateFormat = "YYYY-MM-DD";
    c.formats.negativeStyle = "PARENTHESES";
    c.pageFooter = true;
    const config = checked(c);
    const def = buildInvoiceDefinition(creditData(), config, LOGO_URI);
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    expect(buildInvoiceDefinition(creditData(), config, LOGO_URI)).toEqual(def);
  });
});

// ================================================================================================
// The print path (spec §5.2): resolve docType `INVOICE` on the invoice's own customer (BOTH an
// invoice and a credit resolve INVOICE — spec §4.1: one contract covers credits), render the
// resolved config, stamp `templateVersionId`. `claimInvoiceForPrint`'s order+invoice claim and the
// print-vs-discard serialization are untouched. Reprints reissue STORED bytes, never re-render.
// ================================================================================================

/** Create → tweak the v1 draft → (optionally logo) → publish, for the INVOICE docType. */
let tplSeq = 0;
async function publishCustom(tweak: (c: TemplateConfig) => void, logo?: { data: Buffer; mime: string }) {
  tplSeq += 1;
  const t = await asSystem(() => createTemplate("INVOICE", `Custom Invoice ${tplSeq}`));
  const c = cfg();
  tweak(c);
  await asSystem(() => editDraft(t.id, { config: c, updatedAt: t.draft.updatedAt }));
  if (logo) await asSystem(() => uploadLogo(t.id, logo.data, logo.mime));
  const { versionId } = await asSystem(() => publishDraft(t.id));
  return { templateId: t.id, versionId };
}

async function stampOf(documentId: string): Promise<string | null> {
  const row = await prisma.storedDocument.findUnique({
    where: { id: documentId }, select: { templateVersionId: true },
  });
  return row!.templateVersionId;
}

describe("printInvoice — resolution stamps the version (INVOICE for both invoice and credit)", () => {
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    await asSystem(() => setSetting("company_name", "American Heat Treating - Alabama, LLC"));
    await asSystem(() => setSetting("company_address", "3008 Red Morris Parkway\nAnniston AL 36207"));
    await asSystem(() => setSetting("company_phone", "256-835-3370"));
  });

  it("no assignment: resolves the seeded Standard invoice and stamps ITS version id", async () => {
    const { invoice } = await finalizedFixture();
    const { documentId, pdf } = await asSystem(() => printInvoice(invoice.id));
    expect(drawnText(pdf)).toContain("Invoice");
    expect(await stampOf(documentId)).toBe(templateVersionId("INVOICE"));
  });

  it("a label override prints through the real path and stamps the assigned version", async () => {
    const { invoice, customer } = await finalizedFixture();
    const tpl = await publishCustom((c) => { fieldOf(c, "totals", "total").label = "TOTAL-MARKER:"; });
    await asSystem(() => assignTemplate(customer.id, "INVOICE", tpl.templateId));
    const { documentId, pdf } = await asSystem(() => printInvoice(invoice.id));
    expect(drawnText(pdf)).toContain("TOTAL-MARKER:");
    expect(await stampOf(documentId)).toBe(tpl.versionId);
  });

  it("BOTH an invoice and its credit resolve INVOICE — same assigned template, same version stamp", async () => {
    const { invoice, customer } = await finalizedFixture();
    const tpl = await publishCustom((c) => { fieldOf(c, "totals", "total").label = "SHARED-MARKER:"; });
    await asSystem(() => assignTemplate(customer.id, "INVOICE", tpl.templateId));

    const inv = await asSystem(() => printInvoice(invoice.id));
    expect(drawnText(inv.pdf)).toContain("SHARED-MARKER:");
    expect(await stampOf(inv.documentId)).toBe(tpl.versionId);

    const credit = await asSystem(() => createCredit(invoice.id));
    const cr = await asSystem(() => printInvoice(credit.id));
    expect(drawnText(cr.pdf)).toContain("SHARED-MARKER:");
    expect(await stampOf(cr.documentId)).toBe(tpl.versionId);
  });

  it("the negativeStyle knob formats a credit through the real path", async () => {
    const { invoice, customer } = await finalizedFixture();
    const tpl = await publishCustom((c) => { c.formats.negativeStyle = "PARENTHESES"; });
    await asSystem(() => assignTemplate(customer.id, "INVOICE", tpl.templateId));
    const credit = await asSystem(() => createCredit(invoice.id));
    const { pdf } = await asSystem(() => printInvoice(credit.id));
    const text = drawnText(pdf);
    expect(text).toContain("Credit");
    expect(text).toContain("($937.44)");
  });

  it("the pageFooter knob prints per-page numbers; the default prints none", async () => {
    const a = await finalizedFixture();
    const tpl = await publishCustom((c) => { c.pageFooter = true; });
    await asSystem(() => assignTemplate(a.customer.id, "INVOICE", tpl.templateId));
    const withFooter = await asSystem(() => printInvoice(a.invoice.id));
    expect(drawnText(withFooter.pdf)).toContain("Page 1 of 1");

    const b = await finalizedFixture();
    const bare = await asSystem(() => printInvoice(b.invoice.id));
    expect(drawnText(bare.pdf)).not.toMatch(/Page \d+ of \d+/);
  });

  it("a placed logo prints through the real path; the bare invoice paints none", async () => {
    const a = await finalizedFixture();
    const tpl = await publishCustom(
      (c) => { c.logo = { placement: "header-left", width: 90 }; },
      { data: await barcodePng("INVLOGO"), mime: "image/png" });
    await asSystem(() => assignTemplate(a.customer.id, "INVOICE", tpl.templateId));
    const placed = await asSystem(() => printInvoice(a.invoice.id));
    expect(paintedImageCounts(placed.pdf)).toEqual([1]);

    const b = await finalizedFixture();
    const bare = await asSystem(() => printInvoice(b.invoice.id));
    expect(paintedImageCounts(bare.pdf)).toEqual([0]);
  });

  it("a template edit after an invoice is raised changes NOTHING on reprint — the frozen-paper proof", async () => {
    const { invoice, customer } = await finalizedFixture();
    // Assign a template that relabels the total, then print — the paper carries that label.
    const first = await publishCustom((c) => { fieldOf(c, "totals", "total").label = "ORIGINAL-MARKER:"; });
    await asSystem(() => assignTemplate(customer.id, "INVOICE", first.templateId));
    const printed = await asSystem(() => printInvoice(invoice.id));
    expect(drawnText(printed.pdf)).toContain("ORIGINAL-MARKER:");

    // Publish and assign a DIFFERENT template AFTER the invoice was raised and printed.
    const second = await publishCustom((c) => { fieldOf(c, "totals", "total").label = "CHANGED-MARKER:"; });
    await asSystem(() => assignTemplate(customer.id, "INVOICE", second.templateId));

    // The STORED bytes of the raised paper are byte-for-byte unchanged — a reprint reissues them,
    // never re-renders under the new template.
    const stored = await getDocument(printed.documentId);
    expect(Buffer.compare(stored.fileData, printed.pdf)).toBe(0);
    const storedText = drawnText(stored.fileData);
    expect(storedText).toContain("ORIGINAL-MARKER:");
    expect(storedText).not.toContain("CHANGED-MARKER:");
  });
});
