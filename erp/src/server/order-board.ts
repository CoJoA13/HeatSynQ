// The order board's reads (#33's bounded slice, split verbatim out of orders.ts 2026-08-19):
// `listOrders`, `exportOrders`, their filter/row shapes, and the WHERE/orderBy/date-range builders
// they share. PURE READS ONLY — nothing here claims a row, opens a Serializable transaction, or
// allocates a number, and nothing here may start to: a board query that locked or wrote would be
// a new concurrency surface, not a move. Every mutator, and every invariant that guards one,
// stays in orders.ts; orders.ts re-exports this module's public names so every existing
// `@/server/orders` import site (the routes, the tests, order-loads.ts, traveler.ts) is
// untouched.
import { Prisma, type OrderStatus } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { toXlsx } from "./excel";
import { getSetting } from "./settings";
import { formatDateOnly, parseDateOnly, todayDateOnly } from "../lib/business-days";
import { computeLight, LIGHT_LABELS, type TrafficLight } from "../lib/traffic-light";

export type BoardRow = {
  id: string; orderNumber: number; customerCode: string; customerName: string;
  leadPartNumber: string; poNumber: string; vsOrderNumber: string;
  /** Σ over the order's lines. */
  qty: number; weight: number;
  receivedDate: string; requestDate: string; targetDate: string | null;
  status: OrderStatus; voided: boolean; light: TrafficLight;
  loadCount: number; linked: boolean;
};

/**
 * The board query. Dates arrive as "yyyy-mm-dd" strings and are validated here; `status` is
 * already typed, so the route that turns a query string into this shape owns that parse — the
 * `listParts` precedent.
 */
export type OrderFilter = {
  search?: string; status?: OrderStatus[]; customerId?: string;
  receivedFrom?: string; receivedTo?: string; requestFrom?: string; requestTo?: string;
  includeVoided?: boolean; sort?: string; dir?: "asc" | "desc";
};

export type Traffic = { mayMissDays: number; willMissDays: number };

/** Both windows in ONE pair of reads per call — the board computes a light for every row and
 *  must not fan a settings query out across them (spec §6). Exported for order-loads.ts (Task 6),
 *  whose mutators need the same `readDetail` call orders.ts's own mutators do. */
export async function trafficSettings(): Promise<Traffic> {
  const [mayMissDays, willMissDays] = await Promise.all([
    getSetting("traffic_may_miss_days"),
    getSetting("traffic_will_miss_days"),
  ]);
  return { mayMissDays, willMissDays };
}

/** `parseDateOnly` at the service boundary — orders.ts's `parseDate`, per-service the way
 *  shippers.ts carries its own copy: the lib throws a plain `Error`, and a bad filter date must
 *  fail as a field-anchored 400 naming which one was wrong. */
