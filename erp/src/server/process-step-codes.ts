import { z, ZodError } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { readableMessage } from "./error-message";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { STEP_FIELD_TYPES, type StepFieldType } from "../lib/step-field-constants";
import type { Blocker } from "./reference-blockers";

export type StepFieldInput = { id?: string; label: string; type: StepFieldType; unit?: string | null; sort: number };
export type StepCode = {
  id: string; code: string; name: string; glAccountId: string | null;
  equipmentTag: string; active: boolean; needsGlAccount: boolean;
  fields: (StepFieldInput & { id: string })[];
};

// .strict(): an unrecognized key (e.g. a stale client sending a field the schema doesn't know)
// 400s instead of being silently dropped — see the `id` field below for the defect that being
// non-strict was masking (HANDOFF §6).
const FIELD = z.object({
  // Present only for a field that already exists — see setStepFields's diff-by-id rework. Absent
  // (or omitted) means "create a new field def." Not validated against the target code here;
  // syncStepFields 404s an id that isn't actually one of this code's own defs.
  id: z.string().optional(),
  label: z.string().min(1).max(60),
  type: z.enum(STEP_FIELD_TYPES),
  unit: z.string().max(20).nullable().optional(),
  sort: z.number().int().min(0),
}).strict();

// `sort` drives both the on-screen field order and the printed traveler layout. Two fields
// sharing a `sort` would leave Postgres to tie-break `ORDER BY sort ASC` nondeterministically,
// so duplicates are rejected outright rather than silently accepted or auto-renumbered — a
// caller-supplied sort value is meaningful (see the "stores ordered field definitions" test,
// which relies on out-of-order input being placed by explicit `sort`, not array position).
const FIELDS_ARRAY = z.array(FIELD).superRefine((arr, ctx) => {
  const seen = new Set<number>();
  arr.forEach((f, i) => {
    if (seen.has(f.sort)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "sort"], message: `Duplicate sort value: ${f.sort}` });
    }
    seen.add(f.sort);
  });
});

const CREATE = z.object({
  code: z.string().min(1).max(30),
  name: z.string().min(1).max(100),
  glAccountId: z.string().nullable().optional(),
  equipmentTag: z.string().max(60).optional(),
}).strict();

/** `FIELDS_ARRAY.parse`, but a rejection (e.g. `.strict()`'s unrecognized-key error) becomes an
 *  ordinary `HttpError(400, ...)` instead of a raw `ZodError`. Routes never need this — `handle()`
 *  already maps `ZodError` to a 400 JSON response — but `setStepFields`/`updateStepCodeWithFields`
 *  are called directly by callers (and tests) that never pass through `handle()`, and every other
 *  refusal in this file already carries a `.status`; a field-payload rejection should too. */
function parseFields(fields: unknown): z.infer<typeof FIELDS_ARRAY> {
  try {
    return FIELDS_ARRAY.parse(fields);
  } catch (err) {
    if (err instanceof ZodError) throw new HttpError(400, readableMessage(err));
    throw err;
  }
}

export async function listStepCodes(opts?: { includeInactive?: boolean }): Promise<StepCode[]> {
  const rows = await prisma.processStepCode.findMany({
    where: { deletedAt: null, ...(opts?.includeInactive ? {} : { active: true }) },
    include: { fields: { orderBy: { sort: "asc" } } },
    orderBy: { code: "asc" },
  });
  return rows.map((r) => ({
    id: r.id, code: r.code, name: r.name, glAccountId: r.glAccountId,
    equipmentTag: r.equipmentTag, active: r.active,
    // Surfaced in the UI and asserted by Phase 5 before any QBO export runs.
    needsGlAccount: r.glAccountId === null,
    fields: r.fields.map((f) => ({ id: f.id, label: f.label, type: f.type, unit: f.unit, sort: f.sort })),
  }));
}

export async function createStepCode(input: z.input<typeof CREATE>): Promise<{ id: string }> {
  const data = CREATE.parse(input);

  // findFirst, NOT findUnique: `code` is unique only among live rows, but the generated client
  // still types it unique, so findUnique would compile and return the soft-deleted row.
  const existing = await prisma.processStepCode.findFirst({
    where: { code: data.code, deletedAt: null },
    select: { id: true },
  });
  if (existing) throw new HttpError(400, "A process step code with that code already exists");

  // Serializable is scoped to writes that actually assign the FK (spec §5.2) — a pure rename or
  // equipmentTag edit pays none of Serializable's abort-under-ordinary-concurrency cost. The
  // target is still validated on this transaction's own `tx` whenever it IS being assigned, for
  // the same reason as createCustomer's parentId/termsId checks (assertRefExists's doc comment
  // explains why the check must share the write's own transaction to close the writer-side
  // TOCTOU).
  const assignsGlAccount = data.glAccountId != null;
  const row = await withDbErrors({ entity: "Process step code", conflictField: "code" }, () =>
    prisma.$transaction(async (tx) => {
      if (data.glAccountId) await assertRefExists("glAccount", data.glAccountId, tx);
      return auditedCreate("processStepCode", data, () => tx.processStepCode.create({ data }), { tx });
    }, assignsGlAccount ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined));
  return { id: row.id };
}

