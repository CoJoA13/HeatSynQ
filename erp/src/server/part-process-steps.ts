import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate } from "./audit";
import { assertRefExists } from "./reference-guards";

export type RevisionSummary = { revisionNumber: number; lockedAt: Date | null; stepCount: number; createdAt: Date };
export type StepValueRow = { fieldDefId: string; label: string; type: string; unit: string | null; sort: number; value: string };
export type StepRow = { id: string; position: number; codeId: string; code: string; codeName: string; instruction: string; values: StepValueRow[] };
export type RevisionDetail = { revisionNumber: number; lockedAt: Date | null; steps: StepRow[] };

const VALUE_ITEM = z.object({ fieldDefId: z.string().min(1), value: z.string().max(500) }).strict();
const ADD = z.object({
  codeId: z.string().min(1), instruction: z.string().max(4000).default(""), values: z.array(VALUE_ITEM).default([]),
}).strict();
const EDIT = z.object({
  instruction: z.string().max(4000).optional(), values: z.array(VALUE_ITEM).optional(),
}).strict();

/** Mirror of part-field-values.ts's validateValue, against StepFieldType (same four cases; TEXT
 *  max 500 here, not 2000 — step values are shorter than custom field text). Message-anchored on
 *  `def.label` (ProcessStepFieldDef's display name column), not `def.name`. */
function validateStepValue(def: { label: string; type: string }, value: string): string {
  const v = value.trim();
  if (v === "") return "";
  switch (def.type) {
    case "NUMBER":
      if (!/^-?\d{1,12}(\.\d{1,6})?$/.test(v)) {
        throw new HttpError(400, `"${value}" is not a valid number for ${def.label}`);
      }
      return v;
    case "DATE": {
      // Mirror of part-field-values.ts's leap-year rollover guard: Date.parse alone silently
      // rolls a nonexistent calendar date (2025-02-29) over into the next valid one (March 1)
      // instead of rejecting it. Round-tripping through Date.UTC and re-reading the y/m/d back
      // out exposes any silent normalization.
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (!match) {
        throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${def.label}`);
      }
      const [, yStr, mStr, dStr] = match;
      const y = Number(yStr), m = Number(mStr), d = Number(dStr);
      const asUtc = new Date(Date.UTC(y, m - 1, d));
      const rolled = asUtc.getUTCFullYear() !== y || asUtc.getUTCMonth() !== m - 1 || asUtc.getUTCDate() !== d;
      if (Number.isNaN(asUtc.getTime()) || rolled) {
        throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${def.label}`);
      }
      return v;
    }
    case "CHECKBOX":
      if (v !== "true" && v !== "false") {
        throw new HttpError(400, `${def.label} must be true or false`);
      }
      return v;
    default:
      if (v.length > 500) throw new HttpError(400, `${def.label} is too long (500 max)`);
      return v;
  }
}

/**
 * THE revision-cut rule (spec §5). Resolves — and, when necessary, creates — the revision a
 * mutation should target, entirely inside the caller's own transaction:
 *
 *  - No revision yet: revision 1 is created lazily (§5.1) and returned.
 *  - The current (highest-numbered) revision is unlocked: amend in place (§5.3) — returned as-is.
 *  - The current revision is locked: cut N+1 first (§5.4) — every step and value of the locked
 *    revision is copied into the new revision (position, code, instruction, values all
 *    preserved), and a position-keyed map from the locked revision's step ids to their copies is
 *    returned so callers naming a step by its (now-superseded) id can resolve it against the new
 *    working revision.
 *
 * `stepIdMap` is `null` exactly when no cut happened this call — callers use that to tell "amend
 * in place" (resolve the caller's stepId directly against the returned revision) from "just cut"
 * (resolve it through the map first).
 *
 * CONCURRENCY (Codex, PR #22 — regression test "a lock landing mid-mutation cannot leave the
 * locked revision modified"). The current revision is claimed with `SELECT … FOR UPDATE` before
 * its `lockedAt` is read, because that read is what decides amend-vs-cut and the answer must not
 * be able to go stale between here and the child write. Serializable isolation is NOT the
 * guarantee here, even on both sides: `lockRevision`'s documented caller — Phase 3's order save —
 * holds it inside a Serializable transaction of its own (orders.ts:522), same as the mutators in
 * this file, but that pairing is never what's relied on. Postgres's serializable guarantees only
 * hold among transactions that stay ALL Serializable, a property no caller here is required to
 * preserve; what actually protects `lockedAt` is the row lock, which blocks at ANY caller
 * isolation regardless. Without it, a mutator could read `lockedAt: null`, let that lock commit,
 * then amend the now-locked revision's steps and commit clean, silently breaking §5's
 * immutability guarantee.
 *
 * A row lock is the right instrument precisely because both sides take it at any isolation
 * (`lockRevision`'s `updateMany` locks the same row). Whichever gets there first wins cleanly: a
 * mutator that wins amends in place and the lock follows it; a mutator that loses either sees
 * `lockedAt` set and cuts N+1, or is aborted with 40001, which `withDbErrors` already turns into
 * a 409 "try again" rather than a 500. There is no ordering in which the locked revision changes.
 */
