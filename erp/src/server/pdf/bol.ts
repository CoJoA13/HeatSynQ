/**
 * The bill of lading — THE multi-order document (design spec §10.2, owner rulings §3.19/§3.20):
 * one per shipment, listing every order number on the truck, its own lazily-allocated
 * `bolNumber`, and the straight-bill-of-lading form completed by hand where the sample leaves
 * blanks. PURE by construction, the traveler.ts contract: `BolData` in, a plain-JSON pdfmake
 * definition out — no I/O, no clock, nothing that would not survive `JSON.parse(JSON.stringify())`
 * (asserted in tests/bol.test.ts). The reads live in shippers.ts (`readBolData`), the bytes in
 * render.ts.
 *
 * A CONFIG-CONSUMER since Phase 7 Task 10 (P7 spec §5.4). The ELEVEN UDSBL legal form constants
 * that used to live in this file are the `BOL` contract's TEXT BLOCKS now
 * (src/lib/template-contracts/bol.ts, defaults transcribed verbatim, quirks intact — "here
 * under", "(I) … (2)", "Comerce"): spec §8's "edited in place" — the template designer is the
 * legal text's editing path, and the builder renders `config.textBlocks`, never a literal of its
 * own. The default config reproduces today's paper exactly (the golden gate,
 * tests/bol.test.ts, untouched).
 *
 * **THE DATE KNOB HAS NO TRAP HERE** (the ticket's two-date-styles rule, generalized: map the
 * knob to exactly the slots the contract's default reproduces). This builder was grepped for
 * every date call before the knob was mapped — `bolDate` had exactly ONE call site, the
 * ship-from line — so the contract's single knob (default "MMM - DD - YYYY", the sample's own
 * style) maps to the paper's single date slot directly.
 *
 * Layout mirrors the owner's `docs/samples/Bill of Lading Sample.pdf`, which IS the contract
 * (spec §3.1). Deviations are individually commented; there are no silent ones:
 *  - `Delivering Carrier`, `Car or Vehicle Initials`, `Received $`, `Charges Advanced` and every
 *    signature line print as blank rules for hand completion, exactly as on the sample (§10.2).
 *    One spelling exception, on the spec's own explicit wording: §10.2 writes "Car or Vehicle
 *    Initials", so the contract's default label uses that spelling over the sample's.
 *  - everything is flow-laid; no `absolutePosition` anywhere (the Task 18 review's tear-off
 *    lesson — a pinned block collides with flow content on a long form).
 *  - the small inline form glue (parenthetical captions, "RECEIVED $", "Agent or Cashier",
 *    signature-rule captions, the "at"/"From" connectives) is the form's own furniture — rendered
 *    by the builder, not a contract knob (the contract's own header comment).
 */
import type { Column, Content, TableCell } from "pdfmake/interfaces";
import { LAYOUT, type RenderableDefinition } from "./render";
import { BOL_CONTRACT, DEFAULT_CONFIG } from "../../lib/template-contracts/bol";
import {
  completeSections,
  type FontsConfig, type FormatsConfig, type LogoPlacement, type SectionConfig,
  type TemplateConfig,
} from "../../lib/template-contracts/types";

// ---------------------------------------------------------------------------------------------
// BolData — the builder's whole input. Plain data: no Decimals, no Dates, no Prisma rows.
// ---------------------------------------------------------------------------------------------

export type BolCompany = { name: string; address: string };
export type BolParty = { name: string; street: string; city: string; state: string; zip: string };
export type BolData = {
  company: BolCompany;
  bolNumber: number;                   // Shipper.bolNumber, allocated at first print (§3.19)
  proNumber: string;
  scacCode: string;
  carrierName: string;
  shipDate: string;                    // "yyyy-mm-dd"
  consignee: BolParty;                 // the shipment's ship-to address (§3's closing note)
  orderNumbers: number[];              // every order on the shipment, ticket print order (§3.20)
  poNumbers: string[];                 // the orders' POs — "Consignee's Ref/PO No."
  packageCount: number | null;
  freightDescription: string;
  totalWeight: number;                 // the shipment's total pounds
  freightClass: string;
  freightTerms: "PREPAID" | "COLLECT";
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, config-driven (P7 spec §5.4's per-file formatting helpers), locale pinned
// (the traveler's own rule) so output never tracks the server's.
// ---------------------------------------------------------------------------------------------

/** Thousands-separated per the knob, at most 2 decimals, trailing zeros dropped — "11,415". */
function makeNum(formats: FormatsConfig): (value: number) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => value.toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping });
}

