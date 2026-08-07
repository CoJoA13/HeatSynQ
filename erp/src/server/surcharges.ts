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
 * The exact row `SAVE`'s superRefine validated, with every optional column pinned to its
 * explicit empty value (or the schema's own default) instead of left absent. zod drops an
 * absent `.optional()` key from its parsed output entirely, so handing the raw `SAVE.parse(...)`
 * result straight to `tx.surcharge.update({ data })` left an omitted column untouched — which is
 * exactly how a caller flipping PERCENT -> FLAT (who *cannot* resend `rate`; superRefine rejects
 * a FLAT surcharge that carries one) left a stale `rate` on the row after the save, a state the
 * service itself declares impossible (fix-wave review, Fix 1). `create` never needed this —
 * Prisma applies the schema's own `@default` to an absent key on `.create()` — but the values
 * below are exactly those defaults, so routing `create` through the same helper costs nothing and
 * keeps one function, not two, responsible for "what does an omitted field mean."
 */
function toSurchargeRow(data: z.infer<typeof SAVE>) {
  return {
    name: data.name, kind: data.kind, position: data.position,
    rate: data.rate ?? null,
    amount: data.amount ?? null,
    minimumAmount: data.minimumAmount ?? null,
    glAccountId: data.glAccountId ?? null,
    scope: data.scope ?? "ALL",
    active: data.active ?? true,
  };
}

/**
 * `createStepCode` verbatim (process-step-codes.ts:86-107): findFirst on the live name (partial
 * unique — findFirst, never findUnique), conditional Serializable only when glAccountId is
 * actually assigned (the FK-writer pattern), assertRefExists("glAccount", …, tx) inside that
 * same transaction so the check and the write commit or abort together.
 */
export async function createSurcharge(input: unknown): Promise<{ id: string }> {
  const data = SAVE.parse(input);
  const row = toSurchargeRow(data);

  const existing = await prisma.surcharge.findFirst({
    where: { name: data.name, deletedAt: null },
    select: { id: true },
  });
  if (existing) throw new HttpError(400, "A surcharge with that name already exists");

  const assignsGlAccount = data.glAccountId != null;
  const created = await withDbErrors({ entity: "Surcharge", conflictField: "name" }, () =>
    prisma.$transaction(async (tx) => {
      if (data.glAccountId) await assertRefExists("glAccount", data.glAccountId, tx);
      return auditedCreate("surcharge", row, () => tx.surcharge.create({ data: row }), { tx });
    }, assignsGlAccount ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined));
  return { id: created.id };
}

/**
 * `updateStepCode` verbatim (process-step-codes.ts:109-119) — same conditional Serializable and
 * assertRefExists shape. Takes the same full `SAVE` shape as create (not a partial patch): the
 * kind/rate/amount consistency rule lives ONLY in `SAVE`'s superRefine, so a caller always
 * submits the whole intended row rather than this function re-deriving merged state to
 * re-validate a partial one. Writes `toSurchargeRow(data)`, not `data` itself (Fix 1) — the
 * persisted row must equal the row superRefine validated, not just the keys the caller happened
 * to send. `where: { id, deletedAt: null }` follows the newer precedent at
 * process-step-codes.ts:309, not the older one this function was first modeled on
 * (process-step-codes.ts:119): a bare `where: { id }` mutates a row under a soft-deleted
 * surcharge and audits it as an update after its own delete entry, describing a change to a row
 * nothing can ever see again (Codex, PR #22). No match is P2025, which `withDbErrors` turns into
 * the "Surcharge not found" 404 this deserves.
 */
export async function updateSurcharge(id: string, input: unknown): Promise<void> {
  const data = SAVE.parse(input);
  const row = toSurchargeRow(data);
  const assignsGlAccount = data.glAccountId != null;
  await withDbErrors({ entity: "Surcharge", conflictField: "name" }, () =>
    prisma.$transaction(async (tx) => {
      if (data.glAccountId) await assertRefExists("glAccount", data.glAccountId, tx);
      await auditedUpdate("surcharge", id,
        () => tx.surcharge.update({ where: { id, deletedAt: null }, data: row }), { tx });
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
 *  position, the same order the plant-wide list prints in, with the same `id` tiebreak
 *  `listSurcharges` uses (`Surcharge.position` is not unique) so two overrides on same-position
 *  surcharges don't depend on Postgres's arbitrary tie order. */
export async function listCustomerSurcharges(customerId: string): Promise<CustomerSurchargeRow[]> {
  const rows = await prisma.customerSurcharge.findMany({
    where: { customerId, deletedAt: null },
    include: { surcharge: { select: { name: true } } },
    orderBy: [{ surcharge: { position: "asc" } }, { surcharge: { id: "asc" } }],
  });
  return rows.map((r) => ({
    surchargeId: r.surchargeId, surchargeName: r.surcharge.name,
    optOut: r.optOut, rate: r.rate?.toNumber() ?? null, amount: r.amount?.toNumber() ?? null,
  }));
}

export type CustomerSurchargeOptionRow = CustomerSurchargeRow & {
  kind: SurchargeKindValue;
  /** Whether a live `CustomerSurcharge` row exists for this pair — distinct from
   *  `optOut`/`rate`/`amount` reading their "no override" defaults, since a row that explicitly
   *  holds those same empty values is functionally identical (both bill at the plant-wide
   *  definition) but only the former has anything for `deleteCustomerSurcharge` to remove, and
   *  only the former is what blocks this surcharge's own deletion
   *  (customerSurcharge -> surcharge in reference-links.ts). The customer page's per-row "Clear
   *  override" control is gated on this, not on the field values. */
  hasOverride: boolean;
};

/**
 * Every ACTIVE plant-wide surcharge, each merged with this customer's own override where one
 * exists — the exact shape the customer page's Surcharge overrides section renders directly
 * (task-8 brief). Composed here, behind `customers` permissions only, specifically so that
 * screen never needs `admin.view` (the gate on `GET /api/admin/surcharges`) just to see what
 * surcharges exist to override — `change_prices` + `customers.edit` is already the complete,
 * correct gate for touching a customer's pricing (parts/[id]'s PricingSection precedent), and a
 * second, unrelated permission requirement here would be a silent capability gap, not a feature.
 *
 * A surcharge with no override row reads `optOut: false, rate: null, amount: null` — per
 * `listCustomerSurcharges`' own doc comment, indistinguishable in EFFECT from an override row
 * that explicitly holds those same values (both bill at the plant-wide definition); `hasOverride`
 * is what tells the two apart for the UI's "Clear override" control.
 */
export async function customerSurchargeOptions(customerId: string): Promise<CustomerSurchargeOptionRow[]> {
  const [surcharges, overrides] = await Promise.all([
    listSurcharges(),
    listCustomerSurcharges(customerId),
  ]);
  const byId = new Map(overrides.map((o) => [o.surchargeId, o]));
  return surcharges.map((s) => {
    const o = byId.get(s.id);
    return {
      surchargeId: s.id, surchargeName: s.name, kind: s.kind,
      optOut: o?.optOut ?? false, rate: o?.rate ?? null, amount: o?.amount ?? null,
      hasOverride: o !== undefined,
    };
  });
}

const CUSTOMER_SURCHARGE = z.object({
  optOut: z.boolean().optional(),
  rate: decimalField(9, 6, { min: "nonnegative" }),
  amount: decimalField(12, 2, { min: "nonnegative" }),
}).strict();

/** The exact row `CUSTOMER_SURCHARGE` validated, every optional column pinned to its explicit
 *  empty value — the `toSurchargeRow` fix (Fix 1) applied to this schema too. Without it,
 *  `setCustomerSurcharge`'s create branch (spread over schema defaults) and its update branch
 *  (a bare `data` that leaves an omitted key untouched) meant the exact same call — one carrying
 *  only `{ optOut: true }` — produced a DIFFERENT row depending on whether an override already
 *  existed: a fresh customer got `rate: null`, but a customer with a prior `{ rate: "0.05" }`
 *  override kept `rate: 0.05` retained underneath the new `optOut`. A function named `set…` that
 *  half-replaces on one branch and fully replaces on the other is a trap (fix-wave review, Fix
 *  2) — both branches now write this same normalized row. */
function toCustomerSurchargeRow(data: z.infer<typeof CUSTOMER_SURCHARGE>) {
  return { optOut: data.optOut ?? false, rate: data.rate ?? null, amount: data.amount ?? null };
}

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
  const row = toCustomerSurchargeRow(data);
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
          () => tx.customerSurcharge.update({ where: { id: existing.id }, data: row }), { tx });
      } else {
        await auditedCreate("customerSurcharge", { customerId, surchargeId, ...row },
          () => tx.customerSurcharge.create({ data: { customerId, surchargeId, ...row } }), { tx });
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * Removes this customer's override, restoring the surcharge to its plant-wide definition — the
 * escape hatch `setCustomerSurcharge` cannot provide, since its interface is create-or-update
 * only (Fix 5, fix-wave review). Without this, an override once created could never be removed,
 * and — because a live `CustomerSurcharge` row blocks its surcharge's deletion
 * (`customerSurcharge.surchargeId -> surcharge` in `REFERENCE_LINKS`) — a customer opted out of a
 * surcharge by mistake would permanently block that surcharge from ever being deleted: exactly
 * the undiscoverable dead end `reference-blockers.ts` exists to prevent.
 *
 * Soft-deleted through `auditedSoftDelete`, like every other row in this system —
 * `CustomerSurcharge.deletedAt` exists for exactly this. Looked up by the live
 * `(customerId, surchargeId)` pair (partial-unique, `findFirst`, never `findUnique`) rather than
 * by the row's own id, matching every other caller in this file; 404s when no live override
 * exists for that pair, whether none was ever created or one is already gone.
 */
export async function deleteCustomerSurcharge(customerId: string, surchargeId: string): Promise<void> {
  await withDbErrors({ entity: "Customer surcharge" }, () =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.customerSurcharge.findFirst({
        where: { customerId, surchargeId, deletedAt: null }, select: { id: true },
      });
      if (!existing) throw new HttpError(404, "Customer surcharge override not found");
      await auditedSoftDelete("customerSurcharge", existing.id, undefined, tx);
    }));
}
