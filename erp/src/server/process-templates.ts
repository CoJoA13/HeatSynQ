import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";

export type TemplateSummary = { id: string; name: string; active: boolean; stepCount: number; updatedAt: Date };
export type TemplateStepRow = {
  id: string; position: number; codeId: string; code: string; codeName: string; boilerplate: string;
};
export type TemplateDetail = { id: string; name: string; active: boolean; steps: TemplateStepRow[] };

const CREATE = z.object({ name: z.string().trim().min(1).max(120) }).strict();
const UPDATE = z.object({
  name: z.string().trim().min(1).max(120).optional(), active: z.boolean().optional(),
}).strict();
const ADD_STEP = z.object({
  codeId: z.string().min(1), boilerplate: z.string().max(4000).default(""),
}).strict();
const EDIT_STEP = z.object({ boilerplate: z.string().max(4000) }).strict();

/**
 * 404s a `templateId` that names no live row — the entry gate every step mutation below runs
 * first, mirroring `workingRevision`'s part-liveness check (part-process-steps.ts). A template's
 * steps stay mutable only while the template itself is live: without this, a stale id for a
 * soft-deleted template could still add/edit/remove/reorder its steps through this API even
 * though the template is gone from every list.
 */
async function assertTemplateLive(tx: Prisma.TransactionClient, templateId: string): Promise<void> {
  const template = await tx.processTemplate.findFirst({
    where: { id: templateId, deletedAt: null }, select: { id: true },
  });
  if (!template) throw new HttpError(404, "Template not found");
}

export async function listTemplates(opts?: { includeInactive?: boolean }): Promise<TemplateSummary[]> {
  const rows = await prisma.processTemplate.findMany({
    where: { deletedAt: null, ...(opts?.includeInactive ? {} : { active: true }) },
    orderBy: { name: "asc" },
    include: { _count: { select: { steps: true } } },
  });
  return rows.map((r) => ({
    id: r.id, name: r.name, active: r.active, stepCount: r._count.steps, updatedAt: r.updatedAt,
  }));
}

/** Full content of one template: ordered steps, each with the live code (code/name — renames
 *  propagate, spec §3.3) and its own boilerplate text. */
export async function getTemplate(id: string): Promise<TemplateDetail> {
  const row = await prisma.processTemplate.findFirst({
    where: { id, deletedAt: null },
    include: { steps: { orderBy: { position: "asc" }, include: { code: { select: { code: true, name: true } } } } },
  });
  if (!row) throw new HttpError(404, "Template not found");
  return {
    id: row.id, name: row.name, active: row.active,
    steps: row.steps.map((s) => ({
      id: s.id, position: s.position, codeId: s.codeId, code: s.code.code, codeName: s.code.name,
      boilerplate: s.boilerplate,
    })),
  };
}

export async function createTemplate(input: { name: string }): Promise<{ id: string }> {
  const data = CREATE.parse(input);

  // Courtesy 400 for the ordinary case; the partial unique index (name, live rows only) is the
  // real guard, and its P2002 maps through withDbErrors below for the race case. findFirst,
  // never findUnique — name is unique only among live rows, but the generated client still
  // types it unique, so findUnique would compile and silently return the soft-deleted row.
  const existing = await prisma.processTemplate.findFirst({
    where: { name: data.name, deletedAt: null }, select: { id: true },
  });
  if (existing) throw new HttpError(400, "A template with that name already exists");

  const row = await withDbErrors({ entity: "Template", conflictField: "name" }, () =>
    prisma.$transaction((tx) =>
      auditedCreate("processTemplate", data, () => tx.processTemplate.create({ data }), { tx })));
  return { id: row.id };
}

export async function updateTemplate(id: string, input: { name?: string; active?: boolean }): Promise<void> {
  const data = UPDATE.parse(input);
  await withDbErrors({ entity: "Template", conflictField: "name" }, () =>
    prisma.$transaction((tx) =>
      auditedUpdate("processTemplate", id, () => tx.processTemplate.update({ where: { id }, data }), { tx })));
}

/**
 * `reason` is required, not optional (spec §8 / handoff §5.17: deleting a template carries its
 * steps away and frees a unique name for reuse — same footing as a role delete). Enforced here,
 * not only at the route, so no future caller can bypass it.
 */
