/**
 * The quotation (Phase 6 design spec §6, ruling 12). PURE by construction, the traveler.ts
 * contract: `QuotePdfData` in, a pdfmake definition out — no I/O, no clock, no Prisma rows. The
 * reads (and the engine-computed indicative amounts) live in quotes.ts (`readQuotePdfData`), the
 * bytes in render.ts.
 *
 * UNLIKE its siblings this definition is NOT plain JSON: the quote render is code, not a Phase 7
 * JSON template (spec §6's explicit carve-out), so a pdfmake page callback is legal here and
 * `footer` is one — "Page: N of M" on every page, the count the pure-JSON documents had to
 * deviate away. There is deliberately no JSON-round-trip purity test for this builder.
 *
 * Layout mirrors the owner's `docs/samples/Quote_Sample_Form.jpeg`, which IS the contract
 * (ruling 12; the sample is VS's stock vendor form — the LAYOUT is the target, its demo content
 * is not). Deviations are individually commented; there are no silent ones:
 *  - **"Page: N of M" prints bottom-right (the footer callback), not the sample's top-right** —
 *    the plan names "pdfmake footer page numbers", and the footer keeps the count on every page
 *    of a wrapped quote without margin games in the header band.
 *  - **price details print the 5A vocabulary, not the sample's VS labels** (spec §6): "Setup
 *    charge: $X Plus / Price per <unit>: $Y Or / Minimum charge: $Z" replaces "Furnace Charge" /
 *    "Flat rate charge of" — same arrangement, this system's own price-row terms.
 *  - **no vendor "Fax:" / customer "Your Fax No.:" lines** — no fax field exists anywhere in
 *    this model (settings or contact); do not invent fields (the invoice's and cert's identical
 *    deviation).
 *  - the sample's "Supervisor" / "Jane's Department" lines are the VS contact's title/department
 *    — fields this model does not carry; the Attn block prints contact name, customer name and
 *    the bill-to address (spec §6's own transcription).
 *  - the signature block is flow-laid with a top margin, never `absolutePosition` (the Phase 4
 *    tear-off collision lesson) — on a long quote it follows the content instead of overprinting.
 */
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { LAYOUT } from "./render";

// ---------------------------------------------------------------------------------------------
// QuotePdfData — the builder's whole input. Plain data: no Decimals, no Dates, no Prisma rows.
// `amount` per price row is the ENGINE's indicative extended amount (quotes.ts feeds priceOrder a
// synthetic line from quotedQty + each-weight); null = omitted (unlimited / qty or weight
// unknown) — the builder never computes money, it prints what it is handed.
// ---------------------------------------------------------------------------------------------

