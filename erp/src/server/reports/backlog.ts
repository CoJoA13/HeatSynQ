import type { Prisma } from "../../../prisma/generated/prisma/client";
import { prisma } from "../db";
import { HttpError } from "../errors";
import { parseDateOnly, formatDateOnly, todayDateOnly } from "../../lib/business-days";

// -------------------------------------------------------------------------------------------
// Phase 8A Task 1 (spec §4.2): the Backlog report — open order lines of orders not yet fully
// shipped. `buildBacklog` is the PURE core (the `bucketAging` shape — no Prisma, no I/O), and
// `reportBacklog` is the thin Prisma-reading wrapper. A report is a pure READ: no row claim, no
// audit, no Serializable (spec §11, reports/README.md).
//
// The measure, pinned (do not guess it back into ambiguity):
//   • Population — order lines of orders whose status ∈ {OPEN, PARTIAL_SHIPPED, REOPENED} and
//     deletedAt: null. REOPENED is INCLUDED — an invoiced order reversed back open is genuinely
//     un-shipped work again; dropping it silently undercounts backlog. SHIPPED and INVOICED are
//     done, and voided orders are excluded by deletedAt: null.
//   • Amounts — qty + weight ORDERED (the order line's own ordered quantity/weight, spec §4.2's
//     words), NOT remaining-to-ship. Computing a shipped remainder would pull in the ship-ledger,
//     a different and unrequested measure.
//   • Grain — one detail row per open order line; the customer/part/received-month slices
//     aggregate over that grain.
// -------------------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
/** Weight is a Decimal(12,2); sum it in integer hundredths so fractional weights don't drift
 *  (the `ar-balances` integer-cent rule applied to pounds). */
const hundredths = (n: number): number => Math.round(n * 100);

/** The three open statuses that count as backlog (see the header note on REOPENED). */
export const BACKLOG_STATUSES = ["OPEN", "PARTIAL_SHIPPED", "REOPENED"] as const;

export type BacklogGroupBy = "none" | "customer" | "part" | "month";
const GROUP_BYS: readonly BacklogGroupBy[] = ["none", "customer", "part", "month"];

/** One open order line — the base grain. `qty`/`weight` are the ORDERED amounts; `daysOpen` =
 *  today − receivedDate in whole days. */
export type BacklogDetailRow = {
  orderId: string;
  orderLineId: string;
  orderNumber: number;
  customerCode: string;
  customerName: string;
  partNumber: string;
  partName: string;
  qty: number;
  weight: number;
  receivedDate: string;
  daysOpen: number;
};

/** An aggregate over the base grain — one row per customer / part / received-month. `key` is the
 *  stable grouping id (customerId / partId / "yyyy-mm"); `label` is the display string. */
export type BacklogGroupRow = {
  key: string;
  label: string;
  orderCount: number;
  lineCount: number;
  qty: number;
  weight: number;
};

export type BacklogResult =
  | { groupBy: "none"; rows: BacklogDetailRow[] }
  | { groupBy: "customer" | "part" | "month"; rows: BacklogGroupRow[] };

/** The pure-core input: an open order line with its order/customer/part identity resolved and its
 *  amounts already humanized (weight a plain number, receivedDate a "yyyy-mm-dd" string). No
 *  Prisma, no Decimal — the wrapper below maps the DB rows into this. */
export type OpenLine = {
  orderId: string;
  orderLineId: string;
  orderNumber: number;
  customerId: string;
  customerCode: string;
  customerName: string;
  partId: string;
  partNumber: string;
  partName: string;
  qty: number;
  weight: number;
  receivedDate: string;
};

/** Whole days an order line has been open: `today − receivedDate`. Both are UTC-midnight date-only
 *  values, so the difference is an exact DAY_MS multiple; `Math.round` guards any float noise. */
function daysOpen(receivedDate: string, today: string): number {
  return Math.round((parseDateOnly(today).getTime() - parseDateOnly(receivedDate).getTime()) / DAY_MS);
}

function groupLabel(l: OpenLine, groupBy: "customer" | "part" | "month"): { key: string; label: string } {
  if (groupBy === "customer") return { key: l.customerId, label: `${l.customerCode} · ${l.customerName}` };
  if (groupBy === "part") return { key: l.partId, label: l.partName ? `${l.partNumber} · ${l.partName}` : l.partNumber };
  const month = l.receivedDate.slice(0, 7); // "yyyy-mm"
  return { key: month, label: month };
}

/**
 * PURE. Shapes the open lines into the requested view.
 *   • `none` → one detail row per open line, sorted by order number then part number
 *     (deterministic), each carrying its ORDERED qty/weight and its days-open vs. `today`.
 *   • `customer`/`part`/`month` → aggregate rows: distinct order count, line count, Σqty, Σweight
 *     (weight summed in integer hundredths so fractional weights don't drift), sorted by label.
 * `today` is a parameter so the days-open math is deterministic under test.
 */
