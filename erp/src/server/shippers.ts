import { z } from "zod";
import { Prisma, type Order } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";
import { allocateNumber } from "./settings";
import { claimOrdersInOrder } from "./order-locks";
import { shippedTotals, recomputeOrderStatus, nextShipmentSequence, type ShippedTotal } from "./ship-ledger";
import { createCert } from "./certs";
import { INT4_MAX, isDuplicateClientRequestId } from "./orders";
import { parseDateOnly, formatDateOnly } from "../lib/business-days";
import { FREIGHT_TERMS, type FreightTermsValue } from "../lib/cert-constants";

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
export type ShipperOrderDetail = {
  id: string; orderId: string; orderNumber: number; sequence: number; position: number;
  poNumber: string; customerJobNo: string; label: string;
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
  comments: z.string().max(2000).default(""),
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
      order: { select: { orderNumber: true, poNumber: true, customerJobNo: true } },
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
  const orderLineIds = row.orders.flatMap((o) => o.lines.map((l) => l.orderLineId));
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
  data: CreateShipperInput, opts: { canOverrideCreditHold: boolean },
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

    for (const o of data.orders) {
      const order = ordersById.get(o.orderId)!;
      for (const l of o.lines) {
        const line = lineById.get(l.orderLineId);
        if (!line || line.orderId !== o.orderId) {
          throw new HttpError(400, `Order #${order.orderNumber}: that line does not belong to this order`);
        }
      }
      for (const c of o.containers) {
        const container = containerById.get(c.orderContainerId);
        if (!container || container.orderId !== o.orderId) {
          throw new HttpError(400, `Order #${order.orderNumber}: that container does not belong to this order`);
        }
      }
      for (const s of o.serials) {
        const serial = serialById.get(s.orderSerialId);
        if (!serial || serial.orderId !== o.orderId) {
          throw new HttpError(400, `Order #${order.orderNumber}: that serial does not belong to this order`);
        }
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

    const shipDate = parseDate(data.shipDate, "Ship date");

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

  // A shipment about nothing is not a shipment (spec §4.2) — checked ahead of the transaction
  // since it is pure input validation with no DB dependency.
  const anyPositiveQty = data.orders.some((o) => o.lines.some((l) => l.qty > 0));
  if (!anyPositiveQty) throw new HttpError(400, "A shipment needs at least one line with a positive quantity");

  return withDbErrors({ entity: "Shipper", conflictField: "shipper number" }, async () => {
    try {
      return await saveNewShipper(data, opts);
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
