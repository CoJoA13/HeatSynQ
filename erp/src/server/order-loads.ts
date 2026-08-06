import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedUpdate } from "./audit";
import { decimalField } from "./decimal-field";
import { MAX_LOADS } from "../lib/load-split";
import { INT4_MAX } from "../lib/order-constants";
import {
  type OrderDetail, type OrderWarnings,
  readDetail, trafficSettings, loadsMismatchWarnings, lineTotals, runSplitLoads,
} from "./orders";
import { claimOrder } from "./order-locks";

// -------------------------------------------------------------------------------------------
// Task 6: the loads service — bulk load edit/renumber and re-split (spec §5.4/§12.9). Both
// mutators share orders.ts's own mutator shape exactly: `withDbErrors` -> Serializable
// `$transaction` -> `findFirst({ id, deletedAt: null })` (404 "Order not found" — a voided order
// is read-only, same as every mutator in orders.ts) -> `auditedUpdate("order", orderId, doIt,
// { tx })`. `order`'s `SNAPSHOT_INCLUDE` (audit.ts) already pulls `loads` ordered by loadNumber,
// so the automatic before/after diff `auditedUpdate` takes needs no hand-built payload here.
// -------------------------------------------------------------------------------------------

/**
 * One row of a `replaceLoads` bulk PUT, post-validation/normalization — `qty`/`weight` coerced
 * from zod's `T | null | undefined` down to `T | null` (the `CONTAINER_ITEM`/`c.qty ?? null`
 * precedent, orders.ts). No `id`: a caller can't name an existing Load row, so `applyLoads` below
 * matches input rows to existing rows by ARRAY POSITION instead (both ordered by loadNumber).
 */
export type LoadInput = { loadNumber: number; qty: number | null; weight: number | null };

// Fix-wave R3 finding 3: `weight` is bounded `nonnegative`, not `positive` — cumulative-rounding
// auto-splits legitimately produce 0-weight loads whenever the row also carries a qty (spec
// §5.4's own splitLoads, load-split.test.ts's counter-example: totalQty=5/totalWeight=0.03 at a
// 1-piece cap rounds to per-load weights [0.01, 0, 0.01, 0, 0.01]). Rejecting weight === 0
// unconditionally meant that legal auto-split could never be re-saved once loaded back into the
// bulk editor. The `superRefine` below still refuses a WEIGHT-ONLY row (qty null) at exactly
// zero — there is nothing else on that row for a positive weight to describe.
// Fix-wave R4 finding 4: the same `.max()` treatment `qty` gets just below, applied to the
// ARRAY. `createOrder`'s auto-split already refuses to produce more than `MAX_LOADS` loads
// (runSplitLoads, translated into a clean 400) — but that cap lived entirely on the SPLIT path,
// so the manual bulk replace could set a load count no split would ever generate, one INSERT per
// row inside a single Serializable transaction. Bounded here, before the transaction opens, with
// the cap named in the message: a refusal has to say what the limit actually is.
const MAX_LOADS_MESSAGE =
  `An order cannot have more than ${MAX_LOADS.toLocaleString("en-US")} loads`;

// Fix-wave R4 finding 3: `Load.qty` is a Postgres `INTEGER` (schema.prisma) — a value past its
// ceiling escaped this schema's field-anchored 400 as an unmapped numeric-overflow 500 from
// inside the transaction. The auto-split path could never produce one (splitLoads divides a
// bounded line qty), so the hole was only ever reachable through this manual editor. Same bound,
// same reasoning, as orders.ts's own container count/qty fields.
const LOAD_ITEM = z.object({
  loadNumber: z.number().int().min(1),
  qty: z.number().int().min(1).max(INT4_MAX).nullable().optional(),
  weight: decimalField(12, 2, { min: "nonnegative" }),
}).strict().superRefine((row, ctx) => {
  if (row.qty == null && row.weight == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Each load needs a qty, a weight, or both" });
    return;
  }
  if (row.qty == null && row.weight === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["weight"],
      message: "A weight-only load needs a weight greater than zero",
    });
  }
});

