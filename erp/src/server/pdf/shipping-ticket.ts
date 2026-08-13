/**
 * The shipping ticket — one sheet per order of a shipment (design spec §10.1, owner ruling §3.20:
 * "five orders on a truck print five shipping tickets and one BOL"; there is NO multi-order ticket
 * layout — a multi-order shipment prints one ticket per order). PURE by construction, the
 * traveler.ts contract: `TicketData[]` in, a plain-JSON pdfmake definition out — no I/O, no clock,
 * nothing that would not survive `JSON.parse(JSON.stringify())` (asserted in tests).
 *
 * A CONFIG-CONSUMER since Phase 7 Task 9 (P7 spec §5.4), and the ONE builder serving BOTH ticket
 * docTypes (P7 spec §5.2): `SHIPPER` (single-order shipments) and `MOS_SHIPPER` (multi-order
 * shipments — including the per-order ticket print of one of their orders; the SHIPMENT'S order
 * count decides, so all paper from one shipment styles alike). The two contracts start
 * structurally identical but are free to diverge, so every build names the docType its config was
 * validated against and resolves labels/widths against THAT contract — never a shared one.
 *
 * **THE TWO-DATE-STYLES TRAP (Task 1 review carry, BINDING).** This paper prints TWO date styles
 * against the contract's ONE date knob: the header's `shortDate` ("7/29/2026") and the tear-off's
 * zero-padded `paddedDate` ("Shipped ON: 07/29/2026"). The knob maps to the HEADER slot ONLY;
 * the tear-off keeps `paddedDate` UNCONDITIONALLY — mapping the knob there too would change the
 * tear-off at the golden-compat gate. Do not "unify" them.
 *
 * Layout mirrors the owner's `docs/samples/Shipping Ticket Sample.pdf`, which IS the contract
 * (spec §3.1). Deviations are individually commented; there are no silent ones:
 *  - no "Page 1 of 1" between the address blocks — page numbers are the render runtime's
 *    declarative footer spec now (P7 spec §6.1), per ticket group, behind the config's
 *    `pageFooter` knob (default off — golden).
 *  - the sample's stray "Temper Only" annotation has no field behind it in this model and spec
 *    §10.1 does not list it — not printed (do not invent fields, task brief Step 1).
 */
import type { Column, Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { LAYOUT } from "./render";
import { SHIPPER_CONTRACT, DEFAULT_CONFIG as SHIPPER_DEFAULT_CONFIG } from "../../lib/template-contracts/shipper";
import { MOS_SHIPPER_CONTRACT, DEFAULT_CONFIG as MOS_SHIPPER_DEFAULT_CONFIG } from "../../lib/template-contracts/mos-shipper";
import {
  completeSections,
  type FontsConfig, type FormatsConfig, type LogoPlacement, type SectionConfig,
  type TemplateConfig, type TemplateContract,
} from "../../lib/template-contracts/types";

// ---------------------------------------------------------------------------------------------
// TicketData — the builder's whole input (task-18-brief.md's exact shape). Plain data: no
// Decimals, no Dates, no Prisma rows.
// ---------------------------------------------------------------------------------------------

export type TicketCompany = { name: string; address: string; phone: string; liabilityText: string };
export type TicketParty = { code: string; name: string; street: string; city: string; state: string; zip: string };
export type TicketLine = { qty: number; partNumber: string; partName: string; partDescription: string; pounds: number };
export type TicketContainer = { typeName: string; count: number; customerContainerId: string };
export type TicketData = {
  company: TicketCompany;
  soldTo: TicketParty;                 // the customer's default BILL_TO
  shipTo: TicketParty;                 // the shipment's ship-to address
  orderLabel: string;                  // "72036-3"
  orderNumber: number;
  shipDate: string;                    // "yyyy-mm-dd"
  poNumber: string;
  packingListNo: number;               // Shipper.shipperNumber
  customerJobNo: string;
  route: string;
  carrierName: string;
  lines: TicketLine[];
  containers: TicketContainer[];
  serials: { serial: string; description: string }[];   // only printOnShipper rows
  shippedComplete: boolean;
  totalQty: number;
  totalWeight: number;
};

/** The two ticket docTypes this ONE builder serves (P7 spec §5.2): the shipment's order count
 *  picks which — see printShippingTickets in shippers.ts. */
export type TicketDocType = "SHIPPER" | "MOS_SHIPPER";

const CONTRACTS: Record<TicketDocType, TemplateContract> = {
  SHIPPER: SHIPPER_CONTRACT,
  MOS_SHIPPER: MOS_SHIPPER_CONTRACT,
};
const DEFAULT_CONFIGS: Record<TicketDocType, TemplateConfig> = {
  SHIPPER: SHIPPER_DEFAULT_CONFIG,
  MOS_SHIPPER: MOS_SHIPPER_DEFAULT_CONFIG,
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, config-driven (P7 spec §5.4's per-file formatting helpers), locale pinned
// (the traveler's own rule) so output never tracks the server's.
// ---------------------------------------------------------------------------------------------

/** Thousands-separated per the knob, at most 2 decimals, trailing zeros dropped — "4,128", "192". */
function makeNum(formats: FormatsConfig): (value: number) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => value.toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping });
}

