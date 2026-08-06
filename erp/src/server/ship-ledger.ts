// The ship ledger (spec §5.1/§5.2/§5.3): shipped-to-date, order-status derivation, and the
// per-order shipment sequence. Deliberately independent of `shippers.ts` (Task 8) — that service
// will call every export here, but nothing here knows it exists (the task-7-brief.md fixtures
// note applies to this file's own design, not just its tests): the arithmetic and the locking
// discipline are the foundation, not a detail of whichever route ends up calling them.
import { Prisma, type OrderStatus } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { auditedUpdate } from "./audit";

type Db = typeof prisma | Prisma.TransactionClient;

export type ShippedTotal = { qty: number; weight: number };

/**
 * Sum of `qty`/`weight` across every LIVE shipper line for each of `orderLineIds` (spec §5.1) — a
 * voided shipment (`Shipper.deletedAt` set) contributes nothing. `ShipperOrder`/`ShipperLine`
 * themselves carry no `deletedAt` of their own (spec §4.2: "shipment children have no deletedAt,
 * same reasoning as the cert's") — voidedness lives on the `Shipper` alone, so the live filter
 * reaches it through the one relation that connects a line back to its shipment.
 *
 * This is the ONE derivation spec §5.1 calls out as "used everywhere": the ship-now prefill
 * (`ordered - shipped`, editable), the over-ship warning, and the edit invariants Task 10
 * enforces (removing a line, or shrinking its qty/weight below shipped-to-date). Every one of
 * those callers reads through this function rather than re-deriving the sum, so "a voided
 * shipment contributes nothing" only has to be true in one place.
 *
 * A line with no live shipment at all has NO entry in the returned map (there is nothing to sum) —
 * callers that need a default treat a missing key as `{ qty: 0, weight: 0 }`, the same sparse-map
 * shape `certs.ts`'s own `sequenceMap` uses for the identical reason.
 */
export async function shippedTotals(db: Db, orderLineIds: string[]): Promise<Map<string, ShippedTotal>> {
  const totals = new Map<string, ShippedTotal>();
  if (orderLineIds.length === 0) return totals;

  const rows = await db.shipperLine.findMany({
    where: { orderLineId: { in: orderLineIds }, shipperOrder: { shipper: { deletedAt: null } } },
    select: { orderLineId: true, qty: true, weight: true },
  });

  // Weight accumulates in INTEGER CENTS and divides once at the end (the `toShipperRow` idiom,
  // shippers.ts — weights are Decimal(12,2), so cents are exact): summing `toNumber()` floats made
  // 0.10 + 0.20 come back as 0.30000000000000004, and since this is the ONE §5.1 derivation every
  // caller reads, that artifact turned `updateLine`'s §5.5 guard into a hard false REFUSAL of a
  // legal edit-to-exactly-shipped, made `overshipWarnings` flag exactly-complete lines, and printed
  // the raw float in refusal text (fix-wave 2026-08-06, whole-branch review Important #2). `qty` is
  // an int and needs nothing.
  const cents = new Map<string, { qty: number; weightCents: number }>();
  for (const row of rows) {
    const prev = cents.get(row.orderLineId) ?? { qty: 0, weightCents: 0 };
    cents.set(row.orderLineId, {
      qty: prev.qty + row.qty,
      weightCents: prev.weightCents + Math.round(row.weight.toNumber() * 100),
    });
  }
  for (const [orderLineId, t] of cents) {
    totals.set(orderLineId, { qty: t.qty, weight: t.weightCents / 100 });
  }
  return totals;
}

