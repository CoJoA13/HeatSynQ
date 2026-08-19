import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";
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
  carrier: z.object({}),
  // Task 4 (P5B spec §4.3): `netDays` mirrors the column's own `Int @default(30)` — optional
  // here too, so a create that omits it lets Postgres apply the default rather than this schema
  // re-asserting one. A zod-level `.default(30)` was tried and dropped: `EXTRA_SCHEMAS[kind]` is
  // reused verbatim (via `.partial()`) for UPDATE, and `.default()` fires whenever the key is
  // undefined — including on a partial PATCH that never meant to touch netDays — which would
  // silently reset an existing row's netDays to 30 on every unrelated update (e.g. the Active
  // toggle). Leaving it optional with no default keeps "omitted" meaning "don't touch" on update
  // and "use the column default" on create, which is what each op actually needs.
  // `discountPercent`/`discountDays` are both optional AND nullable — nullable so an update can
  // explicitly clear either one (the column itself is `Int?`/`Decimal?`), optional so a PATCH
  // that never mentions a key leaves it untouched (see resolveLinkNames/updateReference). Their
  // all-or-nothing pairing is enforced on the composed create/update schema by requireDiscountPair
  // below, not here — see its comment for why it can't live on this entry — and, on update, by
  // assertDiscountPairAfterUpdate against the merged row (see that function's comment).
  terms: z.object({
    netDays: z.number().int().min(0).optional(),
    discountPercent: decimalField(5, 2, { min: "nonnegative" }),
    discountDays: z.number().int().min(1).nullable().optional(),
  }),
  // Phase 6 ruling 13: `text` is the statement body printed on the quote footer (the
  // commentSnippet.text precedent, same 4000 cap); `isDefault` is service-normalized to at most
  // one live default.
  endingStatement: z.object({
    text: z.string().max(4000).optional(),
    isDefault: z.boolean().optional(),
  }),
};

/**
 * Terms' early-pay discount is all-or-nothing (Task 4): `discountPercent` and `discountDays`
 * arrive as a pair or not at all. This can't live inside `EXTRA_SCHEMAS.terms` itself —
 * `EXTRA_SCHEMAS` is typed `Record<ReferenceKind, z.ZodObject>` and every kind's create/update
 * composes it via `.merge()`/`.partial()` below; a `.refine()`/`.superRefine()` there would
 * return a `ZodEffects`, which has neither method, and would break every other kind's compose.
 * Applied instead to the fully-composed schema, once, right before `.parse()` — for the other
 * nine kinds neither key is ever in that schema's shape, so the check is a structural no-op.
 *
 * Update validates only the raw PATCH here — it cannot see the stored row, so it can't tell
 * "the other half of the pair is already set on the row" from "the other half was never set at
 * all"; both look like "key absent from this patch" from inside the refine. That gap (a PATCH
 * supplying exactly one of the pair against a row that already has the other set) is closed by
 * `assertDiscountPairAfterUpdate` below, which `updateReference` runs against the MERGED row
 * (stored values overlaid by the patch) before writing. This refine still runs on update too —
 * it catches the cheaper case where the patch itself sets both keys to a mismatched pair
 * (percent present-and-non-null, days explicitly null, or vice versa) without a DB round trip.
 */
function requireDiscountPair<S extends z.ZodTypeAny>(schema: S) {
  return schema.superRefine((value, ctx) => {
    const row = value as { discountPercent?: number | null; discountDays?: number | null };
    const hasPercent = row.discountPercent != null;
    const hasDays = row.discountDays != null;
    if (hasPercent !== hasDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasPercent ? "discountDays" : "discountPercent"],
        message: "an early-pay discount needs both a percent and a day count",
      });
    }
  });
}

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
  // The #99 guarded write: conditional on `deletedAt: null`, zero-count = absent (see
  // updateReference). Every reference model's generated delegate carries it.
  updateMany: (a: { where: object; data: object }) => Promise<{ count: number }>;
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

/**
 * EndingStatement's at-most-one-live-default invariant (Phase 6 ruling 13; the customer-address
 * default precedent, enforced HERE in the service per §5.17 so no future caller bypasses it).
 * Unlike addresses there is NO auto-promotion: deactivating or deleting the default leaves the
 * kind defaultless, which is legal — `Quote.endingStatementId` is nullable, and a quote created
 * against a defaultless kind simply stores no ending statement.
 *
 * THE CONCURRENCY DESIGN (load-bearing — do not reduce to a plain scan-and-demote). "At most one
 * live default" is a *predicate over the whole table* — a kind with zero defaults has no row that
 * expresses the state — so, exactly like the period lock (period-locks.ts), no `SELECT … FOR
 * UPDATE` on a row can claim it: two concurrent make-me-default writes promoting different rows
 * may share no row at all (each scan sees nothing to demote while the other's flag write is
 * uncommitted, both commit, two defaults survive). Every write that can ADD a default therefore
 * takes this transaction-level advisory lock first; the demote-scan then runs after any competing
 * writer has committed, so it sees (and demotes) that writer's flag at ANY caller isolation.
 * `(4300, 0)` is the two-int namespacing form: 4300 is this module's classifier (period-locks
 * owns 4200; keep them distinct), 0 the single key — only one table carries this invariant.
 * Writes that can only SHRINK the default set (an explicit `isDefault: false`) skip the lock;
 * the deactivation strip takes it so a deactivate racing a promote of the SAME row cannot leave
 * an inactive row flagged. The concurrency test in tests/reference-tables.test.ts is
 * RED-verified against the promote branch losing this lock.
 */
