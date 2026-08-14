import type { Prisma } from "../../../prisma/generated/prisma/client";
import { prisma } from "../db";
import { HttpError } from "../errors";
import { parseDateOnly } from "../../lib/business-days";
import type { InvoiceKindValue } from "../../lib/invoice-constants";
import { reportShipped, type ShippedResult } from "./shipped";

// -------------------------------------------------------------------------------------------
// Phase 8A Task 7 (spec §4.3): the Comparison scoreboard — the weekly parallel-run eyeball page.
// THREE HeatSynQ figures for ONE {from,to} window, to eyeball against Visual Shop's own reports.
// This is a VS eyeball, NOT a books tie-out — hence the deliberate basis choices below. A report is
// a pure READ: no row claim, no audit, no Serializable (spec §11, reports/README.md).
//
// The three figures, each pinned:
//   • Orders entered — COUNT of orders by `Order.receivedDate` in the window, voided excluded
//     (`deletedAt: null`). receivedDate (not createdAt) matches how VS dates an order.
//   • Shipped — pounds & pieces, by REUSING `reportShipped` for the SAME window and summing its rows.
//     Not re-derived: the scoreboard's shipped number is, by construction, exactly what the Shipped
//     report shows for that window (voids excluded, reversals netted, released rows counted — all
//     inherited from `reportShipped`).
//   • Invoiced $ — Σ `Invoice.total` for FINALIZED docs by **`invoiceDate`** (owner ruling — the
//     VS-eyeball basis), `deletedAt: null`, credits netted. This is DELIBERATELY `invoiceDate`, NOT
//     `finalizedAt` the way the Sales report recognizes revenue (§4.2): the scoreboard eyeballs the
//     date printed on the paper, and `invoiceDate` is a `@db.Date` (no time-of-day) so the window is
//     an inclusive `lte` — NOT the Sales report's half-open `finalizedAt` window. The figure is the
//     GROSS tax-inclusive `Invoice.total` (not an ex-tax line sum). A CREDIT's `total` is stored
//     NEGATIVE (the `negateMoney` convention), so summing by kind gives invoices and credits on their
//     own lines and a net that already accounts for the credits.
// -------------------------------------------------------------------------------------------

/** Money is Decimal(12,2); sum it in integer cents so credits and fractional dollars don't drift
 *  (the `buildSales` integer-cent rule). */
const cents = (n: number): number => Math.round(n * 100);

/** Weight is Decimal(12,2) pounds; sum in integer hundredths so fractional/negative weights don't
 *  drift (the `buildShipped` integer-hundredths rule). */
const hundredths = (n: number): number => Math.round(n * 100);

export type ScoreboardFigures = {
  /** The window echoed back (yyyy-mm-dd, or null for an open bound) — the same strings that drove it. */
  window: { from: string | null; to: string | null };
  /** Count of live orders whose receivedDate falls in the window. */
  ordersEntered: number;
  /** Shipped pieces (qty) and pounds (weight), summed from the Shipped report for the same window. */
  shipped: { qty: number; weight: number };
  /** Gross tax-inclusive invoiced dollars by invoiceDate: invoices, credits (negative), and the net. */
  invoiced: { invoices: number; credits: number; net: number };
};

/**
 * PURE. Combines the three already-read inputs into the scoreboard figures.
 *   • shipped — Σ qty (integers, exact) and Σ weight (integer hundredths) across the Shipped rows.
 *   • invoiced — split the FINALIZED docs by kind: Σ INVOICE totals, Σ CREDIT totals (already
 *     negative), and their net (all in integer cents so credits/fractions don't drift).
 * `ordersEntered` and `window` pass straight through — they carry no aggregation of their own.
 */
export function buildScoreboard(input: {
  window: { from: string | null; to: string | null };
  ordersEntered: number;
  shipped: ShippedResult;
  invoices: { kind: InvoiceKindValue; total: number }[];
}): ScoreboardFigures {
  const qty = input.shipped.rows.reduce((s, r) => s + r.qty, 0);
  const weightHundredths = input.shipped.rows.reduce((s, r) => s + hundredths(r.weight), 0);

  let invoiceCents = 0;
  let creditCents = 0;
  for (const inv of input.invoices) {
    if (inv.kind === "CREDIT") creditCents += cents(inv.total);
    else invoiceCents += cents(inv.total);
  }

  return {
    window: input.window,
    ordersEntered: input.ordersEntered,
    shipped: { qty, weight: weightHundredths / 100 },
    invoiced: {
      invoices: invoiceCents / 100,
      credits: creditCents / 100,
      net: (invoiceCents + creditCents) / 100,
    },
  };
}

// -------------------------------------------------------------------------------------------
// reportScoreboard — the Prisma-reading wrapper. Read-only: no claim, no transaction, no audit.
// One window drives all three reads; the shipped read is delegated to `reportShipped` (reuse).
// -------------------------------------------------------------------------------------------

export type ScoreboardFilter = {
  from?: string; // window >=
  to?: string; // window <=
};

/** `parseDateOnly` at the service boundary — the `buildShipped`/`buildSales` `parseDate` precedent:
 *  a malformed bound fails as a field-anchored 400, not a status-less 500. */
function parseDate(value: string, field: string): Date {
  try {
    return parseDateOnly(value);
  } catch {
    throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${field}`);
  }
}

/** The scoreboard window — undefined when neither bound is set, so a blank filter narrows nothing.
 *  Both columns this drives (`Order.receivedDate`, `Invoice.invoiceDate`) are `@db.Date` (UTC
 *  midnight, no time-of-day), so an inclusive `lte` on `to` is correct — this is NOT the Sales
 *  report's half-open `finalizedAt` window. The one window is applied verbatim to both columns. */
function dateRange(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: parseDate(from, "From") } : {}),
    ...(to ? { lte: parseDate(to, "To") } : {}),
  };
}

export async function reportScoreboard(filter: ScoreboardFilter = {}): Promise<ScoreboardFigures> {
  const { from, to } = filter;
  const window = dateRange(from, to); // parses both bounds up front — a malformed date 400s here

  // Orders entered — a live-order COUNT by receivedDate (voided excluded).
  const ordersEntered = await prisma.order.count({
    where: {
      deletedAt: null,
      ...(window ? { receivedDate: window } : {}),
    },
  });

  // Shipped — REUSE the Shipped report for the same window (default groupBy: "none"), then sum its
  // rows. `reportShipped` re-parses the same strings, so a malformed date would 400 identically.
  const shipped = await reportShipped({ from, to });

  // Invoiced $ — FINALIZED, non-discarded docs by invoiceDate; gross `total` (CREDIT total negative).
  const invoiceRows = await prisma.invoice.findMany({
    where: {
      status: "FINALIZED",
      deletedAt: null,
      ...(window ? { invoiceDate: window } : {}),
    },
    select: { kind: true, total: true },
  });

  return buildScoreboard({
    window: { from: from ?? null, to: to ?? null },
    ordersEntered,
    shipped,
    invoices: invoiceRows.map((i) => ({ kind: i.kind, total: i.total.toNumber() })),
  });
}