async function workingRevision(partId: string, tx: Prisma.TransactionClient):
  Promise<{ rev: { id: string; revisionNumber: number }; stepIdMap: Map<string, string> | null }> {
  const part = await tx.part.findFirst({ where: { id: partId, deletedAt: null }, select: { id: true } });
  if (!part) throw new HttpError(404, "Part not found");
  // Raw because Prisma has no `FOR UPDATE`. Id only — the full row and its steps are read back
  // through the client below, once the lock is held.
  const claimed = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "PartProcessRevision"
    WHERE "partId" = ${partId}
    ORDER BY "revisionNumber" DESC
    LIMIT 1
    FOR UPDATE
  `;
  const current = claimed.length === 0 ? null : await tx.partProcessRevision.findFirst({
    where: { id: claimed[0].id },
    include: { steps: { orderBy: { position: "asc" }, include: { values: true } } },
  });
  if (!current) {
    const rev = await auditedCreate("partProcessRevision", { partId, revisionNumber: 1 },
      () => tx.partProcessRevision.create({ data: { partId, revisionNumber: 1 } }), { tx });
    return { rev, stepIdMap: null };
  }
  if (!current.lockedAt) return { rev: current, stepIdMap: null };
  // locked current -> cut N+1: copy every step and value (spec §5.4 — own-part continuity, NOT
  // copy-from-another-part).
  const next = await auditedCreate("partProcessRevision", { partId, revisionNumber: current.revisionNumber + 1 },
    () => tx.partProcessRevision.create({ data: { partId, revisionNumber: current.revisionNumber + 1 } }), { tx });
  const stepIdMap = new Map<string, string>();
  for (const s of current.steps) {
    const copy = await tx.partProcessStep.create({ data: {
      revisionId: next.id, position: s.position, codeId: s.codeId, instruction: s.instruction,
      values: { create: s.values.map((v) => ({ fieldDefId: v.fieldDefId, value: v.value })) },
    } });
    stepIdMap.set(s.id, copy.id);
  }
  return { rev: next, stepIdMap };
}

/** Resolves a client-supplied `stepId` against the working revision returned by
 *  `workingRevision`, mapping it through `stepIdMap` first when a cut just happened. A stepId
 *  that resolves to no live step of the working revision — because it names a step from a
 *  revision superseded before this call, or one that predates the cut this call just made —
 *  404s with the exact message spec §5.6a requires. */
async function resolveStep(
  tx: Prisma.TransactionClient, rev: { id: string }, stepIdMap: Map<string, string> | null, stepId: string,
) {
  const targetId = stepIdMap?.get(stepId) ?? stepId;
  const step = await tx.partProcessStep.findFirst({ where: { id: targetId, revisionId: rev.id } });
  if (!step) throw new HttpError(404, "That step belongs to a superseded revision");
  return step;
}

/** Applies a values patch to one step: validates each value against its def (scoped to the
 *  step's own code — a def from another code 400s), then creates/updates/deletes rows so only
 *  non-empty values are ever stored (spec §4). Skips a write that would leave the row unchanged,
 *  so an unchanged value doesn't add junk to the revision's audit diff. */
async function applyValues(
  tx: Prisma.TransactionClient, stepId: string, codeId: string, values: { fieldDefId: string; value: string }[],
): Promise<void> {
  if (values.length === 0) return;
  const fieldDefIds = [...new Set(values.map((v) => v.fieldDefId))];
  const defs = await tx.processStepFieldDef.findMany({ where: { id: { in: fieldDefIds }, codeId } });
  const defById = new Map(defs.map((d) => [d.id, d]));
  for (const v of values) {
    const def = defById.get(v.fieldDefId);
    if (!def) throw new HttpError(400, "That field does not belong to this step's code");
    const value = validateStepValue(def, v.value);
    const existing = await tx.partProcessStepValue.findFirst({ where: { stepId, fieldDefId: v.fieldDefId } });
    if (value === "") {
      if (existing) await tx.partProcessStepValue.delete({ where: { id: existing.id } });
      continue;
    }
    if (!existing) {
      await tx.partProcessStepValue.create({ data: { stepId, fieldDefId: v.fieldDefId, value } });
    } else if (existing.value !== value) {
      await tx.partProcessStepValue.update({ where: { id: existing.id }, data: { value } });
    }
    // identical value: skip — no junk audit rows.
  }
}

/** Newest first; 404 if the part is missing or soft-deleted. */
export async function getRevisions(partId: string): Promise<RevisionSummary[]> {
  const part = await prisma.part.findFirst({ where: { id: partId, deletedAt: null }, select: { id: true } });
  if (!part) throw new HttpError(404, "Part not found");
  const revs = await prisma.partProcessRevision.findMany({
    where: { partId },
    orderBy: { revisionNumber: "desc" },
    include: { _count: { select: { steps: true } } },
  });
  return revs.map((r) => ({
    revisionNumber: r.revisionNumber, lockedAt: r.lockedAt, stepCount: r._count.steps, createdAt: r.createdAt,
  }));
}

/**
 * Full content of one revision: ordered steps, each with the live code (code/name — renames
 * propagate, spec §3.3) and values joined to their live defs, sorted by the def's own `sort`.
 * NOT part-liveness-gated — that gate is `getRevision`'s job (below), the general part-scoped
 * read. This is the shared include-tree + mapping the two callers split on: `getRevision` runs
 * its own liveness check first and then delegates here; `orders.ts`'s `getLockedRevision` calls
 * this directly, deliberately bypassing that gate.
 *
 * Fix-wave R2 finding 7: a part is deletable once every order referencing it is voided
 * (parts.ts's deletePart), but an order's own locked recipe (spec §5.3/§11 — the (partId,
 * revisionNumber) pair frozen onto the order's lead line at save time) has to stay readable
 * forever regardless — a voided order's paperwork is exactly the kind of record that must not
 * 404 just because the part it named has since been cleaned up. Restricted to callers already
 * anchored on a stored (partId, revisionNumber) pair they have independent authority to read
 * (i.e. they already resolved, and are allowed to see, the entity that captured it) — this is
 * NOT a general-purpose unchecked read, and must not be exposed as one.
 */
export async function getRevisionContentUnchecked(
  partId: string, revisionNumber: number,
): Promise<RevisionDetail> {
  const rev = await prisma.partProcessRevision.findFirst({
    where: { partId, revisionNumber },
    include: {
      steps: {
        orderBy: { position: "asc" },
        include: {
          code: { select: { code: true, name: true } },
          values: { include: { fieldDef: { select: { label: true, type: true, unit: true, sort: true } } } },
        },
      },
    },
  });
  if (!rev) throw new HttpError(404, "Revision not found");
  return {
    revisionNumber: rev.revisionNumber,
    lockedAt: rev.lockedAt,
    steps: rev.steps.map((s) => ({
      id: s.id, position: s.position, codeId: s.codeId, code: s.code.code, codeName: s.code.name,
      instruction: s.instruction,
      values: s.values
        .map((v) => ({
          fieldDefId: v.fieldDefId, label: v.fieldDef.label, type: v.fieldDef.type, unit: v.fieldDef.unit,
          sort: v.fieldDef.sort, value: v.value,
        }))
        .sort((a, b) => a.sort - b.sort),
    })),
  };
}

/** The general, part-scoped read: live-part-gated, then delegates to `getRevisionContentUnchecked`
 *  for the actual content. */
export async function getRevision(partId: string, revisionNumber: number): Promise<RevisionDetail> {
  const part = await prisma.part.findFirst({ where: { id: partId, deletedAt: null }, select: { id: true } });
  if (!part) throw new HttpError(404, "Part not found");
  return getRevisionContentUnchecked(partId, revisionNumber);
}

/** The old-step-id -> new-step-id mapping a revision cut produced, or `{}` when no cut happened.
 *  Returned by every mutator so the client can follow per-step UI state (unsaved drafts) across a
 *  cut, whose copies carry brand-new ids — without it, a structural action on a locked revision
 *  silently discarded whatever the user had typed into some other step (Codex, PR #22). Plain
 *  object rather than a Map: this crosses the wire as JSON. */
export type StepIdMapping = Record<string, string>;

const asMapping = (m: Map<string, string> | null): StepIdMapping =>
  m ? Object.fromEntries(m) : {};

export async function addStep(
  partId: string, input: { codeId: string; instruction?: string; values?: { fieldDefId: string; value: string }[] },
): Promise<{ revisionNumber: number; stepId: string; stepIdMap: StepIdMapping }> {
  const data = ADD.parse(input);
  return withDbErrors({ entity: "Process step" }, () =>
    prisma.$transaction(async (tx) => {
      await assertRefExists("processStepCode", data.codeId, tx);
      const { rev, stepIdMap } = await workingRevision(partId, tx);
      const nextPosition = (await tx.partProcessStep.count({ where: { revisionId: rev.id } })) + 1;
      let stepId = "";
      await auditedUpdate("partProcessRevision", rev.id, async () => {
        const step = await tx.partProcessStep.create({
          data: { revisionId: rev.id, position: nextPosition, codeId: data.codeId, instruction: data.instruction },
        });
        stepId = step.id;
        await applyValues(tx, step.id, data.codeId, data.values);
      }, { tx });
      return { revisionNumber: rev.revisionNumber, stepId, stepIdMap: asMapping(stepIdMap) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export async function updateStep(
  partId: string, stepId: string, input: { instruction?: string; values?: { fieldDefId: string; value: string }[] },
): Promise<{ revisionNumber: number; stepIdMap: StepIdMapping }> {
  const data = EDIT.parse(input);
  // Before `workingRevision`, deliberately: reaching it is what cuts N+1 off a locked revision,
  // and a patch that cannot change anything has no business doing that. `{}` and `{ values: [] }`
  // both satisfy EDIT's shape — every field is optional, and `applyValues` no-ops on an empty
  // array — so without this an empty request against a locked revision returned success having
  // permanently added a revision identical to the one it superseded, plus a before===after audit
  // entry. Shape belongs in the schema; "must actually say something" is a rule about the
  // request, so it lives here.
  if (data.instruction === undefined && !data.values?.length) {
    throw new HttpError(400, "Nothing to change — send an instruction or at least one value");
  }
  return withDbErrors({ entity: "Process step" }, () =>
    prisma.$transaction(async (tx) => {
      const { rev, stepIdMap } = await workingRevision(partId, tx);
      const step = await resolveStep(tx, rev, stepIdMap, stepId);
      await auditedUpdate("partProcessRevision", rev.id, async () => {
        if (data.instruction !== undefined) {
          await tx.partProcessStep.update({ where: { id: step.id }, data: { instruction: data.instruction } });
        }
        if (data.values !== undefined) await applyValues(tx, step.id, step.codeId, data.values);
      }, { tx });
      return { revisionNumber: rev.revisionNumber, stepIdMap: asMapping(stepIdMap) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export async function removeStep(
  partId: string, stepId: string,
): Promise<{ revisionNumber: number; stepIdMap: StepIdMapping }> {
  return withDbErrors({ entity: "Process step" }, () =>
    prisma.$transaction(async (tx) => {
      const { rev, stepIdMap } = await workingRevision(partId, tx);
      const step = await resolveStep(tx, rev, stepIdMap, stepId);
      await auditedUpdate("partProcessRevision", rev.id, async () => {
        await tx.partProcessStepValue.deleteMany({ where: { stepId: step.id } });
        await tx.partProcessStep.delete({ where: { id: step.id } });
        // Close the position gap: per-row updates in ascending position order, each shift
        // vacating the slot the next update needs, so no step ever collides with
        // @@unique([revisionId, position]) mid-loop.
        const rest = await tx.partProcessStep.findMany({
          where: { revisionId: rev.id, position: { gt: step.position } },
          orderBy: { position: "asc" },
        });
        for (const s of rest) {
          await tx.partProcessStep.update({ where: { id: s.id }, data: { position: s.position - 1 } });
        }
      }, { tx });
      return { revisionNumber: rev.revisionNumber, stepIdMap: asMapping(stepIdMap) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export async function reorderSteps(
  partId: string, orderedStepIds: string[],
): Promise<{ revisionNumber: number; stepIdMap: StepIdMapping }> {
  return withDbErrors({ entity: "Process step" }, () =>
    prisma.$transaction(async (tx) => {
      const { rev, stepIdMap } = await workingRevision(partId, tx);
      const mapped = stepIdMap ? orderedStepIds.map((id) => stepIdMap.get(id) ?? id) : orderedStepIds;
      const live = await tx.partProcessStep.findMany({ where: { revisionId: rev.id }, select: { id: true } });
      const liveIds = new Set(live.map((s) => s.id));
      const noDuplicates = new Set(mapped).size === mapped.length;
      const sameSet = noDuplicates && mapped.length === liveIds.size && mapped.every((id) => liveIds.has(id));
      if (!sameSet) throw new HttpError(400, "The order must list every step exactly once");
      await auditedUpdate("partProcessRevision", rev.id, async () => {
        // Two-phase, same pattern as the 2C-2 reorder precedent: park every row at a negative
        // position first so the second pass's final positions never collide with a row that
        // hasn't moved yet, against @@unique([revisionId, position]).
        for (const [index, id] of mapped.entries()) {
          await tx.partProcessStep.update({ where: { id }, data: { position: -(index + 1) } });
        }
        for (const [index, id] of mapped.entries()) {
          await tx.partProcessStep.update({ where: { id }, data: { position: index + 1 } });
        }
      }, { tx });
      return { revisionNumber: rev.revisionNumber, stepIdMap: asMapping(stepIdMap) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** Thrown by `lockRevision`'s own `doIt` to short-circuit `auditedUpdate`'s unconditional write
 *  when the atomic `updateMany` claimed zero rows — i.e. a concurrent caller already locked this
 *  revision first. Caught immediately below and turned into a silent, unaudited no-op; never
 *  escapes this function. */
class RevisionAlreadyLocked extends Error {}

/**
 * Sets `lockedAt` once (spec §5.5) — idempotent: a second call against an already-locked
 * revision is a silent no-op, not an error, and writes no audit entry. Exported for Phase 3's
 * order save to call inside the order's own transaction; nothing in this phase calls it.
 *
 * Concurrency contract: "already locked" is decided by the atomic `updateMany`'s own row count,
 * not by a prior JS-level read of `lockedAt` — a check-then-act shape (read `lockedAt`, branch,
 * then write) would let two overlapping callers both read `lockedAt: null`, both conclude "I'm
 * the one locking it", and both write an audit "update" entry, one of them with before===after
 * for a lock that never actually happened on the DB. Instead, the `updateMany`'s own
 * `lockedAt: null` guard runs as the mutation itself, inside `auditedUpdate`'s doIt — so the
 * before-snapshot is taken before it, and only the caller whose `updateMany` actually claims the
 * row (`count === 1`) reaches `auditedUpdate`'s write. The loser's `count === 0` throws
 * `RevisionAlreadyLocked`, which prevents `doIt` from returning normally and therefore prevents
 * `auditedUpdate` from ever calling `write()` — caught here and turned into the documented
 * silent no-op.
 */
export async function lockRevision(
  partId: string, revisionNumber: number, tx: Prisma.TransactionClient,
): Promise<void> {
  const existing = await tx.partProcessRevision.findFirst({
    where: { partId, revisionNumber }, select: { id: true },
  });
  if (!existing) throw new HttpError(404, "Revision not found");
  try {
    await auditedUpdate("partProcessRevision", existing.id, async () => {
      const { count } = await tx.partProcessRevision.updateMany({
        where: { id: existing.id, lockedAt: null }, data: { lockedAt: new Date() },
      });
      if (count === 0) throw new RevisionAlreadyLocked();
    }, { tx });
  } catch (err) {
    if (err instanceof RevisionAlreadyLocked) return; // lost the race — no audit, no error
    throw err;
  }
}

/** Same claim SQL as workingRevision — this file is the only home of that `FOR UPDATE` (HANDOFF
 *  §4a: the row lock is the guarantee at ANY caller isolation, not the transaction's own level).
 *  Exported for Phase 3's order save to call inside its own Serializable transaction
 *  (orders.ts:522). Caveat: the `ORDER BY … DESC LIMIT 1` target is chosen before blocking and
 *  isn't re-picked on wake; benign today because new revisions are only ever cut through
 *  workingRevision's own claim on this same row. */
export async function lockCurrentRevision(
  partId: string, tx: Prisma.TransactionClient,
): Promise<{ revisionNumber: number }> {
  const part = await tx.part.findFirst({ where: { id: partId, deletedAt: null }, select: { id: true } });
  if (!part) throw new HttpError(404, "Part not found");
  const claimed = await tx.$queryRaw<{ id: string; revisionNumber: number }[]>`
    SELECT "id", "revisionNumber" FROM "PartProcessRevision"
    WHERE "partId" = ${partId} ORDER BY "revisionNumber" DESC LIMIT 1 FOR UPDATE`;
  if (claimed.length === 0) throw new HttpError(400, "This part has no process steps");
  const stepCount = await tx.partProcessStep.count({ where: { revisionId: claimed[0].id } });
  if (stepCount === 0) throw new HttpError(400, "This part has no process steps");
  await lockRevision(partId, claimed[0].revisionNumber, tx);
  return { revisionNumber: claimed[0].revisionNumber };
}

/**
 * Loads a template's blank structure onto the part's working revision — REPLACE, not merge
 * (spec §8 / owner ruling §3.1): every existing step and value of the working revision is
 * deleted, then one step is created per template step (position and code copied, `instruction`
 * seeded from the template step's `boilerplate`, zero value rows). The confirm-before-replace UX
 * is Task 10's job on the client; this service just replaces. Cuts N+1 first if the current
 * revision is locked, same as every other mutator in this file.
 *
 * A template is picked live from a list, not held as a stored assignment — nothing references
 * templates the way step assignments reference codes — so a soft-deleted or inactive template is
 * refused outright rather than getting the §5.14 "inactive still valid" treatment codes get.
 */
export async function loadTemplate(partId: string, templateId: string): Promise<{ revisionNumber: number }> {
  return withDbErrors({ entity: "Process step" }, () =>
    prisma.$transaction(async (tx) => {
      const { rev } = await workingRevision(partId, tx);
      const template = await tx.processTemplate.findFirst({
        where: { id: templateId, deletedAt: null },
        include: { steps: { orderBy: { position: "asc" } } },
      });
      if (!template) throw new HttpError(404, "Template not found");
      if (!template.active) throw new HttpError(400, "That template is inactive");
      const distinctCodeIds = [...new Set(template.steps.map((s) => s.codeId))];
      for (const codeId of distinctCodeIds) {
        await assertRefExists("processStepCode", codeId, tx);
      }
      await auditedUpdate("partProcessRevision", rev.id, async () => {
        await tx.partProcessStepValue.deleteMany({ where: { step: { revisionId: rev.id } } });
        await tx.partProcessStep.deleteMany({ where: { revisionId: rev.id } });
        for (const s of template.steps) {
          await tx.partProcessStep.create({
            data: { revisionId: rev.id, position: s.position, codeId: s.codeId, instruction: s.boilerplate },
          });
        }
      }, { tx });
      // No `stepIdMap` here, unlike every other mutator: loadTemplate REPLACES the working
      // revision's steps outright, so no step survives for a draft to follow, and discarding them
      // is the correct outcome — the user has already confirmed replacing what was there.
      return { revisionNumber: rev.revisionNumber };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
