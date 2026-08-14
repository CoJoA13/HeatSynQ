/**
 * The certification (design spec §10.3, owner rulings §3.11/§3.19/§3.21). PURE by construction,
 * the traveler.ts contract: `CertPdfData` + a validated `TemplateConfig` in, a plain-JSON pdfmake
 * definition out — no I/O, no clock, nothing that would not survive `JSON.parse(JSON.stringify())`
 * (asserted in tests/cert-pdf.test.ts). The reads live in certs.ts (`readCertPdfData`), the bytes
 * in render.ts.
 *
 * A CONFIG-CONSUMER since Phase 7 Task 11 (P7 spec §5.4) — the BOL's exact lens (`sectionView`
 * over `completeSections`, the §5.6 belt in both halves): sections/fields/labels/widths/fonts/
 * formats render from a validated config, and the default config reproduces today's paper exactly
 * (the golden gate, tests/cert-pdf.test.ts, untouched). Two deliberate departures from the BOL:
 *
 *  - **`cert_statement` binds through the DATA SEAM, not `config.textBlocks`** (the TICKET's
 *    liability-text shape, not the BOL's form-constant shape). certs.ts ALREADY reads the Setting
 *    into `CertPdfData.statement`, so the statement is caller data, not a builder literal — binding
 *    the builder to config would create two sources for one fact and break the pure-builder golden
 *    test. `printCert` injects `config.textBlocks.cert_statement` at that seam instead; the
 *    `statement` section here is a text-block section with no fields of its own, and the builder
 *    renders `input.statement` verbatim.
 *  - **§3.21 is enforced by the INPUT TYPE, and the config cannot widen it.** `CertPdfData` carries
 *    no min, no max, no pass/fail, no override and no per-reading structure — only bare reading
 *    values under a line naming the specification and scale. A config can only REARRANGE what the
 *    data layer collects; the cert's data layer deliberately never collects those, so no field
 *    below can bind one. Likewise `internalNotes` has no field here at all (spec §7.4 / §10.3's
 *    "Never internalNotes"; §5.6: "not in the contract at all — nothing to lock").
 *
 * **THE DATE KNOB HAS NO STYLE TRAP HERE** (the ticket's two-date-styles rule, generalized: map the
 * knob to exactly the slots the contract's default reproduces). This builder was grepped for every
 * date call before the knob was mapped — `certDate` renders the Date and Entry Date header slots,
 * BOTH the sample's MM/DD/YYYY style — so the contract's single knob maps to those two same-style
 * slots directly, no second style to trap.
 *
 * Layout mirrors the owner's `docs/samples/Certification Sample.pdf`, which IS the contract
 * (spec §3.1). Deviations are individually commented; there are no silent ones:
 *  - the top-left logo is Phase 7's (spec §6.3) — the sample's own logo area, off by default (the
 *    owner supplied none): a config that places one fills the header's 100pt left spacer.
 *  - no "Page: 1 of 1" by default — a page count is not knowable to a pure JSON definition, and a
 *    hard-coded "1 of 1" would lie the moment a long cert wraps; the `pageFooter` knob (spec §6.1)
 *    turns the real per-page count on when a template wants it.
 *  - the sample's stray "73753" beside the address is Visual Shop's internal row id (the ticket's
 *    own ruling on the same artifact) — not printed.
 *  - the footer prints the company address and phone; the sample's trailing empty "Fax:" label has
 *    no field behind it in this model (there is no fax setting) — not printed (do not invent
 *    fields, the ticket's "Temper Only" precedent).
 *  - the signature block is flow-laid with a top margin, never `absolutePosition` (the Task 18
 *    review's tear-off collision lesson) — on a long cert it follows the content instead of
 *    overprinting it. Its RENDERING SEMANTICS (§3.11 — image over the rule, or the typed name when
 *    no image is on file) stay the builder's own and are BYTE-IDENTICAL to pre-conversion under
 *    the default config (pinned through the definition and rendered bytes, tests/cert-templates).
 */
import type { Column, Content, TableCell } from "pdfmake/interfaces";
import { LAYOUT, type RenderableDefinition } from "./render";
import { CERT_CONTRACT, DEFAULT_CONFIG } from "../../lib/template-contracts/cert";
import {
  completeSections,
  type FontsConfig, type FormatsConfig, type LogoPlacement, type SectionConfig,
  type TemplateConfig,
} from "../../lib/template-contracts/types";

