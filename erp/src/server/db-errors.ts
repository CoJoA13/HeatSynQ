import { Prisma } from "../../prisma/generated/prisma/client";
import { HttpError } from "./errors";

export type DbErrorOpts = { entity: string; conflictField?: string };

/** The driver-adapter meta shape (#40): every read below is `unknown`-typed and narrowed, the
 *  `isRawRetryableFailure` style, because the adapter omits `constraint` entirely when Postgres
 *  sends no DETAIL line and nothing here may ever throw. */
type AdapterMeta = {
  target?: unknown;
  constraint?: unknown;
  modelName?: unknown;
  driverAdapterError?: {
    cause?: { constraint?: { fields?: unknown; index?: unknown }; originalMessage?: unknown };
  };
} | undefined;

/** The adapter parses unique-conflict fields out of Postgres' DETAIL line, so mixed-case
 *  identifiers arrive wrapped in literal double quotes ('"tokenHash"') and lowercase ones don't.
 *  Strips exactly one surrounding layer. */
const stripQuotes = (field: string): string => field.replace(/^"|"$/g, "");

/**
 * The columns a P2002 fired on. Measured on this stack (#40): `meta.target` is ALWAYS absent —
 * the answer lives in `meta.driverAdapterError.cause.constraint.fields`. Legacy `meta.target`
 * (string[] or string) is still consulted FIRST so this keeps working if a future adapter
 * populates it — the `isDuplicateClientRequestId` precedent (orders.ts) and its documented
 * rationale. Returns undefined when neither shape carries usable field names (e.g. the adapter's
 * no-DETAIL case, where `constraint` is omitted entirely), so the caller falls back to "value".
 */
function uniqueConflictFields(err: Prisma.PrismaClientKnownRequestError): string[] | undefined {
  const meta = err.meta as AdapterMeta;
  const target = meta?.target;
  if (typeof target === "string" && target.length > 0) return [target];
  if (Array.isArray(target) && target.length > 0 && target.every((f) => typeof f === "string" && f.length > 0)) {
    return target;
  }
  const fields = meta?.driverAdapterError?.cause?.constraint?.fields;
  if (Array.isArray(fields) && fields.length > 0 && fields.every((f) => typeof f === "string" && f.length > 0)) {
    return fields.map(stripQuotes);
  }
  return undefined;
}

/**
 * The constraint NAME a P2003 fired on. Measured on this stack (#40): `meta.constraint` is
 * ALWAYS absent — the adapter puts the name under `cause.constraint.index` (the key is `index`,
 * not `fields`; parsed from pg's `error.constraint`). Legacy `meta.constraint` first, the same
 * ordering rationale as above; the driver's message text is the last resort.
 */
function fkConstraintName(err: Prisma.PrismaClientKnownRequestError): string | undefined {
  const meta = err.meta as AdapterMeta;
  if (typeof meta?.constraint === "string") return meta.constraint;
  const cause = meta?.driverAdapterError?.cause;
  const index = cause?.constraint?.index;
  if (typeof index === "string") return index;
  const message = cause?.originalMessage;
  if (typeof message === "string") {
    return message.match(/foreign key constraint "([^"]+)"/)?.[1];
  }
  return undefined;
}

/** The shared `Id`-strip + humanize: "glAccountId" → "gl account". Returns undefined rather than
 *  a guess when the field isn't plain letters, so nothing unexpected ever leaks into a message. */
function humanizeFkField(field: string): string | undefined {
  const label = field.endsWith("Id") ? field.slice(0, -2) : field;
  if (!/^[A-Za-z]+$/.test(label)) return undefined;
  return label.replace(/([A-Z])/g, " $1").trim().toLowerCase();
}

/**
 * Turns a Prisma FK-constraint failure's constraint name (e.g. "PaymentType_glAccountId_fkey")
 * into a short, user-safe field label (e.g. "gl account"). Returns undefined rather than a
 * guess when the constraint doesn't match the expected `${Model}_${field}_fkey` shape, so the
 * caller can fall back to a generic message instead of ever surfacing raw Prisma text. (A
 * delete-direction violation keeps the generic text by design: `modelName` is the parent model
 * while the constraint names the child table, so the prefix check fails.)
 *
 * One adapter variant carries no constraint name at all: when pg sets `error.column`, the
 * adapter emits `cause.constraint = { fields: [column] }` (#40). That column IS the FK field,
 * so it maps through the same humanize directly, without the name parse.
 */
