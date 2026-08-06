import { z } from "zod";
import { Prisma, type Order } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";
import { allocateNumber, getSetting } from "./settings";
import { claimOrdersInOrder } from "./order-locks";
import { listAddresses } from "./customer-addresses";
import { renderPdf } from "./pdf/render";
import { buildShippingTicketDefinition, type TicketData, type TicketParty } from "./pdf/shipping-ticket";
import { buildBolDefinition, type BolData, type BolParty } from "./pdf/bol";
import { storeDocument, assertPrintable } from "./documents";
import { shippedTotals, recomputeOrderStatus, nextShipmentSequence, type ShippedTotal } from "./ship-ledger";
import { createCert } from "./certs";
import { isDuplicateClientRequestId } from "./orders";
import { toXlsx } from "./excel";
import type { Blocker } from "./reference-blockers";
import { parseDateOnly, formatDateOnly } from "../lib/business-days";
import { FREIGHT_TERMS, type FreightTermsValue, type CertScopeValue } from "../lib/cert-constants";
import { INT4_MAX } from "../lib/order-constants";

// -------------------------------------------------------------------------------------------
// Task 8: the shipment save — `Shipper -> ShipperOrder -> lines/containers/serials` (spec §4.2,
// §5.3, §5.4, §5.7, §6.2). The densest task in the phase: this is where sorted claims, credit
// hold, and idempotency all meet for the first time.
// -------------------------------------------------------------------------------------------

export type ShipperLineDetail = {
  id: string; orderLineId: string; linePosition: number; partNumber: string; partName: string;
  orderedQty: number; orderedWeight: number; shippedToDateQty: number; shippedToDateWeight: number;
  qty: number; weight: number; lineComplete: boolean;
};
/**
 * Shipped-to-date for ONE line of the order, whether or not that line is on this shipment (Task 14
 * review, Important #1). `ShipperLineDetail` above already carries the same two figures for the
 * lines that ARE on this shipment; this is the same derivation extended to the rest of the order's
 * lines — the ones the shipment page's "Add line" picker offers — so the ship-now prefill can be
 * `ordered − shipped` (design §5.1) for a candidate that was partly shipped on some OTHER
 * shipment, instead of defaulting to the full ordered figure and over-shipping by construction.
 */
export type OrderLineShippedToDate = {
  orderLineId: string; shippedToDateQty: number; shippedToDateWeight: number;
};
export type ShipperOrderDetail = {
  id: string; orderId: string; orderNumber: number; sequence: number; position: number;
  poNumber: string; customerJobNo: string; label: string;
  /** Every LIVE line of this order, in order position — a superset of `lines[].orderLineId`, and
   *  the only place a not-yet-added candidate's shipped-to-date is knowable client-side. */
  orderLineShippedToDate: OrderLineShippedToDate[];
  lines: ShipperLineDetail[];
  containers: { id: string; orderContainerId: string; typeName: string; customerContainerId: string; count: number; position: number }[];
  serials: { id: string; orderSerialId: string; serial: string; description: string; printOnShipper: boolean }[];
};
export type ShipperDetail = {
  id: string; shipperNumber: number; bolNumber: number | null;
  customerId: string; customerCode: string; customerName: string;
  shipToAddressId: string | null; shipDate: string;
  carrierId: string | null; carrierName: string | null; route: string; comments: string;
  billFreight: boolean; freightAmount: number | null; freightTerms: FreightTermsValue;
  freightClass: string; freightDescription: string; packageCount: number | null;
  proNumber: string; scacCode: string; deletedAt: string | null;
  orders: ShipperOrderDetail[];
};
export type ShipperCreateResult = { shipper: ShipperDetail; warnings: string[]; deduped: boolean };

// Either the top-level client or a `tx` — the `readDetail` precedent (orders.ts): `readShipperDetail`
// serves both `getShipper` and the tail of the save transaction.
type Db = Prisma.TransactionClient;

const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