export function buildBacklog(lines: OpenLine[], opts: { today: string; groupBy: BacklogGroupBy }): BacklogResult {
  if (opts.groupBy === "none") {
    const rows: BacklogDetailRow[] = lines
      .map((l) => ({
        orderId: l.orderId, orderLineId: l.orderLineId, orderNumber: l.orderNumber,
        customerCode: l.customerCode, customerName: l.customerName,
        partNumber: l.partNumber, partName: l.partName,
        qty: l.qty, weight: l.weight, receivedDate: l.receivedDate,
        daysOpen: daysOpen(l.receivedDate, opts.today),
      }))
      .sort((a, b) => a.orderNumber - b.orderNumber || a.partNumber.localeCompare(b.partNumber));
    return { groupBy: "none", rows };
  }

  const groupBy = opts.groupBy;
  type Acc = { key: string; label: string; orders: Set<string>; lineCount: number; qty: number; weightHundredths: number };
  const groups = new Map<string, Acc>();
  for (const l of lines) {
    const { key, label } = groupLabel(l, groupBy);
    let acc = groups.get(key);
    if (!acc) {
      acc = { key, label, orders: new Set(), lineCount: 0, qty: 0, weightHundredths: 0 };
      groups.set(key, acc);
    }
    acc.orders.add(l.orderId);
    acc.lineCount += 1;
    acc.qty += l.qty;
    acc.weightHundredths += hundredths(l.weight);
  }
  const rows: BacklogGroupRow[] = [...groups.values()]
    .map((a) => ({
      key: a.key, label: a.label,
      orderCount: a.orders.size, lineCount: a.lineCount,
      qty: a.qty, weight: a.weightHundredths / 100,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  return { groupBy, rows };
}

// -------------------------------------------------------------------------------------------
// reportBacklog — the Prisma-reading wrapper. Read-only: no claim, no transaction, no audit.
// -------------------------------------------------------------------------------------------

export type BacklogFilter = {
  customerId?: string;
  partId?: string;
  from?: string; // receivedDate >=
  to?: string; // receivedDate <=
  groupBy?: BacklogGroupBy;
};

/** `parseDateOnly` at the service boundary — the `orders.ts`/`receipts.ts` `parseDate` precedent:
 *  a malformed bound fails as a field-anchored 400, not a status-less 500. */
function parseDate(value: string, field: string): Date {
  try {
    return parseDateOnly(value);
  } catch {
    throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${field}`);
  }
}

/** The received-date window (the `orders.ts` `dateRange` shape) — undefined when neither bound is
 *  set, so a blank filter narrows nothing. */
function receivedRange(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: parseDate(from, "Received from") } : {}),
    ...(to ? { lte: parseDate(to, "Received to") } : {}),
  };
}

/** The service owns groupBy validation (the parse layer passes the raw string through — the
 *  aging `parseAsOf` discipline), so an unknown value fails as a 400 rather than silently falling
 *  back to a view the caller did not ask for. `Object.hasOwn`-safe: a plain membership check. */
function normalizeGroupBy(value: string | undefined): BacklogGroupBy {
  if (value === undefined) return "none";
  if ((GROUP_BYS as readonly string[]).includes(value)) return value as BacklogGroupBy;
  throw new HttpError(400, `Cannot group backlog by "${value}"`);
}

export async function reportBacklog(filter: BacklogFilter = {}): Promise<BacklogResult> {
  const groupBy = normalizeGroupBy(filter.groupBy);
  const received = receivedRange(filter.from, filter.to);

  // A single findMany — atomic on its own, so unlike aging (three component reads) this needs no
  // RepeatableRead transaction. OrderLine is not soft-deletable (no deletedAt column); the only
  // liveness filter is the order's own deletedAt: null.
  const lineRows = await prisma.orderLine.findMany({
    where: {
      order: {
        deletedAt: null,
        status: { in: [...BACKLOG_STATUSES] },
        ...(filter.customerId ? { customerId: filter.customerId } : {}),
        ...(received ? { receivedDate: received } : {}),
      },
      ...(filter.partId ? { partId: filter.partId } : {}),
    },
    // Deterministic order so within-group detail rows are stable across runs: orderNumber is unique
    // and [orderId, position] is unique, so the pair totally orders the rows. The pure-core sort is
    // stable (ES2019+), so it preserves this order for rows tied under its own comparator (same
    // order + same part number — two lines on the SAME part).
    orderBy: [{ order: { orderNumber: "asc" } }, { position: "asc" }],
    select: {
      id: true, qty: true, weight: true, partId: true,
      part: { select: { partNumber: true, name: true } },
      order: {
        select: {
          id: true, orderNumber: true, receivedDate: true, customerId: true,
          customer: { select: { code: true, name: true } },
        },
      },
    },
  });

  const today = formatDateOnly(todayDateOnly());
  const lines: OpenLine[] = lineRows.map((l) => ({
    orderId: l.order.id,
    orderLineId: l.id,
    orderNumber: l.order.orderNumber,
    customerId: l.order.customerId,
    customerCode: l.order.customer.code,
    customerName: l.order.customer.name,
    partId: l.partId,
    partNumber: l.part.partNumber,
    partName: l.part.name,
    qty: l.qty,
    weight: l.weight.toNumber(),
    receivedDate: formatDateOnly(l.order.receivedDate),
  }));

  return buildBacklog(lines, { today, groupBy });
}