// ---------------------------------------------------------------------------------------------
// CertPdfData — the builder's whole input. Plain data: no Decimals, no Dates, no Prisma rows.
// ---------------------------------------------------------------------------------------------

export type CertCompany = { name: string; address: string; phone: string };
export type CertParty = { name: string; street: string; city: string; state: string; zip: string };
/** `qty`/`pounds` nullable: a LOAD-scope cert against a load whose split left qty/weight blank
 *  prints a blank cell, never an invented zero. */
export type CertPartRow = { qty: number | null; partNumber: string; partName: string; partDescription: string; pounds: number | null };
/** One §10.3 requirement block: the line naming the specification and scale, then bare values. */
export type CertRequirementBlock = {
  /** Frozen line identity (ruling 24) — consumed only when the cert spans more than one part
   *  (ruling 27): a single-part cert renders heading-free, identical to the §3.21 sample.
   *  `lineIdentity` is the never-reused grouping key (#57 review — the seed-line cuid, or the
   *  composite fallback for rows released before the backfill). */
  lineIdentity: string; linePosition: number; partNumber: string; partName: string;
  specification: string; scale: string; readings: number[];
};
export type CertSerialBlock = { partNumber: string; serials: { serial: string; description: string }[] };
/** §3.11: the PRINTING user's signature image above their typed name/title/company — or the name
 *  typed over the rule when no image is on file. `title` prints only when non-empty: the sample
 *  shows one ("Production Manager") but this system's User record carries no title field, so the
 *  collector passes "" and the line is omitted rather than fabricated. */
export type CertSigner = { name: string; title: string; company: string; signatureDataUri: string | null };
export type CertPdfData = {
  company: CertCompany;
  orderLabel: string;                  // "72036-3" for shipment scope, "72036" otherwise (§10.3)
  printDate: string;                   // "yyyy-mm-dd" — the day this print happened
  entryDate: string;                   // the order's received date
  to: CertParty;
  poNumber: string;
  packingListNo: number | null;        // the shipment's shipperNumber where one applies
  material: string;                    // the lead part's material
  parts: CertPartRow[];
  statement: string;                   // the `cert_statement` block, bound at printCert's data seam
  requirements: CertRequirementBlock[];
  serialBlocks: CertSerialBlock[];
  freeform: string;
  signer: CertSigner;
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, config-driven (P7 spec §5.4's per-file formatting helpers), locale pinned
// (the traveler's own rule) so output never tracks the server's.
// ---------------------------------------------------------------------------------------------

/** Thousands-separated per the knob, at most 2 decimals — "4,128", "192". */
function makeNum(formats: FormatsConfig): (value: number) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => value.toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping });
}

/** A reading value, at least one decimal (the sample's "30.0", "25.6" style) and at most the
 *  column's own four ("28.1234" survives untouched). DATA PRECISION, not a knob (the cert contract
 *  carries no price-decimals surface) — a pure literal function, never config-driven. */
function reading(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 4 });
}

const MONTHS_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The header's Date / Entry Date, driven by the contract's ONE date knob (default "MM/DD/YYYY" —
 * the sample's own zero-padded style). The paper's ONLY date slots, BOTH this same style — see the
 * header comment's no-trap note. Pure string work — parsing to a Date would drag a timezone into a
 * date-only value (src/lib/business-days.ts's whole point).
 */
function makeCertDate(formats: FormatsConfig): (iso: string) => string {
  const format = formats.dateFormat ?? "MM/DD/YYYY";
  return (iso) => {
    const [y, m, d] = iso.split("-");
    switch (format) {
      case "M/D/YYYY": return `${Number(m)}/${Number(d)}/${y}`;
      case "YYYY-MM-DD": return iso;
      case "MMMM D, YYYY": return `${MONTHS_FULL[Number(m) - 1]} ${Number(d)}, ${y}`;
      case "MMM - DD - YYYY": return `${MONTHS_ABBR[Number(m) - 1]} - ${d} - ${y}`;
      default: return `${m}/${d}/${y}`; // "MM/DD/YYYY" — the sample's own
    }
  };
}

/** The packing list number zero-padded to six digits — the sample prints "072826" (the ticket's
 *  own rule); blank (never "000000") when the cert has no shipment. */
function packingListNo(n: number | null): string {
  return n === null ? "" : String(n).padStart(6, "0");
}

const head = (text: string): TableCell => ({ text, bold: true, alignment: "center" });

/** LETTER (612pt) minus the 24pt margins. */
const CONTENT_WIDTH = 564;

const rule = (margin: [number, number, number, number], lineWidth = 1.5): Content =>
  ({ canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth }], margin });

