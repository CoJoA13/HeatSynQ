import { z } from "zod";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { REFERENCE_KINDS, REFERENCE_LABELS, type ReferenceKind } from "../lib/reference-constants";

export type ReferenceRow = { id: string; name: string; active: boolean } & Record<string, unknown>;

/** Fields each kind accepts beyond `name` and `active`. */
const EXTRA_SCHEMAS: Record<ReferenceKind, z.ZodObject<z.ZodRawShape>> = {
  glAccount: z.object({ description: z.string().max(200).optional() }),
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
  findUnique: (a: { where: { name: string } }) => Promise<(ReferenceRow & { deletedAt: Date | null }) | null>;
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
  return delegate(kind).findMany({
    where: { deletedAt: null, ...(opts?.includeInactive ? {} : { active: true }) },
    orderBy: { name: "asc" },
  });
}

export async function createReference(kind: string, input: Record<string, unknown>): Promise<{ id: string }> {
  assertKind(kind);
  // EXTRA_SCHEMAS[kind] widens to the Record's general value type once indexed by a non-literal
  // key, which in turn widens `name` on the merged shape's inferred type — cast back to what we
  // know BASE guarantees so `data.name` below type-checks as `string`, not `unknown`.
  const data = BASE.merge(EXTRA_SCHEMAS[kind]).strict().parse(input) as z.infer<typeof BASE> & Record<string, unknown>;

  // A soft-deleted row still occupies its unique `name`, so retyping the same name must revive
  // that row rather than 400 on a duplicate the caller can no longer see (or silently orphan it
  // behind a second row). Mirrors createRole's revival pattern (see src/server/roles.ts).
  const existing = await delegate(kind).findUnique({ where: { name: data.name } });
  if (existing && !existing.deletedAt) {
    throw new HttpError(400, `A ${REFERENCE_LABELS[kind].singular.toLowerCase()} with that name already exists`);
  }

  const row = existing
    ? await auditedUpdate(kind, existing.id, () =>
        delegate(kind).update({ where: { id: existing.id }, data: { ...data, deletedAt: null } }))
    : await auditedCreate(kind, data, () =>
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