export async function deleteTemplate(id: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required");

  // Same gap as updateTemplate would have without a pre-check: without this, deleting an
  // already soft-deleted template would fall through to auditedSoftDelete's own updateMany
  // guard, which already 404s correctly — but this keeps the ordinary sequential-repeat case
  // fast and consistent with deleteCustomer/deletePart/deleteRole's own pre-check.
  const current = await prisma.processTemplate.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Template not found");

  await withDbErrors({ entity: "Template" }, () =>
    prisma.$transaction((tx) => auditedSoftDelete("processTemplate", id, why, tx)));
}

export async function addTemplateStep(
  templateId: string, input: { codeId: string; boilerplate?: string },
): Promise<{ id: string }> {
  const data = ADD_STEP.parse(input);
  return withDbErrors({ entity: "Template step" }, () =>
    prisma.$transaction(async (tx) => {
      await assertTemplateLive(tx, templateId);
      await assertRefExists("processStepCode", data.codeId, tx);
      const nextPosition = (await tx.processTemplateStep.count({ where: { templateId } })) + 1;
      let stepId = "";
      await auditedUpdate("processTemplate", templateId, async () => {
        const step = await tx.processTemplateStep.create({
          data: { templateId, position: nextPosition, codeId: data.codeId, boilerplate: data.boilerplate },
        });
        stepId = step.id;
      }, { tx });
      return { id: stepId };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export async function updateTemplateStep(
  templateId: string, stepId: string, input: { boilerplate: string },
): Promise<void> {
  const data = EDIT_STEP.parse(input);
  await withDbErrors({ entity: "Template step" }, () =>
    prisma.$transaction(async (tx) => {
      await assertTemplateLive(tx, templateId);
      const step = await tx.processTemplateStep.findFirst({ where: { id: stepId, templateId } });
      if (!step) throw new HttpError(404, "Template step not found");
      await auditedUpdate("processTemplate", templateId, () =>
        tx.processTemplateStep.update({ where: { id: step.id }, data: { boilerplate: data.boilerplate } }),
      { tx });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export async function removeTemplateStep(templateId: string, stepId: string): Promise<void> {
  await withDbErrors({ entity: "Template step" }, () =>
    prisma.$transaction(async (tx) => {
      await assertTemplateLive(tx, templateId);
      const step = await tx.processTemplateStep.findFirst({ where: { id: stepId, templateId } });
      if (!step) throw new HttpError(404, "Template step not found");
      await auditedUpdate("processTemplate", templateId, async () => {
        await tx.processTemplateStep.delete({ where: { id: step.id } });
        // Close the position gap: per-row updates in ascending position order, each shift
        // vacating the slot the next update needs, so no step ever collides with
        // @@unique([templateId, position]) mid-loop — same pattern as removeStep
        // (part-process-steps.ts).
        const rest = await tx.processTemplateStep.findMany({
          where: { templateId, position: { gt: step.position } },
          orderBy: { position: "asc" },
        });
        for (const s of rest) {
          await tx.processTemplateStep.update({ where: { id: s.id }, data: { position: s.position - 1 } });
        }
      }, { tx });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export async function reorderTemplateSteps(templateId: string, orderedStepIds: string[]): Promise<void> {
  await withDbErrors({ entity: "Template step" }, () =>
    prisma.$transaction(async (tx) => {
      await assertTemplateLive(tx, templateId);
      const live = await tx.processTemplateStep.findMany({ where: { templateId }, select: { id: true } });
      const liveIds = new Set(live.map((s) => s.id));
      const noDuplicates = new Set(orderedStepIds).size === orderedStepIds.length;
      const sameSet = noDuplicates && orderedStepIds.length === liveIds.size
        && orderedStepIds.every((id) => liveIds.has(id));
      if (!sameSet) throw new HttpError(400, "The order must list every step exactly once");
      await auditedUpdate("processTemplate", templateId, async () => {
        // Two-phase, same pattern as the 2C-2/Task-4 reorder precedent: park every row at a
        // negative position first so the second pass's final positions never collide with a row
        // that hasn't moved yet, against @@unique([templateId, position]).
        for (const [index, id] of orderedStepIds.entries()) {
          await tx.processTemplateStep.update({ where: { id }, data: { position: -(index + 1) } });
        }
        for (const [index, id] of orderedStepIds.entries()) {
          await tx.processTemplateStep.update({ where: { id }, data: { position: index + 1 } });
        }
      }, { tx });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