/**
 * OPEN | PARTIAL_SHIPPED | SHIPPED per spec §5.2 — quantities never enter this decision, only
 * `ShipperLine.lineComplete`, the human's own call (spec §7.3, HANDOFF §3):
 *
 * - no live shipper lines for the order -> OPEN
 * - EVERY order line has at least one live shipper line with `lineComplete = true` -> SHIPPED
 *   (order lines carry no `deletedAt` of their own — P3 §4 — so every line of the order counts)
 * - otherwise -> PARTIAL_SHIPPED
 *
 * Recomputed inside the SAME transaction as every shipment mutation, for every affected order,
 * and also whenever an order's own line set changes (orders.ts's `addLine`/`updateLine`/
 * `removeLine`, Task 8's shipment create/void) — the caller is expected to already hold each
 * order's row claim (`claimOrder`/`claimOrdersInOrder`, order-locks.ts) before calling this; it
 * does no claiming of its own.
 *
 * Voided orders (`deletedAt !== null`) are skipped outright — voidedness stays orthogonal to
 * status (P3 §4), and `INVOICED`/`REOPENED` are unreachable in Phase 4, so the only two writable
 * values this function ever produces are `OPEN`/`PARTIAL_SHIPPED`/`SHIPPED`. Written through
 * `auditedUpdate` like every other mutation in this codebase (CLAUDE.md: "this phase adds no new
 * audit exceptions") and ONLY when the derived status actually differs from the stored one, so a
 * line edit that cannot possibly move the needle (spec §5.2's quantity-only case) never writes a
 * no-op "update" entry.
 */
export async function recomputeOrderStatus(tx: Prisma.TransactionClient, orderIds: string[]): Promise<void> {
  const ids = [...new Set(orderIds)];
  if (ids.length === 0) return;

  const orders = await tx.order.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, status: true, lines: { select: { id: true } } },
  });
  if (orders.length === 0) return;

  // One query for every affected order's lines, not one per order — the `resolveCertSettings`
  // precedent (certs.ts) for avoiding an N+1 when a multi-order shipment recomputes several
  // orders' statuses in the same transaction.
  const allLineIds = orders.flatMap((o) => o.lines.map((l) => l.id));
  const shipperLines = allLineIds.length === 0 ? [] : await tx.shipperLine.findMany({
    where: { orderLineId: { in: allLineIds }, shipperOrder: { shipper: { deletedAt: null } } },
    select: { orderLineId: true, lineComplete: true },
  });

  const linesWithLiveShipment = new Set<string>();
  const linesComplete = new Set<string>();
  for (const row of shipperLines) {
    linesWithLiveShipment.add(row.orderLineId);
    if (row.lineComplete) linesComplete.add(row.orderLineId);
  }

  for (const order of orders) {
    const lineIds = order.lines.map((l) => l.id);
    const anyLive = lineIds.some((id) => linesWithLiveShipment.has(id));
    const status: OrderStatus = !anyLive
      ? "OPEN"
      : lineIds.every((id) => linesComplete.has(id))
        ? "SHIPPED"
        : "PARTIAL_SHIPPED";

    if (status === order.status) continue;
    await auditedUpdate(
      "order", order.id,
      () => tx.order.update({ where: { id: order.id }, data: { status } }),
      { tx },
    );
  }
}

/**
 * `max(sequence) + 1` over EVERY `ShipperOrder` row for this order (spec §3.19/§5.3) — deliberately
 * NO live filter. `ShipperOrder.sequence` is the "-3" in "72036-3", allocated once and never
 * reused: `Shipper` carries `deletedAt` but `ShipperOrder` does not (spec §4.2), so a voided
 * shipment's rows are still counted here, exactly as the brief requires — a number already
 * printed on a customer's paperwork must never be handed out twice. The caller is expected to
 * already hold the order's row claim (`claimOrder`/`claimOrdersInOrder`) before calling this, the
 * same discipline `allocateNumber` leans on for every other counter in this codebase.
 */
export async function nextShipmentSequence(tx: Prisma.TransactionClient, orderId: string): Promise<number> {
  const { _max } = await tx.shipperOrder.aggregate({ where: { orderId }, _max: { sequence: true } });
  return (_max.sequence ?? 0) + 1;
}
