import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { withDbErrors } from "./db-errors";
import { auditedUpdate } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";

const ID = "singleton";

export type BillingConfigRow = {
  salesTaxRate: number | null;
  salesTaxGlAccountId: string | null;
  freightGlAccountId: string | null;
  otherChargeGlAccountId: string | null;
  certChargeStepCodeId: string | null;
  certChargeDefault: number | null;
  billForCertDefault: boolean;
};

const EMPTY: BillingConfigRow = {
  salesTaxRate: null, salesTaxGlAccountId: null, freightGlAccountId: null,
  otherChargeGlAccountId: null, certChargeStepCodeId: null,
  certChargeDefault: null, billForCertDefault: false,
};

// Kept in sync with prisma/schema.prisma's @db.Decimal declarations on BillingConfig.
const SAVE = z.object({
  salesTaxRate: decimalField(9, 6, { min: "nonnegative" }),
  salesTaxGlAccountId: z.string().nullable().optional(),
  freightGlAccountId: z.string().nullable().optional(),
  otherChargeGlAccountId: z.string().nullable().optional(),
  certChargeStepCodeId: z.string().nullable().optional(),
  certChargeDefault: decimalField(12, 2, { min: "nonnegative" }),
  billForCertDefault: z.boolean().optional(),
}).partial().strict();

export async function getBillingConfig(db: Prisma.TransactionClient | typeof prisma = prisma): Promise<BillingConfigRow> {
  // The row is seeded by the migration, but truncateAll removes it between tests and a fresh
  // clone restores it — either way an absent row means "nothing configured", not an error.
  const row = await db.billingConfig.findFirst({ where: { id: ID } });
  if (!row) return EMPTY;
  return {
    salesTaxRate: row.salesTaxRate?.toNumber() ?? null,
    salesTaxGlAccountId: row.salesTaxGlAccountId,
    freightGlAccountId: row.freightGlAccountId,
    otherChargeGlAccountId: row.otherChargeGlAccountId,
    certChargeStepCodeId: row.certChargeStepCodeId,
    certChargeDefault: row.certChargeDefault?.toNumber() ?? null,
    billForCertDefault: row.billForCertDefault,
  };
}

export async function setBillingConfig(input: unknown): Promise<BillingConfigRow> {
  const data = SAVE.parse(input);
  // Serializable whenever an FK is actually being assigned — the createStepCode scoping
  // precedent (process-step-codes.ts:97-108). Clearing one to null needs neither.
  const assigns =
    data.salesTaxGlAccountId != null || data.freightGlAccountId != null ||
    data.otherChargeGlAccountId != null || data.certChargeStepCodeId != null;
  await withDbErrors({ entity: "Billing settings" }, () =>
    prisma.$transaction(async (tx) => {
      if (data.salesTaxGlAccountId) await assertRefExists("glAccount", data.salesTaxGlAccountId, tx);
      if (data.freightGlAccountId) await assertRefExists("glAccount", data.freightGlAccountId, tx);
      if (data.otherChargeGlAccountId) await assertRefExists("glAccount", data.otherChargeGlAccountId, tx);
      if (data.certChargeStepCodeId) await assertRefExists("processStepCode", data.certChargeStepCodeId, tx);
      await auditedUpdate("billingConfig", ID, () =>
        tx.billingConfig.upsert({ where: { id: ID }, create: { id: ID, ...data }, update: data }), { tx });
    }, assigns ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined));
  return getBillingConfig();
}
