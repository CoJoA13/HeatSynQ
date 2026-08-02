import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { linksTargeting, type BlockerTarget } from "../lib/reference-links";

export type Blocker = { entityLabel: string; name: string; id: string; href: string | null };

// Either the top-level client or a `tx` from prisma.$transaction — same shape as customers.ts's
// Db. deleteReference (reference.ts) passes its own `tx` through so the blocker scan and the
// soft delete it guards run inside one transaction instead of two separate round trips.
type Db = Prisma.TransactionClient;

/** Every LIVE row, across every registered link, whose foreign key holds this reference row's id.
 *
 *  Why this exists rather than just refusing: refusing is only a third of it. This is a live
 *  Visual Shop dead end the owner is escaping — there, a furnace group cannot be deleted because
 *  a process master points at it, and that master cannot be deleted because parts point at it,
 *  with no way to find those parts: "it would take me a year to find them all and point it
 *  elsewhere." A block without discoverability looks like data integrity while actually being a
 *  permanent dead end.
 *
 *  Computed on demand, not cached: blocker sets stay small for years because the system starts
 *  empty, and a stale cache on a data-integrity guard is worse than a query. */
export async function findBlockers(target: BlockerTarget, id: string, db: Db = prisma): Promise<Blocker[]> {
  const out: Blocker[] = [];
  // Declared once, above the links loop: a part reachable through two links of one kind (e.g.
  // two PartInspection rows on the same code, or a part linked via both an inspection and a
  // specification) must still list once.
  const seen = new Set<string>();
  for (const link of linksTargeting(target)) {
    const delegate = db[link.model] as unknown as {
      findMany: (a: object) => Promise<Record<string, unknown>[]>;
    };
    const rows = await delegate.findMany({
      where: { [link.column]: id, ...(link.liveWhere ?? { deletedAt: null }) },
      // `id` (cuid, monotonic) rather than `createdAt`: every linked model has an id, but
      // PartProcessStep/ProcessTemplateStep (2C-3) have no createdAt column, and this loop stays
      // free of per-model branches — the ordering key has to be one every model actually has.
      orderBy: { id: "asc" },
      ...(link.include ? { include: link.include } : {}),
    });
    for (const row of rows) {
      // Formatting is the registry's job, not this function's — see `displayName` on
      // ReferenceLink. That is what lets 2C-2 add a Part link (identified by
      // (customer, partNumber), never by name alone) by editing one registry entry, with no
      // change here. `blockerId` lets a child row that presents its parent (partInspection ->
      // part) report the parent's id instead of its own.
      const blockerId = link.blockerId ? link.blockerId(row) : String(row.id);
      const key = `${link.entityLabel}:${blockerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const label = link.displayName?.(row)
        ?? (typeof row.name === "string" && row.name ? row.name : blockerId);
      out.push({
        entityLabel: link.entityLabel,
        name: label,
        id: blockerId,
        href: link.detailPath ? link.detailPath(blockerId) : null,
      });
    }
  }
  return out;
}
