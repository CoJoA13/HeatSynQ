import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, templateVersionId } from "./helpers/db";
import { drawnPages, drawnText, pageCount, paintedImageCounts } from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import {
  createCert, printCert, type CertDetail,
} from "@/server/certs";
import { replaceReadings } from "@/server/cert-results";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { barcodePng, renderPdf } from "@/server/pdf/render";
import { buildCertDefinition, type CertPdfData } from "@/server/pdf/cert";
import { CERT_DEFAULT_CONFIG, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import type { Customer, User } from "../prisma/generated/prisma/client";

/**
 * Phase 7 Task 11 — the cert conversion: `buildCertDefinition` becomes a config-consumer (spec
 * §5.4/§5.6). `cert_statement` binds through the DATA SEAM (the ticket's shape, not the BOL's):
 * certs.ts already reads the Setting into `CertPdfData.statement`, so the config's block is
 * injected at that seam in `printCert` — the builder keeps reading `input.statement`, and the
 * §3.21 type-level exclusion on `CertPdfData` (no min/max/pass-fail/override) is preserved.
 *
 * THE DATE KNOB HAS NO STYLE TRAP HERE (the ticket's two-date-styles rule, generalized): the
 * builder was grepped for every date call before mapping — `paddedDate` is the sole date renderer,
 * called on the Date and Entry Date header slots ONLY, both printing MM/DD/YYYY — so the
 * contract's single knob maps to those two same-style slots directly.
 */

// ------------------------------------------------------------------------------------------------
// Pure fixtures — the golden suite's sampleCert, kept value-distinctive.
// ------------------------------------------------------------------------------------------------

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64");

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
    requirements: [{
      lineIdentity: "line-1", linePosition: 1, partNumber: "500031-HT", partName: "Track Shoe, Vehicular",
      specification: "Were heat treated as per P.O. NONE", scale: "HRC",
      readings: [28, 30, 29, 30, 29, 30.1, 29.7, 25.6, 27.1],
    }],
    serialBlocks: [{ partNumber: "500031-HT", serials: [{ serial: "SN-0001", description: "Heat A1" }] }],
    freeform: "FREEFORM BLOCK UNDER TEST",
    signer: { name: "Colton Jones", title: "", company: "American Heat Treating - Alabama, LLC", signatureDataUri: `data:image/png;base64,${TINY_PNG.toString("base64")}` },
    ...overrides,
  };
}

/** A hand-built multi-part cert — two parts, each with its own requirement (ruling 27 grouping). */
function twoPartCert(overrides: Partial<CertPdfData> = {}): CertPdfData {
  return sampleCert({
    parts: [
      { qty: 100, partNumber: "PART-A", partName: "Part A", partDescription: "DA", pounds: 200 },
      { qty: 100, partNumber: "PART-B", partName: "Part B", partDescription: "DB", pounds: 200 },
    ],
    requirements: [
      { lineIdentity: "line-A", linePosition: 1, partNumber: "PART-A", partName: "Part A", specification: "Were heat treated as per P.O. NONE", scale: "HRC", readings: [30, 31, 29] },
      { lineIdentity: "line-B", linePosition: 2, partNumber: "PART-B", partName: "Part B", specification: "Were heat treated as per P.O. NONE", scale: "HRC", readings: [28, 27, 29] },
    ],
    ...overrides,
  });
}

const cfg = (): TemplateConfig => structuredClone(CERT_DEFAULT_CONFIG);
/** Round-trips a tweaked config through the REAL validator — every config a test feeds the
 *  builder (the raw omission-belt shapes excepted, deliberately) is one a template could store. */
const checked = (c: TemplateConfig): TemplateConfig => validateConfig("CERT", c);
const sectionOf = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
const fieldOf = (c: TemplateConfig, section: string, key: string) =>
  sectionOf(c, section).fields.find((f) => f.key === key)!;

/** Every `text` string/number in a definition, flattened — the golden suite's walker (skips
 *  `image` so a data-URI never pollutes a text assertion). */
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

// ------------------------------------------------------------------------------------------------
// Config-driven sections, fields, labels, widths.
// ------------------------------------------------------------------------------------------------

