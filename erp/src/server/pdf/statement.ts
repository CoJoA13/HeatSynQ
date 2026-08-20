/**
 * The open-item customer statement (P5B design spec §8). PURE by construction, the invoice/cert
 * contract: `StatementData` + a validated `TemplateConfig` in, a plain-JSON pdfmake definition out —
 * no I/O, no clock, nothing that would not survive `JSON.parse(JSON.stringify())` (asserted in
 * tests/statement-pdf.test.ts). The reads live in `statements.ts` (`buildStatement`), the bytes in
 * `render.ts`.
 *
 * A CONFIG-CONSUMER since Phase 7 Task 13 (P7 spec §5.4) — the invoice/BOL/cert lens (`sectionView`
 * over `completeSections`, the §5.6 belt in both halves): sections/fields/labels/widths/fonts/
 * formats/logo render from a validated config, and the default config reproduces today's paper
 * exactly (the golden gate, tests/statement-pdf.test.ts, untouched).
 *
 * **THE STATEMENT IS A FULLY-LIVE REBUILD — the THIRD snapshot posture, and the OPPOSITE of the
 * invoice.** An invoice is frozen paper (its identity/pricing columns read UNCONDITIONALLY, never
 * re-joined); a shipper/cert live-joins with a snapshot fallback. A statement is neither: it is
 * rebuilt fresh from live A/R every time it is printed (`statements.ts` reads the live open items,
 * the live default BILL_TO address, the point-in-time aging), and it is reprintable identically only
 * because printing ARCHIVES its OUTPUT, not because its input is frozen — a data change between two
 * prints shows in the second. This builder is pure `StatementData` → definition; the live-read
 * discipline is `statements.ts`'s, and this config-consumer conversion adds no frozen-column
 * constraint of its own.
 *
 * Unlike the invoice/cert/traveler templates, there is no owner-supplied sample to mirror — a
 * statement is a document type this phase INTRODUCES (spec §8). The layout below is this project's
 * own built-in default: a centered title over the company name, a customer + remit-to header, the
 * open-item table, the five-bucket aging strip with its own Unapplied column (owner ruling 8 — never
 * folded into a bucket) and Net, an optional finance-charge line, and the total due.
 *
 * `StatementData` is owned HERE (the `InvoicePdfData` pdf-module-owns-its-input-type precedent) so
 * this file imports nothing from the service layer and the dependency stays one-directional
 * (`statements.ts` imports `buildStatementDefinition` and re-exports this type — never the reverse).
 */
import type { Column, Content, TableCell } from "pdfmake/interfaces";
import { LAYOUT, type RenderableDefinition } from "./render";
import { STATEMENT_CONTRACT, DEFAULT_CONFIG } from "../../lib/template-contracts/statement";
import {
  completeSections,
  type FontsConfig, type FormatsConfig, type LogoPlacement, type SectionConfig,
  type TemplateConfig,
} from "../../lib/template-contracts/types";
import type { AgingRow } from "../aging";
import type { InvoiceCompany, InvoiceRemitTo } from "./invoice";

// ---------------------------------------------------------------------------------------------
// StatementData — the builder's whole input. Plain data: no Decimals, no Dates, no Prisma rows.
// `customer.billTo` is read LIVE off the customer's current default BILL_TO address (statements.ts)
// — unlike an invoice's frozen snapshot, a statement is rebuilt fresh every print, so these are the
// current address, not paper raised once.
// ---------------------------------------------------------------------------------------------

export type StatementOpenItem = {
  documentNumber: string; date: string; dueDate: string | null; kind: "INVOICE" | "CREDIT" | "PAYMENT";
  original: number; open: number;
};

