/**
 * The invoice / credit (P5A design spec §10). PURE by construction, the traveler.ts contract:
 * `InvoicePdfData` in, a plain-JSON pdfmake definition out — no I/O, no clock, nothing that would
 * not survive `JSON.parse(JSON.stringify())` (asserted in tests/invoice-pdf.test.ts). The reads
 * live in invoices.ts (`readInvoicePdfData`), the bytes in render.ts. This definition is the
 * built-in default template Phase 7's designer will edit and version.
 *
 * Layout mirrors the owner's `docs/samples/Invoice Sample.pdf`, which IS the contract (spec §3.1).
 * Deviations are individually commented; there are no silent ones:
 *  - **no "Page N of M"** — a page count is not knowable to a pure-JSON definition (pdfmake exposes
 *    it only to header/footer CALLBACKS, which a template-as-data definition cannot carry, and a
 *    hard-coded "1 of 1" would lie the moment a long invoice wraps). The identity column therefore
 *    prints Invoice No. / Invoice Date / Terms and omits the sample's "Page No." line — the
 *    shipping ticket's and the cert's identical deviation (spec §10, owner ping #1).
 *  - **`Process:` prints the lead part's priced operation names comma-joined** (`processNames`,
 *    snapshotted at create) — byte-identical to the sample whenever a part has one priced operation
 *    (spec §10, deviation 2). This is `readInvoicePdfData`'s doing; the builder just prints the
 *    string it is handed.
 *  - the footer's "Contact: Accounts Receivable" is the sample's own static strip; the trailing
 *    empty "Fax:" label has no field behind it in this model (there is no fax setting) — not
 *    printed (do not invent fields, the cert's "Fax" precedent).
 *  - the sample's stray "1" beside "Remit To" and "2827" beside "Shipto" are Visual Shop's internal
 *    row ids (the ticket's own ruling on the same class of artifact) — not printed.
 *  - a CREDIT titles itself "Credit" and carries negative amounts (spec §10: "Credits print the
 *    same layout with the credit number and negative amounts"). The title text is DATA (`title`),
 *    set by `readInvoicePdfData` off the invoice's own kind, so the builder stays kind-agnostic. A
 *    credit is a distinct financial document and must not read as an invoice; this is the one place
 *    the credit's content differs from the sample's beyond its number and signs.
 */
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { PRICE_SOURCE_LABELS } from "../../lib/invoice-constants";
import { LAYOUT } from "./render";

// ---------------------------------------------------------------------------------------------
// InvoicePdfData — the builder's whole input. Plain data: no Decimals, no Dates, no Prisma rows.
// `billTo`/`shipTo` are the FROZEN snapshot lines (Invoice.billTo/shipTo, split on newline): an
// invoice is frozen paper (invoices.ts's `toLineDetail` rule), so these are what was billed, never
// a live re-read of the customer's current address. `remitTo` is the plant's own remit address,
// read live from company settings (it is not frozen per-invoice) — see `invoicePrintSettings`.
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
// Formatting. Pure, locale pinned (the traveler's own rule) so output never tracks the server's.
// ---------------------------------------------------------------------------------------------

/** Money with a leading "$" and exactly two decimals — "$937.44", "$6.51". A negative (a credit
 *  line) renders "$-937.44": the sign sits between the "$" and the digits so the magnitude and the
 *  sign both read at a glance, and the sample's positive form is unchanged. */
