import { prisma } from "@/server/db";
import { reseedSingletons } from "@/server/practice-seed";

// The seeded template row ids are minted by practice-seed.ts (the single source — the drift-guard
// precedent, so a second hand-rolled copy of the minting rule can't drift) and re-exported here so
// the many test files that reference them keep importing from "./helpers/db".
export { templateId, templateVersionId } from "@/server/practice-seed";

/**
 * Deletes all rows from every table except _prisma_migrations, then restores the rows the
 * schema guarantees always exist.
 *
 * `BillingConfig` is a singleton by construction (P5A design spec §4.5): a hand-written
 * `CHECK ("id" = 'singleton')` pins it to one row, and the migration that creates the table seeds
 * that row — deliberately, so `getBillingConfig` is a plain `findFirst` and `setBillingConfig` a
 * plain audited update with a real before-snapshot, rather than a lazy create-on-first-read. A
 * bare TRUNCATE deletes it, which would make every test run against a database in a state the
 * production schema cannot be in, and would push the first service that reads it toward exactly
 * the lazy create the spec rules out. Re-seeding it here keeps the invariant true everywhere.
 * `SetupState` (Phase 8B §7) is the same by-construction singleton once more — re-seeded here for
 * the same reason, so `getSetupState` stays a plain `findFirst`.
 *
 * The eight "Standard" document templates (Phase 7 spec §9) are the same invariant one phase
 * over: the seed migration guarantees every docType a live default template with a PUBLISHED v1,
 * and the print path may assume that resolution never dereferences null. The re-seed is built
 * from the TS `DEFAULT_CONFIG` constants — the canonical copy — NOT from the migration's SQL
 * literals, so tests start from factory state (code-default standing texts; the migration's
 * Setting-value COALESCE copies are its own upgrade concern, drift-guarded by
 * tests/template-seed.test.ts against the SQL file itself). Fixed ids match the migration's
 * (standard-<doctype> / -v1); the pointer UPDATE runs as one statement because the two
 * createMany calls cannot reference each other's rows mid-flight.
 */
export async function truncateAll(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
  // Restore the by-construction singletons + the eight Standard templates. Phase 8B §5.3 lifted this
  // body into practice-seed.ts (a NON-test-only module) so the production practice reset reuses the
  // exact same restore; truncateAll itself stays test-only.
  await reseedSingletons();
}

/**
 * Seeds the minimum config the Phase 8B order-entry gate (order-entry-readiness.ts) requires so
 * order-creating suites can call `createOrder`: company identity + one live GL account +
 * `BillingConfig.arGlAccountId`. OPT-IN — called in the `beforeEach` of order-creating suites ONLY,
 * never inside `truncateAll`. Seeding it globally would (a) red the pristine-default suites that
 * assert the empty baseline (billing-config's `arGlAccountId: null`, settings' `company_name === ""`,
 * reference-gl's GL-account counts) and (b) via T11's `reseedSingletons` lift, contaminate the
 * production practice reset with non-singleton demo rows. Raw prisma writes (no audit) — this is
 * harness setup, not a service call, so it adds no audit rows to the baseline.
 */
export async function seedOrderGatePrereqs(): Promise<void> {
  await prisma.setting.createMany({
    data: [
      { key: "company_name", value: "Test Heat Treat Co." },
      { key: "company_address", value: "1 Test Way, Testville" },
      { key: "company_phone", value: "555-0000" },
    ],
    skipDuplicates: true,
  });
  const gl = await prisma.glAccount.create({
    data: { name: "0000-GATE-AR", description: "A/R (order-gate prereq)" },
  });
  await prisma.billingConfig.update({ where: { id: "singleton" }, data: { arGlAccountId: gl.id } });
}

export { prisma };
