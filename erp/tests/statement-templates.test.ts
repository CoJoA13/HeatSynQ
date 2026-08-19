import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, templateVersionId } from "./helpers/db";
import { drawnText, drawnPages, pageCount, paintedImageCounts } from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { setSetting } from "@/server/settings";
import { printStatement, buildStatement, type StatementData } from "@/server/statements";
import { buildStatementDefinition } from "@/server/pdf/statement";
import { renderPdf, barcodePng } from "@/server/pdf/render";
import { getDocument } from "@/server/documents";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { STATEMENT_DEFAULT_CONFIG, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import type { Customer } from "../prisma/generated/prisma/client";

/**
 * Phase 7 Task 13 — the statement conversion. `buildStatementDefinition` becomes a config-consumer
 * over LIVE-rebuilt data (spec §5.4/§5.6). The statement is the THIRD snapshot posture and the
 * OPPOSITE of the invoice: not frozen paper, but a fully-live rebuild every print — a data change
 * between two prints shows in the second (the live-rebuild proof below, the mirror image of the
 * invoice's frozen-paper proof). The golden 5B suites (statement-pdf/statements) stay UNTOUCHED —
 * all Task-13 tests live here.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

// ------------------------------------------------------------------------------------------------
// Pure builder fixtures — copied in shape from tests/statement-pdf.test.ts (copying across test
// files is this repo's convention), kept value-distinctive.
// ------------------------------------------------------------------------------------------------

function sampleData(overrides: Partial<StatementData> = {}): StatementData {
  return {
    asOf: "2026-07-29",
    company: {
      name: "American Heat Treating - Alabama, LLC",
      address: "3008 Red Morris Parkway\nAnniston AL 36207", phone: "256-835-3370",
    },
    remitTo: {
      name: "American Heat Treating - Alabama, LLC",
      lines: ["3008 Red Morris Parkway", "Anniston AL 36207"],
    },
    customer: {
      code: "C100", name: "GFMCO - Columbus LLC",
      billTo: ["GFMCO - Columbus LLC", "600 12th Street", "Columbus GA 31902-0096"],
    },
    openItems: [
      { documentNumber: "7 - 72026", date: "2026-06-29", dueDate: "2026-06-29", kind: "INVOICE", original: 1000, open: 400 },
      { documentNumber: "1000", date: "2026-07-19", dueDate: null, kind: "CREDIT", original: -200, open: -200 },
    ],
    aging: {
      customerId: "cust-1", customerCode: "C100", customerName: "GFMCO - Columbus LLC",
      current: 0, d1_30: 0, d31_60: 400, d61_90: 0, d90_plus: 0, unapplied: 200, net: 200,
    },
    financeCharge: null,
    totalDue: 200,
    ...overrides,
  };
}

const cfg = (): TemplateConfig => structuredClone(STATEMENT_DEFAULT_CONFIG);
/** Round-trips a tweaked config through the REAL validator — every config a test feeds the builder
 *  (the raw omission-belt shapes excepted, deliberately) is one a template could store. */
const checked = (c: TemplateConfig): TemplateConfig => validateConfig("STATEMENT", c);
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

describe("buildStatementDefinition — config-driven over live data", () => {
  it("a label override prints in place of the contract default", () => {
    const c = cfg();
    fieldOf(c, "identity", "customer").label = "Account:";
    fieldOf(c, "aging", "aging_net").label = "Balance:";
    fieldOf(c, "total", "total_due").label = "Amount Owed:";
    const text = textOf(buildStatementDefinition(sampleData(), checked(c)));
    expect(text).toContain("Account: ");
    expect(text).not.toContain("Customer:");
    expect(text).toContain("Balance:");
    expect(text).not.toContain("Net");
    expect(text).toContain("Amount Owed:");
    expect(text).not.toContain("Total Due:");
    // The live-rebuilt VALUES are untouched by the relabel — the config maps over the data.
    expect(text).toContain("C100");
    expect(text).toContain("$200.00");
  });

  it("an aging width override lands in the aging table's widths array", () => {
    const c = cfg();
    fieldOf(c, "aging", "aging_net").width = 100;
    const def = buildStatementDefinition(sampleData(), checked(c));
    expect(allWidths(def)).toContainEqual(["*", "*", "*", "*", "*", "*", 100]);
    // …the default keeps the seven equal flex columns.
    expect(allWidths(buildStatementDefinition(sampleData()))).toContainEqual(["*", "*", "*", "*", "*", "*", "*"]);
  });

  it("a hidden section is omitted from the stack; the default still prints it", () => {
    const c = cfg();
    sectionOf(c, "aging").visible = false;
    const text = textOf(buildStatementDefinition(sampleData(), checked(c)));
    expect(text).not.toContain("Unapplied");
    expect(textOf(buildStatementDefinition(sampleData()))).toContain("Unapplied");
  });

  it("a hidden open-item field drops its whole column (header AND cells); the widths shrink", () => {
    const c = cfg();
    fieldOf(c, "open_items", "due_date").visible = false;
    const def = buildStatementDefinition(sampleData(), checked(c));
    expect(textOf(def)).not.toContain("Due Date");
    expect(allWidths(def)).toContainEqual(["auto", "auto", "*", "*"]); // the due-date column is gone
    // …the default keeps the five-column ["auto","auto","auto","*","*"].
    expect(allWidths(buildStatementDefinition(sampleData()))).toContainEqual(["auto", "auto", "auto", "*", "*"]);
  });

  it("a hidden aging column drops from the strip and shrinks its widths", () => {
    const c = cfg();
    fieldOf(c, "aging", "aging_unapplied").visible = false;
    const def = buildStatementDefinition(sampleData(), checked(c));
    expect(textOf(def)).not.toContain("Unapplied");
    expect(allWidths(def)).toContainEqual(["*", "*", "*", "*", "*", "*"]); // six columns now
  });

  it("stack order follows the config's section order", () => {
    const c = cfg();
    const i = c.sections.findIndex((s) => s.key === "header");
    const j = c.sections.findIndex((s) => s.key === "identity");
    [c.sections[i], c.sections[j]] = [c.sections[j], c.sections[i]];
    const text = textOf(buildStatementDefinition(sampleData(), checked(c)));
    expect(text.indexOf("Customer:")).toBeLessThan(text.indexOf("Statement"));
    // …the default order is title first.
    const dflt = textOf(buildStatementDefinition(sampleData()));
    expect(dflt.indexOf("Statement")).toBeLessThan(dflt.indexOf("Customer:"));
  });

  it("field order follows the config WITHIN the identity block", () => {
    const c = cfg();
    const identity = sectionOf(c, "identity");
    const date = identity.fields.find((f) => f.key === "statement_date")!;
    identity.fields = [date, ...identity.fields.filter((f) => f.key !== "statement_date")];
    const text = textOf(buildStatementDefinition(sampleData(), checked(c)));
    expect(text.indexOf("Statement Date:")).toBeLessThan(text.indexOf("Customer:"));
  });
});

describe("buildStatementDefinition — fonts and number formats", () => {
  it("family, base size and heading size map into the definition", () => {
    const c = cfg();
    c.fonts = { family: "Liberation Serif", baseSize: 8, headingSize: 26, smallSize: 5 };
    const def = buildStatementDefinition(sampleData(), checked(c));
    expect(def.defaultStyle).toEqual({ font: "Liberation Serif", fontSize: 8 });
    // headingSize drives the "Statement" title.
    expect(findNodes(def, (n) => n.text === "Statement")[0].fontSize).toBe(26);
    // …the default keeps today's literals.
    const dflt = buildStatementDefinition(sampleData());
    expect(dflt.defaultStyle).toEqual({ font: "Roboto", fontSize: 9 });
    expect(findNodes(dflt, (n) => n.text === "Statement")[0].fontSize).toBe(20);
  });

  it("thousandsSeparator: false ungroups money", () => {
    const c = cfg();
    c.formats.thousandsSeparator = false;
    const big = sampleData({
      openItems: [{ documentNumber: "7 - 72026", date: "2026-06-29", dueDate: "2026-06-29", kind: "INVOICE", original: 12000, open: 9374.4 }],
      aging: { customerId: "x", customerCode: "C100", customerName: "GFMCO", current: 9374.4, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, unapplied: 0, net: 9374.4 },
      totalDue: 9374.4,
    });
    const text = textOf(buildStatementDefinition(big, checked(c)));
    expect(text).toContain("$9374.40");
    expect(text).not.toContain("$9,374.40");
  });
});

describe("buildStatementDefinition — the date knob (both slots, one style)", () => {
  it.each([
    ["M/D/YYYY", "7/29/2026"],
    ["MM/DD/YYYY", "07/29/2026"],
    ["YYYY-MM-DD", "2026-07-29"],
    ["MMMM D, YYYY", "July 29, 2026"],
    ["MMM - DD - YYYY", "Jul - 29 - 2026"],
  ])("renders the statement date as %s", (format, expected) => {
    const c = cfg();
    c.formats.dateFormat = format as TemplateConfig["formats"]["dateFormat"];
    expect(textOf(buildStatementDefinition(sampleData(), checked(c)))).toContain(expected);
  });

  it("defaults to the 'July 29, 2026' long-full-month style", () => {
    expect(textOf(buildStatementDefinition(sampleData()))).toContain("July 29, 2026");
  });
});

describe("buildStatementDefinition — the negativeStyle knob formats credit/payment money (ruling 3)", () => {
  const withPayment = () => sampleData({
    openItems: [
      { documentNumber: "7 - 72026", date: "2026-06-29", dueDate: "2026-06-29", kind: "INVOICE", original: 1000, open: 400 },
      { documentNumber: "CHK-4711", date: "2026-07-19", dueDate: null, kind: "PAYMENT", original: 300, open: -300 },
    ],
  });
  it.each([
    ["SIGN_AFTER_SYMBOL", "$-300.00"],
    ["LEADING_MINUS", "-$300.00"],
    ["PARENTHESES", "($300.00)"],
  ])("renders %s on an on-account payment's negative Open amount", (style, expected) => {
    const c = cfg();
    c.formats.negativeStyle = style as TemplateConfig["formats"]["negativeStyle"];
    expect(textOf(buildStatementDefinition(withPayment(), checked(c)))).toContain(expected);
  });

  it("defaults to SIGN_AFTER_SYMBOL — today's '$-200.00'; a positive amount is unchanged", () => {
    expect(textOf(buildStatementDefinition(sampleData()))).toContain("$-200.00");
    expect(textOf(buildStatementDefinition(sampleData()))).toContain("$200.00");
  });
});

describe("buildStatementDefinition — the §5.6 belt, both halves", () => {
  it("nothing on this contract is locked: a validated config may hide ANY section and the builder honors it", () => {
    const c = cfg();
    sectionOf(c, "total").visible = false;
    sectionOf(c, "finance_charge").visible = false;
    const text = textOf(buildStatementDefinition(sampleData(), checked(c)));
    expect(text).not.toContain("Total Due:");
  });

  it("a raw config OMITTING the total section entry still renders it (the omission half)", () => {
    const c = cfg();
    c.sections = c.sections.filter((s) => s.key !== "total");
    const text = textOf(buildStatementDefinition(sampleData(), c));
    expect(text).toContain("Total Due:");
  });

  it("a raw config OMITTING a field entry inside a present section still renders it", () => {
    const c = cfg();
    const aging = sectionOf(c, "aging");
    aging.fields = aging.fields.filter((f) => f.key !== "aging_unapplied");
    const text = textOf(buildStatementDefinition(sampleData(), c));
    expect(text).toContain("Unapplied");
  });
});

const LOGO_URI = "data:image/png;base64,STATEMENTLOGOFIXTURE";

describe("buildStatementDefinition — logo placement (spec §6.3)", () => {
  const placedConfig = (placement: "header-left" | "header-center" | "header-right") => {
    const c = cfg();
    c.logo = { placement, width: 90 };
    return checked(c);
  };
  const header = (def: unknown) => (def as { content: Record<string, unknown>[] }).content[0];

  it("a header-center logo unshifts into the centered header stack", () => {
    const h = header(buildStatementDefinition(sampleData(), placedConfig("header-center"), LOGO_URI));
    expect((h.stack as { image?: string }[])[0]).toEqual({ image: LOGO_URI, width: 90 });
  });

  it("a header-left logo rides the left column at its configured width", () => {
    const h = header(buildStatementDefinition(sampleData(), placedConfig("header-left"), LOGO_URI));
    const cols = h.columns as { width?: number; stack?: { image?: string }[] }[];
    expect(cols[0].stack![0]).toEqual({ image: LOGO_URI, width: 90 });
  });

  it("a header-right logo rides the right column", () => {
    const h = header(buildStatementDefinition(sampleData(), placedConfig("header-right"), LOGO_URI));
    const cols = h.columns as { width?: number; stack?: { image?: string }[] }[];
    expect(cols[cols.length - 1].stack![0]).toEqual({ image: LOGO_URI, width: 90 });
  });

  it("config placement without bytes, and bytes without placement, both fall back to the text-only header", () => {
    expect(JSON.stringify(buildStatementDefinition(sampleData(), placedConfig("header-center")))).not.toContain(LOGO_URI);
    expect(JSON.stringify(buildStatementDefinition(sampleData(), cfg(), LOGO_URI))).not.toContain(LOGO_URI);
  });
});

describe("buildStatementDefinition — pageFooter knob and continuation band", () => {
  it("the knob OFF prints no footer at all; the margins are today's", () => {
    const dflt = buildStatementDefinition(sampleData());
    expect(dflt.pageFooterSpec).toBeUndefined();
    expect(dflt.footer).toBeUndefined();
    expect(dflt.pageMargins).toEqual([24, 24, 24, 40]);
  });

  it("the knob ON turns on the pageNofM footer (a bare page line — the statement has no company strip)", () => {
    const c = cfg();
    c.pageFooter = true;
    const def = buildStatementDefinition(sampleData(), checked(c));
    expect(def.footer).toBeUndefined();
    expect(def.pageFooterSpec).toEqual({ kind: "pageNofM" });
    expect(def.pageMargins).toEqual([24, 24, 24, 40]);
  });

  it("the definition carries the statement's identity band for continuation pages", () => {
    const def = buildStatementDefinition(sampleData());
    const band = allText(def.continuationHeaderSpec!.content).join("\n");
    expect(band).toContain("Customer: C100 — GFMCO - Columbus LLC");
    expect(band).toContain("(continued)");
    expect(def.continuationHeaderSpec!.overflowTopMargin).toBeGreaterThanOrEqual(36);
  });

  it("the band carries a customer label override but ignores its visibility flag — identity on paper is locked", () => {
    const c = cfg();
    fieldOf(c, "identity", "customer").label = "Account:";
    fieldOf(c, "identity", "customer").visible = false;
    const def = buildStatementDefinition(sampleData(), checked(c));
    const band = allText(def.continuationHeaderSpec!.content).join("\n");
    expect(band).toContain("Account: C100 — GFMCO - Columbus LLC");
    // …while the sheet body honours the hide.
    expect(textOf(def.content)).not.toContain("Account:");
  });

  it("a many-item statement overflows LETTER, repeats its identity, and lands aging + total on the last page", async () => {
    // 60 open items — a clean mid-range fixture, well clear of this fixture's verified boundary
    // counts (77/78 and 122–124), where the raised margin legitimately spills the final Total Due
    // block onto its own page (#102, closed not-reproducible 2026-08-18).
    const openItems = Array.from({ length: 60 }, (_, i) => ({
      documentNumber: `7 - ${72000 + i}`, date: "2026-06-29", dueDate: "2026-06-29", kind: "INVOICE" as const, original: 1000, open: 400,
    }));
    const pdf = await renderPdf(buildStatementDefinition(sampleData({ openItems })));
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
    const pages = drawnPages(pdf);
    expect(pages[0]).not.toContain("(continued)");
    const last = pages[pages.length - 1];
    expect(last).toContain("(continued)");
    // The aging strip and Total Due flow after the open-item table onto the last page.
    expect(last).toContain("Unapplied");
    expect(last).toContain("Total Due");
  });
});

describe("buildStatementDefinition — purity, config included", () => {
  it("a config-driven definition survives the JSON round trip and is deterministic", () => {
    const c = cfg();
    c.logo = { placement: "header-right", width: 80 };
    fieldOf(c, "identity", "customer").label = "Account:";
    c.formats.dateFormat = "YYYY-MM-DD";
    c.formats.negativeStyle = "PARENTHESES";
    c.pageFooter = true;
    const config = checked(c);
    const def = buildStatementDefinition(sampleData(), config, LOGO_URI);
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    expect(buildStatementDefinition(sampleData(), config, LOGO_URI)).toEqual(def);
  });
});

// ================================================================================================
// The print path (spec §5.2): resolve docType STATEMENT on the statement's customer, render the
// resolved config, stamp `templateVersionId`. The statement is CLAIM-FREE by design (no single
// owner row) — resolution runs on the print's own Serializable tx. The preview GET writes NO
// StoredDocument. And the LIVE-REBUILD character is preserved: a data change between two prints
// shows in the second (the mirror image of the invoice's frozen-paper proof).
// ================================================================================================

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `STP${customerSeq}`, name: `Statement Template Customer ${customerSeq}` } });
}