/** Always 2 decimals — the sample's own totals style ("192.00", "4,128.00"). */
function makeNum2(formats: FormatsConfig): (value: number) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => value.toLocaleString("en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping });
}

const MONTHS_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The header date, driven by the contract's ONE date knob (default "M/D/YYYY" — the sample
 * header's own `shortDate`). Pure string work — parsing to a Date would drag a timezone into a
 * date-only value (src/lib/business-days.ts's whole point). The tear-off NEVER uses this — see
 * `paddedDate` below and the header comment's two-date-styles trap.
 */
function makeHeaderDate(formats: FormatsConfig): (iso: string) => string {
  const format = formats.dateFormat ?? "M/D/YYYY";
  return (iso) => {
    const [y, m, d] = iso.split("-");
    switch (format) {
      case "MM/DD/YYYY": return `${m}/${d}/${y}`;
      case "YYYY-MM-DD": return iso;
      case "MMMM D, YYYY": return `${MONTHS_FULL[Number(m) - 1]} ${Number(d)}, ${y}`;
      case "MMM - DD - YYYY": return `${MONTHS_ABBR[Number(m) - 1]} - ${d} - ${y}`;
      default: return `${Number(m)}/${Number(d)}/${y}`; // "M/D/YYYY"
    }
  };
}

/** "2026-07-29" -> "07/29/2026" — the tear-off's zero-padded "Shipped ON" style, as printed.
 *  UNCONDITIONAL: deliberately NOT wired to the date knob (the two-date-styles trap — the knob
 *  is the header's; changing it must never move the tear-off at the golden gate). */
function paddedDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

/** The packing list number zero-padded to six digits — the sample prints "072826", not "72826".
 *  A formatting rule of the paper itself, not a knob. */
function packingListNo(n: number): string {
  return String(n).padStart(6, "0");
}

const head = (text: string, colSpan?: number): TableCell =>
  ({ text, bold: true, alignment: "center", ...(colSpan ? { colSpan } : {}) });

/** LETTER (612pt) minus the 24pt margins — the width every full-bleed rule below draws to. */
const CONTENT_WIDTH = 564;

const rule = (margin: [number, number, number, number]): Content =>
  ({ canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 1.5 }], margin });

