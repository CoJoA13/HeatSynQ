import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { can } from "./permissions";
import type { SessionUser } from "./sessions";

export type SearchResults = {
  exactOrderId: string | null;
  orders: { id: string; orderNumber: number; customerCode: string; poNumber: string; leadPartNumber: string }[];
  parts: { id: string; partNumber: string; customerCode: string; name: string }[];
  customers: { id: string; code: string; name: string }[];
};

/** Every group's cap, brief: "≤10 rows per group, ordered by recency". */
const MAX_ROWS = 10;

/**
 * `Order.orderNumber` is a plain Int4 column (schema.prisma) — a digit string wider than that is
 * not "no match", it is a value Prisma refuses to serialize at all (a validation error, not an
 * empty result). Mirrors the guard `searchWhere` uses for the board in orders.ts:
 * `Number.isSafeInteger` first, since a long digit string can parse past a safe integer (or even
 * to `Infinity`) before the range check would otherwise catch it.
 */
function parsedOrderNumber(term: string): number | null {
  if (!/^\d+$/.test(term)) return null;
  const n = Number(term);
  return Number.isSafeInteger(n) && n <= 2_147_483_647 ? n : null;
}

/**
 * The digit-only short-circuit (task-8-brief: "input is all digits AND matches a live order's
 * number"). Deliberately NOT gated on `orders.view`, unlike the `orders` group below — the brief
 * states its two conditions (digits, live order) with no permission clause, and
 * phase-3-orders-design.md §8 (Services) lists it as a capability distinct from the
 * permission-filtered groups: "grouped global search ..., permission-filtered per group,
 * exact-order-number short-circuit" — two clauses, not one. An order NUMBER is also the barcode
 * payload printed on every traveler (the approved spec §4: "scanning it into the global search
 * opens the order"; §6: "traveler barcode scans land here and open the order directly") —
 * confirming a bare number is live is not the same disclosure as the `orders` group's
 * PO/VS#/customer-bearing rows. The Shell's landing on `/orders/[id]` still goes through that
 * route's own `requireUser` + `mustCan`, which is the real gate on the order's contents
 * (CLAUDE.md: "Real authorization is `requireUser` + `mustCan` in every route").
 */
async function findExactOrderId(term: string): Promise<string | null> {
  const orderNumber = parsedOrderNumber(term);
  if (orderNumber === null) return null;
  const row = await prisma.order.findFirst({ where: { orderNumber, deletedAt: null }, select: { id: true } });
  return row?.id ?? null;
}

/**
 * Number / PO / VS# / serial / lead-part-number. Mirrors `searchWhere`'s (orders.ts) Int4
 * overflow guard, but deliberately does NOT also match on customer code/name the way that
 * board-search where-clause does — the `customers` group below already covers that surface, and
 * letting every group cascade through the customer relation would just triple up the same hits
 * across all three groups. Voided orders excluded (`deletedAt: null`, global-constraints: voided
 * orders are excluded everywhere in this service). Only the LEAD (position 1) line's part number
 * counts — same reasoning as the board: a rider match would surface an order under a part number
 * that appears nowhere in the row shown for it.
 */
async function searchOrders(term: string): Promise<SearchResults["orders"]> {
  const clauses: Prisma.OrderWhereInput[] = [
    { poNumber: { contains: term, mode: "insensitive" } },
    { vsOrderNumber: { contains: term, mode: "insensitive" } },
    { serials: { some: { serial: { contains: term, mode: "insensitive" } } } },
    { lines: { some: { position: 1, part: { partNumber: { contains: term, mode: "insensitive" } } } } },
  ];
  const orderNumber = parsedOrderNumber(term);
  if (orderNumber !== null) clauses.push({ orderNumber });

  const rows = await prisma.order.findMany({
    where: { deletedAt: null, OR: clauses },
    select: {
      id: true, orderNumber: true, poNumber: true,
      customer: { select: { code: true } },
      lines: { where: { position: 1 }, select: { part: { select: { partNumber: true } } }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS,
  });
  return rows.map((r) => ({
    id: r.id, orderNumber: r.orderNumber, customerCode: r.customer.code,
    poNumber: r.poNumber, leadPartNumber: r.lines[0]?.part.partNumber ?? "",
  }));
}

/**
 * partNumber or name, case-insensitive. Soft-deleted parts excluded; inactive ones are NOT — this
 * is a lookup surface (find the record), not `listParts`'s picker (choose a record to assign),
 * so there is no reason to hide it the way the picker does by default. Per-customer duplicate
 * part numbers both come back, each carrying its own customer code (Phase 2 kickoff §2 / spec
 * §15 heritage: "a part number alone must never identify a part").
 */
async function searchParts(term: string): Promise<SearchResults["parts"]> {
  const rows = await prisma.part.findMany({
    where: {
      deletedAt: null,
      OR: [
        { partNumber: { contains: term, mode: "insensitive" } },
        { name: { contains: term, mode: "insensitive" } },
      ],
    },
    select: { id: true, partNumber: true, name: true, customer: { select: { code: true } } },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS,
  });
  return rows.map((r) => ({ id: r.id, partNumber: r.partNumber, customerCode: r.customer.code, name: r.name }));
}

/** code or name, case-insensitive. Soft-deleted customers excluded, inactive ones not — same
 *  lookup-vs-picker reasoning as `searchParts`. */
async function searchCustomers(term: string): Promise<SearchResults["customers"]> {
  return prisma.customer.findMany({
    where: {
      deletedAt: null,
      OR: [
        { code: { contains: term, mode: "insensitive" } },
        { name: { contains: term, mode: "insensitive" } },
      ],
    },
    select: { id: true, code: true, name: true },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS,
  });
}

/**
 * Grouped global search (the approved spec §6: "Global search box on every screen"; Phase 3
 * design phase-3-orders-design.md §1/§8/§11). Purely read-only: no transaction, no audit trail,
 * plain prisma queries (task-8-brief). Each group is independently permission-filtered: a caller
 * lacking `{area}.view` gets an EMPTY array for that group — never omitted from the object, never
 * a 403, so the Shell dropdown can render whatever it is given without every caller special-casing
 * a missing key. `exactOrderId` fills alongside the groups unconditionally; see
 * `findExactOrderId`'s comment for why it is not itself permission-gated.
 *
 * `q.trim()` shorter than 1 character means "nothing to search": every group empty, no exact
 * match — never the first `MAX_ROWS` rows of everything.
 */
export async function globalSearch(user: SessionUser, q: string): Promise<SearchResults> {
  const term = q.trim();
  if (term.length < 1) return { exactOrderId: null, orders: [], parts: [], customers: [] };

  const [exactOrderId, orders, parts, customers] = await Promise.all([
    findExactOrderId(term),
    can(user, "orders", "view") ? searchOrders(term) : Promise.resolve([]),
    can(user, "parts", "view") ? searchParts(term) : Promise.resolve([]),
    can(user, "customers", "view") ? searchCustomers(term) : Promise.resolve([]),
  ]);

  return { exactOrderId, orders, parts, customers };
}