/** `parseDateOnly` at the service boundary — the `orders.ts` `parseDate` precedent, one field. */
function parseDate(value: string, field: string): Date {
  try {
    return parseDateOnly(value);
  } catch {
    throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${field}`);
  }
}

// -------------------------------------------------------------------------------------------
// Input shape (task-8-brief.md's exact fields). `clientRequestId` is a plain string, NOT `.uuid()`
// — unlike `Order.clientRequestId` (a browser-minted UUID nonce), nothing in this phase's spec or
// task brief requires this shape to be a UUID specifically, and the brief's own idempotency test
// exercises a plain string ("nonce-1"). `freightClass`/`proNumber`/`scacCode` are `.max(30)` per
// the brief; other display-text fields follow the 2C-2 §4 "max(n) text defaulting """ convention
// with reasonable bounds, since the brief does not pin them individually.
// -------------------------------------------------------------------------------------------

const SHIP_LINE = z.object({
  orderLineId: z.string().min(1),
  qty: z.number().int().min(0).max(INT4_MAX),
  weight: decimalField(12, 2, { required: true, min: "nonnegative" }),
  lineComplete: z.boolean(),
}).strict();

const SHIP_CONTAINER = z.object({
  orderContainerId: z.string().min(1),
  count: z.number().int().min(1).max(INT4_MAX),
}).strict();

const SHIP_SERIAL = z.object({
  orderSerialId: z.string().min(1),
  printOnShipper: z.boolean().default(true),
}).strict();

const SHIP_ORDER = z.object({
  orderId: z.string().min(1),
  lines: z.array(SHIP_LINE).default([]),
  containers: z.array(SHIP_CONTAINER).default([]),
  serials: z.array(SHIP_SERIAL).default([]),
}).strict();

const CREATE_SHIPPER = z.object({
  clientRequestId: z.string().min(1).max(200).optional(),
  customerId: z.string().min(1),
  shipToAddressId: z.string().min(1).nullable().optional(),
  shipDate: z.string().min(1),
  carrierId: z.string().min(1).nullable().optional(),
  route: z.string().max(200).default(""),
  comments: z.string().max(4000).default(""),
  billFreight: z.boolean().default(false),
  freightAmount: decimalField(12, 2, { min: "nonnegative" }),
  freightTerms: z.enum(FREIGHT_TERMS).default("PREPAID"),
  freightClass: z.string().max(30).default(""),
  freightDescription: z.string().max(200).default(""),
  packageCount: z.number().int().min(0).max(INT4_MAX).nullable().optional(),
  proNumber: z.string().max(30).default(""),
  scacCode: z.string().max(30).default(""),
  // Required and trimmed IN THE SERVICE below (spec §5.4's shape), not enforced by zod here — a
  // non-blank string is not, by itself, "a real reason", and the same field is legal (and
  // ignored) when the customer is not actually on hold.
  creditHoldReason: z.string().max(1000).optional(),
  orders: z.array(SHIP_ORDER).min(1),
}).strict();

type CreateShipperInput = z.infer<typeof CREATE_SHIPPER>;

type ResolvedLine = {
  id: string; orderId: string; position: number; qty: number; weight: Prisma.Decimal;
  part: { partNumber: string; name: string; serializationRequired: boolean };
};
type ResolvedContainer = {
  id: string; orderId: string; customerContainerId: string; type: { name: string };
};
type ResolvedSerial = { id: string; orderId: string; lineId: string; serial: string; description: string };

/** "Order #1042 line 2 (3541720C3)" — one label shape for every line-anchored refusal and every
 *  warning in this file, naming both the order and the line (spec §5.7's "each naming the order
 *  and line") — the `orders.ts` `lineLabel` precedent, widened to name the order too since one
 *  shipment can span several of a customer's orders. */
function shipLineLabel(orderNumber: number, line: ResolvedLine): string {
  return `Order #${orderNumber} line ${line.position} (${line.part.partNumber})`;
}

/** The create entry's `after` snapshot, composed by hand exactly like `orders.ts`'s own
 *  `auditPayload` — every foreign key travels with the live name it points at (spec §7's
 *  unreadable-history lesson applied at the create path too, not just `SNAPSHOT_INCLUDE`), and
 *  the credit-hold override reason (when present) rides in THIS payload only — never in a column
 *  on `Shipper` itself, so it lands in the audit entry and prints on no piece of paper (spec
 *  §5.4). Row ids are absent because they do not exist yet, the `orders.ts` precedent. */
function auditPayload(args: {
  shipperNumber: number;
  customer: { id: string; code: string; name: string };
  data: CreateShipperInput;
  shipDate: Date;
  carrierName: string | null;
  shipToAddressName: string | null;
  sequenceByOrderId: Map<string, number>;
  ordersById: Map<string, Order>;
  lineById: Map<string, ResolvedLine>;
  containerById: Map<string, ResolvedContainer>;
  serialById: Map<string, ResolvedSerial>;
  creditHoldOverrideReason?: string;
}) {
  const {
    shipperNumber, customer, data, shipDate, carrierName, shipToAddressName, sequenceByOrderId,
    ordersById, lineById, containerById, serialById, creditHoldOverrideReason,
  } = args;
  return {
    shipperNumber,
    customerId: customer.id, customerCode: customer.code, customerName: customer.name,
    shipToAddressId: data.shipToAddressId ?? null, shipToAddressName,
    shipDate: formatDateOnly(shipDate),
    carrierId: data.carrierId ?? null, carrierName,
    route: data.route, comments: data.comments,
    billFreight: data.billFreight, freightAmount: data.freightAmount ?? null,
    freightTerms: data.freightTerms, freightClass: data.freightClass,
    freightDescription: data.freightDescription, packageCount: data.packageCount ?? null,
    proNumber: data.proNumber, scacCode: data.scacCode,
    // `?? undefined` would silently vanish under redact()'s JSON.stringify round-trip
    // (CLAUDE.md's own lesson) — omitted with a conditional spread instead, so the key exists
    // only when an override genuinely happened.
    ...(creditHoldOverrideReason ? { creditHoldOverrideReason } : {}),
    orders: data.orders.map((o) => {
      const order = ordersById.get(o.orderId)!;
      return {
        orderId: o.orderId, orderNumber: order.orderNumber, sequence: sequenceByOrderId.get(o.orderId)!,
        lines: o.lines.map((l) => {
          const line = lineById.get(l.orderLineId)!;
          return {
            orderLineId: l.orderLineId, linePosition: line.position, partNumber: line.part.partNumber,
            qty: l.qty, weight: l.weight, lineComplete: l.lineComplete,
          };
        }),
        containers: o.containers.map((c) => {
          const container = containerById.get(c.orderContainerId)!;
          return {
            orderContainerId: c.orderContainerId, typeName: container.type.name,
            customerContainerId: container.customerContainerId, count: c.count,
          };
        }),
        serials: o.serials.map((s) => {
          const serial = serialById.get(s.orderSerialId)!;
          return { orderSerialId: s.orderSerialId, serial: serial.serial, printOnShipper: s.printOnShipper };
        }),
      };
    }),
  };
}

const DETAIL_INCLUDE = {
  customer: { select: { code: true, name: true } },
  carrier: { select: { name: true } },
  orders: {
    orderBy: { position: "asc" },
    include: {
      order: {
        select: {
          orderNumber: true, poNumber: true, customerJobNo: true,
          // The order's OWN full line set, not just the lines on this shipment — `toDetail` turns
          // it into `orderLineShippedToDate` below. A nested select on a relation this query
          // already joins, so it costs no extra round trip; order lines carry no `deletedAt` of
          // their own (P3 §4), so every row here is live by construction.
          lines: { orderBy: { position: "asc" }, select: { id: true } },
        },
      },
      lines: {
        orderBy: { position: "asc" },
        include: {
          orderLine: {
            select: { position: true, qty: true, weight: true, part: { select: { partNumber: true, name: true } } },
          },
        },
      },
      containers: {
        orderBy: { position: "asc" },
        include: { orderContainer: { select: { customerContainerId: true, type: { select: { name: true } } } } },
      },
      serials: {
        orderBy: { orderSerialId: "asc" },
        include: { orderSerial: { select: { serial: true, description: true } } },
      },
    },
  },
} satisfies Prisma.ShipperInclude;

type DetailRow = Prisma.ShipperGetPayload<{ include: typeof DETAIL_INCLUDE }>;

function toDetail(row: DetailRow, shipped: Map<string, ShippedTotal>): ShipperDetail {
  return {
    id: row.id, shipperNumber: row.shipperNumber, bolNumber: row.bolNumber,
    customerId: row.customerId, customerCode: row.customer.code, customerName: row.customer.name,
    shipToAddressId: row.shipToAddressId, shipDate: formatDateOnly(row.shipDate),
    carrierId: row.carrierId, carrierName: row.carrier?.name ?? null,
    route: row.route, comments: row.comments,
    billFreight: row.billFreight, freightAmount: num(row.freightAmount),
    freightTerms: row.freightTerms as FreightTermsValue,
    freightClass: row.freightClass, freightDescription: row.freightDescription,
    packageCount: row.packageCount, proNumber: row.proNumber, scacCode: row.scacCode,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    orders: row.orders.map((so) => ({
      id: so.id, orderId: so.orderId, orderNumber: so.order.orderNumber, sequence: so.sequence,
      position: so.position, poNumber: so.order.poNumber, customerJobNo: so.order.customerJobNo,
      label: `${so.order.orderNumber}-${so.sequence}`,
      // A DENSE list: a line with no live shipper line at all has no entry in `shipped` (the
      // sparse-map shape `shippedTotals` documents), and the grid must render a real "0 / 0 lbs"
      // for it rather than the "—" that used to stand in for "unknown".
      orderLineShippedToDate: so.order.lines.map((ol) => {
        const totals = shipped.get(ol.id) ?? { qty: 0, weight: 0 };
        return { orderLineId: ol.id, shippedToDateQty: totals.qty, shippedToDateWeight: totals.weight };
      }),
      lines: so.lines.map((l) => {
        const totals = shipped.get(l.orderLineId) ?? { qty: 0, weight: 0 };
        return {
          id: l.id, orderLineId: l.orderLineId, linePosition: l.orderLine.position,
          partNumber: l.orderLine.part.partNumber, partName: l.orderLine.part.name,
          orderedQty: l.orderLine.qty, orderedWeight: l.orderLine.weight.toNumber(),
          shippedToDateQty: totals.qty, shippedToDateWeight: totals.weight,
          qty: l.qty, weight: l.weight.toNumber(), lineComplete: l.lineComplete,
        };
      }),
      containers: so.containers.map((c) => ({
        id: c.id, orderContainerId: c.orderContainerId, typeName: c.orderContainer.type.name,
        customerContainerId: c.orderContainer.customerContainerId, count: c.count, position: c.position,
      })),
      serials: so.serials.map((s) => ({
        id: s.id, orderSerialId: s.orderSerialId, serial: s.orderSerial.serial,
        description: s.orderSerial.description, printOnShipper: s.printOnShipper,
      })),
    })),
  };
}

/** Exported for `certs.ts`/future callers that need the full detail on a `tx` — the `readDetail`
 *  precedent (orders.ts). */
export async function readShipperDetail(db: Db, id: string): Promise<ShipperDetail> {
  const row = await db.shipper.findFirst({ where: { id }, include: DETAIL_INCLUDE });
  if (!row) throw new HttpError(404, "Shipment not found");
  // Every line of every order on this shipment — a superset of the lines actually ON the shipment
  // (`o.lines[].orderLineId`), which is what lets `toDetail` answer shipped-to-date for an add-line
  // CANDIDATE too (Task 14 review, Important #1). Still ONE `shippedTotals` call, and still the
  // single §5.1 derivation: the ids widened, the arithmetic untouched.
  const orderLineIds = row.orders.flatMap((o) => o.order.lines.map((l) => l.id));
  const shipped = await shippedTotals(db, orderLineIds);
  return toDetail(row, shipped);
}

export async function getShipper(id: string): Promise<ShipperDetail> {
  return readShipperDetail(prisma, id);
}

/**
 * The save transaction (spec §5.3/§5.4/§5.7, task-8-brief.md Step 4): validate -> claim -> credit
 * hold -> allocate -> write -> shipment-scope certs -> recompute status -> warnings.
 *
 * Serializable — the registered-FK writer pattern applies to `carrierId` via `assertRefExists`
 * (CLAUDE.md); it is NOT what protects the sorted claim below, which is the row-lock guarantee at
 * any isolation level.
 */
async function saveNewShipper(
  data: CreateShipperInput, shipDate: Date, opts: { canOverrideCreditHold: boolean },
): Promise<ShipperCreateResult> {
  return prisma.$transaction(async (tx) => {
    if (new Set(data.orders.map((o) => o.orderId)).size !== data.orders.length) {
      throw new HttpError(400, "An order cannot appear twice on the same shipment");
    }

    // Claims are taken in SORTED order, always (spec §5.3) — `claimOrdersInOrder`, never a loop of
    // per-id `claimOrder` calls in caller order, which is exactly the ABBA deadlock hazard two
    // multi-order shipments over {A,B} and {B,A} would otherwise hit.
    const orderIds = data.orders.map((o) => o.orderId);
    const claimed = await claimOrdersInOrder(tx, orderIds);
    const ordersById = new Map(claimed.map((o) => [o.id, o]));

    const customer = await tx.customer.findFirst({ where: { id: data.customerId, deletedAt: null } });
    if (!customer) throw new HttpError(400, "That customer does not exist");

    for (const o of data.orders) {
      const order = ordersById.get(o.orderId);
      if (!order) throw new HttpError(404, "Order not found");
      if (order.deletedAt !== null) throw new HttpError(400, `Order #${order.orderNumber} has been voided`);
      if (order.customerId !== data.customerId) {
        throw new HttpError(400, `Order #${order.orderNumber} belongs to another customer`);
      }
    }

    let shipToAddressName: string | null = null;
    if (data.shipToAddressId) {
      const addr = await tx.customerAddress.findFirst({
        where: { id: data.shipToAddressId, customerId: data.customerId, kind: "SHIP_TO", deletedAt: null },
        select: { name: true },
      });
      if (!addr) throw new HttpError(400, "That ship-to address does not exist");
      shipToAddressName = addr.name;
    }

    // Every orderLineId/orderContainerId/orderSerialId must belong to the order it was named
    // under — one batched read per collection, not one per row (the `resolveLineParts` precedent,
    // orders.ts), then a membership check keyed by id.
    const orderLineIds = [...new Set(data.orders.flatMap((o) => o.lines.map((l) => l.orderLineId)))];
    const orderLines: ResolvedLine[] = orderLineIds.length === 0 ? [] : await tx.orderLine.findMany({
      where: { id: { in: orderLineIds } },
      select: {
        id: true, orderId: true, position: true, qty: true, weight: true,
        part: { select: { partNumber: true, name: true, serializationRequired: true } },
      },
    });
    const lineById = new Map(orderLines.map((l) => [l.id, l]));

    const containerIds = [...new Set(data.orders.flatMap((o) => o.containers.map((c) => c.orderContainerId)))];
    const orderContainers: ResolvedContainer[] = containerIds.length === 0 ? [] : await tx.orderContainer.findMany({
      where: { id: { in: containerIds } },
      select: { id: true, orderId: true, customerContainerId: true, type: { select: { name: true } } },
    });
    const containerById = new Map(orderContainers.map((c) => [c.id, c]));

    const serialIds = [...new Set(data.orders.flatMap((o) => o.serials.map((s) => s.orderSerialId)))];
    const orderSerials: ResolvedSerial[] = serialIds.length === 0 ? [] : await tx.orderSerial.findMany({
      where: { id: { in: serialIds } },
      select: { id: true, orderId: true, lineId: true, serial: true, description: true },
    });
    const serialById = new Map(orderSerials.map((s) => [s.id, s]));

    // Membership AND uniqueness, in the same pass — a repeated orderLineId/orderContainerId/
    // orderSerialId within one order is refused HERE, naming the duplicated line/container/serial
    // by the same live name the membership check already resolved, rather than falling through to
    // the `@@unique` constraint and being mislabeled by `withDbErrors`' generic
    // `conflictField: "shipper number"` (Task 8 review, 2026-08-04) — the `orders.ts`
    // `duplicateSerialError` precedent, made proactive since the resolved rows are already here.
    for (const o of data.orders) {
      const order = ordersById.get(o.orderId)!;

      const seenLines = new Set<string>();
      for (const l of o.lines) {
        const line = lineById.get(l.orderLineId);
        if (!line || line.orderId !== o.orderId) {
          throw new HttpError(400, `Order #${order.orderNumber}: that line does not belong to this order`);
        }
        if (seenLines.has(l.orderLineId)) {
          throw new HttpError(400, `${shipLineLabel(order.orderNumber, line)}: listed twice on this shipment`);
        }
        seenLines.add(l.orderLineId);
      }

      const seenContainers = new Set<string>();
      for (const c of o.containers) {
        const container = containerById.get(c.orderContainerId);
        if (!container || container.orderId !== o.orderId) {
          throw new HttpError(400, `Order #${order.orderNumber}: that container does not belong to this order`);
        }
        if (seenContainers.has(c.orderContainerId)) {
          throw new HttpError(400,
            `Order #${order.orderNumber}: container "${container.type.name}" is listed twice on this shipment`);
        }
        seenContainers.add(c.orderContainerId);
      }

      const seenSerials = new Set<string>();
      for (const s of o.serials) {
        const serial = serialById.get(s.orderSerialId);
        if (!serial || serial.orderId !== o.orderId) {
          throw new HttpError(400, `Order #${order.orderNumber}: that serial does not belong to this order`);
        }
        if (seenSerials.has(s.orderSerialId)) {
          throw new HttpError(400,
            `Order #${order.orderNumber}: serial "${serial.serial}" is listed twice on this shipment`);
        }
        seenSerials.add(s.orderSerialId);
      }
    }

    // Credit hold (spec §5.4, owner ruling §3.7) — the first real gate in this system. Named and
    // linked (the §5.14 blocked-delete discoverability rule applied to a permission-shaped
    // block), never merely "refused".
    let creditHoldOverrideReason: string | undefined;
    if (customer.creditHold) {
      if (!opts.canOverrideCreditHold) {
        throw new HttpError(400,
          `${customer.code} · ${customer.name} is on credit hold — see /customers/${customer.id} to lift it`);
      }
      const reason = (data.creditHoldReason ?? "").trim();
      if (!reason) throw new HttpError(400, "A reason is required to override a credit hold");
      creditHoldOverrideReason = reason;
    }

    // Numbering (spec §3.19/§5.3), inside the same claim: the shipment's own packing-list number,
    // then every order's own never-reused shipment sequence.
    const shipperNumber = await allocateNumber("shipper_number_next", tx);
    const sequenceByOrderId = new Map<string, number>();
    for (const orderId of orderIds) {
      if (sequenceByOrderId.has(orderId)) continue;
      sequenceByOrderId.set(orderId, await nextShipmentSequence(tx, orderId));
    }

    let carrierName: string | null = null;
    if (data.carrierId) {
      await assertRefExists("carrier", data.carrierId, tx);
      const carrier = await tx.carrier.findFirst({ where: { id: data.carrierId }, select: { name: true } });
      carrierName = carrier?.name ?? null;
    }

    // Shipped-to-date BEFORE this shipment's own lines exist — the over-ship warning below
    // compares against what was already live, not what this save is about to add.
    const priorShipped = await shippedTotals(tx, orderLineIds);

    const shipper = await auditedCreate(
      "shipper",
      auditPayload({
        shipperNumber, customer, data, shipDate, carrierName, shipToAddressName, sequenceByOrderId,
        ordersById, lineById, containerById, serialById, creditHoldOverrideReason,
      }),
      () => tx.shipper.create({
        data: {
          shipperNumber,
          clientRequestId: data.clientRequestId ?? null,
          customerId: data.customerId,
          shipToAddressId: data.shipToAddressId ?? null,
          shipDate,
          carrierId: data.carrierId ?? null,
          route: data.route,
          comments: data.comments,
          billFreight: data.billFreight,
          freightAmount: data.freightAmount ?? null,
          freightTerms: data.freightTerms,
          freightClass: data.freightClass,
          freightDescription: data.freightDescription,
          packageCount: data.packageCount ?? null,
          proNumber: data.proNumber,
          scacCode: data.scacCode,
          orders: {
            create: data.orders.map((o, oi) => ({
              orderId: o.orderId,
              sequence: sequenceByOrderId.get(o.orderId)!,
              position: oi + 1,
              lines: {
                create: o.lines.map((l, li) => ({
                  orderLineId: l.orderLineId, position: li + 1,
                  qty: l.qty, weight: l.weight, lineComplete: l.lineComplete,
                })),
              },
              containers: {
                create: o.containers.map((c, ci) => ({
                  orderContainerId: c.orderContainerId, position: ci + 1, count: c.count,
                })),
              },
              serials: {
                create: o.serials.map((s) => ({
                  orderSerialId: s.orderSerialId, printOnShipper: s.printOnShipper,
                })),
              },
            })),
          },
        },
        select: { id: true },
      }),
      { tx },
    );

    // SHIPMENT-scope certs, one per order whose resolved cert scope is SHIPMENT (spec §6.2).
    // `shipper.id` is the row THIS transaction inserted a moment ago: no other transaction can
    // see it yet (it is uncommitted), so it can never have been voided before this transaction
    // commits — this call path can never hand `createCert` a voided `shipperId` (task brief,
    // carried-forward item 1; see the task report for the full argument).
    for (const o of data.orders) {
      const order = ordersById.get(o.orderId)!;
      if (order.certRequired && order.certScope === "SHIPMENT") {
        await createCert({ orderId: o.orderId, scope: "SHIPMENT", shipperId: shipper.id }, tx);
      }
    }

    await recomputeOrderStatus(tx, orderIds);

    // Warnings (spec §5.7) — collected AFTER the cert/status writes above, so a SHIPMENT-scope
    // cert this very save just created is never reported as "missing".
    const liveCertOrderIds = new Set(
      (await tx.cert.findMany({
        where: { orderId: { in: orderIds }, deletedAt: null }, select: { orderId: true },
      })).map((c) => c.orderId),
    );

    const warnings: string[] = [];
    for (const o of data.orders) {
      const order = ordersById.get(o.orderId)!;
      if (order.certRequired && !liveCertOrderIds.has(o.orderId)) {
        warnings.push(
          `Order #${order.orderNumber} requires a certification and none exists yet — see /orders/${order.id}`);
      }

      const serialLineIds = new Set(
        o.serials.map((s) => serialById.get(s.orderSerialId)?.lineId).filter((id): id is string => !!id));

      for (const l of o.lines) {
        const line = lineById.get(l.orderLineId)!;
        const label = shipLineLabel(order.orderNumber, line);

        if (line.part.serializationRequired && !serialLineIds.has(l.orderLineId)) {
          warnings.push(`${label}: requires serialization but no serial numbers were selected for this shipment`);
        }

        const prior = priorShipped.get(l.orderLineId) ?? { qty: 0, weight: 0 };
        const remainingQty = line.qty - prior.qty;
        const remainingWeight = line.weight.toNumber() - prior.weight;
        if (l.qty > remainingQty || l.weight > remainingWeight) {
          warnings.push(
            `${label}: shipping ${l.qty} / ${l.weight} lbs exceeds the remaining ` +
            `${remainingQty} / ${remainingWeight} lbs on this line`);
        }
      }
    }

    return { shipper: await readShipperDetail(tx, shipper.id), warnings, deduped: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/**
 * `createShipper` (spec §5, task-8-brief.md). `clientRequestId` collisions answer with the
 * shipment that request already created — `orders.ts`'s `createOrder` idempotent-replay shape,
 * reused via its exported `isDuplicateClientRequestId` rather than rediscovered here.
 */
export async function createShipper(
  input: unknown, opts: { canOverrideCreditHold: boolean },
): Promise<ShipperCreateResult> {
  const data = CREATE_SHIPPER.parse(input);

  // Both checked ahead of the transaction — pure input validation with no DB dependency (Task 8
  // review, 2026-08-04: `parseDate` moved up beside the pre-existing `qty > 0` check for the same
  // reason). A shipment about nothing is not a shipment (spec §4.2).
  const anyPositiveQty = data.orders.some((o) => o.lines.some((l) => l.qty > 0));
  if (!anyPositiveQty) throw new HttpError(400, "A shipment needs at least one line with a positive quantity");
  const shipDate = parseDate(data.shipDate, "Ship date");

  return withDbErrors({ entity: "Shipper", conflictField: "shipper number" }, async () => {
    try {
      return await saveNewShipper(data, shipDate, opts);
    } catch (err) {
      // The replay: deliberately inside withDbErrors' callback and outside the transaction — by
      // the time this runs the failed attempt has fully rolled back (no number, no sequence
      // consumed), and the winning shipment is committed and readable.
      if (!data.clientRequestId || !isDuplicateClientRequestId(err)) throw err;
      const existing = await prisma.shipper.findFirst({
        where: { clientRequestId: data.clientRequestId }, select: { id: true },
      });
      if (!existing) throw err;
      return { shipper: await readShipperDetail(prisma, existing.id), warnings: [], deduped: true };
    }
  });
}

// -------------------------------------------------------------------------------------------
// Task 9: shipment children — a shipment edited as a document (spec §4.2, §5.3, §5.5, §7.3):
// change its header, add and remove orders, and replace the three per-order grids. Every mutator
// below follows the same shape: `withDbErrors` -> Serializable `$transaction` -> resolve the
// shipper (404 on missing OR voided — a voided shipment is read-only, the P3 voided-order shape)
// -> `claimOrdersInOrder(tx, everyAffectedOrderId)` -> `auditedUpdate("shipper", id, …)` -> writes
// -> `recomputeOrderStatus`. "Every affected order" is always the FULL set of orders currently on
// the shipment (plus the incoming order for `addOrderToShipper`) — even a header-only edit claims
// the whole set, the same uniform discipline `updateLine`'s own comment describes for
// `recomputeOrderStatus` itself (orders.ts): calling it where it cannot possibly matter is cheap,
// and it means no mutator silently relies on an invariant ("this write can never touch another
// order") that a later change could quietly break.
// -------------------------------------------------------------------------------------------

/** Resolves the shipper and 404s on missing OR voided — a voided shipment is read-only (the P3
 *  voided-order shape). Not a row claim of its own: `Shipper` has no `FOR UPDATE` instrument in
 *  this system, only the `Order` rows it points at do (order-locks.ts) — this is a plain
 *  existence/liveness read, always followed by `claimOrdersInOrder` below. */
async function claimLiveShipper(tx: Prisma.TransactionClient, id: string) {
  const shipper = await tx.shipper.findFirst({ where: { id } });
  if (!shipper || shipper.deletedAt !== null) throw new HttpError(404, "Shipment not found");
  return shipper;
}

/** Resolves one `ShipperOrder` row scoped to this shipment — a `shipperOrderId` from a DIFFERENT
 *  shipment is "not found" here, never silently accepted. */
async function findShipperOrder(tx: Prisma.TransactionClient, shipperId: string, shipperOrderId: string) {
  const so = await tx.shipperOrder.findFirst({
    where: { id: shipperOrderId, shipperId }, select: { id: true, orderId: true },
  });
  if (!so) throw new HttpError(404, "That order is not on this shipment");
  return so;
}

/** Every order currently on the shipment, as a plain id array — the "everyAffectedOrderId" set
 *  every mutator below claims through `claimOrdersInOrder` before it reads or writes anything. */
async function shipperOrderIds(tx: Prisma.TransactionClient, shipperId: string): Promise<string[]> {
  const rows = await tx.shipperOrder.findMany({ where: { shipperId }, select: { orderId: true } });
  return rows.map((r) => r.orderId);
}

// -------------------------------------------------------------------------------------------
// updateShipper: header only (customerId, clientRequestId, shipperNumber and bolNumber are all
// immutable — the first because every order on the shipment is validated against it at add-time
// (spec: "refuses an order belonging to a different customer"), letting it change would silently
// invalidate that check for every order already attached).
// -------------------------------------------------------------------------------------------

const UPDATE_SHIPPER = z.object({
  shipToAddressId: z.string().min(1).nullable().optional(),
  shipDate: z.string().min(1).optional(),
  carrierId: z.string().min(1).nullable().optional(),
  route: z.string().max(200).optional(),
  comments: z.string().max(4000).optional(),
  billFreight: z.boolean().optional(),
  freightAmount: decimalField(12, 2, { min: "nonnegative" }),
  freightTerms: z.enum(FREIGHT_TERMS).optional(),
  freightClass: z.string().max(30).optional(),
  freightDescription: z.string().max(200).optional(),
  packageCount: z.number().int().min(0).max(INT4_MAX).nullable().optional(),
  proNumber: z.string().max(30).optional(),
  scacCode: z.string().max(30).optional(),
}).strict();

export async function updateShipper(id: string, input: unknown): Promise<ShipperDetail> {
  const data = UPDATE_SHIPPER.parse(input);

  return withDbErrors({ entity: "Shipper" }, () => prisma.$transaction(async (tx) => {
    const shipper = await claimLiveShipper(tx, id);
    const orderIds = await shipperOrderIds(tx, id);
    await claimOrdersInOrder(tx, orderIds);

    if (data.shipToAddressId) {
      const addr = await tx.customerAddress.findFirst({
        where: { id: data.shipToAddressId, customerId: shipper.customerId, kind: "SHIP_TO", deletedAt: null },
        select: { id: true },
      });
      if (!addr) throw new HttpError(400, "That ship-to address does not exist");
    }
    if (data.carrierId) await assertRefExists("carrier", data.carrierId, tx);

    const patch: Prisma.ShipperUncheckedUpdateInput = {
      ...(data.shipToAddressId !== undefined ? { shipToAddressId: data.shipToAddressId } : {}),
      ...(data.shipDate !== undefined ? { shipDate: parseDate(data.shipDate, "Ship date") } : {}),
      ...(data.carrierId !== undefined ? { carrierId: data.carrierId } : {}),
      ...(data.route !== undefined ? { route: data.route } : {}),
      ...(data.comments !== undefined ? { comments: data.comments } : {}),
      ...(data.billFreight !== undefined ? { billFreight: data.billFreight } : {}),
      ...(data.freightAmount !== undefined ? { freightAmount: data.freightAmount } : {}),
      ...(data.freightTerms !== undefined ? { freightTerms: data.freightTerms } : {}),
      ...(data.freightClass !== undefined ? { freightClass: data.freightClass } : {}),
      ...(data.freightDescription !== undefined ? { freightDescription: data.freightDescription } : {}),
      ...(data.packageCount !== undefined ? { packageCount: data.packageCount } : {}),
      ...(data.proNumber !== undefined ? { proNumber: data.proNumber } : {}),
      ...(data.scacCode !== undefined ? { scacCode: data.scacCode } : {}),
    };

    await auditedUpdate("shipper", id, () => tx.shipper.update({ where: { id }, data: patch }), { tx });
    await recomputeOrderStatus(tx, orderIds);
    return readShipperDetail(tx, id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * Attaches one more order of the SAME customer to the shipment (spec §4.2's emergent multi-order
 * shipment) — its own `sequence` (this order's Nth shipment ever, `nextShipmentSequence`) and the
 * next `position` (print order of the tickets, `MAX(position) + 1`; positions stay contiguous
 * 1..N by construction — appends never collide with an existing position, so unlike
 * `removeOrderFromShipper` this needs no two-phase renumber). No lines/containers/serials are
 * populated here — those come from the three replace calls below, once the order shell exists.
 *
 * Task 9 review (2026-08-04): the duplicate-order check and the `position` number are read AFTER
 * `claimOrdersInOrder`, not from the bare pre-claim `preClaimExisting` list below — that list
 * exists ONLY to know which orders to claim (there is no lock on `Shipper`/`ShipperOrder`
 * themselves to claim instead, so some unlocked read is unavoidable to learn that). Computing
 * `position` fresh at the point of use, the `nextShipmentSequence` idiom (ship-ledger.ts), rather
 * than trusting a value captured before the claim. A residual collision (two adds racing on the
 * same shipment, serialized through the row lock but still landing on `@@unique([shipperId,
 * position])` or `@@unique([shipperId, orderId])`) is mapped to the SAME honest "try again" 409
 * `withDbErrors` already gives a genuine Serializable conflict (P2034) elsewhere in this codebase
 * — not the generic, mislabelled `withDbErrors` P2002 fallback the Task 8 review's own lesson
 * warns against ("a refusal naming a problem that did not exist").
 */
export async function addOrderToShipper(id: string, orderId: string): Promise<ShipperDetail> {
  return withDbErrors({ entity: "Shipper" }, () => prisma.$transaction(async (tx) => {
    const shipper = await claimLiveShipper(tx, id);

    const preClaimExisting = await tx.shipperOrder.findMany({ where: { shipperId: id }, select: { orderId: true } });
    const allOrderIds = [...new Set([...preClaimExisting.map((o) => o.orderId), orderId])];
    const claimed = await claimOrdersInOrder(tx, allOrderIds);
    const order = claimed.find((o) => o.id === orderId);
    if (!order) throw new HttpError(404, "Order not found");
    if (order.deletedAt !== null) throw new HttpError(400, `Order #${order.orderNumber} has been voided`);
    if (order.customerId !== shipper.customerId) {
      throw new HttpError(400, `Order #${order.orderNumber} does not belong to the same customer as this shipment`);
    }

    const dup = await tx.shipperOrder.findFirst({ where: { shipperId: id, orderId }, select: { id: true } });
    if (dup) throw new HttpError(400, "That order is already on this shipment");

    const { _max } = await tx.shipperOrder.aggregate({ where: { shipperId: id }, _max: { position: true } });
    const position = (_max.position ?? 0) + 1;
    const sequence = await nextShipmentSequence(tx, orderId);

    try {
      await auditedUpdate("shipper", id, () => tx.shipperOrder.create({
        data: { shipperId: id, orderId, sequence, position },
        select: { id: true },
      }), { tx });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new HttpError(409, "Another change to this shipment was saved at the same time — please try again");
      }
      throw err;
    }

    await recomputeOrderStatus(tx, allOrderIds);
    return readShipperDetail(tx, id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * Two-phase negative-park rewrite of `ShipperOrder.position` for one shipment's SURVIVING rows,
 * against `@@unique([shipperId, position])` — the `applyLoads` precedent (order-loads.ts): every
 * remaining row is first parked at a unique NEGATIVE position (index-derived, distinct by
 * construction), and only then rewritten to its real 1..N target, in the same relative order it
 * already had. A direct decrement-in-place would also happen to be safe for this specific "close
 * the gap left by one removed row" shape (each row's target is vacated by the row ahead of it
 * moving first) — the two-phase park is used anyway, uniformly, so this function's correctness
 * never depends on which particular renumber shape called it.
 */
async function renumberShipperOrderPositions(tx: Prisma.TransactionClient, shipperId: string): Promise<void> {
  const rows = await tx.shipperOrder.findMany({
    where: { shipperId }, orderBy: { position: "asc" }, select: { id: true },
  });
  for (const [index, row] of rows.entries()) {
    await tx.shipperOrder.update({ where: { id: row.id }, data: { position: -(index + 1) } });
  }
  for (const [index, row] of rows.entries()) {
    await tx.shipperOrder.update({ where: { id: row.id }, data: { position: index + 1 } });
  }
}

/**
 * Removes one order from the shipment (spec §4.2/§5.5). `ShipperOrder` carries no `deletedAt` of
 * its own (spec §4.2), so removal HARD-deletes the row — and frees its `sequence`, which is
 * exactly the hazard spec §5.5 was tightened for (2026-08-04, Task 2 review): a later shipment of
 * that same order would then be handed a number already printed on a customer's paperwork. Refused
 * outright once a shipping ticket exists for this order — either its own (`orderId` = this order)
 * or a whole-set print (`orderId: null`, which covers every order on the shipment) — naming the
 * document and pointing at the correct fix: void the shipment instead, which keeps every sequence
 * claimed forever (spec §5.6) rather than freeing one back into circulation.
 *
 * **Also voids that order's own SHIPMENT-scope cert, if it has one (spec §5.6, 2026-08-04
 * amendment — recorded after a review caught the gap this closes).** Once the order leaves the
 * shipment, nothing on it still names that order's parts — the cert is orphaned regardless of
 * locking. Doing it HERE, under the claim this function already holds for `target.orderId`
 * (`orderIds` above includes it, via `claimOrdersInOrder`), rather than leaving it for
 * `voidShipper`'s own cascade to find later, is what keeps `voidShipper` provably correct: its own
 * claim only ever covers the orders STILL on the shipment when IT runs, and would otherwise have
 * to write a `deletedAt` onto a cert belonging to an order it never claimed — see `voidShipper`'s
 * own doc comment for the full argument this closes.
 *
 * Children are deleted explicitly before the parent row — `ShipperLine`/`Container`/`Serial` are
 * all `ON DELETE RESTRICT` from `ShipperOrder` (migration.sql), so a bare `shipperOrder.delete`
 * would fail with a foreign-key violation while any child row survives it (the `removeLine`
 * precedent, orders.ts, for the identical `OrderSerial -> OrderLine` RESTRICT shape).
 */
export async function removeOrderFromShipper(id: string, shipperOrderId: string): Promise<ShipperDetail> {
  return withDbErrors({ entity: "Shipper" }, () => prisma.$transaction(async (tx) => {
    const shipper = await claimLiveShipper(tx, id);
    const target = await findShipperOrder(tx, id, shipperOrderId);

    const orderIds = await shipperOrderIds(tx, id);
    await claimOrdersInOrder(tx, orderIds);

    // Spec §4.2: "a shipment must carry at least one line with qty > 0 across all its orders" —
    // removing the LAST order leaves `orders: []`, a document about nothing in the strongest
    // sense. Void the shipment is the correct correction (§5.6): it keeps every sequence claimed
    // forever, exactly like the printed-ticket refusal just below — this is the same
    // "irreversible removal has a void-shaped escape hatch" shape, not a coincidence.
    if (orderIds.length === 1) {
      throw new HttpError(400,
        `This is the only order on the shipment — void the shipment (Packing List ${shipper.shipperNumber}) ` +
        "instead of removing its last order.");
    }

    const printed = await tx.storedDocument.findFirst({
      where: { kind: "SHIPPER", shipperId: id, OR: [{ orderId: target.orderId }, { orderId: null }] },
      select: { id: true },
    });
    if (printed) {
      throw new HttpError(400,
        `A shipping ticket for this order has already printed (Packing List ${shipper.shipperNumber}) — ` +
        "void the shipment instead of removing it.");
    }

    // Void this order's own SHIPMENT-scope cert, if it has one — see this function's own doc
    // comment for why HERE, not deferred to `voidShipper`'s cascade. A DIFFERENT audit entity
    // ("cert", not "shipper"), so a separate `auditedSoftDelete` call, not folded into the
    // `auditedUpdate("shipper", …)` below. At most one live row can match (createCert's own
    // scope-instance uniqueness, certs.ts), so this is a find-and-void of at most one row.
    const orphanedCert = await tx.cert.findFirst({
      where: { orderId: target.orderId, shipperId: id, deletedAt: null }, select: { id: true },
    });
    if (orphanedCert) {
      await auditedSoftDelete("cert", orphanedCert.id,
        `Order removed from shipment (Packing List ${shipper.shipperNumber})`, tx);
    }

    await auditedUpdate("shipper", id, async () => {
      await tx.shipperLine.deleteMany({ where: { shipperOrderId } });
      await tx.shipperContainer.deleteMany({ where: { shipperOrderId } });
      await tx.shipperSerial.deleteMany({ where: { shipperOrderId } });
      await tx.shipperOrder.delete({ where: { id: shipperOrderId } });
      await renumberShipperOrderPositions(tx, id);
    }, { tx });

    await recomputeOrderStatus(tx, orderIds);
    return readShipperDetail(tx, id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * The over-ship half of spec §5.7's warnings, computed straight off an already-built
 * `ShipperDetail` rather than re-deriving `shippedTotals` a second time: a line's own
 * `shippedToDateQty`/`shippedToDateWeight` already sum every LIVE shipment for that order line,
 * INCLUDING this one (`readShipperDetail`'s own `shippedTotals` call), so "the running total now
 * exceeds what was ordered" is algebraically the identical fact `saveNewShipper`'s own warning
 * checks against the qty/weight remaining BEFORE that save (shipped-to-date = prior + this
 * shipment's own qty; `thisQty > ordered - prior` rearranges to exactly `prior + thisQty >
 * ordered`, i.e. `shippedToDateQty > orderedQty`). Exported so any mutator that hands back a fresh
 * `ShipperDetail` can report the warning without a second round trip — `replaceShipperLines` is
 * the one that can newly trigger it, since it is the one call that changes a shipped qty/weight.
 */
export function overshipWarnings(detail: ShipperDetail): string[] {
  const warnings: string[] = [];
  for (const so of detail.orders) {
    for (const line of so.lines) {
      if (line.shippedToDateQty > line.orderedQty || line.shippedToDateWeight > line.orderedWeight) {
        warnings.push(
          `Order #${so.orderNumber} line ${line.linePosition} (${line.partNumber}): shipped-to-date ` +
          `${line.shippedToDateQty} / ${line.shippedToDateWeight} lbs exceeds the ${line.orderedQty} / ` +
          `${line.orderedWeight} lbs ordered`);
      }
    }
  }
  return warnings;
}

/**
 * Bulk PUT of one `ShipperOrder`'s lines — delete-then-recreate at positions 1..n (the
 * `replaceContainers`/`replaceSerials` precedent, orders.ts). Over-shipping still warns and never
 * blocks (spec §5.7): `overshipWarnings` above is what a caller uses to see it in the fresh detail
 * this function returns.
 */
export async function replaceShipperLines(id: string, shipperOrderId: string, input: unknown): Promise<ShipperDetail> {
  const data = z.array(SHIP_LINE).parse(input);

  return withDbErrors({ entity: "Shipper" }, () => prisma.$transaction(async (tx) => {
    await claimLiveShipper(tx, id);
    const so = await findShipperOrder(tx, id, shipperOrderId);

    const orderIds = await shipperOrderIds(tx, id);
    const claimed = await claimOrdersInOrder(tx, orderIds);
    const order = claimed.find((o) => o.id === so.orderId)!;

    const lineIds = [...new Set(data.map((l) => l.orderLineId))];
    const orderLines: ResolvedLine[] = lineIds.length === 0 ? [] : await tx.orderLine.findMany({
      where: { id: { in: lineIds } },
      select: {
        id: true, orderId: true, position: true, qty: true, weight: true,
        part: { select: { partNumber: true, name: true, serializationRequired: true } },
      },
    });
    const lineById = new Map(orderLines.map((l) => [l.id, l]));

    const seen = new Set<string>();
    for (const l of data) {
      const line = lineById.get(l.orderLineId);
      if (!line || line.orderId !== so.orderId) {
        throw new HttpError(400, `Order #${order.orderNumber}: that line does not belong to this order`);
      }
      if (seen.has(l.orderLineId)) {
        throw new HttpError(400, `${shipLineLabel(order.orderNumber, line)}: listed twice on this shipment`);
      }
      seen.add(l.orderLineId);
    }

    // Spec §4.2: "a shipment must carry at least one line with qty > 0 across all its orders" —
    // a DOCUMENT-level invariant, not a per-line one (a single zeroed line, `lineComplete: true`,
    // stays legal on its own — "we are not sending the last three, close the line"). Checked only
    // when THIS order's own new lines carry none, against every OTHER `ShipperOrder` on the same
    // shipment — the common case (this order still has a positive line, or this isn't the only
    // order) never pays for the extra read.
    if (!data.some((l) => l.qty > 0)) {
      const otherPositive = await tx.shipperLine.findFirst({
        where: { qty: { gt: 0 }, shipperOrder: { shipperId: id, id: { not: shipperOrderId } } },
        select: { id: true },
      });
      if (!otherPositive) throw new HttpError(400, "A shipment needs at least one line with a positive quantity");
    }

    await auditedUpdate("shipper", id, async () => {
      await tx.shipperLine.deleteMany({ where: { shipperOrderId } });
      if (data.length > 0) {
        await tx.shipperLine.createMany({
          data: data.map((l, i) => (
            { shipperOrderId, orderLineId: l.orderLineId, position: i + 1, qty: l.qty, weight: l.weight, lineComplete: l.lineComplete })),
        });
      }
    }, { tx });

    await recomputeOrderStatus(tx, orderIds);
    return readShipperDetail(tx, id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** Bulk PUT of one `ShipperOrder`'s containers — delete-then-recreate at positions 1..n, each
 *  `orderContainerId` validated to belong to this SAME order (the create-path's own per-order
 *  membership check, `saveNewShipper`, scoped down to one order here). */
export async function replaceShipperContainers(id: string, shipperOrderId: string, input: unknown): Promise<ShipperDetail> {
  const data = z.array(SHIP_CONTAINER).parse(input);

  return withDbErrors({ entity: "Shipper" }, () => prisma.$transaction(async (tx) => {
    await claimLiveShipper(tx, id);
    const so = await findShipperOrder(tx, id, shipperOrderId);

    const orderIds = await shipperOrderIds(tx, id);
    const claimed = await claimOrdersInOrder(tx, orderIds);
    const order = claimed.find((o) => o.id === so.orderId)!;

    const containerIds = [...new Set(data.map((c) => c.orderContainerId))];
    const containers: ResolvedContainer[] = containerIds.length === 0 ? [] : await tx.orderContainer.findMany({
      where: { id: { in: containerIds } },
      select: { id: true, orderId: true, customerContainerId: true, type: { select: { name: true } } },
    });
    const containerById = new Map(containers.map((c) => [c.id, c]));

    const seen = new Set<string>();
    for (const c of data) {
      const container = containerById.get(c.orderContainerId);
      if (!container || container.orderId !== so.orderId) {
        throw new HttpError(400, `Order #${order.orderNumber}: that container does not belong to this order`);
      }
      if (seen.has(c.orderContainerId)) {
        throw new HttpError(400,
          `Order #${order.orderNumber}: container "${container.type.name}" is listed twice on this shipment`);
      }
      seen.add(c.orderContainerId);
    }

    await auditedUpdate("shipper", id, async () => {
      await tx.shipperContainer.deleteMany({ where: { shipperOrderId } });
      if (data.length > 0) {
        await tx.shipperContainer.createMany({
          data: data.map((c, i) => ({ shipperOrderId, orderContainerId: c.orderContainerId, position: i + 1, count: c.count })),
        });
      }
    }, { tx });

    await recomputeOrderStatus(tx, orderIds);
    return readShipperDetail(tx, id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** Bulk PUT of one `ShipperOrder`'s serials — delete-then-recreate, each `orderSerialId` validated
 *  to belong to this SAME order. No position write of its own (`ShipperSerial` has none — a serial
 *  is either on the ticket or it isn't, schema.prisma's own comment on its `orderBy`). */
export async function replaceShipperSerials(id: string, shipperOrderId: string, input: unknown): Promise<ShipperDetail> {
  const data = z.array(SHIP_SERIAL).parse(input);

  return withDbErrors({ entity: "Shipper" }, () => prisma.$transaction(async (tx) => {
    await claimLiveShipper(tx, id);
    const so = await findShipperOrder(tx, id, shipperOrderId);

    const orderIds = await shipperOrderIds(tx, id);
    const claimed = await claimOrdersInOrder(tx, orderIds);
    const order = claimed.find((o) => o.id === so.orderId)!;

    const serialIds = [...new Set(data.map((s) => s.orderSerialId))];
    const serials: ResolvedSerial[] = serialIds.length === 0 ? [] : await tx.orderSerial.findMany({
      where: { id: { in: serialIds } },
      select: { id: true, orderId: true, lineId: true, serial: true, description: true },
    });
    const serialById = new Map(serials.map((s) => [s.id, s]));

    const seen = new Set<string>();
    for (const s of data) {
      const serial = serialById.get(s.orderSerialId);
      if (!serial || serial.orderId !== so.orderId) {
        throw new HttpError(400, `Order #${order.orderNumber}: that serial does not belong to this order`);
      }
      if (seen.has(s.orderSerialId)) {
        throw new HttpError(400, `Order #${order.orderNumber}: serial "${serial.serial}" is listed twice on this shipment`);
      }
      seen.add(s.orderSerialId);
    }

    await auditedUpdate("shipper", id, async () => {
      await tx.shipperSerial.deleteMany({ where: { shipperOrderId } });
      if (data.length > 0) {
        await tx.shipperSerial.createMany({
          data: data.map((s) => ({ shipperOrderId, orderSerialId: s.orderSerialId, printOnShipper: s.printOnShipper })),
        });
      }
    }, { tx });

    await recomputeOrderStatus(tx, orderIds);
    return readShipperDetail(tx, id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

// -------------------------------------------------------------------------------------------
// Task 10: void, and the order edit invariants (spec §5.5/§5.6). `shipmentBlockers` is the
// `orders.ts -> shippers.ts` import edge this task adds — `orders.ts`'s `removeLine`/`updateLine`/
// `voidOrder` call it to refuse a contradiction of shipped fact, naming the blocking shipment
// through the SAME `Blocker` shape every other "still in use" refusal in this codebase already
// renders through `BlockerPanel` (reference-blockers.ts), rather than a bespoke shape. Safe
// against the cycle this creates with `shippers.ts`'s own pre-existing import of
// `isDuplicateClientRequestId` FROM orders.ts (order-locks.ts's own header comment anticipated
// this): both crossing exports are hoisted `function` declarations, never a top-level `const`
// evaluated at module-load time, so neither side can land in the other's temporal dead zone
// regardless of which module a given entry point happens to import first — see the task report
// for how this was verified (module-load-order smoke test, plus the full suite importing both
// modules together with no import-time error).
// -------------------------------------------------------------------------------------------

/**
 * Every LIVE shipment currently attached to `orderId` — or, scoped to `orderLineId`, only those
 * carrying a live `ShipperLine` for that exact order line — as the shared `Blocker` shape (spec
 * §5.5). Deduplicated by shipper (a shipment can only appear on one `ShipperOrder` row per order,
 * `@@unique([shipperId, orderId])`, so dedup only matters when `orderLineId` is omitted and more
 * than one shipment touches the order), ordered by `shipperNumber` ascending so the refusal names
 * shipments in a deterministic, human-meaningful order rather than whatever order Postgres
 * happened to scan them in.
 */
export async function shipmentBlockers(db: Db, orderId: string, orderLineId?: string): Promise<Blocker[]> {
  const rows = await db.shipperOrder.findMany({
    where: {
      orderId,
      shipper: { deletedAt: null },
      ...(orderLineId ? { lines: { some: { orderLineId } } } : {}),
    },
    select: { shipperId: true, shipper: { select: { shipperNumber: true } } },
    orderBy: { shipper: { shipperNumber: "asc" } },
  });

  const seen = new Set<string>();
  const out: Blocker[] = [];
  for (const row of rows) {
    if (seen.has(row.shipperId)) continue;
    seen.add(row.shipperId);
    out.push({
      entityLabel: "Shipment",
      name: `Packing List ${row.shipper.shipperNumber}`,
      id: row.shipperId,
      href: `/shipping/${row.shipperId}`,
    });
  }
  return out;
}

/**
 * `mustDo(user, "void_shipper")` is the route's job; the reason is required and trimmed HERE so
 * no future caller can bypass it (the `voidOrder`/`voidCert` precedent, orders.ts/certs.ts).
 * Claims every order the shipment touches — sorted, via `claimOrdersInOrder` — before writing
 * anything, `auditedSoftDelete`s the shipper, then every LIVE shipment-scope cert hanging off it
 * WITH THE SAME REASON (spec §5.6: "voids any shipment-scoped certs hanging off it with the same
 * reason"), and finally recomputes every affected order's status. `shipperNumber`, `bolNumber` and
 * every `ShipperOrder.sequence` are never touched by this function — that permanence is the
 * absence of any write to them, not a check this function performs.
 *
 * A shipment-scope cert's `orderId` is always one of the orders THIS claim just covered — NOT
 * because every order that ever touched the shipment still does (an order CAN be removed,
 * `removeOrderFromShipper` above), but because `removeOrderFromShipper` itself voids that order's
 * own shipment-scope cert, under the claim it already holds for that order, at the moment the
 * order leaves the shipment (spec §5.6, 2026-08-04 amendment). A review of the first version of
 * this function caught the gap that amendment closes: `orderIds` here comes from the shipment's
 * CURRENT `ShipperOrder` rows, so an order removed earlier is not in it and its row is not
 * claimed — if its cert could still be live, THIS loop would be writing `deletedAt` onto a row
 * belonging to an unclaimed order. With the removal-time void in place, that case cannot arise: by
 * the time a shipment-scope cert can still be found live here, its order is necessarily still ON
 * the shipment, i.e. inside `orderIds` — so the claim already taken over `orderIds` genuinely
 * covers every cert this loop can touch, and no separate claim is needed for the cert side.
 */
export async function voidShipper(id: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to void a shipment");

  await withDbErrors({ entity: "Shipper" }, () => prisma.$transaction(async (tx) => {
    await claimLiveShipper(tx, id);
    const orderIds = await shipperOrderIds(tx, id);
    await claimOrdersInOrder(tx, orderIds);

    await auditedSoftDelete("shipper", id, why, tx);

    const certs = await tx.cert.findMany({ where: { shipperId: id, deletedAt: null }, select: { id: true } });
    for (const cert of certs) {
      await auditedSoftDelete("cert", cert.id, why, tx);
    }

    await recomputeOrderStatus(tx, orderIds);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

// -------------------------------------------------------------------------------------------
// Task 18: the shipping ticket's print entry point (spec §10.1, §3.20). The traveler's three-layer
// shape, applied to shipments: `readShippingTicketData` (the reads, all on the caller's `db`),
// `buildShippingTicketDefinition` (pdf/shipping-ticket.ts — PURE), `renderPdf` (bytes). One sheet
// per order of the shipment in ONE PDF; a named order prints alone.
// -------------------------------------------------------------------------------------------

/** Every SETTING the ticket needs, read in one place BEFORE the print transaction opens — the
 *  `travelerSettings` precedent (traveler.ts, fix-wave R4 finding 8): settings are read-only and
 *  not shipment state, so the transaction below never waits on their round trips. */
export type TicketSettings = {
  company: { name: string; address: string; phone: string };
  liabilityText: string;
};

export async function ticketSettings(): Promise<TicketSettings> {
  const [name, address, phone, liabilityText] = await Promise.all([
    getSetting("company_name"),
    getSetting("company_address"),
    getSetting("company_phone"),
    getSetting("shipper_liability_text"),
  ]);
  return { company: { name, address, phone }, liabilityText };
}

/**
 * Assembles the print payload — one `TicketData` per order of the shipment, in ticket print order
 * (`ShipperOrder.position`, which `readShipperDetail` already sorts by), or just the named
 * order's. Reads EVERYTHING through `db` (the `readTravelerData` rule): inside `printShippingTickets`
 * that is the claim-holding `tx`, so every read sees the snapshot the claim covers and no second
 * pooled connection is borrowed mid-transaction.
 *
 * Address semantics (spec §10.1):
 *  - **Sold To** is the CUSTOMER (code in the corner, name on the first line) at their default
 *    `BILL_TO` address — default flag first, else the first live one, the traveler's
 *    RECEIVED_FROM idiom. Live-and-active only (`listAddresses`' own filter): "the customer's
 *    default BILL_TO" is a current fact, not a historical one.
 *  - **Ship To** is the shipment's own `shipToAddressId` row, read UNFILTERED on
 *    deletedAt/active — the shipment references it and the paper has to name where the truck
 *    went, whatever has happened to the address book since (the traveler's deliberately-unfiltered
 *    parts read, same reasoning). Its `name` is the destination's name (spec §3's closing note:
 *    a third-party consignee IS a named SHIP_TO address); blank name falls back to the customer.
 *    Its corner code prints empty — a `CustomerAddress` has no short code in this system, and a
 *    cuid is not paper (the sample's "73753" is Visual Shop's internal row id).
 */
export async function readShippingTicketData(
  db: Db, shipperId: string, settings: TicketSettings, orderId?: string,
): Promise<TicketData[]> {
  const detail = await readShipperDetail(db, shipperId); // 404s a missing shipment

  const orders = orderId === undefined ? detail.orders : detail.orders.filter((o) => o.orderId === orderId);
  if (orderId !== undefined && orders.length === 0) {
    throw new HttpError(404, "That order is not on this shipment");
  }

  const addresses = await listAddresses(detail.customerId, undefined, db);
  const billTos = addresses.filter((a) => a.kind === "BILL_TO");
  const billTo = billTos.find((a) => a.isDefault) ?? billTos[0] ?? null;
  const soldTo: TicketParty = {
    code: detail.customerCode, name: detail.customerName,
    street: billTo?.street ?? "", city: billTo?.city ?? "", state: billTo?.state ?? "", zip: billTo?.zip ?? "",
  };

  const shipToRow = detail.shipToAddressId === null ? null
    : await db.customerAddress.findFirst({ where: { id: detail.shipToAddressId } });
  const shipTo: TicketParty = {
    code: "",
    name: shipToRow !== null && shipToRow.name !== "" ? shipToRow.name : detail.customerName,
    street: shipToRow?.street ?? "", city: shipToRow?.city ?? "",
    state: shipToRow?.state ?? "", zip: shipToRow?.zip ?? "",
  };

  // Part DESCRIPTIONS in one batched read — `ShipperLineDetail` carries number and name already,
  // and the ticket's stacked part cell (spec §10.1) needs the third line too.
  const orderLineIds = [...new Set(orders.flatMap((o) => o.lines.map((l) => l.orderLineId)))];
  const descriptionRows = orderLineIds.length === 0 ? [] : await db.orderLine.findMany({
    where: { id: { in: orderLineIds } },
    select: { id: true, part: { select: { description: true } } },
  });
  const descriptionByLineId = new Map(descriptionRows.map((r) => [r.id, r.part.description]));

  return orders.map((o): TicketData => {
    // Weight summed in cents (the `toShipperRow` idiom) so 0.1 + 0.2 shapes never print as
    // 0.30000000000000004.
    let totalQty = 0;
    let weightCents = 0;
    for (const l of o.lines) {
      totalQty += l.qty;
      weightCents += Math.round(l.weight * 100);
    }
    return {
      company: { ...settings.company, liabilityText: settings.liabilityText },
      soldTo, shipTo,
      orderLabel: o.label, orderNumber: o.orderNumber,
      shipDate: detail.shipDate, poNumber: o.poNumber,
      packingListNo: detail.shipperNumber, customerJobNo: o.customerJobNo,
      route: detail.route, carrierName: detail.carrierName ?? "",
      lines: o.lines.map((l) => ({
        qty: l.qty, partNumber: l.partNumber, partName: l.partName,
        partDescription: descriptionByLineId.get(l.orderLineId) ?? "", pounds: l.weight,
      })),
      containers: o.containers.map((c) => ({
        typeName: c.typeName, count: c.count, customerContainerId: c.customerContainerId,
      })),
      serials: o.serials.filter((s) => s.printOnShipper).map((s) => ({ serial: s.serial, description: s.description })),
      // "every line on this ticket is lineComplete" (spec §10.1) — vacuously false for an order
      // shell with no lines yet: paper must not claim completeness nothing asserted.
      shippedComplete: o.lines.length > 0 && o.lines.every((l) => l.lineComplete),
      totalQty, totalWeight: weightCents / 100,
    };
  });
}

/**
 * Renders and archives the shipping ticket(s), returning the exact bytes stored — `printTraveler`'s
 * mechanic applied to a shipment (task-18-brief.md Step 4): settings OUTSIDE the transaction, then
 * one Serializable transaction bracketing claim → read → render → archive, so the stored PDF always
 * describes a fully-committed state no concurrent shipment edit can tear (traveler.ts's fix-wave R3
 * finding 1 reasoning, inherited wholesale).
 *
 * The claim is `claimOrdersInOrder` over every order on the shipment — `Shipper` has no row-lock
 * instrument of its own (claimLiveShipper's own comment); its mutators all serialize through the
 * orders' row locks, so holding those same locks is what makes this print's read/render/archive
 * atomic against them. The shipper row is re-read AFTER the claim and checked with `assertPrintable`
 * (documents.ts): a voided shipment refuses a NEW print with the shared 400 while every stored
 * print stays reprintable forever (spec §5.6) — deliberately NOT `claimLiveShipper`, whose 404
 * would misname a void as "not found".
 *
 * `orderNumber` rides along (null for the whole set) purely so the route can name the download —
 * the `printTraveler` precedent.
 */
export async function printShippingTickets(
  shipperId: string, orderId?: string,
): Promise<{ documentId: string; shipperNumber: number; orderNumber: number | null; pdf: Buffer }> {
  const settings = await ticketSettings();

  return withDbErrors({ entity: "Shipper" }, () => prisma.$transaction(async (tx) => {
    // The pre-claim read exists ONLY to learn which orders to claim (the addOrderToShipper
    // shape — some unlocked read is unavoidable when the lock lives on the orders); everything
    // acted on below is re-read under the claim.
    const stub = await tx.shipper.findFirst({ where: { id: shipperId }, select: { id: true } });
    if (!stub) throw new HttpError(404, "Shipment not found");
    await claimOrdersInOrder(tx, await shipperOrderIds(tx, shipperId));

    const shipper = await tx.shipper.findFirst({ where: { id: shipperId } });
    if (!shipper) throw new HttpError(404, "Shipment not found");
    assertPrintable(shipper);

    const data = await readShippingTicketData(tx, shipperId, settings, orderId);
    const pdf = await renderPdf(buildShippingTicketDefinition(data));

    const doc = await storeDocument(tx, { kind: "SHIPPER", shipperId, orderId: orderId ?? null }, pdf);
    return {
      documentId: doc.id, shipperNumber: shipper.shipperNumber,
      orderNumber: orderId === undefined ? null : data[0].orderNumber, pdf,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

// -------------------------------------------------------------------------------------------
// Task 19: the bill of lading (spec §10.2, §3.19/§3.20) — one per shipment, and it does not
// exist until someone prints one (the owner's Task 3 ruling, restated in §10.2): `bolNumber` is
// allocated lazily HERE, at first print, inside the claim-holding transaction, and never again.
// -------------------------------------------------------------------------------------------

/** Every SETTING the BOL needs, read BEFORE the print transaction opens (the ticketSettings
 *  precedent): the ship-from block is the company settings (spec §10.2). */
export type BolSettings = { company: { name: string; address: string } };

export async function bolSettings(): Promise<BolSettings> {
  const [name, address] = await Promise.all([
    getSetting("company_name"),
    getSetting("company_address"),
  ]);
  return { company: { name, address } };
}

/**
 * Assembles the BOL payload off the same claim-held `db` the print transaction passes (the
 * `readShippingTicketData` rule). `bolNumber` is the CALLER's — inside `printBol` it may have
 * been allocated a statement earlier in this same transaction, so it travels as an argument
 * rather than being re-derived from a read that could not be wrong but would be one more thing
 * to reason about.
 *
 * Consignee semantics (spec §10.2, §3's closing note): the shipment's own ship-to address, read
 * UNFILTERED on deletedAt/active — the paper has to name where the truck went, whatever has
 * happened to the address book since (the ticket's own rule). A blank name falls back to the
 * customer's, exactly as the ticket's Ship To does.
 */
export async function readBolData(
  db: Db, shipperId: string, bolNumber: number, settings: BolSettings,
): Promise<BolData> {
  const detail = await readShipperDetail(db, shipperId); // 404s a missing shipment

  const shipToRow = detail.shipToAddressId === null ? null
    : await db.customerAddress.findFirst({ where: { id: detail.shipToAddressId } });
  const consignee: BolParty = {
    name: shipToRow !== null && shipToRow.name !== "" ? shipToRow.name : detail.customerName,
    street: shipToRow?.street ?? "", city: shipToRow?.city ?? "",
    state: shipToRow?.state ?? "", zip: shipToRow?.zip ?? "",
  };

  // The shipment's total weight, summed in cents (the toShipperRow idiom) so 0.1 + 0.2 shapes
  // never print as 0.30000000000000004 on the freight table.
  let weightCents = 0;
  for (const so of detail.orders) {
    for (const l of so.lines) weightCents += Math.round(l.weight * 100);
  }

  return {
    company: settings.company,
    bolNumber,
    proNumber: detail.proNumber, scacCode: detail.scacCode,
    carrierName: detail.carrierName ?? "",
    shipDate: detail.shipDate,
    consignee,
    // Ticket print order (`ShipperOrder.position`, already how readShipperDetail sorts) — the
    // sample's own "TRV NO. 71955,71957,71959,71960,71961" list (§3.20).
    orderNumbers: detail.orders.map((o) => o.orderNumber),
    poNumbers: detail.orders.map((o) => o.poNumber),
    packageCount: detail.packageCount,
    freightDescription: detail.freightDescription,
    totalWeight: weightCents / 100,
    freightClass: detail.freightClass,
    freightTerms: detail.freightTerms,
  };
}

/**
 * Renders and archives the bill of lading, returning the exact bytes stored — the
 * `printShippingTickets` mechanic (settings outside, then ONE Serializable transaction bracketing
 * claim → re-read → assertPrintable → allocate → read-on-tx → render → archive), plus the one
 * thing only this print does: **`bolNumber` is allocated from `bol_number_next` on the first BOL
 * print only** (spec §3.19 — not every shipment gets a BOL, so allocating at shipment creation
 * would burn numbers), written through `auditedUpdate` so history records which print claimed
 * which number, and reused verbatim by every reprint. A voided shipment refuses a NEW print and
 * keeps its number forever (spec §5.6) — permanence is the absence of any write, the `voidShipper`
 * rule.
 */
export async function printBol(
  shipperId: string,
): Promise<{ documentId: string; bolNumber: number; shipperNumber: number; pdf: Buffer }> {
  const settings = await bolSettings();

  return withDbErrors({ entity: "Shipper" }, () => prisma.$transaction(async (tx) => {
    // Pre-claim stub read only to learn which orders to claim (the printShippingTickets shape).
    const stub = await tx.shipper.findFirst({ where: { id: shipperId }, select: { id: true } });
    if (!stub) throw new HttpError(404, "Shipment not found");
    await claimOrdersInOrder(tx, await shipperOrderIds(tx, shipperId));

    const shipper = await tx.shipper.findFirst({ where: { id: shipperId } });
    if (!shipper) throw new HttpError(404, "Shipment not found");
    assertPrintable(shipper);

    let bolNumber = shipper.bolNumber;
    if (bolNumber === null) {
      bolNumber = await allocateNumber("bol_number_next", tx);
      const allocated = bolNumber;
      await auditedUpdate("shipper", shipperId,
        () => tx.shipper.update({ where: { id: shipperId }, data: { bolNumber: allocated } }), { tx });
    }

    const data = await readBolData(tx, shipperId, bolNumber, settings);
    const pdf = await renderPdf(buildBolDefinition(data));

    const doc = await storeDocument(tx, { kind: "BOL", shipperId }, pdf);
    return { documentId: doc.id, bolNumber, shipperNumber: shipper.shipperNumber, pdf };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * The cert=1 half of the shipment print action (spec §3.14, §9; task-19-brief.md Step 6):
 * resolves which certification prints alongside each covered order's ticket, WITHOUT printing
 * anything — the route prints the tickets and then each cert through `printCert` (certs.ts), so
 * each PDF is produced and stored as its own document exactly as §3.14 rules.
 *
 * "Each covered order's cert" resolves through the order's own frozen `certScope` (§6.1's
 * freeze is what makes this well-defined):
 *  - SHIPMENT — that order's live cert pinned to THIS shipment;
 *  - ORDER    — that order's live order-scope cert;
 *  - LOAD     — every live load-scope cert the order has (a shipment cannot know which loads went,
 *    and load certs exist only on demand, §3.17).
 *
 * An order that REQUIRES a cert (its frozen `certRequired`) with nothing to print gets a named
 * WARNING, never a refusal (§9 amendment 2026-08-05, owner-ratified — §3.13's "a missing cert
 * warns and never blocks", honored in the default pre-ticked flow): the tickets print and archive
 * exactly as a cert-less print would, no cert is archived for that order, and the warning names
 * it so the shipment page can surface the gap to the operator — never a silent drop (the Task 18
 * rule the original refusal over-served). Orders that DO have certs on the same request still
 * print theirs. An order that doesn't require one and has none simply contributes nothing. A
 * voided shipment refuses here with the shared refusal, BEFORE any ticket could print — its
 * ORDER-scope certs are still live (only shipment-scope certs are voided with the shipment, spec
 * §5.6), so without this check a voided shipment's print could still archive cert paper.
 */
export async function printableShipmentCertIds(
  shipperId: string, orderId?: string,
): Promise<{ certIds: string[]; warnings: string[] }> {
  const shipper = await prisma.shipper.findFirst({ where: { id: shipperId }, select: { deletedAt: true } });
  if (!shipper) throw new HttpError(404, "Shipment not found");
  assertPrintable(shipper);

  const shipperOrders = await prisma.shipperOrder.findMany({
    where: { shipperId, ...(orderId ? { orderId } : {}) },
    orderBy: { position: "asc" },
    select: {
      orderId: true,
      order: { select: { id: true, orderNumber: true, certRequired: true, certScope: true } },
    },
  });
  if (orderId !== undefined && shipperOrders.length === 0) {
    throw new HttpError(404, "That order is not on this shipment");
  }

  const certIds: string[] = [];
  const warnings: string[] = [];
  for (const so of shipperOrders) {
    const scope = so.order.certScope as CertScopeValue;
    const certs = await prisma.cert.findMany({
      where: {
        orderId: so.orderId, scope, deletedAt: null,
        ...(scope === "SHIPMENT" ? { shipperId } : {}),
      },
      orderBy: [{ loadNumber: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    if (certs.length === 0 && so.order.certRequired) {
      // The saveNewShipper §5.7 warning's own shape, adapted to the print moment.
      warnings.push(
        `Order #${so.order.orderNumber} requires a certification and none exists to print — ` +
        `its ticket printed without one; create it from /orders/${so.order.id}`);
    }
    certIds.push(...certs.map((c) => c.id));
  }
  return { certIds, warnings };
}

// -------------------------------------------------------------------------------------------
// Listing, export and the order-hub view (task-9-brief.md Step 4) — `use-latest`-friendly (pure
// data, no `tx`), `includeVoided` defaulting off (spec §5c's precedent), search over the
// packing-list number, BOL number, order number and customer code.
// -------------------------------------------------------------------------------------------

export type ShipperFilter = { customerId?: string; from?: string; to?: string; includeVoided?: boolean; search?: string };
export type ShipperRow = {
  id: string; shipperNumber: number; bolNumber: number | null; customerCode: string; customerName: string;
  shipDate: string; orderCount: number; orderLabels: string[]; carrierName: string | null;
  totalQty: number; totalWeight: number; freightAmount: number | null; deletedAt: string | null;
};

const ROW_SELECT = {
  id: true, shipperNumber: true, bolNumber: true, shipDate: true, freightAmount: true, deletedAt: true,
  customer: { select: { code: true, name: true } },
  carrier: { select: { name: true } },
  orders: {
    // Deterministic order for `orderLabels` — the issue #24 lesson applied here too: an
    // unordered collection makes a multi-order shipment's label list depend on Postgres's own
    // scan order rather than the print order the operator actually sees (DETAIL_INCLUDE's own
    // `orderBy: { position: "asc" }`, reused).
    orderBy: { position: "asc" },
    select: {
      sequence: true,
      order: { select: { orderNumber: true } },
      lines: { select: { qty: true, weight: true } },
    },
  },
} satisfies Prisma.ShipperSelect;

type ShipperRowShape = Prisma.ShipperGetPayload<{ select: typeof ROW_SELECT }>;

function toShipperRow(row: ShipperRowShape): ShipperRow {
  const orderLabels = row.orders.map((o) => `${o.order.orderNumber}-${o.sequence}`);
  let totalQty = 0;
  let weightCents = 0;
  for (const so of row.orders) {
    for (const l of so.lines) {
      totalQty += l.qty;
      weightCents += Math.round(l.weight.toNumber() * 100);
    }
  }
  return {
    id: row.id, shipperNumber: row.shipperNumber, bolNumber: row.bolNumber,
    customerCode: row.customer.code, customerName: row.customer.name,
    shipDate: formatDateOnly(row.shipDate), orderCount: row.orders.length, orderLabels,
    carrierName: row.carrier?.name ?? null,
    totalQty, totalWeight: weightCents / 100,
    freightAmount: num(row.freightAmount), deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

function shipperSearchWhere(term: string): Prisma.ShipperWhereInput[] {
  const clauses: Prisma.ShipperWhereInput[] = [
    { customer: { code: { contains: term, mode: "insensitive" } } },
  ];
  // shipperNumber/bolNumber/orderNumber are Int4 columns (the orders.ts `searchWhere` precedent):
  // a longer digit string is not a value they can hold, and handing it to Prisma is a validation
  // error, not "no match".
  const asNumber = Number(term);
  if (/^\d+$/.test(term) && Number.isSafeInteger(asNumber) && asNumber <= 2_147_483_647) {
    clauses.push({ shipperNumber: asNumber });
    clauses.push({ bolNumber: asNumber });
    clauses.push({ orders: { some: { order: { orderNumber: asNumber } } } });
  }
  return clauses;
}

function shipperListWhere(filter: ShipperFilter): Prisma.ShipperWhereInput {
  const term = filter.search?.trim();
  const shipDate = filter.from || filter.to ? {
    ...(filter.from ? { gte: parseDate(filter.from, "Ship date from") } : {}),
    ...(filter.to ? { lte: parseDate(filter.to, "Ship date to") } : {}),
  } : undefined;
  return {
    // Voided shipments leave the list unless the toggle is on (spec §5c's precedent).
    ...(filter.includeVoided ? {} : { deletedAt: null }),
    ...(filter.customerId ? { customerId: filter.customerId } : {}),
    ...(shipDate ? { shipDate } : {}),
    ...(term ? { OR: shipperSearchWhere(term) } : {}),
  };
}

/** Newest ship date first, `shipperNumber` (unique) tie-broken — two shipments sharing a ship date
 *  still sort deterministically (the `readAudit` precedent, audit.ts). */
export async function listShippers(filter: ShipperFilter): Promise<ShipperRow[]> {
  const rows = await prisma.shipper.findMany({
    where: shipperListWhere(filter), select: ROW_SELECT, orderBy: [{ shipDate: "desc" }, { shipperNumber: "desc" }],
  });
  return rows.map(toShipperRow);
}

const SHIPPER_COLUMNS = [
  { key: "shipperNumber", header: "Packing List No" },
  { key: "bolNumber", header: "BOL No" },
  { key: "customerCode", header: "Customer code" },
  { key: "customerName", header: "Customer name" },
  { key: "shipDate", header: "Ship date" },
  { key: "orderLabels", header: "Orders" },
  { key: "carrierName", header: "Carrier" },
  { key: "totalQty", header: "Qty" },
  { key: "totalWeight", header: "Weight" },
  { key: "freightAmount", header: "Freight amount" },
  { key: "voided", header: "Voided" },
];

/** Exactly what `listShippers` returned for the same filter — same query, same rows, humanized
 *  cells (the `exportCerts`/`exportOrders` precedent). */
export async function exportShippers(filter: ShipperFilter): Promise<Buffer> {
  const rows = await listShippers(filter);
  const xlsxRows = rows.map((r) => ({ ...r, orderLabels: r.orderLabels.join(", "), voided: r.deletedAt ? "yes" : "no" }));
  return toXlsx("Shipments", SHIPPER_COLUMNS, xlsxRows as unknown as Record<string, unknown>[]);
}

/** Every shipment that has ever carried this order, voided included — the order hub's own
 *  "Shipments" section needs to see a voided shipment too, not have it silently vanish (the
 *  `certsForOrder` precedent, certs.ts). */
export async function shipmentsForOrder(orderId: string): Promise<ShipperRow[]> {
  const rows = await prisma.shipper.findMany({
    where: { orders: { some: { orderId } } },
    select: ROW_SELECT, orderBy: [{ shipDate: "desc" }, { shipperNumber: "desc" }],
  });
  return rows.map(toShipperRow);
}