const ENDING_STATEMENT_DEFAULT_LOCK = 4300;

async function lockEndingStatementDefault(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ENDING_STATEMENT_DEFAULT_LOCK}, 0)`;
}

/** Clears the flag on every LIVE default except `exceptId`, through the audit helpers — the
 *  customer-address setDefault lesson: a bare update leaves the demoted row's history claiming
 *  isDefault: true forever. Call only under `lockEndingStatementDefault`. */
async function demoteOtherEndingStatementDefaults(
  tx: Prisma.TransactionClient, exceptId?: string,
): Promise<void> {
  const rows = await tx.endingStatement.findMany({
    where: { deletedAt: null, isDefault: true, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true },
  });
  for (const row of rows) {
    await auditedUpdate("endingStatement", row.id, () =>
      tx.endingStatement.update({ where: { id: row.id }, data: { isDefault: false } }), { tx });
  }
}

/** Create side: an inactive row never carries the flag (rejected, not silently stripped — the
 *  caller asked for a contradiction), and a new default demotes the old one under the lock. */
async function normalizeEndingStatementDefaultOnCreate(
  tx: Prisma.TransactionClient, data: Record<string, unknown>,
): Promise<void> {
  if (data.isDefault !== true) return;
  if (data.active === false) {
    throw new HttpError(400, "An inactive ending statement cannot be the default");
  }
  await lockEndingStatementDefault(tx);
  await demoteOtherEndingStatementDefaults(tx);
}

/** Update side. Three writes can touch the default set:
 *  - promote (`isDefault: true`): lock, then re-read the row's `active` UNDER the lock (a
 *    pre-lock read could race a concurrent deactivation into flagging an inactive row), refuse
 *    if the row is/stays inactive, demote the others;
 *  - deactivate (`active: false`): strip the flag in the same write — the kind goes defaultless
 *    (legal), and a later reactivation must not silently resurrect a default beside a newer one.
 *    Also under the lock, for the same promote-vs-deactivate race;
 *  - explicit clear (`isDefault: false`): can only shrink the set — no lock needed.
 *  Mutates `data` (the strip) before the caller's audited write, so the audit snapshot and the
 *  stored row agree. */
async function normalizeEndingStatementDefaultOnUpdate(
  tx: Prisma.TransactionClient, id: string, data: Record<string, unknown>,
): Promise<void> {
  if (data.active === false && data.isDefault === true) {
    throw new HttpError(400, "An inactive ending statement cannot be the default");
  }
  if (data.isDefault === true) {
    await lockEndingStatementDefault(tx);
    const current = await tx.endingStatement.findFirst({
      where: { id, deletedAt: null }, select: { active: true },
    });
    // #99: a row soft-deleted (or missing) at entry never reaches here — the live-row guard at
    // the top of updateReference's transaction already 404'd it. Null now means a concurrent
    // delete committed between that guard and this locked re-read (visible at Read Committed);
    // returning skips the demote-scan, and the flag write below lands on a dead row no live
    // read ever sees — the at-most-one-LIVE-default invariant holds either way. (The update()
    // below does NOT 404 a soft-deleted id — it finds rows by bare id — which is exactly why
    // the guard exists.)
    if (!current) return;
    if (data.active !== true && !current.active) {
      throw new HttpError(400, "An inactive ending statement cannot be the default");
    }
    await demoteOtherEndingStatementDefaults(tx, id);
    return;
  }
  if (data.active === false) {
    await lockEndingStatementDefault(tx);
    data.isDefault = false;
  }
}

export async function createReference(kind: string, input: Record<string, unknown>): Promise<{ id: string }> {
  assertKind(kind);
  // EXTRA_SCHEMAS[kind] widens to the Record's general value type once indexed by a non-literal
  // key, which in turn widens `name` on the merged shape's inferred type — cast back to what we
  // know BASE guarantees so `data.name` below type-checks as `string`, not `unknown`.
  const data = requireDiscountPair(BASE.merge(EXTRA_SCHEMAS[kind]).strict())
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
      if (kind === "endingStatement") await normalizeEndingStatementDefaultOnCreate(tx, data);
      return auditedCreate(kind, data, () => delegate(kind, tx).create({ data }), { tx });
    }, assignsFk ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined));
  return { id: row.id };
}

/**
 * Closes the gap `requireDiscountPair` leaves on update (see its doc comment): a PATCH touching
 * only one of `discountPercent`/`discountDays` is valid on its own, but can still leave the
 * STORED row broken if the other half was already set. Runs only for kind "terms" (the one kind
 * with this pairing) and only when the patch actually touches one of the two keys — every other
 * PATCH (renaming, toggling `active`, changing `netDays`) is a no-op here.
 *
 * Reads the current row inside the caller's own transaction, then merges: a key ABSENT from the
 * patch (`"discountPercent" in patch` false) keeps the stored value; a key PRESENT in the patch —
 * including an explicit `null` — overrides it. That distinction is exactly what a plain
 * `patch.discountPercent ?? current.discountPercent` would erase (`??` can't tell "omitted" from
 * "explicitly null"), so this checks `in` on the parsed patch object instead. zod's `.partial()`
 * omits untouched optional keys from its parsed output entirely (verified against this repo's
 * zod: `{ a: null }` parsed through `z.object({a,b}).partial()` yields `{a: null}`, not
 * `{a: null, b: undefined}`), so `in` reliably means "the caller's PATCH mentioned this key".
 */
async function assertDiscountPairAfterUpdate(
  tx: Prisma.TransactionClient, id: string, patch: Record<string, unknown>,
): Promise<void> {
  if (!("discountPercent" in patch) && !("discountDays" in patch)) return;
  const current = await tx.terms.findFirst({
    where: { id }, select: { discountPercent: true, discountDays: true },
  });
  // #99: an id that was missing at entry never reaches here — updateReference's live-row guard
  // already 404'd it (this bare-id read sees soft-deleted rows, so null means hard-missing
  // only). Null now takes a mid-transaction hard delete, which only tests perform; the update()
  // below then raises the real (404-shaped) P2025 error.
  if (!current) return;
  const percent = "discountPercent" in patch ? patch.discountPercent : current.discountPercent;
  const days = "discountDays" in patch ? patch.discountDays : current.discountDays;
  if ((percent != null) !== (days != null)) {
    throw new HttpError(400, "an early-pay discount needs both a percent and a day count");
  }
}

export async function updateReference(kind: string, id: string, input: Record<string, unknown>): Promise<void> {
  assertKind(kind);
  const data = requireDiscountPair(BASE.partial().merge(EXTRA_SCHEMAS[kind].partial()).strict())
    .parse(await resolveLinkNames(kind, input)) as z.infer<typeof BASE> & Record<string, unknown>;
  // Same Serializable scoping as createReference above — see that comment. Clearing an FK to
  // null needs neither a target check nor Serializable: nothing points at anything after the
  // write, so there is no cross-row invariant to protect.
  const links = linksFrom(kind);
  const assignsFk = links.some((link) => data[link.column] != null);
  await withDbErrors({ entity: REFERENCE_LABELS[kind].singular, conflictField: "name" }, () =>
    prisma.$transaction(async (tx) => {
      // #99, two layers. This ENTRY guard 404s a soft-deleted (or hard-missing) row before the
      // link asserts and both normalizers run — first statement of the transaction, ON this tx
      // (the #60 rule — a read defaulting to the top-level singleton escapes the caller's
      // snapshot AND its Serializable read-set), message matching db-errors.ts's P2025 mapping
      // so the two absences present identically. It is a plain read, though, so a concurrent
      // deleteReference committing between it and the write could still slip past — the WRITE
      // below is the guarantee: a guarded updateMany conditional on `deletedAt: null` (the
      // auditedSoftDelete shape, audit.ts) whose zero-count raises the same 404 and aborts the
      // transaction entry-less at any isolation (PR #152 Codex round; the task-2 review had
      // recorded this residue as accepted — now closed).
      const alive = await delegate(kind, tx).findFirst({
        where: { id, deletedAt: null }, select: { id: true },
      });
      if (!alive) throw new HttpError(404, `${REFERENCE_LABELS[kind].singular} not found`);
      for (const link of links) {
        const value = data[link.column];
        if (value != null) await assertRefExists(link.targetKind, value as string, tx);
      }
      if (kind === "terms") await assertDiscountPairAfterUpdate(tx, id, data);
      if (kind === "endingStatement") await normalizeEndingStatementDefaultOnUpdate(tx, id, data);
      await auditedUpdate(kind, id, async () => {
        const updated = await delegate(kind, tx).updateMany({ where: { id, deletedAt: null }, data });
        if (updated.count === 0) throw new HttpError(404, `${REFERENCE_LABELS[kind].singular} not found`);
        return updated;
      }, { tx });
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
