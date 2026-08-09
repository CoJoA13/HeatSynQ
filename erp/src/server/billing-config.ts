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
  financeChargeRate: number | null;
};

const EMPTY: BillingConfigRow = {
  salesTaxRate: null, salesTaxGlAccountId: null, freightGlAccountId: null,
  otherChargeGlAccountId: null, certChargeStepCodeId: null,
  certChargeDefault: null, billForCertDefault: false, financeChargeRate: null,
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
  // Task 4 (P5B spec §4.3, §7): the plant default monthly finance-charge rate. Customer.
  // financeChargeRate (customers.ts) overrides this per customer — that override chain is Task
  // 11/12's concern; this field only carries the plant-wide fallback.
  financeChargeRate: decimalField(6, 4, { min: "nonnegative" }),
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
    financeChargeRate: row.financeChargeRate?.toNumber() ?? null,
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
      // upsert, not a plain update: the `create` arm only exists as self-healing for a genuinely
      // rowless database (a partial restore, a hand-run DELETE) — it is unreachable against any
      // migrated database, since the migration seeds this row and truncateAll (tests/helpers/db)
      // re-seeds it after every TRUNCATE. The CHECK ("id" = 'singleton') plus the primary key
      // mean the only row this arm can ever create is the correct one. A plain `update` would
      // instead raise P2025 on a missing row, surfacing as a 404 with no in-app recovery. If the
      // create arm ever did run, auditedUpdate logs it as an update with a null `before` (there
      // was no prior row to snapshot), which is expected and not a bug.
      await auditedUpdate("billingConfig", ID, () =>
        tx.billingConfig.upsert({ where: { id: ID }, create: { id: ID, ...data }, update: data }), { tx });
    }, assigns ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined));
  return getBillingConfig();
}
