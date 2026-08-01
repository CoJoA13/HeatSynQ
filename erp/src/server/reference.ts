import { z } from "zod";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { REFERENCE_KINDS, REFERENCE_LABELS, type ReferenceKind } from "../lib/reference-constants";
import { linksFrom, nameKey } from "../lib/reference-links";

export type ReferenceRow = { id: string; name: string; active: boolean } & Record<string, unknown>;

/** Fields each kind accepts beyond `name` and `active`. */
const EXTRA_SCHEMAS: Record<ReferenceKind, z.ZodObject<z.ZodRawShape>> = {
  glAccount:       z.object({ description: z.string().max(200).optional() }),
  inspectionCode:  z.object({ defaultScaleId: z.string().nullable().optional() }),
  paymentType:     z.object({ glAccountId: z.string().nullable().optional() }),
  commentSnippet:  z.object({ text: z.string().max(4000).optional() }),
  specification:   z.object({ text: z.string().max(4000).optional() }),
  material: z.object({}), inspectionScale: z.object({}), containerType: z.object({}),
  carrier: z.object({}), terms: z.object({}),
};

const BASE = z.object({ name: z.string().min(1).max(100), active: z.boolean().optional() });

/** Exported so paste.ts guards on the same rule rather than re-deriving it. */
export function assertKind(kind: string): asserts kind is ReferenceKind {
  if (!(REFERENCE_KINDS as readonly string[]).includes(kind)) {
    throw new HttpError(400, `Unknown reference kind: ${kind}`);
  }
}

// Every reference kind is a Prisma delegate with the same id/name/active/deletedAt shape.
type RefDelegate = {
  findMany: (a: object) => Promise<ReferenceRow[]>;
  // findFirst, not findUnique: `name` is unique only among live rows, but the generated client
  // still types it unique — findUnique would compile and return the soft-deleted row.
  findFirst: (a: { where: object; select?: object }) => Promise<{ id: string } | null>;
  create: (a: { data: object }) => Promise<{ id: string }>;
  update: (a: { where: { id: string }; data: object }) => Promise<{ id: string }>;
};
function delegate(kind: ReferenceKind): RefDelegate {
  return prisma[kind] as unknown as RefDelegate;
}

// A compile-time check here (asserting every REFERENCE_KINDS member's Prisma payload has the
// id/name/active/deletedAt shape delegate() assumes) was tried and dropped: TypeScript won't
// distribute a conditional type across a mapped type's key when the check is one level of
// generic indirection away from the naked key parameter, so the check came back `boolean`
// (both branches unioned) instead of resolving per-kind — it flagged even a genuinely valid
// shape as an error. Enforcement instead lives in the "delegate shape" test in
// tests/reference-gl.test.ts, which round-trips every kind in REFERENCE_KINDS through
// create/list/update/delete and fails loudly (not opaquely) if a future model is missing a
// required column.

export async function listReference(
  kind: string, opts?: { includeInactive?: boolean },
): Promise<ReferenceRow[]> {
  assertKind(kind);
  const rows = await delegate(kind).findMany({
    where: { deletedAt: null, ...(opts?.includeInactive ? {} : { active: true }) },
    orderBy: { name: "asc" },
  });

  // Resolve each FK column to the target's name, so screens and Excel show "Rockwell C"
  // rather than a cuid. One batched query per link, not one per row.
  for (const link of linksFrom(kind)) {
    const ids = [...new Set(rows.map((r) => r[link.column]).filter((v): v is string => typeof v === "string"))];
    // Deleted targets resolve to null rather than throwing — rows predating the FK guards exist.
    // Filtered on deletedAt only, never on active: an inactive target still resolves to its
    // name — inactive hides a row from pick lists, it does not invalidate existing assignments.
    const targets = ids.length
      ? await delegate(link.targetKind).findMany({ where: { id: { in: ids }, deletedAt: null } })
      : [];
    const byId = new Map(targets.map((t) => [t.id, t.name]));
    for (const row of rows) {
      const id = row[link.column];
      row[nameKey(link.column)] = typeof id === "string" ? byId.get(id) ?? null : null;
    }
  }
  return rows;
}

export async function createReference(kind: string, input: Record<string, unknown>): Promise<{ id: string }> {
  assertKind(kind);
  // EXTRA_SCHEMAS[kind] widens to the Record's general value type once indexed by a non-literal
  // key, which in turn widens `name` on the merged shape's inferred type — cast back to what we
  // know BASE guarantees so `data.name` below type-checks as `string`, not `unknown`.
  const data = BASE.merge(EXTRA_SCHEMAS[kind]).strict().parse(input) as z.infer<typeof BASE> & Record<string, unknown>;

  // A soft-deleted row still occupies its unique `name`, but is invisible to every list — so a
  // live duplicate is the only thing that must 400 here. `name` is unique only among live rows
  // (Task 4's partial index), hence findFirst filtered on deletedAt rather than findUnique, which
  // would compile and silently return the soft-deleted row.
  const existing = await delegate(kind).findFirst({
    where: { name: data.name, deletedAt: null },
    select: { id: true },
  });
  if (existing) {
    throw new HttpError(400, `A ${REFERENCE_LABELS[kind].singular.toLowerCase()} with that name already exists`);
  }

  const row = await auditedCreate(kind, data, () =>
    withDbErrors({ entity: REFERENCE_LABELS[kind].singular, conflictField: "name" }, () =>
      delegate(kind).create({ data })));
  return { id: row.id };
}

export async function updateReference(kind: string, id: string, input: Record<string, unknown>): Promise<void> {
  assertKind(kind);
  const data = BASE.partial().merge(EXTRA_SCHEMAS[kind].partial()).strict().parse(input);
  await withDbErrors({ entity: REFERENCE_LABELS[kind].singular, conflictField: "name" }, () =>
    auditedUpdate(kind, id, () => delegate(kind).update({ where: { id }, data })));
}

export async function deleteReference(kind: string, id: string): Promise<void> {
  assertKind(kind);
  await withDbErrors({ entity: REFERENCE_LABELS[kind].singular }, () => auditedSoftDelete(kind, id));
}