const MONTHS_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The ship-from line's date, driven by the contract's ONE date knob (default "MMM - DD - YYYY" —
 * the sample's own "Jul - 06 - 2026"). The paper's ONLY date slot — see the header comment's
 * no-trap note. Pure string work — parsing to a Date would drag a timezone into a date-only
 * value (src/lib/business-days.ts's whole point).
 */
function makeBolDate(formats: FormatsConfig): (iso: string) => string {
  const format = formats.dateFormat ?? "MMM - DD - YYYY";
  return (iso) => {
    const [y, m, d] = iso.split("-");
    switch (format) {
      case "M/D/YYYY": return `${Number(m)}/${Number(d)}/${y}`;
      case "MM/DD/YYYY": return `${m}/${d}/${y}`;
      case "YYYY-MM-DD": return iso;
      case "MMMM D, YYYY": return `${MONTHS_FULL[Number(m) - 1]} ${Number(d)}, ${y}`;
      default: return `${MONTHS_ABBR[Number(m) - 1]} - ${d} - ${y}`; // "MMM - DD - YYYY"
    }
  };
}

/** LETTER (612pt) minus the 24pt margins. */
const CONTENT_WIDTH = 564;

const line = (width: number): Content =>
  ({ canvas: [{ type: "line", x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 0.8 }] });

const fullRule = (margin: [number, number, number, number], lineWidth = 1.2): Content =>
  ({ canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth }], margin });

/** A form field: bold label left, the value sitting on its own rule right. */
function labeledRule(label: string, value: string, labelWidth: number, valueWidth: number): Content {
  return {
    columns: [
      { width: labelWidth, text: label, bold: true, fontSize: 7.5 },
      { width: valueWidth, stack: [{ text: value === "" ? " " : value, fontSize: 8, alignment: "center" }, line(valueWidth)] },
    ],
    columnGap: 4,
    margin: [0, 0, 0, 3],
  };
}

const head = (text: string): TableCell => ({ text, bold: true, alignment: "center", fontSize: 6.5 });

// ---------------------------------------------------------------------------------------------
// The config lens (P7 spec §5.4) — the ticket's `sectionView`, single contract. The builder
// ASSUMES a complete config (`validateConfig`'s §5.3 backfill guarantees every entry exists);
// only the two null-means-contract-default knobs a complete config still carries resolve here.
//
// THE §5.6 BELT, both halves plus a third: the flag half (`visible || !hideable` /
// `visible || !removable`) is the traveler's expression verbatim — NOTHING on this contract is
// locked, so it forces nothing and a config may hide anything; the omission half is
// `completeSections` in `buildBolDefinition` below, so a raw config that OMITS an entry still
// renders it; and the TEXT-BLOCK half is `TEXT_DEFAULTS` — a raw config omitting a text-block
// key renders the contract's transcription, never the string "undefined" (a validated config
// always carries all eleven keys; this is the belt's rationale applied to the one config surface
// completeSections does not cover).
// ---------------------------------------------------------------------------------------------

const CONTRACT_SECTIONS = new Map(BOL_CONTRACT.sections.map((s) =>
  [s.key, { section: s, fields: new Map(s.fields.map((f) => [f.key, f])) }] as const));

const TEXT_DEFAULTS = new Map(BOL_CONTRACT.textBlocks.map((t) => [t.key, t.defaultText]));

type FieldView = { visible: boolean; label: string; width: number | "*" };
type SectionView = {
  visible: boolean;
  /** Field keys in config (= display) order; per-field visibility still applies at use. */
  order: string[];
  field: (key: string) => FieldView;
};

