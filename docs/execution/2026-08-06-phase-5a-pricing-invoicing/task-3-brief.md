### Task 3: `billing-config.ts` + Admin → Billing

**Files:**
- Create: `src/server/billing-config.ts`, `src/app/api/admin/billing/route.ts`, `src/app/admin/billing/page.tsx`
- Modify: `src/components/Shell.tsx` (no nav change — Billing lives under Admin, reached from `/admin`), `src/app/admin/page.tsx` (add the card/link)
- Test: `tests/billing-config.test.ts`

**Interfaces:**
- Consumes: `assertRefExists(kind, id, tx)` (`src/server/reference-guards.ts:23`), `auditedUpdate`, `withDbErrors`.
- Produces:
```ts
// src/server/billing-config.ts
export type BillingConfigRow = {
  salesTaxRate: number | null;
  salesTaxGlAccountId: string | null;
  freightGlAccountId: string | null;
  otherChargeGlAccountId: string | null;
  certChargeStepCodeId: string | null;
  certChargeDefault: number | null;
  billForCertDefault: boolean;
};
export async function getBillingConfig(db?: Prisma.TransactionClient): Promise<BillingConfigRow>;
export async function setBillingConfig(input: unknown): Promise<BillingConfigRow>;
```

> **Amended after Task 2 (2026-08-06).** `tests/part-price-breaks.test.ts` **no longer exists** — Task 2 deleted it with the rest of the old pricing surface. Take the harness idiom (`beforeEach(truncateAll)`, `asSystem` wrapping `runWithContext({ actor: { id: null, name: "test" }, user: null }, fn)`) from any current service test, e.g. `tests/certs.test.ts`.
>
> **And `truncateAll()` now RE-SEEDS the `BillingConfig` singleton** (`tests/helpers/db.ts`, Task 2). That is deliberate and correct — production can never have zero rows (the migration seeds it and a CHECK pins the id), so a test database without it would encode a state production cannot reach. The consequence for you: **`getBillingConfig`'s `if (!row) return EMPTY` branch is unreachable under `truncateAll`.** Keep the fallback — a fresh clone or a restore can genuinely arrive without the row — but a test of it must delete the row explicitly first, or it asserts nothing. Both cases are written out below.

- [ ] **Step 1: Write the failing test** `tests/billing-config.test.ts`:

```ts
it("returns the seeded singleton with everything unset", async () => {
  const cfg = await getBillingConfig();
  expect(cfg).toEqual({
    salesTaxRate: null, salesTaxGlAccountId: null, freightGlAccountId: null,
    otherChargeGlAccountId: null, certChargeStepCodeId: null,
    certChargeDefault: null, billForCertDefault: false,
  });
});

// The fallback branch, which truncateAll's re-seed would otherwise make unreachable: delete the
// row first, so this test can actually fail if the `if (!row) return EMPTY` guard is removed.
it("returns the defaults when the row is genuinely absent (a fresh clone, a restore)", async () => {
  await prisma.billingConfig.deleteMany({});
  const cfg = await getBillingConfig();
  expect(cfg.salesTaxRate).toBeNull();
  expect(cfg.billForCertDefault).toBe(false);
});

// Task 2 hand-wrote BILLING_CONFIG_BLOCKER to repair a defect in this plan's own registry
// snippet, and nothing exercises its displayName/blockerId yet — the queries are proven valid
// (they run on every GL-account delete), but no test has ever had a matching row. BillingConfig
// has no `name` column, so findBlockers' default would print "singleton" at a user.
it("refuses to delete a GL account the billing settings point at, naming it usefully", async () => {
  const gl = await prisma.glAccount.create({ data: { name: "4300", description: "Freight" } });
  await asSystem(() => setBillingConfig({ freightGlAccountId: gl.id }));
  await expect(asSystem(() => deleteReference("glAccount", gl.id)))
    .rejects.toThrow(/still in use by 1 record/);
  const blockers = await findBlockers("glAccount", gl.id);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].entityLabel).toBe("Billing settings");
  expect(blockers[0].name).not.toBe("singleton");     // a person must be able to read this
  expect(blockers[0].href).toBe("/admin/billing");
});

it("saves a rate and a GL account, and audits the diff", async () => {
  const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Sales" } });
  await asSystem(() => setBillingConfig({ salesTaxRate: "0.0400", salesTaxGlAccountId: gl.id }));
  const cfg = await getBillingConfig();
  expect(cfg.salesTaxRate).toBe(0.04);
  const entry = await prisma.auditLog.findFirst({
    where: { entity: "billingConfig", entityId: "singleton" }, orderBy: { at: "desc" } });
  const before = entry!.before as { salesTaxRate: string | null };
  const after = entry!.after as { salesTaxRate: string };
  expect(before.salesTaxRate).toBeNull();
  expect(Number(after.salesTaxRate)).toBe(0.04);
});

it("refuses a GL account that does not exist", async () => {
  await expect(asSystem(() => setBillingConfig({ freightGlAccountId: "nope" })))
    .rejects.toThrow("That gl account does not exist");
});

it("refuses a soft-deleted step code", async () => {
  const code = await prisma.processStepCode.create({ data: { code: "CERT", name: "Certification" } });
  await prisma.processStepCode.update({ where: { id: code.id }, data: { deletedAt: new Date() } });
  await expect(asSystem(() => setBillingConfig({ certChargeStepCodeId: code.id })))
    .rejects.toThrow("That process step code does not exist");
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/billing-config.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/server/billing-config.ts`.** `truncateAll` wipes the seeded row, so `getBillingConfig` must tolerate its absence and return the defaults — the tests above depend on that:

```ts
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
```

- [ ] **Step 4: Run the tests** — `npx vitest run tests/billing-config.test.ts`. Expected: PASS.

- [ ] **Step 5: The route** `src/app/api/admin/billing/route.ts`:

```ts
import { NextResponse } from "next/server";
import { handle, requireUser, assertRecord } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getBillingConfig, setBillingConfig } from "@/server/billing-config";

export const GET = handle(async () => {
  mustCan(requireUser(), "admin", "view");
  return NextResponse.json(await getBillingConfig());
});

export const PUT = handle(async (req) => {
  mustCan(requireUser(), "admin", "edit");
  const body = await req.json();
  assertRecord(body);
  return NextResponse.json(await setBillingConfig(body));
});
```

- [ ] **Step 6: Route tests** in `tests/billing-config.test.ts` — GET 401 unauthenticated, 403 without `admin.view`, PUT 403 without `admin.edit`, 200 with both. Pass ctx: `GET(request, { params: Promise.resolve({}) })`.

- [ ] **Step 7: The page** `src/app/admin/billing/page.tsx` — a client component modelled on `src/app/admin/settings/page.tsx`: one form, seven controls. The three GL account selects and the step-code select load their options from `/api/admin/reference/glAccount` and `/api/picklists/processStepCode` respectively (**GL accounts are deliberately not on the pick-list route** — `PICKLIST_KINDS` excludes them, §5.15 — and this is an admin page, so the admin route is the right source). Every control gates on `gate(perms, "admin.edit")` and renders **disabled with a title naming the missing permission, never hidden** (§5.16). Add the card link on `src/app/admin/page.tsx` beside Settings.

- [ ] **Step 8: Gates + commit** — `feat(admin): plant billing configuration — GL defaults, tax rate, certification charge`

---

