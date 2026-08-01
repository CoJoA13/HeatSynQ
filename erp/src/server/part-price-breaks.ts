import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { decimalField } from "./decimal-field";

export type PartBreakRow = { id: string; threshold: number; price: number };

// Kept in sync with prisma/schema.prisma's @db.Decimal declarations on PartPriceBreak.
const FIELDS = {
  threshold: decimalField(12, 2, { required: true, min: "positive" }),
  price: decimalField(12, 4, { required: true, min: "nonnegative" }),
};
const ADD = z.object(FIELDS).strict();
const EDIT = z.object(FIELDS).partial().strict();

export async function listPartBreaks(partId: string): Promise<PartBreakRow[]> {
  const rows = await prisma.partPriceBreak.findMany({
    where: { partId, deletedAt: null },
    orderBy: { threshold: "asc" },
  });
  return rows.map((r) => ({ id: r.id, threshold: r.threshold.toNumber(), price: r.price.toNumber() }));
}

/**
 * Serializable: this reads `part.pricePer` and writes a break — the write-skew partner of
 * `updatePart`'s LOT check, which reads breaks and writes the part. Both Serializable is what
 * lets Postgres abort the interleaving that would otherwise produce a LOT part with breaks.
 */
export async function addPartBreak(partId: string, input: Record<string, unknown>): Promise<{ id: string }> {
  const data = ADD.parse(input);
  const row = await withDbErrors({ entity: "Price break", conflictField: "threshold" }, () =>
    prisma.$transaction(async (tx) => {
      const part = await tx.part.findFirst({
        where: { id: partId, deletedAt: null }, select: { pricePer: true } });
      if (!part) throw new HttpError(404, "Part not found");
      if (part.pricePer === "LOT") {
        throw new HttpError(400, "A LOT-priced part cannot carry price breaks");
      }
      const dupe = await tx.partPriceBreak.findFirst({
        where: { partId, threshold: data.threshold, deletedAt: null }, select: { id: true } });
      if (dupe) throw new HttpError(400, "A price break with that threshold already exists");
      return auditedCreate("partPriceBreak", { partId, ...data }, () =>
        tx.partPriceBreak.create({ data: { partId, ...data } }), { tx });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  return { id: row.id };
}

/** Writes only if still live and still scoped to this part, one statement — the claimLive
 *  precedent (part-inspections.ts). */
async function claimLive(
  tx: Prisma.TransactionClient, id: string, partId: string, data: Prisma.PartPriceBreakUpdateManyMutationInput,
) {
  const { count } = await tx.partPriceBreak.updateMany({ where: { id, partId, deletedAt: null }, data });
  if (count === 0) throw new HttpError(404, "Price break not found");
}

export async function updatePartBreak(
  partId: string, breakId: string, input: Record<string, unknown>,
): Promise<void> {
  const patch = EDIT.parse(input);
  const current = await prisma.partPriceBreak.findFirst({
    where: { id: breakId, partId, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Price break not found");

  await withDbErrors({ entity: "Price break", conflictField: "threshold" }, () =>
    prisma.$transaction(async (tx) => {
      if (patch.threshold !== undefined) {
        const dupe = await tx.partPriceBreak.findFirst({
          where: { partId, threshold: patch.threshold, deletedAt: null, id: { not: breakId } },
          select: { id: true },
        });
        if (dupe) throw new HttpError(400, "A price break with that threshold already exists");
      }
      await auditedUpdate("partPriceBreak", breakId, () => claimLive(tx, breakId, partId, patch), { tx });
    }));
}

export async function deletePartBreak(partId: string, breakId: string): Promise<void> {
  const current = await prisma.partPriceBreak.findFirst({
    where: { id: breakId, partId, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Price break not found");
  await withDbErrors({ entity: "Price break" }, () =>
    prisma.$transaction((tx) => auditedSoftDelete("partPriceBreak", breakId, undefined, tx)));
}
