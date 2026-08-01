import { Prisma } from "../../prisma/generated/prisma/client";
import { HttpError } from "./errors";
import { REFERENCE_LABELS, type ReferenceKind } from "../lib/reference-constants";

/**
 * Rejects an id that is not a LIVE row of the target kind, reading on the caller's own `tx` so
 * the check and the FK write commit or abort together. This is the writer-side half of the
 * reference-delete TOCTOU (handoff §6): deleteReference's blocker scan runs Serializable, and
 * Postgres SSI only aborts a race when the writer's read of the target shares the writer's own
 * Serializable transaction — assertNoCycle (customers.ts) is the precedent shape.
 *
 * `active: false` is deliberately NOT filtered: inactive hides a row from pick lists, it does
 * not invalidate assignment (handoff §5.14).
 */
export async function assertRefExists(
  kind: ReferenceKind, id: string, tx: Prisma.TransactionClient,
): Promise<void> {
  const delegate = tx[kind] as unknown as {
    findFirst: (a: { where: object; select: object }) => Promise<{ id: string } | null>;
  };
  const row = await delegate.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!row) {
    throw new HttpError(400, `That ${REFERENCE_LABELS[kind].singular.toLowerCase()} does not exist`);
  }
}
