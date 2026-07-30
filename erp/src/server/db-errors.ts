import { Prisma } from "@prisma/client";
import { HttpError } from "./errors";

export type DbErrorOpts = { entity: string; conflictField?: string };

/** Translate the two Prisma failures that are expected business outcomes, not bugs. */
export function translatePrisma(err: unknown, opts: DbErrorOpts): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      const field = opts.conflictField ?? (err.meta?.target as string[] | undefined)?.join(", ") ?? "value";
      throw new HttpError(400, `A ${opts.entity.toLowerCase()} with that ${field} already exists`);
    }
    if (err.code === "P2025") throw new HttpError(404, `${opts.entity} not found`);
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