async function makeBillTo(customerId: string, name = "GFMCO - Columbus LLC") {
  return prisma.customerAddress.create({
    data: {
      customerId, kind: "BILL_TO", name, street: "600 12th Street",
      city: "Columbus", state: "GA", zip: "31902-0096", isDefault: true,
    },
  });
}

/** One finalized invoice owned by `customerId`, past-due, with an open balance — enough for the
 *  statement to carry an open item and a nonzero aging/net (the statements.test.ts fixture shape). */
let orderSeq = 0;
async function finalizedInvoice(customerId: string, total: number): Promise<void> {
  orderSeq += 1;
  const order = await prisma.order.create({
    data: {
      orderNumber: 90000 + orderSeq, customerId, status: "SHIPPED",
      receivedDate: new Date("2026-05-01"), requestDate: new Date("2026-05-05"),
    },
  });
  await prisma.invoice.create({
    data: {
      orderId: order.id, customerId, kind: "INVOICE", status: "FINALIZED",
      invoiceDate: new Date("2026-05-10"), dueDate: new Date("2026-05-20"),
      finalizedAt: new Date("2026-05-10"), total,
    },
  });
}

const ASOF = "2026-07-29";

/** Create → tweak the v1 draft → (optionally logo) → publish, for the STATEMENT docType. */
let tplSeq = 0;
async function publishCustom(tweak: (c: TemplateConfig) => void, logo?: { data: Buffer; mime: string }) {
  tplSeq += 1;
  const t = await asSystem(() => createTemplate("STATEMENT", `Custom Statement ${tplSeq}`));
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

describe("printStatement — resolution stamps the STATEMENT version", () => {
  beforeEach(async () => {
    await truncateAll();
    await asSystem(() => setSetting("company_name", "American Heat Treating - Alabama, LLC"));
    await asSystem(() => setSetting("company_address", "3008 Red Morris Parkway\nAnniston AL 36207"));
    await asSystem(() => setSetting("company_phone", "256-835-3370"));
  });

  it("no assignment: resolves the seeded Standard statement and stamps ITS version id", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    await finalizedInvoice(customer.id, 400);
    const { documentId, pdf } = await asSystem(() =>
      printStatement(customer.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: false }));
    expect(drawnText(pdf)).toContain("Statement");
    expect(await stampOf(documentId)).toBe(templateVersionId("STATEMENT"));
  });

  it("a label override prints through the real path and stamps the assigned version", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    await finalizedInvoice(customer.id, 400);
    const tpl = await publishCustom((c) => { fieldOf(c, "total", "total_due").label = "TOTAL-MARKER:"; });
    await asSystem(() => assignTemplate(customer.id, "STATEMENT", tpl.templateId));
    const { documentId, pdf } = await asSystem(() =>
      printStatement(customer.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: false }));
    expect(drawnText(pdf)).toContain("TOTAL-MARKER:");
    expect(await stampOf(documentId)).toBe(tpl.versionId);
  });

  it("the negativeStyle knob formats a credit through the real path", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    await finalizedInvoice(customer.id, 400);
    // A stand-alone finalized credit with an open remaining → a negative Open line on the statement.
    orderSeq += 1;
    const order = await prisma.order.create({
      data: { orderNumber: 95000 + orderSeq, customerId: customer.id, status: "SHIPPED", receivedDate: new Date("2026-05-01"), requestDate: new Date("2026-05-05") },
    });
    await prisma.invoice.create({
      data: {
        orderId: order.id, customerId: customer.id, kind: "CREDIT", status: "FINALIZED",
        invoiceDate: new Date("2026-06-01"), finalizedAt: new Date("2026-06-01"), creditNumber: 5000 + orderSeq,
        total: -200,
      },
    });
    const tpl = await publishCustom((c) => { c.formats.negativeStyle = "PARENTHESES"; });
    await asSystem(() => assignTemplate(customer.id, "STATEMENT", tpl.templateId));
    const { pdf } = await asSystem(() =>
      printStatement(customer.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: false }));
    expect(drawnText(pdf)).toContain("($200.00)");
  });

  it("the pageFooter knob prints per-page numbers; the default prints none", async () => {
    const a = await makeCustomer();
    await makeBillTo(a.id);
    await finalizedInvoice(a.id, 400);
    const tpl = await publishCustom((c) => { c.pageFooter = true; });
    await asSystem(() => assignTemplate(a.id, "STATEMENT", tpl.templateId));
    const withFooter = await asSystem(() =>
      printStatement(a.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: false }));
    expect(drawnText(withFooter.pdf)).toContain("Page 1 of 1");

    const b = await makeCustomer();
    await makeBillTo(b.id);
    await finalizedInvoice(b.id, 400);
    const bare = await asSystem(() =>
      printStatement(b.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: false }));
    expect(drawnText(bare.pdf)).not.toMatch(/Page \d+ of \d+/);
  });

  it("a placed logo prints through the real path; the bare statement paints none", async () => {
    const a = await makeCustomer();
    await makeBillTo(a.id);
    await finalizedInvoice(a.id, 400);
    const tpl = await publishCustom(
      (c) => { c.logo = { placement: "header-left", width: 90 }; },
      { data: await barcodePng("STMTLOGO"), mime: "image/png" });
    await asSystem(() => assignTemplate(a.id, "STATEMENT", tpl.templateId));
    const placed = await asSystem(() =>
      printStatement(a.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: false }));
    expect(paintedImageCounts(placed.pdf)).toEqual([1]);

    const b = await makeCustomer();
    await makeBillTo(b.id);
    await finalizedInvoice(b.id, 400);
    const bare = await asSystem(() =>
      printStatement(b.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: false }));
    expect(paintedImageCounts(bare.pdf)).toEqual([0]);
  });
});

