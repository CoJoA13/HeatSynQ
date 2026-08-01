import { prisma } from "./db";
import { linksTargeting } from "../lib/reference-links";
import type { ReferenceKind } from "../lib/reference-constants";

export type Blocker = { entityLabel: string; name: string; id: string; href: string | null };

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
export async function findBlockers(kind: ReferenceKind, id: string): Promise<Blocker[]> {
  const out: Blocker[] = [];
  for (const link of linksTargeting(kind)) {
    const delegate = prisma[link.model] as unknown as {
      findMany: (a: object) => Promise<Record<string, unknown>[]>;
    };
    const rows = await delegate.findMany({
      where: { [link.column]: id, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    for (const row of rows) {
      const rowId = String(row.id);
      // Formatting is the registry's job, not this function's — see `displayName` on
      // ReferenceLink. That is what lets 2C-2 add a Part link (identified by
      // (customer, partNumber), never by name alone) by editing one registry entry, with no
      // change here.
      const label = link.displayName?.(row)
        ?? (typeof row.name === "string" && row.name ? row.name : rowId);
      out.push({
        entityLabel: link.entityLabel,
        name: label,
        id: rowId,
        href: link.detailPath ? link.detailPath(rowId) : null,
      });
    }
  }
  return out;
}