/** Splits `values` into rows of three — the sample's own three-across readings grid. */
function chunk3<T>(values: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < values.length; i += 3) rows.push(values.slice(i, i + 3));
  return rows;
}

// ---------------------------------------------------------------------------------------------
// The config lens (P7 spec §5.4) — the BOL's `sectionView`, applied to the cert's blocks. The
// builder ASSUMES a complete config (`validateConfig`'s §5.3 backfill guarantees every entry
// exists); only the null-means-contract-default knobs a complete config still carries resolve here.
//
// THE §5.6 BELT, both halves: the flag half (`visible || !hideable` / `visible || !removable`) is
// the BOL's expression verbatim — NOTHING on this contract is locked, so it forces nothing and a
// config may hide anything; the omission half is `completeSections` in `buildCertDefinition` below,
// so a raw config that OMITS an entry still renders it. (The BOL's third, text-block half is absent
// here: the cert's one text block, `cert_statement`, binds at the DATA SEAM, not through the
// builder — see the file comment.)
// ---------------------------------------------------------------------------------------------

const CONTRACT_SECTIONS = new Map(CERT_CONTRACT.sections.map((s) =>
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
  if (cs === undefined) throw new Error(`Unknown CERT template section "${sc.key}"`);
  const byKey = new Map(sc.fields.map((f) => [f.key, f]));
  return {
    visible: sc.visible || !cs.section.hideable, // the belt, section half (nothing locked here)
    order: sc.fields.map((f) => f.key),
    field: (key) => {
      const cf = cs.fields.get(key);
      if (cf === undefined) throw new Error(`Unknown CERT template field "${sc.key}.${key}"`);
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
  /** The date knob's two consumers — the Date and Entry Date header slots (same style). */
  date: (iso: string) => string;
  sections: Map<string, SectionView>;
  /** Present only when the resolved version carries logo BYTES and the config PLACES them
   *  (spec §6.3) — either alone renders today's text-only header. */
  logo: { placement: LogoPlacement; width: number; dataUri: string } | null;
};

/** This section's visible column-field keys, in config order — what the parts table turns into its
 *  `widths` and its per-row cells. */
function columnKeys(v: SectionView, sectionKey: string): string[] {
  const cs = CONTRACT_SECTIONS.get(sectionKey)!;
  return v.order.filter((k) => cs.fields.get(k)?.column !== undefined && v.field(k).visible);
}

// ---------------------------------------------------------------------------------------------
// Blocks, top to bottom in sample order. Each returns Content[] — empty means "nothing left to
// draw" (every configurable piece hidden) and the block drops from the stack. The `footer` section
// is pulled OUT of the content flow into the page-margin strip (below), so it has no renderer here.
// ---------------------------------------------------------------------------------------------

/**
 * Company name over the big "Certification" title, centered; Order No. / Date / Entry Date right —
 * the sample's header. TWO structural slots hand-laid on the sample: the centered title stack
 * (company name + title) and the right order-fields stack; config field ORDER applies WITHIN each
 * slot, and a field never migrates between them (the BOL header's documented mapping decision). The
 * title's label IS its printed text, so a label override renames it; the date slots carry the knob.
 *
 * A placed logo (spec §6.3) fills the 100pt left spacer where the sample's logo area sits
 * (header-left) or joins the top of the title/order-field stack (header-center/header-right) — only
 * a placed logo changes the structure (golden: no logo → today's spacer-left header, byte-for-byte).
 */
function headerBlock(ctx: Ctx, d: CertPdfData): Content[] {
  const v = ctx.sections.get("header")!;
  const pick = (keys: string[]): string[] =>
    v.order.filter((k) => keys.includes(k) && v.field(k).visible);

  const center: Content[] = [];
  for (const key of pick(["company_name", "title"])) {
    if (key === "company_name") center.push({ text: d.company.name, bold: true, fontSize: 12, alignment: "center" });
    else center.push({ text: v.field(key).label, bold: true, fontSize: ctx.fonts.headingSize, alignment: "center", margin: [0, 2, 0, 0] });
  }

  const right: Content[] = [];
  for (const key of pick(["order_no", "print_date", "entry_date"])) {
    if (key === "order_no") right.push({ text: `${v.field(key).label} ${d.orderLabel}`, bold: true, fontSize: 10.5 });
    else if (key === "print_date") right.push({ text: `${v.field(key).label} ${ctx.date(d.printDate)}`, bold: true, fontSize: 10, margin: [0, 2, 0, 0] });
    else right.push({ text: `${v.field(key).label} ${ctx.date(d.entryDate)}`, bold: true, fontSize: 10, margin: [0, 2, 0, 0] });
  }

  const logoNode: Content | null = ctx.logo === null ? null : { image: ctx.logo.dataUri, width: ctx.logo.width };
  if (logoNode !== null && ctx.logo!.placement === "header-center") center.unshift(logoNode);
  if (logoNode !== null && ctx.logo!.placement === "header-right") right.unshift(logoNode);
  if (center.length + right.length === 0 && !(logoNode !== null && ctx.logo!.placement === "header-left")) return [];

  const leftColumn: Column = logoNode !== null && ctx.logo!.placement === "header-left"
    ? { width: ctx.logo!.width, stack: [logoNode] }
    : { width: 100, text: "" };

  return [{
    columns: [leftColumn, { width: "*", stack: center }, { width: 165, stack: right }],
    columnGap: 8,
    margin: [0, 0, 0, 6],
  }];
}

/** "To:" (the customer at their billing address) left; PO / Packing List / Material right, then the
 *  full-width rule that closes the parties block (the BOL's inter-block-rule-as-section-glue rule:
 *  it hides and travels with parties). The `to` box is one bound blob (the ticket's party-box
 *  shape); each right field drops its label+value line when hidden. */
function partiesBlock(ctx: Ctx, d: CertPdfData): Content[] {
  const v = ctx.sections.get("parties")!;
  const f = v.field;
  const cols: Column[] = [];

  if (f("to").visible) {
    cols.push({
      width: "*",
      stack: [
        { text: f("to").label, bold: true, fontSize: 11, decoration: "underline" },
        { text: d.to.name, fontSize: 10, margin: [0, 2, 0, 0] },
        { text: d.to.street, fontSize: 10 },
        {
          columns: [
            { width: 120, text: d.to.city, fontSize: 10 },
            { width: 40, text: d.to.state, fontSize: 10 },
            { width: 60, text: d.to.zip, fontSize: 10 },
          ],
          margin: [0, 8, 0, 0],
        },
      ],
    });
  }

  const rightStack: Content[] = [];
  if (f("po_number").visible) rightStack.push({ text: `${f("po_number").label} ${d.poNumber}`, bold: true, fontSize: 10, margin: [0, 14, 0, 0] });
  if (f("packing_list_no").visible) rightStack.push({ text: `${f("packing_list_no").label} ${packingListNo(d.packingListNo)}`, bold: true, fontSize: 10, margin: [0, 2, 0, 0] });
  if (f("material").visible) rightStack.push({ text: `${f("material").label} ${d.material}`, bold: true, fontSize: 10, margin: [0, 2, 0, 0] });
  if (rightStack.length > 0) cols.push({ width: 240, stack: rightStack });

  if (cols.length === 0) return [];
  return [{ columns: cols, columnGap: 10, margin: [0, 0, 0, 4] }, rule([0, 2, 0, 4])];
}

/** Quantity | Part Number / Part Name / Part Description (stacked) | Pounds — one row per part
 *  line with scope-appropriate quantities (§10.3), the ticket's own stacked-cell shape. Columns,
 *  labels and widths are config-driven; hiding a column drops its header cell, width and per-row
 *  cell together. */
function partsTable(ctx: Ctx, d: CertPdfData): Content[] {
  const { num } = ctx;
  const v = ctx.sections.get("parts")!;
  const cols = columnKeys(v, "parts");
  if (cols.length === 0) return [];

  const cellFor = (key: string, p: CertPartRow): TableCell => {
    switch (key) {
      case "part_qty": return { text: p.qty === null ? "" : num(p.qty), alignment: "right" };
      case "part_identity": return { stack: [p.partNumber, p.partName, p.partDescription].filter((t) => t !== "").map((text) => ({ text })) };
      default: return { text: p.pounds === null ? "" : num(p.pounds), alignment: "right" }; // part_pounds
    }
  };

  return [{
    table: {
      headerRows: 1,
      widths: cols.map((k) => v.field(k).width),
      body: [
        cols.map((k) => head(v.field(k).label)),
        ...d.parts.map((p): TableCell[] => cols.map((k) => cellFor(k, p))),
      ],
    },
    layout: LAYOUT.ruled,
    margin: [0, 0, 0, 10],
  }];
}

/** The §3.21 certification statement — `input.statement`, the block `printCert` binds from the
 *  config's `cert_statement` at the data seam (see the file comment). No fields of its own (the
 *  shipper-liability precedent); the whole section hides when the config hides it. */
function statementBlock(d: CertPdfData): Content[] {
  return [{ text: d.statement, fontSize: 9.5, margin: [0, 2, 0, 8] }];
}

/**
 * One requirement: the line naming the specification and scale (the sample's "Were heat treated
 * as per P.O. NONE to HRC:"), then the bare three-across grid of reading values — no min/max, no
 * scale column, no pass/fail, no override marker (§3.21; also see the file comment: none of that
 * is even in this builder's input). The spec line and readings grid are each a config-gated field.
 */
function requirementBlock(v: SectionView, r: CertRequirementBlock): Content {
  const parts: Content[] = [];
  if (v.field("spec_line").visible) {
    parts.push({ text: r.scale === "" ? `${r.specification}:` : `${r.specification} to ${r.scale}:`, fontSize: 9.5, margin: [0, 0, 0, 4] });
  }
  if (v.field("readings").visible) {
    parts.push(...chunk3(r.readings).map((row) => ({
      text: row.map(reading).join("   |   "), fontSize: 9.5, margin: [0, 0, 0, 3] as [number, number, number, number],
    })));
  }
  return { stack: parts, margin: [0, 4, 0, 6] };
}

/**
 * The requirement blocks, grouped by frozen line (ruling 27, issue #55): a cert spanning MORE
 * than one part heads each line group with its frozen part identity — without it, two parts
 * sharing an inspection code print indistinguishable grids of readings. A single-part cert emits
 * the bare blocks exactly as before: the owner's §3.21 sample carries no headings, and this
 * deviates from it only where the sample's shape could not answer which part a grid certifies. The
 * grouping is UNCHANGED by the conversion — the `part_heading` field only gates the heading's
 * visibility; the frozen-identity comparison that decides a group boundary is untouched.
 */
function requirementSection(ctx: Ctx, d: CertPdfData): Content[] {
  const v = ctx.sections.get("requirements")!;
  // Multi-part detection reads the PARTS TABLE, not the requirement rows (#57 review): a cert
  // listing two parts where only one is inspected still needs its one grid attributed. The
  // grouping key is the full frozen identity, never `linePosition` alone — `removeLine` frees
  // positions and a later rider re-uses them (#57 review, P1), so two different parts can share
  // a number; the composite keeps each part's readings under its own heading.
  if (d.parts.length <= 1) return d.requirements.map((r) => requirementBlock(v, r));

  const out: Content[] = [];
  let current: string | null = null;
  for (const r of d.requirements) {
    if (r.lineIdentity !== current) {
      current = r.lineIdentity;
      if (v.field("part_heading").visible) {
        out.push({ text: `${r.partNumber} — ${r.partName}`, bold: true, fontSize: 9.5, margin: [0, 6, 0, 2] });
      }
    }
    out.push(requirementBlock(v, r));
  }
  return out;
}

/** Each part line's serials with their description — the heat/lot field Phase 3 added for exactly
 *  this (§10.3). The sample order carried none, so the shape is the ticket's own serial block,
 *  per part. The label root ("Serial Numbers") is the overridable part; the em-dash glue and part
 *  number stay the builder's. Renders nothing when the field is hidden or no line has serials. */
function serialBlocks(ctx: Ctx, d: CertPdfData): Content[] {
  const v = ctx.sections.get("serials")!;
  if (!v.field("serials").visible) return [];
  const label = v.field("serials").label;
  return d.serialBlocks.filter((b) => b.serials.length > 0).map((b) => ({
    stack: [
      { text: `${label} — ${b.partNumber}:`, bold: true, fontSize: 9, margin: [0, 0, 0, 2] },
      ...b.serials.map((s) => ({ text: s.description === "" ? s.serial : `${s.serial} — ${s.description}`, fontSize: 9 })),
    ],
    margin: [0, 2, 0, 4] as [number, number, number, number],
  }));
}

/** The cert's PRINTABLE freeform text (spec §7.4's sanctioned half — never internalNotes). Drops
 *  when the field is hidden or the text is empty. */
function freeformBlock(ctx: Ctx, d: CertPdfData): Content[] {
  const v = ctx.sections.get("freeform")!;
  if (!v.field("freeform").visible || d.freeform === "") return [];
  return [{ text: d.freeform, fontSize: 9.5, margin: [0, 6, 0, 0] }];
}

/**
 * The signature block, bottom right (§3.11): the printing user's signature image above the rule —
 * or their display name TYPED over the rule when no image is on file (visible, blocking nothing,
 * never a fabricated mark) — then the typed name, title (only when one exists — see CertSigner)
 * and company. Each printed piece is a config-gated field, but under the DEFAULT config the emitted
 * node tree is BYTE-IDENTICAL to pre-conversion (untouchable §3.11; pinned in tests/cert-templates):
 * `signature_mark` is the image/typed-name over the rule, `signer_name`/`signer_title`/
 * `signer_company` the lines beneath. The labels are all value-only ("") — a label override has
 * nothing to replace (the BOL's `ship_from` decision).
 */
function signatureBlock(ctx: Ctx, d: CertPdfData): Content[] {
  const v = ctx.sections.get("signature")!;
  const f = v.field;
  const s = d.signer;
  const stack: Content[] = [];
  if (f("signature_mark").visible) {
    stack.push(
      s.signatureDataUri === null
        ? { text: s.name, fontSize: 13, alignment: "center", margin: [0, 0, 0, 2] }
        : { image: s.signatureDataUri, fit: [220, 45], alignment: "center", margin: [0, 0, 0, 2] },
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: 250, y2: 0, lineWidth: 1 }] },
    );
  }
  if (f("signer_name").visible) stack.push({ text: s.name, fontSize: 10, margin: [4, 3, 0, 0] });
  if (f("signer_title").visible && s.title !== "") stack.push({ text: s.title, fontSize: 10, margin: [4, 1, 0, 0] });
  if (f("signer_company").visible) stack.push({ text: s.company, fontSize: 10, margin: [4, 1, 0, 0] });
  if (stack.length === 0) return [];
  return [{ columns: [{ width: "*", text: "" }, { width: 250, stack }], margin: [0, 24, 0, 0] }];
}

