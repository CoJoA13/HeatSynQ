import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { setSetting } from "@/server/settings";
import {
  createQuote, closeQuote, deleteQuote, printQuote, readQuotePdfData,
} from "@/server/quotes";
import { buildQuoteDefinition, type QuotePdfData } from "@/server/pdf/quote";
import { renderPdf } from "@/server/pdf/render";
import { getDocument, VOIDED_PRINT } from "@/server/documents";
import type { Content } from "pdfmake/interfaces";
import type { Customer, User } from "../prisma/generated/prisma/client";

import { POST as printRoute } from "@/app/api/quotes/[id]/print/route";
import { GET as quoteDocumentsRoute } from "@/app/api/quotes/[id]/documents/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const postReq = (url: string, cookie?: string) =>
  new Request(url, { method: "POST", headers: cookie ? { cookie } : {} });
const getReq = (url: string, cookie?: string) =>
  new Request(url, { method: "GET", headers: cookie ? { cookie } : {} });

/** Every `text` string anywhere in a document definition, flattened — content pins live on the
 *  DEFINITION, never on rendered bytes (pdfkit writes TTF-subset glyph ids, so a rendered PDF
 *  carries no character text to grep for; the rendered file is pinned STRUCTURALLY instead).
 *  Copied from tests/invoice-pdf.test.ts (copying across test files is this repo's convention).
 *  Functions (the quote's footer page callback — spec §6 sanctions the code-rendered layout) are
 *  simply not traversed; the callback's own output is pinned separately below. */
function allText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  if (typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) allText(value, out);
  }
  return out;
}

/** The PDF's own page count, off its `/Type /Pages /Count N` object — the structural pin a fresh
 *  render CAN carry (CLAUDE.md: renderPdf is not byte-deterministic, so fresh renders are never
 *  Buffer.compare'd). Copied from tests/traveler.test.ts. */
function pageCount(pdf: Buffer): number {
  const match = pdf.toString("latin1").match(/\/Type\s*\/Pages[^>]*\/Count\s+(\d+)/);
  if (!match) throw new Error("Could not find a /Type /Pages /Count marker in the rendered PDF");
  return Number(match[1]);
}

// -------------------------------------------------------------------------------------------
// Fixtures — copied in shape from tests/quotes.test.ts / tests/invoice-pdf.test.ts.
// -------------------------------------------------------------------------------------------

let seq = 0;
async function makeCustomer(withTerms = true): Promise<Customer> {
  seq += 1;
  const terms = withTerms
    ? await prisma.terms.create({ data: { name: "Net 30", netDays: 30 } })
    : null;
  return prisma.customer.create({
    data: { code: `QPD${seq}`, name: `Robertson Tractor Parts ${seq}`, termsId: terms?.id ?? null },
  });
}

async function makeBillTo(customerId: string) {
  return prisma.customerAddress.create({
    data: {
      customerId, kind: "BILL_TO", name: "", street: "350 Second Street",
      city: "Chicago", state: "IL", zip: "12345", isDefault: true,
    },
  });
}

async function makeContact(customerId: string) {
  return prisma.customerContact.create({
    data: { customerId, name: "Curtis", phone: "123.456.7894" },
  });
}

async function makeQuotedBy(title = "V.P. Sales"): Promise<User> {
  seq += 1;
  return prisma.user.create({
    data: { username: `sales${seq}`, displayName: "Mr. Johnathen Smith", passwordHash: "x", title },
  });
}

async function makeStep(name: string) {
  seq += 1;
  return prisma.processStepCode.create({ data: { code: `QS${seq}`, name } });
}

/** Loose payload line for `createQuote` — the service zod-parses `unknown`, so the fixture only
 *  needs a shape TypeScript will pass through. */
type LineOverride = Record<string, unknown>;

/** One quote shaped after the sample: free-text part, qty 100 at 10 lb each, one EACH row
 *  (0.15 / min 100 / setup 2 — the minimum-floor case: 100 × $0.15 = $15 → floor $100 → + $2). */
