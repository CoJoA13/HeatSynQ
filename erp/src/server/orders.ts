import { z } from "zod";
import { Prisma, type OrderStatus } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";
import { currentActor } from "./context";
import { toXlsx } from "./excel";
import { allocateNumber, getSetting } from "./settings";
import { lockCurrentRevision } from "./part-process-steps";
import { splitLoads } from "../lib/load-split";
import { addBusinessDays, formatDateOnly, parseDateOnly, todayDateOnly } from "../lib/business-days";
import { computeLight, LIGHT_LABELS, type TrafficLight } from "../lib/traffic-light";

export type OrderWarnings = string[];

export type OrderLineDetail = {
  id: string; position: number; partId: string; revisionNumber: number | null;
  qty: number; weight: number;
  part: { id: string; partNumber: string; name: string; customer: { code: string } };
};
export type OrderContainerDetail = {
  id: string; position: number; typeId: string; count: number; qty: number | null;
  tareWeight: number | null; grossWeight: number | null; type: { name: string };
};
export type OrderSerialDetail = {
  id: string; lineId: string; position: number; serial: string; description: string;
};
export type OrderLoadDetail = { id: string; loadNumber: number; qty: number | null; weight: number | null };
export type OrderChargeDetail = {
  id: string; position: number; description: string; amount: number | null;
};

export type OrderDetail = {
  id: string; orderNumber: number; customerId: string;
  poNumber: string; vsOrderNumber: string;
  receivedDate: string; requestDate: string; targetDate: string | null;
  status: OrderStatus; notes: string; linkGroupId: string | null;
  /** `deletedAt` is set. Voided orders are returned, not hidden — the hub renders them
   *  read-only, and the reason lives in the `auditedSoftDelete` entry (spec §5c). */
  voided: boolean;
  light: TrafficLight;
  /** Derived, never stored: any StoredDocument row for this order (spec §5b). */
  travelerPrinted: boolean;
  lines: OrderLineDetail[];
  containers: OrderContainerDetail[];
  serials: OrderSerialDetail[];
  loads: OrderLoadDetail[];
  charges: OrderChargeDetail[];
  linkedOrders: { id: string; orderNumber: number }[];
};

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

// Kept in sync with prisma/schema.prisma's @db.Decimal declarations on the order tables.
const LINE = z.object({
  partId: z.string().min(1),
  qty: z.number().int().min(1),
  weight: decimalField(12, 2, { required: true, min: "positive" }),
  serials: z.array(z.object({
    serial: z.string().trim().min(1).max(120),
    description: z.string().max(500).default(""),
  }).strict()).max(10_000).default([]),
}).strict();

const CREATE = z.object({
  customerId: z.string().min(1),
  poNumber: z.string().max(200).default(""),
  vsOrderNumber: z.string().max(60).default(""),
  receivedDate: z.string().optional(),
  requestDate: z.string().optional(),
  targetDate: z.string().nullable().optional(),
  notes: z.string().max(4000).default(""),
  lines: z.array(LINE).min(1),
  containers: z.array(z.object({
    typeId: z.string().min(1),
    count: z.number().int().min(1),
    qty: z.number().int().min(1).nullable().optional(),
    tareWeight: decimalField(12, 2, { min: "nonnegative" }),
    grossWeight: decimalField(12, 2, { min: "nonnegative" }),
  }).strict()).default([]),
  charges: z.array(z.object({
    description: z.string().trim().min(1).max(500),
    amount: decimalField(12, 2, { min: "nonnegative" }),
  }).strict()).default([]),
}).strict();

type CreateInput = z.infer<typeof CREATE>;
type LineInput = CreateInput["lines"][number];

// Either the top-level client or a `tx` — readDetail serves both getOrder and the tail of the
// save transaction (customer-addresses.ts's Db precedent).
type Db = Prisma.TransactionClient;

const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

/**
 * `parseDateOnly` at the service boundary. The lib throws a plain `Error` (it has no server
 * import), and every date that crosses the wire has to fail as a field-anchored 400 naming which
 * one was wrong — "Received date", not "invalid input".
 */
