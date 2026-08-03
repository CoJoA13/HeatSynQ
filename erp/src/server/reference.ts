import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { REFERENCE_KINDS, REFERENCE_LABELS, type ReferenceKind } from "../lib/reference-constants";
import { linksFrom, nameKey } from "../lib/reference-links";
import { findBlockers } from "./reference-blockers";

export type ReferenceRow = { id: string; name: string; active: boolean } & Record<string, unknown>;

/** Fields each kind accepts beyond `name` and `active`. */
const EXTRA_SCHEMAS: Record<ReferenceKind, z.ZodObject<z.ZodRawShape>> = {
  glAccount:       z.object({ description: z.string().max(200).optional() }),
  // The <column>Name form (e.g. defaultScaleName, glAccountName) is deliberately absent here:
  // resolveLinkNames() below always deletes that key and replaces it with the resolved
  // <column>Id before this schema ever parses the input, so a `defaultScaleName` entry would be
  // unreachable dead code that just advertises API surface zod never actually sees.
  inspectionCode:  z.object({ defaultScaleId: z.string().nullable().optional() }),
  paymentType:     z.object({ glAccountId: z.string().nullable().optional() }),
  commentSnippet:  z.object({ text: z.string().max(4000).optional() }),
  specification:   z.object({ text: z.string().max(4000).optional() }),
  material: z.object({}), inspectionScale: z.object({}), containerType: z.object({}),
  carrier: z.object({}), terms: z.object({}),
};

// `.trim()` mirrors customers.ts's CREATE.name — without it a name is stored exactly as typed
// (e.g. "  Rockwell C  ") but resolveLinkNames() below trims before its lookup, so the grid could
// display a name, submit it unchanged, and get a false "does not exist". Trimming on store makes
// "X" and " X " collide under the partial-unique index, which is correct: they are the same name.
const BASE = z.object({ name: z.string().trim().min(1).max(100), active: z.boolean().optional() });

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
function delegate(kind: ReferenceKind, db: Prisma.TransactionClient = prisma): RefDelegate {
  return db[kind] as unknown as RefDelegate;
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
    //
    // `targetKind` widened to `BlockerTarget` in 2C-3 so the same registry can serve
    // `partProcessStep`/`processTemplateStep` (targetKind "processStepCode", not itself a
    // ReferenceKind). Only those two non-listable models carry that targetKind; `kind` here is
    // always a genuine ReferenceKind (asserted above), so every link `linksFrom(kind)` returns
    // still targets a genuine ReferenceKind too — the cast reflects that, not a new assumption.
    const targets = ids.length
      ? await delegate(link.targetKind as ReferenceKind).findMany({ where: { id: { in: ids }, deletedAt: null } })
      : [];
    const byId = new Map(targets.map((t) => [t.id, t.name]));
    for (const row of rows) {
      const id = row[link.column];
      row[nameKey(link.column)] = typeof id === "string" ? byId.get(id) ?? null : null;
    }
  }
  return rows;
}

/** Turns `<column>Name` input into `<column>` (an id) by looking the name up among LIVE rows of
 *  the target kind.
 *
 *  The raw id form stays accepted too. Not for the UI — the grid's select submits the name
 *  (Task 4 Step 6) — but because existing callers and tests already pass `defaultScaleId` /
 *  `glAccountId` directly, and an id is unambiguous where a name needs resolving. Removing it
 *  would be a breaking API change this task has no reason to make.
 *
 *  Returns a shallow copy — the caller's object is not mutated. */
async function resolveLinkNames(kind: ReferenceKind, input: Record<string, unknown>) {
  const data = { ...input };
  for (const link of linksFrom(kind)) {
    const key = nameKey(link.column);
    if (!(key in data)) continue;
    const raw = data[key];
    delete data[key];
    if (raw === null || raw === "") { data[link.column] = null; continue; }
    const name = String(raw).trim();
    // findFirst, not findUnique: `name` is unique only among live rows, so findUnique would
    // compile and return a soft-deleted row (tests/partial-unique-sweep.test.ts bans it).
    // See the matching cast/comment in listReference above: `kind` is always a genuine
    // ReferenceKind here, so `linksFrom(kind)` never yields the processStepCode-targeting links.
    const target = await delegate(link.targetKind as ReferenceKind).findFirst({
      where: { name, deletedAt: null }, select: { id: true },
    });
    if (!target) throw new HttpError(400, `${link.label} "${name}" does not exist`);
    data[link.column] = target.id;
  }
  return data;
}