describe("buildCertDefinition — config-driven", () => {
  it("a label override prints in place of the contract default", () => {
    const c = cfg();
    fieldOf(c, "header", "title").label = "HEAT CERTIFICATE";
    fieldOf(c, "parties", "po_number").label = "PO Number:";
    const text = textOf(buildCertDefinition(sampleCert(), checked(c)));
    expect(text).toContain("HEAT CERTIFICATE");
    expect(text).not.toContain("Certification");
    expect(text).toContain("PO Number: PT24115");
    expect(text).not.toContain("Purchase Order No.:");
  });

  it("a width override lands in the parts table's widths array", () => {
    const c = cfg();
    fieldOf(c, "parts", "part_pounds").width = 120;
    const def = buildCertDefinition(sampleCert(), checked(c));
    expect(allWidths(def)).toContainEqual([70, "*", 120]);
  });

  it("a hidden section is omitted from the stack", () => {
    const c = cfg();
    sectionOf(c, "serials").visible = false;
    const text = textOf(buildCertDefinition(sampleCert(), checked(c)));
    expect(text).not.toContain("Serial Numbers");
    expect(text).not.toContain("SN-0001");
    // …the default config still prints them.
    const dflt = textOf(buildCertDefinition(sampleCert()));
    expect(dflt).toContain("Serial Numbers");
    expect(dflt).toContain("SN-0001");
  });

  it("a hidden field drops its parts column — header cell and width both", () => {
    const c = cfg();
    fieldOf(c, "parts", "part_pounds").visible = false;
    const def = buildCertDefinition(sampleCert(), checked(c));
    expect(textOf(def)).not.toContain("Pounds");
    expect(allWidths(def)).toContainEqual([70, "*"]);
  });

  it("a hidden non-column field drops from its block", () => {
    const c = cfg();
    fieldOf(c, "parties", "packing_list_no").visible = false;
    const text = textOf(buildCertDefinition(sampleCert(), checked(c)));
    expect(text).not.toContain("Packing List No.:");
    expect(text).not.toContain("072826");
    expect(text).toContain("Material: steel"); // its sibling survives
  });

  it("stack order follows the config's section order", () => {
    const c = cfg();
    const i = c.sections.findIndex((s) => s.key === "serials");
    const j = c.sections.findIndex((s) => s.key === "freeform");
    [c.sections[i], c.sections[j]] = [c.sections[j], c.sections[i]];
    const text = textOf(buildCertDefinition(sampleCert(), checked(c)));
    expect(text.indexOf("FREEFORM BLOCK UNDER TEST")).toBeLessThan(text.indexOf("Serial Numbers"));
    // …the default order is the other way around.
    const dflt = textOf(buildCertDefinition(sampleCert()));
    expect(dflt.indexOf("Serial Numbers")).toBeLessThan(dflt.indexOf("FREEFORM BLOCK UNDER TEST"));
  });

  it("field order follows the config WITHIN the header's order-fields slot", () => {
    const c = cfg();
    const header = sectionOf(c, "header");
    const entry = header.fields.find((f) => f.key === "entry_date")!;
    header.fields = [entry, ...header.fields.filter((f) => f.key !== "entry_date")];
    const text = textOf(buildCertDefinition(sampleCert(), checked(c)));
    expect(text.indexOf("Entry Date:")).toBeLessThan(text.indexOf("Order No.:"));
    // The title slot is untouched — fields never migrate between the hand-laid slots.
    expect(text.indexOf("Certification")).toBeLessThan(text.indexOf("Order No.:"));
  });
});

// ------------------------------------------------------------------------------------------------
// Fonts and number formats.
// ------------------------------------------------------------------------------------------------

describe("buildCertDefinition — fonts and number formats", () => {
  it("family, base size and role sizes map into the definition", () => {
    const c = cfg();
    c.fonts = { family: "Liberation Serif", baseSize: 8, headingSize: 22, smallSize: 5 };
    const def = buildCertDefinition(sampleCert(), checked(c));
    expect(def.defaultStyle).toEqual({ font: "Liberation Serif", fontSize: 8 });
    // headingSize drives the "Certification" title; smallSize the footer strip's fine print.
    expect(findNodes(def, (n) => n.text === "Certification")[0].fontSize).toBe(22);
    expect(findNodes(def, (n) => n.text === "3008 Red Morris Parkway  Anniston  AL  36207")[0].fontSize).toBe(5);
    // …the default keeps today's literals.
    const dflt = buildCertDefinition(sampleCert());
    expect(dflt.defaultStyle).toEqual({ font: "Roboto", fontSize: 9 });
    expect(findNodes(dflt, (n) => n.text === "Certification")[0].fontSize).toBe(19);
  });

  it("thousandsSeparator: false ungroups the parts' quantity and pounds", () => {
    const c = cfg();
    c.formats.thousandsSeparator = false;
    const big = sampleCert({ parts: [{ qty: 4128, partNumber: "X", partName: "Y", partDescription: "", pounds: 11415 }] });
    const text = textOf(buildCertDefinition(big, checked(c)));
    expect(text).toContain("4128");
    expect(text).toContain("11415");
    expect(text).not.toContain("4,128");
    const dflt = textOf(buildCertDefinition(big));
    expect(dflt).toContain("4,128");
    expect(dflt).toContain("11,415");
  });
});

