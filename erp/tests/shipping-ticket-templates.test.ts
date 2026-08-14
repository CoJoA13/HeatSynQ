import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, templateVersionId } from "./helpers/db";
import { drawnPages, drawnText, pageCount, paintedImageCounts, textRunsWithY } from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import { createShipper, printShippingTickets, type ShipperDetail } from "@/server/shippers";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { barcodePng, renderPdf } from "@/server/pdf/render";
import {
  buildShippingTicketDefinition, buildShippingTicketDefinitions,
  type TicketData, type TicketDocType,
} from "@/server/pdf/shipping-ticket";
import {
  SHIPPER_DEFAULT_CONFIG, MOS_SHIPPER_DEFAULT_CONFIG, validateConfig, type TemplateConfig,
} from "@/lib/template-contracts/index";
import type { Customer } from "../prisma/generated/prisma/client";

/**
 * Phase 7 Task 9 — the shipping-ticket conversion: ONE builder serving BOTH the `SHIPPER` and
 * `MOS_SHIPPER` contracts (spec §5.4, §5.2 — the configs are structurally identical today, each
 * fed with the docType it was validated against), the §5.6 belt (both halves — the ticket
 * contracts lock NOTHING, so the belt's observable duty here is to NOT force what may hide, plus
 * the omission half via `completeSections`), and THE TWO-DATE-STYLES TRAP (Task 1 review carry,
 * BINDING): the contract's ONE date knob maps to the header `shortDate` slot ONLY — the tear-off
 * keeps its zero-padded `paddedDate` style unconditionally, both assertions in one test.
 *
 * The GOLDEN-COMPAT gate lives in tests/shipping-ticket.test.ts, untouched — this file is the
 * config-driven half (the traveler-templates.test.ts shape).
 */

// ------------------------------------------------------------------------------------------------
// Pure fixtures — the golden suite's sampleTicket, kept value-distinctive.
// ------------------------------------------------------------------------------------------------

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

const DEFAULTS: Record<TicketDocType, TemplateConfig> = {
  SHIPPER: SHIPPER_DEFAULT_CONFIG,
  MOS_SHIPPER: MOS_SHIPPER_DEFAULT_CONFIG,
};
const cfg = (docType: TicketDocType = "SHIPPER"): TemplateConfig => structuredClone(DEFAULTS[docType]);
/** Round-trips a tweaked config through the REAL validator — every config a test feeds the
 *  builder (the raw omission-belt shapes excepted, deliberately) is one a template could store. */
const checked = (c: TemplateConfig, docType: TicketDocType = "SHIPPER"): TemplateConfig =>
  validateConfig(docType, c);
const sectionOf = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
const fieldOf = (c: TemplateConfig, section: string, key: string) =>
  sectionOf(c, section).fields.find((f) => f.key === key)!;

/** Every `text` string/number in a definition, flattened — the golden suite's walker. */
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
// Config-driven sections, fields, labels, widths — through BOTH docTypes where the knob is
// docType-fed (label/width); the single-docType tests run SHIPPER (the contracts are pinned
// structurally identical in tests/template-contracts.test.ts, and the builder resolves each
// config against ITS OWN contract either way).
// ------------------------------------------------------------------------------------------------