const REPLACE_LOADS = z.array(LOAD_ITEM).min(1).max(MAX_LOADS, MAX_LOADS_MESSAGE);

/**
 * The SET of `loadNumber`s must be exactly {1, ..., N} — no gaps, no repeats — so the board's
 * load count always matches what it can enumerate. A manual post-parse check rather than a zod
 * `.refine()` on the array: the target set size IS the array's own length, which a per-item
 * refine has no way to see, and the `reorderSteps` "must list every step exactly once" 400
 * (part-process-steps.ts) is the precedent for doing this kind of whole-array check by hand.
 */
function assertContiguousLoadNumbers(rows: { loadNumber: number }[]): void {
  const numbers = new Set(rows.map((r) => r.loadNumber));
  const isContiguous = numbers.size === rows.length && [...numbers].every((n) => n >= 1 && n <= rows.length);
  if (!isContiguous) throw new HttpError(400, "Load numbers must be 1..N with no gaps or repeats");
}

/**
 * Writes `loads` as the order's complete Load collection, preferring in-place UPDATEs over
 * delete-then-recreate: existing rows (fetched ordered by their CURRENT loadNumber) are matched
 * to `loads` by array position and rewritten onto their new loadNumber/qty/weight; a longer
 * `loads` creates the surplus, a shorter one deletes the remainder.
 *
 * Two-phase against `@@unique([orderId, loadNumber])` — the `reorderSteps` precedent
 * (part-process-steps.ts): every surviving row is first parked at a unique NEGATIVE loadNumber
 * (index-derived, so distinct by construction), and only then rewritten to its real target. A
 * direct swap (e.g. two loads trading numbers 1 and 3) would violate the unique index on the
 * FIRST update statement without this — Postgres checks a non-deferrable unique constraint at the
 * end of each statement, not at commit, so "row 1 -> 3" fails immediately while row 3 (not yet
 * moved) still holds the number being claimed.
 *
 * Trusts its caller: `loads` must already be a validated permutation of 1..loads.length
 * (`assertContiguousLoadNumbers`) — this function does not re-check it.
 */
async function applyLoads(tx: Prisma.TransactionClient, orderId: string, loads: LoadInput[]): Promise<void> {
  const existing = await tx.load.findMany({
    where: { orderId }, orderBy: { loadNumber: "asc" }, select: { id: true },
  });

  for (const [index, row] of existing.entries()) {
    await tx.load.update({ where: { id: row.id }, data: { loadNumber: -(index + 1) } });
  }
  for (const [index, item] of loads.entries()) {
    if (index < existing.length) {
      await tx.load.update({
        where: { id: existing[index].id },
        data: { loadNumber: item.loadNumber, qty: item.qty, weight: item.weight },
      });
    } else {
      await tx.load.create({
        data: { orderId, loadNumber: item.loadNumber, qty: item.qty, weight: item.weight },
      });
    }
  }
  if (existing.length > loads.length) {
    await tx.load.deleteMany({ where: { id: { in: existing.slice(loads.length).map((r) => r.id) } } });
  }
}

/**
 * Sum-mismatch (Task 5's `loadsMismatchWarnings`, reused verbatim) plus the traveler-reprint
 * notice (spec §3.3): loads stay editable after a traveler prints (owner ruling), but a stored
 * traveler describes the loads as they were at print time, so any edit after that needs a nudge
 * to reprint. `order.travelerPrinted` is already "a TRAVELER StoredDocument exists for this
 * order" — `readDetail`'s own derivation off a kind-filtered `documents` existence check — so no
 * separate query is needed here to answer "has a traveler printed". Never blocks either mutator.
 */
function buildLoadWarnings(order: OrderDetail): OrderWarnings {
  const warnings = loadsMismatchWarnings(order);
  if (order.travelerPrinted) warnings.push("A traveler has already printed — print a fresh one");
  return warnings;
}

