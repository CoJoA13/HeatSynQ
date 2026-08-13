/**
 * The traveler — the paper that rides with the work (design spec §10).
 *
 * Three layers, deliberately separated:
 *
 *   collectTravelerData()               reads (order + LOCKED revision + lead part + settings + barcode)
 *   buildTravelerDefinition(d, config)  PURE: TravelerData + a backfilled TemplateConfig in,
 *                                       a plain-JSON pdfmake definition out
 *   renderPdf()                         bytes (src/server/pdf/render.ts — the only pdfmake-aware file)
 *
 * The middle layer is the point. Spec §10 made the traveler template *data, not code*, and Phase
 * 7 (Task 7) cashed that promise in: the builder is now a CONFIG-CONSUMER (P7 spec §5.4) — the
 * seeded "Standard" template's config reproduces the Phase 3 paper exactly (the golden-compat
 * gate, tests/traveler.test.ts unchanged), and every knob a template stores (section/field
 * visibility and order, labels, column widths, fonts, formats, the logo slot) is applied here.
 * `buildTravelerDefinition` still performs no I/O, reads no clock, and returns nothing that
 * would not survive `JSON.parse(JSON.stringify(...))` — asserted in tests, not merely intended.
 *
 * Layout mirrors the owner's `docs/samples/2025-aht-orderform-mockup.pdf`, which the owner ruled
 * on 2026-08-03 to BE the build target (spec §3.9 amendment). Deviations from it are individually
 * commented below; there are no silent ones.
 */
import type { Column, Content, TDocumentDefinitions, TableCell } from "pdfmake/interfaces";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { readDetail, trafficSettings } from "./orders";
import { claimOrder } from "./order-locks";
import { getRevision } from "./part-process-steps";
import { listPartInspections } from "./part-inspections";
import { listAddresses } from "./customer-addresses";
import { getSetting } from "./settings";
import { renderPdf, barcodePng, pngDataUri, jpegDataUri, LAYOUT } from "./pdf/render";
import { storeDocument, listDocumentsForOrder, documentFilename, assertPrintable } from "./documents";
import { resolveTemplateForPrint } from "./template-assignments";
import { TRAVELER_CONTRACT, DEFAULT_CONFIG as TRAVELER_DEFAULT_CONFIG } from "../lib/template-contracts/traveler";
import {
  completeSections,
  type FontsConfig, type FormatsConfig, type LogoPlacement, type SectionConfig,
  type TemplateConfig,
} from "../lib/template-contracts/types";

// Re-exported unchanged: `src/app/api/orders/[id]/documents/route.ts` and this file's own tests
// depend on `getDocument` living at this import path. Phase 4 Task 3 moved its implementation
// (and the storage it shares with shipping tickets, BOLs and certifications) to documents.ts —
// see the "Stored documents" section below for `listDocuments`, the other half of that surface.
export { getDocument } from "./documents";

// ---------------------------------------------------------------------------------------------
// TravelerData — the builder's whole input. Plain data by construction: no Decimals, no Dates,
// no Prisma rows, nothing that needs a database to interpret.
// ---------------------------------------------------------------------------------------------

export type TravelerLine = {
  qty: number; partNumber: string; partName: string; description: string;
  eachWeight: number | null; lineWeight: number;
};
export type TravelerContainer = {
  typeName: string; count: number; qty: number | null;
  tareWeight: number | null; grossWeight: number | null;
};
export type TravelerInspection = {
  code: string; scale: string | null; min: number | null; max: number | null;
  sampleQty: string; location: string;
};
export type TravelerStepValue = { label: string; value: string; unit: string | null };
export type TravelerStep = {
  position: number; codeName: string; instruction: string; values: TravelerStepValue[];
};
/** One printed sheet-set: the mockup's header carries a load number, and the load's own numbers
 *  replace the order-wide ones in the quantity row. */
export type TravelerSheet = { loadNumber: number | null; loadQty: number | null; loadWeight: number | null };

export type TravelerData = {
  orderNumber: number;
  // No PO number: the mockup carries none, and the mockup IS the build target (spec §3.9a). The
  // PO lives on the order hub; adding a field to controlled shop paper is not this task's call.
  customerName: string;
  /** Received-from address lines, already assembled; empty when the customer has none. */
  receivedFrom: string[];
  company: { name: string; address: string; phone: string };
  /** `data:image/png;base64,…` — Code 128 over the bare order number (spec §10). */
  barcodeDataUri: string;
  lines: TravelerLine[];
  orderQty: number;
  orderWeight: number;
  containers: TravelerContainer[];
  materialName: string;
  /** The lead part's `processName` (Phase 7 ruling 4, P7 spec §5.7): presentation vocabulary the
   *  Process: slot binds LIVE at render — read fresh from the part on every print, never locked
   *  with the revision. Blank ("") prints nothing, exactly the Phase 3 blank-slot ruling. */
  processName: string;
  /** The lead part number: the shop's process identity for this order (spec §3.1/§10). */
  processId: string;
  inspections: TravelerInspection[];
  /** The LOCKED revision — historical, never the part's current working revision. Governs
   *  `steps`; deliberately NOT printed (owner ruling 2026-08-03, see `processRow`), and kept on
   *  the payload because it is what makes `steps` interpretable to any future template. */
  revisionNumber: number | null;
  steps: TravelerStep[];
  sheets: TravelerSheet[];
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, config-driven (P7 spec §5.4's per-file formatting helper), and shared by
// every cell so one number never renders two ways.
// ---------------------------------------------------------------------------------------------

/** At most 2 decimals, trailing zeros dropped, thousands grouped per the config's ONE format
 *  knob (the traveler's contract declares only `thousandsSeparator` — it prints no date and no
 *  price). Default true reproduces the mockup's own style ("4,500", "33,750", "13.5"). Locale
 *  pinned so the output never tracks the server's. */
function makeNum(formats: FormatsConfig): (value: number | null | undefined) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => value === null || value === undefined
    ? "" : value.toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping });
}