// ------------------------------------------------------------------------------------------------
// The date knob — ONE printed style on this paper (paddedDate's two call sites, the Date and
// Entry Date header slots, BOTH MM/DD/YYYY; grep-verified before mapping). The knob drives both.
// ------------------------------------------------------------------------------------------------

describe("buildCertDefinition — the date knob maps to the two same-style header slots", () => {
  it.each([
    ["M/D/YYYY", "8/3/2026", "7/29/2026"],
    ["MM/DD/YYYY", "08/03/2026", "07/29/2026"],
    ["YYYY-MM-DD", "2026-08-03", "2026-07-29"],
    ["MMMM D, YYYY", "August 3, 2026", "July 29, 2026"],
    ["MMM - DD - YYYY", "Aug - 03 - 2026", "Jul - 29 - 2026"],
  ])("renders both header dates as %s", (format, printDate, entryDate) => {
    const c = cfg();
    c.formats.dateFormat = format as TemplateConfig["formats"]["dateFormat"];
    const text = textOf(buildCertDefinition(sampleCert(), checked(c)));
    expect(text).toContain(`Date: ${printDate}`);
    expect(text).toContain(`Entry Date: ${entryDate}`);
  });

  it("defaults to the sample's MM/DD/YYYY style", () => {
    const text = textOf(buildCertDefinition(sampleCert()));
    expect(text).toContain("Date: 08/03/2026");
    expect(text).toContain("Entry Date: 07/29/2026");
  });
});

// ------------------------------------------------------------------------------------------------
// The §5.6 belt, both halves. The CERT contract locks NOTHING, so the flag half's observable duty
// is the NEGATIVE direction — the belt must not force visible what the contract allows hiding —
// and the omission half (completeSections) must re-materialize entries a raw config drops.
// ------------------------------------------------------------------------------------------------

describe("buildCertDefinition — the §5.6 belt", () => {
  it("nothing on this contract is locked: a validated config may hide ANY section and the builder honors it", () => {
    const c = cfg();
    sectionOf(c, "statement").visible = false;
    sectionOf(c, "signature").visible = false;
    const validated = checked(c); // accepted — contrast with the traveler's locked refusals
    const text = textOf(buildCertDefinition(sampleCert(), validated));
    expect(text).not.toContain("We certify that the listed Parts / Materials");
    expect(text).not.toContain("Colton Jones");
  });

  it("a raw config OMITTING the parts section entry still renders it (the omission half)", () => {
    const c = cfg();
    c.sections = c.sections.filter((s) => s.key !== "parts");
    const text = textOf(buildCertDefinition(sampleCert(), c));
    expect(text).toContain("Part Number  /  Part Name  /  Part Description");
    expect(text).toContain("500031-HT");
  });

  it("a raw config OMITTING a field entry inside a present section still renders it", () => {
    const c = cfg();
    const parties = sectionOf(c, "parties");
    parties.fields = parties.fields.filter((f) => f.key !== "material");
    const text = textOf(buildCertDefinition(sampleCert(), c));
    expect(text).toContain("Material: steel");
  });
});

// ------------------------------------------------------------------------------------------------
// The §3.21 type-level exclusion survives conversion — a config can only REARRANGE what the data
// layer collects, and `CertPdfData` never collects min/max/pass-fail/override. Even a fully
// re-labelled config over a cert whose reading FAILS its band prints no verdict furniture.
// ------------------------------------------------------------------------------------------------

describe("buildCertDefinition — §3.21 exclusion is structural, config cannot widen it", () => {
  it("no config surface can bind min, max, scale column, pass/fail or override", () => {
    const c = cfg();
    for (const s of c.sections) for (const f of s.fields) if (f.label !== null) continue;
    // Re-label every field that carries one; the failing 25.6 reading is in the sample.
    fieldOf(c, "requirements", "spec_line").label = "SPEC:";
    const text = textOf(buildCertDefinition(sampleCert(), checked(c)));
    expect(text).not.toMatch(/\bMin\b|\bMax\b|\bPass\b|\bFail\b|\bOverride\b/);
  });
});