/**
 * Bulk PUT of the order's loads (spec §5.4): a manual edit or renumber, independent of the
 * order's line totals — `buildLoadWarnings` is what tells the operator the two have drifted,
 * never a refusal to save. Each row needs a `loadNumber` and at least a `qty` or a `weight` (or
 * both); the full set of numbers must be exactly 1..N.
 */
export async function replaceLoads(
  orderId: string, input: unknown,
): Promise<{ order: OrderDetail; warnings: OrderWarnings }> {
  const parsed = REPLACE_LOADS.parse(input);
  assertContiguousLoadNumbers(parsed);
  const loads: LoadInput[] = parsed.map((r) => (
    { loadNumber: r.loadNumber, qty: r.qty ?? null, weight: r.weight ?? null }));

  const traffic = await trafficSettings();
  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await claimOrder(tx, orderId);
    if (!order || order.deletedAt !== null) throw new HttpError(404, "Order not found");

    await auditedUpdate("order", orderId, () => applyLoads(tx, orderId, loads), { tx });

    const detail = await readDetail(tx, orderId, traffic);
    return { order: detail, warnings: buildLoadWarnings(detail) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * Re-splits from scratch (spec §5.4): the order's CURRENT line totals (Σqty/Σweight over every
 * line, lead and riders alike — `lineTotals`, the exact helper and cents-exact technique
 * `createOrder` uses) against the LEAD part's CURRENT `loadQty`/`loadWeight` caps, read fresh
 * from `Part` here rather than trusted from whatever they were at order-creation time — a cap
 * edited on the part since the order was placed is exactly what a re-split is for. Same
 * `splitLoads` call `createOrder` makes, written with the same `applyLoads` two-phase rewrite
 * `replaceLoads` uses, so the result always sums to the order exactly: no sum-mismatch warning
 * can survive a resplit, only the traveler-reprint notice can still apply.
 */
export async function resplitLoads(orderId: string): Promise<{ order: OrderDetail; warnings: OrderWarnings }> {
  const traffic = await trafficSettings();
  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await claimOrder(tx, orderId);
    if (!order || order.deletedAt !== null) throw new HttpError(404, "Order not found");

    const orderLines = await tx.orderLine.findMany({
      where: { orderId }, orderBy: { position: "asc" }, select: { partId: true, qty: true, weight: true },
    });

    // Position 1 is always the lead (createOrder's own invariant; removeLine refuses to remove
    // it) — its loadQty/loadWeight are the caps every split (auto or re-) honors, never a rider's.
    const lead = await tx.part.findFirst({
      where: { id: orderLines[0].partId }, select: { loadQty: true, loadWeight: true },
    });
    // Unreachable in practice — OrderLine.partId is ON DELETE RESTRICT, so the row can never be
    // hard-deleted out from under a line, only soft-deleted, and this lookup has no `deletedAt`
    // filter — but an explicit message beats a silent 500 if that invariant is ever broken.
    if (!lead) throw new HttpError(400, "The lead part no longer exists");

    // Prisma returns a raw select's Decimal column as `Decimal`, not `number` — readDetail's
    // toDetail() is what normally does this conversion, but re-reading the full detail just to
    // get line totals would be wasteful, so it happens here on this narrow select instead.
    const lines = orderLines.map((l) => ({ qty: l.qty, weight: l.weight.toNumber() }));
    const computed = runSplitLoads({
      ...lineTotals(lines),
      loadQty: lead.loadQty,
      loadWeight: lead.loadWeight === null ? null : lead.loadWeight.toNumber(),
    });
    const loads: LoadInput[] = computed.map((l, i) => ({ loadNumber: i + 1, qty: l.qty, weight: l.weight }));

    await auditedUpdate("order", orderId, () => applyLoads(tx, orderId, loads), { tx });

    const detail = await readDetail(tx, orderId, traffic);
    return { order: detail, warnings: buildLoadWarnings(detail) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
