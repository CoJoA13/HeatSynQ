import type { Prisma } from "../../../prisma/generated/prisma/client";
import { prisma } from "../db";
import { HttpError } from "../errors";
import { getSetting } from "../settings";
import { parseDateOnly, formatDateOnly, addDays } from "../../lib/business-days";
import type { InvoiceKindValue, InvoiceLineKindValue } from "../../lib/invoice-constants";

// -------------------------------------------------------------------------------------------
// Phase 8A Task 4 (spec §4.2 / §8): the Sales report — invoiced revenue EXCLUDING sales tax,
// net of credits, sliceable by customer / part / finalized-month and reconciling to the GL
// export's revenue accounts. `buildSales` is the PURE core (the `bucketAging`/`buildShipped`
// shape — no Prisma, no I/O), `reportSales` the thin Prisma-reading wrapper. A report is a pure
// READ: no row claim, no audit, no Serializable (main spec §12, reports/README.md).
//
// The measure, pinned (this is "the careful one" — two things MUST be exactly right):
//   • Recognition — `Invoice.status = FINALIZED`, `deletedAt: null`, recognized by `finalizedAt`
//     (owner ruling 8 — NOT `invoiceDate`), over a HALF-OPEN `[from, nextDay)` window because
//     `finalizedAt` carries a time-of-day (an inclusive `lte` at midnight drops a last-day
//     finalize). This is the SAME recognition basis as the 5C close roll-forward and GL-export.
//   • FROZEN snapshot — the report sums the stored `InvoiceLine.amount` and groups on the stored
//     `InvoiceLine.partNumber`. It NEVER live-joins `Part`/`StepCode` (the frozen-paper rule,
//     CLAUDE.md §5.4): a later part rename or reprice must not rewrite a past month's figures.
//   • Line kinds — sum ALL non-`TAX` lines: OPERATION + SURCHARGE + FREIGHT + CHARGE + CERT. The
//     `PART` header line is `amount = 0` (harmless to include). SURCHARGE carries REAL revenue and
//     a BLANK partNumber (pricing.ts `blank("SURCHARGE")`) — dropping it undercounts sales AND
//     breaks the GL reconciliation. TAX is the one kind excluded (revenue is ex-tax).
//   • Credits — a CREDIT copies its source lines with the money sign FLIPPED (invoices.ts
//     `negateMoney`), so its `amount`s are stored NEGATIVE. Summing every line therefore NETS
//     credits automatically: Sales = Σ invoice non-tax lines − Σ credit non-tax lines.
//   • By-part slice — part-bearing lines group by (customer, partNumber); parts are customer-scoped
//     (the `buildShipped` precedent — two customers can share a number and mean different parts).
//     The blank-`partNumber` kinds (SURCHARGE/FREIGHT/CHARGE/CERT) fall into one explicit
//     "(no part)" bucket, so the part-sliced total still equals the unsliced total. A surcharge is
//     NEVER re-joined to the part it surcharges — the snapshot carries no part identity on it.
// -------------------------------------------------------------------------------------------

/** Money is Decimal(12,2); sum it in integer cents so credits and fractional dollars don't drift
 *  (the `buildShipped` integer-hundredths rule applied to money). */
const cents = (n: number): number => Math.round(n * 100);

/** The stable key + label for the single blank-`partNumber` bucket in the by-part slice. A cuid
 *  customerId never equals this, so a part key (`customerId + " " + partNumber`) never collides. */
const NO_PART = "(no part)";

export type SalesGroupBy = "none" | "customer" | "part" | "month";
const GROUP_BYS: readonly SalesGroupBy[] = ["none", "customer", "part", "month"];

/** One non-... line of a finalized document — the pure-core input. `amount` is a signed dollar
 *  figure (NEGATIVE on a credit); `lineKind` lets the core drop TAX (ex-tax); `documentKind` and
 *  `documentNumber` ride along for the detail row. `partNumber` is the stored snapshot (blank on
 *  SURCHARGE/FREIGHT/CHARGE/CERT/TAX), never a live join. */
export type SalesLine = {
  invoiceId: string;
  documentNumber: string;
  documentKind: InvoiceKindValue; // INVOICE | CREDIT — the document, not the line
  lineKind: InvoiceLineKindValue; // the core excludes TAX
  customerId: string;
  customerCode: string;
  customerName: string;
  finalizedDate: string; // yyyy-mm-dd (from finalizedAt, UTC)
  partNumber: string;
  partName: string;
  amount: number; // signed dollars — credits are negative
};

/** One detail row — a finalized document and its net ex-tax revenue (negative for a credit). */
export type SalesDetailRow = {
  invoiceId: string;
  documentNumber: string;
  kind: InvoiceKindValue;
  customerCode: string;
  customerName: string;
  finalizedDate: string;
  revenue: number;
};

