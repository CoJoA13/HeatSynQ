import { z } from "zod";
import { Prisma, type OrderStatus } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
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
//
// Item shapes shared with Task 5's bulk-replace mutators below (replaceContainers/replaceSerials/
// replaceCharges each accept `z.array(<ITEM>)` directly — same validation as a line's nested
// array here, just without an outer CREATE envelope) — extracted once so both paths stay in sync
// by construction rather than by two hand-kept-identical literals.
const SERIAL_ITEM = z.object({
  serial: z.string().trim().min(1).max(120),
  description: z.string().max(500).default(""),
}).strict();

const CONTAINER_ITEM = z.object({
  typeId: z.string().min(1),
  count: z.number().int().min(1),
  qty: z.number().int().min(1).nullable().optional(),
  tareWeight: decimalField(12, 2, { min: "nonnegative" }),
  grossWeight: decimalField(12, 2, { min: "nonnegative" }),
}).strict();

const CHARGE_ITEM = z.object({
  description: z.string().trim().min(1).max(500),
  amount: decimalField(12, 2, { min: "nonnegative" }),
}).strict();

const LINE = z.object({
  partId: z.string().min(1),
  qty: z.number().int().min(1),
  weight: decimalField(12, 2, { required: true, min: "positive" }),
  serials: z.array(SERIAL_ITEM).max(10_000).default([]),
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
  containers: z.array(CONTAINER_ITEM).default([]),
  charges: z.array(CHARGE_ITEM).default([]),
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
 * Only `parts[0]`, the lead, goes on to the orderability check when called from createOrder:
 * riders are deliberately exempt (spec §12.4) — the recipe an order is built from is the lead's.
 *
 * `base` (default 0, `lineLabel`'s own indexing) lets `addLine` (Task 5) reuse this exact
 * validation for its one new rider without mislabeling it: a bare 1-element array would otherwise
 * always read "Line 1" in a rejection, even when the rider lands at position 4 — `base` is that
 * line's real `position - 1`, so the label names the part actually being rejected.
 */
async function resolveLineParts(
  tx: Db, customerId: string, lines: LineInput[], base = 0,
): Promise<ResolvedPart[]> {
  const ids = [...new Set(lines.map((l) => l.partId))];
  const found = await tx.part.findMany({ where: { id: { in: ids }, deletedAt: null }, select: PART_SELECT });
  const byId = new Map(found.map((p) => [p.id, p]));

  return lines.map((line, i) => {
    const part = byId.get(line.partId);
    if (!part) throw new HttpError(400, `${lineLabel(base + i)}: that part does not exist`);
    if (part.customerId !== customerId) {
      throw new HttpError(400, `${lineLabel(base + i, part)}: that part belongs to another customer`);
    }
    if (!part.active) throw new HttpError(400, `${lineLabel(base + i, part)}: that part is inactive`);
    return part;
  });
}

/**
 * Σqty and Σweight over the lines. The weight sum runs in integer cents: `decimalField(12, 2)`
 * has already bounded every line to two decimal places, so the cents are exact and the single
 * division back to pounds is the only floating step — load-split.ts's reasoning applied one
 * level up, and what keeps the split's own sums landing on the totals exactly.
 *
 * Typed structurally (`{ qty; weight }[]`, not `LineInput[]`) and exported so Task 6's
 * `resplitLoads` (order-loads.ts) can reuse the exact cents-sum technique against a PERSISTED
 * order's lines (mapped to plain numbers first — Prisma returns `weight` as a `Decimal` off a raw
 * select) rather than re-deriving it — every existing call site already satisfies the narrower
 * shape, so this is a widening, not a breaking change.
 */
export function lineTotals(lines: { qty: number; weight: number }[]): { totalQty: number; totalWeight: number } {
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
 *
 * `base` (default 0) is `resolveLineParts`'s same label-offset, forwarded from `createSerials` so
 * `addLine`'s one new rider is named by its real position too.
 */
function duplicateSerialError(lines: LineInput[], parts: ResolvedPart[], base = 0): HttpError {
  for (const [i, line] of lines.entries()) {
    const seen = new Set<string>();
    for (const { serial } of line.serials) {
      if (seen.has(serial)) {
        return new HttpError(400, `${lineLabel(base + i, parts[i])}: serial "${serial}" is entered twice`);
      }
      seen.add(serial);
    }
  }
  return new HttpError(400, "That serial is already on this line");
}

/** Serials hang off lines, so they cannot be part of the order's nested create — they are
 *  written once the line ids exist, keyed by the line's position in the payload. `base` (default
 *  0) is forwarded to `duplicateSerialError` — see `resolveLineParts`'s comment on it. */
async function createSerials(
  tx: Db, orderId: string, lineIds: string[], lines: LineInput[], parts: ResolvedPart[], base = 0,
): Promise<void> {
  const rows = lines.flatMap((line, i) => line.serials.map((s, index) => ({
    orderId, lineId: lineIds[i], position: index + 1, serial: s.serial, description: s.description,
  })));
  if (rows.length === 0) return;
  try {
    await tx.orderSerial.createMany({ data: rows });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw duplicateSerialError(lines, parts, base);
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
 *  must not fan a settings query out across them (spec §6). Exported for order-loads.ts (Task 6),
 *  whose mutators need the same `readDetail` call this file's own mutators do. */
export async function trafficSettings(): Promise<Traffic> {
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
 *
 * Exported for order-loads.ts (Task 6): its mutators end every write the same way every mutator
 * in THIS file does — read the fresh detail back inside the same `tx` — and re-deriving that read
 * would just be a second, easy-to-drift copy of `DETAIL_INCLUDE`/`toDetail`.
 */
export async function readDetail(db: Db, id: string, traffic: Traffic): Promise<OrderDetail> {
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

/**
 * The §6 chain (`part.requestDaysOverride ?? customer.requestDaysOverride ??
 * request_days_default`) applied to a base date, for `GET /api/orders/entry-defaults` — the
 * entry page's prefill preview before an order exists at all. `createOrder` runs this identical
 * chain inline against the order's own (possibly backdated) `receivedDate`; `receivedDate` here
 * is that SAME optional override, so the preview and the eventual save agree — omitted (or
 * blank), this falls back to `todayDateOnly()`, the identical default `createOrder` itself uses
 * when `receivedDate` is omitted (spec §5.1), since a fresh, not-yet-backdated order is, by
 * construction, received today.
 *
 * Fix-wave finding 1: before `receivedDate` existed here, the preview always computed from today
 * even after the operator backdated the received date on the entry form, so an order saved with
 * an overridden `receivedDate` could show a request date at save time that never matched what
 * the preview showed moments before. Passing the same override through closes that gap.
 *
 * Existence-checked (a bogus id must 400, not crash reading `.requestDaysOverride` off `null`)
 * and cross-checked when both ids are given (a part from another customer would silently preview
 * a number that could never be saved), but deliberately NOT active-checked: this is a preview,
 * never a commitment, and `createOrder` is what actually refuses to save against an inactive
 * customer or part.
 */
export async function defaultRequestDate(customerId: string, partId?: string, receivedDate?: string): Promise<string> {
  if (!customerId) throw new HttpError(400, "customerId is required");

  const customer = await prisma.customer.findFirst({
    where: { id: customerId, deletedAt: null }, select: { requestDaysOverride: true },
  });
  if (!customer) throw new HttpError(400, "That customer does not exist");

  let partOverride: number | null = null;
  if (partId) {
    const part = await prisma.part.findFirst({
      where: { id: partId, deletedAt: null }, select: { customerId: true, requestDaysOverride: true },
    });
    if (!part) throw new HttpError(400, "That part does not exist");
    if (part.customerId !== customerId) throw new HttpError(400, "That part belongs to another customer");
    partOverride = part.requestDaysOverride;
  }

  const defaultRequestDays = await getSetting("request_days_default");
  const days = partOverride ?? customer.requestDaysOverride ?? defaultRequestDays;
  const base = receivedDate ? parseDate(receivedDate, "Received date") : todayDateOnly();
  return formatDateOnly(addBusinessDays(base, days));
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

// -------------------------------------------------------------------------------------------
// Edits, void, and linked orders (Task 5, spec §5a/§5c/§5d). Every mutator below shares one
// shape: `withDbErrors` wraps a Serializable `$transaction` (uniform with createOrder's own, even
// where nothing here assigns a registered FK — global-constraints: "the whole order save runs
// Serializable for uniformity") that resolves the order with `findFirst({ id, deletedAt: null })`
// — 404 "Order not found" catches both an unknown id and a voided one, since a voided order is
// read-only (spec §5a/§5c) — then writes through `auditedUpdate("order", id, ...)` so history
// carries a real before/after diff on the order's own row. `SNAPSHOT_INCLUDE.order` (audit.ts)
// already pulls every child collection, ordered, so no mutator here hand-builds a snapshot the
// way createOrder's `auditPayload` does for the create entry — the automatic one is enough.
// -------------------------------------------------------------------------------------------

const UPDATE_ORDER = z.object({
  poNumber: z.string().max(200).optional(),
  vsOrderNumber: z.string().max(60).optional(),
  receivedDate: z.string().optional(),
  requestDate: z.string().optional(),
  targetDate: z.string().nullable().optional(),
  notes: z.string().max(4000).optional(),
}).strict();

// qty/weight only — partId and revisionNumber have no key in this shape at all, so `.strict()`
// itself is the immutability guard (spec §5a: "Customer and lead part/revision are immutable").
const UPDATE_LINE = z.object({
  qty: z.number().int().min(1).optional(),
  weight: decimalField(12, 2, { required: true, min: "positive" }).optional(),
}).strict();

const REPLACE_CONTAINERS = z.array(CONTAINER_ITEM);
const REPLACE_SERIALS = z.array(SERIAL_ITEM).max(10_000);
const REPLACE_CHARGES = z.array(CHARGE_ITEM);

/**
 * Recomputed from the order's CURRENT state, not from what a particular edit changed — so any
 * mutator whose signature carries `warnings` (updateOrder, addLine, updateLine) reports the true
 * relationship even when this call didn't touch qty/weight at all, and an edit that restores the
 * match reports `[]` again rather than remembering it once didn't (spec §5a/§5b). Compared in
 * cents, not the rounded-back-to-dollars quotient: two totals that both divide out to the same
 * float are only guaranteed equal when the integer cents behind them already are, so comparing
 * the cents directly (lineTotals' own technique, inlined here for the loads side too) sidesteps
 * any IEEE754 doubt entirely rather than trusting it.
 *
 * Exported for order-loads.ts (Task 6) — `replaceLoads`/`resplitLoads` report the identical
 * mismatch string on the identical condition, reused rather than retyped.
 */
export function loadsMismatchWarnings(order: OrderDetail): OrderWarnings {
  const lineQty = order.lines.reduce((sum, l) => sum + l.qty, 0);
  const lineCents = order.lines.reduce((sum, l) => sum + Math.round(l.weight * 100), 0);
  const loadQty = order.loads.reduce((sum, l) => sum + (l.qty ?? 0), 0);
  const loadCents = order.loads.reduce((sum, l) => sum + Math.round((l.weight ?? 0) * 100), 0);
  return lineQty === loadQty && lineCents === loadCents
    ? []
    : ["Loads no longer sum to the order — re-split or edit loads"];
}

/** PATCH of poNumber/vsOrderNumber/dates/notes — nothing else (spec §5a: customer and the lead
 *  part/revision are immutable; a wrong-part order is voided and re-keyed, not patched). Fields
 *  are all `.optional()` rather than `.default()`, so an omitted key is a true no-op; `targetDate`
 *  is `.nullable()` too, so an explicit `null` clears it, distinct from omitting the key. */
export async function updateOrder(
  id: string, input: unknown,
): Promise<{ order: OrderDetail; warnings: OrderWarnings }> {
  const data = UPDATE_ORDER.parse(input);
  const traffic = await trafficSettings();

  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const target = await tx.order.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!target) throw new HttpError(404, "Order not found");

    const patch: Prisma.OrderUpdateInput = {
      ...(data.poNumber !== undefined ? { poNumber: data.poNumber } : {}),
      ...(data.vsOrderNumber !== undefined ? { vsOrderNumber: data.vsOrderNumber } : {}),
      ...(data.receivedDate !== undefined ? { receivedDate: parseDate(data.receivedDate, "Received date") } : {}),
      ...(data.requestDate !== undefined ? { requestDate: parseDate(data.requestDate, "Request date") } : {}),
      ...(data.targetDate !== undefined
        ? { targetDate: data.targetDate === null ? null : parseDate(data.targetDate, "Target date") }
        : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
    };

    await auditedUpdate("order", id, () => tx.order.update({ where: { id }, data: patch }), { tx });

    const order = await readDetail(tx, id, traffic);
    return { order, warnings: loadsMismatchWarnings(order) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** Adds one rider at position max+1 (spec §5a) — never the lead; a fresh order's own lead comes
 *  only from createOrder. Validated exactly like every line createOrder resolves (live, active,
 *  owned by the order's customer) via the same `resolveLineParts` helper. */
export async function addLine(
  orderId: string, input: unknown,
): Promise<{ order: OrderDetail; warnings: OrderWarnings }> {
  const data = LINE.parse(input);
  const traffic = await trafficSettings();

  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId, deletedAt: null }, select: { id: true, customerId: true },
    });
    if (!order) throw new HttpError(404, "Order not found");

    const { _max } = await tx.orderLine.aggregate({ where: { orderId }, _max: { position: true } });
    const position = (_max.position ?? 0) + 1;
    const [part] = await resolveLineParts(tx, order.customerId, [data], position - 1);

    await auditedUpdate("order", orderId, async () => {
      const line = await tx.orderLine.create({
        data: {
          orderId, position, partId: data.partId, revisionNumber: null, qty: data.qty, weight: data.weight,
        },
      });
      await createSerials(tx, orderId, [line.id], [data], [part], position - 1);
    }, { tx });

    const detail = await readDetail(tx, orderId, traffic);
    return { order: detail, warnings: loadsMismatchWarnings(detail) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** qty/weight only (spec §5a) — works on any line, lead included, but `UPDATE_LINE`'s shape has
 *  no `partId`/`revisionNumber` key at all, so those stay immutable by construction. */
export async function updateLine(
  orderId: string, lineId: string, input: unknown,
): Promise<{ order: OrderDetail; warnings: OrderWarnings }> {
  const data = UPDATE_LINE.parse(input);
  const traffic = await trafficSettings();

  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({ where: { id: orderId, deletedAt: null }, select: { id: true } });
    if (!order) throw new HttpError(404, "Order not found");

    const line = await tx.orderLine.findFirst({ where: { id: lineId, orderId }, select: { id: true } });
    if (!line) throw new HttpError(404, "Order line not found");

    const patch: Prisma.OrderLineUpdateInput = {
      ...(data.qty !== undefined ? { qty: data.qty } : {}),
      ...(data.weight !== undefined ? { weight: data.weight } : {}),
    };

    await auditedUpdate("order", orderId, () => tx.orderLine.update({ where: { id: lineId }, data: patch }), { tx });

    const detail = await readDetail(tx, orderId, traffic);
    return { order: detail, warnings: loadsMismatchWarnings(detail) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** Position 1 (the lead) refuses outright — spec §5a: a wrong-part order is voided and re-keyed,
 *  never edited down to its lead. Any rider closes the position gap it leaves behind: per-row
 *  updates in ascending position order, each shift vacating the slot the next update needs — the
 *  `removeStep` precedent (part-process-steps.ts), against `@@unique([orderId, position])`. */
export async function removeLine(orderId: string, lineId: string): Promise<OrderDetail> {
  const traffic = await trafficSettings();

  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({ where: { id: orderId, deletedAt: null }, select: { id: true } });
    if (!order) throw new HttpError(404, "Order not found");

    const line = await tx.orderLine.findFirst({
      where: { id: lineId, orderId }, select: { id: true, position: true },
    });
    if (!line) throw new HttpError(404, "Order line not found");
    if (line.position === 1) {
      throw new HttpError(400, "The lead part cannot be removed — void the order instead");
    }

    await auditedUpdate("order", orderId, async () => {
      // OrderSerial -> OrderLine is ON DELETE RESTRICT (migration.sql) — its rows have no meaning
      // once the line is gone, so they go first, in the same transaction.
      await tx.orderSerial.deleteMany({ where: { lineId } });
      await tx.orderLine.delete({ where: { id: lineId } });
      const rest = await tx.orderLine.findMany({
        where: { orderId, position: { gt: line.position } },
        orderBy: { position: "asc" },
      });
      for (const l of rest) {
        await tx.orderLine.update({ where: { id: l.id }, data: { position: l.position - 1 } });
      }
    }, { tx });

    return readDetail(tx, orderId, traffic);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** Bulk PUT of the order's containers: delete-then-recreate at positions 1..n (spec §5a), one
 *  `assertRefExists("containerType", …)` per DISTINCT incoming typeId, on this transaction's own
 *  `tx` — the writer-side half of the reference-delete TOCTOU (reference-guards.ts's doc comment),
 *  the same registered-FK pattern createOrder itself already runs for `containers[].typeId`. */
export async function replaceContainers(orderId: string, input: unknown): Promise<OrderDetail> {
  const data = REPLACE_CONTAINERS.parse(input);
  const traffic = await trafficSettings();

  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({ where: { id: orderId, deletedAt: null }, select: { id: true } });
    if (!order) throw new HttpError(404, "Order not found");

    const typeIds = [...new Set(data.map((c) => c.typeId))];
    for (const typeId of typeIds) await assertRefExists("containerType", typeId, tx);

    await auditedUpdate("order", orderId, async () => {
      await tx.orderContainer.deleteMany({ where: { orderId } });
      if (data.length > 0) {
        await tx.orderContainer.createMany({
          data: data.map((c, i) => ({
            orderId, position: i + 1, typeId: c.typeId, count: c.count, qty: c.qty ?? null,
            tareWeight: c.tareWeight ?? null, grossWeight: c.grossWeight ?? null,
          })),
        });
      }
    }, { tx });

    return readDetail(tx, orderId, traffic);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** Bulk PUT of ONE line's serials: delete-then-recreate at positions 1..n (spec §5a). In-payload
 *  duplicates are named and refused before the transaction even opens — the `duplicateSerialError`
 *  shape, scoped to just this line's own replacement set (no part/customer label needed: the
 *  caller already named the line via `lineId`). The `@@unique([lineId, serial])` P2002 mapping
 *  below is the fallback for a value that collides for a reason the in-payload scan cannot see
 *  (e.g. a genuine race with another write to this same line). */
export async function replaceSerials(orderId: string, lineId: string, input: unknown): Promise<OrderDetail> {
  const data = REPLACE_SERIALS.parse(input);

  const seen = new Set<string>();
  for (const { serial } of data) {
    if (seen.has(serial)) throw new HttpError(400, `Serial "${serial}" is entered twice`);
    seen.add(serial);
  }

  const traffic = await trafficSettings();
  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({ where: { id: orderId, deletedAt: null }, select: { id: true } });
    if (!order) throw new HttpError(404, "Order not found");

    const line = await tx.orderLine.findFirst({ where: { id: lineId, orderId }, select: { id: true } });
    if (!line) throw new HttpError(404, "Order line not found");

    await auditedUpdate("order", orderId, async () => {
      await tx.orderSerial.deleteMany({ where: { lineId } });
      if (data.length > 0) {
        try {
          await tx.orderSerial.createMany({
            data: data.map((s, i) => (
              { orderId, lineId, position: i + 1, serial: s.serial, description: s.description })),
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            throw new HttpError(400, "That serial is already on this line");
          }
          throw err;
        }
      }
    }, { tx });

    return readDetail(tx, orderId, traffic);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** Bulk PUT of the order's charges: delete-then-recreate at positions 1..n (spec §5a/§7.5.3 — a
 *  null amount is a legitimate "needs price"). No registered FK on this table, so no
 *  `assertRefExists`, but the transaction stays Serializable for uniformity with every mutator
 *  in this file. */
export async function replaceCharges(orderId: string, input: unknown): Promise<OrderDetail> {
  const data = REPLACE_CHARGES.parse(input);
  const traffic = await trafficSettings();

  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({ where: { id: orderId, deletedAt: null }, select: { id: true } });
    if (!order) throw new HttpError(404, "Order not found");

    await auditedUpdate("order", orderId, async () => {
      await tx.orderCharge.deleteMany({ where: { orderId } });
      if (data.length > 0) {
        await tx.orderCharge.createMany({
          data: data.map((c, i) => (
            { orderId, position: i + 1, description: c.description, amount: c.amount ?? null })),
        });
      }
    }, { tx });

    return readDetail(tx, orderId, traffic);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * `mustDo(user, "void_order")` is the route's job; the reason is required and trimmed HERE so no
 * future caller can bypass it (the `deleteCustomer` precedent, customers.ts) — spec §5c: voiding
 * carries the order's lines/loads/serials/charges away from every list and never frees the order
 * number, so the reason is the only record of why. `auditedSoftDelete` writes the "delete" audit
 * entry with that reason; the pre-check above it is what makes a second void of the same order
 * read "Order not found" rather than the generic "That record has already been deleted" every
 * other mutator in this file would also say for a voided target.
 */
export async function voidOrder(id: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to void an order");

  await withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!order) throw new HttpError(404, "Order not found");
    await auditedSoftDelete("order", id, why, tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * Links two live orders of the SAME customer (spec §5d, **amended 2026-08-02 by owner ruling
 * during the Task 5 review** — the ruling supersedes §5d's original literal wording, which this
 * function followed before the fix: "adopt the OTHER side's group, else mint one for both" could
 * silently detach `id` from a group it already belonged to). Reference-only in Phase 3, no
 * scheduling/consolidation behaviour hangs off it yet.
 *
 * UNIONS the two sides' groups — no order is ever silently detached by linking (only
 * `unlinkOrder` removes membership):
 *   - neither side grouped -> mint one fresh `crypto.randomUUID()` for both (the column is a
 *     plain `String?` with no default — any opaque unique string works, no new dependency);
 *   - exactly one side already grouped -> the groupless side joins it, whichever side that is;
 *   - both grouped in DIFFERENT groups -> merge whole: every order carrying `other`'s groupId
 *     (itself included) moves onto `order`'s groupId, which survives;
 *   - both already in the SAME group -> 400, there is nothing to do.
 *
 * Only rows whose `linkGroupId` VALUE actually changes are audited — the "identical value: skip —
 * no junk audit rows" rule `setPartFieldValues`/`updateStep` already follow, generalized to a
 * per-row loop because a merge can touch more than two rows at once (groups are small per the
 * ruling, so an unbounded loop of individually-audited updates is the honest, not the expensive,
 * choice — and it is what makes either affected order's own history show the link/merge).
 */
export async function linkOrder(id: string, otherId: string): Promise<OrderDetail> {
  if (otherId === id) throw new HttpError(400, "An order cannot be linked to itself");
  const traffic = await trafficSettings();

  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id, deletedAt: null }, select: { id: true, customerId: true, linkGroupId: true },
    });
    if (!order) throw new HttpError(404, "Order not found");

    const other = await tx.order.findFirst({
      where: { id: otherId, deletedAt: null }, select: { id: true, customerId: true, linkGroupId: true },
    });
    if (!other) throw new HttpError(404, "Order not found");

    if (other.customerId !== order.customerId) {
      throw new HttpError(400, "Orders can only be linked within one customer");
    }
    if (order.linkGroupId !== null && order.linkGroupId === other.linkGroupId) {
      throw new HttpError(400, "Those orders are already linked");
    }

    // The survivor groupId, and exactly the rows that need to move onto it — anything NOT
    // listed here already carries the right value and gets no audit entry for this call.
    let groupId: string;
    let toUpdate: string[];
    if (order.linkGroupId && !other.linkGroupId) {
      groupId = order.linkGroupId;
      toUpdate = [otherId];
    } else if (!order.linkGroupId && other.linkGroupId) {
      groupId = other.linkGroupId;
      toUpdate = [id];
    } else if (order.linkGroupId && other.linkGroupId) {
      // Different groups (same-group already 400'd above): id's group survives, and every
      // member of other's group — other itself included — moves onto it.
      groupId = order.linkGroupId;
      const othersGroup = await tx.order.findMany({
        where: { linkGroupId: other.linkGroupId }, select: { id: true },
      });
      toUpdate = othersGroup.map((o) => o.id);
    } else {
      groupId = crypto.randomUUID();
      toUpdate = [id, otherId];
    }

    for (const memberId of toUpdate) {
      await auditedUpdate("order", memberId, () =>
        tx.order.update({ where: { id: memberId }, data: { linkGroupId: groupId } }), { tx });
    }

    return readDetail(tx, id, traffic);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** Clears just this order's own `linkGroupId` (spec §5d) — a group of one left behind is
 *  harmless and collapses on the next link, so no cascade to the other members is needed. */
export async function unlinkOrder(id: string): Promise<OrderDetail> {
  const traffic = await trafficSettings();

  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!order) throw new HttpError(404, "Order not found");

    await auditedUpdate("order", id, () =>
      tx.order.update({ where: { id }, data: { linkGroupId: null } }), { tx });

    return readDetail(tx, id, traffic);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