export async function createReference(kind: string, input: Record<string, unknown>): Promise<{ id: string }> {
  assertKind(kind);
  // EXTRA_SCHEMAS[kind] widens to the Record's general value type once indexed by a non-literal
  // key, which in turn widens `name` on the merged shape's inferred type — cast back to what we
  // know BASE guarantees so `data.name` below type-checks as `string`, not `unknown`.
  const data = BASE.merge(EXTRA_SCHEMAS[kind]).strict()
    .parse(await resolveLinkNames(kind, input)) as z.infer<typeof BASE> & Record<string, unknown>;

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

  // Serializable is scoped to writes that actually assign a registered FK (spec §5.2) — most
  // kinds (material, carrier, terms, ...) have no entry in REFERENCE_LINKS at all, and even
  // inspectionCode/paymentType only need it when the FK column is actually being set to a
  // non-null value; a plain rename or `active` toggle pays none of Serializable's
  // abort-under-ordinary-concurrency cost. Each assigned target is still validated on this
  // transaction's own `tx`, for the same reason as createCustomer's parentId/termsId checks: a
  // read against the top-level `prisma` client cannot participate in the write's own Serializable
  // read-write cycle, so it cannot close the writer-side half of the reference-delete TOCTOU
  // (assertRefExists's doc comment).
  const links = linksFrom(kind);
  const assignsFk = links.some((link) => data[link.column] != null);
  const row = await withDbErrors({ entity: REFERENCE_LABELS[kind].singular, conflictField: "name" }, () =>
    prisma.$transaction(async (tx) => {
      for (const link of links) {
        const value = data[link.column];
        if (value != null) await assertRefExists(link.targetKind, value as string, tx);
      }
      return auditedCreate(kind, data, () => delegate(kind, tx).create({ data }), { tx });
    }, assignsFk ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined));
  return { id: row.id };
}

export async function updateReference(kind: string, id: string, input: Record<string, unknown>): Promise<void> {
  assertKind(kind);
  const data = BASE.partial().merge(EXTRA_SCHEMAS[kind].partial()).strict()
    .parse(await resolveLinkNames(kind, input)) as z.infer<typeof BASE> & Record<string, unknown>;
  // Same Serializable scoping as createReference above — see that comment. Clearing an FK to
  // null needs neither a target check nor Serializable: nothing points at anything after the
  // write, so there is no cross-row invariant to protect.
  const links = linksFrom(kind);
  const assignsFk = links.some((link) => data[link.column] != null);
  await withDbErrors({ entity: REFERENCE_LABELS[kind].singular, conflictField: "name" }, () =>
    prisma.$transaction(async (tx) => {
      for (const link of links) {
        const value = data[link.column];
        if (value != null) await assertRefExists(link.targetKind, value as string, tx);
      }
      await auditedUpdate(kind, id, () => delegate(kind, tx).update({ where: { id }, data }), { tx });
    }, assignsFk ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined));
}

/**
 * The blocker scan and the soft delete it guards run inside one Serializable transaction, not
 * two separate statements — a concurrent request assigning this row's id to a new record could
 * otherwise commit in the gap between them, leaving a live row pointing at a row this function
 * just soft-deleted (the exact state the guard exists to prevent). Same shape as
 * updateCustomer's parent-cycle guard (customers.ts): read and write share one transaction, and
 * withDbErrors already maps Serializable's P2034 abort to a 409 asking the caller to retry.
 *
 * This closes the race only where the *concurrent writer's own transaction* also reads the
 * target row — Postgres's SSI aborts on a genuine read-write cycle, not on a one-sided read.
 * Every registered FK writer — every entry in src/lib/reference-links.ts's REFERENCE_LINKS, not
 * just the original four (customer.termsId, processStepCode.glAccountId, paymentType.glAccountId,
 * inspectionCode.defaultScaleId) — now validates its target via assertRefExists on its own
 * Serializable transaction whenever it assigns a non-null value to a registered FK column, so the
 * read-write cycle SSI needs to abort the race can actually form:
 * a concurrent delete's blocker scan and a concurrent writer's assertRefExists both read the same
 * row inside their own Serializable transactions, and Postgres aborts whichever one would commit
 * a result no serial ordering of the two could produce. This guard is live, not merely
 * precedent-setting.
 */
export async function deleteReference(kind: string, id: string): Promise<void> {
  assertKind(kind);
  const label = REFERENCE_LABELS[kind].singular.toLowerCase();
  await withDbErrors({ entity: REFERENCE_LABELS[kind].singular }, () =>
    prisma.$transaction(async (tx) => {
      const blockers = await findBlockers(kind, id, tx);
      if (blockers.length) {
        throw new HttpError(400, `That ${label} is still in use by ${blockers.length} record(s)`);
      }
      await auditedSoftDelete(kind, id, undefined, tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
