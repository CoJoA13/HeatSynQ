import type { Prisma } from "../../../prisma/generated/prisma/client";
import { prisma } from "../db";
import { HttpError } from "../errors";
import { parseDateOnly, formatDateOnly } from "../../lib/business-days";

// -------------------------------------------------------------------------------------------
// Phase 8A Task 2 (spec §4.2): the Shipped report — actual shipped volume by period. `buildShipped`
// is the PURE core (the `bucketAging`/`buildBacklog` shape — no Prisma, no I/O), and `reportShipped`
// is the thin Prisma-reading wrapper. A report is a pure READ: no row claim, no audit, no
// Serializable (spec §11, reports/README.md).
//
// The measure, pinned (this one has two traps — do NOT let it drift back to `shippedTotals`):
//   • A NEW shipDate-WINDOWED aggregation. We join ShipperLine → ShipperOrder → Shipper and bucket
//     on `Shipper.shipDate`. We deliberately do NOT call `shippedTotals` (ship-ledger.ts): that
//     function is keyed on `orderLineId` with NO date dimension and it SKIPS released rows — it
//     answers the ordered-vs-shipped invariant question, not "how much did we ship in this window."
//     We reuse only its LIVE-FILTER discipline (voided shipments contribute nothing), not the code.
//   • Live filter: a voided shipment (`Shipper.deletedAt` set) contributes nothing, reached through
//     the one relation a line has back to its shipment (`shipperOrder.shipper.deletedAt: null`).
//     ShipperOrder/ShipperLine carry no deletedAt of their own (spec §4.2). REVERSALS are live
//     negative-qty ShipperLine rows whose parent Shipper links via `reversesShipperId` and carries
//     its OWN `shipDate` — so summing live lines auto-nets a reversal into the reversal's own
//     shipDate window (which may be a different month than the original outbound). No special case.
//   • RELEASED rows (`orderLineId === null`, the order line was later deleted) ARE real shipped
//     material and ARE included, via their SNAPSHOT `qty`/`weight`/`partNumber`/`partName` columns —
//     the deliberate divergence from `shippedTotals`, which skips them. The snapshot part identity
//     is what the "by part" slice groups a released row under.
// -------------------------------------------------------------------------------------------

/** Weight is a Decimal(12,2); sum it in integer hundredths so fractional (and negative reversal)
 *  weights don't drift (the `buildBacklog`/`ar-balances` integer-cent rule applied to pounds). */
const hundredths = (n: number): number => Math.round(n * 100);

export type ShippedGroupBy = "none" | "customer" | "part" | "month" | "day";
const GROUP_BYS: readonly ShippedGroupBy[] = ["none", "customer", "part", "month", "day"];

/** One shipped shipper line — the base grain. `qty`/`weight` are the SHIPPED amounts and may be
 *  NEGATIVE (a reversal line). `partNumber`/`partName` are already resolved live-join-first with the
 *  snapshot as fallback (the wrapper does that); the core never re-joins. */
export type ShippedLine = {
  shipperId: string;
  shipperNumber: number;
  shipDate: string; // yyyy-mm-dd
  customerId: string;
  customerCode: string;
  customerName: string;
  partNumber: string;
  partName: string;
  qty: number;
  weight: number;
};

/** One detail row — a single shipper line, identity + amounts. */
export type ShippedDetailRow = {
  shipperId: string;
  shipperNumber: number;
  shipDate: string;
  customerCode: string;
  customerName: string;
  partNumber: string;
  partName: string;
  qty: number;
  weight: number;
};

/** An aggregate over the base grain — one row per customer / part / ship-month / day. `key` is the
 *  stable grouping id; `label` is the display string. `shipmentCount` is DISTINCT shippers in the
 *  group (a two-line shipment counts once), NOT a line count. */
export type ShippedGroupRow = {
  key: string;
  label: string;
  shipmentCount: number;
  qty: number;
  weight: number;
};

export type ShippedResult =
  | { groupBy: "none"; rows: ShippedDetailRow[] }
  | { groupBy: "customer" | "part" | "month" | "day"; rows: ShippedGroupRow[] };

/** The part grouping key is `customerId + " " + partNumber`: parts are customer-scoped (two
 *  customers can share a part number and they are genuinely different parts), and a RELEASED row has
 *  no partId to key on — only its snapshot partNumber — so a partNumber-based key is the one that
 *  spans both live and released rows. A cuid customerId never contains a space, so the first space
 *  is always the delimiter (partNumber may itself contain spaces without ambiguity). */
function groupLabel(
  l: ShippedLine, groupBy: "customer" | "part" | "month" | "day",
): { key: string; label: string } {
  if (groupBy === "customer") return { key: l.customerId, label: `${l.customerCode} · ${l.customerName}` };
  if (groupBy === "part") {
    return { key: `${l.customerId} ${l.partNumber}`, label: l.partName ? `${l.partNumber} · ${l.partName}` : l.partNumber };
  }
  if (groupBy === "month") { const month = l.shipDate.slice(0, 7); return { key: month, label: month }; }
  return { key: l.shipDate, label: l.shipDate }; // day
}

/**
 * PURE. Shapes the shipped lines into the requested view.
 *   • `none` → one detail row per shipper line, sorted by shipDate, then shipper number, then part
 *     number (deterministic), each carrying its (possibly negative) shipped qty/weight.
 *   • `customer`/`part`/`month`/`day` → aggregate rows: distinct shipment count, Σqty, Σweight
 *     (weight summed in integer hundredths so fractional/negative weights don't drift), sorted by
 *     label — for month/day the label is the date string, so the sort is chronological.
 */
