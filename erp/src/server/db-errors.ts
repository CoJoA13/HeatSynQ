import { Prisma } from "../../prisma/generated/prisma/client";
import { HttpError } from "./errors";

export type DbErrorOpts = { entity: string; conflictField?: string };

/**
 * Turns a Prisma FK-constraint failure's constraint name (e.g. "PaymentType_glAccountId_fkey")
 * into a short, user-safe field label (e.g. "gl account"). Returns undefined rather than a
 * guess when the constraint doesn't match the expected `${Model}_${field}_fkey` shape, so the
 * caller can fall back to a generic message instead of ever surfacing raw Prisma text.
 */
function readableFkField(err: Prisma.PrismaClientKnownRequestError): string | undefined {
  const constraint = err.meta?.constraint;
  const modelName = err.meta?.modelName;
  if (typeof constraint !== "string" || typeof modelName !== "string") return undefined;
  const prefix = `${modelName}_`;
  if (!constraint.startsWith(prefix) || !constraint.endsWith("_fkey")) return undefined;
  const field = constraint.slice(prefix.length, -"_fkey".length);
  const label = field.endsWith("Id") ? field.slice(0, -2) : field;
  if (!/^[A-Za-z]+$/.test(label)) return undefined; // guards against leaking anything unexpected
  return label.replace(/([A-Z])/g, " $1").trim().toLowerCase();
}

/**
 * A serialization failure raised by a RAW query does not arrive as P2034. Prisma wraps anything a
 * `$queryRaw` throws as P2010 ("Raw query failed") and leaves the Postgres SQLSTATE inside the
 * driver adapter's own error, so the P2034 branch below never sees it and it would escape as a
 * 500. The condition is identical — 40001, the transaction was aborted, nothing was written — so
 * it gets the identical answer. Reached by `workingRevision`'s `SELECT … FOR UPDATE`
 * (part-process-steps.ts), the one raw query in the app that can lose a serialization race.
 */
function isRawSerializationFailure(err: Prisma.PrismaClientKnownRequestError): boolean {
  if (err.code !== "P2010") return false;
  const meta = err.meta as { driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  return meta?.driverAdapterError?.cause?.originalCode === "40001";
}

/** Translate the Prisma failures that are expected business outcomes, not bugs. */
export function translatePrisma(err: unknown, opts: DbErrorOpts): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      const field = opts.conflictField ?? (err.meta?.target as string[] | undefined)?.join(", ") ?? "value";
      throw new HttpError(400, `A ${opts.entity.toLowerCase()} with that ${field} already exists`);
    }
    if (err.code === "P2025") throw new HttpError(404, `${opts.entity} not found`);
    // P2034: the transaction was aborted because a concurrent one touched the same rows. Under
    // Serializable isolation Postgres raises this rather than allowing two transactions whose
    // combined effect no serial order could produce — which is exactly how the hierarchy guard
    // in customers.ts stops two reciprocal parent updates from forming a cycle. Nothing is
    // wrong with the request itself and nothing was written, so the honest answer is "that
    // collided with another change, send it again", not a 500.
    if (err.code === "P2034" || isRawSerializationFailure(err)) {
      throw new HttpError(409,
        `Another change to that ${opts.entity.toLowerCase()} was saved at the same time — please try again`);
    }
    if (err.code === "P2003") {
      const field = readableFkField(err);
      throw new HttpError(400, field ? `That ${field} does not exist` : "That reference does not exist");
    }
  }
  throw err;
}

export async function withDbErrors<T>(opts: DbErrorOpts, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    translatePrisma(err, opts);
  }
}

/**
 * The two RAW Prisma failures a *fresh* transaction can absorb by simply re-running: a serialization
 * failure (P2034, or the raw-query 40001 Prisma wraps as P2010) and a unique-constraint violation
 * (P2002). Both are the shapes a losing Serializable writer takes when a concurrent transaction
 * committed the row its own snapshot could not see — a re-run gets a snapshot that DOES see it and
 * takes the other branch. Detected on the raw error, so `retryOnSerializationConflict` must sit
 * INSIDE `withDbErrors` (which would otherwise have already turned these into an `HttpError`).
 */
function isRetryableConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return err.code === "P2034" || err.code === "P2002" || isRawSerializationFailure(err);
}

/**
 * Re-run `run` when it fails with a retryable serialization/unique conflict (above), up to `tries`
 * attempts, then let the last failure escape (to `withDbErrors`, which translates it). Wrap the RAW
 * `prisma.$transaction` — each `run()` must open its own transaction so the retry gets a new snapshot.
 * The month-end close (close-periods.ts) uses it: two concurrent Serializable closes serialize on the
 * month advisory lock, and the loser unblocks with a snapshot fixed BEFORE the winner committed (the
 * blocking `lockMonth` SELECT takes the snapshot before the lock is granted), so its `findFirst`
 * misses the just-committed row and its insert collides — the retry re-runs, sees the row, and updates.
 */
export async function retryOnSerializationConflict<T>(run: () => Promise<T>, tries = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= tries || !isRetryableConflict(err)) throw err;
    }
  }
}

/**
 * How many attempts an ALLOCATING transaction gets. Higher than the default above, and the number is
 * measured rather than picked (issue #115).
 *
 * `allocateNumber` claims its counter with `SELECT … FOR UPDATE`, and every caller runs Serializable,
 * so N concurrent allocations serialize into N rounds: each round exactly ONE commits and every other
 * transaction aborts with 40001 the instant it unblocks onto a row updated after its own snapshot.
 * The last caller therefore needs up to **N attempts**. Measured against `erp_test`:
 *
 *   concurrent |  tries=1 (pre-fix)  |  tries=5  |  tries=10
 *       2      |  1 ok, 1 FAIL       |  2 ok     |  2 ok
 *       5      |  1 ok, 4 FAIL       |  5 ok     |  5 ok
 *       8      |  1 ok, 7 FAIL       |  5 ok, 3 FAIL |  8 ok
 *
 * `tries = 5` would cover exactly the spec's documented 1–5 users with ZERO margin — one extra tab or
 * one client-side resubmit and a save fails. 10 leaves real headroom on a shop this size. Retries are
 * immediate (no backoff) and a losing attempt aborts AT the claim, before any expensive work, so the
 * cost of the higher ceiling is a few extra short transactions in a race that is already rare.
 *
 * Why retry at all, rather than removing the conflict: the hazard is NOT "the caller read something
 * first". `allocateNumber`'s own first statement is an `INSERT … ON CONFLICT DO NOTHING`, which fixes
 * the snapshot before the claim — so allocating as a transaction's very first operation aborts too
 * (measured). A Postgres sequence would dodge it entirely but leaks gaps on rollback, and
 * "consumes no number when the save fails" is a pinned contract (tests/orders.test.ts). Retry is what
 * is left, and it is the shape `close-periods.ts` already uses.
 */
export const ALLOCATION_TRIES = 10;

/**
 * Wrap an allocating transaction so a 40001 loser re-runs instead of surfacing as a 409 the user has
 * to resubmit. Each `run()` MUST open its own transaction — the retry only helps because the re-run
 * gets a fresh snapshot. Sits INSIDE `withDbErrors` (which would otherwise have already translated
 * the raw error) and OUTSIDE `prisma.$transaction`, exactly as `close-periods.ts` does.
 *
 * A business refusal (`HttpError`) is not retryable and surfaces on the first attempt.
 */
export async function retryAllocation<T>(run: () => Promise<T>): Promise<T> {
  return retryOnSerializationConflict(run, ALLOCATION_TRIES);
}
