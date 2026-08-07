import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";
import { PRICE_PER, type PricePerValue } from "../lib/part-constants";

export type PartBreakRow = { id: string; threshold: number; price: number };
export type PartPriceRow = {
  id: string;
  processStepCodeId: string;
  stepCode: string;
  stepName: string;
  // The GL account rides along on the read so createInvoice never has to re-walk step codes to
  // find the account a revenue line posts to (P5A spec §3.4's whole reason for this restructure).
  glAccountId: string | null;
  glAccountName: string;
  position: number;
  setupCharge: number | null;
  unitPrice: number | null;
  minimumCharge: number | null;
  pricePer: PricePerValue;
  breaks: PartBreakRow[];
};

// Kept in sync with prisma/schema.prisma's @db.Decimal declarations on PartPrice.
const PRICE_FIELDS = {
  processStepCodeId: z.string().min(1),
  position: z.number().int().min(0),
  setupCharge: decimalField(12, 2, { min: "nonnegative" }),
  unitPrice: decimalField(12, 4, { min: "nonnegative" }),
  minimumCharge: decimalField(12, 2, { min: "nonnegative" }),
  pricePer: z.enum(PRICE_PER).optional(),
};
const ADD_PRICE = z.object(PRICE_FIELDS).strict();
const EDIT_PRICE = z.object(PRICE_FIELDS).partial().strict();

// Kept in sync with prisma/schema.prisma's @db.Decimal declarations on PartPriceBreak.
const BREAK_FIELDS = {
  threshold: decimalField(12, 2, { required: true, min: "positive" }),
  price: decimalField(12, 4, { required: true, min: "nonnegative" }),
};
const ADD_BREAK = z.object(BREAK_FIELDS).strict();
const EDIT_BREAK = z.object(BREAK_FIELDS).partial().strict();

const LOT_WITH_BREAKS = "A LOT-priced operation cannot carry price breaks";

export async function listPartPrices(partId: string): Promise<PartPriceRow[]> {
  const rows = await prisma.partPrice.findMany({
    where: { partId, deletedAt: null },
    include: {
      processStepCode: {
        select: { code: true, name: true, glAccountId: true, glAccount: { select: { name: true } } },
      },
      breaks: { where: { deletedAt: null }, orderBy: { threshold: "asc" } },
    },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id, processStepCodeId: r.processStepCodeId,
    stepCode: r.processStepCode.code, stepName: r.processStepCode.name,
    glAccountId: r.processStepCode.glAccountId,
    glAccountName: r.processStepCode.glAccount?.name ?? "",
    position: r.position,
    setupCharge: r.setupCharge?.toNumber() ?? null,
    unitPrice: r.unitPrice?.toNumber() ?? null,
    minimumCharge: r.minimumCharge?.toNumber() ?? null,
    pricePer: r.pricePer,
    breaks: r.breaks.map((b) => ({ id: b.id, threshold: b.threshold.toNumber(), price: b.price.toNumber() })),
  }));
}

/**
 * Serializable: assigns a registered FK (`processStepCodeId` -> `processStepCode`, checked via
 * `assertRefExists`), the FK-writer pattern (CLAUDE.md) that pairs a live read of the target with
 * the write inside one Serializable transaction.
 */