describe("printStatement — the LIVE-REBUILD proof (the OPPOSITE of the invoice's frozen paper)", () => {
  beforeEach(async () => {
    await truncateAll();
    await asSystem(() => setSetting("company_name", "American Heat Treating - Alabama, LLC"));
    await asSystem(() => setSetting("company_address", "3008 Red Morris Parkway\nAnniston AL 36207"));
  });

  it("a live bill-to change between two prints shows in the SECOND print (a statement is rebuilt, not frozen)", async () => {
    const customer = await makeCustomer();
    const addr = await makeBillTo(customer.id, "ORIGINALBILLTO INC");
    await finalizedInvoice(customer.id, 400);

    // First print carries the live bill-to as it stands now.
    const first = await asSystem(() =>
      printStatement(customer.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: false }));
    expect(drawnText(first.pdf)).toContain("ORIGINALBILLTO INC");

    // Change the LIVE default bill-to address AFTER the first print.
    await prisma.customerAddress.update({ where: { id: addr.id }, data: { name: "CHANGEDBILLTO LLC" } });

    // A second print reflects the change — the statement is a fresh rebuild, not frozen paper...
    const second = await asSystem(() =>
      printStatement(customer.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: false }));
    const text = drawnText(second.pdf);
    expect(text).toContain("CHANGEDBILLTO LLC");
    expect(text).not.toContain("ORIGINALBILLTO INC");

    // ...while the FIRST print's STORED bytes are frozen at print time (reissued, never re-rendered).
    const stored = await getDocument(first.documentId);
    expect(Buffer.compare(stored.fileData, first.pdf)).toBe(0);
    expect(drawnText(stored.fileData)).toContain("ORIGINALBILLTO INC");
  });

  it("the preview build (buildStatement) writes NO StoredDocument — it stays side-effect-free", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    await finalizedInvoice(customer.id, 400);
    await asSystem(() => buildStatement(customer.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: false }));
    const docs = await prisma.storedDocument.count({ where: { customerId: customer.id } });
    expect(docs).toBe(0);
  });
});
