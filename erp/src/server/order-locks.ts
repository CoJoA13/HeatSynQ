// The Order row lock, alone in its own leaf module (the `errors.ts` precedent — Phase 2A pulled
// `HttpError` out here for the identical reason: `settings.ts` -> `http.ts` -> `sessions.ts` ->
// `settings.ts` was a real cycle, safe only because every crossing export was a hoisted `function`
// declaration). Task 5 created the same shape between `orders.ts` and `certs.ts`
// (`certs.ts` imports `claimOrder`; `orders.ts` imports `resolveCertSettings`/`createCert` back)
// and Tasks 7/8 were both about to widen it further (`shippers.ts` needs `claimOrdersInOrder` AND
// `createCert`; `orders.ts` needs `shipmentBlockers` back from `shippers.ts` for spec §5.5). Moving
// the claim itself here — importing nothing but the db types — means every order-family service
// (`orders.ts`, `certs.ts`, `attachments.ts`, `order-loads.ts`, `traveler.ts`, and Task 8's
// `shippers.ts`) can depend on the lock without depending on each other through it.
import type { Prisma, Order } from "../../prisma/generated/prisma/client";

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