async function sampleFixture(opts: { lines?: LineOverride[]; title?: string } = {}) {
  await asSystem(() => setSetting("company_name", "CSI Support Inc."));
  await asSystem(() => setSetting("company_address", "14th Street\nCrystal Lake IL 60014"));
  await asSystem(() => setSetting("company_phone", "111.111.1111"));
  const customer = await makeCustomer();
  await makeBillTo(customer.id);
  const contact = await makeContact(customer.id);
  const quotedBy = await makeQuotedBy(opts.title ?? "V.P. Sales");
  const step = await makeStep("Bake");
  const lines = opts.lines ?? [{
    partNumberText: "Customer Part ID", partNameText: "Customer part name",
    partDescriptionText: "Description of Part", materialText: "Customer Material",
    eachWeight: "10", quotedQty: 100,
    prices: [{
      processStepCodeId: step.id, setupCharge: "2.00", unitPrice: "0.1500",
      minimumCharge: "100.00", pricePer: "EACH", notes: "Quote Notes",
    }],
  }];
  const quote = await asSystem(() => createQuote({
    customerId: customer.id, contactId: contact.id, rfqNumber: "12345",
    quotedById: quotedBy.id, notes: "Our terms are net 30",
    lines,
  }));
  return { quote, customer, contact, quotedBy, step };
}

/** A hand-built QuotePdfData carrying the owner sample's demo content, for the pure-builder
 *  assertions (the invoice-pdf sampleData shape). */
