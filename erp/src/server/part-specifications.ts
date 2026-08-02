import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";

async function assertPartLive(partId: string, tx: Prisma.TransactionClient): Promise<void> {
  const part = await tx.part.findFirst({ where: { id: partId, deletedAt: null }, select: { id: true } });
  if (!part) throw new HttpError(404, "Part not found");
}

export async function listPartSpecs(partId: string) {
  const rows = await prisma.partSpecification.findMany({
    where: { partId, deletedAt: null },
    include: { specification: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({ id: r.id, specificationId: r.specificationId, specificationName: r.specification.name }));
}

export async function addPartSpec(partId: string, specificationId: string): Promise<{ id: string }> {
  const row = await withDbErrors({ entity: "Specification link", conflictField: "specification" }, () =>
    prisma.$transaction(async (tx) => {
      await assertPartLive(partId, tx);
      await assertRefExists("specification", specificationId, tx);
      const dupe = await tx.partSpecification.findFirst({
        where: { partId, specificationId, deletedAt: null }, select: { id: true } });
      if (dupe) throw new HttpError(400, "That specification is already on this part");
      return auditedCreate("partSpecification", { partId, specificationId }, () =>
        tx.partSpecification.create({ data: { partId, specificationId } }), { tx });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  return { id: row.id };
}

export async function removePartSpec(partId: string, linkId: string): Promise<void> {
  const current = await prisma.partSpecification.findFirst({
    where: { id: linkId, partId, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Specification link not found");
  await withDbErrors({ entity: "Specification link" }, () =>
    prisma.$transaction((tx) => auditedSoftDelete("partSpecification", linkId, undefined, tx)));
}