function parseDate(value: string, field: string): Date {
  try {
    return parseDateOnly(value);
  } catch {
    throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${field}`);
  }
}

const BOARD_SELECT = {
  id: true, orderNumber: true, poNumber: true, vsOrderNumber: true,
  receivedDate: true, requestDate: true, targetDate: true, status: true,
  deletedAt: true, linkGroupId: true,
  customer: { select: { code: true, name: true } },
  lines: {
    orderBy: { position: "asc" },
    select: { position: true, qty: true, weight: true, part: { select: { partNumber: true } } },
  },
  _count: { select: { loads: true } },
} satisfies Prisma.OrderSelect;

/**
 * The columns the board can sort in SQL. `qty`, `weight`, `light` and `loadCount` are derived per
 * row rather than stored, so they are deliberately absent — asking for one is a 400 rather than a
 * board silently sorted by something else, which is the kind of quiet wrong answer this app
 * refuses to give.
 */
const SORTABLE: Record<string, (dir: Prisma.SortOrder) => Prisma.OrderOrderByWithRelationInput> = {
  orderNumber: (dir) => ({ orderNumber: dir }),
  customerCode: (dir) => ({ customer: { code: dir } }),
  customerName: (dir) => ({ customer: { name: dir } }),
  poNumber: (dir) => ({ poNumber: dir }),
  vsOrderNumber: (dir) => ({ vsOrderNumber: dir }),
  receivedDate: (dir) => ({ receivedDate: dir }),
  requestDate: (dir) => ({ requestDate: dir }),
  targetDate: (dir) => ({ targetDate: dir }),
  status: (dir) => ({ status: dir }),
};

function orderByFor(filter: OrderFilter): Prisma.OrderOrderByWithRelationInput[] {
  const key = filter.sort ?? "orderNumber";
  // Object.hasOwn, not a bare lookup: "constructor" and "toString" are inherited and truthy, and
  // calling one of those would hand Prisma something that is not an orderBy at all.
  if (!Object.hasOwn(SORTABLE, key)) throw new HttpError(400, `Cannot sort orders by "${key}"`);
  const dir: Prisma.SortOrder = filter.dir === "asc" ? "asc" : "desc";
  // orderNumber is unique, so it doubles as the tiebreaker for every other column — without it,
  // two orders sharing a request date come back in whatever order the planner picked that run.
  return key === "orderNumber" ? [{ orderNumber: dir }] : [SORTABLE[key](dir), { orderNumber: "desc" }];
}

function dateRange(
  from: string | undefined, to: string | undefined, fromField: string, toField: string,
): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: parseDate(from, fromField) } : {}),
    ...(to ? { lte: parseDate(to, toField) } : {}),
  };
}

function searchWhere(term: string): Prisma.OrderWhereInput[] {
  const clauses: Prisma.OrderWhereInput[] = [
    { poNumber: { contains: term, mode: "insensitive" } },
    { vsOrderNumber: { contains: term, mode: "insensitive" } },
    { customer: { code: { contains: term, mode: "insensitive" } } },
    { customer: { name: { contains: term, mode: "insensitive" } } },
    // The LEAD part only. A board row is labelled with its lead part, so matching a rider would
    // surface an order under a part number that appears nowhere in the list the operator is
    // looking at.
    { lines: { some: { position: 1, part: { partNumber: { contains: term, mode: "insensitive" } } } } },
  ];
  // orderNumber is an Int4 column: a longer digit string is not a value it can hold, and handing
  // it to Prisma is a validation error (a status-less 500), not "no match".
  const asNumber = Number(term);
  if (/^\d+$/.test(term) && Number.isSafeInteger(asNumber) && asNumber <= 2_147_483_647) {
    clauses.push({ orderNumber: asNumber });
  }
  return clauses;
}

function boardWhere(filter: OrderFilter): Prisma.OrderWhereInput {
  const term = filter.search?.trim();
  const received = dateRange(filter.receivedFrom, filter.receivedTo, "Received from", "Received to");
  const request = dateRange(filter.requestFrom, filter.requestTo, "Request from", "Request to");
  return {
    // Voided orders leave the board unless the toggle is on (spec §5c).
    ...(filter.includeVoided ? {} : { deletedAt: null }),
    ...(filter.status?.length ? { status: { in: filter.status } } : {}),
    ...(filter.customerId ? { customerId: filter.customerId } : {}),
    ...(received ? { receivedDate: received } : {}),
    ...(request ? { requestDate: request } : {}),
    ...(term ? { OR: searchWhere(term) } : {}),
  };
}

export async function listOrders(filter: OrderFilter): Promise<BoardRow[]> {
  // Both of these reject bad input before a query is issued.
  const orderBy = orderByFor(filter);
  const where = boardWhere(filter);

  const traffic = await trafficSettings();
  const today = todayDateOnly();
  const rows = await prisma.order.findMany({ where, select: BOARD_SELECT, orderBy });

  return rows.map((row) => {
    const cents = row.lines.reduce((sum, l) => sum + Math.round(l.weight.toNumber() * 100), 0);
    const lead = row.lines.find((l) => l.position === 1);
    return {
      id: row.id, orderNumber: row.orderNumber,
      customerCode: row.customer.code, customerName: row.customer.name,
      leadPartNumber: lead?.part.partNumber ?? "",
      poNumber: row.poNumber, vsOrderNumber: row.vsOrderNumber,
      qty: row.lines.reduce((sum, l) => sum + l.qty, 0),
      weight: cents / 100,
      receivedDate: formatDateOnly(row.receivedDate),
      requestDate: formatDateOnly(row.requestDate),
      targetDate: row.targetDate === null ? null : formatDateOnly(row.targetDate),
      status: row.status,
      voided: row.deletedAt !== null,
      light: computeLight(row.requestDate, today, traffic.mayMissDays, traffic.willMissDays),
      loadCount: row._count.loads,
      linked: row.linkGroupId !== null,
    };
  });
}

/** §11's board column order, with the customer split into its two cells and `voided` appended —
 *  it only carries information once the include-voided toggle is on, but it is a board column. */
const BOARD_COLUMNS = [
  { key: "orderNumber", header: "Order #" },
  { key: "customerCode", header: "Customer code" },
  { key: "customerName", header: "Customer name" },
  { key: "leadPartNumber", header: "Lead part" },
  { key: "poNumber", header: "PO" },
  { key: "qty", header: "Qty" },
  { key: "weight", header: "Weight" },
  { key: "receivedDate", header: "Received" },
  { key: "requestDate", header: "Request" },
  { key: "targetDate", header: "Target" },
  { key: "light", header: "Light" },
  { key: "status", header: "Status" },
  { key: "loadCount", header: "Loads" },
  { key: "linked", header: "Linked" },
  { key: "vsOrderNumber", header: "VS #" },
  { key: "voided", header: "Voided" },
];

/** Exactly what `listOrders` returned for the same filter — same query, same rows, humanized
 *  cells (the parts export precedent: booleans as yes/no, never a raw enum key). */
export async function exportOrders(filter: OrderFilter): Promise<Buffer> {
  const rows = await listOrders(filter);
  const xlsxRows = rows.map((r) => ({
    ...r,
    light: LIGHT_LABELS[r.light],
    linked: r.linked ? "yes" : "no",
    voided: r.voided ? "yes" : "no",
  }));
  return toXlsx("Orders", BOARD_COLUMNS, xlsxRows as unknown as Record<string, unknown>[]);
}