function sectionView(sc: SectionConfig): SectionView {
  const cs = CONTRACT_SECTIONS.get(sc.key);
  // Unknown keys were refused by the validator before any config could be stored; a miss here
  // is a caller bug, not a config state.
  if (cs === undefined) throw new Error(`Unknown BOL template section "${sc.key}"`);
  const byKey = new Map(sc.fields.map((f) => [f.key, f]));
  return {
    visible: sc.visible || !cs.section.hideable, // the belt, section half (nothing locked here)
    order: sc.fields.map((f) => f.key),
    field: (key) => {
      const cf = cs.fields.get(key);
      if (cf === undefined) throw new Error(`Unknown BOL template field "${sc.key}.${key}"`);
      const fc = byKey.get(key);
      return {
        visible: (fc?.visible ?? true) || !cf.removable, // the belt, field half
        label: fc?.label ?? cf.defaultLabel,
        width: fc?.width ?? cf.column?.defaultWidth ?? "*",
      };
    },
  };
}

/** Everything a section renderer needs, threaded once instead of parameter-by-parameter. */
type Ctx = {
  fonts: FontsConfig;
  num: (value: number) => string;
  /** The date knob's only consumer — the ship-from line, the paper's single date slot. */
  bolDate: (iso: string) => string;
  /** A text block's config text — the omission belt's text half (see the lens comment). */
  text: (key: string) => string;
  sections: Map<string, SectionView>;
  /** Present only when the resolved version carries logo BYTES and the config PLACES them
   *  (spec §6.3) — either alone renders today's text-only header. */
  logo: { placement: LogoPlacement; width: number; dataUri: string } | null;
};

/** This section's visible column-field keys, in config order — what the freight table turns
 *  into its `widths` and its per-row cells. */
function columnKeys(v: SectionView, sectionKey: string): string[] {
  const cs = CONTRACT_SECTIONS.get(sectionKey)!;
  return v.order.filter((k) => cs.fields.get(k)?.column !== undefined && v.field(k).visible);
}

// ---------------------------------------------------------------------------------------------
// Blocks, top to bottom in sample order. Each returns Content[] — empty means "nothing left to
// draw" (every configurable piece hidden) and the block drops from the stack. Inter-block rules
// are each block's own closing glue: they hide, and travel, with their section.
// ---------------------------------------------------------------------------------------------

/**
 * Header: two structural slots hand-laid on the sample — "Original - Not Negotiable" + the title
 * left, the four labeled form rules right (250pt). Config field ORDER applies WITHIN each slot;
 * a field never migrates between slots (the traveler's documented mapping decision). The
 * original-label's and title's labels ARE their printed text, so a label override renames them.
 *
 * A placed logo (spec §6.3) joins the TOP of its slot's stack at its configured width; the
 * sample header has no center slot, so a header-center logo materializes a middle column between
 * the two structural slots — only a placed logo changes the structure (golden: no logo → today's
 * two-column header, byte-for-byte).
 */
function headerBlock(ctx: Ctx, d: BolData): Content[] {
  const v = ctx.sections.get("header")!;
  const pick = (keys: string[]): string[] =>
    v.order.filter((k) => keys.includes(k) && v.field(k).visible);

  const left: Content[] = [];
  for (const key of pick(["original_label", "title"])) {
    if (key === "original_label") left.push({ text: v.field(key).label, bold: true, fontSize: 9 });
    else left.push({ text: v.field(key).label, bold: true, fontSize: ctx.fonts.headingSize, margin: [0, 4, 0, 0] });
  }

  const valueFor = (key: string): string => {
    switch (key) {
      case "pro_number": return d.proNumber;
      case "bol_number": return String(d.bolNumber);
      case "consignee_ref": return d.poNumbers.filter((p) => p !== "").join(", ");
      default: return d.scacCode; // scac_code
    }
  };
  const right: Content[] = pick(["pro_number", "bol_number", "consignee_ref", "scac_code"])
    .map((key) => labeledRule(v.field(key).label, valueFor(key), 110, 130));

  let center: Content[] | null = null;
  if (ctx.logo !== null) {
    const node: Content = { image: ctx.logo.dataUri, width: ctx.logo.width };
    if (ctx.logo.placement === "header-left") left.unshift(node);
    else if (ctx.logo.placement === "header-right") right.unshift(node);
    else center = [node];
  }
  if (left.length + right.length === 0 && center === null) return [];

  const columns: Column[] = [{ width: "*", stack: left }];
  if (center !== null) columns.push({ width: ctx.logo!.width, stack: center });
  columns.push({ width: 250, stack: right });

  return [
    { columns, columnGap: 12, margin: [0, 0, 0, 4] },
    fullRule([0, 0, 0, 3]),
  ];
}