/** An aggregate over the base grain — one row per customer / part / finalized-month. `invoiceCount`
 *  is DISTINCT documents in the group; `revenue` is the net ex-tax sum. */
export type SalesGroupRow = {
  key: string;
  label: string;
  invoiceCount: number;
  revenue: number;
};

/** Every view carries the overall `total` (net ex-tax revenue) and `invoiceCount` (distinct
 *  documents), computed over the whole population regardless of `groupBy` — the `buildTurnaround`
 *  summary pattern; a slice's rows can't be re-weighted back into it. */
export type SalesResult =
  | { groupBy: "none"; rows: SalesDetailRow[]; total: number; invoiceCount: number }
  | { groupBy: "customer" | "part" | "month"; rows: SalesGroupRow[]; total: number; invoiceCount: number };

/** The (key, label) a line contributes to for a grouping dimension. customer/month map to exactly
 *  one group; part maps a part-bearing line to (customer, partNumber) and every blank-part line to
 *  the single "(no part)" bucket. */
function groupKey(l: SalesLine, groupBy: "customer" | "part" | "month"): { key: string; label: string } {
  if (groupBy === "customer") return { key: l.customerId, label: `${l.customerCode} · ${l.customerName}` };
  if (groupBy === "month") { const m = l.finalizedDate.slice(0, 7); return { key: m, label: m }; }
  // Blank-part lines (SURCHARGE/FREIGHT/CHARGE/CERT) share ONE explicit "(no part)" bucket — the
  // snapshot carries no part identity on them, and a surcharge is never re-joined to its part.
  if (l.partNumber === "") return { key: NO_PART, label: NO_PART };
  return { key: `${l.customerId} ${l.partNumber}`, label: l.partName ? `${l.partNumber} · ${l.partName}` : l.partNumber };
}

/**
 * PURE. Shapes the finalized lines into the requested view.
 *   • `none` → one detail row per document, its non-tax lines summed to a net ex-tax revenue,
 *     sorted by finalized date then document number.
 *   • `customer`/`part`/`month` → aggregate rows: distinct document count + Σrevenue (summed in
 *     integer cents so credits/fractions don't drift), sorted by label.
 * The overall `total`/`invoiceCount` are always over the DISTINCT documents in the population.
 */
