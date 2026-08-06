// Order-row locks, alone in their own leaf module (the `errors.ts` precedent — Phase 2A pulled
// `HttpError` out here for the identical reason: `settings.ts` -> `http.ts` -> `sessions.ts` ->
// `settings.ts` was a real cycle, safe only because every crossing export was a hoisted `function`
// declaration). Task 5 created the same shape between `orders.ts` and `certs.ts`
// (`certs.ts` imports `claimOrder`; `orders.ts` imports `resolveCertSettings`/`createCert` back)
// and Tasks 7/8 were both about to widen it further (`shippers.ts` needs `claimOrdersInOrder` AND
// `createCert`; `orders.ts` needs `shipmentBlockers` back from `shippers.ts` for spec §5.5). Moving
// the claim itself here — importing nothing but the db types and the zero-import `errors.ts` leaf —
// means every order-family service (`orders.ts`, `certs.ts`, `attachments.ts`, `order-loads.ts`,
// `traveler.ts`, and Task 8's `shippers.ts`) can depend on the lock without depending on each
// other through it.
//
// Task 7 review (2026-08-04) found the identical shape one file over: `cert-results.ts` imported
// `claimCertsOrder`/`readCertDetail` from `certs.ts`, while `certs.ts` imported `seedRequirements`
// back — safe only because every crossing export was, again, a hoisted `function`. `claimCertsOrder`
// moved here (a lock helper belongs beside the lock it wraps); `readCertDetail` moved into
// `cert-results.ts` itself instead, since certs.ts is no longer in a position to host it.
//
// HOUSE RULE (whole-branch review, 2026-08-06): **the guarded state must live on, or be locked
// with, the claimed row.** The Order row's claim protects `Order.deletedAt` only because
// `voidOrder` writes that very row; the moment a claim guards state on a DIFFERENT row (a Cert's
// or Shipper's own `deletedAt`), the post-claim re-read is only fresh if that row is locked too —
// at Serializable the snapshot is fixed at the transaction's first read, so blocking on the Order
// lock and then re-reading the other row sees a pre-void world, and SSI cannot be relied on to
// abort it (Postgres only serializes transactions that are ALL Serializable, and a print's
// StoredDocument insert conflicts with nothing a void touches). Hence `claimCertsOrder` below also
// takes FOR UPDATE on the Cert row, and shippers.ts's `claimLiveShipper`/print paths do the same
// for the Shipper row — uniformly AFTER the order claims (one fixed order: Order rows first, then
// the entity's own row), so no new ABBA window opens. Phase 5's reversing shipments will need this
// rule again.
import type { Prisma, Order } from "../../prisma/generated/prisma/client";
import { HttpError } from "./errors";

type Db = Prisma.TransactionClient;

/**
 * Claims the Order row for the rest of the caller's OWN transaction — the ONE shared instrument
 * every order-family mutator (orders.ts), order-loads.ts's two mutators, attachments.ts's
 * order-owner writes, certs.ts's `claimCertsOrder`, and traveler.ts's `printTraveler` open their
 * order-resolution step with.
 *
 * Fix-wave R3 finding 1: before this helper existed, only `printTraveler`'s own inline claim (and,
 * incidentally, `voidOrder`'s own row UPDATE) ever took a lock here — every child mutator
 * (`replaceLoads`, `addLine`, `replaceContainers`, …) resolved the order with a plain, UNLOCKED
 * `findFirst`. That let a child edit commit in the gap between `printTraveler`'s content read
 * (`collectTravelerData`) and its archive commit, so the stored traveler could describe pre-edit
 * state with no warning possible — from the archive's own point of view nothing was wrong, the
 * document simply didn't exist yet when the stale read happened.
 *
 * Raw because Prisma has no `FOR UPDATE` of its own (the `workingRevision` precedent,
 * part-process-steps.ts) — id only, since the full row is read back through the ordinary client
 * immediately below, once the lock is actually held. A row lock is the right instrument
 * regardless of isolation level (restated here for the Order row, generalizing `workingRevision`'s
 * own reasoning): whichever caller — a print, or any edit below — reaches this claim first makes
 * every other one wait until it commits or rolls back, so a child mutation can never commit
 * invisibly while a traveler render is reading this same order, and a print can never archive a
 * stale, pre-edit snapshot while an edit is mid-flight either. Returns the full row (or `null` for
 * an id that does not exist) so every call site can read off whatever scalar it needs —
 * `deletedAt`, `customerId`, `linkGroupId`, … — without a second round trip; callers still decide
 * for themselves whether a voided (`deletedAt !== null`) row counts as "not found" for their own
 * purpose, exactly as every mutator already did with its own `findFirst({ deletedAt: null })`.
 */