function money(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A weight, always two decimals, no "$" — the sample's "3,024.00" / "21.00" style. */
function weight(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A quantity, integer, thousands-separated — "144", "1,440". */
function qty(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-07-29" -> "July 29, 2026" — the sample's Invoice Date style. Pure string work; parsing to
 *  a Date would drag a timezone into a date-only value (src/lib/business-days.ts's whole point). */
function longDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
}

// The parts / price / totals rows share these column widths so every number lands under the header
// strip's "Each weight" and "Total Wt / Price" columns.
const QTY_W = 52;
const EACH_W = 66;
const AMT_W = 84;

// ---------------------------------------------------------------------------------------------
// Blocks, top to bottom in sample order.
// ---------------------------------------------------------------------------------------------

/** The big title over the company name, both centered — the sample's header. */
function headerBlock(d: InvoicePdfData): Content {
  return {
    stack: [
      { text: d.title, bold: true, fontSize: 20, alignment: "center" },
      { text: d.company.name, bold: true, fontSize: 15, alignment: "center", margin: [0, 2, 0, 6] },
    ],
  };
}

/** The identity column (Invoice No. / Invoice Date / Terms — NO Page No., see the file comment)
 *  left; the boxed Remit To block right. */
function identityBlock(d: InvoicePdfData): Content {
  return {
    columns: [
      {
        width: "*",
        stack: [
          { text: [{ text: "Invoice No.:  ", bold: true }, d.documentNumber], fontSize: 10 },
          { text: [{ text: "Invoice Date: ", bold: true }, longDate(d.invoiceDate)], fontSize: 10, margin: [0, 2, 0, 0] },
          { text: [{ text: "Terms: ", bold: true }, d.termsName], fontSize: 10, margin: [0, 2, 0, 0] },
        ],
        margin: [40, 0, 0, 0],
      },
      {
        width: 250,
        table: {
          widths: ["*"],
          body: [[{
            stack: [
              { text: "Remit To", bold: true, fontSize: 13 },
              { text: d.remitTo.name, bold: true, fontSize: 10, margin: [0, 2, 0, 0] },
              ...d.remitTo.lines.map((line): Content => ({ text: line, fontSize: 10 })),
            ],
            margin: [4, 2, 4, 4],
          }]],
        },
        layout: LAYOUT.boxed,
      },
    ],
    columnGap: 12,
    margin: [0, 0, 0, 8],
  };
}

/** A labelled multi-line address block ("Billto:" / "Shipto:") — the label over each line straight
 *  off the frozen snapshot. Returns the stack rows; `partiesBlock` wraps them in a column. */
function addressLines(label: string, lines: string[]): Content[] {
  return [
    { text: label, fontSize: 9, decoration: "underline" },
    ...lines.map((line, i): Content => ({ text: line, fontSize: 10, ...(i === 0 ? { margin: [0, 2, 0, 0] } : {}) })),
  ];
}

function partiesBlock(d: InvoicePdfData): Content {
  return {
    columns: [
      { width: "*", stack: addressLines("Billto:", d.billTo), margin: [40, 0, 0, 0] },
      { width: "*", stack: addressLines("Shipto:", d.shipTo) },
    ],
    columnGap: 12,
    margin: [0, 4, 0, 6],
  };
}

const head = (text: string, alignment: "left" | "right" = "left"): TableCell =>
  ({ text, bold: true, fontSize: 9, alignment });

/** The one boxed strip naming the four data columns (spec §10's header row). Everything below it is
 *  free-flow text aligned to the same widths — the sample rules only this strip, not the body. */
function columnHeaderStrip(): Content {
  return {
    table: {
      widths: [QTY_W, "*", EACH_W, AMT_W],
      body: [[
        head("Quantity"),
        head("Order Information / Part No. / Description / Pricing Information"),
        head("Each weight", "right"),
        head("Total Wt / Price", "right"),
      ]],
    },
    layout: LAYOUT.boxed,
    margin: [0, 0, 0, 4],
  };
}

/** Our Order # / Your PO #, Material / Process, then the underlined "PARTS" heading — the strip
 *  above the parts rows. Indented past the Quantity column to sit under "Order Information". */
function orderStrip(d: InvoicePdfData): Content {
  return {
    stack: [
      { text: [{ text: "Our Order #: ", bold: true }, `${d.orderNumber}    `, { text: "Your PO #: ", bold: true }, d.poNumber], fontSize: 9 },
      { text: [{ text: "Material: ", bold: true }, `${d.materialName}  `, { text: "Process: ", bold: true }, d.processNames], fontSize: 9, margin: [0, 1, 0, 0] },
      { text: "PARTS", bold: true, decoration: "underline", fontSize: 9, margin: [0, 4, 0, 2] },
    ],
    margin: [QTY_W + 6, 0, 0, 0],
  };
}

/** One row per part: Quantity, the stacked Part No. / Name / Description, Each weight, Total Wt. */
function partsRows(d: InvoicePdfData): Content[] {
  return d.parts.map((p): Content => ({
    columns: [
      { width: QTY_W, text: p.qty === null ? "" : qty(p.qty), fontSize: 9, alignment: "right" },
      {
        width: "*",
        stack: [p.partNumber, p.partName, p.partDescription]
          .filter((t) => t !== "").map((text): Content => ({ text, fontSize: 9 })),
        margin: [6, 0, 0, 0],
      },
      { width: EACH_W, text: p.eachWeight === null ? "" : weight(p.eachWeight), fontSize: 9, alignment: "right" },
      { width: AMT_W, text: p.totalWeight === null ? "" : weight(p.totalWeight), fontSize: 9, alignment: "right" },
    ],
    columnGap: 6,
    margin: [0, 2, 0, 0],
  }));
}

/** The centered "Price per Each:  $6.51   Or" / "Minimum Charge:  $600.00" detail lines beneath an
 *  operation. "Or" trails the per-unit price only when a minimum follows it (the sample's shape). */
function priceDetailLine(label: string, value: string, showOr: boolean): Content {
  return { text: `${label}  ${value}${showOr ? "   Or" : ""}`, fontSize: 9, alignment: "center", margin: [0, 1, 0, 0] };
}

/** The PRICE block: the underlined heading, then per operation its name + billed amount, with the
 *  per-unit price, minimum and setup beneath. */
function priceBlock(d: InvoicePdfData): Content[] {
  const out: Content[] = [{ text: "PRICE", bold: true, decoration: "underline", fontSize: 9, margin: [QTY_W + 6, 8, 0, 2] }];
  for (const pr of d.priceRows) {
    out.push({
      columns: [
        { width: QTY_W, text: "" },
        { width: "*", text: pr.description, fontSize: 9, margin: [6, 0, 0, 0] },
        { width: EACH_W, text: "" },
        { width: AMT_W, text: money(pr.amount), fontSize: 9, alignment: "right" },
      ],
      columnGap: 6,
      margin: [0, 3, 0, 0],
    });
    // The tier-1 source line (quoting spec §5.3): a quote-priced operation names its agreement
    // first — "Quote #1006", the frozen number the data carries — then the price details. The
    // label root is PRICE_SOURCE_LABELS.QUOTE with the number appended (the invoice-constants
    // mechanism); rows without a quote number print no source line at all (sample fidelity).
    if (pr.sourceQuoteNumber !== null && pr.sourceQuoteNumber !== undefined) {
      out.push({
        text: `${PRICE_SOURCE_LABELS.QUOTE} #${pr.sourceQuoteNumber}`,
        fontSize: 9, alignment: "center", margin: [0, 1, 0, 0],
      });
    }
    if (pr.unitPrice !== null) out.push(priceDetailLine(`Price per ${pr.pricePerLabel}:`, money(pr.unitPrice), pr.minimumCharge !== null));
    if (pr.minimumCharge !== null) out.push(priceDetailLine("Minimum Charge:", money(pr.minimumCharge), false));
    if (pr.setupCharge !== null) out.push(priceDetailLine("Setup Charge:", money(pr.setupCharge), false));
  }
  return out;
}

/** A right-aligned "label  amount" totals line. */
function totalLine(label: string, value: string, opts: { bold?: boolean; big?: boolean } = {}): Content {
  const fontSize = opts.big ? 13 : 10;
  return {
    columns: [
      { width: "*", text: "" },
      { width: 200, text: label, bold: opts.bold ?? false, fontSize, alignment: "right" },
      { width: AMT_W, text: value, bold: opts.bold ?? false, fontSize, alignment: "right" },
    ],
    columnGap: 6,
    margin: [0, opts.big ? 6 : 2, 0, 0],
  };
}

/** Sub Total, one named line per surcharge/charge/cert/freight/tax, then the bold Total Amount Due. */
function totalsBlock(d: InvoicePdfData): Content[] {
  const out: Content[] = [totalLine("Sub Total Amount:", money(d.subtotal), { bold: true })];
  for (const s of d.surchargeRows) out.push(totalLine(s.description, money(s.amount)));
  for (const c of d.chargeRows) out.push(totalLine(c.description, money(c.amount)));
  if (d.certRow) out.push(totalLine(d.certRow.description, money(d.certRow.amount)));
  if (d.freightRow) out.push(totalLine(d.freightRow.description, money(d.freightRow.amount)));
  if (d.taxRow) out.push(totalLine(d.taxRow.description, money(d.taxRow.amount)));
  out.push(totalLine("Total Amount Due:", money(d.total), { bold: true, big: true }));
  return out;
}

/** The footer strip: company address left, the sample's static "Contact: Accounts Receivable"
 *  center, phone right (no Fax; see the file comment). A static pdfmake footer — plain JSON, no
 *  callback — so it lands on every page of a wrapped invoice. */
function footerBlock(d: InvoicePdfData): Content {
  return {
    columns: [
      { width: "*", text: d.company.address, fontSize: 7.5 },
      { width: 180, text: "Contact: Accounts Receivable", fontSize: 7.5, alignment: "center" },
      { width: 140, text: `Phone: ${d.company.phone}`, fontSize: 7.5, alignment: "right" },
    ],
    margin: [24, 6, 24, 0],
  };
}

// ---------------------------------------------------------------------------------------------
// The built-in default invoice/credit template (spec §10). PURE — data in, JSON out.
// ---------------------------------------------------------------------------------------------

export function buildInvoiceDefinition(input: InvoicePdfData): TDocumentDefinitions {
  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, 44],
    defaultStyle: { font: "Roboto", fontSize: 9 },
    // No `info.creationDate`, no clock anywhere — the print DATE is not even printed; the invoice
    // date is data (`invoiceDate`), so the builder itself stays deterministic (the traveler's
    // purity rule).
    footer: footerBlock(input),
    content: [
      headerBlock(input),
      identityBlock(input),
      partiesBlock(input),
      columnHeaderStrip(),
      orderStrip(input),
      ...partsRows(input),
      ...priceBlock(input),
      ...totalsBlock(input),
    ],
  };
}