/** The page footer strip: company address left, phone right — the sample's bottom strip (no Fax;
 *  see the file comment), at the config's `smallSize` role. Returns null when the footer section or
 *  both its fields are hidden. This is a PAGE-MARGIN strip, not a content-flow section: it renders
 *  in the footer slot regardless of its position in the config's section order, and rides the
 *  pageNofM footer's `above` slot when the `pageFooter` knob is on (buildCertDefinition below). */
function footerStrip(ctx: Ctx, d: CertPdfData): Content | null {
  const v = ctx.sections.get("footer")!;
  if (!v.visible) return null;
  const cols: Column[] = [];
  if (v.field("footer_address").visible) cols.push({ width: "*", text: d.company.address, fontSize: ctx.fonts.smallSize });
  if (v.field("footer_phone").visible) cols.push({ width: 200, text: `${v.field("footer_phone").label} ${d.company.phone}`, bold: true, fontSize: ctx.fonts.smallSize, alignment: "right" });
  if (cols.length === 0) return null;
  return { columns: cols, margin: [24, 6, 24, 0] };
}

/**
 * The cert's identity band — what a cert overflowing LETTER repeats on its continuation pages. A
 * real cert genuinely overflows: the readings (bounded at 500 per requirement), the parts (order
 * lines are unbounded, min(1) with no max) and the serials (bounded at 10,000) all grow past one
 * page (probed empirically, Task 11: 100 readings → 2 pages). Its identity is `Order No.:
 * <orderLabel>` (§10.3's own header field). Rendered REGARDLESS of the config's visibility flags
 * (the BOL band's identity treatment — identity on paper is locked, not configurable), though the
 * `order_no` label override still carries through. The `[24, 10, 24, 0]` margin aligns the band
 * with the page's 24pt side margins (pdfmake header content spans the full page width).
 */