describe("buildShippingTicketDefinition — config-driven, both docTypes", () => {
  it.each(["SHIPPER", "MOS_SHIPPER"] as const)(
    "a label override prints in place of the contract default (%s)", (docType) => {
      const c = cfg(docType);
      fieldOf(c, "field_strip", "po_number").label = "Client PO";
      const text = textOf(buildShippingTicketDefinition([sampleTicket()], docType, checked(c, docType)));
      expect(text).toContain("Client PO");
      expect(text).not.toContain("Purchase Order Number");
    });

  it.each(["SHIPPER", "MOS_SHIPPER"] as const)(
    "a width override lands in the table's widths array (%s)", (docType) => {
      const c = cfg(docType);
      fieldOf(c, "field_strip", "customer_job_no").width = 90;
      const def = buildShippingTicketDefinition([sampleTicket()], docType, checked(c, docType));
      expect(allWidths(def)).toContainEqual(["*", "*", 90, 70, 85]);
    });

  it("a hidden section is omitted from the stack", () => {
    const c = cfg();
    sectionOf(c, "liability").visible = false;
    const text = textOf(buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(c)));
    expect(text).not.toContain("FIRST LIABILITY PARAGRAPH.");
    // …and the default config still prints it.
    const dflt = textOf(buildShippingTicketDefinition([sampleTicket()]));
    expect(dflt).toContain("FIRST LIABILITY PARAGRAPH.");
  });

  it("a hidden field drops its column — header cell and width both", () => {
    const c = cfg();
    fieldOf(c, "lines", "line_pounds").visible = false;
    const def = buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(c));
    // Exact-element containment — "Pounds Shipped:" (totals) legitimately remains.
    expect(allText(def)).not.toContain("Pounds");
    expect(allWidths(def)).toContainEqual([70, "*"]);
  });

  it("a hidden container column drops from BOTH folded groups", () => {
    const c = cfg();
    fieldOf(c, "containers", "cust_cont_id").visible = false;
    const def = buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(c));
    expect(textOf(def)).not.toContain("Cust Cont Id");
    expect(allWidths(def)).toContainEqual([80, "*", 80, "*"]);
  });

  it("stack order follows the config's section order", () => {
    const c = cfg();
    const i = c.sections.findIndex((s) => s.key === "lines");
    const j = c.sections.findIndex((s) => s.key === "containers");
    [c.sections[i], c.sections[j]] = [c.sections[j], c.sections[i]];
    const text = textOf(buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(c)));
    expect(text.indexOf("Container Type")).toBeLessThan(text.indexOf("Quantity"));
    // …the default order is the other way around.
    const dflt = textOf(buildShippingTicketDefinition([sampleTicket()]));
    expect(dflt.indexOf("Quantity")).toBeLessThan(dflt.indexOf("Container Type"));
  });

  it("field order follows the config within its section", () => {
    const c = cfg();
    const strip = sectionOf(c, "field_strip");
    const carrier = strip.fields.find((f) => f.key === "carrier")!;
    strip.fields = [carrier, ...strip.fields.filter((f) => f.key !== "carrier")];
    const def = buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(c));
    const text = textOf(def);
    expect(text.indexOf("Carrier")).toBeLessThan(text.indexOf("Purchase Order Number"));
    expect(allWidths(def)).toContainEqual([85, "*", "*", 110, 70]);
  });

  it("the two party boxes follow config order and a hidden box leaves its slot holding position", () => {
    const swapped = cfg();
    const parties = sectionOf(swapped, "parties");
    parties.fields = [parties.fields[1], parties.fields[0]];
    const text = textOf(buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(swapped)));
    expect(text.indexOf("Ship To:")).toBeLessThan(text.indexOf("Sold To:"));

    const hidden = cfg();
    fieldOf(hidden, "parties", "sold_to").visible = false;
    const def = buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(hidden));
    const t = textOf(def);
    expect(t).not.toContain("Sold To:\n3054");
    expect(t).toContain("Ship To:");
    expect(t).toContain("Max Coating");
  });
});

describe("buildShippingTicketDefinition — fonts and number formats", () => {
  it("family, base size and role sizes map into the definition", () => {
    const c = cfg();
    c.fonts = { family: "Liberation Sans", baseSize: 9, headingSize: 20, smallSize: 4 };
    const def = buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(c));
    expect(def.defaultStyle).toEqual({ font: "Liberation Sans", fontSize: 9 });
    // headingSize drives the document title; smallSize the liability fine print.
    const title = findNodes(def, (n) => n.text === "Shipping Ticket");
    expect(title[0].fontSize).toBe(20);
    const fine = findNodes(def, (n) => n.text === "FIRST LIABILITY PARAGRAPH.");
    expect(fine[0].fontSize).toBe(4);
    // …the default keeps today's literals.
    const dflt = buildShippingTicketDefinition([sampleTicket()]);
    expect(dflt.defaultStyle).toEqual({ font: "Roboto", fontSize: 8 });
    expect(findNodes(dflt, (n) => n.text === "Shipping Ticket")[0].fontSize).toBe(16);
  });

  it("thousandsSeparator: false ungroups every number style the ticket prints", () => {
    const big = sampleTicket({ totalQty: 4128, totalWeight: 4128,
      lines: [{ qty: 4128, partNumber: "P", partName: "N", partDescription: "D", pounds: 4128 }] });
    const c = cfg();
    c.formats.thousandsSeparator = false;
    const text = textOf(buildShippingTicketDefinition([big], "SHIPPER", checked(c)));
    expect(text).toContain("4128");          // num()
    expect(text).toContain("4128.00");       // num2() — the totals pair
    expect(text).not.toContain("4,128");
    const dflt = textOf(buildShippingTicketDefinition([big]));
    expect(dflt).toContain("4,128");
    expect(dflt).toContain("4,128.00");
  });
});

