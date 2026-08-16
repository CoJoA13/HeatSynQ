import { prisma } from "./db";
import { assertPracticeDatabase } from "./practice-mode";
import { reseedSingletons } from "./practice-seed";
import { seedDemoSlice } from "../../prisma/demo-seed";

// Reset the practice database to a fresh demo baseline (Phase 8B §5.3). NON-atomic by construction:
// seedDemoSlice spans many independent service-owned transactions, so the guard is a process-level
// current_database() PRE-check (assertPracticeDatabase), NOT a transaction wrapping the whole reset.
// It restores the by-construction singletons (reseedSingletons) BEFORE any demo business rows — a
// bare truncate leaves the DB in the impossible no-billing-config / no-printable-templates state the
// restore exists to prevent. Reuses NO test-only tooling (truncateAll stays test-only).

async function truncateAllTables(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
}

/**
 * The internal reset, exercised directly against erp_test in CI (the db-identity guard-split — the
 * happy path can only run where vitest connects, i.e. NOT erp_practice). NEVER call this from a
 * route: it truncates unconditionally. The guard is resetPracticeData().
 */
export async function resetPracticeDataUnguarded(): Promise<void> {
  await truncateAllTables();
  await reseedSingletons(); // singletons FIRST — before any demo business rows (trap #4)
  await seedDemoSlice(); // through the services
}

/**
 * The guarded entry (§5.3): refuses unless the connected database is erp_practice, so a mis-set
 * PRACTICE_MODE on a production-pointed app can NEVER truncate real data. This refusal is the RED
 * safety test (it fires in the erp_test process).
 */
export async function resetPracticeData(): Promise<void> {
  await assertPracticeDatabase(prisma);
  await resetPracticeDataUnguarded();
}