export async function updateStepCode(id: string, input: Partial<z.input<typeof CREATE>> & { active?: boolean }) {
  const data = CREATE.partial().extend({ active: z.boolean().optional() }).strict().parse(input);
  // Same Serializable scoping as createStepCode above — see that comment. Clearing glAccountId
  // to null, or a patch that never touches it, needs neither the check nor Serializable.
  const assignsGlAccount = data.glAccountId != null;
  await withDbErrors({ entity: "Process step code", conflictField: "code" }, () =>
    prisma.$transaction(async (tx) => {
      if (data.glAccountId) await assertRefExists("glAccount", data.glAccountId, tx);
      await auditedUpdate("processStepCode", id, () => tx.processStepCode.update({ where: { id }, data }), { tx });
    }, assignsGlAccount ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined));
}

export async function deleteStepCode(id: string): Promise<void> {
  await withDbErrors({ entity: "Process step code" }, () =>
    prisma.$transaction((tx) => auditedSoftDelete("processStepCode", id, undefined, tx)));
}

/**
 * Diffs `parsed` against `codeId`'s current field defs by id, inside the caller's own `tx`:
 * items carrying an `id` update that def in place (so any `PartProcessStepValue` row pointing at
 * it keeps pointing at the same id); items with no `id` create a new def; an existing def absent
 * from the payload is deleted. Both a delete and a type change are refused with the two exact
 * messages below while ANY value still references the def — spec §6: "blocked while any
 * PartProcessStepValue references the def... locked revisions included"; §11 testing item 4:
 * "including only-historical values." Deliberately UNLIKE `stepFieldBlockers` below (which is
 * scoped to live parts only) and unlike the `partFieldDefBlockersOn` precedent this otherwise
 * follows (part-field-defs.ts, where the guard and the listing share one live-filtered query):
 * `ProcessStepFieldDef` has no `deletedAt` — deleting it here is a genuine hard delete against
 * `PartProcessStepValue.fieldDefId`'s `ON DELETE RESTRICT` FK, unlike `PartFieldDef`'s soft
 * delete. A live-filtered guard would let a def whose only reference is a value under a
 * soft-deleted part slip past this check and then hit that FK directly, trading this function's
 * field-named 400 for a raw, unhelpful DB error — worse discoverability, not better. See
 * task-3-report.md's fix-round note for the full trail (this was reverted from a live-filtered
 * version after a review round proposed it, citing the wrong spec rule).
 */
async function syncStepFields(
  tx: Prisma.TransactionClient, codeId: string, parsed: z.infer<typeof FIELDS_ARRAY>,
): Promise<void> {
  const existing = await tx.processStepFieldDef.findMany({ where: { codeId } });
  const existingById = new Map(existing.map((d) => [d.id, d]));
  const keptIds = new Set(parsed.flatMap((f) => (f.id !== undefined ? [f.id] : [])));

  for (const def of existing) {
    if (keptIds.has(def.id)) continue;
    const n = await tx.partProcessStepValue.count({ where: { fieldDefId: def.id } });
    if (n > 0) throw new HttpError(400, `Cannot remove field "${def.label}" — ${n} step value(s) use it`);
    await tx.processStepFieldDef.delete({ where: { id: def.id } });
  }

  for (const f of parsed) {
    if (f.id !== undefined) {
      const def = existingById.get(f.id);
      // Not this code's own def (stale id, or one from another code entirely) — fail loudly
      // rather than silently falling back to a create that drops the caller's intended id.
      if (!def) throw new HttpError(404, "Process step field not found");
      if (def.type !== f.type) {
        const n = await tx.partProcessStepValue.count({ where: { fieldDefId: def.id } });
        if (n > 0) {
          throw new HttpError(400, `Cannot change the type of "${def.label}" — ${n} step value(s) use it`);
        }
      }
      await tx.processStepFieldDef.update({
        where: { id: def.id },
        data: { label: f.label, type: f.type, unit: f.unit ?? null, sort: f.sort },
      });
    } else {
      await tx.processStepFieldDef.create({
        data: { codeId, label: f.label, type: f.type, unit: f.unit ?? null, sort: f.sort },
      });
    }
  }
}

