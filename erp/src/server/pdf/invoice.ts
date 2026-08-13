/**
 * The invoice / credit (P5A design spec §10). PURE by construction, the traveler.ts contract:
 * `InvoicePdfData` + a validated `TemplateConfig` in, a plain-JSON pdfmake definition out — no I/O,
 * no clock, nothing that would not survive `JSON.parse(JSON.stringify())` (asserted in
 * tests/invoice-pdf.test.ts). The reads live in invoices.ts (`readInvoicePdfData`), the bytes in
 * render.ts.
 *
 * A CONFIG-CONSUMER since Phase 7 Task 12 (P7 spec §5.4) — the BOL/cert lens (`sectionView` over
 * `completeSections`, the §5.6 belt in both halves): sections/fields/labels/widths/fonts/formats/
 * logo render from a validated config, and the default config reproduces today's paper exactly (the
 * golden gate, tests/invoice-pdf.test.ts, untouched).
 *
 * **THE FROZEN-PAPER RULE IS THE DEFINING CONSTRAINT** (CLAUDE.md; ruling 24's refinement). This is
 * the OPPOSITE snapshot rule from the cert/shipper: `InvoicePdfData` is built exclusively from the
 * invoice row's FROZEN snapshot columns (invoices.ts's `readInvoicePdfData`), read UNCONDITIONALLY —
 * never re-joined to a live customer address, part name, or re-priced amount. The config controls
 * placement/labels/widths/fonts/formats/logo over that frozen data; a template edit changes future
 * invoices' layout, never a raised invoice's numbers. This builder introduces NO live re-join — it
 * maps config over the frozen data it is handed, and there is no live-join-first-with-fallback
 * branch (a draft edit replaces the whole line array — §5.5 — so there is nothing to fall back to).
 *
 * ONE contract, one builder, BOTH kinds (spec §4.1: `INVOICE` covers credits). The builder is
 * kind-agnostic — "Invoice"/"Credit" is DATA (`title`, off the row's own kind), the credit's
 * negative amounts are what the `negativeStyle` knob formats (ruling 3), and a credit's paper
 * differs only in its number and signs.
 *
 * Layout mirrors the owner's `docs/samples/Invoice Sample.pdf`, which IS the contract (spec §3.1).
 * Deviations are individually commented; there are no silent ones:
 *  - the header logo is Phase 7's (spec §6.3) — off by default (the owner supplied none): a config
 *    that places one joins the centered header stack (center) or a side column (left/right).
 *  - no "Page N of M" by default — a page count is not knowable to a pure-JSON definition, and a
 *    hard-coded "1 of 1" would lie the moment a long invoice wraps (the ticket's/cert's identical
 *    deviation, spec §10, owner ping #1). The `pageFooter` knob (spec §6.1) turns the real per-page
 *    count on when a template wants it.
 *  - **`Process:` prints the create-time `processNames` snapshot** (spec §5.7, ruling 4): the lead
 *    part's `processName` when non-blank, else its priced operations comma-joined — snapshotted at
 *    create in invoices.ts, read here from the frozen column. The builder just prints the string.
 *  - the footer's "Contact: Accounts Receivable" is the sample's own static strip; the trailing
 *    empty "Fax:" label has no field behind it in this model — not printed (the cert's precedent).
 *  - the sample's stray "1" beside "Remit To" and "2827" beside "Shipto" are Visual Shop's internal
 *    row ids (the ticket's ruling on the same artifact) — not printed.
 */
import type { Column, Content, TableCell } from "pdfmake/interfaces";
import { LAYOUT, type RenderableDefinition } from "./render";
import { INVOICE_CONTRACT, DEFAULT_CONFIG } from "../../lib/template-contracts/invoice";
import {
  completeSections,
  type FontsConfig, type FormatsConfig, type LogoPlacement, type SectionConfig,
  type TemplateConfig,
} from "../../lib/template-contracts/types";

// ---------------------------------------------------------------------------------------------
// InvoicePdfData — the builder's whole input. Plain data: no Decimals, no Dates, no Prisma rows.
// `billTo`/`shipTo` are the FROZEN snapshot lines (Invoice.billTo/shipTo, split on newline): an
// invoice is frozen paper (invoices.ts's `toLineDetail` rule), so these are what was billed, never
// a live re-read of the customer's current address. `remitTo` is the plant's own remit address,
// read live from company settings (it is not frozen per-invoice) — see `invoicePrintSettings`.
// The contract maps its fields ONLY onto these frozen columns — do not widen it.
// ---------------------------------------------------------------------------------------------

