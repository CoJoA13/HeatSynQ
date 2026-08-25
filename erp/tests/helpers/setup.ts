import { config } from "dotenv";
config({ quiet: true });
// Point every prisma client in the test process at the test database.
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;

/**
 * Silences exactly one upstream DeprecationWarning — the same house rule (pristine test output)
 * dotenv's `quiet: true` above already serves. @prisma/adapter-pg's `PgTransaction.performIO`
 * (client-engine-runtime/query-interpreter.ts:246) fires an `include`'s sibling relation loads on
 * one connection concurrently, `Array.map`-ing over the relation nodes rather than awaiting each
 * in turn. node-postgres queues same-connection calls instead of corrupting them, so results stay
 * correct — but pg's `Client.query()` notices the overlap and reports it once via
 * `util.deprecate()`, which calls `process.emitWarning(message, "DeprecationWarning", …)`.
 *
 * Measured threshold (.superpowers/sdd/task-4-report.md §9.1): inside a transaction, an `include`
 * with 1-2 sibling relations stays clean and 5+ warns; the identical query outside a transaction
 * never warns (separate pool connections). This suite crosses the threshold from `readDetail`'s
 * 6-relation order graph (src/server/order-internals.ts, DETAIL_INCLUDE — #33) and `SNAPSHOT_INCLUDE.order`'s
 * 5-relation graph (src/server/audit.ts) — a property of the order schema under Prisma 7 + pg 8,
 * not of any one query.
 *
 * Filtered at the source, before the `warning` event ever fires — nothing else this one exact
 * message is dropped for; every other warning, deprecation or not, still reaches the real
 * `process.emitWarning` unchanged.
 *
 * REMOVE this the moment @prisma/adapter-pg stops loading sibling relations concurrently, and in
 * any case before any upgrade to pg@9 — its changelog drops the call pattern this warning, and
 * this suppression, both depend on. Tracked as issue #32.
 */
export const SUPPRESSED_PG_DEPRECATION = "Calling client.query() when the client is already executing a query";

function isSuppressedPgDeprecation(warning: string | Error, type: unknown): boolean {
  const message = typeof warning === "string" ? warning : warning.message;
  const effectiveType = typeof warning === "string" ? type : warning.name;
  return effectiveType === "DeprecationWarning" && message.includes(SUPPRESSED_PG_DEPRECATION);
}

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (isSuppressedPgDeprecation(warning, rest[0])) return;
  (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