export function buildSales(lines: SalesLine[], opts: { groupBy: SalesGroupBy }): SalesResult {
  // Revenue is EX-TAX (§4.2): the TAX line is the one kind excluded — every other kind
  // (OPERATION/SURCHARGE/FREIGHT/CHARGE/CERT, plus the $0 PART header) is real invoiced revenue.
  const revenue = lines.filter((l) => l.lineKind !== "TAX");

  const grandCents = revenue.reduce((s, l) => s + cents(l.amount), 0);
  const total = grandCents / 100;
  const invoiceCount = new Set(revenue.map((l) => l.invoiceId)).size;

  if (opts.groupBy === "none") {
    type Doc = { invoiceId: string; documentNumber: string; kind: InvoiceKindValue; customerCode: string; customerName: string; finalizedDate: string; cents: number };
    const docs = new Map<string, Doc>();
    for (const l of revenue) {
      let doc = docs.get(l.invoiceId);
      if (!doc) {
        doc = {
          invoiceId: l.invoiceId, documentNumber: l.documentNumber, kind: l.documentKind,
          customerCode: l.customerCode, customerName: l.customerName, finalizedDate: l.finalizedDate, cents: 0,
        };
        docs.set(l.invoiceId, doc);
      }
      doc.cents += cents(l.amount);
    }
    const rows: SalesDetailRow[] = [...docs.values()]
      .map((d) => ({
        invoiceId: d.invoiceId, documentNumber: d.documentNumber, kind: d.kind,
        customerCode: d.customerCode, customerName: d.customerName,
        finalizedDate: d.finalizedDate, revenue: d.cents / 100,
      }))
      .sort((a, b) =>
        a.finalizedDate.localeCompare(b.finalizedDate)
        || a.documentNumber.localeCompare(b.documentNumber)
        || a.invoiceId.localeCompare(b.invoiceId));
    return { groupBy: "none", rows, total, invoiceCount };
  }

  const groupBy = opts.groupBy;
  type Acc = { key: string; label: string; docs: Set<string>; cents: number };
  const groups = new Map<string, Acc>();
  for (const l of revenue) {
    const { key, label } = groupKey(l, groupBy);
    let acc = groups.get(key);
    if (!acc) { acc = { key, label, docs: new Set(), cents: 0 }; groups.set(key, acc); }
    acc.docs.add(l.invoiceId);
    acc.cents += cents(l.amount);
  }
  const rows: SalesGroupRow[] = [...groups.values()]
    .map((a) => ({ key: a.key, label: a.label, invoiceCount: a.docs.size, revenue: a.cents / 100 }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  return { groupBy, rows, total, invoiceCount };
}

// -------------------------------------------------------------------------------------------
// reportSales — the Prisma-reading wrapper. Read-only: no claim, no transaction, no audit. It
// assembles the FROZEN snapshot into `SalesLine`s; the pure core owns the ex-tax and "(no part)"
// rules so they stay unit-testable.
// -------------------------------------------------------------------------------------------

export type SalesFilter = {
  customerId?: string;
  from?: string; // finalizedAt >=
  to?: string; // finalizedAt within [from, nextDay(to))
  groupBy?: SalesGroupBy;
};

/** `parseDateOnly` at the service boundary — the `buildBacklog`/`buildShipped` `parseDate`
 *  precedent: a malformed bound fails as a field-anchored 400, not a status-less 500. */
function parseDate(value: string, field: string): Date {
  try {
    return parseDateOnly(value);
  } catch {
    throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${field}`);
  }
}

/** The finalized-date window. HALF-OPEN `[from, nextDay(to))` (owner ruling 8): `finalizedAt` is a
 *  `DateTime` with a time-of-day, so the upper bound is the START of the day AFTER `to` — a
 *  last-second-of-`to` finalize is in range, and an inclusive `lte monthEnd`-at-midnight would drop
 *  it. Undefined when neither bound is set, so a blank filter narrows nothing. */
function finalizedRange(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: parseDate(from, "Finalized from") } : {}),
    ...(to ? { lt: addDays(parseDate(to, "Finalized to"), 1) } : {}),
  };
}

/** The service owns groupBy validation (the parse layer passes the raw string through — the
 *  `buildBacklog` `normalizeGroupBy` discipline), so an unknown value fails as a 400 rather than
 *  silently falling back to a view the caller did not ask for. */
function normalizeGroupBy(value: string | undefined): SalesGroupBy {
  if (value === undefined) return "none";
  if ((GROUP_BYS as readonly string[]).includes(value)) return value as SalesGroupBy;
  throw new HttpError(400, `Cannot group sales by "${value}"`);
}

/** The paper's document number — the credit number for a CREDIT, else the invoice-number prefix +
 *  order number (P5A §10; a blank prefix prints the bare order number). Replicated from
 *  invoices.ts's private `documentNumber` rather than imported, so this lean report never drags the
 *  invoice service's PDF/template graph into its bundle. */
function documentNumberOf(kind: InvoiceKindValue, creditNumber: number | null, orderNumber: number, prefix: string): string {
  if (kind === "CREDIT") return String(creditNumber);
  return prefix === "" ? String(orderNumber) : `${prefix} - ${orderNumber}`;
}

export async function reportSales(filter: SalesFilter = {}): Promise<SalesResult> {
  const groupBy = normalizeGroupBy(filter.groupBy);
  const finalizedAt = finalizedRange(filter.from, filter.to);
  const prefix = await getSetting("invoice_number_prefix");

  // A single findMany — atomic on its own, so no RepeatableRead transaction is needed. The only
  // liveness filters are the invoice's own `status = FINALIZED` (a draft posts nothing and prints
  // nothing) and `deletedAt: null` (a discarded draft). Every line's `amount`/`partNumber` is the
  // FROZEN snapshot — no join to Part/StepCode anywhere in this select.
  const invoices = await prisma.invoice.findMany({
    where: {
      status: "FINALIZED",
      deletedAt: null,
      ...(finalizedAt ? { finalizedAt } : {}),
      ...(filter.customerId ? { customerId: filter.customerId } : {}),
    },
    select: {
      id: true, kind: true, customerId: true, creditNumber: true, finalizedAt: true,
      order: { select: { orderNumber: true } },
      customer: { select: { code: true, name: true } },
      lines: { select: { kind: true, partNumber: true, partName: true, amount: true } },
    },
  });

  const lines: SalesLine[] = [];
  for (const inv of invoices) {
    const documentNumber = documentNumberOf(inv.kind, inv.creditNumber, inv.order.orderNumber, prefix);
    // A FINALIZED invoice always carries `finalizedAt` (stamped at finalize), so it is non-null here.
    const finalizedDate = formatDateOnly(inv.finalizedAt!);
    for (const l of inv.lines) {
      lines.push({
        invoiceId: inv.id, documentNumber, documentKind: inv.kind, lineKind: l.kind,
        customerId: inv.customerId, customerCode: inv.customer.code, customerName: inv.customer.name,
        finalizedDate,
        partNumber: l.partNumber, partName: l.partName,
        amount: l.amount.toNumber(),
      });
    }
  }

  return buildSales(lines, { groupBy });
}
