import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { linksTargeting, type BlockerTarget, type ReferenceLinkModel } from "../lib/reference-links";

// `model` is optional (fix wave 1, Fix 3 review; the field itself was `label` in that wave — fix
// wave 2 review found the discriminator it enabled to be a tautology and replaced it with this
// one, see below): only populated when a caller opts in via `findBlockers`'s `includeModel`
// option below, straight off the registry entry's own `model` (src/lib/reference-links.ts) — the
// Prisma model holding the FK, a member of the typed `ReferenceLinkModel` union. Every hand-built
// Blocker[] elsewhere (customers.ts's customerPartBlockers/customerOrderBlockers, parts.ts,
// part-field-defs.ts, process-step-codes.ts, shippers.ts) is not driven by that registry and has
// no such field to supply — and `findBlockers` itself has many callers (reference.ts/
// surcharges.ts/process-step-codes.ts's own delete guards, several `/blockers` routes) whose
// existing tests assert the plain four-field shape, so the field stays opt-in rather than
// always-on to avoid quietly widening every one of those.
//
// Where it IS present, `model` is genuine identity — which registered link produced this row —
// not a rendered string. The field it replaced, `label`, was tried first (fix wave 1) and paired
// with `entityLabel`, on the theory that the combination pins down one link: it does not, because
// among the rows `findBlockers("surcharge", …)` can ever return, every link's FK column is named
// `surchargeId`, so `label` (that column's own header) reads "Surcharge" on all of them — the
// conjunct added nothing (fix wave 2 review). `entityLabel` alone has the matching problem: a
// future surcharge-targeting link could legitimately present its own Customer exactly like this
// one does. `model` doesn't have either problem — admin/surcharges/page.tsx's "Clear override"
// button filters on `model === "customerSurcharge"` alone, true only for the one link this escape
// hatch was built for, regardless of what entityLabel or label any sibling link ever picks.
export type Blocker = { entityLabel: string; name: string; id: string; href: string | null; model?: ReferenceLinkModel };

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
 *  empty, and a stale cache on a data-integrity guard is worse than a query.
 *
 *  `includeModel` (fix wave 1, Fix 3 review; renamed from `includeLabel` in fix wave 2 — see the
 *  `Blocker` type's own comment above): opt-in, off by default — see that same comment for why
 *  this isn't unconditional. */
export async function findBlockers(
  target: BlockerTarget, id: string, db: Db = prisma, opts: { includeModel?: boolean } = {},
): Promise<Blocker[]> {
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
      // Named `displayName`, not `label` (fix wave 1, Fix 3 review), to stay distinct from
      // `model` below — the registry entry's own Prisma model identity, not this row's display
      // name.
      const displayName = link.displayName?.(row)
        ?? (typeof row.name === "string" && row.name ? row.name : blockerId);
      out.push({
        entityLabel: link.entityLabel,
        name: displayName,
        id: blockerId,
        href: link.detailPath ? link.detailPath(blockerId) : null,
        // Conditional spread, not a bare `model: opts.includeModel ? link.model : undefined`
        // (Fix 3, fix wave 2 review): the bare form always creates the key, which is harmless
        // only because JSON drops `undefined` and no caller uses `toStrictEqual` — the spread
        // makes the property genuinely absent when not requested, matching the opt-in claim
        // above.
        ...(opts.includeModel ? { model: link.model } : {}),
      });
    }
  }
  return out;
}
