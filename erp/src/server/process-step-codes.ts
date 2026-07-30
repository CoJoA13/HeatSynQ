import { z } from "zod";
import { prisma } from "./db";
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
  const parsed = z.array(FIELD).parse(fields);
  await withDbErrors({ entity: "Process step code" }, () =>
    auditedUpdate("processStepCode", id, () =>
      prisma.$transaction([
        prisma.processStepFieldDef.deleteMany({ where: { codeId: id } }),
        prisma.processStepFieldDef.createMany({
          data: parsed.map((f) => ({ codeId: id, label: f.label, type: f.type, unit: f.unit ?? null, sort: f.sort })),
        }),
      ])));
}