export function buildShipped(lines: ShippedLine[], opts: { groupBy: ShippedGroupBy }): ShippedResult {
  if (opts.groupBy === "none") {
    const rows: ShippedDetailRow[] = lines
      .map((l) => ({
        shipperId: l.shipperId, shipperNumber: l.shipperNumber, shipDate: l.shipDate,
        customerCode: l.customerCode, customerName: l.customerName,
        partNumber: l.partNumber, partName: l.partName,
        qty: l.qty, weight: l.weight,
      }))
      .sort((a, b) =>
        a.shipDate.localeCompare(b.shipDate)
        || a.shipperNumber - b.shipperNumber
        || a.partNumber.localeCompare(b.partNumber));
    return { groupBy: "none", rows };
  }

  const groupBy = opts.groupBy;
  type Acc = { key: string; label: string; shippers: Set<string>; qty: number; weightHundredths: number };
  const groups = new Map<string, Acc>();
  for (const l of lines) {
    const { key, label } = groupLabel(l, groupBy);
    let acc = groups.get(key);
    if (!acc) {
      acc = { key, label, shippers: new Set(), qty: 0, weightHundredths: 0 };
      groups.set(key, acc);
    }
    acc.shippers.add(l.shipperId);
    acc.qty += l.qty;
    acc.weightHundredths += hundredths(l.weight);
  }
  const rows: ShippedGroupRow[] = [...groups.values()]
    .map((a) => ({
      key: a.key, label: a.label,
      shipmentCount: a.shippers.size, qty: a.qty, weight: a.weightHundredths / 100,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  return { groupBy, rows };
}

// -------------------------------------------------------------------------------------------
// reportShipped — the Prisma-reading wrapper. Read-only: no claim, no transaction, no audit.
// -------------------------------------------------------------------------------------------

export type ShippedFilter = {
  customerId?: string;
  partId?: string;
  from?: string; // shipDate >=
  to?: string; // shipDate <=
  groupBy?: ShippedGroupBy;
};

/** `parseDateOnly` at the service boundary — the `buildBacklog` `parseDate` precedent: a malformed
 *  bound fails as a field-anchored 400, not a status-less 500. */
function parseDate(value: string, field: string): Date {
  try {
    return parseDateOnly(value);
  } catch {
    throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${field}`);
  }
}

/** The ship-date window — undefined when neither bound is set, so a blank filter narrows nothing.
 *  `shipDate` is a `@db.Date` (UTC-midnight, no time-of-day), so an inclusive `lte` on the `to` date
 *  is correct — the `finalizedAt` half-open subtlety does not apply here. */
function shipDateRange(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: parseDate(from, "Ship from") } : {}),
    ...(to ? { lte: parseDate(to, "Ship to") } : {}),
  };
}

/** The service owns groupBy validation (the parse layer passes the raw string through — the
 *  `buildBacklog` `normalizeGroupBy` discipline), so an unknown value fails as a 400 rather than
 *  silently falling back to a view the caller did not ask for. */
function normalizeGroupBy(value: string | undefined): ShippedGroupBy {
  if (value === undefined) return "none";
  if ((GROUP_BYS as readonly string[]).includes(value)) return value as ShippedGroupBy;
  throw new HttpError(400, `Cannot group shipped by "${value}"`);
}

export async function reportShipped(filter: ShippedFilter = {}): Promise<ShippedResult> {
  const groupBy = normalizeGroupBy(filter.groupBy);
  const shipDate = shipDateRange(filter.from, filter.to);

  // A single findMany — atomic on its own, so no RepeatableRead transaction is needed. The live
  // filter reaches the void flag through `shipperOrder.shipper.deletedAt: null` (a voided shipment
  // contributes nothing). Released rows (`orderLineId: null`) are NOT filtered out — that is the
  // point; they still belong to a live shipper and are counted via their snapshot columns.
  //
  // The `partId` filter matches the LIVE `orderLine.partId`, so it deliberately excludes released
  // rows: a released row has no partId (only a snapshot number) and so cannot be positively matched
  // to a chosen part. The default view (no part filter) still counts released material via the
  // snapshot; drilling into one specific part restricts to lines whose part linkage is intact.
  const lineRows = await prisma.shipperLine.findMany({
    where: {
      shipperOrder: {
        shipper: {
          deletedAt: null,
          ...(shipDate ? { shipDate } : {}),
          ...(filter.customerId ? { customerId: filter.customerId } : {}),
        },
      },
      ...(filter.partId ? { orderLine: { partId: filter.partId } } : {}),
    },
    select: {
      qty: true, weight: true,
      partNumber: true, partName: true, // snapshot fallback (released rows)
      orderLine: { select: { part: { select: { partNumber: true, name: true } } } }, // live-join-first
      shipperOrder: {
        select: {
          shipper: {
            select: {
              id: true, shipperNumber: true, shipDate: true, customerId: true,
              customer: { select: { code: true, name: true } },
            },
          },
        },
      },
    },
  });

  const lines: ShippedLine[] = lineRows.map((r) => {
    const shipper = r.shipperOrder.shipper;
    // Live-join-first: a live row shows the part's CURRENT number/name; a released row (orderLine
    // null) falls back to the snapshot captured at ship time. `??` only falls back on null, so a
    // deliberately-blank live name stays blank rather than borrowing the snapshot.
    return {
      shipperId: shipper.id,
      shipperNumber: shipper.shipperNumber,
      shipDate: formatDateOnly(shipper.shipDate),
      customerId: shipper.customerId,
      customerCode: shipper.customer.code,
      customerName: shipper.customer.name,
      partNumber: r.orderLine?.part.partNumber ?? r.partNumber,
      partName: r.orderLine?.part.name ?? r.partName,
      qty: r.qty,
      weight: r.weight.toNumber(),
    };
  });

  return buildShipped(lines, { groupBy });
}
