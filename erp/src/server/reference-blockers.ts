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
      // processStepCode's human key is `code` + `name`; every other linked model uses `name`
      // alone. Keyed on link.model, NOT on whether the row happens to have a `code` field:
      // Customer also has a `code` column (its own business key, e.g. "ACME"), but a blocker
      // list should read "Acme Foundry", not "ACME — Acme Foundry" — a generic
      // `typeof row.code === "string"` check would wrongly prefix every customer blocker too.
      const label = link.model === "processStepCode" && typeof row.code === "string" && typeof row.name === "string"
        ? `${row.code} — ${row.name}`
        : (typeof row.name === "string" && row.name ? row.name : rowId);
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