/** The carrier's name over its rule, the caption beneath (the `carrier_name` field's label —
 *  default "(Name of Carrier)") — blank rule when the shipment has no carrier (the sample's own
 *  hand-completed style; a customer-owned truck has none). */
function carrierBlock(ctx: Ctx, d: BolData): Content[] {
  const v = ctx.sections.get("carrier")!;
  if (!v.field("carrier_name").visible) return [];
  return [{
    columns: [
      { width: 60, text: "" },
      {
        width: 260,
        stack: [
          { text: d.carrierName === "" ? " " : d.carrierName, bold: true, fontSize: 10, alignment: "center" },
          line(260),
          { text: v.field("carrier_name").label, fontSize: 6.5, alignment: "center", margin: [0, 1, 0, 0] },
        ],
      },
      { width: "*", text: "" },
    ],
    margin: [0, 0, 0, 4],
  }];
}

/** "at <ship-from> <date> From <company>" — ship-from is the company settings (spec §10.2). A
 *  value-only composite field (the contract's `ship_from`, defaultLabel "") — the "at"/"From"
 *  connectives are the form's own wording, so a label override has nothing to replace (the
 *  traveler's decision 4). The ONE place the date knob lands. */
function shipFromLine(ctx: Ctx, d: BolData): Content {
  return {
    columns: [
      { width: "*", text: `at ${d.company.address}`, fontSize: 8.5 },
      { width: 100, text: ctx.bolDate(d.shipDate), bold: true, fontSize: 8.5, alignment: "center" },
      { width: 30, text: "From", fontSize: 8.5 },
      { width: 180, text: d.company.name, fontSize: 8.5 },
    ],
    columnGap: 6,
    margin: [0, 2, 0, 2],
  };
}

/** The legal preamble: the received clause, the ship-from line, the property clause, the shipper
 *  certification — three text blocks around one composite data line, in the sample's fixed
 *  order (text blocks are not reorderable elements; only the `ship_from` field can hide). The
 *  5.5pt clauses print at the config's `smallSize` role; the 6pt certification keeps its own
 *  literal — the knob maps to exactly the slots the contract's default (5.5) reproduces. */
function receivedBlock(ctx: Ctx, d: BolData): Content[] {
  const v = ctx.sections.get("received")!;
  const out: Content[] = [
    { text: ctx.text("bol_received_text"), fontSize: ctx.fonts.smallSize, margin: [0, 0, 0, 2] },
  ];
  if (v.field("ship_from").visible) out.push(shipFromLine(ctx, d));
  out.push({ text: ctx.text("bol_property_text"), fontSize: ctx.fonts.smallSize, margin: [0, 0, 0, 2] });
  out.push({ text: ctx.text("bol_certifies_text"), fontSize: 6, bold: true, margin: [8, 0, 0, 2] });
  out.push(fullRule([0, 0, 0, 4], 0.8));
  return out;
}

/** Consigned to / Destination, from the ship-to address — how a third-party consignee like the
 *  sample's "Max Coating" is expressed (spec §10.2, §3's closing note). Hand-laid: each field
 *  keeps the sample's fixed position and drops its label+rule pair when hidden (config order
 *  does not rearrange within this block); the captions are furniture riding with their rows. */