// ------------------------------------------------------------------------------------------------
// THE TWO-DATE-STYLES TRAP (Task 1 review carry, BINDING): one date knob, two printed styles.
// The knob maps to the header's `shortDate` slot ONLY; the tear-off's zero-padded "Shipped ON"
// keeps `paddedDate` UNCONDITIONALLY — both assertions in one test, per the Task 9 brief.
// ------------------------------------------------------------------------------------------------

describe("buildShippingTicketDefinition — the date knob maps to the header ONLY", () => {
  it("moves the header date and provably NOT the tear-off date", () => {
    const c = cfg();
    c.formats.dateFormat = "YYYY-MM-DD";
    const text = textOf(buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(c)));
    expect(text).toContain("Ship Date: 2026-07-29");          // the knob moved the header…
    expect(text).toContain("Shipped ON: 07/29/2026");         // …and the tear-off DID NOT move.
    expect(text).not.toContain("Ship Date: 7/29/2026");
  });

  it("every fixed date style renders in the header; the tear-off never follows", () => {
    const styles: [string, string][] = [
      ["M/D/YYYY", "Ship Date: 7/29/2026"],
      ["MM/DD/YYYY", "Ship Date: 07/29/2026"],
      ["YYYY-MM-DD", "Ship Date: 2026-07-29"],
      ["MMMM D, YYYY", "Ship Date: July 29, 2026"],
      ["MMM - DD - YYYY", "Ship Date: Jul - 29 - 2026"],
    ];
    for (const [format, expected] of styles) {
      const c = cfg();
      c.formats.dateFormat = format as TemplateConfig["formats"]["dateFormat"];
      const text = textOf(buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(c)));
      expect(text).toContain(expected);
      expect(text).toContain("Shipped ON: 07/29/2026");
    }
  });
});

// ------------------------------------------------------------------------------------------------
// The §5.6 belt, both halves. The ticket contracts lock NOTHING (shipper.ts's own header:
// "spec §5.6's locks are traveler-only"), so the flag half's observable duty is the NEGATIVE
// direction — the belt must not force visible what the contract allows hiding — and the omission
// half (completeSections) must still re-materialize entries a raw config drops.
// ------------------------------------------------------------------------------------------------

describe("buildShippingTicketDefinition — the §5.6 belt", () => {
  it("nothing on this contract is locked: a validated config may hide ANY section and the builder honors it", () => {
    const c = cfg();
    sectionOf(c, "header").visible = false;
    sectionOf(c, "tear_off").visible = false;
    const validated = checked(c); // accepted — contrast with the traveler's locked refusals
    const text = textOf(buildShippingTicketDefinition([sampleTicket()], "SHIPPER", validated));
    expect(text).not.toContain("Shipping Ticket");
    expect(text).not.toContain("Received By:");
  });

  it("a raw config OMITTING the totals section entry still renders it (the omission half)", () => {
    const c = cfg();
    c.sections = c.sections.filter((s) => s.key !== "totals");
    const text = textOf(buildShippingTicketDefinition([sampleTicket()], "SHIPPER", c));
    expect(text).toContain("Quantity Shipped:");
    expect(text).toContain("Pounds Shipped:");
  });

  it("a raw config OMITTING a field entry inside a present section still renders it", () => {
    const c = cfg();
    const strip = sectionOf(c, "field_strip");
    strip.fields = strip.fields.filter((f) => f.key !== "route");
    const text = textOf(buildShippingTicketDefinition([sampleTicket()], "SHIPPER", c));
    expect(text).toContain("Route");
    expect(text).toContain("South");
  });
});

// ------------------------------------------------------------------------------------------------
// Logo placement (spec §6.3) — the traveler's slot mechanics on the ticket's header.
// ------------------------------------------------------------------------------------------------