const CONTINUATION_TOP_MARGIN = 40;
function continuationHeader(ctx: Ctx, d: CertPdfData): Content {
  const v = ctx.sections.get("header")!;
  return {
    stack: [
      { text: `${v.field("order_no").label} ${d.orderLabel}`, bold: true, fontSize: 11 },
      { text: "(continued)", italics: true, fontSize: ctx.fonts.smallSize },
    ],
    margin: [24, 10, 24, 0],
  };
}

/** One config section key → its renderer. The `footer` section is handled separately (the strip),
 *  so it renders nothing in the content flow. An unknown key renders nothing: the validator refused
 *  it before any config stored it. */
function renderSection(key: string, ctx: Ctx, d: CertPdfData): Content[] {
  switch (key) {
    case "header": return headerBlock(ctx, d);
    case "parties": return partiesBlock(ctx, d);
    case "parts": return partsTable(ctx, d);
    case "statement": return statementBlock(d);
    case "requirements": return requirementSection(ctx, d);
    case "serials": return serialBlocks(ctx, d);
    case "freeform": return freeformBlock(ctx, d);
    case "signature": return signatureBlock(ctx, d);
    default: return []; // footer (the page-margin strip) and any unknown key
  }
}

// ---------------------------------------------------------------------------------------------
// The built-in default certification template (spec §10.3, P7 spec §5.4). PURE — data and config
// in, JSON out.
// ---------------------------------------------------------------------------------------------