function consignedBlock(ctx: Ctx, d: BolData): Content[] {
  const v = ctx.sections.get("consigned")!;
  const f = v.field;
  const rows: Content[] = [];

  if (f("consigned_to").visible) {
    rows.push({
      columns: [
        { width: 70, text: f("consigned_to").label, bold: true, fontSize: 9 },
        { width: 180, stack: [{ text: d.consignee.name === "" ? " " : d.consignee.name, fontSize: 9 }, line(180)] },
        { width: "*", text: "(Mail or street address of consign - For purposes of notification only.)", fontSize: 5.5, margin: [8, 2, 0, 0] },
      ],
      columnGap: 4,
    });
    rows.push({
      columns: [
        { width: 70, text: "" },
        { width: 180, stack: [{ text: d.consignee.street === "" ? " " : d.consignee.street, fontSize: 9 }, line(180)] },
        { width: "*", text: "" },
      ],
      columnGap: 4,
      margin: [0, 3, 0, 0],
    });
  }

  const destPairs: Column[] = [];
  if (f("destination").visible) {
    destPairs.push({ width: 70, text: f("destination").label, bold: true, fontSize: 9 });
    destPairs.push({ width: 150, stack: [{ text: d.consignee.city === "" ? " " : d.consignee.city, fontSize: 9 }, line(150)] });
  }
  if (f("destination_state").visible) {
    destPairs.push({ width: 16, text: f("destination_state").label, bold: true, fontSize: 7.5 });
    destPairs.push({ width: 40, stack: [{ text: d.consignee.state === "" ? " " : d.consignee.state, fontSize: 9, alignment: "center" }, line(40)] });
  }
  if (f("destination_zip").visible) {
    destPairs.push({ width: 18, text: f("destination_zip").label, bold: true, fontSize: 7.5 });
    destPairs.push({ width: 60, stack: [{ text: d.consignee.zip === "" ? " " : d.consignee.zip, fontSize: 9, alignment: "center" }, line(60)] });
  }
  if (destPairs.length > 0) {
    rows.push({
      columns: [...destPairs, { width: "*", text: "Delivery Address *", fontSize: 6, margin: [8, 2, 0, 0] }],
      columnGap: 4,
      margin: [0, 3, 0, 0],
    });
    rows.push({
      text: "* To be filled in only when shipper desires and governing tariffs provide for delivery thereof.",
      fontSize: 5, alignment: "right", margin: [0, 2, 0, 0],
    });
  }

  if (rows.length === 0) return [];
  return [{ stack: rows, margin: [0, 2, 0, 4] }];
}

/** TRV NO. — every order number on the shipment, the §3.20 point of the whole document. */
function trvLine(ctx: Ctx, d: BolData): Content[] {
  const v = ctx.sections.get("trv")!;
  if (!v.field("trv_no").visible) return [];
  return [
    {
      columns: [
        { width: 55, text: v.field("trv_no").label, bold: true, fontSize: 9.5 },
        { width: "*", text: d.orderNumbers.join(","), bold: true, fontSize: 9.5 },
      ],
      margin: [0, 2, 0, 4],
    },
    fullRule([0, 0, 0, 3], 0.8),
  ];
}

/** Delivering Carrier / Car or Vehicle Initials / No. — blank rules for hand completion. Each
 *  field's label+rule pair drops when hidden; the sample's fixed left-to-right order holds. */
function deliveringCarrierLine(ctx: Ctx): Content[] {
  const v = ctx.sections.get("delivering_carrier")!;
  const f = v.field;
  const cols: Column[] = [];
  if (f("delivering_carrier").visible) {
    cols.push({ width: 80, text: f("delivering_carrier").label, bold: true, fontSize: 8 });
    cols.push({ width: 150, stack: [{ text: " " }, line(150)] });
  }
  if (f("vehicle_initials").visible) {
    cols.push({ width: 105, text: f("vehicle_initials").label, bold: true, fontSize: 8, alignment: "right" });
    cols.push({ width: 90, stack: [{ text: " " }, line(90)] });
  }
  if (f("vehicle_no").visible) {
    cols.push({ width: 22, text: f("vehicle_no").label, bold: true, fontSize: 8, alignment: "right" });
    cols.push({ width: "*", stack: [{ text: " " }, line(55)] });
  }
  if (cols.length === 0) return [];
  return [{ columns: cols, columnGap: 4, margin: [0, 2, 0, 6] }];
}

