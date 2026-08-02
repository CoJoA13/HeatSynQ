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