/** `Label: value unit`, the mockup's step-value line ("Furnace Temp: 1650 °F"). */
function valueLine(v: TravelerStepValue): string {
  return `${v.label}: ${v.value}${v.unit ? ` ${v.unit}` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// The config lens (P7 spec §5.4). The builder ASSUMES a complete config — `validateConfig`'s
// §5.3 backfill guarantees every section and field entry exists, so nothing here re-defaults a
// missing entry (re-defaulting would hide a broken caller). What IS resolved here is the two
// null-means-contract-default knobs a complete config still carries: `label: null` → the
// contract's defaultLabel, `width: null` → the contract column's defaultWidth.
//
// THE §5.6 BUILDER-SIDE BELT: a non-hideable section (steps, header) and a non-removable field
// (the typed step fields, the barcode) render REGARDLESS of what the config's visible flags say.
// The validator refuses such configs at save time, but the builder does not trust that alone —
// belt in the builder, no logging, just render them (spec §5.6's defense in depth).
// ---------------------------------------------------------------------------------------------

const CONTRACT_SECTIONS = new Map(TRAVELER_CONTRACT.sections.map((s) =>
  [s.key, { section: s, fields: new Map(s.fields.map((f) => [f.key, f])) }] as const));

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
  if (cs === undefined) throw new Error(`Unknown traveler template section "${sc.key}"`);
  const byKey = new Map(sc.fields.map((f) => [f.key, f]));
  return {
    visible: sc.visible || !cs.section.hideable, // the belt, section half
    order: sc.fields.map((f) => f.key),
    field: (key) => {
      const cf = cs.fields.get(key);
      if (cf === undefined) throw new Error(`Unknown traveler template field "${sc.key}.${key}"`);
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
  d: TravelerData;
  fonts: FontsConfig;
  num: (value: number | null | undefined) => string;
  sections: Map<string, SectionView>;
  /** Present only when the resolved version carries logo BYTES and the config PLACES them
   *  (spec §6.3) — either alone renders today's text-only header. */
  logo: { placement: LogoPlacement; width: number; dataUri: string } | null;
};

/** This section's visible column-field keys, in config order — what a table renderer turns into
 *  its `widths` and its per-row cells. */
function columnKeys(v: SectionView, sectionKey: string): string[] {
  const cs = CONTRACT_SECTIONS.get(sectionKey)!;
  return v.order.filter((k) => cs.fields.get(k)?.column !== undefined && v.field(k).visible);
}

// ---------------------------------------------------------------------------------------------
// buildTravelerDefinition — PURE.
// ---------------------------------------------------------------------------------------------

// Table layouts are referenced BY NAME (src/server/pdf/render.ts registers the drawing code).
// An inline layout object would put callbacks in the definition, and a definition carrying
// functions is not data — see render.ts's LAYOUT comment and the purity test.

const head = (text: string, colSpan?: number): TableCell =>
  ({ text, bold: true, alignment: "center", ...(colSpan ? { colSpan } : {}) });
const cell = (text: string): TableCell => ({ text, alignment: "center" });
/** A drawn square rather than "☐": a glyph would depend on the font actually carrying U+2610. */
const checkbox = (): TableCell => ({
  canvas: [{ type: "rect", x: 0, y: 0, w: 10, h: 10, lineWidth: 0.8 }], margin: [14, 2, 0, 0],
});

/**
 * Header: three structural slots (left/center/right), hand-laid on the mockup. Config field
 * ORDER applies WITHIN each slot (the left stack's two fields, the center stack's three, the
 * right block's two number columns) — the slots themselves are the builder's layout, not a
 * per-field knob, so a field never migrates between columns (documented mapping decision).
 *
 * The customer line's 9.5pt is the mockup's own size — between the base and heading roles,
 * covered by neither knob, so it stays the builder's literal.
 *
 * A placed logo (spec §6.3) joins the TOP of its slot's stack at its configured width; the
 * stack reflows the slot's text beneath it. No logo → today's text-only header, byte-for-byte.
 */
function headerBlock(ctx: Ctx, sheet: TravelerSheet): Content {
  const { d } = ctx;
  const v = ctx.sections.get("header")!;
  const pick = (keys: string[]): string[] =>
    v.order.filter((k) => keys.includes(k) && v.field(k).visible);

  const left: Content[] = [];
  for (const key of pick(["customer_name", "received_from"])) {
    if (key === "customer_name") left.push({ text: d.customerName, bold: true, fontSize: 9.5 });
    else left.push(...d.receivedFrom.map((line): Content => ({ text: line })));
  }

  // Pre-Phase-7 the company block stood in for the missing logo; with §6.3 the logo is ADDITIVE
  // (unshifted below) — a template wanting a logo-ONLY center hides the company fields.
  const center: Content[] = [];
  for (const key of pick(["company_name", "company_address", "company_phone"])) {
    if (key === "company_name") center.push({ text: d.company.name, bold: true, fontSize: ctx.fonts.headingSize });
    else if (key === "company_address") center.push({ text: d.company.address });
    else center.push({ text: d.company.phone });
  }

  const right: Content[] = [];
  const numberCols = pick(["order_number", "load_number"]);
  if (numberCols.length > 0) {
    right.push({
      columns: numberCols.map((key): Column => key === "order_number"
        ? { width: "*", text: v.field(key).label, bold: true, alignment: "center" }
        : { width: 44, text: v.field(key).label, bold: true, alignment: "center" }),
    });
    right.push({
      columns: numberCols.map((key): Column => key === "order_number"
        ? { width: "*", text: String(d.orderNumber), alignment: "center" }
        : { width: 44, text: sheet.loadNumber === null ? "—" : String(sheet.loadNumber), alignment: "center" }),
    });
  }
  // The barcode renders REGARDLESS of config — the §5.6 belt (BARCODE_LOCK's builder half).
  right.push({ image: d.barcodeDataUri, width: 186, height: 44, margin: [0, 4, 0, 0] });

  if (ctx.logo !== null) {
    const node: Content = { image: ctx.logo.dataUri, width: ctx.logo.width };
    if (ctx.logo.placement === "header-left") left.unshift(node);
    else if (ctx.logo.placement === "header-center") center.unshift(node);
    else right.unshift(node);
  }

  return {
    columns: [
      { width: "*", stack: left },
      { width: "*", alignment: "center", stack: center },
      { width: 190, stack: right },
    ],
    columnGap: 10,
    margin: [0, 0, 0, 8],
  };
}

function linesTable(ctx: Ctx): Content | null {
  const { d, num } = ctx;
  const v = ctx.sections.get("lines")!;
  const cols = columnKeys(v, "lines");
  if (cols.length === 0) return null; // a zero-column table is not a table

  const cellFor = (key: string, l: TravelerLine): TableCell => {
    switch (key) {
      case "line_qty": return cell(num(l.qty));
      // One cell, slash-joined, exactly as the mockup prints it.
      case "line_part": return cell([l.partNumber, l.partName, l.description].filter((p) => p !== "").join(" / "));
      case "line_each_weight": return cell(num(l.eachWeight));
      case "line_weight": return cell(num(l.lineWeight));
      default: return cell("");
    }
  };

  return {
    table: {
      headerRows: 1,
      widths: cols.map((k) => v.field(k).width),
      body: [
        cols.map((k) => head(v.field(k).label)),
        ...d.lines.map((l): TableCell[] => cols.map((k) => cellFor(k, l))),
      ],
    },
    layout: LAYOUT.ruled,
  };
}

/**
 * Order Quantity · Load Quantity · Containers.
 *
 * `Container Quantity` is the number of CONTAINERS (`OrderContainer.count`) — the mockup's own
 * meaning: 8 drop pans + 12 bins against a 4,500-piece order, which is neither a per-container
 * nor a total piece count. `OrderContainer.qty` (pieces per container) has no column of its own
 * on the mockup, so it rides as a second line inside the Container cell rather than being
 * dropped; it is real data the shop keys and the floor uses.
 *
 * Gross weight is a single figure for the whole set, as on the mockup. It is the SUM of the
 * containers' stored gross weights when every container carries one, and otherwise the mockup's
 * own arithmetic — order weight + total tare (60,750 + 6,764 = 67,514 there). Summing partial
 * data would silently under-report, which on a shipping document is worse than deriving.
 */
function quantityTable(ctx: Ctx, sheet: TravelerSheet): Content | null {
  const { d, num } = ctx;
  const v = ctx.sections.get("quantities")!;
  const cols = columnKeys(v, "quantities");
  if (cols.length === 0) return null;

  const rows = d.containers.length > 0 ? d.containers : [null];
  const tareTotal = d.containers.reduce((sum, c) => sum + (c.tareWeight ?? 0), 0);
  const grossTotal = d.containers.length > 0 && d.containers.every((c) => c.grossWeight !== null)
    ? d.containers.reduce((sum, c) => sum + (c.grossWeight ?? 0), 0)
    : d.orderWeight + tareTotal;

  const spanned = (text: string): TableCell => ({ text, alignment: "center", rowSpan: rows.length });

  const cellFor = (key: string, c: TravelerContainer | null, i: number): TableCell => {
    switch (key) {
      case "order_qty": return i === 0 ? spanned(num(d.orderQty)) : {};
      case "load_qty": return i === 0 ? {
        alignment: "center", rowSpan: rows.length,
        stack: [
          { text: sheet.loadQty === null ? "" : num(sheet.loadQty) },
          // The split is weight-capped as often as it is piece-capped (spec §5.4), so the
          // load's own weight rides under its piece count rather than being dropped — the
          // same treatment the Container cell gives pieces-per-container.
          ...(sheet.loadWeight === null
            ? [] : [{ text: `${num(sheet.loadWeight)} lb`, fontSize: ctx.fonts.smallSize, color: "#444444" }]),
        ],
      } : {};
      case "container": return c === null ? cell("") : {
        alignment: "center",
        stack: [
          { text: c.typeName },
          ...(c.qty === null ? [] : [{ text: `${num(c.qty)} per container`, fontSize: ctx.fonts.smallSize, color: "#444444" }]),
        ],
      };
      case "container_qty": return cell(c === null ? "" : num(c.count));
      case "tare_weight": return cell(c === null ? "" : num(c.tareWeight));
      case "gross_weight": return i === 0 ? spanned(d.containers.length === 0 ? "" : num(grossTotal)) : {};
      default: return cell("");
    }
  };

  return {
    table: {
      headerRows: 1,
      widths: cols.map((k) => v.field(k).width),
      body: [
        cols.map((k) => head(v.field(k).label)),
        ...rows.map((c, i): TableCell[] => cols.map((k) => cellFor(k, c, i))),
      ],
    },
    layout: LAYOUT.ruled,
  };
}

/**
 * Process / Material / Process ID — label/value pairs in one hand-laid table (no per-column
 * width knob; each pair keeps the builder's own label width). Config order and visibility apply
 * per PAIR; a label override replaces the pair's label cell.
 *
 * **The Process: slot binds `d.processName` — Phase 7 ruling 4 (P7 spec §5.7), closing the
 * Phase 3 owner ruling (2026-08-03, spec §3.9 amendment) that deliberately left it BLANK.** The
 * mockup prints a process NAME there ("Austemper") and the Phase 3 data model had no such field;
 * every stand-in (the part name, an assembled step-code name, the locked revision) answered a
 * different question than the label asks, so the slot stayed empty and Phase 7 was ruled its
 * owner. `Part.processName` is that owner's answer: presentation vocabulary, read LIVE from the
 * lead part at render — blank prints nothing, exactly the Phase 3 behavior. The locked revision
 * is still carried on TravelerData (and governs `steps`) — it is still not printed here.
 */
function processRow(ctx: Ctx): Content | null {
  const { d } = ctx;
  const v = ctx.sections.get("process")!;
  const PAIRS: Record<string, { labelWidth: number; value: string }> = {
    process: { labelWidth: 50, value: d.processName },
    material: { labelWidth: 50, value: d.materialName },
    process_id: { labelWidth: 56, value: d.processId },
  };
  const keys = v.order.filter((k) => k in PAIRS && v.field(k).visible);
  if (keys.length === 0) return null;

  return {
    table: {
      widths: keys.flatMap((k): (number | "*")[] => [PAIRS[k].labelWidth, "*"]),
      body: [keys.flatMap((k): TableCell[] => [
        { text: v.field(k).label, bold: true, alignment: "center" }, cell(PAIRS[k].value),
      ])],
    },
    layout: LAYOUT.ruled,
  };
}

/**
 * Key Characteristic Inspection(s).
 *
 * Two deviations from the mockup, both forced:
 *  - the first column's header reads "Inspection", not "Hardness". On the mockup that header
 *    cell holds a DATA value (the first inspection's code name), which cannot generalise to an
 *    arbitrary set of inspection codes.
 *  - the mockup's `{Inspection Location.bmp}` slot renders nothing. Owner ruling 2026-08-03
 *    (spec §3.9c): no inspection-location images in Phase 3 — Phase 4/7 owns image handling.
 *    `PartInspection.location`'s TEXT still prints, in the last column.
 */
function inspectionsBlock(ctx: Ctx): Content | null {
  const { d, num } = ctx;
  const v = ctx.sections.get("inspections")!;
  const title = v.field("inspections_title");
  const cols = columnKeys(v, "inspections");
  if (cols.length === 0 && !title.visible) return null;

  const cellFor = (key: string, i: TravelerInspection): TableCell => {
    switch (key) {
      case "inspection_code": return { text: i.code, bold: true };
      case "inspection_scale": return cell(i.scale ?? "");
      case "inspection_min": return cell(num(i.min));
      case "inspection_max": return cell(num(i.max));
      case "inspection_qty": return cell(i.sampleQty);
      case "inspection_location": return cell(i.location);
      default: return cell("");
    }
  };

  const body: TableCell[][] = [
    cols.map((k) => head(v.field(k).label)),
    ...d.inspections.map((i): TableCell[] => cols.map((k) => cellFor(k, i))),
  ];
  if (d.inspections.length === 0) body.push(cols.map(() => cell("")));

  return {
    table: {
      widths: ["*"],
      body: [[{
        stack: [
          ...(title.visible
            ? [{ text: title.label, bold: true, alignment: "center" as const, margin: [0, 0, 0, 3] as [number, number, number, number] }]
            : []),
          ...(cols.length > 0
            ? [{ table: { widths: cols.map((k) => v.field(k).width), body }, layout: "noBorders" }]
            : []),
        ],
      }]],
    },
    layout: LAYOUT.boxed,
    margin: [0, 0, 0, 6],
  };
}

/**
 * PROCESS STEPS — position, code name, instruction + typed values (def order, units included),
 * and the EQ# / OP / Date handwriting boxes the floor fills in by hand (there is no shop-floor
 * tracking, by decision — spec §10).
 *
 * LOCKED WHOLE (P7 spec §5.6, the §15 Step-fields ruling): the section and its typed-field
 * columns render regardless of the config's visible flags — `sectionView`'s belt forces them,
 * so only the removable pieces (the title text, the handwriting boxes) actually answer to the
 * config. The typed step VALUES render inside the instruction column unconditionally: they are
 * a locked rendering, not a column of their own.
 *
 * The "PROCESS STEPS:" title cell spans the leading run of content columns (position/code/
 * instruction) — under the default order that is exactly the mockup's colSpan-3 cell; a config
 * that interleaves a handwriting column into that run gets plain empty header cells for the
 * content columns past the title's run instead of a broken span.
 */
const STEP_CONTENT_COLS = new Set(["step_position", "step_code", "step_instruction"]);

function stepsTable(ctx: Ctx): Content {
  const { d } = ctx;
  const v = ctx.sections.get("steps")!;
  const title = v.field("steps_title");
  const cols = columnKeys(v, "steps");

  const headerCells: TableCell[] = [];
  let i = 0;
  let titleDone = false;
  while (i < cols.length) {
    if (STEP_CONTENT_COLS.has(cols[i])) {
      let run = 1;
      while (i + run < cols.length && STEP_CONTENT_COLS.has(cols[i + run])) run++;
      if (!titleDone) {
        headerCells.push({
          text: title.visible ? title.label : "", bold: true, alignment: "center",
          ...(run > 1 ? { colSpan: run } : {}),
        });
        for (let j = 1; j < run; j++) headerCells.push({});
        titleDone = true;
      } else {
        for (let j = 0; j < run; j++) headerCells.push(head(""));
      }
      i += run;
    } else {
      headerCells.push(head(v.field(cols[i]).label));
      i++;
    }
  }

  const stepCell = (key: string, s: TravelerStep): TableCell => {
    switch (key) {
      case "step_position": return { text: String(s.position), bold: true };
      case "step_code": return { text: s.codeName, bold: true };
      case "step_instruction": return {
        stack: [
          ...(s.instruction === "" ? [] : [{ text: s.instruction }]),
          ...s.values.map((val) => ({ text: valueLine(val) })),
        ],
      };
      default: return { text: "" }; // the handwriting boxes
    }
  };
  const blank: TableCell[] = cols.map((k) => k === "step_instruction"
    ? { text: "The locked revision carries no steps.", italics: true }
    : { text: "" });

  return {
    table: {
      headerRows: 1,
      widths: cols.map((k) => v.field(k).width),
      body: [
        headerCells,
        ...(d.steps.length > 0 ? d.steps.map((s) => cols.map((k) => stepCell(k, s))) : [blank]),
      ],
    },
    layout: LAYOUT.steps,
    margin: [0, 0, 0, 6],
  };
}

/**
 * RESULTS / TEMPERED RESULTS / FINAL INSPECTION PASS-FAIL / Tested By / OK to Ship. All
 * handwriting areas — the traveler comes back marked up.
 *
 * Config mapping (a hand-laid signature block, so fields group into the ROWS they anchor):
 * `results` is the left box; the right column's row groups are tempered_results (its header +
 * the 92pt writing row), final_inspection, pass/fail (one shared row), tested_by/tested_date,
 * ok_to_ship/ship_date. A group renders when ANY of its fields is visible (a hidden half leaves
 * an empty spanned cell so its sibling keeps its place), groups order by the EARLIEST config
 * position among their visible fields, and a group with nothing visible drops — heights follow
 * their rows. The left box keeps its hand-tuned 151pt (level with the DEFAULT right column;
 * pdfmake cannot say "match my sibling", so a template hiding right-column rows accepts the
 * mismatch it configured).
 */
function footerBlocks(ctx: Ctx): Content | null {
  const v = ctx.sections.get("footer")!;
  const f = v.field;
  const label = (text: string): TableCell => ({ text, bold: true, colSpan: 2 });
  const labelHalf = (key: string): TableCell[] =>
    f(key).visible ? [label(f(key).label), {}] : [{ text: "", colSpan: 2 }, {}];

  type Group = { members: string[]; build: () => { rows: TableCell[][]; heights: ("auto" | number)[] } };
  const groups: Group[] = [
    {
      members: ["tempered_results"],
      build: () => ({
        rows: [
          [head(f("tempered_results").label, 4), {}, {}, {}],
          [{ text: "", colSpan: 4 }, {}, {}, {}] as TableCell[],
        ],
        heights: ["auto", 92],
      }),
    },
    {
      members: ["final_inspection"],
      build: () => ({ rows: [[head(f("final_inspection").label, 4), {}, {}, {}]], heights: ["auto"] }),
    },
    {
      members: ["pass", "fail"],
      build: () => {
        const order = v.order.filter((k) => (k === "pass" || k === "fail") && f(k).visible);
        const cells: TableCell[] = order.flatMap((k) => [head(f(k).label), checkbox()]);
        while (cells.length < 4) cells.push({ text: "" });
        return { rows: [cells], heights: ["auto"] };
      },
    },
    {
      members: ["tested_by", "tested_date"],
      build: () => ({ rows: [[...labelHalf("tested_by"), ...labelHalf("tested_date")]], heights: ["auto"] }),
    },
    {
      members: ["ok_to_ship", "ship_date"],
      build: () => ({ rows: [[...labelHalf("ok_to_ship"), ...labelHalf("ship_date")]], heights: ["auto"] }),
    },
  ];

  const active = groups
    .map((g) => ({ g, at: Math.min(...g.members.filter((k) => f(k).visible).map((k) => v.order.indexOf(k))) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at);
  const rows: TableCell[][] = [];
  const heights: ("auto" | number)[] = [];
  for (const { g } of active) {
    const built = g.build();
    rows.push(...built.rows);
    heights.push(...built.heights);
  }

  const columns: Column[] = [];
  if (f("results").visible) {
    columns.push({
      width: "*",
      table: {
        widths: ["*"],
        // Hand-tuned so the RESULTS box ends level with the right column's last row. pdfmake
        // gives no way to say "match my sibling's height", and a mismatch is the one thing that
        // makes this footer look wrong on paper. Re-measure if the right column gains a row.
        heights: ["auto", 151],
        body: [[head(f("results").label)], [{ text: "" }]],
      },
      layout: LAYOUT.boxed,
    });
  }
  if (rows.length > 0) {
    columns.push({
      width: "*",
      table: { widths: ["*", 34, "*", 34], heights, body: rows },
      layout: LAYOUT.boxed,
    });
  }
  if (columns.length === 0) return null;

  return { columns, columnGap: 0 };
}

/** One config section key → its renderer. `null` from a renderer means "nothing left to draw"
 *  (every configurable piece hidden) — the block is dropped from the stack, like a hidden
 *  section. An unknown key returns null: the validator refused it before any config stored it. */
function renderSection(key: string, ctx: Ctx, sheet: TravelerSheet): Content | null {
  switch (key) {
    case "header": return headerBlock(ctx, sheet);
    case "lines": return linesTable(ctx);
    case "quantities": return quantityTable(ctx, sheet);
    case "process": return processRow(ctx);
    case "inspections": return inspectionsBlock(ctx);
    case "steps": return stepsTable(ctx);
    case "footer": return footerBlocks(ctx);
    default: return null;
  }
}

/**
 * The traveler builder, a CONFIG-CONSUMER since Phase 7 Task 7 (P7 spec §5.4). PURE — data and
 * config in, JSON out; no I/O, no clock.
 *
 * `config` is a **backfilled** `TemplateConfig` (what `resolveTemplateForPrint` returns — the
 * §5.3 backfill means every section/field entry and every knob is present, so this builder never
 * re-defaults a missing entry). It DEFAULTS to the contract's own `DEFAULT_CONFIG` — the same
 * complete object the seeded "Standard" template stores — so a config-less call renders exactly
 * today's paper: that keeps the pre-Phase-7 test suite calling `buildTravelerDefinition(data)`
 * green UNCHANGED (the golden-compat gate) without re-defaulting any individual key.
 *
 * `logoDataUri` is a deliberate THIRD parameter, not a TravelerData field: TravelerData is what
 * `readTravelerData` assembles from the ORDER, while the logo bytes belong to the resolved
 * template version — the print path converts them (`pngDataUri`/`jpegDataUri` by the stored
 * `logoMimeType`) and passes them alongside the config they arrived with. It only renders when
 * the config also PLACES a logo (spec §6.3).
 *
 * `config.pageFooter` is deliberately NOT consumed yet: the traveler's contract pins it false
 * (golden compat — no Phase 3 traveler prints one), and Task 8's per-load sheet groups own the
 * traveler's page-number/continuation story (#36/#43).
 *
 * One sheet-set per load, all in ONE document: printing an order prints every load's paperwork
 * as a single PDF, and printing load N prints just that one (`sheets` is already filtered by
 * `collectTravelerData`).
 */
export function buildTravelerDefinition(
  input: TravelerData,
  config: TemplateConfig = TRAVELER_DEFAULT_CONFIG,
  logoDataUri?: string,
): TDocumentDefinitions {
  // The belt's OMISSION half (Task 8 pre-step): resolve the views over the config's lists MERGED
  // with the contract's key list — a config that omits a locked entry (rather than flag-flipping
  // it, which sectionView's belt already catches) still renders it. See completeSections.
  const sectionConfigs = completeSections(TRAVELER_CONTRACT, config.sections);
  const sections = new Map(sectionConfigs.map((sc) => [sc.key, sectionView(sc)] as const));
  const ctx: Ctx = {
    d: input,
    fonts: config.fonts,
    num: makeNum(config.formats),
    sections,
    logo: config.logo !== null && logoDataUri !== undefined
      ? { placement: config.logo.placement, width: config.logo.width, dataUri: logoDataUri }
      : null,
  };

  const content: Content[] = [];
  for (const [index, sheet] of input.sheets.entries()) {
    const blocks: Content[] = [];
    // Stack order IS the config's section order; hidden sections are omitted — except the
    // §5.6-locked ones, whose views the belt forces visible (see sectionView).
    for (const sc of sectionConfigs) {
      if (!sections.get(sc.key)!.visible) continue;
      const block = renderSection(sc.key, ctx, sheet);
      if (block !== null) blocks.push(block);
    }
    content.push({
      // Page break BEFORE every sheet but the first — never a trailing blank page.
      ...(index === 0 ? {} : { pageBreak: "before" as const }),
      stack: blocks,
    });
  }
  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, 24],
    defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
    // No `info.creationDate`, no header/footer clock: a definition that embedded "now" would make
    // two prints of the same order differ for no reason, and would break this builder's purity.
    content,
  };
}

// ---------------------------------------------------------------------------------------------
// collectTravelerData — the reads.
// ---------------------------------------------------------------------------------------------

/**
 * Every SETTING the traveler needs, read in one place so `readTravelerData` below performs no
 * setting reads of its own (fix-wave R4 finding 8).
 *
 * Settings are read-only, take no `tx`, and are not order state — nothing about a print's
 * correctness depends on reading them at the same instant as the order — so they are read BEFORE
 * the print transaction opens, exactly as `createOrder` already reads `request_days_default` and
 * the traffic thresholds ahead of its own. Doing otherwise would mean holding the print's
 * connection while waiting on four more round trips, for no gain in what the paper says.
 */
export type TravelerSettings = {
  traffic: Awaited<ReturnType<typeof trafficSettings>>;
  company: { name: string; address: string; phone: string };
};

export async function travelerSettings(): Promise<TravelerSettings> {
  const [traffic, name, address, phone] = await Promise.all([
    trafficSettings(),
    getSetting("company_name"),
    getSetting("company_address"),
    getSetting("company_phone"),
  ]);
  return { traffic, company: { name, address, phone } };
}

/**
 * Assembles a print payload for one order (every load) or one load of it, reading EVERYTHING
 * through `db`.
 *
 * Fix-wave R4 finding 8: this used to run against the top-level `prisma` client while
 * `printTraveler`'s transaction held a connection of its own — six reads plus the ~100 ms render,
 * all on a second pooled connection borrowed from inside a transaction. Under concurrent prints
 * that is a pool-starvation shape: each in-flight print holds one connection idle and competes for
 * another, and if the pool empties every holder waits on a connection only another holder can
 * release. Threading `db` also makes the reads mean what the surrounding claim already promised —
 * they now see the same transaction snapshot the claim was taken in, rather than whatever
 * committed between the claim and each individual query.
 *
 * The claim: between the print transaction's open and its commit there is NO query against the
 * top-level client. `readDetail` takes the client (as `getOrder` has always shown), and
 * `listAddresses`/`listPartInspections`/`getRevision` each gained the same trailing `db`
 * parameter; settings moved out of the transaction entirely (`travelerSettings` above). The reads
 * are sequential rather than `Promise.all`'d: on ONE connection they are serialized regardless,
 * and issuing them concurrently is what makes @prisma/adapter-pg's `performIO` overlap calls on a
 * single connection and emit node-postgres' own deprecation warning (tests/helpers/setup.ts
 * documents the same threshold for `readDetail`'s relation loads).
 *
 * Reads the LOCKED revision via `getRevision(leadPartId, lockedRevisionNumber)` — never the
 * part's current working revision. That is the whole point of locking at save (spec §5.3): a
 * traveler reprinted after the recipe changed must still say what the shop actually ran.
 *
 * Line parts are read here in ONE query rather than through `getPart` per line: the traveler
 * needs the same three fields (description, each-weight, material) for every line, and `getPart`
 * both fires a second per-part revision query and 404s a part an order may legitimately still
 * reference. Inspections still come from the parts service (`listPartInspections`).
 */
export async function readTravelerData(
  db: Prisma.TransactionClient, orderId: string, settings: TravelerSettings, loadNumber?: number,
): Promise<TravelerData> {
  const order = await readDetail(db, orderId, settings.traffic); // 404s a missing order
  const lead = order.lines[0];
  if (!lead) throw new HttpError(400, "This order has no part lines to print");

  const parts = await db.part.findMany({
    // Deliberately unfiltered on deletedAt: the order references these parts and the paper
    // has to name them, whatever has happened to the catalog since.
    where: { id: { in: order.lines.map((l) => l.partId) } },
    select: { id: true, partNumber: true, name: true, description: true, eachWeight: true,
      processName: true, material: { select: { name: true } } },
  });
  const customer = await db.customer.findFirst({ where: { id: order.customerId }, select: { name: true } });
  const addresses = await listAddresses(order.customerId, undefined, db);
  const inspectionRows = await listPartInspections(lead.partId, db);
  const revision = lead.revisionNumber === null
    ? null : await getRevision(lead.partId, lead.revisionNumber, db);
  // The one remaining non-database read, and the only reason this is not a pure function: PNG
  // encoding, no connection involved.
  const barcode = await barcodePng(String(order.orderNumber));
  const { name: companyName, address: companyAddress, phone: companyPhone } = settings.company;

  const partById = new Map(parts.map((p) => [p.id, p]));
  const leadPart = partById.get(lead.partId);

  // The default received-from address, else the first one on file. Street and city/state/zip
  // only — the mockup's Ph/Fx lines have no `CustomerAddress` columns behind them (phone lives
  // on CustomerContact, which is a person, not a site), so they are not printed.
  const receivedFromRows = addresses.filter((a) => a.kind === "RECEIVED_FROM");
  const site = receivedFromRows.find((a) => a.isDefault) ?? receivedFromRows[0] ?? null;
  const cityLine = site ? [site.city, [site.state, site.zip].filter(Boolean).join(" ")]
    .filter((p) => p !== "").join(", ") : "";
  const receivedFrom = site ? [site.street, cityLine].filter((line) => line !== "") : [];

  const allSheets: TravelerSheet[] = order.loads.map((l) => (
    { loadNumber: l.loadNumber, loadQty: l.qty, loadWeight: l.weight }));
  let sheets = allSheets;
  if (loadNumber !== undefined) {
    sheets = allSheets.filter((s) => s.loadNumber === loadNumber);
    if (sheets.length === 0) throw new HttpError(404, `This order has no load ${loadNumber}`);
  }
  // An order with no loads at all still prints one sheet — the paper is what the shop works
  // from, and refusing to print it would be a worse answer than a blank Load box.
  if (sheets.length === 0) sheets = [{ loadNumber: null, loadQty: null, loadWeight: null }];

  return {
    orderNumber: order.orderNumber,
    customerName: customer?.name ?? "",
    receivedFrom,
    company: { name: companyName, address: companyAddress, phone: companyPhone },
    barcodeDataUri: pngDataUri(barcode),
    lines: order.lines.map((l) => {
      const part = partById.get(l.partId);
      return {
        qty: l.qty,
        partNumber: part?.partNumber ?? l.part.partNumber,
        partName: part?.name ?? l.part.name,
        description: part?.description ?? "",
        eachWeight: part ? part.eachWeight.toNumber() : null,
        lineWeight: l.weight,
      };
    }),
    orderQty: order.lines.reduce((sum, l) => sum + l.qty, 0),
    orderWeight: order.lines.reduce((sum, l) => sum + l.weight, 0),
    containers: order.containers.map((c) => ({
      typeName: c.type.name, count: c.count, qty: c.qty,
      tareWeight: c.tareWeight, grossWeight: c.grossWeight,
    })),
    materialName: leadPart?.material?.name ?? "",
    // LIVE, not locked (ruling 4, P7 spec §5.7): the slot always says what the part says TODAY —
    // presentation vocabulary, deliberately outside the locked revision's freeze.
    processName: leadPart?.processName ?? "",
    processId: leadPart?.partNumber ?? lead.part.partNumber,
    inspections: inspectionRows.map((i) => ({
      code: i.inspectionCodeName, scale: i.scaleName, min: i.min, max: i.max,
      sampleQty: i.sampleQty, location: i.location,
    })),
    revisionNumber: revision?.revisionNumber ?? null,
    steps: (revision?.steps ?? []).map((s) => ({
      position: s.position, codeName: s.codeName, instruction: s.instruction,
      values: s.values.map((v) => ({ label: v.label, value: v.value, unit: v.unit })),
    })),
    sheets,
  };
}

/**
 * The standalone entry point: same payload, read outside any transaction — the `getOrder` /
 * `readDetail` split in orders.ts, applied here for the same reason. Used by the traveler
 * PREVIEW path and by tests; `printTraveler` calls `readTravelerData` on its own `tx` instead.
 */
export async function collectTravelerData(orderId: string, loadNumber?: number): Promise<TravelerData> {
  return readTravelerData(prisma, orderId, await travelerSettings(), loadNumber);
}

// ---------------------------------------------------------------------------------------------
// Stored documents. Permanent, create-only (spec §4) — there is no delete path at all. The
// storage itself (this section used to own it directly) now lives in documents.ts, shared with
// the shipping ticket, BOL and certification kinds Phase 4 adds; `printTraveler` below and
// `listDocuments`/`getDocument` further down are this file's thin, order-scoped remainder of it.
// ---------------------------------------------------------------------------------------------

/**
 * Renders and archives one traveler, returning the exact bytes stored.
 *
 * Voided orders refuse a NEW print (spec §5c) but keep every earlier print listable and
 * reprintable — `listDocuments`/`getDocument` deliberately do not filter on `deletedAt`
 * (documents.ts's own doc comment).
 *
 * Fix-wave R3 finding 1: the ENTIRE operation — claim, content read, render, archive — now runs
 * inside ONE transaction, claimed with the shared `claimOrder` (order-locks.ts) before anything
 * else happens. Before this, the claim only wrapped the final archive commit (fix-wave R2 finding 4,
 * below): `collectTravelerData` (the read that decides what the PDF says) and `renderPdf` (~100 ms
 * of pure CPU) both ran BEFORE any lock was taken, so a child mutator — `replaceLoads`,
 * `replaceContainers`, a line/serial/charge edit — could claim the SAME row, write, and commit
 * entirely within that unlocked window, and the archive commit that followed would still see the
 * order as "not voided" (the only thing the old claim re-checked) and happily archive the STALE,
 * pre-edit snapshot already rendered. No warning was possible either: from the archive's own
 * point of view nothing was wrong, the document simply didn't exist yet when the stale read
 * happened.
 *
 * `claimOrder`'s (order-locks.ts) row lock now brackets the read too, and every order-family
 * mutator (orders.ts, order-loads.ts, attachments.ts's order-owner writes) opens with the SAME
 * claim on its own transaction — so the two sides properly serialize: whichever gets here first
 * forces the other to wait for its FULL transaction, not just its final write, to finish. A print
 * that wins the race archives the pre-edit state, and the edit — blocked until the print commits —
 * lands cleanly right after, affecting only the next print ("a load edit after printing changes
 * the NEXT print, never the stored one", below). An edit that wins the race commits first, and the
 * print — blocked until the edit commits — reads and archives the POST-edit state once it can
 * proceed. Either way the archived bytes always describe a real, fully-committed state; a torn,
 * mid-edit snapshot is no longer reachable.
 *
 * This does mean the Order row's lock is now held across the render, not just the final insert —
 * accepted deliberately: correctness (no torn snapshot) matters more here than shaving the
 * occasional wait a concurrent claimant on the SAME order might see, and two prints (or a print
 * and an edit) of the same order overlapping in time is not a case this app needs to run fast. The
 * single check below (claim, then decide) also replaces the OLD two-tier check — an unlocked
 * pre-check before the transaction opened, plus the locked re-check inside it — with one: the
 * expensive work (collectTravelerData, renderPdf) still only ever runs after the order is known to
 * exist and be live, so a refusal is exactly as cheap as it always was.
 *
 * Fix-wave R2 finding 4 (superseded in shape, not in substance, by the above): the original in-tx
 * re-check read `deletedAt` with a plain (unlocked) SELECT, which under Postgres MVCC never blocks
 * on anything — so a `voidOrder` call whose own UPDATE committed in the gap between that read and
 * the `storedDocument` insert went unnoticed, and the print archived against an order that was, by
 * the time anyone looked, already voided. Claiming the row with `SELECT … FOR UPDATE` before the
 * re-check closed that gap: `voidOrder`'s own order UPDATE (via `auditedSoftDelete`, in orders.ts —
 * this file performs no mutation of its own since Phase 4 Task 3 moved storage to documents.ts)
 * takes a write lock on the same row at ANY isolation level, the same "a row lock is the right
 * instrument because both sides take it regardless of isolation" guarantee `workingRevision`
 * documents for the process-steps revision claim (part-process-steps.ts) — `claimOrder` is that
 * same claim, generalized into the one instrument every order-family caller now shares.
 */
export async function printTraveler(
  orderId: string, loadNumber?: number,
): Promise<{ documentId: string; orderNumber: number; loadNumber: number | null; pdf: Buffer }> {
  // Fix-wave R4 finding 8: settings first, OUTSIDE the transaction — the `createOrder` precedent.
  // They are read-only, they are not order state, and reading them here means the transaction
  // below never waits on a round trip that has nothing to do with the order it is holding.
  const settings = await travelerSettings();

  const { doc, orderNumber, pdf } = await withDbErrors({ entity: "Order" }, () =>
    prisma.$transaction(async (tx) => {
      const live = await claimOrder(tx, orderId);
      if (!live) throw new HttpError(404, "Order not found");
      assertPrintable(live);

      // Template resolution on THIS claimed transaction, at its DEFAULT isolation — deliberately
      // unchanged (P7 spec §5.1). The resolution is correct at ANY isolation **by immutability,
      // not by locking**: publish commits the immutable published version row and the
      // `publishedVersionId` pointer move atomically, so any committed pointer this read follows
      // yields a complete published config; drafts can never print; and the stamped
      // `templateVersionId` below records exactly which version produced the paper. A print
      // racing a publish may legitimately render with the previous published version — ruling
      // 2's "from that moment" means COMMIT order, not wall clock (accepted-by-design, §5.1).
      // No template row is claimed here and none is needed — do not add one.
      const resolved = await resolveTemplateForPrint(tx, "TRAVELER", live.customerId);
      // Logo bytes → data URI by the STORED mime type (spec §6.3); the builder renders it only
      // when the config also places it, so an unplaced upload converts nothing.
      const logoDataUri = resolved.logoImage !== null && resolved.config.logo !== null
        ? (resolved.logoMimeType === "image/jpeg"
            ? jpegDataUri(Buffer.from(resolved.logoImage))
            : pngDataUri(Buffer.from(resolved.logoImage)))
        : undefined;

      // Only now, with the claim held: the read that decides what the PDF says, and the render
      // itself. Nothing else touching this order's traveler-relevant children can commit until
      // this whole transaction ends — see the fix-wave R3 finding 1 comment above.
      //
      // `readTravelerData(tx, …)`, never `collectTravelerData(…)` (R4 finding 8): every read it
      // performs runs on THIS transaction's connection. The version that called the standalone
      // helper went to the top-level client for all six of them while this transaction sat
      // holding a connection of its own — a pool-starvation shape under concurrent prints, and a
      // snapshot the surrounding claim did not actually cover.
      const data = await readTravelerData(tx, orderId, settings, loadNumber);
      const pdf = await renderPdf(buildTravelerDefinition(data, resolved.config, logoDataUri));

      // Storage itself — permanence, the audit-payload/bytes split, and the `new Uint8Array`
      // conversion — is documents.ts's job now (Phase 4 Task 3); this claim-holding transaction
      // is still the one thing that has to stay HERE, since the archive must land before the
      // claim is released. `resolved.versionId` is the §5.2 stamp.
      const doc = await storeDocument(tx,
        { kind: "TRAVELER", orderId, loadNumber: loadNumber ?? null }, pdf, resolved.versionId);
      return { doc, orderNumber: data.orderNumber, pdf };
    }));

  // `orderNumber`/`loadNumber` ride along purely so the route can name the download without a
  // second read — `getDocument` would pull the whole PDF back out of the database to learn them.
  return { documentId: doc.id, orderNumber, loadNumber: loadNumber ?? null, pdf };
}

/** Every traveler this order has had printed, newest first — the order-scoped view onto
 *  documents.ts's shared store. Kept under this name (rather than `listDocumentsForOrder`
 *  directly) because `src/app/api/orders/[id]/documents/route.ts` and this file's own tests
 *  already depend on it. */
export const listDocuments = listDocumentsForOrder;

/** `traveler-71246.pdf` / `traveler-71246-load-3.pdf` — what the browser tab and any save-as
 *  dialog show. Delegates to documents.ts's shared `documentFilename` (Phase 4 Task 3) rather
 *  than keeping its own copy of the naming rule; the adapter object below carries only what a
 *  TRAVELER filename needs (`kind`, `loadNumber`, and `orderId: null` since the real order
 *  number arrives as the second argument instead) — `id`/`createdAt` are part of `DocumentMeta`
 *  but `documentFilename` never reads them for this kind. */
export function travelerFilename(orderNumber: number, loadNumber: number | null): string {
  return documentFilename(
    { id: "", createdAt: new Date(0), kind: "TRAVELER",
      orderId: null, shipperId: null, certId: null, invoiceId: null, customerId: null, quoteId: null, loadNumber },
    orderNumber,
  );
}