// ------------------------------------------------------------------------------------------------
// cert_statement binds through the DATA SEAM: the builder reads `input.statement` verbatim (the
// config binding is printCert's job, exercised in the print-path suite below).
// ------------------------------------------------------------------------------------------------

describe("buildCertDefinition — cert_statement is a data-seam field, not a builder literal", () => {
  it("renders whatever statement the data carries; the statement section can be hidden", () => {
    const text = textOf(buildCertDefinition(sampleCert({ statement: "DATA-SEAM-STATEMENT-MARKER" })));
    expect(text).toContain("DATA-SEAM-STATEMENT-MARKER");
    const c = cfg();
    sectionOf(c, "statement").visible = false;
    expect(textOf(buildCertDefinition(sampleCert({ statement: "HIDDEN-MARKER" }), checked(c)))).not.toContain("HIDDEN-MARKER");
  });
});

// ------------------------------------------------------------------------------------------------
// The signature block (§3.11) — byte-identical under the default config. Pinned through the
// rendered bytes (the image paints, the fallback paints none) AND the definition structure.
// ------------------------------------------------------------------------------------------------

describe("buildCertDefinition — the signature block is untouched by the conversion", () => {
  const signatureNode = (def: unknown) =>
    findNodes(def, (n) => Array.isArray(n.columns)
      && (n.margin as unknown[])?.toString?.() === [0, 24, 0, 0].toString())[0];

  it("the default signature block's definition is byte-for-byte the pre-conversion shape", () => {
    const def = buildCertDefinition(sampleCert({
      signer: { name: "Colton Jones", title: "Production Manager", company: "American Heat Treating - Alabama, LLC", signatureDataUri: null },
    }));
    expect(signatureNode(def)).toEqual({
      columns: [
        { width: "*", text: "" },
        {
          width: 250,
          stack: [
            { text: "Colton Jones", fontSize: 13, alignment: "center", margin: [0, 0, 0, 2] },
            { canvas: [{ type: "line", x1: 0, y1: 0, x2: 250, y2: 0, lineWidth: 1 }] },
            { text: "Colton Jones", fontSize: 10, margin: [4, 3, 0, 0] },
            { text: "Production Manager", fontSize: 10, margin: [4, 1, 0, 0] },
            { text: "American Heat Treating - Alabama, LLC", fontSize: 10, margin: [4, 1, 0, 0] },
          ],
        },
      ],
      margin: [0, 24, 0, 0],
    });
  });

  it("the signature image paints through rendered bytes; the typed-name fallback paints none", async () => {
    const withImage = await renderPdf(buildCertDefinition(sampleCert()));
    expect(paintedImageCounts(withImage)).toEqual([1]);
    const noImage = await renderPdf(buildCertDefinition(sampleCert({
      signer: { name: "Colton Jones", title: "", company: "American Heat Treating - Alabama, LLC", signatureDataUri: null },
    })));
    expect(paintedImageCounts(noImage)).toEqual([0]);
    expect(drawnText(noImage)).toContain("Colton Jones");
  });
});

// ------------------------------------------------------------------------------------------------
// Multi-part certs are ONE sheet group — the per-part requirement headings are §3.21 content in a
// single document, never separate renders. The ruling-27 grouping stays the builder's own.
// ------------------------------------------------------------------------------------------------

describe("buildCertDefinition — multi-part certs stay one document", () => {
  it("a two-part cert renders one sheet with a heading per frozen line group (ruling 27)", async () => {
    const def = buildCertDefinition(twoPartCert());
    const text = textOf(def);
    expect(text).toContain("PART-A — Part A");
    expect(text).toContain("PART-B — Part B");
    const pdf = await renderPdf(def);
    expect(pageCount(pdf)).toBe(1); // one document, not two renders
  });

  it("a single-part cert stays heading-free — the §3.21 sample shape (ruling 27)", () => {
    const text = textOf(buildCertDefinition(sampleCert()));
    expect(text).not.toContain("500031-HT — Track Shoe, Vehicular");
  });

  it("hiding the part_heading field drops the headings but keeps the grouped grids", () => {
    const c = cfg();
    fieldOf(c, "requirements", "part_heading").visible = false;
    const text = textOf(buildCertDefinition(twoPartCert(), checked(c)));
    expect(text).not.toContain("PART-A — Part A");
    expect(text).not.toContain("PART-B — Part B");
    expect(text).toContain("Were heat treated as per P.O. NONE to HRC:"); // the grids remain
  });
});