function readableFkField(err: Prisma.PrismaClientKnownRequestError): string | undefined {
  const meta = err.meta as AdapterMeta;
  const constraint = fkConstraintName(err);
  const modelName = meta?.modelName;
  if (typeof constraint === "string" && typeof modelName === "string") {
    const prefix = `${modelName}_`;
    if (constraint.startsWith(prefix) && constraint.endsWith("_fkey")) {
      const label = humanizeFkField(constraint.slice(prefix.length, -"_fkey".length));
      if (label) return label;
    }
  }
  const fields = meta?.driverAdapterError?.cause?.constraint?.fields;
  if (Array.isArray(fields) && fields.length === 1 && typeof fields[0] === "string") {
    return humanizeFkField(stripQuotes(fields[0]));
  }
  return undefined;
}

/**
 * A retryable transaction abort raised by a RAW query does not arrive as P2034. Prisma wraps
 * anything a `$queryRaw` throws as P2010 ("Raw query failed") and leaves the Postgres SQLSTATE
 * inside the driver adapter's own error, so the P2034 branch below never sees it and it would
 * escape as a 500. Two SQLSTATEs qualify (#90): 40001 (serialization failure) and 40P01 (deadlock
 * detected — the victim Postgres shoots to break a lock cycle). The condition is identical either
 * way — the transaction was aborted, nothing was written, a re-run is safe — so both get the
 * identical answer. Reached by `workingRevision`'s `SELECT … FOR UPDATE` (part-process-steps.ts)
 * and by any raw row claim that loses a race the ordered-claim rules didn't foresee.
 */