/** The freight table (columns per config — order, labels, widths) beside the Section 7 /
 *  prepaid-collect sidebar. The sidebar's paragraphs are the section's text blocks; its one
 *  data-driven mark, the collect checkbox, is the `collect_checkbox` field — hiding it drops
 *  the box AND its explanatory caption (the caption exists only to explain the box). */
function freightBlock(ctx: Ctx, d: BolData): Content[] {
  const { num } = ctx;
  const v = ctx.sections.get("freight")!;
  const cols = columnKeys(v, "freight");

  const headFor = (key: string): TableCell => key === "freight_description"
    // The description's header cell stacks the sample's second line under the label — the
    // contract's own note: one column, two header lines.
    ? { stack: [{ text: v.field(key).label, bold: true, alignment: "center", fontSize: 6.5 }, { text: "Special Marks, and Exceptions", bold: true, alignment: "center", fontSize: 6.5 }] }
    : head(v.field(key).label);
  const cellFor = (key: string): TableCell => {
    switch (key) {
      case "package_count": return { text: d.packageCount === null ? "" : num(d.packageCount), alignment: "center", fontSize: 9 };
      case "freight_description": return { text: d.freightDescription, fontSize: 9 };
      case "freight_weight": return { text: num(d.totalWeight), alignment: "right", fontSize: 9 };
      case "freight_class": return { text: d.freightClass, alignment: "center", fontSize: 9 };
      default: return { text: "" }; // check_column — hand-completed
    }
  };
  const freightTable: Content | null = cols.length === 0 ? null : {
    table: {
      headerRows: 1,
      widths: cols.map((k) => v.field(k).width),
      body: [cols.map(headFor), cols.map(cellFor)],
    },
    layout: LAYOUT.boxed,
  };

  const smallRule = (margin: [number, number, number, number]): Content =>
    ({ canvas: [{ type: "line", x1: 0, y1: 0, x2: 160, y2: 0, lineWidth: 0.8 }], margin });

  const sidebarStack: Content[] = [
    { text: ctx.text("bol_section_7_text"), fontSize: 6 },
    { text: ctx.text("bol_no_delivery_text"), fontSize: 6, margin: [0, 6, 0, 0] },
    smallRule([0, 14, 0, 1]),
    { text: "(Signature of consignor)", fontSize: 5.5, alignment: "center" },
  ];
  if (v.field("collect_checkbox").visible) {
    sidebarStack.push({ text: "Freight charges are PREPAID unless marked collect.", fontSize: 6, margin: [0, 8, 0, 2] });
    sidebarStack.push({
      columns: [
        { width: "*", text: v.field("collect_checkbox").label, bold: true, fontSize: 6.5, margin: [0, 2, 0, 0] },
        {
          width: 14,
          // The one data-driven mark on the whole form (spec §10.2's "prepaid/collect block
          // driven by freightTerms"): an X in the box for COLLECT, an empty box for PREPAID.
          table: { widths: [10], body: [[{ text: d.freightTerms === "COLLECT" ? "X" : "", alignment: "center", fontSize: 7, bold: true }]] },
          layout: LAYOUT.boxed,
        },
      ],
      margin: [0, 0, 0, 6],
    });
  }
  sidebarStack.push(
    smallRule([0, 8, 0, 1]),
    { text: "RECEIVED $", fontSize: 6.5, bold: true },
    { text: "to apply in prepayment of the charges on the property described hereon.", fontSize: 6, margin: [0, 2, 0, 0] },
    smallRule([0, 12, 0, 1]),
    { text: "Agent or Cashier", fontSize: 5.5, alignment: "center" },
    smallRule([0, 8, 0, 1]),
    { text: "Per", fontSize: 6.5 },
    { text: "(The signature here acknowledges only the amount prepaid.)", fontSize: 6, margin: [0, 2, 0, 0] },
    { text: "Charges Advanced:", fontSize: 6.5, bold: true, margin: [0, 8, 0, 0] },
    smallRule([0, 8, 0, 1]),
    { text: "$", fontSize: 6.5 },
    { text: ctx.text("bol_imprint_text"), fontSize: 6, margin: [0, 8, 0, 0] },
  );

  return [{
    columns: [
      { width: "*", stack: freightTable === null ? [] : [freightTable] },
      { width: 170, stack: [{ stack: sidebarStack }] },
    ],
    columnGap: 8,
    margin: [0, 0, 0, 10],
  }];
}