const LOGO_URI = "data:image/png;base64,TICKETLOGOFIXTURE";

describe("buildShippingTicketDefinition — logo placement", () => {
  const placedConfig = (placement: "header-left" | "header-center" | "header-right") => {
    const c = cfg();
    c.logo = { placement, width: 110 };
    return checked(c);
  };
  /** The header's three column stacks, structurally. */
  const headerStacks = (def: unknown): { image?: string; width?: number }[][] => {
    const sheet = (def as { content: { stack: { columns: { stack: never[] }[] }[] }[] }).content[0];
    return sheet.stack[0].columns.map((col) => col.stack);
  };

  it.each([["header-left", 0], ["header-center", 1], ["header-right", 2]] as const)(
    "a placed logo joins the %s slot at its configured width", (placement, colIdx) => {
      const def = buildShippingTicketDefinition([sampleTicket()], "SHIPPER", placedConfig(placement), LOGO_URI);
      const stacks = headerStacks(def);
      expect(stacks[colIdx][0]).toEqual({ image: LOGO_URI, width: 110 });
    });

  it("config placement without bytes, and bytes without placement, both fall back to the text-only header", () => {
    const placed = buildShippingTicketDefinition([sampleTicket()], "SHIPPER", placedConfig("header-center"));
    expect(JSON.stringify(placed)).not.toContain(LOGO_URI);
    const unplaced = buildShippingTicketDefinition([sampleTicket()], "SHIPPER", cfg(), LOGO_URI);
    expect(JSON.stringify(unplaced)).not.toContain(LOGO_URI);
  });
});

// ------------------------------------------------------------------------------------------------
// The tear-off reflow (P7 spec §5.6 ruling-3 guardrail; HANDOFF §7 item 5.3). The strip used to
// be stamped at `absolutePosition {x:24, y:648}`, so past ~8 extra multi-line part rows the
// flowed table ran UNDER it. Flow-based, the strip follows the content — the reading-order
// assertions below decode RENDERED bytes with their positions (textRunsWithY): on any page the
// strip shares with part rows, every row must sit ABOVE the strip's topmost text.
// ------------------------------------------------------------------------------------------------

/** `count` stacked three-line part rows with distinctive, greppable part numbers. */
function manyRowTicket(count: number): TicketData {
  return sampleTicket({
    lines: Array.from({ length: count }, (_, i) => ({
      qty: 10 + i, partNumber: `RFL-${String(i + 1).padStart(2, "0")}`,
      partName: "Reflow Regression Part", partDescription: "Stacked third line",
      pounds: 100 + i,
    })),
  });
}

/** The strip's textual TOP on a page: the bare tear-off order number ("72036" — the header
 *  prints "72036-3", so the bare run is unique to the strip). */
const tearTopY = (runs: { text: string; y: number }[]): number | null => {
  const run = runs.find((r) => r.text.trim() === "72036");
  return run === undefined ? null : run.y;
};
const partYs = (runs: { text: string; y: number }[]): number[] =>
  runs.filter((r) => r.text.trim().startsWith("RFL-")).map((r) => r.y);

/** A validated config keeping only the blocks ABOVE the part table plus the strip itself — the
 *  layout a long pick list legitimately produces, and the exact regime the HANDOFF §7 item 5.3
 *  ping describes: enough part rows and the table reaches the strip's old fixed slot (y=648,
 *  device y≈128). Nothing on this contract is locked, so the validator accepts the hiding. */
const longTableConfig = (): TemplateConfig => {
  const c = cfg();
  for (const key of ["containers", "serials", "liability", "totals"]) {
    sectionOf(c, key).visible = false;
  }
  return checked(c);
};