/** Applies the field-definition diff described on `syncStepFields`. */
export async function setStepFields(id: string, fields: StepFieldInput[]): Promise<void> {
  const parsed = parseFields(fields);
  await withDbErrors({ entity: "Process step code" }, () =>
    prisma.$transaction((tx) =>
      auditedUpdate("processStepCode", id, async () => {
        // syncStepFields alone would silently no-op against a nonexistent codeId when `fields` is
        // empty (nothing to delete, nothing to create), so without this check a bad id would
        // report success and write a useless before=null/after=null audit row instead of 404ing
        // the way updateStepCode does via Prisma's P2025.
        const exists = await tx.processStepCode.findUnique({ where: { id }, select: { id: true } });
        if (!exists) throw new HttpError(404, "Process step code not found");
        await syncStepFields(tx, id, parsed);
      }, { tx }),
    // Serializable: the delete/type-change refusals above are count-then-act against
    // PartProcessStepValue — the same TOCTOU the deletePartFieldDef/updatePartFieldDef precedent
    // (part-field-defs.ts) closes with Serializable rather than leaving a concurrent value insert
    // free to slip in between the count and the write.
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * Every LIVE part holding a value for this field def, deduped per part, `CODE · partNumber`
 * named with an `/parts/[id]` href — the partFieldDefBlockers precedent (part-field-defs.ts),
 * scoped through step -> revision -> part instead of a direct part relation. Deliberately
 * narrower than `syncStepFields`'s guard above (which counts every value, live or not) — this
 * lists parts worth a caller's attention (something they could go edit), not every row that
 * happens to keep the def permanently undeletable. A def whose only reference is a value under
 * a soft-deleted part legitimately returns `[]` here while the guard still refuses; see the
 * comment on `syncStepFields` for why that asymmetry is correct rather than a drift bug.
 */
export async function stepFieldBlockers(fieldDefId: string): Promise<Blocker[]> {
  const values = await prisma.partProcessStepValue.findMany({
    where: { fieldDefId, step: { revision: { part: { deletedAt: null } } } },
    include: {
      step: {
        include: {
          revision: {
            include: { part: { select: { id: true, partNumber: true, customer: { select: { code: true } } } } },
          },
        },
      },
    },
    orderBy: { id: "asc" },
  });
  const seen = new Set<string>();
  const out: Blocker[] = [];
  for (const v of values) {
    const part = v.step.revision.part;
    if (seen.has(part.id)) continue;
    seen.add(part.id);
    out.push({
      entityLabel: "Part", name: `${part.customer.code} · ${part.partNumber}`,
      id: part.id, href: `/parts/${part.id}`,
    });
  }
  return out;
}

export type StepCodeUpdateInput = Partial<z.input<typeof CREATE>> & { active?: boolean; fields?: StepFieldInput[] };

/**
 * Applies scalar column changes and a field-definition replacement as a single atomic
 * transaction backed by exactly one audit row. Used by the PUT route, which can carry both
 * kinds of change in one request: without this, a valid `fields` array committed ahead of a
 * rejected scalar change (e.g. a bad `glAccountId`) would leave the code with new fields but
 * stale scalar values — one logical request, partially applied, and two audit rows for what
 * the caller experienced as a single PUT. `setStepFields` and `updateStepCode` stay as they
 * are for callers that only ever touch one side.
 */
export async function updateStepCodeWithFields(id: string, input: StepCodeUpdateInput): Promise<void> {
  const { fields, ...rest } = input;
  const data = CREATE.partial().extend({ active: z.boolean().optional() }).strict().parse(rest);
  const parsedFields = fields === undefined ? undefined : parseFields(fields);

  // Same Serializable scoping as createStepCode above — see that comment. `parsedFields` adds a
  // second, independent reason: syncStepFields's delete/type-change refusals are count-then-act
  // against PartProcessStepValue (see setStepFields), so a request carrying `fields` needs the
  // same isolation even when it never touches glAccountId.
  const assignsGlAccount = data.glAccountId != null;
  const needsSerializable = assignsGlAccount || parsedFields !== undefined;
  await withDbErrors({ entity: "Process step code", conflictField: "code" }, () =>
    prisma.$transaction(async (tx) => {
      // Runs first, on this transaction's own `tx`: a bad glAccountId is rejected here before
      // any field statement runs, and the transaction rolls the whole batch back on any failure,
      // so the field definitions are left untouched either way.
      if (data.glAccountId) await assertRefExists("glAccount", data.glAccountId, tx);
      await auditedUpdate("processStepCode", id, async () => {
        await tx.processStepCode.update({ where: { id }, data });
        if (parsedFields !== undefined) await syncStepFields(tx, id, parsedFields);
      }, { tx });
    }, needsSerializable ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined));
}