export type InvoiceCompany = { name: string; address: string; phone: string };
export type InvoiceRemitTo = { name: string; lines: string[] };
export type InvoicePart = {
  qty: number | null; partNumber: string; partName: string; partDescription: string;
  eachWeight: number | null; totalWeight: number | null;
};
/** One priced operation: its name and billed amount, with the per-unit price and the minimum /
 *  setup shown beneath (spec §10's PRICE grid). A null `unitPrice`/`minimumCharge`/`setupCharge`
 *  prints no line for that detail rather than a fabricated "$0.00". `sourceQuoteNumber` is the
 *  Phase 6 tier-1 source (quoting spec §5.3, off `InvoiceLine.sourceQuoteNumber`'s FROZEN
 *  column): when set, "Quote #N" prints beneath the operation — §7.5's "every line names its
 *  source". Absent/null (every part-priced or manual line) prints nothing, keeping those rows
 *  byte-identical to the approved 5A sample. */
export type InvoicePriceRow = {
  description: string; pricePerLabel: string;
  unitPrice: number | null; minimumCharge: number | null; setupCharge: number | null;
  sourceQuoteNumber?: number | null;
  amount: number;
};
/** A named money line — one surcharge/charge, or the single cert/freight/tax row. */
export type InvoiceAmountRow = { description: string; amount: number };
export type InvoicePdfData = {
  company: InvoiceCompany;
  remitTo: InvoiceRemitTo;
  billTo: string[];
  shipTo: string[];
  title: string;                       // "Invoice" or "Credit" — the invoice row's own kind
  documentNumber: string;              // "7 - 72026", or the bare credit number for a CREDIT
  invoiceDate: string;                 // "yyyy-mm-dd" — formatted to the sample's long style below
  termsName: string;
  orderNumber: number;
  poNumber: string;
  materialName: string;
  processNames: string;
  parts: InvoicePart[];
  priceRows: InvoicePriceRow[];
  subtotal: number;
  surchargeRows: InvoiceAmountRow[];
  chargeRows: InvoiceAmountRow[];
  certRow: InvoiceAmountRow | null;
  freightRow: InvoiceAmountRow | null;
  taxRow: InvoiceAmountRow | null;
  total: number;
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, config-driven (P7 spec §5.4), locale pinned (the traveler's own rule) so output
// never tracks the server's.
// ---------------------------------------------------------------------------------------------

/** Money with a leading "$", `priceDecimals` decimals and `thousandsSeparator` grouping. The
 *  `negativeStyle` knob (ruling 3 — the invoice contract is its first real declarer) formats a
 *  credit's negative amounts: `SIGN_AFTER_SYMBOL` (default) is today's "$-937.44" — the sign between
 *  the "$" and the digits so magnitude and sign both read at a glance; `LEADING_MINUS` is "-$937.44";
 *  `PARENTHESES` is "($937.44)". The default knobs reproduce today's `money()` byte-for-byte. */
function makeMoney(formats: FormatsConfig): (value: number) => string {
  const decimals = formats.priceDecimals ?? 2;
  const useGrouping = formats.thousandsSeparator !== false;
  const style = formats.negativeStyle ?? "SIGN_AFTER_SYMBOL";
  return (value) => {
    const magnitude = Math.abs(value).toLocaleString("en-US", {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping,
    });
    if (value >= 0) return `$${magnitude}`;
    switch (style) {
      case "LEADING_MINUS": return `-$${magnitude}`;
      case "PARENTHESES": return `($${magnitude})`;
      default: return `$-${magnitude}`; // SIGN_AFTER_SYMBOL — today's
    }
  };
}

/** A weight, always two decimals, no "$" — the sample's "3,024.00" / "21.00" style. Grouping rides
 *  the `thousandsSeparator` knob; the decimals are DATA PRECISION, not the price knob. */
function makeWeight(formats: FormatsConfig): (value: number) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping });
}

/** A quantity, integer, thousands-grouped per the knob — "144", "1,440". */
function makeQty(formats: FormatsConfig): (value: number) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => value.toLocaleString("en-US", { maximumFractionDigits: 0, useGrouping });
}

