/**
 * The GL posting-register PDF (P5C §4.3/§4.4 — Task 7). PURE by construction, the
 * invoice/cert/statement contract: `PostingRegisterData` in, a plain-JSON pdfmake definition out —
 * no I/O, no clock, nothing that would not survive `JSON.parse(JSON.stringify())`. The reads and
 * the emitted `JournalLine[]` -> `PostingRegisterData` mapping live in `gl-export.ts`
 * (`buildPostingRegister`'s caller); the bytes in `render.ts`.
 *
 * `PostingRegisterData` is owned HERE (the `StatementData`/`InvoicePdfData` pdf-module-owns-its-
 * input-type precedent), so this file imports nothing from the service layer and the dependency
 * stays one-directional (`gl-export.ts` imports `buildPostingRegister` and re-exports this type —
 * never the reverse).
 *
 * There is no owner-supplied sample to mirror (a posting register is this phase's own document,
 * not a port of a Visual Shop report — the `pdf/statement.ts` precedent), so the layout below is
 * this project's own built-in default: a header naming the period and export number, then the two
 * sub-registers side has printed in the source order the export always emits them, SALES then
 * CASH (§4.3) — each a table of the lines with a totals row proving Σdebit = Σcredit for THAT side.
 * A side with no lines still prints its (empty) table with a $0/$0 totals row, so the register
 * always shows both sides of a batch, never silently omits one.
 */
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { LAYOUT } from "./render";

// ---------------------------------------------------------------------------------------------
// PostingRegisterData — the builder's whole input. Plain data: no Decimals, no Dates, no Prisma
// rows. `periodEnd` arrives pre-formatted (the same `formatDateOnly` string `gl-export.ts` already
// computes for the CSV and the returned `ExportedBatch`) — this module owns no date formatter of
// its own because it never needs to format one; it only prints the string it is handed.
// ---------------------------------------------------------------------------------------------

export type PostingRegisterLine = {
  side: "SALES" | "CASH";
  glAccountName: string;
  debit: number;
  credit: number;
  memo: string;
};

export type PostingRegisterData = {
  periodLabel: string;
  periodEnd: string;
  exportNumber: number;
  lines: PostingRegisterLine[];
};

// ---------------------------------------------------------------------------------------------
// Formatting — a LOCAL, pure helper. Not `pdf/invoice.ts`'s or `pdf/statement.ts`'s `money`:
// every pdf/ template duplicates its own (that module's own precedent) rather than share one, so
// no template's layout is at the mercy of another's edits.
// ---------------------------------------------------------------------------------------------

const money = (n: number): string =>
  n === 0 ? "" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------------------------
// Blocks, top to bottom.
// ---------------------------------------------------------------------------------------------

const head = (text: string): TableCell => ({ text, bold: true });

/** One sub-register: Account / Debit / Credit / Memo, one row per line, then a bold totals row
 *  proving Σdebit = Σcredit for this side (§4.3 — every event's line set is self-balancing, so
 *  every side of the batch is too). */
function sideTable(title: string, lines: PostingRegisterLine[]): Content {
  const body: TableCell[][] = [[head("Account"), head("Debit"), head("Credit"), head("Memo")]];
  let debitTotal = 0;
  let creditTotal = 0;
  for (const l of lines) {
    body.push([
      l.glAccountName,
      { text: money(l.debit), alignment: "right" },
      { text: money(l.credit), alignment: "right" },
      l.memo,
    ]);
    debitTotal += l.debit;
    creditTotal += l.credit;
  }
  body.push([
    { text: "Total", bold: true },
    { text: money(debitTotal), alignment: "right", bold: true },
    { text: money(creditTotal), alignment: "right", bold: true },
    "",
  ]);
  return {
    margin: [0, 6, 0, 10],
    stack: [
      { text: title, bold: true, margin: [0, 0, 0, 3] },
      { table: { headerRows: 1, widths: ["*", "auto", "auto", "*"], body }, layout: LAYOUT.boxed },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// The built-in default posting-register template. PURE — data in, JSON out.
// ---------------------------------------------------------------------------------------------

export function buildPostingRegister(d: PostingRegisterData): TDocumentDefinitions {
  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, 40],
    defaultStyle: { font: "Roboto", fontSize: 9 },
    content: [
      { text: `GL Posting Register — ${d.periodLabel}`, bold: true, fontSize: 13 },
      { text: `Export #${d.exportNumber} · JE date ${d.periodEnd}`, margin: [0, 2, 0, 10] },
      sideTable("SALES", d.lines.filter((l) => l.side === "SALES")),
      sideTable("CASH", d.lines.filter((l) => l.side === "CASH")),
    ],
  };
}