// ------------------------------------------------------------------------------------------------
// Logo placement (spec §6.3). The cert header has a 100pt left spacer where a top-left logo sits;
// header-center/right join the title/order-field stacks.
// ------------------------------------------------------------------------------------------------

const LOGO_URI = "data:image/png;base64,CERTLOGOFIXTURE";

describe("buildCertDefinition — logo placement", () => {
  const placedConfig = (placement: "header-left" | "header-center" | "header-right") => {
    const c = cfg();
    c.logo = { placement, width: 90 };
    return checked(c);
  };
  const headerColumns = (def: unknown): { image?: string; width?: number; stack?: { image?: string; width?: number }[] }[] =>
    (def as { content: { columns: never[] }[] }).content[0].columns;

  it("a placed logo joins the header-left spacer at its configured width", () => {
    const cols = headerColumns(buildCertDefinition(sampleCert(), placedConfig("header-left"), LOGO_URI));
    expect(cols[0].stack![0]).toEqual({ image: LOGO_URI, width: 90 });
  });

  it("a header-center logo joins the top of the title stack", () => {
    const cols = headerColumns(buildCertDefinition(sampleCert(), placedConfig("header-center"), LOGO_URI));
    expect(cols[1].stack![0]).toEqual({ image: LOGO_URI, width: 90 });
  });

  it("a header-right logo joins the top of the order-fields stack", () => {
    const cols = headerColumns(buildCertDefinition(sampleCert(), placedConfig("header-right"), LOGO_URI));
    expect(cols[2].stack![0]).toEqual({ image: LOGO_URI, width: 90 });
  });

  it("config placement without bytes, and bytes without placement, both fall back to the text-only header", () => {
    const placed = buildCertDefinition(sampleCert(), placedConfig("header-center"));
    expect(JSON.stringify(placed)).not.toContain(LOGO_URI);
    const unplaced = buildCertDefinition(sampleCert(), cfg(), LOGO_URI);
    expect(JSON.stringify(unplaced)).not.toContain(LOGO_URI);
  });
});

// ------------------------------------------------------------------------------------------------
// Page footer knob + the continuation band. The knob defaults OFF (golden — the static company
// strip stays a plain pdfmake footer); ON, the strip rides the pageNofM knob's `above` so it never
// competes for the one footer slot. The band exists because a real cert genuinely overflows: the
// readings (bounded at 500 per requirement), the parts (order lines are unbounded) and the serials
// (bounded at 10,000) all grow past one page (probed before building: 100 readings → 2 pages).
// ------------------------------------------------------------------------------------------------

