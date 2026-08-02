import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";

export type InspectionRow = {
  id: string; inspectionCodeId: string; inspectionCodeName: string;
  scaleId: string | null; scaleName: string | null;
  min: number | null; max: number | null; location: string; sort: number;
};

// Kept in sync with prisma/schema.prisma's @db.Decimal declarations on PartInspection.
const FIELDS = {
  inspectionCodeId: z.string().min(1),
  scaleId: z.string().nullable().optional(),
  min: decimalField(10, 4),
  max: decimalField(10, 4),
  location: z.string().max(200).optional(),
  sort: z.number().int().min(0),
};
const ADD = z.object(FIELDS).strict().superRefine((v, ctx) => {
  if (v.min != null && v.max != null && v.min > v.max) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["min"], message: "min cannot exceed max" });
  }
});
// min/max cross-check is re-run against the merged (current + patch) values in the service,
// since a partial patch touching only one side of the pair can't be validated in isolation here.
const EDIT = z.object(FIELDS).partial().strict();

async function assertPartLive(partId: string, tx: Prisma.TransactionClient): Promise<void> {
  const part = await tx.part.findFirst({ where: { id: partId, deletedAt: null }, select: { id: true } });
  if (!part) throw new HttpError(404, "Part not found");
}

export async function listPartInspections(partId: string): Promise<InspectionRow[]> {
  const rows = await prisma.partInspection.findMany({
    where: { partId, deletedAt: null },
    include: { inspectionCode: { select: { name: true } }, scale: { select: { name: true } } },
    orderBy: { sort: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    inspectionCodeId: r.inspectionCodeId,
    inspectionCodeName: r.inspectionCode.name,
    scaleId: r.scaleId,
    scaleName: r.scale?.name ?? null,
    min: r.min?.toNumber() ?? null,
    max: r.max?.toNumber() ?? null,
    location: r.location,
    sort: r.sort,
  }));
}

export async function addPartInspection(partId: string, input: Record<string, unknown>): Promise<{ id: string }> {
  const data = ADD.parse(input);
  const row = await withDbErrors({ entity: "Inspection" }, () =>
    prisma.$transaction(async (tx) => {
      await assertPartLive(partId, tx);
      await assertRefExists("inspectionCode", data.inspectionCodeId, tx);
      if (data.scaleId != null) await assertRefExists("inspectionScale", data.scaleId, tx);
      return auditedCreate("partInspection", { partId, ...data }, () =>
        tx.partInspection.create({ data: { partId, ...data } }), { tx });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  return { id: row.id };
}

/** Writes only if still live and still scoped to this part, one statement — the claimLive
 *  precedent (parts.ts). */
async function claimLive(
  tx: Prisma.TransactionClient, id: string, partId: string, data: Prisma.PartInspectionUpdateManyMutationInput,
) {
  const { count } = await tx.partInspection.updateMany({ where: { id, partId, deletedAt: null }, data });
  if (count === 0) throw new HttpError(404, "Inspection not found");
}

export async function updatePartInspection(
  partId: string, inspId: string, input: Record<string, unknown>,
): Promise<void> {
  const patch = EDIT.parse(input);
  // Scoped purely for the ordinary "already gone" 404 — NOT what the min/max merge validates
  // against. A pre-transaction read is stale the instant a concurrent patch to the other bound
  // (this call touches only max, a racing call touches only min) commits between this read and
  // this call's own write; the merge below re-reads live, on tx, instead.
  const current = await prisma.partInspection.findFirst({
    where: { id: inspId, partId, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Inspection not found");

  const touchesMin = Object.hasOwn(input, "min");
  const touchesMax = Object.hasOwn(input, "max");
  const touchesCode = Object.hasOwn(input, "inspectionCodeId");
  const touchesScale = Object.hasOwn(input, "scaleId");
  // F5: Serializable now also covers a min/max touch, alongside the existing FK cases — a
  // cross-field invariant, not just the cross-row ones assertRefExists guards. Two concurrent
  // patches that each touch only one side of the min/max pair (one raising min, one lowering
  // max) must not each validate against a merge that's already stale by the time either commits
  // and jointly leave the row holding min > max; Postgres aborts whichever side would produce a
  // result no serial ordering could, surfacing as P2034 -> 409 via withDbErrors.
  const needsSerializable =
    (touchesCode && patch.inspectionCodeId != null) || (touchesScale && patch.scaleId != null) ||
    touchesMin || touchesMax;
  const iso = needsSerializable ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined;

  await withDbErrors({ entity: "Inspection" }, () =>
    prisma.$transaction(async (tx) => {
      if (touchesCode && patch.inspectionCodeId != null) {
        await assertRefExists("inspectionCode", patch.inspectionCodeId, tx);
      }
      if (touchesScale && patch.scaleId != null) {
        await assertRefExists("inspectionScale", patch.scaleId, tx);
      }
      // Re-read live, on tx, and merge against THIS read rather than the pre-check above — this
      // in-tx read is what the Serializable isolation above actually protects; validating
      // against the pre-check would leave the exact TOCTOU window the isolation bump is meant to
      // close.
      const live = await tx.partInspection.findFirst({ where: { id: inspId, partId, deletedAt: null } });
      if (!live) throw new HttpError(404, "Inspection not found");
      const mergedMin = touchesMin ? patch.min ?? null : live.min?.toNumber() ?? null;
      const mergedMax = touchesMax ? patch.max ?? null : live.max?.toNumber() ?? null;
      if (mergedMin != null && mergedMax != null && mergedMin > mergedMax) {
        throw new HttpError(400, "min cannot exceed max");
      }
      await auditedUpdate("partInspection", inspId, () => claimLive(tx, inspId, partId, patch), { tx });
    }, iso));
}

export async function deletePartInspection(partId: string, inspId: string): Promise<void> {
  const current = await prisma.partInspection.findFirst({
    where: { id: inspId, partId, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Inspection not found");
  await withDbErrors({ entity: "Inspection" }, () =>
    prisma.$transaction((tx) => auditedSoftDelete("partInspection", inspId, undefined, tx)));
}