function parseDate(value: string, field: string): Date {
  try {
    return parseDateOnly(value);
  } catch {
    throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${field}`);
  }
}

/**
 * "Line 2 (ACME · 3541720C3)" — one label shape shared by every line-anchored rejection and
 * every warning, so the operator reads the same identifier in the refusal, in the warning banner
 * and on the saved order. Falls back to the bare position when the part could not be resolved at
 * all, which is the only case where there is nothing to name it with.
 */
function lineLabel(index: number, part?: { partNumber: string; customer: { code: string } }): string {
  return part ? `Line ${index + 1} (${part.customer.code} · ${part.partNumber})` : `Line ${index + 1}`;
}

const PART_SELECT = {
  id: true, partNumber: true, customerId: true, active: true,
  loadQty: true, loadWeight: true, requestDaysOverride: true, serializationRequired: true,
  customer: { select: { code: true } },
} as const;

type ResolvedPart = Prisma.PartGetPayload<{ select: typeof PART_SELECT }>;

/**
 * Resolves every line's part — live, active, and owned by the order's customer (spec §5.1). One
 * query for the distinct ids, then a walk in payload order so the FIRST bad line is the one
 * reported and the same part used twice is fetched once.
 *
 * Only `parts[0]`, the lead, goes on to the orderability check: riders are deliberately exempt
 * (spec §12.4) — the recipe an order is built from is the lead's.
 */
async function resolveLineParts(
  tx: Db, customerId: string, lines: LineInput[],
): Promise<ResolvedPart[]> {
  const ids = [...new Set(lines.map((l) => l.partId))];
  const found = await tx.part.findMany({ where: { id: { in: ids }, deletedAt: null }, select: PART_SELECT });
  const byId = new Map(found.map((p) => [p.id, p]));

  return lines.map((line, i) => {
    const part = byId.get(line.partId);
    if (!part) throw new HttpError(400, `${lineLabel(i)}: that part does not exist`);
    if (part.customerId !== customerId) {
      throw new HttpError(400, `${lineLabel(i, part)}: that part belongs to another customer`);
    }
    if (!part.active) throw new HttpError(400, `${lineLabel(i, part)}: that part is inactive`);
    return part;
  });
}

/**
 * Σqty and Σweight over the lines. The weight sum runs in integer cents: `decimalField(12, 2)`
 * has already bounded every line to two decimal places, so the cents are exact and the single
 * division back to pounds is the only floating step — load-split.ts's reasoning applied one
 * level up, and what keeps the split's own sums landing on the totals exactly.
 */
function lineTotals(lines: LineInput[]): { totalQty: number; totalWeight: number } {
  const totalQty = lines.reduce((sum, l) => sum + l.qty, 0);
  const cents = lines.reduce((sum, l) => sum + Math.round(l.weight * 100), 0);
  return { totalQty, totalWeight: cents / 100 };
}

/** Non-blocking notices returned alongside the saved order (spec §5.5). Neither of these ever
 *  refuses a save — credit hold warns and never blocks (owner ruling §3), and a missing serial
 *  list is something the operator finishes later. */
function buildWarnings(
  customer: { code: string; name: string; creditHold: boolean },
  parts: ResolvedPart[], lines: LineInput[],
): OrderWarnings {
  const warnings = lines.flatMap((line, i) =>
    parts[i].serializationRequired && line.serials.length === 0
      ? [`${lineLabel(i, parts[i])}: serialization required but no serials entered`]
      : []);
  if (customer.creditHold) warnings.push(`${customer.code} · ${customer.name} is on credit hold`);
  return warnings;
}

/**
 * Names the serial behind an `@@unique([lineId, serial])` violation. P2002 reports which COLUMNS
 * collided, never which VALUE did, and on a keyed-or-pasted serial list naming the value is the
 * entire point — so the payload is re-walked here, in entry order, to find the repeat the
 * database just refused. Only ever runs on the failure path, so the happy path pays nothing.
 */
function duplicateSerialError(lines: LineInput[], parts: ResolvedPart[]): HttpError {
  for (const [i, line] of lines.entries()) {
    const seen = new Set<string>();
    for (const { serial } of line.serials) {
      if (seen.has(serial)) {
        return new HttpError(400, `${lineLabel(i, parts[i])}: serial "${serial}" is entered twice`);
      }
      seen.add(serial);
    }
  }
  return new HttpError(400, "That serial is already on this line");
}

/** Serials hang off lines, so they cannot be part of the order's nested create — they are
 *  written once the line ids exist, keyed by the line's position in the payload. */
async function createSerials(
  tx: Db, orderId: string, lineIds: string[], lines: LineInput[], parts: ResolvedPart[],
): Promise<void> {
  const rows = lines.flatMap((line, i) => line.serials.map((s, index) => ({
    orderId, lineId: lineIds[i], position: index + 1, serial: s.serial, description: s.description,
  })));
  if (rows.length === 0) return;
  try {
    await tx.orderSerial.createMany({ data: rows });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw duplicateSerialError(lines, parts);
    }
    throw err;
  }
}

/**
 * The create entry's `after` snapshot. Composed by hand rather than read back — `auditedCreate`
 * takes the payload as an argument, which is the chance to shape it: every collection is ordered
 * by construction (issue #24 — an unordered collection makes two identical snapshots render as a
 * spurious diff), each foreign key travels with the live name it points at so history reads
 * "3541720C3" and "Basket" rather than cuids (the rule `SNAPSHOT_INCLUDE.order` follows for
 * update diffs), and nothing file-shaped comes anywhere near it.
 *
 * Row ids are absent because they do not exist yet; serials are keyed by their line's POSITION
 * for the same reason, which also happens to read better than a cuid would.
 */
function auditPayload(args: {
  orderNumber: number;
  customer: { id: string; code: string };
  data: CreateInput;
  parts: ResolvedPart[];
  receivedDate: Date; requestDate: Date; targetDate: Date | null;
  revisionNumber: number;
  loads: { qty: number; weight: number }[];
  containerTypeNames: Map<string, string>;
}) {
  const { orderNumber, customer, data, parts, loads, containerTypeNames } = args;
  return {
    orderNumber,
    customerId: customer.id, customerCode: customer.code,
    poNumber: data.poNumber, vsOrderNumber: data.vsOrderNumber,
    receivedDate: formatDateOnly(args.receivedDate),
    requestDate: formatDateOnly(args.requestDate),
    targetDate: args.targetDate === null ? null : formatDateOnly(args.targetDate),
    // Not written by createOrder — the column default, recorded so the create entry and every
    // later update diff describe the same set of fields.
    status: "OPEN",
    notes: data.notes,
    lines: data.lines.map((line, i) => ({
      position: i + 1, partId: line.partId, partNumber: parts[i].partNumber,
      revisionNumber: i === 0 ? args.revisionNumber : null, qty: line.qty, weight: line.weight,
    })),
    containers: data.containers.map((c, i) => ({
      position: i + 1, typeId: c.typeId, typeName: containerTypeNames.get(c.typeId) ?? null,
      count: c.count, qty: c.qty ?? null,
      tareWeight: c.tareWeight ?? null, grossWeight: c.grossWeight ?? null,
    })),
    serials: data.lines.flatMap((line, i) => line.serials.map((s, index) => ({
      linePosition: i + 1, position: index + 1, serial: s.serial, description: s.description,
    }))),
    loads: loads.map((l, i) => ({ loadNumber: i + 1, qty: l.qty, weight: l.weight })),
    charges: data.charges.map((c, i) => ({
      position: i + 1, description: c.description, amount: c.amount ?? null,
    })),
  };
}

const DETAIL_INCLUDE = {
  lines: {
    orderBy: { position: "asc" },
    include: {
      part: { select: { id: true, partNumber: true, name: true, customer: { select: { code: true } } } },
    },
  },
  containers: { orderBy: { position: "asc" }, include: { type: { select: { name: true } } } },
  serials: { orderBy: [{ line: { position: "asc" } }, { position: "asc" }] },
  loads: { orderBy: { loadNumber: "asc" } },
  charges: { orderBy: { position: "asc" } },
  // Existence only — the bytes are never read here, and `travelerPrinted` is the one thing the
  // hub needs from them.
  documents: { select: { id: true }, take: 1 },
} satisfies Prisma.OrderInclude;

type DetailRow = Prisma.OrderGetPayload<{ include: typeof DETAIL_INCLUDE }>;

type Traffic = { mayMissDays: number; willMissDays: number };

/** Both windows in ONE pair of reads per call — the board computes a light for every row and
 *  must not fan a settings query out across them (spec §6). */
async function trafficSettings(): Promise<Traffic> {
  const [mayMissDays, willMissDays] = await Promise.all([
    getSetting("traffic_may_miss_days"),
    getSetting("traffic_will_miss_days"),
  ]);
  return { mayMissDays, willMissDays };
}

function toDetail(
  row: DetailRow, linkedOrders: { id: string; orderNumber: number }[], traffic: Traffic,
): OrderDetail {
  return {
    id: row.id, orderNumber: row.orderNumber, customerId: row.customerId,
    poNumber: row.poNumber, vsOrderNumber: row.vsOrderNumber,
    receivedDate: formatDateOnly(row.receivedDate),
    requestDate: formatDateOnly(row.requestDate),
    targetDate: row.targetDate === null ? null : formatDateOnly(row.targetDate),
    status: row.status, notes: row.notes, linkGroupId: row.linkGroupId,
    voided: row.deletedAt !== null,
    light: computeLight(row.requestDate, todayDateOnly(), traffic.mayMissDays, traffic.willMissDays),
    travelerPrinted: row.documents.length > 0,
    lines: row.lines.map((l) => ({
      id: l.id, position: l.position, partId: l.partId, revisionNumber: l.revisionNumber,
      qty: l.qty, weight: l.weight.toNumber(), part: l.part,
    })),
    containers: row.containers.map((c) => ({
      id: c.id, position: c.position, typeId: c.typeId, count: c.count, qty: c.qty,
      tareWeight: num(c.tareWeight), grossWeight: num(c.grossWeight), type: c.type,
    })),
    serials: row.serials.map((s) => ({
      id: s.id, lineId: s.lineId, position: s.position, serial: s.serial, description: s.description,
    })),
    loads: row.loads.map((l) => ({
      id: l.id, loadNumber: l.loadNumber, qty: l.qty, weight: num(l.weight),
    })),
    charges: row.charges.map((c) => ({
      id: c.id, position: c.position, description: c.description, amount: num(c.amount),
    })),
    linkedOrders,
  };
}

/**
 * Deliberately NOT filtered on `deletedAt`: a voided order is still readable (spec §5c) — the
 * hub renders it read-only rather than pretending it never existed. Linked siblings are listed
 * the same way, voided or not; a group member that has been voided is exactly the kind of thing
 * the panel exists to show.
 */
async function readDetail(db: Db, id: string, traffic: Traffic): Promise<OrderDetail> {
  const row = await db.order.findFirst({ where: { id }, include: DETAIL_INCLUDE });
  if (!row) throw new HttpError(404, "Order not found");
  const linkedOrders = row.linkGroupId
    ? await db.order.findMany({
      where: { linkGroupId: row.linkGroupId, id: { not: id } },
      select: { id: true, orderNumber: true },
      orderBy: { orderNumber: "asc" },
    })
    : [];
  return toDetail(row, linkedOrders, traffic);
}

/**
 * The order save (spec §5). One `withDbErrors` → Serializable `$transaction`, in this order:
 * validate → allocate → lock → assert container types → split → write → clear the draft.
 *
 * Serializable is required by the registered-FK writer pattern for `containers[].typeId`
 * (`assertRefExists` on the caller's own `tx` is only half of the reference-delete TOCTOU
 * guard — the other half is deleteReference's Serializable blocker scan). It is emphatically NOT
 * what protects the locked revision: `lockCurrentRevision`'s `SELECT … FOR UPDATE` row lock is
 * the guarantee (spec §5.3), and this transaction's isolation level is irrelevant to it.
 *
 * A serialization failure — two saves colliding on the number sequence or on the same part's
 * revision — surfaces as the retryable 409 `withDbErrors` already maps 40001 to. Nothing is
 * written, and no order number is consumed.
 */
export async function createOrder(input: unknown): Promise<{ order: OrderDetail; warnings: OrderWarnings }> {
  const data = CREATE.parse(input);

  // Settings are read-only and take no `tx`. Reading them BEFORE the transaction opens keeps a
  // second-connection read out of a Serializable transaction that goes on to lock a Setting row
  // itself (allocateNumber) — the shape a deadlock gets introduced through later.
  const defaultRequestDays = await getSetting("request_days_default");
  const traffic = await trafficSettings();

  return withDbErrors({ entity: "Order", conflictField: "order number" }, () =>
    prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: data.customerId, deletedAt: null } });
      if (!customer) throw new HttpError(400, "That customer does not exist");
      if (!customer.active) throw new HttpError(400, "That customer is inactive");

      const parts = await resolveLineParts(tx, customer.id, data.lines);
      const lead = parts[0];

      const receivedDate = data.receivedDate
        ? parseDate(data.receivedDate, "Received date")
        : todayDateOnly();
      // Most-specific-wins and silent (spec §6): the LEAD part's override, else the customer's,
      // else the plant default — never a rider's.
      const requestDate = data.requestDate
        ? parseDate(data.requestDate, "Request date")
        : addBusinessDays(receivedDate,
          lead.requestDaysOverride ?? customer.requestDaysOverride ?? defaultRequestDays);
      const targetDate = data.targetDate ? parseDate(data.targetDate, "Target date") : null;

      const orderNumber = await allocateNumber("order_number_next", tx);
      const { revisionNumber } = await lockCurrentRevision(lead.id, tx); // the row lock IS the guarantee

      // Two reads per distinct type, deliberately. `assertRefExists` is the mandated writer-side
      // half of the reference-delete TOCTOU guard and returns nothing; the names are for the
      // audit payload, which must read "Basket" rather than a cuid. No `deletedAt` filter on the
      // second read — the assert above has already refused every id that is not live.
      const typeIds = [...new Set(data.containers.map((c) => c.typeId))];
      for (const typeId of typeIds) await assertRefExists("containerType", typeId, tx);
      const containerTypeNames = new Map(typeIds.length === 0 ? [] :
        (await tx.containerType.findMany({ where: { id: { in: typeIds } }, select: { id: true, name: true } }))
          .map((t) => [t.id, t.name] as const));

      // The lead part's caps, passed straight through — splitLoads trusts pre-validated input
      // (a zero loadQty would not terminate), and parts.ts already enforces loadQty ≥ 1 and
      // loadWeight > 0 when present, so nothing is synthesized here.
      const loads = splitLoads({
        ...lineTotals(data.lines),
        loadQty: lead.loadQty,
        loadWeight: lead.loadWeight === null ? null : lead.loadWeight.toNumber(),
      });

      const order = await auditedCreate(
        "order",
        auditPayload({
          orderNumber, customer, data, parts, receivedDate, requestDate, targetDate,
          revisionNumber, loads, containerTypeNames,
        }),
        () => tx.order.create({
          data: {
            orderNumber, customerId: customer.id,
            poNumber: data.poNumber, vsOrderNumber: data.vsOrderNumber,
            receivedDate, requestDate, targetDate, notes: data.notes,
            lines: {
              create: data.lines.map((line, i) => ({
                position: i + 1, partId: line.partId,
                // Non-null on position 1 and nowhere else — the order's locked recipe is the
                // pair (lines[0].partId, lines[0].revisionNumber). Spec §4.
                revisionNumber: i === 0 ? revisionNumber : null,
                qty: line.qty, weight: line.weight,
              })),
            },
            containers: {
              create: data.containers.map((c, i) => ({
                position: i + 1, typeId: c.typeId, count: c.count, qty: c.qty ?? null,
                tareWeight: c.tareWeight ?? null, grossWeight: c.grossWeight ?? null,
              })),
            },
            loads: { create: loads.map((l, i) => ({ loadNumber: i + 1, qty: l.qty, weight: l.weight })) },
            charges: {
              create: data.charges.map((c, i) => ({
                position: i + 1, description: c.description, amount: c.amount ?? null,
              })),
            },
          },
          select: { id: true, lines: { select: { id: true }, orderBy: { position: "asc" } } },
        }),
        { tx },
      );

      await createSerials(tx, order.id, order.lines.map((l) => l.id), data.lines, parts);

      // Same transaction as the save (spec §5.5): the scratch draft dies exactly when the order
      // it became is committed, and survives untouched if anything above rolled back.
      const actor = currentActor();
      if (actor.id) {
        await tx.orderDraft.updateMany({ where: { userId: actor.id }, data: { payload: Prisma.DbNull } });
      }

      return {
        order: await readDetail(tx, order.id, traffic),
        warnings: buildWarnings(customer, parts, data.lines),
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export async function getOrder(id: string): Promise<OrderDetail> {
  return readDetail(prisma, id, await trafficSettings());
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