describe("the tear-off strip is flow-based (the >8-row overlap regression)", () => {
  it("the definition carries no absolutePosition anywhere", () => {
    const def = buildShippingTicketDefinition([sampleTicket()]);
    expect(JSON.stringify(def)).not.toContain("absolutePosition");
  });

  it("a part table reaching the strip's old fixed slot reflows instead of running under it", async () => {
    // 16 three-line rows end below device y≈128 — inside the absolutely-positioned strip's box.
    const pdf = await renderPdf(
      buildShippingTicketDefinition([manyRowTicket(16)], "SHIPPER", longTableConfig()));
    const pages = textRunsWithY(pdf);

    // Every row printed, and the strip printed once.
    const flat = pages.flat().map((r) => r.text).join("");
    for (let i = 1; i <= 16; i++) expect(flat).toContain(`RFL-${String(i).padStart(2, "0")}`);
    expect(flat).toContain("Received By:");

    const tearPage = pages.findIndex((runs) => tearTopY(runs) !== null);
    expect(tearPage).toBeGreaterThanOrEqual(0);
    const lastPartPage = pages.reduce((last, runs, i) => (partYs(runs).length > 0 ? i : last), -1);
    // Reading order: the strip never precedes part rows…
    expect(tearPage).toBeGreaterThanOrEqual(lastPartPage);
    // …and on the page they share (if any), every row sits ABOVE the strip's top (device y is
    // bottom-up: higher on paper = larger y). Pre-reflow this is the exact violation: rows past
    // y≈648-from-top drew UNDER the absolutely-positioned strip.
    const sharedPartYs = partYs(pages[tearPage]);
    const top = tearTopY(pages[tearPage])!;
    for (const y of sharedPartYs) expect(y).toBeGreaterThan(top);
  });

  it("a longer table shares its last page with the strip, rows strictly above it (the flow pin)", async () => {
    const pdf = await renderPdf(
      buildShippingTicketDefinition([manyRowTicket(24)], "SHIPPER", longTableConfig()));
    const pages = textRunsWithY(pdf);
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);

    const tearPage = pages.findIndex((runs) => tearTopY(runs) !== null);
    const shared = partYs(pages[tearPage]);
    expect(shared.length).toBeGreaterThan(0); // the strip and the table tail DO share this page
    const top = tearTopY(pages[tearPage])!;
    for (const y of shared) expect(y).toBeGreaterThan(top);
  });
});

// ------------------------------------------------------------------------------------------------
// Per-ticket sheet groups (P7 spec §6.1): one RenderableDefinition per order's ticket, merged by
// renderSheetGroups in the print path — the traveler's Task 8 shape. Each definition carries ITS
// order's continuation band and (behind the pageFooter knob, default OFF) its own per-group
// page-number footer.
// ------------------------------------------------------------------------------------------------

describe("buildShippingTicketDefinitions — one definition per ticket (pure)", () => {
  const twoTickets = (): TicketData[] => [
    sampleTicket(),
    sampleTicket({ orderLabel: "72037-1", orderNumber: 72037, poNumber: "PO-B" }),
  ];

  it("returns one definition per ticket, each content-identical to the singular's per-sheet stack", () => {
    const defs = buildShippingTicketDefinitions(twoTickets());
    expect(defs).toHaveLength(2);
    const singular = buildShippingTicketDefinition(twoTickets());
    const singularStacks = (singular.content as { stack: unknown }[]).map((c) => c.stack);
    const groupStacks = defs.map((d) => (d.content as { stack: unknown }[])[0].stack);
    expect(groupStacks).toEqual(singularStacks);
  });

  it("each definition carries ITS order's continuation band — never a sibling ticket's", () => {
    const defs = buildShippingTicketDefinitions(twoTickets());
    const bands = defs.map((d) => allText(d.continuationHeaderSpec!.content).join("\n"));
    expect(bands[0]).toContain("Order No.: 72036-3");
    expect(bands[0]).toContain("(continued)");
    expect(bands[0]).not.toContain("72037");
    expect(bands[1]).toContain("Order No.: 72037-1");
    expect(bands[1]).not.toContain("72036");
    // The band draws in the top margin; the reserve must clear its own height.
    expect(defs[0].continuationHeaderSpec!.overflowTopMargin).toBeGreaterThanOrEqual(36);
  });

  it("the band carries a label override but ignores the visibility flags — identity on paper is locked", () => {
    const c = cfg();
    fieldOf(c, "header", "order_no").label = "Work Order:";
    fieldOf(c, "header", "order_no").visible = false;
    const defs = buildShippingTicketDefinitions([sampleTicket()], "SHIPPER", checked(c));
    const band = allText(defs[0].continuationHeaderSpec!.content).join("\n");
    expect(band).toContain("Work Order: 72036-3");
    // …while the sheet body itself honours the hide.
    expect(textOf(defs[0].content)).not.toContain("Work Order:");
  });

  it("the pageFooter knob turns on the per-group footer spec and widens the bottom margin; default stays off", () => {
    const on = cfg();
    on.pageFooter = true;
    const withFooter = buildShippingTicketDefinitions(twoTickets(), "SHIPPER", checked(on));
    expect(withFooter[0].pageFooterSpec).toEqual({ kind: "pageNofM" });
    expect(withFooter[0].pageMargins).toEqual([24, 24, 24, 44]);

    const dflt = buildShippingTicketDefinitions(twoTickets());
    expect(dflt[0].pageFooterSpec).toBeUndefined();
    expect(dflt[0].pageMargins).toEqual([24, 24, 24, 24]); // golden — today's margins exactly
  });

  it("is pure: plain JSON, deterministic, spec keys included", () => {
    const defs = buildShippingTicketDefinitions(twoTickets(), "MOS_SHIPPER");
    expect(JSON.parse(JSON.stringify(defs))).toEqual(defs);
    expect(buildShippingTicketDefinitions(twoTickets(), "MOS_SHIPPER")).toEqual(defs);
  });
});