describe("buildCertDefinition — pageFooter knob and continuation band", () => {
  it("the knob OFF keeps the static company-strip footer; the margins are today's", () => {
    const dflt = buildCertDefinition(sampleCert());
    expect(dflt.pageFooterSpec).toBeUndefined();
    expect(textOf(dflt.footer)).toContain("Phone: 256-835-3370");
    expect(dflt.pageMargins).toEqual([24, 24, 24, 44]);
  });

  it("the knob ON moves the company strip onto the pageNofM footer's `above` slot, dropping the plain footer", () => {
    const c = cfg();
    c.pageFooter = true;
    const def = buildCertDefinition(sampleCert(), checked(c));
    expect(def.footer).toBeUndefined();
    expect(def.pageFooterSpec!.kind).toBe("pageNofM");
    expect(textOf(def.pageFooterSpec!.above)).toContain("Phone: 256-835-3370");
    expect(def.pageMargins).toEqual([24, 24, 24, 44]);
  });

  it("the knob ON with the footer section hidden carries the page line alone", () => {
    const c = cfg();
    c.pageFooter = true;
    sectionOf(c, "footer").visible = false;
    const def = buildCertDefinition(sampleCert(), checked(c));
    expect(def.pageFooterSpec).toEqual({ kind: "pageNofM" });
    expect(def.footer).toBeUndefined();
  });

  it("the definition carries the cert's identity band for continuation pages", () => {
    const def = buildCertDefinition(sampleCert());
    const band = allText(def.continuationHeaderSpec!.content).join("\n");
    expect(band).toContain("Order No.: 72036-3");
    expect(band).toContain("(continued)");
    expect(def.continuationHeaderSpec!.overflowTopMargin).toBeGreaterThanOrEqual(36);
  });

  it("the band carries an order_no label override but ignores its visibility flag — identity on paper is locked", () => {
    const c = cfg();
    fieldOf(c, "header", "order_no").label = "Job No.:";
    fieldOf(c, "header", "order_no").visible = false;
    const def = buildCertDefinition(sampleCert(), checked(c));
    const band = allText(def.continuationHeaderSpec!.content).join("\n");
    expect(band).toContain("Job No.: 72036-3");
    // …while the sheet body honours the hide.
    expect(textOf(def.content)).not.toContain("Job No.:");
  });

  it("a reading-heavy cert overflows LETTER and repeats its identity on page 2 (the live overflow path)", async () => {
    const readings = Array.from({ length: 150 }, (_, i) => 28 + (i % 5) * 0.1);
    const wide = sampleCert({
      requirements: [{ lineIdentity: "line-1", linePosition: 1, partNumber: "500031-HT", partName: "Track Shoe, Vehicular", specification: "Were heat treated as per P.O. NONE", scale: "HRC", readings }],
    });
    const pdf = await renderPdf(buildCertDefinition(wide));
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
    const pages = drawnPages(pdf);
    expect(pages[0]).not.toContain("(continued)");
    expect(pages[pages.length - 1]).toContain("(continued)");
  });
});

// ------------------------------------------------------------------------------------------------
// Purity, config included.
// ------------------------------------------------------------------------------------------------

describe("buildCertDefinition — purity, config included", () => {
  it("a config-driven definition survives the JSON round trip and is deterministic", () => {
    const c = cfg();
    c.logo = { placement: "header-right", width: 80 };
    fieldOf(c, "header", "title").label = "CERT";
    c.formats.dateFormat = "MMMM D, YYYY";
    c.pageFooter = true;
    const config = checked(c);
    const def = buildCertDefinition(sampleCert(), config, LOGO_URI);
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    expect(buildCertDefinition(sampleCert(), config, LOGO_URI)).toEqual(def);
  });
});

