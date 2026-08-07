import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";
import { TARGET_LABELS } from "../lib/reference-links";
import { findBlockers } from "./reference-blockers";
import {
  SURCHARGE_KINDS, SURCHARGE_SCOPES, type SurchargeKindValue, type SurchargeScopeValue,
} from "../lib/invoice-constants";

export type SurchargeRow = {
  id: string; name: string; kind: SurchargeKindValue;
  rate: number | null; amount: number | null; minimumAmount: number | null;
  glAccountId: string | null; glAccountName: string | null; needsGlAccount: boolean;
  scope: SurchargeScopeValue; position: number; active: boolean;
  stepCodeIds: string[];
};

// Kept in sync with prisma/schema.prisma's @db.Decimal declarations on Surcharge.
const FIELDS = {
  name: z.string().trim().min(1).max(60),
  kind: z.enum(SURCHARGE_KINDS),
  rate: decimalField(9, 6, { min: "nonnegative" }),
  amount: decimalField(12, 2, { min: "nonnegative" }),
  minimumAmount: decimalField(12, 2, { min: "nonnegative" }),
  glAccountId: z.string().nullable().optional(),
  scope: z.enum(SURCHARGE_SCOPES).optional(),
  position: z.number().int().min(0),
  active: z.boolean().optional(),
};

// PERCENT/FLAT are mutually exclusive with rate/amount — expressed once here, not in the
// service body, so the messages are field-anchored regardless of which caller triggers them.
const SAVE = z.object(FIELDS).strict().superRefine((v, ctx) => {
  if (v.kind === "PERCENT") {
    if (v.rate == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rate"], message: "A percent surcharge needs a rate" });
    }
    if (v.amount != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ["amount"],
        message: "A percent surcharge cannot also carry a flat amount",
      });
    }
  } else {
    if (v.amount == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amount"], message: "A flat surcharge needs an amount" });
    }
    if (v.rate != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ["rate"],
        message: "A flat surcharge cannot also carry a rate",
      });
    }
  }
});

export async function listSurcharges(opts?: { includeInactive?: boolean }): Promise<SurchargeRow[]> {
  const rows = await prisma.surcharge.findMany({
    where: { deletedAt: null, ...(opts?.includeInactive ? {} : { active: true }) },
    include: {
      glAccount: { select: { name: true } },
      stepCodes: { select: { processStepCodeId: true }, orderBy: { processStepCodeId: "asc" } },
    },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id, name: r.name, kind: r.kind,
    rate: r.rate?.toNumber() ?? null, amount: r.amount?.toNumber() ?? null,
    minimumAmount: r.minimumAmount?.toNumber() ?? null,
    glAccountId: r.glAccountId, glAccountName: r.glAccount?.name ?? null,
    // Surfaced in the UI and asserted by 5C's export later — the processStepCode precedent
    // (process-step-codes.ts:80).
    needsGlAccount: r.glAccountId === null,
    scope: r.scope, position: r.position, active: r.active,
    stepCodeIds: r.stepCodes.map((sc) => sc.processStepCodeId),
  }));
}

/**
 * `createStepCode` verbatim (process-step-codes.ts:86-107): findFirst on the live name (partial
 * unique — findFirst, never findUnique), conditional Serializable only when glAccountId is
 * actually assigned (the FK-writer pattern), assertRefExists("glAccount", …, tx) inside that
 * same transaction so the check and the write commit or abort together.
 */
export async function createSurcharge(input: unknown): Promise<{ id: string }> {
  const data = SAVE.parse(input);

  const existing = await prisma.surcharge.findFirst({
    where: { name: data.name, deletedAt: null },
    select: { id: true },
  });
  if (existing) throw new HttpError(400, "A surcharge with that name already exists");

  const assignsGlAccount = data.glAccountId != null;
  const row = await withDbErrors({ entity: "Surcharge", conflictField: "name" }, () =>
    prisma.$transaction(async (tx) => {
      if (data.glAccountId) await assertRefExists("glAccount", data.glAccountId, tx);
      return auditedCreate("surcharge", data, () => tx.surcharge.create({ data }), { tx });
    }, assignsGlAccount ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined));
  return { id: row.id };
}

/** `updateStepCode` verbatim (process-step-codes.ts:109-119) — same conditional Serializable and
 *  assertRefExists shape. Takes the same full `SAVE` shape as create (not a partial patch): the
 *  kind/rate/amount consistency rule lives ONLY in `SAVE`'s superRefine, so a caller always
 *  submits the whole intended row rather than this function re-deriving merged state to
 *  re-validate a partial one. */
export async function updateSurcharge(id: string, input: unknown): Promise<void> {
  const data = SAVE.parse(input);
  const assignsGlAccount = data.glAccountId != null;
  await withDbErrors({ entity: "Surcharge", conflictField: "name" }, () =>
    prisma.$transaction(async (tx) => {
      if (data.glAccountId) await assertRefExists("glAccount", data.glAccountId, tx);
      await auditedUpdate("surcharge", id, () => tx.surcharge.update({ where: { id }, data }), { tx });
    }, assignsGlAccount ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined));
}