export type StatementData = {
  asOf: string;
  company: InvoiceCompany;
  remitTo: InvoiceRemitTo;
  customer: { code: string; name: string; billTo: string[] };
  openItems: StatementOpenItem[];
  aging: AgingRow;
  financeCharge: number | null;
  totalDue: number;
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, config-driven (P7 spec §5.4), locale pinned (the invoice's own rule) so output
// never tracks the server's.
// ---------------------------------------------------------------------------------------------

/** Money with a leading "$", `priceDecimals` decimals and `thousandsSeparator` grouping. The
 *  `negativeStyle` knob formats the statement's negative money (a credit or on-account PAYMENT row's
 *  Open amount, a net-negative aging bucket): `SIGN_AFTER_SYMBOL` (default) is today's "$-200.00";
 *  `LEADING_MINUS` is "-$200.00"; `PARENTHESES` is "($200.00)". The default knobs reproduce today's
 *  `money()` byte-for-byte (the makeMoney the invoice contract declares — copied, its own precedent). */
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

const MONTHS_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A date, driven by the contract's ONE date knob (default "MMMM D, YYYY" — the statement's own
 * "July 29, 2026" long-FULL-month style, shared with the invoice). Both date slots — the Statement
 * Date and each open item's Date/Due Date — print through the SAME renderer (`longDate` was the sole
 * date function), so the single knob maps directly with no two-styles trap. Pure string work —
 * parsing to a Date would drag a timezone into a date-only value.
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
      default: return `${MONTHS_FULL[Number(m) - 1]} ${Number(d)}, ${y}`; // "MMMM D, YYYY" — today's
    }
  };
}

// ---------------------------------------------------------------------------------------------
// The config lens (P7 spec §5.4) — the invoice/BOL/cert `sectionView`, applied to the statement's
// blocks. The builder ASSUMES a complete config (`validateConfig`'s §5.3 backfill guarantees every
// entry exists); only the null-means-contract-default knobs a complete config still carries resolve.
//
// THE §5.6 BELT, both halves: the flag half (`visible || !hideable` / `visible || !removable`) is the
// invoice's expression verbatim — NOTHING on this contract is locked, so it forces nothing and a
// config may hide anything; the omission half is `completeSections` in `buildStatementDefinition`
// below, so a raw config that OMITS an entry still renders it. The statement carries no text blocks
// (its texts are all data or labels), so the BOL's third, text-block half is absent here.
// ---------------------------------------------------------------------------------------------

