/**
 * The certification (design spec §10.3, owner rulings §3.11/§3.19/§3.21). PURE by construction,
 * the traveler.ts contract: `CertPdfData` in, a plain-JSON pdfmake definition out — no I/O, no
 * clock, nothing that would not survive `JSON.parse(JSON.stringify())` (asserted in
 * tests/cert-pdf.test.ts). The reads live in certs.ts (`readCertPdfData`), the bytes in render.ts.
 *
 * §3.21 is enforced by this module's INPUT TYPE, not by discipline: `CertPdfData` carries no
 * min, no max, no pass/fail, no override flag and no per-reading structure — only bare reading
 * values under a line naming the specification and scale. What is not in the data cannot reach
 * the paper. Likewise `internalNotes` has no field here at all (spec §7.4 / §10.3's "Never
 * internalNotes").
 *
 * Layout mirrors the owner's `docs/samples/Certification Sample.pdf`, which IS the contract
 * (spec §3.1). Deviations are individually commented; there are no silent ones:
 *  - no logo top-left — the owner supplied none and Phase 7 owns logo upload (the ticket's own
 *    deviation, shipping-ticket.ts).
 *  - no "Page: 1 of 1" — a page count is not knowable to a pure JSON definition (the ticket's
 *    documented deviation; pdfmake exposes counts only to callbacks a data-only template cannot
 *    carry), and a hard-coded "1 of 1" would lie the moment a long cert wraps.
 *  - the sample's stray "73753" beside the address is Visual Shop's internal row id
 *    (the ticket's own ruling on the same artifact) — not printed.
 *  - the footer prints the company address and phone; the sample's trailing empty "Fax:" label
 *    has no field behind it in this model (there is no fax setting) — not printed (do not invent
 *    fields, the ticket's "Temper Only" precedent).
 *  - the signature block is flow-laid with a top margin, never `absolutePosition` (the Task 18
 *    review's tear-off collision lesson) — on a long cert it follows the content instead of
 *    overprinting it.
 */
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { LAYOUT } from "./render";

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
   *  (ruling 27): a single-part cert renders heading-free, identical to the §3.21 sample. */
  linePosition: number; partNumber: string; partName: string;
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
  statement: string;                   // the `cert_statement` standing block (§3.21)
  requirements: CertRequirementBlock[];
  serialBlocks: CertSerialBlock[];
  freeform: string;
  signer: CertSigner;
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, locale pinned (the traveler's own rule).
// ---------------------------------------------------------------------------------------------

/** Thousands-separated, at most 2 decimals — "4,128", "192". */
function num(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** A reading value, at least one decimal (the sample's "30.0", "25.6" style) and at most the
 *  column's own four ("28.1234" survives untouched). */
function reading(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 4 });
}

/** "2026-08-03" -> "08/03/2026" — the sample header's zero-padded style. Pure string work. */
function paddedDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
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
// Blocks, top to bottom in sample order.
// ---------------------------------------------------------------------------------------------

/** Company name over the big "Certification" title, centered; Order No. / Date / Entry Date
 *  right — the sample's header, minus logo and page count (see the file comment). */
function headerBlock(d: CertPdfData): Content {
  return {
    columns: [
      { width: 100, text: "" },
      {
        width: "*",
        stack: [
          { text: d.company.name, bold: true, fontSize: 12, alignment: "center" },
          { text: "Certification", bold: true, fontSize: 19, alignment: "center", margin: [0, 2, 0, 0] },
        ],
      },
      {
        width: 165,
        stack: [
          { text: `Order No.: ${d.orderLabel}`, bold: true, fontSize: 10.5 },
          { text: `Date: ${paddedDate(d.printDate)}`, bold: true, fontSize: 10, margin: [0, 2, 0, 0] },
          { text: `Entry Date: ${paddedDate(d.entryDate)}`, bold: true, fontSize: 10, margin: [0, 2, 0, 0] },
        ],
      },
    ],
    columnGap: 8,
    margin: [0, 0, 0, 6],
  };
}

/** "To:" (the customer at their billing address) left; PO / Packing List / Material right. */
function partiesBlock(d: CertPdfData): Content {
  return {
    columns: [
      {
        width: "*",
        stack: [
          { text: "To:", bold: true, fontSize: 11, decoration: "underline" },
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
      },
      {
        width: 240,
        stack: [
          { text: `Purchase Order No.: ${d.poNumber}`, bold: true, fontSize: 10, margin: [0, 14, 0, 0] },
          { text: `Packing List No.: ${packingListNo(d.packingListNo)}`, bold: true, fontSize: 10, margin: [0, 2, 0, 0] },
          { text: `Material: ${d.material}`, bold: true, fontSize: 10, margin: [0, 2, 0, 0] },
        ],
      },
    ],
    columnGap: 10,
    margin: [0, 0, 0, 4],
  };
}

/** Quantity | Part Number / Part Name / Part Description (stacked) | Pounds — one row per part
 *  line with scope-appropriate quantities (§10.3), the ticket's own stacked-cell shape. */
function partsTable(d: CertPdfData): Content {
  return {
    table: {
      headerRows: 1,
      widths: [70, "*", 90],
      body: [
        [head("Quantity"), head("Part Number  /  Part Name  /  Part Description"), head("Pounds")],
        ...d.parts.map((p): TableCell[] => [
          { text: p.qty === null ? "" : num(p.qty), alignment: "right" },
          { stack: [p.partNumber, p.partName, p.partDescription].filter((t) => t !== "").map((text) => ({ text })) },
          { text: p.pounds === null ? "" : num(p.pounds), alignment: "right" },
        ]),
      ],
    },
    layout: LAYOUT.ruled,
    margin: [0, 0, 0, 10],
  };
}

/**
 * One requirement: the line naming the specification and scale (the sample's "Were heat treated
 * as per P.O. NONE to HRC:"), then the bare three-across grid of reading values — no min/max, no
 * scale column, no pass/fail, no override marker (§3.21; also see the file comment: none of that
 * is even in this builder's input).
 */
function requirementBlock(r: CertRequirementBlock): Content {
  return {
    stack: [
      { text: r.scale === "" ? `${r.specification}:` : `${r.specification} to ${r.scale}:`, fontSize: 9.5, margin: [0, 0, 0, 4] },
      ...chunk3(r.readings).map((row) => ({
        text: row.map(reading).join("   |   "), fontSize: 9.5, margin: [0, 0, 0, 3] as [number, number, number, number],
      })),
    ],
    margin: [0, 4, 0, 6],
  };
}

/**
 * The requirement blocks, grouped by frozen line (ruling 27, issue #55): a cert spanning MORE
 * than one part heads each line group with its frozen part identity — without it, two parts
 * sharing an inspection code print indistinguishable grids of readings. A single-part cert emits
 * the bare blocks exactly as before: the owner's §3.21 sample carries no headings, and this
 * deviates from it only where the sample's shape could not answer which part a grid certifies.
 */
function requirementSection(d: CertPdfData): Content[] {
  // Multi-part detection reads the PARTS TABLE, not the requirement rows (#57 review): a cert
  // listing two parts where only one is inspected still needs its one grid attributed. The
  // grouping key is the full frozen identity, never `linePosition` alone — `removeLine` frees
  // positions and a later rider re-uses them (#57 review, P1), so two different parts can share
  // a number; the composite keeps each part's readings under its own heading.
  if (d.parts.length <= 1) return d.requirements.map(requirementBlock);

  const out: Content[] = [];
  let current: string | null = null;
  for (const r of d.requirements) {
    const identity = `${r.linePosition}\u0000${r.partNumber}\u0000${r.partName}`;
    if (identity !== current) {
      current = identity;
      out.push({ text: `${r.partNumber} — ${r.partName}`, bold: true, fontSize: 9.5, margin: [0, 6, 0, 2] });
    }
    out.push(requirementBlock(r));
  }
  return out;
}

/** Each part line's serials with their description — the heat/lot field Phase 3 added for exactly
 *  this (§10.3). The sample order carried none, so the shape is the ticket's own serial block,
 *  per part. Renders nothing when no line has serials. */
function serialBlocks(d: CertPdfData): Content[] {
  return d.serialBlocks.filter((b) => b.serials.length > 0).map((b) => ({
    stack: [
      { text: `Serial Numbers — ${b.partNumber}:`, bold: true, fontSize: 9, margin: [0, 0, 0, 2] },
      ...b.serials.map((s) => ({ text: s.description === "" ? s.serial : `${s.serial} — ${s.description}`, fontSize: 9 })),
    ],
    margin: [0, 2, 0, 4] as [number, number, number, number],
  }));
}

/**
 * The signature block, bottom right (§3.11): the printing user's signature image above the rule —
 * or their display name TYPED over the rule when no image is on file (visible, blocking nothing,
 * never a fabricated mark) — then the typed name, title (only when one exists — see CertSigner)
 * and company.
 */
function signatureBlock(d: CertPdfData): Content {
  const s = d.signer;
  return {
    columns: [
      { width: "*", text: "" },
      {
        width: 250,
        stack: [
          s.signatureDataUri === null
            ? { text: s.name, fontSize: 13, alignment: "center", margin: [0, 0, 0, 2] as [number, number, number, number] }
            : { image: s.signatureDataUri, fit: [220, 45] as [number, number], alignment: "center" as const, margin: [0, 0, 0, 2] as [number, number, number, number] },
          { canvas: [{ type: "line", x1: 0, y1: 0, x2: 250, y2: 0, lineWidth: 1 }] },
          { text: s.name, fontSize: 10, margin: [4, 3, 0, 0] },
          ...(s.title === "" ? [] : [{ text: s.title, fontSize: 10, margin: [4, 1, 0, 0] as [number, number, number, number] }]),
          { text: s.company, fontSize: 10, margin: [4, 1, 0, 0] },
        ],
      },
    ],
    margin: [0, 24, 0, 0],
  };
}

/** The page footer: company address left, phone right — the sample's bottom strip (no Fax; see
 *  the file comment). A static pdfmake footer (plain JSON — no callback) so it lands on every
 *  page of a wrapped cert. */
function footerBlock(d: CertPdfData): Content {
  return {
    columns: [
      { width: "*", text: d.company.address, fontSize: 7.5 },
      { width: 200, text: `Phone: ${d.company.phone}`, bold: true, fontSize: 7.5, alignment: "right" },
    ],
    margin: [24, 6, 24, 0],
  };
}

// ---------------------------------------------------------------------------------------------
// The built-in default certification template (spec §10.3). PURE — data in, JSON out.
// ---------------------------------------------------------------------------------------------

export function buildCertDefinition(input: CertPdfData): TDocumentDefinitions {
  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, 44],
    defaultStyle: { font: "Roboto", fontSize: 9 },
    // No `info.creationDate`, no clock anywhere — the print DATE is data (`printDate`), passed in
    // by printCert, so the builder itself stays deterministic (the traveler's purity rule).
    footer: footerBlock(input),
    content: [
      headerBlock(input),
      partiesBlock(input),
      rule([0, 2, 0, 4]),
      partsTable(input),
      { text: input.statement, fontSize: 9.5, margin: [0, 2, 0, 8] },
      ...requirementSection(input),
      ...serialBlocks(input),
      ...(input.freeform === "" ? [] : [{ text: input.freeform, fontSize: 9.5, margin: [0, 6, 0, 0] as [number, number, number, number] }]),
      signatureBlock(input),
    ],
  };
}