/** The bottom note stack: value declaration, liability limitation, fibre boxes (five text
 *  blocks), and the hand-signed Shipper/Agent/post-office lines. A hidden signature half leaves
 *  its slot holding position (the ticket parties' treatment); the PO-address line drops whole.
 *  The 5.5pt notes print at `smallSize`; the 7pt declared-value statement keeps its literal. */
function bottomBlock(ctx: Ctx): Content[] {
  const v = ctx.sections.get("bottom")!;
  const f = v.field;
  const stack: Content[] = [
    { text: ctx.text("bol_water_note"), fontSize: ctx.fonts.smallSize },
    { text: ctx.text("bol_value_note"), fontSize: ctx.fonts.smallSize, margin: [0, 2, 0, 0] },
    { text: ctx.text("bol_declared_value_text"), bold: true, fontSize: 7, margin: [0, 3, 0, 0] },
    {
      columns: [
        { width: 200, text: "" },
        { width: 30, text: "Per", bold: true, fontSize: 6.5 },
        { width: 160, stack: [{ text: " " }, line(160)] },
        { width: "*", text: "" },
      ],
      margin: [0, 1, 0, 2],
    },
    { text: ctx.text("bol_liability_note"), fontSize: ctx.fonts.smallSize },
    fullRule([0, 4, 0, 2], 0.8),
    { text: ctx.text("bol_fibre_note"), bold: true, fontSize: ctx.fonts.smallSize },
    fullRule([0, 2, 0, 8], 0.8),
  ];
  if (f("shipper_per").visible || f("agent_per").visible) {
    stack.push({
      columns: [
        ...(f("shipper_per").visible
          ? [
            { width: 60, text: f("shipper_per").label, bold: true, fontSize: 7.5 },
            { width: 160, stack: [{ text: " " }, line(160)] },
          ] as Column[]
          : [{ width: 60, text: "" }, { width: 160, text: "" }] as Column[]),
        ...(f("agent_per").visible
          ? [
            { width: 60, text: f("agent_per").label, bold: true, fontSize: 7.5, alignment: "right" },
            { width: "*", stack: [{ text: " " }, line(200)] },
          ] as Column[]
          : [{ width: 60, text: "" }, { width: "*", text: "" }] as Column[]),
      ],
      columnGap: 6,
      margin: [0, 6, 0, 8],
    });
  }
  if (f("po_address").visible) {
    stack.push({
      columns: [
        { width: 165, text: f("po_address").label, bold: true, fontSize: 7.5 },
        { width: "*", stack: [{ text: " " }, line(300)] },
      ],
      columnGap: 4,
    });
  }
  return [{ stack }];
}

/** One config section key → its renderer. Empty array means "nothing left to draw" — the block
 *  drops from the stack, like a hidden section. An unknown key renders nothing: the validator
 *  refused it before any config stored it. */
function renderSection(key: string, ctx: Ctx, d: BolData): Content[] {
  switch (key) {
    case "header": return headerBlock(ctx, d);
    case "carrier": return carrierBlock(ctx, d);
    case "received": return receivedBlock(ctx, d);
    case "consigned": return consignedBlock(ctx, d);
    case "trv": return trvLine(ctx, d);
    case "delivering_carrier": return deliveringCarrierLine(ctx);
    case "freight": return freightBlock(ctx, d);
    case "bottom": return bottomBlock(ctx);
    default: return [];
  }
}

/** The continuation band's margin reserve: one 11pt identity line plus the small "(continued)"
 *  line under a 10pt offset — 40 clears the body (the ticket's CONTINUATION_TOP_MARGIN, sized
 *  for a text-only band). Only an OVERFLOWING BOL pays it (render.ts's two-pass); a one-page BOL
 *  keeps today's 24pt top margin untouched. */
const CONTINUATION_TOP_MARGIN = 40;
/** Bottom margin when a template turns the `pageFooter` knob on: the footer draws in the bottom
 *  margin and needs ≥ ~28pt — 44 is the quote's own value, the house precedent. The knob
 *  defaults OFF, so the default paper keeps its 24pt (golden). */