export async function addPartPrice(partId: string, input: Record<string, unknown>): Promise<{ id: string }> {
  const data = ADD_PRICE.parse(input);
  const row = await withDbErrors({ entity: "Price row", conflictField: "operation" }, () =>
    prisma.$transaction(async (tx) => {
      const part = await tx.part.findFirst({ where: { id: partId, deletedAt: null }, select: { id: true } });
      if (!part) throw new HttpError(404, "Part not found");
      await assertRefExists("processStepCode", data.processStepCodeId, tx);
      // Live-rows-only: the (partId, processStepCodeId) pair is unique only among live rows
      // (@@unique ... where: deletedAt IS NULL), so a deleted row must never block a re-price.
      // findFirst, never findUnique.
      const dupe = await tx.partPrice.findFirst({
        where: { partId, processStepCodeId: data.processStepCodeId, deletedAt: null }, select: { id: true } });
      if (dupe) throw new HttpError(400, "That operation is already priced on this part");
      return auditedCreate("partPrice", { partId, ...data }, () =>
        tx.partPrice.create({ data: { partId, ...data } }), { tx });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  return { id: row.id };
}

/** Writes only if still live and still scoped to this part, one statement — the claimLive
 *  precedent (parts.ts, part-price-breaks.ts). */
async function claimLivePrice(
  tx: Prisma.TransactionClient, id: string, partId: string, data: Prisma.PartPriceUpdateManyMutationInput,
) {
  const { count } = await tx.partPrice.updateMany({ where: { id, partId, deletedAt: null }, data });
  if (count === 0) throw new HttpError(404, "Price row not found");
}

export async function updatePartPrice(
  partId: string, priceId: string, input: Record<string, unknown>,
): Promise<void> {
  const patch = EDIT_PRICE.parse(input);
  const current = await prisma.partPrice.findFirst({
    where: { id: priceId, partId, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Price row not found");

  // Serializable whenever this assigns the FK (a processStepCodeId change, the FK-writer pattern)
  // OR touches pricePer — the latter is the write-skew partner of addPriceBreak's LOT read: both
  // sides must run Serializable for Postgres to abort the interleaving that would otherwise
  // produce a LOT row with live breaks.
  const iso = (patch.processStepCodeId !== undefined || patch.pricePer !== undefined)
    ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined;

  await withDbErrors({ entity: "Price row", conflictField: "operation" }, () =>
    prisma.$transaction(async (tx) => {
      if (patch.processStepCodeId !== undefined) {
        await assertRefExists("processStepCode", patch.processStepCodeId, tx);
        const dupe = await tx.partPrice.findFirst({
          where: {
            partId, processStepCodeId: patch.processStepCodeId, deletedAt: null, id: { not: priceId },
          },
          select: { id: true },
        });
        if (dupe) throw new HttpError(400, "That operation is already priced on this part");
      }
      if (patch.pricePer === "LOT") {
        const breakCount = await tx.partPriceBreak.count({ where: { partPriceId: priceId, deletedAt: null } });
        if (breakCount > 0) throw new HttpError(400, LOT_WITH_BREAKS);
      }
      await auditedUpdate("partPrice", priceId, () => claimLivePrice(tx, priceId, partId, patch), { tx });
    }, iso));
}

/** Its breaks are left as they are: the row is gone from every live read, and soft-deleting
 *  children individually would write audit noise for rows nothing can reach. */
export async function deletePartPrice(partId: string, priceId: string): Promise<void> {
  const current = await prisma.partPrice.findFirst({
    where: { id: priceId, partId, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Price row not found");
  await withDbErrors({ entity: "Price row" }, () =>
    prisma.$transaction((tx) => auditedSoftDelete("partPrice", priceId, undefined, tx)));
}

/**
 * Serializable: reads the price row's `pricePer` and writes a break — the write-skew partner of
 * `updatePartPrice`'s LOT check above, which reads breaks and writes `pricePer`. Both Serializable
 * is what lets Postgres abort the interleaving that would otherwise produce a LOT row with breaks.
 */
export async function addPriceBreak(
  partId: string, priceId: string, input: Record<string, unknown>,
): Promise<{ id: string }> {
  const data = ADD_BREAK.parse(input);
  const row = await withDbErrors({ entity: "Price break", conflictField: "threshold" }, () =>
    prisma.$transaction(async (tx) => {
      const price = await tx.partPrice.findFirst({
        where: { id: priceId, partId, deletedAt: null }, select: { pricePer: true } });
      if (!price) throw new HttpError(404, "Price row not found");
      if (price.pricePer === "LOT") throw new HttpError(400, LOT_WITH_BREAKS);
      const dupe = await tx.partPriceBreak.findFirst({
        where: { partPriceId: priceId, threshold: data.threshold, deletedAt: null }, select: { id: true } });
      if (dupe) throw new HttpError(400, "A price break with that threshold already exists");
      return auditedCreate("partPriceBreak", { partPriceId: priceId, ...data }, () =>
        tx.partPriceBreak.create({ data: { partPriceId: priceId, ...data } }), { tx });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  return { id: row.id };
}

/** Writes only if still live and still scoped to this price row, one statement — the claimLive
 *  precedent. */
async function claimLiveBreak(
  tx: Prisma.TransactionClient, id: string, partPriceId: string,
  data: Prisma.PartPriceBreakUpdateManyMutationInput,
) {
  const { count } = await tx.partPriceBreak.updateMany({ where: { id, partPriceId, deletedAt: null }, data });
  if (count === 0) throw new HttpError(404, "Price break not found");
}

export async function updatePriceBreak(
  partId: string, priceId: string, breakId: string, input: Record<string, unknown>,
): Promise<void> {
  const patch = EDIT_BREAK.parse(input);
  const price = await prisma.partPrice.findFirst({
    where: { id: priceId, partId, deletedAt: null }, select: { id: true } });
  if (!price) throw new HttpError(404, "Price row not found");
  const current = await prisma.partPriceBreak.findFirst({
    where: { id: breakId, partPriceId: priceId, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Price break not found");

  await withDbErrors({ entity: "Price break", conflictField: "threshold" }, () =>
    prisma.$transaction(async (tx) => {
      if (patch.threshold !== undefined) {
        const dupe = await tx.partPriceBreak.findFirst({
          where: {
            partPriceId: priceId, threshold: patch.threshold, deletedAt: null, id: { not: breakId },
          },
          select: { id: true },
        });
        if (dupe) throw new HttpError(400, "A price break with that threshold already exists");
      }
      await auditedUpdate("partPriceBreak", breakId, () => claimLiveBreak(tx, breakId, priceId, patch), { tx });
    }));
}

export async function deletePriceBreak(partId: string, priceId: string, breakId: string): Promise<void> {
  const price = await prisma.partPrice.findFirst({
    where: { id: priceId, partId, deletedAt: null }, select: { id: true } });
  if (!price) throw new HttpError(404, "Price row not found");
  const current = await prisma.partPriceBreak.findFirst({
    where: { id: breakId, partPriceId: priceId, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Price break not found");
  await withDbErrors({ entity: "Price break" }, () =>
    prisma.$transaction((tx) => auditedSoftDelete("partPriceBreak", breakId, undefined, tx)));
}