const MONTHS_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The Invoice Date, driven by the contract's ONE date knob (default "MMMM D, YYYY" — the sample's
 * own "July 29, 2026" long-FULL-month style). The paper's ONLY date slot (grep-verified: `longDate`
 * was the sole date renderer, one call site). Pure string work — parsing to a Date would drag a
 * timezone into a date-only value (src/lib/business-days.ts's whole point).
 */
function makeLongDate(formats: FormatsConfig): (iso: string) => string {
  const format = formats.dateFormat ?? "MMMM D, YYYY";
  return (iso) => {
    const [y, m, d] = iso.split("-");
    switch (format) {
      case "M/D/YYYY": return `${Number(m)}/${Number(d)}/${y}`;
      case "MM/DD/YYYY": return `${m}/${d}/${y}`;
      case "YYYY-MM-DD": return iso;
      case "MMM - DD - YYYY": return `${MONTHS_ABBR[Number(m) - 1]} - ${d} - ${y}`;
      default: return `${MONTHS_FULL[Number(m) - 1]} ${Number(d)}, ${y}`; // "MMMM D, YYYY" — the sample's
    }
  };
}

// ---------------------------------------------------------------------------------------------
// The config lens (P7 spec §5.4) — the BOL/cert `sectionView`, applied to the invoice's blocks. The
// builder ASSUMES a complete config (`validateConfig`'s §5.3 backfill guarantees every entry
// exists); only the null-means-contract-default knobs a complete config still carries resolve here.
//
// THE §5.6 BELT, both halves: the flag half (`visible || !hideable` / `visible || !removable`) is
// the BOL's expression verbatim — NOTHING on this contract is locked, so it forces nothing and a
// config may hide anything; the omission half is `completeSections` in `buildInvoiceDefinition`
// below, so a raw config that OMITS an entry still renders it. The invoice carries no text blocks
// (its texts are all data or labels), so the BOL's third, text-block half is absent here.
// ---------------------------------------------------------------------------------------------

const CONTRACT_SECTIONS = new Map(INVOICE_CONTRACT.sections.map((s) =>
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
  if (cs === undefined) throw new Error(`Unknown INVOICE template section "${sc.key}"`);
  const byKey = new Map(sc.fields.map((f) => [f.key, f]));
  return {
    visible: sc.visible || !cs.section.hideable, // the belt, section half (nothing locked here)
    order: sc.fields.map((f) => f.key),
    field: (key) => {
      const cf = cs.fields.get(key);
      if (cf === undefined) throw new Error(`Unknown INVOICE template field "${sc.key}.${key}"`);
      const fc = byKey.get(key);
      return {
        visible: (fc?.visible ?? true) || !cf.removable, // the belt, field half
        label: fc?.label ?? cf.defaultLabel,
        width: fc?.width ?? cf.column?.defaultWidth ?? "*",
      };
    },
  };
}

/** The four data columns the sample's boxed header strip names — every body block (parts, prices,
 *  totals) aligns to these same widths, defined ONCE by the `column_header` section. */
type Slot = "qty" | "info" | "each" | "amt";
const COLUMN_FIELD: Record<string, Slot> = {
  col_qty: "qty", col_info: "info", col_each_weight: "each", col_amount: "amt",
};
/** The strip header cell alignment per slot (qty/info left, each/amt right — the sample's own). */
const HEADER_ALIGN: Record<Slot, "left" | "right"> = { qty: "left", info: "left", each: "right", amt: "right" };

type GridCol = { slot: Slot; width: number | "*"; label: string };

/** Everything a section renderer needs, threaded once instead of parameter-by-parameter. */
type Ctx = {
  fonts: FontsConfig;
  money: (value: number) => string;
  weight: (value: number) => string;
  qty: (value: number) => string;
  date: (iso: string) => string;
  sections: Map<string, SectionView>;
  /** The numeric widths of the qty/each/amt columns (0 when that column is hidden) — the body
   *  blocks' spacers and indents read these so a width override flows through the whole page. */
  slotW: { qty: number; each: number; amt: number };
  /** Present only when the resolved version carries logo BYTES and the config PLACES them
   *  (spec §6.3) — either alone renders today's text-only header. */
  logo: { placement: LogoPlacement; width: number; dataUri: string } | null;
};

/** The `column_header` section's visible column fields, in config order, with resolved widths and
 *  labels — the grid every body block aligns to. */
function gridColumns(ctx: Ctx): GridCol[] {
  const v = ctx.sections.get("column_header")!;
  return v.order
    .filter((k) => k in COLUMN_FIELD && v.field(k).visible)
    .map((k) => ({ slot: COLUMN_FIELD[k], width: v.field(k).width, label: v.field(k).label }));
}

const head = (text: string, align: "left" | "right"): TableCell => ({ text, bold: true, alignment: align });

// ---------------------------------------------------------------------------------------------
// Blocks, top to bottom in sample order. Each returns Content[] — empty means "nothing left to
// draw" and the block drops from the stack. The `footer` section is pulled OUT of the content flow
// into the page-margin strip (below), so it has no renderer here.
// ---------------------------------------------------------------------------------------------

/**
 * The big title (DATA — the row's kind) over the company name, both centered — the sample's header.
 * The title and company name are value-only (their labels are ""), so the printed text is the data,
 * not a label; the title carries `headingSize`. A placed logo (spec §6.3) unshifts into the centered
 * stack (header-center) or rides a side column (header-left/header-right); no logo → today's plain
 * centered stack, byte-for-byte.
 */
function headerBlock(ctx: Ctx, d: InvoicePdfData): Content[] {
  const v = ctx.sections.get("header")!;
  const center: Content[] = [];
  for (const key of v.order.filter((k) => (k === "title" || k === "company_name") && v.field(k).visible)) {
    if (key === "title") center.push({ text: d.title, bold: true, fontSize: ctx.fonts.headingSize, alignment: "center" });
    else center.push({ text: d.company.name, bold: true, fontSize: 15, alignment: "center", margin: [0, 2, 0, 6] });
  }

  const logoNode: Content | null = ctx.logo === null ? null : { image: ctx.logo.dataUri, width: ctx.logo.width };
  if (logoNode !== null && ctx.logo!.placement === "header-center") center.unshift(logoNode);
  const placedSide = logoNode !== null && (ctx.logo!.placement === "header-left" || ctx.logo!.placement === "header-right");
  if (center.length === 0 && !placedSide) return [];
  if (!placedSide) return [{ stack: center }]; // no logo, or header-center → today's stack shape

  const logoCol: Column = { width: ctx.logo!.width, stack: [logoNode!] };
  const centerCol: Column = { width: "*", stack: center };
  return [{ columns: ctx.logo!.placement === "header-left" ? [logoCol, centerCol] : [centerCol, logoCol], columnGap: 8 }];
}

/** The identity column (Invoice No. / Invoice Date / Terms — NO Page No., the sample's recorded
 *  deviation) left; the boxed Remit To block right. The trailing label-value spacing is alignment
 *  glue (the contract's `defaultLabel` carries no trailing spaces); a label override replaces the
 *  label, the glue stays. */
function identityBlock(ctx: Ctx, d: InvoicePdfData): Content[] {
  const v = ctx.sections.get("identity")!;
  const GLUE: Record<string, string> = { invoice_no: "  ", invoice_date: " ", terms: " " };
  const VALUE: Record<string, string> = { invoice_no: d.documentNumber, invoice_date: ctx.date(d.invoiceDate), terms: d.termsName };

  const lines: Content[] = [];
  for (const key of v.order.filter((k) => k in GLUE && v.field(k).visible)) {
    lines.push({
      text: [{ text: `${v.field(key).label}${GLUE[key]}`, bold: true }, VALUE[key]],
      fontSize: 10, ...(lines.length === 0 ? {} : { margin: [0, 2, 0, 0] }),
    });
  }

  const cols: Column[] = [];
  if (lines.length > 0) cols.push({ width: "*", stack: lines, margin: [40, 0, 0, 0] });
  if (v.field("remit_to").visible) {
    cols.push({
      width: 250,
      table: {
        widths: ["*"],
        body: [[{
          stack: [
            { text: v.field("remit_to").label, bold: true, fontSize: 13 },
            { text: d.remitTo.name, bold: true, fontSize: 10, margin: [0, 2, 0, 0] },
            ...d.remitTo.lines.map((line): Content => ({ text: line, fontSize: 10 })),
          ],
          margin: [4, 2, 4, 4],
        }]],
      },
      layout: LAYOUT.boxed,
    });
  }
  if (cols.length === 0) return [];
  return [{ columns: cols, columnGap: 12, margin: [0, 0, 0, 8] }];
}

/** A labelled multi-line address block ("Billto:" / "Shipto:") — the config label over each line
 *  straight off the frozen snapshot. */
function addressLines(label: string, lines: string[]): Content[] {
  return [
    { text: label, fontSize: 9, decoration: "underline" },
    ...lines.map((line, i): Content => ({ text: line, fontSize: 10, ...(i === 0 ? { margin: [0, 2, 0, 0] } : {}) })),
  ];
}

/** The two frozen snapshot address stacks. The first VISIBLE column carries the 40pt indent that
 *  aligns the block under the Quantity column; each field drops its column when hidden. */
function partiesBlock(ctx: Ctx, d: InvoicePdfData): Content[] {
  const v = ctx.sections.get("parties")!;
  const DATA: Record<string, string[]> = { bill_to: d.billTo, ship_to: d.shipTo };
  const cols: Column[] = [];
  for (const key of v.order.filter((k) => k in DATA && v.field(k).visible)) {
    cols.push({ width: "*", stack: addressLines(v.field(key).label, DATA[key]), ...(cols.length === 0 ? { margin: [40, 0, 0, 0] } : {}) });
  }
  if (cols.length === 0) return [];
  return [{ columns: cols, columnGap: 12, margin: [0, 4, 0, 6] }];
}

/** The one boxed strip naming the visible data columns (spec §10's header row) — the grid every
 *  body block below aligns to. Everything beneath it is free-flow text the builder aligns to these
 *  same widths (the sample rules only this strip). */
function columnHeaderStrip(ctx: Ctx): Content[] {
  const cols = gridColumns(ctx);
  if (cols.length === 0) return [];
  return [{
    table: { widths: cols.map((c) => c.width), body: [cols.map((c) => head(c.label, HEADER_ALIGN[c.slot]))] },
    layout: LAYOUT.boxed,
    margin: [0, 0, 0, 4],
  }];
}

/** Our Order # / Your PO #, Material / Process, then the underlined "PARTS" heading — the strip
 *  above the parts rows. Indented past the Quantity column to sit under "Order Information". */
function orderStrip(ctx: Ctx, d: InvoicePdfData): Content[] {
  const v = ctx.sections.get("order_strip")!;
  const stack: Content[] = [];

  const line1: (string | { text: string; bold: boolean })[] = [];
  if (v.field("our_order_no").visible) line1.push({ text: `${v.field("our_order_no").label} `, bold: true }, `${d.orderNumber}`);
  if (v.field("your_po").visible) {
    if (line1.length > 0) line1.push("    ");
    line1.push({ text: `${v.field("your_po").label} `, bold: true }, d.poNumber);
  }
  if (line1.length > 0) stack.push({ text: line1, fontSize: 9 });

  const line2: (string | { text: string; bold: boolean })[] = [];
  if (v.field("material").visible) line2.push({ text: `${v.field("material").label} `, bold: true }, d.materialName);
  if (v.field("process").visible) {
    if (line2.length > 0) line2.push("  ");
    line2.push({ text: `${v.field("process").label} `, bold: true }, d.processNames);
  }
  if (line2.length > 0) stack.push({ text: line2, fontSize: 9, margin: [0, 1, 0, 0] });

  if (v.field("parts_heading").visible) {
    stack.push({ text: v.field("parts_heading").label, bold: true, decoration: "underline", fontSize: 9, margin: [0, 4, 0, 2] });
  }

  if (stack.length === 0) return [];
  return [{ stack, margin: [ctx.slotW.qty + 6, 0, 0, 0] }];
}

/** One free-flow row per part, aligned to the grid: Quantity, the stacked Part No. / Name /
 *  Description, Each weight, Total Wt. Each value drops (blank cell) when its `parts`-section field
 *  is hidden; the column itself (width) is owned by `column_header`. */
function partsRows(ctx: Ctx, d: InvoicePdfData): Content[] {
  const v = ctx.sections.get("parts")!;
  const cols = gridColumns(ctx);
  if (cols.length === 0) return [];
  const cell = (c: GridCol, p: InvoicePart): Column => {
    switch (c.slot) {
      case "qty": return { width: c.width, text: v.field("part_qty").visible && p.qty !== null ? ctx.qty(p.qty) : "", fontSize: 9, alignment: "right" };
      case "info": return {
        width: c.width,
        stack: v.field("part_identity").visible
          ? [p.partNumber, p.partName, p.partDescription].filter((t) => t !== "").map((text): Content => ({ text, fontSize: 9 }))
          : [],
        margin: [6, 0, 0, 0],
      };
      case "each": return { width: c.width, text: v.field("part_each_weight").visible && p.eachWeight !== null ? ctx.weight(p.eachWeight) : "", fontSize: 9, alignment: "right" };
      default: return { width: c.width, text: v.field("part_total_weight").visible && p.totalWeight !== null ? ctx.weight(p.totalWeight) : "", fontSize: 9, alignment: "right" };
    }
  };
  return d.parts.map((p): Content => ({ columns: cols.map((c) => cell(c, p)), columnGap: 6, margin: [0, 2, 0, 0] }));
}

/** The centered "Price per Each:  $6.51   Or" / "Minimum Charge:  $600.00" detail lines beneath an
 *  operation. "Or" trails the per-unit price only when a minimum follows it (the sample's shape). */
function priceDetailLine(label: string, value: string, showOr: boolean): Content {
  return { text: `${label}  ${value}${showOr ? "   Or" : ""}`, fontSize: 9, alignment: "center", margin: [0, 1, 0, 0] };
}

/** The PRICE block: the underlined heading, then per operation its name + billed amount (grid-
 *  aligned like the parts rows), with the quote source, per-unit price, minimum and setup beneath. */
function priceBlock(ctx: Ctx, d: InvoicePdfData): Content[] {
  const v = ctx.sections.get("price")!;
  const cols = gridColumns(ctx);
  const out: Content[] = [];
  if (v.field("price_heading").visible) {
    out.push({ text: v.field("price_heading").label, bold: true, decoration: "underline", fontSize: 9, margin: [ctx.slotW.qty + 6, 8, 0, 2] });
  }
  const opCell = (c: GridCol, pr: InvoicePriceRow): Column => {
    if (c.slot === "info") return { width: c.width, text: v.field("price_description").visible ? pr.description : "", fontSize: 9, margin: [6, 0, 0, 0] };
    if (c.slot === "amt") return { width: c.width, text: v.field("price_amount").visible ? ctx.money(pr.amount) : "", fontSize: 9, alignment: "right" };
    return { width: c.width, text: "" };
  };
  for (const pr of d.priceRows) {
    if (cols.length > 0) out.push({ columns: cols.map((c) => opCell(c, pr)), columnGap: 6, margin: [0, 3, 0, 0] });
    // The tier-1 source line (quoting spec §5.3): a quote-priced operation names its agreement —
    // "Quote #1006", the frozen number the data carries; the label root is the config's `quote_source`
    // (default PRICE_SOURCE_LABELS.QUOTE). Rows without a quote number print no source line.
    if (v.field("quote_source").visible && pr.sourceQuoteNumber !== null && pr.sourceQuoteNumber !== undefined) {
      out.push({ text: `${v.field("quote_source").label} #${pr.sourceQuoteNumber}`, fontSize: 9, alignment: "center", margin: [0, 1, 0, 0] });
    }
    if (v.field("price_per").visible && pr.unitPrice !== null) {
      out.push(priceDetailLine(`${v.field("price_per").label} ${pr.pricePerLabel}:`, ctx.money(pr.unitPrice),
        v.field("minimum_charge").visible && pr.minimumCharge !== null));
    }
    if (v.field("minimum_charge").visible && pr.minimumCharge !== null) out.push(priceDetailLine(v.field("minimum_charge").label, ctx.money(pr.minimumCharge), false));
    if (v.field("setup_charge").visible && pr.setupCharge !== null) out.push(priceDetailLine(v.field("setup_charge").label, ctx.money(pr.setupCharge), false));
  }
  return out;
}

/** A right-aligned "label  amount" totals line, its amount under the grid's amount column. */
function totalLine(amtW: number, label: string, value: string, opts: { bold?: boolean; big?: boolean } = {}): Content {
  const fontSize = opts.big ? 13 : 10;
  return {
    columns: [
      { width: "*", text: "" },
      { width: 200, text: label, bold: opts.bold ?? false, fontSize, alignment: "right" },
      { width: amtW, text: value, bold: opts.bold ?? false, fontSize, alignment: "right" },
    ],
    columnGap: 6,
    margin: [0, opts.big ? 6 : 2, 0, 0],
  };
}

/** Sub Total, one named line per surcharge/charge/cert/freight/tax (their descriptions are frozen
 *  line data), then the bold Total Amount Due. Each row gates on its `totals`-section field. */
function totalsBlock(ctx: Ctx, d: InvoicePdfData): Content[] {
  const v = ctx.sections.get("totals")!;
  const amtW = ctx.slotW.amt || 84; // the amount column's width (fall back to the sample's 84)
  const out: Content[] = [];
  if (v.field("subtotal").visible) out.push(totalLine(amtW, v.field("subtotal").label, ctx.money(d.subtotal), { bold: true }));
  if (v.field("surcharge_rows").visible) for (const s of d.surchargeRows) out.push(totalLine(amtW, s.description, ctx.money(s.amount)));
  if (v.field("charge_rows").visible) for (const c of d.chargeRows) out.push(totalLine(amtW, c.description, ctx.money(c.amount)));
  if (v.field("cert_row").visible && d.certRow) out.push(totalLine(amtW, d.certRow.description, ctx.money(d.certRow.amount)));
  if (v.field("freight_row").visible && d.freightRow) out.push(totalLine(amtW, d.freightRow.description, ctx.money(d.freightRow.amount)));
  if (v.field("tax_row").visible && d.taxRow) out.push(totalLine(amtW, d.taxRow.description, ctx.money(d.taxRow.amount)));
  if (v.field("total").visible) out.push(totalLine(amtW, v.field("total").label, ctx.money(d.total), { bold: true, big: true }));
  return out;
}

/** The page footer strip: company address left, the sample's own static "Contact: Accounts
 *  Receivable" center (a pure label — no data behind it), phone right, at the config's `smallSize`.
 *  Returns null when the footer section or all its fields are hidden. This is a PAGE-MARGIN strip,
 *  not a content-flow section: it renders in the footer slot regardless of its position in the
 *  config's section order, and rides the pageNofM footer's `above` slot when `pageFooter` is on. */
function footerStrip(ctx: Ctx, d: InvoicePdfData): Content | null {
  const v = ctx.sections.get("footer")!;
  if (!v.visible) return null;
  const cols: Column[] = [];
  if (v.field("footer_address").visible) cols.push({ width: "*", text: d.company.address, fontSize: ctx.fonts.smallSize });
  if (v.field("footer_contact").visible) cols.push({ width: 180, text: v.field("footer_contact").label, fontSize: ctx.fonts.smallSize, alignment: "center" });
  if (v.field("footer_phone").visible) cols.push({ width: 140, text: `${v.field("footer_phone").label} ${d.company.phone}`, fontSize: ctx.fonts.smallSize, alignment: "right" });
  if (cols.length === 0) return null;
  return { columns: cols, margin: [24, 6, 24, 0] };
}

/**
 * The invoice's identity band — what an invoice overflowing LETTER repeats on its continuation
 * pages. A real invoice genuinely overflows: the parts are the order's lines (unbounded — min(1),
 * no max, orders.ts) and the priced operations grow with them (probed empirically, Task 12: ~15
 * parts → 2 pages). Its identity is the invoice number under the `invoice_no` field's own label.
 * Rendered REGARDLESS of the config's visibility flags (the BOL/cert band's identity treatment —
 * identity on paper is locked, not configurable), though the `invoice_no` label override carries.
 */
const CONTINUATION_TOP_MARGIN = 40;
function continuationHeader(ctx: Ctx, d: InvoicePdfData): Content {
  const v = ctx.sections.get("identity")!;
  return {
    stack: [
      { text: `${v.field("invoice_no").label} ${d.documentNumber}`, bold: true, fontSize: 11 },
      { text: "(continued)", italics: true, fontSize: ctx.fonts.smallSize },
    ],
    margin: [24, 10, 24, 0],
  };
}

/** One config section key → its renderer. The `footer` section is handled separately (the strip),
 *  so it renders nothing in the content flow. An unknown key renders nothing: the validator refused
 *  it before any config stored it. */
function renderSection(key: string, ctx: Ctx, d: InvoicePdfData): Content[] {
  switch (key) {
    case "header": return headerBlock(ctx, d);
    case "identity": return identityBlock(ctx, d);
    case "parties": return partiesBlock(ctx, d);
    case "column_header": return columnHeaderStrip(ctx);
    case "order_strip": return orderStrip(ctx, d);
    case "parts": return partsRows(ctx, d);
    case "price": return priceBlock(ctx, d);
    case "totals": return totalsBlock(ctx, d);
    default: return []; // footer (the page-margin strip) and any unknown key
  }
}

// ---------------------------------------------------------------------------------------------
// The built-in default invoice/credit template (spec §10, P7 spec §5.4). PURE — data and config
// in, JSON out.
// ---------------------------------------------------------------------------------------------

/**
 * `config` is a **backfilled** `TemplateConfig` (what `resolveTemplateForPrint` returns) and
 * DEFAULTS to the contract's own `DEFAULT_CONFIG` — so a config-less call renders exactly today's
 * paper (the golden-compat gate, tests/invoice-pdf.test.ts). `logoDataUri` is the traveler's
 * deliberate extra parameter: the logo bytes belong to the resolved template version, not to the
 * invoice data. The bottom margin is 44 unconditionally (the invoice has always carried a per-page
 * company strip): the `pageFooter` knob does not change the margin, only where the strip and the
 * page count go.
 */
export function buildInvoiceDefinition(
  input: InvoicePdfData,
  config: TemplateConfig = DEFAULT_CONFIG,
  logoDataUri?: string,
): RenderableDefinition {
  // The §5.6 belt's OMISSION half: views resolve over `completeSections`, never `config.sections`
  // raw, so a raw config omitting an entry cannot drop it.
  const sectionConfigs = completeSections(INVOICE_CONTRACT, config.sections);
  const sections = new Map(sectionConfigs.map((sc) => [sc.key, sectionView(sc)] as const));
  const colV = sections.get("column_header")!;
  const slotNum = (key: string, dflt: number): number => {
    const fv = colV.field(key);
    if (!fv.visible) return 0; // a hidden column reserves no width — the validator's budget model
    return typeof fv.width === "number" ? fv.width : dflt;
  };
  const ctx: Ctx = {
    fonts: config.fonts,
    money: makeMoney(config.formats),
    weight: makeWeight(config.formats),
    qty: makeQty(config.formats),
    date: makeLongDate(config.formats),
    sections,
    slotW: { qty: slotNum("col_qty", 52), each: slotNum("col_each_weight", 66), amt: slotNum("col_amount", 84) },
    logo: config.logo !== null && logoDataUri !== undefined
      ? { placement: config.logo.placement, width: config.logo.width, dataUri: logoDataUri }
      : null,
  };

  const content: Content[] = [];
  // Stack order IS the config's section order; hidden sections are omitted (nothing on this
  // contract is locked, so the belt forces none back). The footer section never enters the content
  // flow — it is the page-margin strip below.
  for (const sc of sectionConfigs) {
    if (sc.key === "footer") continue;
    if (!sections.get(sc.key)!.visible) continue;
    content.push(...renderSection(sc.key, ctx, input));
  }

  const strip = footerStrip(ctx, input);
  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, 44],
    defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
    // No `info.creationDate`, no clock anywhere — the print DATE is not even printed; the invoice
    // date is data (`invoiceDate`), so the builder itself stays deterministic (the traveler's rule).
    //
    // The `pageFooter` knob (spec §6.1) and the static company strip cannot both own pdfmake's one
    // `footer` slot (render.ts refuses two). Knob OFF (default — golden): the strip is a plain static
    // `footer`, exactly today. Knob ON: the strip rides the pageNofM footer's `above` slot, stacked
    // over the page line by render.ts's one callback (the reason `above` exists).
    ...(config.pageFooter
      ? { pageFooterSpec: { kind: "pageNofM" as const, ...(strip !== null ? { above: strip } : {}) } }
      : (strip !== null ? { footer: strip } : {})),
    content,
    continuationHeaderSpec: {
      content: continuationHeader(ctx, input),
      overflowTopMargin: CONTINUATION_TOP_MARGIN,
    },
  };
}