// ------------------------------------------------------------------------------------------------
// Purity, config included.
// ------------------------------------------------------------------------------------------------

describe("buildShippingTicketDefinition — purity, config included", () => {
  it("a config-driven definition survives the JSON round trip and is deterministic", () => {
    const c = cfg("MOS_SHIPPER");
    c.logo = { placement: "header-right", width: 90 };
    fieldOf(c, "lines", "line_qty").label = "Pieces";
    c.formats.dateFormat = "MMMM D, YYYY";
    const config = checked(c, "MOS_SHIPPER");
    const def = buildShippingTicketDefinition([sampleTicket()], "MOS_SHIPPER", config, LOGO_URI);
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    expect(buildShippingTicketDefinition([sampleTicket()], "MOS_SHIPPER", config, LOGO_URI)).toEqual(def);
  });
});

// ------------------------------------------------------------------------------------------------
// The print path (spec §5.2): docType by the SHIPMENT'S order count — a multi-order shipment's
// per-order ticket ALSO resolves MOS_SHIPPER (all paper from one shipment styles alike) — the
// resolved version's config renders, its id stamps the stored row, and the liability text comes
// from the CONFIG's text block, not the Setting (spec §8; settings.ts untouched until Task 14).
// ------------------------------------------------------------------------------------------------

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({
    data: { code: `TT${customerSeq}`, name: `Ticket Template Customer ${customerSeq}` },
  });
}