const FOOTER_BOTTOM_MARGIN = 44;

/**
 * The BOL's identity band — what a BOL overflowing LETTER repeats on its continuation pages. The
 * BOL genuinely overflows: the TRV/PO lists grow with the shipment's order count, which the live
 * path does not bound (`createShipper`'s orders array is min(1) with no max) — ~80 orders pushes
 * the paper to a second page (probed empirically, Task 10). Its identity is its `bolNumber`
 * (§3.19 — the BOL's one number of its own). Rendered REGARDLESS of the config's visibility
 * flags (the ticket band's identity treatment — identity on paper is locked, not configurable),
 * though the `bol_number` label override still carries through. The `[24, 10, 24, 0]` margin
 * aligns the band with the page's 24pt side margins: pdfmake header content spans the full page
 * width (the footer spec's own convention).
 */
function continuationHeader(ctx: Ctx, d: BolData): Content {
  const v = ctx.sections.get("header")!;
  return {
    stack: [
      { text: `${v.field("bol_number").label} ${d.bolNumber}`, bold: true, fontSize: 11 },
      { text: "(continued)", italics: true, fontSize: ctx.fonts.smallSize },
    ],
    margin: [24, 10, 24, 0],
  };
}

// ---------------------------------------------------------------------------------------------
// The builder (spec §10.2, P7 spec §5.4). PURE — data and config in, JSON out.
// ---------------------------------------------------------------------------------------------

/**
 * `config` is a **backfilled** `TemplateConfig` (what `resolveTemplateForPrint` returns) and
 * DEFAULTS to the contract's own `DEFAULT_CONFIG` — the complete canonical constant the seeded
 * "Standard" template stores — so a config-less call renders exactly today's paper (the
 * golden-compat gate, tests/bol.test.ts). `logoDataUri` is the traveler's deliberate extra
 * parameter: the logo bytes belong to the resolved template version, not to the shipment data.
 *
 * ONE definition — the BOL is single-document paper (one per shipment, §3.19), so there is no
 * sheet-group plural here: `renderPdf` consumes the `RenderableDefinition` directly, its
 * `continuationHeaderSpec` covering the genuine many-order overflow (see `continuationHeader`)
 * and `config.pageFooter` (default OFF — golden) adding the page-number footer.
 */
export function buildBolDefinition(
  input: BolData,
  config: TemplateConfig = DEFAULT_CONFIG,
  logoDataUri?: string,
): RenderableDefinition {
  // The §5.6 belt's OMISSION half: views resolve over `completeSections`, never
  // `config.sections` raw, so a raw config omitting an entry cannot drop it.
  const sectionConfigs = completeSections(BOL_CONTRACT, config.sections);
  const sections = new Map(sectionConfigs.map((sc) => [sc.key, sectionView(sc)] as const));
  const ctx: Ctx = {
    fonts: config.fonts,
    num: makeNum(config.formats),
    bolDate: makeBolDate(config.formats),
    text: (key) => config.textBlocks[key] ?? TEXT_DEFAULTS.get(key)!,
    sections,
    logo: config.logo !== null && logoDataUri !== undefined
      ? { placement: config.logo.placement, width: config.logo.width, dataUri: logoDataUri }
      : null,
  };

  const content: Content[] = [];
  // Stack order IS the config's section order; hidden sections are omitted (nothing on this
  // contract is locked, so the belt forces none of them back).
  for (const sc of sectionConfigs) {
    if (!sections.get(sc.key)!.visible) continue;
    content.push(...renderSection(sc.key, ctx, input));
  }

  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, config.pageFooter ? FOOTER_BOTTOM_MARGIN : 24],
    defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
    // No `info.creationDate`, no clock anywhere — two prints of the same shipment must not differ
    // for no reason (the traveler's purity rule).
    content,
    continuationHeaderSpec: {
      content: continuationHeader(ctx, input),
      overflowTopMargin: CONTINUATION_TOP_MARGIN,
    },
    ...(config.pageFooter ? { pageFooterSpec: { kind: "pageNofM" as const } } : {}),
  };
}
