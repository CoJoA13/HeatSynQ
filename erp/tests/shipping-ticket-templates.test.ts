import { describe, it, expect } from "vitest";
import { pageCount, textRunsWithY } from "./helpers/pdf";
import { renderPdf } from "@/server/pdf/render";
import {
  buildShippingTicketDefinition, type TicketData, type TicketDocType,
} from "@/server/pdf/shipping-ticket";
import {
  SHIPPER_DEFAULT_CONFIG, MOS_SHIPPER_DEFAULT_CONFIG, validateConfig, type TemplateConfig,
} from "@/lib/template-contracts/index";

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