/**
 * `deleteStepCode` verbatim (process-step-codes.ts:142-148): the blocker scan and the soft
 * delete it guards run inside one Serializable transaction, not two separate statements, for
 * the same writer-side TOCTOU reason documented there.
 */
export async function deleteSurcharge(id: string): Promise<void> {
  const label = TARGET_LABELS.surcharge;
  await withDbErrors({ entity: "Surcharge" }, () =>
    prisma.$transaction(async (tx) => {
      const blockers = await findBlockers("surcharge", id, tx);
      if (blockers.length) {
        throw new HttpError(400, `That ${label} is still in use by ${blockers.length} record(s)`);
      }
      await auditedSoftDelete("surcharge", id, undefined, tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * Replace grid, no soft delete (§4.2) — SurchargeStepCode has no `deletedAt` of its own, so the
 * whole INCLUDE/EXCLUDE list is deleted and recreated in one shot, wrapped in a single
 * `auditedUpdate` against the parent surcharge so one audit row describes the whole replacement
 * (the setRolePermissions/setUserOverrides precedent). Serializable because it assigns a
 * registered FK per row (`assertRefExists("processStepCode", …, tx)`, the FK-writer pattern).
 */
export async function setSurchargeStepCodes(id: string, stepCodeIds: string[]): Promise<void> {
  const ids = z.array(z.string().min(1)).parse(stepCodeIds);
  if (new Set(ids).size !== ids.length) throw new HttpError(400, "Duplicate step code in the list");

  await withDbErrors({ entity: "Surcharge" }, () =>
    prisma.$transaction(async (tx) => {
      const surcharge = await tx.surcharge.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
      if (!surcharge) throw new HttpError(404, "Surcharge not found");
      for (const stepCodeId of ids) await assertRefExists("processStepCode", stepCodeId, tx);

      await auditedUpdate("surcharge", id, async () => {
        await tx.surchargeStepCode.deleteMany({ where: { surchargeId: id } });
        if (ids.length) {
          await tx.surchargeStepCode.createMany({
            data: ids.map((processStepCodeId) => ({ surchargeId: id, processStepCodeId })),
          });
        }
      }, { tx });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export type CustomerSurchargeRow = {
  surchargeId: string; surchargeName: string;
  optOut: boolean; rate: number | null; amount: number | null;
};

/** Every override this customer carries — plant-wide surcharges with no row here simply bill at
 *  their plant-wide definition (Task 9's pricing engine). Ordered by the surcharge's own display
 *  position, the same order the plant-wide list prints in. */
export async function listCustomerSurcharges(customerId: string): Promise<CustomerSurchargeRow[]> {
  const rows = await prisma.customerSurcharge.findMany({
    where: { customerId, deletedAt: null },
    include: { surcharge: { select: { name: true } } },
    orderBy: { surcharge: { position: "asc" } },
  });
  return rows.map((r) => ({
    surchargeId: r.surchargeId, surchargeName: r.surcharge.name,
    optOut: r.optOut, rate: r.rate?.toNumber() ?? null, amount: r.amount?.toNumber() ?? null,
  }));
}

const CUSTOMER_SURCHARGE = z.object({
  optOut: z.boolean().optional(),
  rate: decimalField(9, 6, { min: "nonnegative" }),
  amount: decimalField(12, 2, { min: "nonnegative" }),
}).strict();

/**
 * Upserts this customer's one override row for this surcharge — `(customerId, surchargeId)` is
 * unique only among live rows (findFirst, never findUnique/upsert, the partial-unique rule).
 * Serializable: surchargeId is always a freshly-checked FK (`assertRefExists`, the FK-writer
 * pattern), same as `addPartPrice`'s always-Serializable transaction.
 */
export async function setCustomerSurcharge(
  customerId: string, surchargeId: string, input: unknown,
): Promise<void> {
  const data = CUSTOMER_SURCHARGE.parse(input);
  await withDbErrors({ entity: "Customer surcharge" }, () =>
    prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: customerId, deletedAt: null }, select: { id: true } });
      if (!customer) throw new HttpError(404, "Customer not found");
      await assertRefExists("surcharge", surchargeId, tx);

      const existing = await tx.customerSurcharge.findFirst({
        where: { customerId, surchargeId, deletedAt: null }, select: { id: true },
      });
      if (existing) {
        await auditedUpdate("customerSurcharge", existing.id,
          () => tx.customerSurcharge.update({ where: { id: existing.id }, data }), { tx });
      } else {
        await auditedCreate("customerSurcharge", { customerId, surchargeId, ...data },
          () => tx.customerSurcharge.create({ data: { customerId, surchargeId, ...data } }), { tx });
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