export type QuoteCompany = { name: string; address: string; phone: string };
export type QuotePdfBreak = { threshold: number; price: number };
export type QuotePdfPriceRow = {
  stepName: string;
  notes: string;                       // the sample's per-row "Quote Notes" line
  setupCharge: number | null;
  unitPrice: number | null;
  minimumCharge: number | null;
  pricePerLabel: string;               // PRICE_PER_LABELS — "Each", "Per lb", "Lot (flat)", …
  breaks: QuotePdfBreak[];
  amount: number | null;
};
export type QuotePdfLine = {
  quotedQty: number | null;
  quotedUnlimited: boolean;
  partNumber: string;
  partName: string;
  partDescription: string;
  eachWeight: number | null;
  totalLbs: number | null;             // qty × each-weight when both known
  material: string;
  prices: QuotePdfPriceRow[];
};
export type QuotePdfData = {
  company: QuoteCompany;
  quoteNumber: number;
  effectiveDate: string;               // "yyyy-mm-dd"
  expiryDate: string;
  termsName: string;                   // the customer's terms name; "" prints a blank value
  rfqNumber: string;
  attn: string;                        // the picked contact's name; "" omits the Attn line
  customerPhone: string;               // the picked contact's phone; "" omits the line
  billTo: string[];                    // customer name + resolved bill-to address lines
  introText: string;                   // quote_intro_text (settings)
  lines: QuotePdfLine[];
  endingStatementText: string;         // the quote's picked ending statement (ruling 13); "" omits
  notes: string;                       // the quote's printable notes (spec §4.1 — never internalNotes)
  liabilityText: string;               // quote_liability_text (settings); "" omits
  signer: { name: string; title: string };  // quotedBy displayName + User.title (ruling 14)
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, locale pinned (the traveler's own rule) so output never tracks the server's.
// ---------------------------------------------------------------------------------------------

/** Money with a leading "$" and exactly two decimals — "$102.00" (the invoice's own `money`). */
function money(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A unit/break price: at least two decimals, up to the column's own four — "$0.15" stays
 *  "$0.15", "$0.0550" prints "$0.055". Quote prices are Decimal(12, 4) and a 4-decimal price
 *  rounded to cents would misstate the agreement (unlike an invoice's already-billed amount). */
function money4(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

/** A weight, always two decimals, no "$" — "1,000.00" (the invoice's own `weight`). */
function weight(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A quantity, integer, thousands-separated — "100", "1,440". */
function qty(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** A break threshold: thousands-separated, at most 2 decimals (pieces, or pounds on an LB row). */
function num(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** "2018-06-30" -> "06/30/2018" — the sample's zero-padded style (the cert's `paddedDate`).
 *  Pure string work; parsing to a Date would drag a timezone into a date-only value. */
function paddedDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

/** A bold label with a regular value — the sample's "Effective: 06/30/2018" line shape. */
const labelled = (label: string, value: string, fontSize = 9.5): Content =>
  ({ text: [{ text: label, bold: true }, value], fontSize, margin: [0, 1, 0, 0] });

// The line grid and price rows share the invoice's column widths so every number lands under the
// header strip's "Each weight" / "Total Lbs / Price" columns.
const QTY_W = 52;
const EACH_W = 66;
const AMT_W = 84;

const head = (text: string, alignment: "left" | "right" = "left"): TableCell =>
  ({ text, bold: true, fontSize: 9, alignment });

// ---------------------------------------------------------------------------------------------
// Blocks, top to bottom in sample order.
// ---------------------------------------------------------------------------------------------

/** The centered "Quotation" title over the company block (settings), with "Quotation Number: N"
 *  to its right — the sample's header. The 170pt spacer on the left balances the number column so
 *  the title truly centers (the cert headerBlock's own trick). */
function headerBlock(d: QuotePdfData): Content {
  return {
    columns: [
      { width: 170, text: "" },
      {
        width: "*",
        stack: [
          { text: "Quotation", bold: true, fontSize: 20, alignment: "center" },
          { text: d.company.name, bold: true, fontSize: 13, alignment: "center", margin: [0, 2, 0, 0] },
          ...d.company.address.split("\n").filter((l) => l.trim() !== "")
            .map((line): Content => ({ text: line.trim(), fontSize: 10, alignment: "center" })),
        ],
      },
      {
        width: 170,
        text: [{ text: "Quotation Number: ", bold: true }, String(d.quoteNumber)],
        fontSize: 11,
      },
    ],
    columnGap: 8,
    margin: [0, 0, 0, 10],
  };
}

/** The Attn block left (contact name when picked, then customer name + bill-to address — the
 *  invoice's address resolution), the info block right (company phone, Effective / Expires On /
 *  Terms, "Your R.F.Q. Number", the contact's phone where the model has one — no fax lines: no
 *  fax field exists, see the file comment). */
function partiesBlock(d: QuotePdfData): Content {
  const attnLines: Content[] = [
    ...(d.attn === "" ? [] : [{ text: [{ text: "Attn: ", bold: true }, d.attn], fontSize: 10 } satisfies Content]),
    ...d.billTo.map((line): Content => ({ text: line, fontSize: 10 })),
  ];
  const infoLines: Content[] = [
    ...(d.company.phone === "" ? [] : [labelled("Phone: ", d.company.phone)]),
    labelled("Effective: ", paddedDate(d.effectiveDate)),
    labelled("Expires On: ", paddedDate(d.expiryDate)),
    labelled("Terms: ", d.termsName),
    { ...labelled("Your R.F.Q. Number: ", d.rfqNumber), margin: [0, 8, 0, 0] },
    ...(d.customerPhone === ""
      ? []
      : [{ ...labelled("Your Phone No.: ", d.customerPhone), margin: [0, 8, 0, 0] } satisfies Content]),
  ];
  return {
    columns: [
      { width: "*", stack: attnLines, margin: [16, 10, 0, 0] },
      { width: 220, stack: infoLines },
    ],
    columnGap: 12,
    margin: [0, 0, 0, 8],
  };
}

/** The one boxed strip naming the four data columns — the sample's header row over the lines. */
function columnHeaderStrip(): Content {
  return {
    table: {
      widths: [QTY_W, "*", EACH_W, AMT_W],
      body: [[
        head("Quantity"),
        head("Part No. / Description / Pricing Information"),
        head("Each weight", "right"),
        head("Total Lbs / Price", "right"),
      ]],
    },
    layout: LAYOUT.boxed,
    margin: [0, 0, 0, 4],
  };
}

/** The quantity cell: the quoted qty, "Unlimited", or blank (ruling 9 — informational). */
function qtyCell(line: QuotePdfLine): string {
  if (line.quotedUnlimited) return "Unlimited";
  return line.quotedQty === null ? "" : qty(line.quotedQty);
}

/** One line's grid row (qty | stacked identity | each weight | total lbs) and its Material line. */
function lineRow(line: QuotePdfLine): Content[] {
  return [
    {
      columns: [
        { width: QTY_W, text: qtyCell(line), fontSize: 9, alignment: "right" },
        {
          width: "*",
          stack: [line.partNumber, line.partName, line.partDescription]
            .filter((t) => t !== "").map((text): Content => ({ text, fontSize: 9 })),
          margin: [6, 0, 0, 0],
        },
        { width: EACH_W, text: line.eachWeight === null ? "" : weight(line.eachWeight), fontSize: 9, alignment: "right" },
        { width: AMT_W, text: line.totalLbs === null ? "" : weight(line.totalLbs), fontSize: 9, alignment: "right" },
      ],
      columnGap: 6,
      margin: [0, 2, 0, 0],
    },
    // "Material: X" beneath the identity, indented under the sample's own placement. The label
    // stays when the value is blank (the cert's keep-the-label rule).
    {
      text: [{ text: "Material: ", bold: true }, line.material],
      fontSize: 9, margin: [QTY_W + 6, 6, 0, 0],
    },
  ];
}

/** The centered "Setup charge:  $2.00   Plus" detail lines beneath a price row — the sample's
 *  arrangement in 5A vocabulary (spec §6). "Plus" trails the setup only when a price or minimum
 *  follows it; "Or" trails the per-unit price only when a minimum follows (the invoice's showOr
 *  shape, re-ordered to the sample's setup-first stack). */
function priceDetailLine(label: string, value: string, trailer: "" | "Plus" | "Or"): Content {
  return {
    text: `${label}  ${value}${trailer === "" ? "" : `   ${trailer}`}`,
    fontSize: 9, alignment: "center", margin: [0, 1, 0, 0],
  };
}

/** One price row: step name (+ its notes) left, the engine's indicative amount right, the price
 *  details and any break rows centered beneath. */
function priceRow(row: QuotePdfPriceRow): Content[] {
  const out: Content[] = [{
    columns: [
      { width: QTY_W, text: "" },
      {
        width: "*",
        stack: [
          { text: row.stepName, bold: true, fontSize: 9 },
          ...(row.notes === "" ? [] : [{ text: row.notes, fontSize: 8.5, margin: [0, 1, 0, 0] } satisfies Content]),
        ],
        margin: [6, 0, 0, 0],
      },
      { width: EACH_W, text: "" },
      { width: AMT_W, text: row.amount === null ? "" : money(row.amount), fontSize: 9, alignment: "right" },
    ],
    columnGap: 6,
    margin: [0, 4, 0, 0],
  }];
  const hasPrice = row.unitPrice !== null;
  const hasMin = row.minimumCharge !== null;
  if (row.setupCharge !== null) {
    out.push(priceDetailLine("Setup charge:", money(row.setupCharge), hasPrice || hasMin ? "Plus" : ""));
  }
  if (row.unitPrice !== null) {
    out.push(priceDetailLine(`Price per ${row.pricePerLabel}:`, money4(row.unitPrice), hasMin ? "Or" : ""));
  }
  if (row.minimumCharge !== null) {
    out.push(priceDetailLine("Minimum charge:", money(row.minimumCharge), ""));
  }
  // Break rows, when present (ruling 2): threshold in the row's own basis unit (pieces, or
  // pounds on an LB row — the engine's breakBasis rule), price at its stored precision.
  for (const brk of row.breaks) {
    out.push(priceDetailLine(`${num(brk.threshold)} or more:`, money4(brk.price), ""));
  }
  return out;
}

/** One quote line's whole body: the grid row, Material, then its underlined PRICE section. */
function lineBlock(line: QuotePdfLine): Content[] {
  const out: Content[] = lineRow(line);
  if (line.prices.length > 0) {
    out.push({ text: "PRICE", bold: true, decoration: "underline", fontSize: 9, margin: [QTY_W + 6, 8, 0, 2] });
    for (const row of line.prices) out.push(...priceRow(row));
  }
  return out;
}

/** The footer content: ending statement + quote notes left, the signature block right (rule,
 *  quotedBy's name, title — blank title prints nothing, ruling 14), then the liability fine
 *  print full-width beneath (the sample's own bottom strip). */
function footerContent(d: QuotePdfData): Content[] {
  const leftLines: Content[] = [
    ...(d.endingStatementText === "" ? [] : [{ text: d.endingStatementText, fontSize: 9.5 } satisfies Content]),
    ...(d.notes === "" ? [] : [{ text: d.notes, fontSize: 9.5, margin: [0, 6, 0, 0] } satisfies Content]),
  ];
  const signature: Content = {
    stack: [
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: 230, y2: 0, lineWidth: 1 }] },
      { text: d.signer.name, fontSize: 10, margin: [4, 3, 0, 0] },
      ...(d.signer.title === "" ? [] : [{ text: d.signer.title, fontSize: 10, margin: [4, 1, 0, 0] } satisfies Content]),
    ],
    margin: [0, 10, 0, 0],
  };
  return [
    {
      columns: [
        { width: "*", stack: leftLines },
        { width: 230, stack: [signature] },
      ],
      columnGap: 12,
      margin: [0, 18, 0, 0],
    },
    ...(d.liabilityText === ""
      ? []
      : [{ text: d.liabilityText, fontSize: 6.5, margin: [0, 10, 0, 0] } satisfies Content]),
  ];
}

// ---------------------------------------------------------------------------------------------
// The quote document (spec §6). Pure — data in, definition out; the footer page CALLBACK is the
// one non-JSON member, sanctioned for this document alone (see the file comment).
// ---------------------------------------------------------------------------------------------

export function buildQuoteDefinition(input: QuotePdfData): TDocumentDefinitions {
  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, 44],
    defaultStyle: { font: "Roboto", fontSize: 9 },
    // No `info.creationDate`, no clock anywhere — every date on the paper is data (the traveler's
    // purity rule). The callback itself is pure: page numbers in, one text line out.
    footer: (currentPage: number, totalPages: number): Content => ({
      text: `Page: ${currentPage} of ${totalPages}`,
      bold: true, fontSize: 8.5, alignment: "right", margin: [24, 8, 24, 0],
    }),
    content: [
      headerBlock(input),
      partiesBlock(input),
      { text: input.introText, fontSize: 9.5, margin: [0, 2, 0, 4] },
      columnHeaderStrip(),
      ...input.lines.flatMap((line) => lineBlock(line)),
      ...footerContent(input),
    ],
  };
}
