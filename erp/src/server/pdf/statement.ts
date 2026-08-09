/**
 * The open-item customer statement (P5B design spec §8). PURE by construction, the invoice/cert
 * contract: `StatementData` in, a plain-JSON pdfmake definition out — no I/O, no clock, nothing
 * that would not survive `JSON.parse(JSON.stringify())`. The reads live in `statements.ts`
 * (`buildStatement`), the bytes in `render.ts`.
 *
 * Unlike the invoice/cert/traveler templates, there is no owner-supplied sample to mirror here —
 * a statement is a document type this phase INTRODUCES (spec §8), not a port of an existing
 * Visual Shop report. The layout below is this project's own built-in default (Phase 7's designer
 * precedent — the invoice/cert templates are equally editable, this one starts from scratch
 * instead of a sample): a customer + remit-to header, the open-item table, the five-bucket aging
 * strip with its own Unapplied column (owner ruling 8 — never folded into a bucket), an optional
 * finance-charge line, and the total due.
 *
 * `StatementData` is owned HERE (the `InvoicePdfData`/pdf-module-owns-its-input-type precedent in
 * `pdf/invoice.ts`) rather than in `statements.ts`, so this file imports nothing from the service
 * layer and the dependency stays one-directional (`statements.ts` imports `buildStatementDefinition`
 * and re-exports this type — never the reverse).
 */
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { LAYOUT } from "./render";
import { AGING_BUCKET_LABELS } from "../../lib/ar-constants";
import type { AgingRow } from "../aging";
import type { InvoiceCompany, InvoiceRemitTo } from "./invoice";

// ---------------------------------------------------------------------------------------------
// StatementData — the builder's whole input. Plain data: no Decimals, no Dates, no Prisma rows.
// `customer.billTo` is read LIVE off the customer's current default BILL_TO address — unlike an
// invoice's frozen snapshot, a statement is not paper that was raised once and must never drift;
// it is rebuilt fresh (and reprintable identically only because printing archives its OUTPUT, not
// because the input is frozen) every time it is built (CLAUDE.md's snapshot-vs-live distinction,
// on the live side of it).
// ---------------------------------------------------------------------------------------------

export type StatementOpenItem = {
  documentNumber: string; date: string; dueDate: string | null; kind: "INVOICE" | "CREDIT";
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
// Formatting — copied from `pdf/invoice.ts` (locale-pinned, pure; duplicated per file rather than
// shared, that module's own precedent).
// ---------------------------------------------------------------------------------------------

function money(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-07-29" -> "July 29, 2026". */
function longDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
}

// ---------------------------------------------------------------------------------------------
// Blocks, top to bottom.
// ---------------------------------------------------------------------------------------------

function headerBlock(d: StatementData): Content {
  return {
    stack: [
      { text: "Statement", bold: true, fontSize: 20, alignment: "center" },
      { text: d.company.name, bold: true, fontSize: 15, alignment: "center", margin: [0, 2, 0, 6] },
    ],
  };
}

/** The customer/bill-to column left; the boxed Remit To block right — the invoice identity
 *  block's shape, with "Customer" + "Statement Date" in place of "Invoice No." + "Invoice Date". */
function identityBlock(d: StatementData): Content {
  return {
    columns: [
      {
        width: "*",
        stack: [
          { text: [{ text: "Customer: ", bold: true }, `${d.customer.code} — ${d.customer.name}`], fontSize: 10 },
          { text: [{ text: "Statement Date: ", bold: true }, longDate(d.asOf)], fontSize: 10, margin: [0, 2, 0, 0] },
          { text: "Bill To", fontSize: 9, decoration: "underline", margin: [0, 6, 0, 0] },
          ...d.customer.billTo.map((line): Content => ({ text: line, fontSize: 10 })),
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
    margin: [0, 0, 0, 10],
  };
}

const head = (text: string, alignment: "left" | "right" = "left"): TableCell =>
  ({ text, bold: true, fontSize: 9, alignment });

/** Document #/Date/Due Date/Original/Open — one row per open item (spec §8). A CREDIT's "Due
 *  Date" cell prints blank (it carries none — `dueDate: null`), never a fabricated date. */
function openItemsTable(d: StatementData): Content {
  const body: TableCell[][] = [[
    head("Document #"), head("Date"), head("Due Date"), head("Original", "right"), head("Open", "right"),
  ]];
  for (const item of d.openItems) {
    body.push([
      { text: item.documentNumber, fontSize: 9 },
      { text: longDate(item.date), fontSize: 9 },
      { text: item.dueDate ? longDate(item.dueDate) : "", fontSize: 9 },
      { text: money(item.original), fontSize: 9, alignment: "right" },
      { text: money(item.open), fontSize: 9, alignment: "right" },
    ]);
  }
  return {
    table: { headerRows: 1, widths: ["auto", "auto", "auto", "*", "*"], body },
    layout: LAYOUT.boxed,
    margin: [0, 0, 0, 10],
  };
}

const AGING_KEYS = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
const AGING_STRIP_LABEL: Record<(typeof AGING_KEYS)[number], string> = {
  current: AGING_BUCKET_LABELS.CURRENT, d1_30: AGING_BUCKET_LABELS.D1_30, d31_60: AGING_BUCKET_LABELS.D31_60,
  d61_90: AGING_BUCKET_LABELS.D61_90, d90_plus: AGING_BUCKET_LABELS.D90_PLUS,
};

/** The five aging buckets plus the separate Unapplied column and Net (owner ruling 8: unapplied
 *  credit/on-account is never folded into a bucket) — one shared strip, off the SAME `AgingRow`
 *  `aging.ts` computes for the report (spec §6: "one pure aging function serves both"). */
function agingStrip(d: StatementData): Content {
  const headRow: TableCell[] = [
    ...AGING_KEYS.map((k) => head(AGING_STRIP_LABEL[k], "right")), head("Unapplied", "right"), head("Net", "right"),
  ];
  const valueRow: TableCell[] = [
    ...AGING_KEYS.map((k): TableCell => ({ text: money(d.aging[k]), fontSize: 9, alignment: "right" })),
    { text: money(d.aging.unapplied), fontSize: 9, alignment: "right" },
    { text: money(d.aging.net), bold: true, fontSize: 9, alignment: "right" },
  ];
  return {
    table: { headerRows: 1, widths: Array(7).fill("*") as string[], body: [headRow, valueRow] },
    layout: LAYOUT.boxed,
    margin: [0, 0, 0, 10],
  };
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

// ---------------------------------------------------------------------------------------------
// The built-in default statement template (spec §8). PURE — data in, JSON out.
// ---------------------------------------------------------------------------------------------

export function buildStatementDefinition(input: StatementData): TDocumentDefinitions {
  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, 40],
    defaultStyle: { font: "Roboto", fontSize: 9 },
    content: [
      headerBlock(input),
      identityBlock(input),
      openItemsTable(input),
      agingStrip(input),
      // The finance-charge line prints ONLY when the run assessed one (spec §8) — `null` means
      // either the run didn't opt in, or nothing non-exempt was past due; either way, no line.
      ...(input.financeCharge !== null ? [totalLine("Finance Charge:", money(input.financeCharge))] : []),
      totalLine("Total Due:", money(input.totalDue), { bold: true, big: true }),
    ],
  };
}