// ---------------------------------------------------------------------------------------------
// The config lens (P7 spec §5.4) — the traveler's `sectionView`, per docType. The builder
// ASSUMES a complete config (`validateConfig`'s §5.3 backfill guarantees every entry exists);
// only the two null-means-contract-default knobs a complete config still carries resolve here.
//
// THE §5.6 BELT, both halves: the flag half (`visible || !hideable` / `visible || !removable`)
// is the traveler's expression verbatim — on THESE contracts nothing is locked ("spec §5.6's
// locks are traveler-only", shipper.ts), so it forces nothing and a config may hide anything;
// the omission half is `completeSections` in `prepareTickets` below, so a raw config that OMITS
// an entry still renders it with the contract's defaults.
// ---------------------------------------------------------------------------------------------

const CONTRACT_SECTIONS: Record<TicketDocType, Map<string, {
  section: TemplateContract["sections"][number];
  fields: Map<string, TemplateContract["sections"][number]["fields"][number]>;
}>> = {
  SHIPPER: new Map(SHIPPER_CONTRACT.sections.map((s) =>
    [s.key, { section: s, fields: new Map(s.fields.map((f) => [f.key, f])) }] as const)),
  MOS_SHIPPER: new Map(MOS_SHIPPER_CONTRACT.sections.map((s) =>
    [s.key, { section: s, fields: new Map(s.fields.map((f) => [f.key, f])) }] as const)),
};

type FieldView = { visible: boolean; label: string; width: number | "*" };
type SectionView = {
  visible: boolean;
  /** Field keys in config (= display) order; per-field visibility still applies at use. */
  order: string[];
  field: (key: string) => FieldView;
};

