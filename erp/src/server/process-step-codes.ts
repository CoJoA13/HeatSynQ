import { z } from "zod";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { STEP_FIELD_TYPES, type StepFieldType } from "../lib/step-field-constants";

export type StepFieldInput = { label: string; type: StepFieldType; unit?: string | null; sort: number };
export type StepCode = {
  id: string; code: string; name: string; glAccountId: string | null;
  equipmentTag: string; active: boolean; needsGlAccount: boolean;
  fields: (StepFieldInput & { id: string })[];
};

const FIELD = z.object({
  label: z.string().min(1).max(60),
  type: z.enum(STEP_FIELD_TYPES),
  unit: z.string().max(20).nullable().optional(),
  sort: z.number().int().min(0),
});

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

  const row = await auditedCreate("processStepCode", data, () =>
    withDbErrors({ entity: "Process step code", conflictField: "code" }, () =>
      prisma.processStepCode.create({ data })));
  return { id: row.id };
}

export async function updateStepCode(id: string, input: Partial<z.input<typeof CREATE>> & { active?: boolean }) {
  const data = CREATE.partial().extend({ active: z.boolean().optional() }).strict().parse(input);
  await withDbErrors({ entity: "Process step code", conflictField: "code" }, () =>
    auditedUpdate("processStepCode", id, () => prisma.processStepCode.update({ where: { id }, data })));
}

export async function deleteStepCode(id: string): Promise<void> {
  await withDbErrors({ entity: "Process step code" }, () => auditedSoftDelete("processStepCode", id));
}

/** Replaces the entire field-definition set for a code. */
export async function setStepFields(id: string, fields: StepFieldInput[]): Promise<void> {
  const parsed = FIELDS_ARRAY.parse(fields);
  await withDbErrors({ entity: "Process step code" }, () =>
    auditedUpdate("processStepCode", id, async () => {
      // deleteMany/createMany against a nonexistent codeId both silently no-op (nothing to
      // delete, nothing violates a constraint when `fields` is empty), so without this check a
      // bad id would report success and write a useless before=null/after=null audit row
      // instead of 404ing the way updateStepCode does via Prisma's P2025.
      const exists = await prisma.processStepCode.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw new HttpError(404, "Process step code not found");
      return prisma.$transaction([
        prisma.processStepFieldDef.deleteMany({ where: { codeId: id } }),
        prisma.processStepFieldDef.createMany({
          data: parsed.map((f) => ({ codeId: id, label: f.label, type: f.type, unit: f.unit ?? null, sort: f.sort })),
        }),
      ]);
    }));
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
  const parsedFields = fields === undefined ? undefined : FIELDS_ARRAY.parse(fields);

  await withDbErrors({ entity: "Process step code", conflictField: "code" }, () =>
    auditedUpdate("processStepCode", id, () =>
      prisma.$transaction([
        // Runs first: a bad glAccountId fails here with P2003 before any field statement runs,
        // and the array form of $transaction rolls the whole batch back on any failure, so the
        // field definitions are left untouched either way.
        prisma.processStepCode.update({ where: { id }, data }),
        ...(parsedFields === undefined ? [] : [
          prisma.processStepFieldDef.deleteMany({ where: { codeId: id } }),
          prisma.processStepFieldDef.createMany({
            data: parsedFields.map((f) => ({ codeId: id, label: f.label, type: f.type, unit: f.unit ?? null, sort: f.sort })),
          }),
        ]),
      ])));
}