// ------------------------------------------------------------------------------------------------
// The print path (spec §5.2): resolve docType `CERT` on the owning order's customer, render the
// resolved config, stamp the version id. `cert_statement` binds at the data seam — the config's
// block reaches paper, the retired Setting no longer does. `printedAt` first-print semantics and
// the signer read are untouched.
// ------------------------------------------------------------------------------------------------

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({
    data: { code: `CRT${customerSeq}`, name: `Cert Template Customer ${customerSeq}` },
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

let partSeq = 0;
async function makeInspectedPart(customerId: string) {
  partSeq += 1;
  const material = await prisma.material.create({ data: { name: `steel ${partSeq}` } });
  const scale = await prisma.inspectionScale.create({ data: { name: `HRC${partSeq}` } });
  const code = await prisma.inspectionCode.create({
    data: { name: `Were heat treated as per P.O. NONE (${partSeq})`, defaultScaleId: scale.id },
  });
  const part = await prisma.part.create({
    data: {
      customerId, partNumber: `500031-HT-${partSeq}`, name: "Track Shoe, Vehicular",
      description: "T-130", eachWeight: "21.5000", materialId: material.id,
    },
  });
  await prisma.partInspection.create({
    data: {
      partId: part.id, inspectionCodeId: code.id, scaleId: scale.id,
      min: "28.0000", max: "32.0000", sampleQty: "9", location: "flange OD", sort: 1,
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
async function makeSigner(): Promise<User> {
  userSeq += 1;
  return prisma.user.create({
    data: { username: `quality${userSeq}`, displayName: "Quality Signer", passwordHash: "x" },
  });
}

async function certFor(customer: Customer): Promise<{ cert: CertDetail; user: User; order: OrderDetail }> {
  const part = await makeInspectedPart(customer.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "PT24115",
    lines: [{ partId: part.id, qty: 192, weight: "4128.00" }],
  }));
  let cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
  cert = await asSystem(() => replaceReadings(cert.id, {
    requirements: [{ id: cert.requirements[0].id, readings: [{ value: 30 }, { value: 31 }] }],
  }, { afterPrint: false }));
  const user = await makeSigner();
  return { cert, user, order };
}

/** Create → tweak the v1 draft → (optionally logo) → publish, for the CERT docType. */
async function publishCustom(tweak: (c: TemplateConfig) => void, logo?: { data: Buffer; mime: string }) {
  const t = await asSystem(() => createTemplate("CERT", "Custom Cert"));
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

describe("printCert — resolution stamps the version and binds cert_statement from config", () => {
  beforeEach(truncateAll);

  it("no assignment: resolves the seeded Standard cert and stamps ITS version id", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const { cert, user } = await certFor(customer);
    const { documentId, pdf } = await asSystem(() => printCert(cert.id, user.id));
    expect(drawnText(pdf)).toContain("Certification");
    expect(await stampOf(documentId)).toBe(templateVersionId("CERT"));
  });

  it("a label override prints through the real path and stamps the assigned version", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const tpl = await publishCustom((c) => {
      fieldOf(c, "header", "title").label = "CERT-STYLE-MARKER";
    });
    await asSystem(() => assignTemplate(customer.id, "CERT", tpl.templateId));
    const { cert, user } = await certFor(customer);
    const { documentId, pdf } = await asSystem(() => printCert(cert.id, user.id));
    expect(drawnText(pdf)).toContain("CERT-STYLE-MARKER");
    expect(await stampOf(documentId)).toBe(tpl.versionId);
  });

  it("the config's cert_statement reaches paper (the Setting is retired in Task 14)", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    // The config's block is the only source now — cert_statement left settings.ts. A DISTINCT
    // marker proves the seam binds the resolved config, not the contract default.
    const tpl = await publishCustom((c) => {
      c.textBlocks.cert_statement = "CONFIG-STATEMENT-MARKER";
    });
    await asSystem(() => assignTemplate(customer.id, "CERT", tpl.templateId));
    const { cert, user } = await certFor(customer);
    const { pdf } = await asSystem(() => printCert(cert.id, user.id));
    const text = drawnText(pdf);
    expect(text).toContain("CONFIG-STATEMENT-MARKER");
    // The contract-default statement is not reached — the template's own block wins at the seam.
    expect(text).not.toContain("We certify that the listed Parts");
  });

  it("the pageFooter knob prints per-page numbers; the default prints none", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const tpl = await publishCustom((c) => { c.pageFooter = true; });
    await asSystem(() => assignTemplate(customer.id, "CERT", tpl.templateId));
    const { cert, user } = await certFor(customer);
    const { pdf } = await asSystem(() => printCert(cert.id, user.id));
    expect(drawnText(pdf)).toContain("Page 1 of 1");

    const bareCustomer = await makeCustomer();
    await makeBillTo(bareCustomer.id);
    const bare = await certFor(bareCustomer);
    const bareprint = await asSystem(() => printCert(bare.cert.id, bare.user.id));
    expect(drawnText(bareprint.pdf)).not.toMatch(/Page \d+ of \d+/);
  });

  it("a placed logo prints through the real path; the bare cert paints only its signature", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const tpl = await publishCustom(
      (c) => { c.logo = { placement: "header-left", width: 90 }; },
      { data: await barcodePng("CERTLOGO"), mime: "image/png" });
    await asSystem(() => assignTemplate(customer.id, "CERT", tpl.templateId));
    const { cert, user } = await certFor(customer);
    const { pdf } = await asSystem(() => printCert(cert.id, user.id));
    // The signer here has no signature on file, so the only painted image is the logo.
    expect(paintedImageCounts(pdf)).toEqual([1]);

    const bareCustomer = await makeCustomer();
    await makeBillTo(bareCustomer.id);
    const bare = await certFor(bareCustomer);
    const bareprint = await asSystem(() => printCert(bare.cert.id, bare.user.id));
    expect(paintedImageCounts(bareprint.pdf)).toEqual([0]);
  });

  it("printedAt is set on the first print only, and every print stamps the version", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const { cert, user } = await certFor(customer);
    expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt).toBeNull();
    const a = await asSystem(() => printCert(cert.id, user.id));
    const first = (await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt;
    expect(first).not.toBeNull();
    const b = await asSystem(() => printCert(cert.id, user.id));
    const second = (await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt;
    expect(second!.getTime()).toBe(first!.getTime()); // reprint does not move it
    expect(await stampOf(a.documentId)).toBe(templateVersionId("CERT"));
    expect(await stampOf(b.documentId)).toBe(templateVersionId("CERT"));
  });
});