let partSeq = 0;
async function makePart(customerId: string) {
  partSeq += 1;
  const part = await prisma.part.create({
    data: {
      customerId, partNumber: `TTP-${partSeq}`, name: `Template Part ${partSeq}`,
      description: "T-130", eachWeight: "21.5000",
    },
  });
  const code = await prisma.processStepCode.create({ data: { code: `TT-${part.id}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
  return part;
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

async function orderFor(customer: Customer, poNumber = "PT24115"): Promise<OrderDetail> {
  const part = await makePart(customer.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber, customerJobNo: "JOB-9",
    lines: [{ partId: part.id, qty: 192, weight: "4128.00" }],
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
    containers: [] as { orderContainerId: string; count: number }[],
    serials: [] as { orderSerialId: string; printOnShipper?: boolean }[],
  };
}

async function oneOrderShipment(customer?: Customer): Promise<{ shipper: ShipperDetail; order: OrderDetail; customer: Customer }> {
  const c = customer ?? await makeCustomer();
  const shipTo = await makeAddresses(c.id);
  const order = await orderFor(c);
  const { shipper } = await asSystem(() => createShipper({
    customerId: c.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id, route: "South",
    orders: [shipOrderInput(order)],
  }, { canOverrideCreditHold: false }));
  return { shipper, order, customer: c };
}

async function twoOrderShipment(customer?: Customer): Promise<{
  shipper: ShipperDetail; orderA: OrderDetail; orderB: OrderDetail; customer: Customer;
}> {
  const c = customer ?? await makeCustomer();
  const shipTo = await makeAddresses(c.id);
  const orderA = await orderFor(c, "PO-A");
  const orderB = await orderFor(c, "PO-B");
  const { shipper } = await asSystem(() => createShipper({
    customerId: c.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id,
    orders: [shipOrderInput(orderA), shipOrderInput(orderB)],
  }, { canOverrideCreditHold: false }));
  return { shipper, orderA, orderB, customer: c };
}

/** Create → tweak the v1 draft → (optionally logo) → publish, for either ticket docType. */
async function publishCustom(
  docType: TicketDocType, tweak: (c: TemplateConfig) => void, logo?: { data: Buffer; mime: string },
) {
  const t = await asSystem(() => createTemplate(docType, `Custom ${docType}`));
  const c = cfg(docType);
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

describe("printShippingTickets — resolution by the SHIPMENT'S order count + the stamp", () => {
  beforeEach(truncateAll);

  it("no assignment: a single-order shipment resolves the seeded Standard SHIPPER and stamps ITS version id", async () => {
    const { shipper } = await oneOrderShipment();
    const { documentId, pdf } = await asSystem(() => printShippingTickets(shipper.id));
    expect(drawnText(pdf)).toContain("Shipping Ticket");
    expect(await stampOf(documentId)).toBe(templateVersionId("SHIPPER"));
  });

  it("no assignment: a multi-order shipment stamps the seeded MOS_SHIPPER id — whole set AND per-order", async () => {
    const { shipper, orderA } = await twoOrderShipment();
    const whole = await asSystem(() => printShippingTickets(shipper.id));
    expect(pageCount(whole.pdf)).toBe(2);
    expect(await stampOf(whole.documentId)).toBe(templateVersionId("MOS_SHIPPER"));

    // The per-order ticket of a MULTI-order shipment resolves MOS_SHIPPER too (spec §5.2: the
    // SHIPMENT'S order count decides, not the tickets being printed).
    const single = await asSystem(() => printShippingTickets(shipper.id, orderA.id));
    expect(pageCount(single.pdf)).toBe(1);
    expect(await stampOf(single.documentId)).toBe(templateVersionId("MOS_SHIPPER"));
  });

  it("customer-assigned templates: the three resolution cases through the real path, styled apart", async () => {
    const customer = await makeCustomer();
    const shipperTpl = await publishCustom("SHIPPER", (c) => {
      fieldOf(c, "header", "title").label = "SINGLE-STYLE-MARKER";
    });
    const mosTpl = await publishCustom("MOS_SHIPPER", (c) => {
      fieldOf(c, "header", "title").label = "MULTI-STYLE-MARKER";
    });
    await asSystem(() => assignTemplate(customer.id, "SHIPPER", shipperTpl.templateId));
    await asSystem(() => assignTemplate(customer.id, "MOS_SHIPPER", mosTpl.templateId));

    // 1. single-order shipment → SHIPPER.
    const single = await oneOrderShipment(customer);
    const p1 = await asSystem(() => printShippingTickets(single.shipper.id));
    expect(drawnText(p1.pdf)).toContain("SINGLE-STYLE-MARKER");
    expect(drawnText(p1.pdf)).not.toContain("MULTI-STYLE-MARKER");
    expect(await stampOf(p1.documentId)).toBe(shipperTpl.versionId);

    // 2. multi-order whole set → MOS_SHIPPER, on every sheet.
    const multi = await twoOrderShipment(customer);
    const p2 = await asSystem(() => printShippingTickets(multi.shipper.id));
    const pages = drawnPages(p2.pdf);
    expect(pages).toHaveLength(2);
    for (const page of pages) expect(page).toContain("MULTI-STYLE-MARKER");
    expect(drawnText(p2.pdf)).not.toContain("SINGLE-STYLE-MARKER");
    expect(await stampOf(p2.documentId)).toBe(mosTpl.versionId);

    // 3. the multi-order shipment's PER-ORDER ticket → still MOS_SHIPPER (explicit, spec §5.2).
    const p3 = await asSystem(() => printShippingTickets(multi.shipper.id, multi.orderA.id));
    expect(drawnText(p3.pdf)).toContain("MULTI-STYLE-MARKER");
    expect(await stampOf(p3.documentId)).toBe(mosTpl.versionId);
  });
});

describe("printShippingTickets — the liability text comes from the CONFIG, not the Setting", () => {
  beforeEach(truncateAll);

  it("the seeded Standard's text block prints (the Setting is retired in Task 14)", async () => {
    const { shipper } = await oneOrderShipment();
    const { pdf } = await asSystem(() => printShippingTickets(shipper.id));
    // The seeded config's text block is the code default — assert a token unique to it.
    expect(drawnText(pdf)).toContain("INSTITUTE");
  });

  it("an assigned template's edited text block prints (not the contract default)", async () => {
    const customer = await makeCustomer();
    const tpl = await publishCustom("SHIPPER", (c) => {
      c.textBlocks.shipper_liability_text = "CONFIG-LIABILITY-MARKER";
    });
    await asSystem(() => assignTemplate(customer.id, "SHIPPER", tpl.templateId));
    const { shipper } = await oneOrderShipment(customer);
    const { pdf } = await asSystem(() => printShippingTickets(shipper.id));
    const text = drawnText(pdf);
    expect(text).toContain("CONFIG-LIABILITY-MARKER");
    expect(text).not.toContain("INSTITUTE");
  });
});

describe("printShippingTickets — per-ticket sheet groups through the real path", () => {
  beforeEach(truncateAll);

  it("the pageFooter knob restarts numbering per ticket group; the default prints none", async () => {
    const customer = await makeCustomer();
    const tpl = await publishCustom("MOS_SHIPPER", (c) => { c.pageFooter = true; });
    await asSystem(() => assignTemplate(customer.id, "MOS_SHIPPER", tpl.templateId));

    const { shipper } = await twoOrderShipment(customer);
    const { pdf } = await asSystem(() => printShippingTickets(shipper.id));
    expect(pageCount(pdf)).toBe(2);
    const pages = drawnPages(pdf);
    // Each one-page ticket numbers ITSELF: "Page 1 of 1" twice, never "of 2".
    expect(pages[0]).toContain("Page 1 of 1");
    expect(pages[1]).toContain("Page 1 of 1");
    expect(drawnText(pdf)).not.toContain("of 2");

    // Default OFF — golden: the unassigned print carries no page numbers at all.
    const bare = await twoOrderShipment();
    const bareprint = await asSystem(() => printShippingTickets(bare.shipper.id));
    expect(drawnText(bareprint.pdf)).not.toMatch(/Page \d+ of \d+/);
  });

  it("a ticket overflowing LETTER repeats its order identity on the continuation page", async () => {
    const { shipper, order } = await oneOrderShipment();
    // 80 printable serials overflow one sheet; the shipment's serial picks are re-saved below.
    await prisma.orderSerial.createMany({
      data: Array.from({ length: 80 }, (_, i) => ({
        orderId: order.id, lineId: order.lines[0].id, position: i + 1,
        serial: `SER-${String(i + 1).padStart(3, "0")}`, description: "",
      })),
    });
    const serialIds = await prisma.orderSerial.findMany({
      where: { orderId: order.id }, select: { id: true, serial: true, lineId: true },
    });
    await prisma.shipperSerial.createMany({
      data: serialIds.map((s) => ({
        shipperOrderId: shipper.orders[0].id, orderSerialId: s.id,
        printOnShipper: true, serial: s.serial, description: "",
        orderLineIdAtSave: s.lineId ?? "",
      })),
    });

    const { pdf } = await asSystem(() => printShippingTickets(shipper.id));
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
    const pages = drawnPages(pdf);
    expect(pages[0]).not.toContain("(continued)");
    expect(pages[1]).toContain("(continued)");
    expect(pages[1]).toContain(`Order No.: ${order.orderNumber}-1`);
  });

  it("a placed logo prints through the real path; the bare ticket paints no image", async () => {
    const bare = await oneOrderShipment();
    const bareprint = await asSystem(() => printShippingTickets(bare.shipper.id));
    expect(paintedImageCounts(bareprint.pdf)).toEqual([0]);

    const customer = await makeCustomer();
    const tpl = await publishCustom("SHIPPER",
      (c) => { c.logo = { placement: "header-right", width: 90 }; },
      { data: await barcodePng("TICKETLOGO"), mime: "image/png" });
    await asSystem(() => assignTemplate(customer.id, "SHIPPER", tpl.templateId));
    const { shipper } = await oneOrderShipment(customer);
    const { pdf } = await asSystem(() => printShippingTickets(shipper.id));
    expect(paintedImageCounts(pdf)).toEqual([1]);
  });
});