/**
 * `config` is a **backfilled** `TemplateConfig` (what `resolveTemplateForPrint` returns) and
 * DEFAULTS to the contract's own `DEFAULT_CONFIG` — the complete canonical constant the seeded
 * "Standard" template stores — so a config-less call renders exactly today's paper (the
 * golden-compat gate, tests/cert-pdf.test.ts). `logoDataUri` is the traveler's deliberate extra
 * parameter: the logo bytes belong to the resolved template version, not to the cert data.
 *
 * ONE definition — a multi-part cert is ONE sheet group (ruling 27: the per-part requirement
 * headings are §3.21 content WITHIN one document, never separate renders), so `renderPdf` consumes
 * the `RenderableDefinition` directly. The bottom margin is 44 unconditionally (the cert has always
 * carried a per-page company strip, unlike the BOL's 24pt default): the `pageFooter` knob does not
 * change the margin, only where the strip and the page count go.
 */
export function buildCertDefinition(
  input: CertPdfData,
  config: TemplateConfig = DEFAULT_CONFIG,
  logoDataUri?: string,
): RenderableDefinition {
  // The §5.6 belt's OMISSION half: views resolve over `completeSections`, never `config.sections`
  // raw, so a raw config omitting an entry cannot drop it.
  const sectionConfigs = completeSections(CERT_CONTRACT, config.sections);
  const sections = new Map(sectionConfigs.map((sc) => [sc.key, sectionView(sc)] as const));
  const ctx: Ctx = {
    fonts: config.fonts,
    num: makeNum(config.formats),
    date: makeCertDate(config.formats),
    sections,
    logo: config.logo !== null && logoDataUri !== undefined
      ? { placement: config.logo.placement, width: config.logo.width, dataUri: logoDataUri }
      : null,
  };

  const content: Content[] = [];
  // Stack order IS the config's section order; hidden sections are omitted (nothing on this
  // contract is locked, so the belt forces none of them back). The footer section never enters the
  // content flow — it is the page-margin strip below.
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
    // No `info.creationDate`, no clock anywhere — the print DATE is data (`printDate`), so the
    // builder itself stays deterministic (the traveler's purity rule).
    //
    // The `pageFooter` knob (spec §6.1) and the static company strip cannot both own pdfmake's one
    // `footer` slot (render.ts refuses two). Knob OFF (default — golden): the strip is a plain
    // static `footer`, exactly today. Knob ON: the strip rides the pageNofM footer's `above` slot,
    // stacked over the page line by render.ts's one callback (the reason `above` exists).
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