function sectionView(docType: TicketDocType, sc: SectionConfig): SectionView {
  const cs = CONTRACT_SECTIONS[docType].get(sc.key);
  // Unknown keys were refused by the validator before any config could be stored; a miss here
  // is a caller bug, not a config state.
  if (cs === undefined) throw new Error(`Unknown ${docType} template section "${sc.key}"`);
  const byKey = new Map(sc.fields.map((f) => [f.key, f]));
  return {
    visible: sc.visible || !cs.section.hideable, // the belt, section half (nothing locked here)
    order: sc.fields.map((f) => f.key),
    field: (key) => {
      const cf = cs.fields.get(key);
      if (cf === undefined) throw new Error(`Unknown ${docType} template field "${sc.key}.${key}"`);
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
  num2: (value: number) => string;
  /** The date knob's ONLY consumer — the header's Ship Date slot. */
  headerDate: (iso: string) => string;
  sections: Map<string, SectionView>;
  /** Present only when the resolved version carries logo BYTES and the config PLACES them
   *  (spec §6.3) — either alone renders today's text-only header. */
  logo: { placement: LogoPlacement; width: number; dataUri: string } | null;
};

/** This section's visible column-field keys, in config order — what a table renderer turns into
 *  its `widths` and its per-row cells. */
function columnKeys(docType: TicketDocType, v: SectionView, sectionKey: string): string[] {
  const cs = CONTRACT_SECTIONS[docType].get(sectionKey)!;
  return v.order.filter((k) => cs.fields.get(k)?.column !== undefined && v.field(k).visible);
}

// ---------------------------------------------------------------------------------------------
// Blocks, top to bottom in sample order. Each returns Content[] — empty means "nothing left to
// draw" (every configurable piece hidden) and the block drops from the stack.
// ---------------------------------------------------------------------------------------------

/**
 * Header: three structural slots hand-laid on the sample — company/title left, order/date center
 * (170pt), the company address block right (130pt). Config field ORDER applies WITHIN each slot;
 * a field never migrates between columns (the traveler's documented mapping decision). Value-only
 * fields (company name/address/phone — contract defaultLabel "") have no label element, so a
 * label override has nothing to replace; the title's label IS its printed text.
 *
 * A placed logo (spec §6.3) joins the TOP of its slot's stack at its configured width; the stack
 * reflows beneath. No logo → today's text-only header, byte-for-byte.
 */
function headerBlock(ctx: Ctx, d: TicketData): Content[] {
  const v = ctx.sections.get("header")!;
  const pick = (keys: string[]): string[] =>
    v.order.filter((k) => keys.includes(k) && v.field(k).visible);

  const left: Content[] = [];
  for (const key of pick(["company_name", "title"])) {
    if (key === "company_name") left.push({ text: d.company.name, bold: true, fontSize: 11 });
    else left.push({ text: v.field(key).label, bold: true, fontSize: ctx.fonts.headingSize, margin: [0, 2, 0, 0] });
  }

  const center: Content[] = [];
  for (const key of pick(["order_no", "ship_date"])) {
    if (key === "order_no") center.push({ text: `${v.field(key).label} ${d.orderLabel}`, bold: true, fontSize: 11 });
    // The ONE place the date knob lands (the two-date-styles trap, header comment).
    else center.push({ text: `${v.field(key).label} ${ctx.headerDate(d.shipDate)}`, fontSize: 10, margin: [0, 4, 0, 0] });
  }

  const right: Content[] = [];
  for (const key of pick(["company_address", "company_phone"])) {
    right.push({ text: key === "company_address" ? d.company.address : d.company.phone, fontSize: 7 });
  }

  if (ctx.logo !== null) {
    const node: Content = { image: ctx.logo.dataUri, width: ctx.logo.width };
    if (ctx.logo.placement === "header-left") left.unshift(node);
    else if (ctx.logo.placement === "header-center") center.unshift(node);
    else right.unshift(node);
  }
  if (left.length + center.length + right.length === 0) return [];

  return [{
    columns: [
      { width: "*", stack: left },
      { width: 170, stack: center },
      { width: 130, alignment: "right", stack: right },
    ],
    columnGap: 10,
    margin: [0, 0, 0, 12],
  }];
}

/** One boxed address block — "Sold To:"/"Ship To:" with the identifying code in the corner
 *  (spec §10.1: the customer code for Sold To; blank for Ship To, since a CustomerAddress has no
 *  short code in this system and a cuid is not paper). */
function partyBox(label: string, party: TicketParty): Content {
  return {
    table: {
      widths: ["*"],
      body: [[{
        stack: [
          {
            columns: [
              { width: "*", text: label, bold: true, fontSize: 13 },
              { width: 60, text: party.code, alignment: "right", fontSize: 9 },
            ],
          },
          { text: party.name, bold: true, fontSize: 9.5 },
          { text: party.street, margin: [0, 1, 0, 0] },
          {
            columns: [
              { width: "*", text: party.city },
              { width: 34, text: party.state },
              { width: 48, text: party.zip },
            ],
            margin: [0, 10, 0, 0],
          },
        ],
        margin: [2, 1, 2, 2],
      }]],
    },
    layout: LAYOUT.boxed,
  };
}

/** The two boxed address blocks. The two party fields fill the left and right slots in CONFIG
 *  order; a hidden field leaves its slot EMPTY so its sibling holds position (the traveler
 *  footer's hidden-half treatment). Both hidden → the section drops. */
function partiesBlock(ctx: Ctx, d: TicketData): Content[] {
  const v = ctx.sections.get("parties")!;
  const keys = v.order.filter((k) => k === "sold_to" || k === "ship_to");
  if (keys.every((k) => !v.field(k).visible)) return [];

  const slot = (key: string | undefined): Column => {
    if (key === undefined || !v.field(key).visible) return { width: "*", text: "" };
    const party = key === "sold_to" ? d.soldTo : d.shipTo;
    return { width: "*", stack: [partyBox(v.field(key).label, party)] };
  };

  return [{
    columns: [slot(keys[0]), { width: 50, text: "" }, slot(keys[1])],
    columnGap: 0,
    margin: [0, 0, 0, 6],
  }];
}

/** The five-cell field strip: PO / Packing List No / Customer Job No / Route / Carrier — columns
 *  in config order, labels and widths from the view. */
function fieldStrip(ctx: Ctx, docType: TicketDocType, d: TicketData): Content[] {
  const v = ctx.sections.get("field_strip")!;
  const cols = columnKeys(docType, v, "field_strip");
  if (cols.length === 0) return [];

  const cellFor = (key: string): TableCell => {
    switch (key) {
      case "po_number": return { text: d.poNumber };
      case "packing_list_no": return { text: packingListNo(d.packingListNo) };
      case "customer_job_no": return { text: d.customerJobNo };
      case "route": return { text: d.route };
      case "carrier": return { text: d.carrierName };
      default: return { text: "" };
    }
  };

  return [{
    table: {
      headerRows: 1,
      widths: cols.map((k) => v.field(k).width),
      body: [cols.map((k) => head(v.field(k).label)), cols.map(cellFor)],
    },
    layout: LAYOUT.boxed,
    margin: [0, 0, 0, 6],
  }];
}

/** Quantity | Part No. / Part Name / Part Description (stacked, the sample's three lines) |
 *  Pounds. Horizontal rules only — the sample's body rows are ruled, not gridded. */
function linesTable(ctx: Ctx, docType: TicketDocType, d: TicketData): Content[] {
  const { num } = ctx;
  const v = ctx.sections.get("lines")!;
  const cols = columnKeys(docType, v, "lines");
  if (cols.length === 0) return [];

  const cellFor = (key: string, l: TicketLine): TableCell => {
    switch (key) {
      case "line_qty": return { text: num(l.qty), alignment: "right" };
      case "line_part": return {
        stack: [l.partNumber, l.partName, l.partDescription].filter((p) => p !== "").map((text) => ({ text })),
      };
      case "line_pounds": return { text: num(l.pounds), alignment: "right" };
      default: return { text: "" };
    }
  };

  return [{
    table: {
      headerRows: 1,
      widths: cols.map((k) => v.field(k).width),
      body: [
        cols.map((k) => head(v.field(k).label)),
        ...d.lines.map((l): TableCell[] => cols.map((k) => cellFor(k, l))),
      ],
    },
    layout: LAYOUT.ruled,
    margin: [0, 0, 0, 8],
  }];
}

/** The container table's two side-by-side column groups — the sample folds the container list
 *  into two columns, so the visible columns (config order) print TWICE and their width budget is
 *  half the content width (the contract's 282pt tableBudget). */
function containersTable(ctx: Ctx, docType: TicketDocType, d: TicketData): Content[] {
  const { num } = ctx;
  const v = ctx.sections.get("containers")!;
  const cols = columnKeys(docType, v, "containers");
  if (cols.length === 0) return [];

  const half = Math.ceil(d.containers.length / 2);
  const left = d.containers.slice(0, half);
  const right = d.containers.slice(half);
  const rows = Math.max(left.length, 1);

  const group = (c: TicketContainer | undefined): TableCell[] => cols.map((key): TableCell => {
    switch (key) {
      case "container_type": return { text: c?.typeName ?? "" };
      case "container_count": return { text: c === undefined ? "" : num(c.count), alignment: "center" };
      case "cust_cont_id": return { text: c?.customerContainerId ?? "" };
      default: return { text: "" };
    }
  });
  const groupWidths = cols.map((k) => v.field(k).width);
  const groupHeads = cols.map((k) => head(v.field(k).label));

  return [{
    table: {
      headerRows: 1,
      widths: [...groupWidths, ...groupWidths],
      body: [
        [...groupHeads, ...groupHeads],
        ...Array.from({ length: rows }, (_, i): TableCell[] => [...group(left[i]), ...group(right[i])]),
      ],
    },
    layout: LAYOUT.ruled,
    margin: [0, 0, 0, 6],
  }];
}

/** Serial numbers where `printOnShipper` (spec §10.1) — a labelled list, description (the
 *  heat/lot field) beside each serial. Renders nothing at all when no serial is flagged. */
function serialsBlock(ctx: Ctx, d: TicketData): Content[] {
  const v = ctx.sections.get("serials")!;
  if (d.serials.length === 0 || !v.field("serials").visible) return [];
  return [{
    stack: [
      { text: v.field("serials").label, bold: true, margin: [0, 0, 0, 2] },
      ...d.serials.map((s) => ({ text: s.description === "" ? s.serial : `${s.serial} — ${s.description}` })),
    ],
    margin: [0, 0, 0, 6],
  }];
}

/**
 * The standing liability text in the sample's own fine print (the config's `smallSize` role),
 * one paragraph per blank-line-separated block, closed by the sample's heavy rule.
 *
 * The TEXT arrives on `TicketData.company.liabilityText` — deliberately. The print path sources
 * that value from the resolved config's `shipper_liability_text` text block (P7 spec §8: the
 * template owns the standing text now; see printShippingTickets), while the config-less legacy
 * call keeps rendering whatever the data carries — exactly today's paper. Binding the builder to
 * `config.textBlocks` directly would make the default-parameter call print the contract's
 * literal instead of the caller's data, breaking the golden gate; one source per fact, injected
 * at the data seam by the path that owns resolution.
 */
function liabilityBlock(ctx: Ctx, d: TicketData): Content[] {
  const v = ctx.sections.get("liability")!;
  if (!v.visible) return []; // unreachable via prepareTickets' own gate; belt for direct callers
  return [{
    stack: [
      ...d.company.liabilityText.split(/\n\s*\n/).map((paragraph) => (
        { text: paragraph, fontSize: ctx.fonts.smallSize, margin: [0, 0, 0, 4] as [number, number, number, number] })),
      rule([0, 2, 0, 0]),
    ],
    margin: [0, 2, 0, 8],
  }];
}

/** "Shipped Complete" (only when every line on this ticket is lineComplete AND the field is
 *  visible), then the Quantity Shipped / Pounds Shipped pair — rows in config order, right of
 *  center as on the sample. */
function totalsBlock(ctx: Ctx, d: TicketData): Content[] {
  const { num, num2 } = ctx;
  const v = ctx.sections.get("totals")!;
  const banner = v.field("shipped_complete").visible && d.shippedComplete;

  const rowFor = (key: string): TableCell[] => key === "total_qty"
    ? [
      { text: v.field(key).label, bold: true, fontSize: 12, alignment: "right" },
      { text: num(d.totalQty), fontSize: 11, alignment: "right" },
    ]
    : [
      { text: v.field(key).label, bold: true, fontSize: 12, alignment: "right" },
      { text: num2(d.totalWeight), fontSize: 11, alignment: "right" },
    ];
  const rowKeys = v.order.filter((k) => (k === "total_qty" || k === "total_weight") && v.field(k).visible);

  const out: Content[] = [];
  if (banner) {
    out.push({
      text: v.field("shipped_complete").label, bold: true, fontSize: 12,
      alignment: "center", margin: [0, 2, 0, 6],
    });
  }
  if (rowKeys.length > 0) {
    out.push({
      columns: [
        { width: "*", text: "" },
        {
          width: 260,
          table: { widths: ["*", 80], body: rowKeys.map(rowFor) },
          layout: "noBorders",
        },
      ],
    });
  }
  return out;
}

/**
 * The footer tear-off strip, pinned to the page bottom with `absolutePosition` (plain JSON —
 * the one instrument a data-only definition has for the sample's page-bottom placement; the
 * blank middle of the sample page is genuinely blank).
 *
 * Bare order number — the sample's tear-off prints "72036", not "72036-3" — totals again in
 * their boxed pair, the hand-completed Received By / Date rules, then Sold To and Shipped ON.
 * Config mapping (a hand-laid strip, the traveler footer's grouping decision): fields group into
 * the ROWS they anchor — {order no, shipped complete, the totals pair}, {received by, date},
 * {sold to, shipped on}. A group renders when ANY member is visible (a hidden half leaves an
 * empty slot so its sibling holds position), groups sort by their earliest visible member's
 * config position, and a group with nothing visible drops.
 *
 * "Shipped ON" is `paddedDate` UNCONDITIONALLY — the two-date-styles trap (header comment): the
 * date knob is the header's; it must never move this line.
 */
function tearOff(ctx: Ctx, d: TicketData): Content[] {
  const { num2 } = ctx;
  const v = ctx.sections.get("tear_off")!;
  const f = v.field;

  type Group = { members: string[]; build: () => Content };
  const groups: Group[] = [
    {
      members: ["tear_order_no", "tear_shipped_complete", "tear_total_qty", "tear_total_weight"],
      build: () => {
        const totalRows = v.order
          .filter((k) => (k === "tear_total_qty" || k === "tear_total_weight") && f(k).visible)
          .map((k): TableCell[] => [
            { text: f(k).label, bold: true, fontSize: 10.5 },
            { text: num2(k === "tear_total_qty" ? d.totalQty : d.totalWeight), alignment: "right" },
          ]);
        return {
          columns: [
            {
              width: "*",
              text: f("tear_order_no").visible ? `${f("tear_order_no").label} ${d.orderNumber}` : "",
              bold: true, fontSize: 11,
            },
            {
              width: 150,
              text: f("tear_shipped_complete").visible && d.shippedComplete
                ? f("tear_shipped_complete").label : "",
              bold: true, fontSize: 11, alignment: "center",
            },
            totalRows.length > 0
              ? {
                width: 200,
                table: { widths: ["*", 62], body: totalRows },
                layout: LAYOUT.boxed,
              }
              : { width: 200, text: "" },
          ],
          columnGap: 8,
        };
      },
    },
    {
      members: ["received_by", "received_date"],
      build: () => ({
        columns: [
          {
            width: 220,
            text: f("received_by").visible ? `${f("received_by").label} _______________________` : "",
            bold: true, fontSize: 9.5,
          },
          {
            width: "*",
            text: f("received_date").visible ? `${f("received_date").label} _______________` : "",
            bold: true, fontSize: 9.5,
          },
        ],
        margin: [0, 12, 0, 0],
      }),
    },
    {
      members: ["tear_sold_to", "shipped_on"],
      build: () => ({
        columns: [
          {
            width: "*",
            text: f("tear_sold_to").visible ? `${f("tear_sold_to").label} ${d.soldTo.name}` : "",
            bold: true, fontSize: 9.5,
          },
          {
            // paddedDate, NEVER ctx.headerDate — the two-date-styles trap (see the doc comment).
            width: 180,
            text: f("shipped_on").visible ? `${f("shipped_on").label} ${paddedDate(d.shipDate)}` : "",
            bold: true, fontSize: 9.5, alignment: "right",
          },
        ],
        margin: [0, 10, 0, 0],
      }),
    },
  ];

  const active = groups
    .map((g) => ({ g, at: Math.min(...g.members.filter((k) => f(k).visible).map((k) => v.order.indexOf(k))) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at);
  if (active.length === 0) return [];

  return [{
    absolutePosition: { x: 24, y: 648 },
    stack: [rule([0, 0, 0, 6]), ...active.map(({ g }) => g.build())],
  }];
}

/** One config section key → its renderer. Empty array means "nothing left to draw" — the block
 *  drops from the stack, like a hidden section. An unknown key renders nothing: the validator
 *  refused it before any config stored it. */
function renderSection(key: string, ctx: Ctx, docType: TicketDocType, d: TicketData): Content[] {
  switch (key) {
    case "header": return headerBlock(ctx, d);
    case "parties": return partiesBlock(ctx, d);
    case "field_strip": return fieldStrip(ctx, docType, d);
    case "lines": return linesTable(ctx, docType, d);
    case "containers": return containersTable(ctx, docType, d);
    case "serials": return serialsBlock(ctx, d);
    case "liability": return liabilityBlock(ctx, d);
    case "totals": return totalsBlock(ctx, d);
    case "tear_off": return tearOff(ctx, d);
    default: return [];
  }
}

/** What both builders share: the resolved views and the per-ticket block stack. The §5.6 belt's
 *  OMISSION half lives here — views resolve over `completeSections(contract, config.sections)`,
 *  never `config.sections` raw, so a raw config omitting an entry cannot drop it. */
function prepareTickets(
  docType: TicketDocType, config: TemplateConfig, logoDataUri?: string,
): { ctx: Ctx; ticketBlocks: (d: TicketData) => Content[] } {
  const sectionConfigs = completeSections(CONTRACTS[docType], config.sections);
  const sections = new Map(sectionConfigs.map((sc) => [sc.key, sectionView(docType, sc)] as const));
  const ctx: Ctx = {
    fonts: config.fonts,
    num: makeNum(config.formats),
    num2: makeNum2(config.formats),
    headerDate: makeHeaderDate(config.formats),
    sections,
    logo: config.logo !== null && logoDataUri !== undefined
      ? { placement: config.logo.placement, width: config.logo.width, dataUri: logoDataUri }
      : null,
  };
  const ticketBlocks = (d: TicketData): Content[] => {
    const blocks: Content[] = [];
    // Stack order IS the config's section order; hidden sections are omitted (nothing on these
    // contracts is locked, so the belt forces none of them back).
    for (const sc of sectionConfigs) {
      if (!sections.get(sc.key)!.visible) continue;
      blocks.push(...renderSection(sc.key, ctx, docType, d));
    }
    return blocks;
  };
  return { ctx, ticketBlocks };
}

// ---------------------------------------------------------------------------------------------
// The builders (spec §10.1, P7 spec §5.4). PURE — data and config in, JSON out.
// ---------------------------------------------------------------------------------------------

/**
 * One sheet per `TicketData` — the traveler's per-load mechanic reused for orders (spec §3.20):
 * "print tickets" hands this every order on the shipment; "print this order's ticket" hands it
 * exactly one.
 *
 * `docType` names which contract the config was validated against (this ONE builder serves both
 * ticket types — header comment); `config` is a **backfilled** `TemplateConfig` and DEFAULTS to
 * that docType's own `DEFAULT_CONFIG` — the complete canonical constant the seeded "Standard"
 * template stores — so a config-less call renders exactly today's paper (the golden-compat gate)
 * without re-defaulting any individual key. `logoDataUri` is the traveler's deliberate extra
 * parameter: the logo bytes belong to the resolved template version, not to the shipment data.
 *
 * `config.pageFooter` is deliberately unconsumed by this whole-document shape: per-ticket page
 * numbers and continuation headers only exist per sheet GROUP (P7 spec §6.1) — the sheet-group
 * builder is this task's next step and shares `prepareTickets`, so per-ticket content cannot
 * drift between the two.
 */
export function buildShippingTicketDefinition(
  input: TicketData[],
  docType: TicketDocType = "SHIPPER",
  config: TemplateConfig = DEFAULT_CONFIGS[docType],
  logoDataUri?: string,
): TDocumentDefinitions {
  const { ticketBlocks } = prepareTickets(docType, config, logoDataUri);
  const content: Content[] = input.map((ticket, index) => ({
    // Page break BEFORE every sheet but the first — never a trailing blank page (the traveler's
    // own rule).
    ...(index === 0 ? {} : { pageBreak: "before" as const }),
    stack: ticketBlocks(ticket),
  }));
  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, 24],
    defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
    // No `info.creationDate`, no clock anywhere — two prints of the same shipment must not differ
    // for no reason (the traveler's purity rule).
    content,
  };
}