function sampleData(overrides: Partial<QuotePdfData> = {}): QuotePdfData {
  return {
    company: { name: "CSI Support Inc.", address: "14th Street\nCrystal Lake IL 60014", phone: "111.111.1111" },
    quoteNumber: 1006,
    effectiveDate: "2018-06-30",
    expiryDate: "2018-07-10",
    termsName: "Net 30",
    rfqNumber: "12345",
    attn: "Curtis",
    customerPhone: "123.456.7894",
    billTo: ["Jane's Department", "Robertson Tractor Parts", "350 Second Street", "Chicago, IL 12345"],
    introText: "We are pleased to provide you with the following quotation:",
    lines: [{
      quotedQty: 100, quotedUnlimited: false,
      partNumber: "Customer Part ID", partName: "Customer part name",
      partDescription: "Description of Part",
      eachWeight: 10, totalLbs: 1000, material: "Customer Material",
      prices: [
        {
          stepName: "Bake", notes: "Quote Notes", setupCharge: 2, unitPrice: 0.15,
          minimumCharge: 100, pricePerLabel: "Each", breaks: [], amount: 102,
        },
        {
          stepName: "Certification", notes: "", setupCharge: null, unitPrice: 20,
          minimumCharge: null, pricePerLabel: "Lot (flat)", breaks: [], amount: 20,
        },
      ],
    }],
    endingStatementText: "Ending Statement from Quote Control",
    notes: "Our terms are net 30",
    liabilityText: "You can add a limited Liability Statement here.",
    signer: { name: "Mr. Johnathen Smith", title: "V.P. Sales" },
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------
// The builder — pure (data in, definition out), built to docs/samples/Quote_Sample_Form.jpeg
// (spec §6). NOT plain JSON: the footer page callback is spec-sanctioned ("the quote render is
// code, not a Phase 7 JSON template"), so there is no JSON-round-trip purity test here.
// -------------------------------------------------------------------------------------------

describe("buildQuoteDefinition", () => {
  it("prints the sample's header, right block, Attn block and intro line", () => {
    const text = allText(buildQuoteDefinition(sampleData())).join(" ");
    expect(text).toContain("Quotation");
    expect(text).toContain("CSI Support Inc.");
    expect(text).toContain("14th Street");
    expect(text).toContain("Crystal Lake IL 60014");
    expect(text).toContain("Quotation Number: ");
    expect(text).toContain("1006");
    expect(text).toContain("Phone: ");                       // the company's own (settings)
    expect(text).toContain("111.111.1111");
    expect(text).toContain("Effective: ");
    expect(text).toContain("06/30/2018");
    expect(text).toContain("Expires On: ");
    expect(text).toContain("07/10/2018");
    expect(text).toContain("Terms: ");
    expect(text).toContain("Net 30");
    expect(text).toContain("Your R.F.Q. Number: ");
    expect(text).toContain("12345");
    expect(text).toContain("Your Phone No.: ");              // the contact's, where the model has one
    expect(text).toContain("123.456.7894");
    expect(text).toContain("Attn: ");
    expect(text).toContain("Curtis");
    expect(text).toContain("Robertson Tractor Parts");
    expect(text).toContain("350 Second Street");
    expect(text).toContain("Chicago, IL 12345");
    expect(text).toContain("We are pleased to provide you with the following quotation:");
  });

  it("prints the line grid and the price section in 5A vocabulary with engine amounts", () => {
    const text = allText(buildQuoteDefinition(sampleData())).join(" ");
    expect(text).toContain("Quantity");
    expect(text).toContain("Part No. / Description / Pricing Information");
    expect(text).toContain("Each weight");
    expect(text).toContain("Total Lbs / Price");
    expect(text).toContain("100");
    expect(text).toContain("Customer Part ID");
    expect(text).toContain("Customer part name");
    expect(text).toContain("Description of Part");
    expect(text).toContain("10.00");                          // each weight
    expect(text).toContain("1,000.00");                       // total lbs = qty × each weight
    expect(text).toContain("Material: ");
    expect(text).toContain("Customer Material");
    expect(text).toContain("PRICE");
    expect(text).toContain("Bake");
    expect(text).toContain("Quote Notes");
    // 5A vocabulary in the sample's own arrangement (spec §6) — NOT the sample's VS labels
    // ("Furnace Charge" / "Flat rate charge of").
    expect(text).toContain("Setup charge:");
    expect(text).toContain("$2.00");
    expect(text).toContain("Plus");
    expect(text).toContain("Price per Each:");
    expect(text).toContain("$0.15");
    expect(text).toContain("Or");
    expect(text).toContain("Minimum charge:");
    expect(text).toContain("$100.00");
    expect(text).toContain("$102.00");                        // engine amount: max(15, 100) + 2
    expect(text).toContain("Certification");
    expect(text).toContain("Price per Lot (flat):");
    expect(text).toContain("$20.00");
    expect(text).not.toContain("Furnace Charge");
  });

  it("prints the footer blocks: ending statement, notes, liability text and the signature", () => {
    const text = allText(buildQuoteDefinition(sampleData())).join(" ");
    expect(text).toContain("Ending Statement from Quote Control");
    expect(text).toContain("Our terms are net 30");
    expect(text).toContain("You can add a limited Liability Statement here.");
    expect(text).toContain("Mr. Johnathen Smith");
    expect(text).toContain("V.P. Sales");
  });

  it("renders 'Page: N of M' through the footer page callback (spec §6 — code-rendered layout)", () => {
    const def = buildQuoteDefinition(sampleData());
    const footer = def.footer as (current: number, total: number) => Content;
    expect(typeof footer).toBe("function");
    expect(allText(footer(2, 5)).join(" ")).toContain("Page: 2 of 5");
  });

  it("prints 'Unlimited' for an unlimited line and omits its amounts", () => {
    const data = sampleData();
    data.lines[0] = {
      ...data.lines[0], quotedQty: null, quotedUnlimited: true, totalLbs: null,
      prices: data.lines[0].prices.map((p) => ({ ...p, amount: null })),
    };
    const text = allText(buildQuoteDefinition(data)).join(" ");
    expect(text).toContain("Unlimited");
    // The engine AMOUNT is omitted; the price DETAILS (unit/minimum/setup) still describe the
    // agreement — an unlimited quote still states its prices, it just extends nothing.
    expect(text).not.toContain("$102.00");
    expect(text).toContain("Price per Each:");
  });

  it("lists break rows beneath the price details", () => {
    const data = sampleData();
    data.lines[0].prices[0] = {
      ...data.lines[0].prices[0], breaks: [{ threshold: 500, price: 0.12 }],
    };
    const text = allText(buildQuoteDefinition(data)).join(" ");
    expect(text).toContain("500 or more:");
    expect(text).toContain("$0.12");
  });

  it("omits blank optional pieces: no attn, no phone, no RFQ value, blank title prints nothing", () => {
    const text = allText(buildQuoteDefinition(sampleData({
      attn: "", customerPhone: "", rfqNumber: "",
      signer: { name: "Mr. Johnathen Smith", title: "" },
      endingStatementText: "", notes: "", liabilityText: "",
    }))).join(" ");
    expect(text).not.toContain("Attn: ");
    expect(text).not.toContain("Your Phone No.: ");
    expect(text).toContain("Your R.F.Q. Number: ");           // label stays, value blank (the cert's label rule)
    expect(text).toContain("Mr. Johnathen Smith");
    expect(text).not.toContain("V.P. Sales");
    expect(text).not.toContain("Ending Statement from Quote Control");
  });

  it("renders to a real single-page PDF (structural pin — never Buffer.compare on fresh renders)", async () => {
    const pdf = await renderPdf(buildQuoteDefinition(sampleData()));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pageCount(pdf)).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------
// The real data path — the collector feeds the builder off the live quote, with indicative
// amounts computed through the REAL engine (priceOrder with a synthetic line — no second
// pricing formula).
// -------------------------------------------------------------------------------------------

describe("readQuotePdfData", () => {
  beforeEach(truncateAll);

  it("assembles company/terms/attn/bill-to/intro and the engine's minimum-floor amount to the cent", async () => {
    const { quote, customer } = await sampleFixture();
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.company).toEqual({
      name: "CSI Support Inc.", address: "14th Street\nCrystal Lake IL 60014", phone: "111.111.1111",
    });
    expect(data.quoteNumber).toBe(quote.quoteNumber);
    expect(data.termsName).toBe("Net 30");
    expect(data.rfqNumber).toBe("12345");
    expect(data.attn).toBe("Curtis");
    expect(data.customerPhone).toBe("123.456.7894");
    expect(data.billTo).toEqual([customer.name, "350 Second Street", "Chicago, IL 12345"]);
    expect(data.introText).toBe("We are pleased to provide you with the following quotation:");
    expect(data.signer).toEqual({ name: "Mr. Johnathen Smith", title: "V.P. Sales" });
    const [line] = data.lines;
    expect(line.partNumber).toBe("Customer Part ID");
    expect(line.eachWeight).toBe(10);
    expect(line.totalLbs).toBe(1000);
    expect(line.material).toBe("Customer Material");
    // The engine's own math (pricing.ts ruling 13): extended 100 × $0.15 = $15.00, floored to the
    // $100 minimum, setup $2 on TOP — $102.00, to the cent.
    expect(line.prices[0]).toMatchObject({
      stepName: "Bake", notes: "Quote Notes", setupCharge: 2, unitPrice: 0.15,
      minimumCharge: 100, pricePerLabel: "Each", amount: 102,
    });
  });

  it("selects the qualifying break through the engine (the break case, to the cent)", async () => {
    await asSystem(() => setSetting("company_name", "CSI Support Inc."));
    const customer = await makeCustomer();
    const quotedBy = await makeQuotedBy();
    const step = await makeStep("Bake");
    const quote = await asSystem(() => createQuote({
      customerId: customer.id, quotedById: quotedBy.id,
      lines: [{
        partNumberText: "BRK-1", quotedQty: 500,
        prices: [{
          processStepCodeId: step.id, unitPrice: "0.1500", minimumCharge: "50.00", pricePer: "EACH",
          breaks: [{ threshold: "500.00", price: "0.1200" }],
        }],
      }],
    }));
    const data = await readQuotePdfData(prisma, quote.id);
    // 500 hits the 500-threshold break: 500 × $0.12 = $60.00 (above the $50 floor, no setup).
    expect(data.lines[0].prices[0].amount).toBe(60);
    expect(data.lines[0].prices[0].breaks).toEqual([{ threshold: 500, price: 0.12 }]);
  });

  it("computes an LB row over qty × each-weight, and omits its amount when weight is unknown", async () => {
    await asSystem(() => setSetting("company_name", "CSI Support Inc."));
    const customer = await makeCustomer();
    const quotedBy = await makeQuotedBy();
    const step = await makeStep("Stress Relieve");
    const withWeight = await asSystem(() => createQuote({
      customerId: customer.id, quotedById: quotedBy.id,
      lines: [{
        partNumberText: "LB-1", quotedQty: 100, eachWeight: "10",
        prices: [{ processStepCodeId: step.id, unitPrice: "0.0550", pricePer: "LB" }],
      }],
    }));
    // 100 pcs × 10 lb = 1,000 lb × $0.055/lb = $55.00.
    const dataW = await readQuotePdfData(prisma, withWeight.id);
    expect(dataW.lines[0].totalLbs).toBe(1000);
    expect(dataW.lines[0].prices[0].amount).toBe(55);

    const noWeight = await asSystem(() => createQuote({
      customerId: customer.id, quotedById: quotedBy.id,
      lines: [{
        partNumberText: "LB-2", quotedQty: 100,
        prices: [{ processStepCodeId: step.id, unitPrice: "0.0550", pricePer: "LB" }],
      }],
    }));
    const dataN = await readQuotePdfData(prisma, noWeight.id);
    expect(dataN.lines[0].totalLbs).toBeNull();
    expect(dataN.lines[0].prices[0].amount).toBeNull();       // LB basis unknown — omitted, never $0
  });

  it("omits every amount for unlimited and no-qty lines", async () => {
    await asSystem(() => setSetting("company_name", "CSI Support Inc."));
    const customer = await makeCustomer();
    const quotedBy = await makeQuotedBy();
    const step = await makeStep("Bake");
    const quote = await asSystem(() => createQuote({
      customerId: customer.id, quotedById: quotedBy.id,
      lines: [
        {
          partNumberText: "UNL-1", quotedUnlimited: true, eachWeight: "10",
          prices: [{ processStepCodeId: step.id, unitPrice: "0.1500", pricePer: "EACH" }],
        },
        {
          partNumberText: "NOQ-1", eachWeight: "10",
          prices: [{ processStepCodeId: step.id, unitPrice: "0.1500", pricePer: "EACH" }],
        },
      ],
    }));
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.lines[0].quotedUnlimited).toBe(true);
    expect(data.lines[0].prices[0].amount).toBeNull();
    expect(data.lines[1].quotedQty).toBeNull();
    expect(data.lines[1].prices[0].amount).toBeNull();
  });

  it("reads a part-linked line's identity live from the part", async () => {
    await asSystem(() => setSetting("company_name", "CSI Support Inc."));
    const customer = await makeCustomer();
    const quotedBy = await makeQuotedBy();
    const material = await prisma.material.create({ data: { name: "Ductile Iron" } });
    const part = await prisma.part.create({
      data: {
        customerId: customer.id, partNumber: "A16-21591-000", name: "EQUALIZER-RR SUSP",
        eachWeight: "21.0000", materialId: material.id,
      },
    });
    const quote = await asSystem(() => createQuote({
      customerId: customer.id, quotedById: quotedBy.id,
      lines: [{ partId: part.id, quotedQty: 144, prices: [] }],
    }));
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.lines[0]).toMatchObject({
      partNumber: "A16-21591-000", partName: "EQUALIZER-RR SUSP",
      material: "Ductile Iron", eachWeight: 21, totalLbs: 3024,
    });
  });

  it("prints notes but never internal notes, and carries the ending statement text", async () => {
    await asSystem(() => setSetting("company_name", "CSI Support Inc."));
    await prisma.endingStatement.create({
      data: { name: "Standard", text: "Ending Statement from Quote Control", isDefault: true },
    });
    const customer = await makeCustomer();
    const quotedBy = await makeQuotedBy();
    const quote = await asSystem(() => createQuote({
      customerId: customer.id, quotedById: quotedBy.id,
      notes: "PUBLIC-QUOTE-NOTES", internalNotes: "SECRET-INTERNAL-STRING",
      lines: [{ partNumberText: "N-1", prices: [] }],
    }));
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.endingStatementText).toBe("Ending Statement from Quote Control");
    expect(data.notes).toBe("PUBLIC-QUOTE-NOTES");
    expect(JSON.stringify(data)).not.toContain("SECRET-INTERNAL-STRING");
    const text = allText(buildQuoteDefinition(data)).join(" ");
    expect(text).toContain("PUBLIC-QUOTE-NOTES");
    expect(text).not.toContain("SECRET-INTERNAL-STRING");
  });
});

// -------------------------------------------------------------------------------------------
// printQuote — render, archive (kind QUOTE), stored-byte reprints (spec §6; the printInvoice
// precedent, claim + archive in one Serializable transaction).
// -------------------------------------------------------------------------------------------

describe("printQuote", () => {
  beforeEach(truncateAll);

  it("archives kind QUOTE against the quote and reprints the identical stored bytes", async () => {
    const { quote } = await sampleFixture();
    const first = await asSystem(() => printQuote(quote.id));
    const stored = await getDocument(first.documentId);
    expect(stored.kind).toBe("QUOTE");
    expect(stored.quoteId).toBe(quote.id);
    expect(stored.invoiceId).toBeNull();
    expect(Buffer.compare(stored.fileData, first.pdf)).toBe(0);   // STORED bytes — exact by design

    // A reprint is a byte-for-byte reissue of the STORED bytes, never a re-render.
    const reprint = await getDocument(first.documentId);
    expect(Buffer.compare(reprint.fileData, first.pdf)).toBe(0);
  });

  it("keeps no byte in the audit payload", async () => {
    const { quote } = await sampleFixture();
    const printed = await asSystem(() => printQuote(quote.id));
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "storedDocument", entityId: printed.documentId },
    });
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry!.after)).not.toContain("fileData");
    expect(JSON.stringify(entry!.after)).not.toContain("%PDF");
  });

  it("still prints a CLOSED quote — closing forbids edits, not the paper", async () => {
    const { quote } = await sampleFixture();
    await asSystem(() => closeQuote(quote.id, "won the business"));
    const printed = await asSystem(() => printQuote(quote.id));
    expect(printed.pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("refuses a new print on a deleted quote, keeping stored prints downloadable", async () => {
    const { quote } = await sampleFixture();
    const printed = await asSystem(() => printQuote(quote.id));
    await asSystem(() => deleteQuote(quote.id, "typo"));
    await expect(asSystem(() => printQuote(quote.id))).rejects.toThrow(VOIDED_PRINT);
    await expect(getDocument(printed.documentId)).resolves.toBeTruthy();
  });

  it("404s a quote that does not exist", async () => {
    await expect(asSystem(() => printQuote("nope"))).rejects.toThrow(/not found/i);
  });
});

// -------------------------------------------------------------------------------------------
// POST /api/quotes/[id]/print — gate quotes.view (spec §6; the traveler/cert/invoice print-route
// precedent: printing changes nothing about the quote beyond the audited archive of its own
// output, an explicit POST so "reads never mutate" holds).
// -------------------------------------------------------------------------------------------

describe("POST /api/quotes/[id]/print", () => {
  beforeEach(truncateAll);

  it("401s without a session", async () => {
    const { quote } = await sampleFixture();
    const res = await printRoute(postReq(`http://t/api/quotes/${quote.id}/print`), withParams({ id: quote.id }));
    expect(res.status).toBe(401);
  });

  it("requires quotes.view", async () => {
    const { quote } = await sampleFixture();
    const cookie = await signInWith(["orders.view"]);
    const res = await printRoute(postReq(`http://t/api/quotes/${quote.id}/print`, cookie), withParams({ id: quote.id }));
    expect(res.status).toBe(403);
  });

  it("streams the quote PDF with a friendly filename and archives it", async () => {
    const { quote } = await sampleFixture();
    const cookie = await signInWith(["quotes.view"]);
    const res = await printRoute(postReq(`http://t/api/quotes/${quote.id}/print`, cookie), withParams({ id: quote.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="quote-${quote.quoteNumber}.pdf"`);
    const documentId = res.headers.get("x-document-id")!;
    const stored = await getDocument(documentId);
    expect(stored.kind).toBe("QUOTE");
    expect(Buffer.compare(stored.fileData, Buffer.from(await res.arrayBuffer()))).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// GET /api/quotes/[id]/documents — the quote page's own stored-documents list, at EXACTLY the
// path Task 8 wired (its 404→empty-state becomes this live list). Gate quotes.view — the
// certs/invoices documents-route precedent: the only kind `listDocumentsForQuote` can return
// sits behind the SAME `quotes` area this route gates on (AREA_FOR_KIND.QUOTE), so no
// cross-kind union or per-kind filter is needed the way the order hub's route needs one.
// -------------------------------------------------------------------------------------------

describe("GET /api/quotes/[id]/documents", () => {
  beforeEach(truncateAll);

  it("401s without a session", async () => {
    const { quote } = await sampleFixture();
    const res = await quoteDocumentsRoute(
      getReq(`http://t/api/quotes/${quote.id}/documents`), withParams({ id: quote.id }));
    expect(res.status).toBe(401);
  });

  it("requires quotes.view, and lists only this quote's own printed documents", async () => {
    const { quote } = await sampleFixture();
    const printed = await asSystem(() => printQuote(quote.id));

    const wrong = await signInWith(["orders.view"], "quote-docs-wrong-1");
    const forbidden = await quoteDocumentsRoute(
      getReq(`http://t/api/quotes/${quote.id}/documents`, wrong), withParams({ id: quote.id }));
    expect(forbidden.status).toBe(403);

    const viewer = await signInWith(["quotes.view"], "quote-docs-view-1");
    const ok = await quoteDocumentsRoute(
      getReq(`http://t/api/quotes/${quote.id}/documents`, viewer), withParams({ id: quote.id }));
    expect(ok.status).toBe(200);
    const docs = await ok.json() as { id: string; kind: string }[];
    expect(docs).toEqual([expect.objectContaining({ id: printed.documentId, kind: "QUOTE" })]);
  });

  it("404s an unknown quote, and keeps a deleted quote's prints listable", async () => {
    const { quote } = await sampleFixture();
    const printed = await asSystem(() => printQuote(quote.id));
    await asSystem(() => deleteQuote(quote.id, "typo"));
    const viewer = await signInWith(["quotes.view"]);

    const missing = await quoteDocumentsRoute(
      getReq("http://t/api/quotes/nope/documents", viewer), withParams({ id: "nope" }));
    expect(missing.status).toBe(404);

    // The voided-owner rule (spec §5.6): stored paper stays listable and downloadable forever.
    const ok = await quoteDocumentsRoute(
      getReq(`http://t/api/quotes/${quote.id}/documents`, viewer), withParams({ id: quote.id }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual([expect.objectContaining({ id: printed.documentId })]);
  });
});