function isRawRetryableFailure(err: Prisma.PrismaClientKnownRequestError): boolean {
  if (err.code !== "P2010") return false;
  const meta = err.meta as { driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  const code = meta?.driverAdapterError?.cause?.originalCode;
  return code === "40001" || code === "40P01";
}

/**
 * The hand-written DB CHECKs whose violation is a real, explainable OUTCOME rather than a bug, with
 * the message to say so. Every one of these is a last-line backstop behind a service validation, so
 * reaching it means two writers raced past that validation — the caller's request was not wrong, it
 * simply lost. A 409 "try again" is the honest answer; letting Postgres' raw constraint text escape
 * as a 500 is not (both reviewers of PR #135 raised this).
 *
 * Deliberately a NAMED allowlist, not a "does the message contain 'check constraint'" sniff: a CHECK
 * nobody has thought about should still surface loudly as a 500, because it means an invariant broke
 * in a way no one has reasoned about yet.
 */
const CHECK_MESSAGES: Record<string, string> = {
  Terms_discount_pair_check:
    "Those terms were changed at the same time by someone else — an early-pay discount needs both a "
    + "percent and a day count. Please re-open the row and try again",
};

/** The violated CHECK's name, when this error is one of the allowlisted ones. Postgres reports the
 *  constraint in `meta.constraint` on a native failure and only inside the message text on the
 *  driver-adapter path (the #40 shape), so both are read. */
function violatedCheckConstraint(err: Prisma.PrismaClientKnownRequestError): string | null {
  const constraint = (err.meta as { constraint?: unknown } | undefined)?.constraint;
  if (typeof constraint === "string" && constraint in CHECK_MESSAGES) return constraint;
  const text = `${err.message} ${JSON.stringify(err.meta ?? {})}`;
  return Object.keys(CHECK_MESSAGES).find((name) => text.includes(name)) ?? null;
}

/** Translate the Prisma failures that are expected business outcomes, not bugs. */
export function translatePrisma(err: unknown, opts: DbErrorOpts): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      const field = opts.conflictField ?? uniqueConflictFields(err)?.join(", ") ?? "value";
      throw new HttpError(400, `A ${opts.entity.toLowerCase()} with that ${field} already exists`);
    }
    if (err.code === "P2025") throw new HttpError(404, `${opts.entity} not found`);
    // P2034: the transaction was aborted because a concurrent one touched the same rows. Under
    // Serializable isolation Postgres raises this rather than allowing two transactions whose
    // combined effect no serial order could produce — which is exactly how the hierarchy guard
    // in customers.ts stops two reciprocal parent updates from forming a cycle. Nothing is
    // wrong with the request itself and nothing was written, so the honest answer is "that
    // collided with another change, send it again", not a 500. A raw-query deadlock victim
    // (40P01) is the same condition and gets the same 409 (#90).
    if (err.code === "P2034" || isRawRetryableFailure(err)) {
      throw new HttpError(409,
        `Another change to that ${opts.entity.toLowerCase()} was saved at the same time — please try again`);
    }
    if (err.code === "P2003") {
      const field = readableFkField(err);
      throw new HttpError(400, field ? `That ${field} does not exist` : "That reference does not exist");
    }
    const check = violatedCheckConstraint(err);
    if (check) throw new HttpError(409, CHECK_MESSAGES[check]);
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
 * The RAW Prisma failures a *fresh* transaction can absorb by simply re-running. Always retryable:
 * a serialization failure or deadlock abort (P2034, or the raw-query 40001/40P01 Prisma wraps as
 * P2010) — the shapes a losing Serializable writer takes when a concurrent transaction committed
 * the row its own snapshot could not see; a re-run gets a snapshot that DOES see it and takes the
 * other branch. A unique-constraint violation (P2002) is retryable ONLY when the caller opted in
 * (#90): the one call site where a P2002 is that same losing-writer shape is `closePeriod`'s
 * year-month insert race — the allocation paths answer their nonce P2002s by in-attempt replay and
 * never retry (#115). Constraint discrimination IS possible since #40 (`uniqueConflictFields`
 * reads the adapter shape), but whether a P2002 means "a concurrent writer won — a re-run will
 * see its row" is a fact about the call site's own insert semantics, not about which constraint
 * fired, so a boolean per call site remains the honest scope. Detected on the raw
 * error, so `retryOnSerializationConflict` must sit INSIDE `withDbErrors` (which would otherwise
 * have already turned these into an `HttpError`).
 */
function isRetryableConflict(err: unknown, retryUniqueConflict: boolean): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code === "P2002") return retryUniqueConflict;
  return err.code === "P2034" || isRawRetryableFailure(err);
}

/**
 * Re-run `run` when it fails with a retryable conflict (above), up to `tries` attempts, then let
 * the last failure escape (to `withDbErrors`, which translates it). Wrap the RAW
 * `prisma.$transaction` — each `run()` must open its own transaction so the retry gets a new snapshot.
 * The month-end close (close-periods.ts) uses it: two concurrent Serializable closes serialize on the
 * month advisory lock, and the loser unblocks with a snapshot fixed BEFORE the winner committed (the
 * blocking `lockMonth` SELECT takes the snapshot before the lock is granted), so its `findFirst`
 * misses the just-committed row and its insert collides — the retry re-runs, sees the row, and
 * updates. That collision is a P2002, which is why `closePeriod` alone passes
 * `{ retryUniqueConflict: true }`; every other caller takes the default (P2002 escapes on attempt 1).
 */
export async function retryOnSerializationConflict<T>(
  run: () => Promise<T>, tries = 5, opts: { retryUniqueConflict?: boolean } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= tries || !isRetryableConflict(err, opts.retryUniqueConflict ?? false)) throw err;
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
 * A business refusal (`HttpError`) is not retryable and surfaces on the first attempt. So does a
 * P2002 (the default `retryUniqueConflict: false`, #90): the unique conflicts allocation callers
 * can hit — a duplicate `clientRequestId` nonce — are answered by in-attempt replay inside the
 * save itself, never by re-running the whole transaction (#115).
 */
export async function retryAllocation<T>(run: () => Promise<T>): Promise<T> {
  return retryOnSerializationConflict(run, ALLOCATION_TRIES);
}