const CONTRACT_SECTIONS = new Map(STATEMENT_CONTRACT.sections.map((s) =>
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
  // Unknown keys were refused by the validator before any config could be stored; a miss here is a
  // caller bug, not a config state.
  if (cs === undefined) throw new Error(`Unknown STATEMENT template section "${sc.key}"`);
  const byKey = new Map(sc.fields.map((f) => [f.key, f]));
  return {
    visible: sc.visible || !cs.section.hideable, // the belt, section half (nothing locked here)
    order: sc.fields.map((f) => f.key),
    field: (key) => {
      const cf = cs.fields.get(key);
      if (cf === undefined) throw new Error(`Unknown STATEMENT template field "${sc.key}.${key}"`);
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
  money: (value: number) => string;
  date: (iso: string) => string;
  sections: Map<string, SectionView>;
  /** Present only when the resolved version carries logo BYTES and the config PLACES them
   *  (spec §6.3) — either alone renders today's text-only header. */
  logo: { placement: LogoPlacement; width: number; dataUri: string } | null;
};

const head = (text: string, align: "left" | "right"): TableCell => ({ text, bold: true, fontSize: 9, alignment: align });

// ---------------------------------------------------------------------------------------------
// Blocks, top to bottom. Each returns Content[] — empty means "nothing left to draw" and the block
// drops from the stack.
// ---------------------------------------------------------------------------------------------

/**
 * The centered "Statement" title over the company name. Unlike the invoice, the title here is a
 * LABEL (nothing kind-varies it), so its printed text is the config's `title` label (default
 * "Statement") at `headingSize`; the company name is value-only (prints `d.company.name`). A placed
 * logo (spec §6.3) unshifts into the centered stack (header-center) or rides a side column
 * (header-left/header-right); no logo → today's plain centered stack, byte-for-byte.
 */
function headerBlock(ctx: Ctx, d: StatementData): Content[] {
  const v = ctx.sections.get("header")!;
  const center: Content[] = [];
  for (const key of v.order.filter((k) => (k === "title" || k === "company_name") && v.field(k).visible)) {
    if (key === "title") center.push({ text: v.field("title").label, bold: true, fontSize: ctx.fonts.headingSize, alignment: "center" });
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

/** The customer / statement-date / live bill-to column left, the boxed Remit To block right — the
 *  invoice identity block's shape, with "Customer" + "Statement Date" in place of "Invoice No." +
 *  "Invoice Date". The label-value spacing is a single trailing space of alignment glue (the
 *  contract's `defaultLabel` carries none); a label override replaces the label, the glue stays.
 *  Each left field carries its OWN sample margin (unlike the invoice's homogeneous position-based
 *  rule — the statement's identity lines are heterogeneous: a plain line, a spaced line, and an
 *  underlined address block). */
function identityBlock(ctx: Ctx, d: StatementData): Content[] {
  const v = ctx.sections.get("identity")!;
  const leftStack: Content[] = [];
  for (const key of v.order.filter((k) => (k === "customer" || k === "statement_date" || k === "bill_to") && v.field(k).visible)) {
    if (key === "customer") {
      leftStack.push({ text: [{ text: `${v.field("customer").label} `, bold: true }, `${d.customer.code} — ${d.customer.name}`], fontSize: 10 });
    } else if (key === "statement_date") {
      leftStack.push({ text: [{ text: `${v.field("statement_date").label} `, bold: true }, ctx.date(d.asOf)], fontSize: 10, margin: [0, 2, 0, 0] });
    } else {
      leftStack.push({ text: v.field("bill_to").label, fontSize: 9, decoration: "underline", margin: [0, 6, 0, 0] });
      for (const line of d.customer.billTo) leftStack.push({ text: line, fontSize: 10 });
    }
  }

  const cols: Column[] = [];
  if (leftStack.length > 0) cols.push({ width: "*", stack: leftStack, margin: [40, 0, 0, 0] });
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
  return [{ columns: cols, columnGap: 12, margin: [0, 0, 0, 10] }];
}

/** Document #/Date/Due Date/Original/Open — one row per open item (spec §8). These fields carry no
 *  column knob (the contract's own choice — the widths are the builder's hand-laid
 *  ["auto","auto","auto","*","*"]), so a template gets label/visibility/order over them; hiding a
 *  field drops its whole column. A CREDIT or on-account PAYMENT row's "Due Date" cell prints blank
 *  (neither carries one — `dueDate: null`), never a fabricated date. */
const OPEN_ITEM_WIDTH: Record<string, number | "auto" | "*"> = {
  document_no: "auto", date: "auto", due_date: "auto", original: "*", open: "*",
};
const OPEN_ITEM_ALIGN: Record<string, "left" | "right"> = {
  document_no: "left", date: "left", due_date: "left", original: "right", open: "right",
};
function openItemValue(key: string, item: StatementOpenItem, ctx: Ctx): string {
  switch (key) {
    case "document_no": return item.documentNumber;
    case "date": return ctx.date(item.date);
    case "due_date": return item.dueDate ? ctx.date(item.dueDate) : "";
    case "original": return ctx.money(item.original);
    default: return ctx.money(item.open); // "open"
  }
}
function openItemsTable(ctx: Ctx, d: StatementData): Content[] {
  const v = ctx.sections.get("open_items")!;
  const cols = v.order.filter((k) => k in OPEN_ITEM_WIDTH && v.field(k).visible);
  if (cols.length === 0) return [];
  const body: TableCell[][] = [cols.map((k) => head(v.field(k).label, OPEN_ITEM_ALIGN[k]))];
  for (const item of d.openItems) {
    body.push(cols.map((k): TableCell => (
      OPEN_ITEM_ALIGN[k] === "right"
        ? { text: openItemValue(k, item, ctx), fontSize: 9, alignment: "right" }
        : { text: openItemValue(k, item, ctx), fontSize: 9 })));
  }
  return [{
    table: { headerRows: 1, widths: cols.map((k) => OPEN_ITEM_WIDTH[k]), body },
    layout: LAYOUT.boxed,
    margin: [0, 0, 0, 10],
  }];
}

/** The five aging buckets plus the separate Unapplied column and Net (owner ruling 8: unapplied
 *  credit/on-account is never folded into a bucket) — off the SAME `AgingRow` `aging.ts` computes
 *  for the report (spec §6: "one pure aging function serves both"). These fields DO carry a column
 *  knob (defaultWidth "*"), so a template may re-width them within the aging table's budget. */
const AGING_DATA: Record<string, Exclude<keyof AgingRow, "customerId" | "customerCode" | "customerName" | "isFamilyTotal">> = {
  aging_current: "current", aging_1_30: "d1_30", aging_31_60: "d31_60", aging_61_90: "d61_90",
  aging_90_plus: "d90_plus", aging_unapplied: "unapplied", aging_net: "net",
};
function agingStrip(ctx: Ctx, d: StatementData): Content[] {
  const v = ctx.sections.get("aging")!;
  const cols = v.order.filter((k) => k in AGING_DATA && v.field(k).visible);
  if (cols.length === 0) return [];
  const headRow: TableCell[] = cols.map((k) => head(v.field(k).label, "right"));
  const valueRow: TableCell[] = cols.map((k): TableCell => (
    k === "aging_net"
      ? { text: ctx.money(d.aging[AGING_DATA[k]]), bold: true, fontSize: 9, alignment: "right" }
      : { text: ctx.money(d.aging[AGING_DATA[k]]), fontSize: 9, alignment: "right" }));
  return [{
    table: { headerRows: 1, widths: cols.map((k) => v.field(k).width), body: [headRow, valueRow] },
    layout: LAYOUT.boxed,
    margin: [0, 0, 0, 10],
  }];
}

/** A right-aligned "label  amount" line — the invoice totals-block precedent. */
function totalLine(label: string, value: string, opts: { bold?: boolean; big?: boolean } = {}): Content {
  const fontSize = opts.big ? 13 : 10;
  return {
    columns: [
      { width: "*", text: "" },
      { width: 200, text: label, bold: opts.bold ?? false, fontSize, alignment: "right" },
      { width: 100, text: value, bold: opts.bold ?? false, fontSize, alignment: "right" },
    ],
    columnGap: 6,
    margin: [0, opts.big ? 6 : 2, 0, 0],
  };
}

/**
 * The finance-charge line prints ONLY when the run assessed one (spec §8) — `null` means either the
 * run didn't opt in, or nothing non-exempt was past due; either way, no line. Gated on its own
 * field's visibility on top.
 *
 * #162: it is INFORMATIONAL (owner ruling 2026-08-19) — `d.totalDue` is `aging.net` and excludes it,
 * nothing is posted, nothing ages. This block deliberately renders it in the CONFIG's section order,
 * which by default is directly above Total Due; the honesty lives in the LABEL the contract supplies
 * ("Finance Charge (not billed, not in total):"), never in a re-order — a stored config keeps its
 * own order, so a re-order would fix the default template and miss every published one, while the
 * label re-resolves for all of them (#103). Do not "fix" it by moving the section.
 */
function financeChargeBlock(ctx: Ctx, d: StatementData): Content[] {
  const v = ctx.sections.get("finance_charge")!;
  if (d.financeCharge === null || !v.field("finance_charge").visible) return [];
  return [totalLine(v.field("finance_charge").label, ctx.money(d.financeCharge))];
}

/** The bold Total Due line — buckets − unapplied = the net owed (`aging.net`). */
function totalDueBlock(ctx: Ctx, d: StatementData): Content[] {
  const v = ctx.sections.get("total")!;
  if (!v.field("total_due").visible) return [];
  return [totalLine(v.field("total_due").label, ctx.money(d.totalDue), { bold: true, big: true })];
}

/**
 * The statement's identity band — what a statement overflowing LETTER repeats on its continuation
 * pages. A real statement genuinely overflows: the open items are unbounded (a customer can carry
 * any number of open finalized invoices/credits/on-account payments), and ~34 rows fill a page
 * (probed empirically, Task 13). Its identity is the customer under the `customer` field's own
 * label. Rendered REGARDLESS of the config's visibility flags (the invoice/BOL/cert band's identity
 * treatment — identity on paper is locked, not configurable), though the `customer` label override
 * carries. The aging strip and Total Due are separate content blocks flowing AFTER the open-item
 * table (which repeats its own header row on continuation pages), so they land on the last page.
 */
const CONTINUATION_TOP_MARGIN = 40;
function continuationHeader(ctx: Ctx, d: StatementData): Content {
  const v = ctx.sections.get("identity")!;
  return {
    stack: [
      { text: `${v.field("customer").label} ${d.customer.code} — ${d.customer.name}`, bold: true, fontSize: 11 },
      { text: "(continued)", italics: true, fontSize: ctx.fonts.smallSize },
    ],
    margin: [24, 10, 24, 0],
  };
}

/** One config section key → its renderer. An unknown key renders nothing: the validator refused it
 *  before any config stored it. */
function renderSection(key: string, ctx: Ctx, d: StatementData): Content[] {
  switch (key) {
    case "header": return headerBlock(ctx, d);
    case "identity": return identityBlock(ctx, d);
    case "open_items": return openItemsTable(ctx, d);
    case "aging": return agingStrip(ctx, d);
    case "finance_charge": return financeChargeBlock(ctx, d);
    case "total": return totalDueBlock(ctx, d);
    default: return [];
  }
}

// ---------------------------------------------------------------------------------------------
// The built-in default statement template (spec §8, P7 spec §5.4). PURE — data and config in, JSON
// out.
// ---------------------------------------------------------------------------------------------

/**
 * `config` is a **backfilled** `TemplateConfig` (what `resolveTemplateForPrint` returns) and DEFAULTS
 * to the contract's own `DEFAULT_CONFIG` — so a config-less call renders exactly today's paper (the
 * golden-compat gate, tests/statement-pdf.test.ts). `logoDataUri` is the invoice's deliberate extra
 * parameter: the logo bytes belong to the resolved template version, not to the statement data. The
 * statement carries no per-page footer strip, so the `pageFooter` knob (default OFF) adds a bare
 * "Page N of M" line when on and nothing otherwise (byte-identical default); the bottom margin stays
 * 40 unconditionally, today's.
 */
export function buildStatementDefinition(
  input: StatementData,
  config: TemplateConfig = DEFAULT_CONFIG,
  logoDataUri?: string,
): RenderableDefinition {
  // The §5.6 belt's OMISSION half: views resolve over `completeSections`, never `config.sections`
  // raw, so a raw config omitting an entry cannot drop it.
  const sectionConfigs = completeSections(STATEMENT_CONTRACT, config.sections);
  const sections = new Map(sectionConfigs.map((sc) => [sc.key, sectionView(sc)] as const));
  const ctx: Ctx = {
    fonts: config.fonts,
    money: makeMoney(config.formats),
    date: makeLongDate(config.formats),
    sections,
    logo: config.logo !== null && logoDataUri !== undefined
      ? { placement: config.logo.placement, width: config.logo.width, dataUri: logoDataUri }
      : null,
  };

  const content: Content[] = [];
  // Stack order IS the config's section order; hidden sections are omitted (nothing on this contract
  // is locked, so the belt forces none back).
  for (const sc of sectionConfigs) {
    if (!sections.get(sc.key)!.visible) continue;
    content.push(...renderSection(sc.key, ctx, input));
  }

  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, 40],
    defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
    // The statement has no static per-page strip (unlike the invoice/cert), so the `pageFooter` knob
    // (spec §6.1) is a bare page line: OFF (default — golden) prints no footer at all; ON prints the
    // real per-page "Page N of M" via render.ts's pageNofM callback.
    ...(config.pageFooter ? { pageFooterSpec: { kind: "pageNofM" as const } } : {}),
    content,
    continuationHeaderSpec: {
      content: continuationHeader(ctx, input),
      overflowTopMargin: CONTINUATION_TOP_MARGIN,
    },
  };
}