export async function claimOrder(tx: Db, orderId: string): Promise<Order | null> {
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
  return tx.order.findFirst({ where: { id: orderId } });
}

/**
 * Deduplicated, ascending. Exported on its own (spec §5.3's plan, "assert the ordering directly")
 * because `claimOrdersInOrder`'s own claim is a single SQL statement — Postgres does the real
 * ordering there (confirmed by hand: `EXPLAIN` on `SELECT … WHERE id = ANY($1) ORDER BY id FOR
 * UPDATE` places `LockRows` ABOVE `Sort` in the plan, so rows are locked in the sorted sequence,
 * not the scan's own order) — which makes a test that intercepts that one `$queryRaw` call and
 * inspects its arguments unable to tell a sorted claim from an unsorted one: every id the caller
 * named is present in that single call's parameter either way. This function is what a plain unit
 * test CAN discriminate on directly.
 */
export function sortedClaimIds(orderIds: string[]): string[] {
  return [...new Set(orderIds)].sort();
}

/**
 * Claims every order in `orderIds` FOR UPDATE in ascending id order, in ONE statement — spec §5.3's
 * "multi-order shipments add a hazard Phase 3 never had": two saves touching orders `{A, B}` and
 * `{B, A}` deadlock if each claims in its own (caller) order, the classic ABBA cycle (save 1 locks
 * A then waits on B; save 2 locks B then waits on A). Claiming both rows in a SINGLE ordered
 * statement removes the gap where that cycle could form — whichever save's statement reaches
 * Postgres first locks A, then B, uncontested; the other blocks on A alone (never holding B while
 * waiting), so it only ever waits, never cycles. `ORDER BY "id" FOR UPDATE`, not two `claimOrder`
 * calls in a sorted loop, is what makes that true — see `sortedClaimIds`'s own comment for why a
 * loop of single-row claims, even sorted, is a materially different (and in this codebase's case,
 * because Task 8's caller sorts once and could otherwise be tempted to just call `claimOrder` per
 * id, worth naming explicitly) shape from this one statement.
 *
 * Returns the claimed rows in the same ascending order they were locked in — `findMany`'s own
 * `orderBy` matches the claim's `ORDER BY` rather than trusting result order to agree by accident.
 */
export async function claimOrdersInOrder(tx: Db, orderIds: string[]): Promise<Order[]> {
  const ids = sortedClaimIds(orderIds);
  if (ids.length === 0) return [];

  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ANY(${ids}) ORDER BY "id" FOR UPDATE`;
  return tx.order.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
}

/**
 * Resolves the order a cert belongs to and claims IT (spec §5.3) before a cert mutator reads or
 * writes the cert's own state — `orderId` itself is safe to read with a bare, unlocked `findFirst`
 * first, because it never changes once a cert exists (no update path touches it); the state a
 * caller actually acts on (`deletedAt`, `freeform`, …) is always re-read after the claim, under
 * the lock, never trusted from this stub.
 *
 * Used by certs.ts's `updateCert`/`voidCert` and cert-results.ts's `replaceReadings` — every cert
 * mutator needs the identical claim discipline before it reads or writes a requirement's readings
 * or the cert's own fields. Two concurrent calls on the SAME cert serialize through the Order row
 * lock taken here.
 *
 * Moved here from certs.ts (Task 7 review, 2026-08-04, this file's own header comment) — a lock
 * helper belongs beside the lock it wraps, and doing so is what breaks the certs.ts <-> cert-
 * results.ts cycle the same way `claimOrder`'s own move broke orders.ts <-> certs.ts.
 */
export async function claimCertsOrder(tx: Db, certId: string): Promise<{ orderId: string }> {
  const stub = await tx.cert.findFirst({ where: { id: certId }, select: { orderId: true } });
  if (!stub) throw new HttpError(404, "Certification not found");
  await claimOrder(tx, stub.orderId);
  // The house rule (file header): the state every caller acts on after this claim — `deletedAt`,
  // `printedAt`, `freeform`, the readings' merge target — lives on the CERT row, not the Order row
  // just claimed, so the Cert row is locked too, always AFTER the order claim (fixed order, no
  // ABBA window). A Read Committed caller's post-claim re-read is then genuinely fresh; a
  // Serializable caller whose Cert row changed under it raises 40001, which withDbErrors maps to
  // its honest "try again" 409. Without this, a voidCert committing while a mutator blocked on the
  // Order lock was invisible to the mutator's stale snapshot (whole-branch review Important #1 —
  // the discriminating race test lives in certs.test.ts).
  await tx.$queryRaw`SELECT "id" FROM "Cert" WHERE "id" = ${certId} FOR UPDATE`;
  return stub;
}
