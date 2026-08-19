import { prisma } from "./db";
import { singleFlight } from "../lib/single-flight";
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

// Concurrent resets are SINGLE-FLIGHTED (#111), not advisory-locked. Two Codex review rounds on
// PR #109 shaped this. Round 2 ("Serialize practice reset operations") required that overlapping
// resets "reject or wait" — two interleaved truncate+seed sequences can leave a partial baseline
// with no usable login; the advisory lock it sketched was its SUGGESTED implementation, not the
// requirement. Round 3 (filed as #111) then flagged that implementation's cost: a pinned
// interactive transaction held a pool connection doing nothing for the whole 120s reset, and on
// this driver-adapter stack the pool is pg-pool's fixed default of 10 (not the Rust engine's
// num_cpus*2+1 the issue cited), so stacked waiters could starve the ambient seed queries.
//
// The module-scoped join satisfies BOTH rounds: a second caller JOINS the running reset (the
// observable outcome — "my click ended with a fresh baseline, sign in as admin/admin" — is
// identical), a failed reset clears the slot rather than wedging the endpoint, and ZERO
// connections are pinned (correct even at pool = 1). It serializes every caller that can invoke
// this route because practice is ONE process: compose's app-practice is a single container with a
// host-port bind (8080:3000 — a second replica cannot start) running `node server.js`, no
// cluster. Accepted residual: a hand-run local server pointed at erp_practice beside the
// container reverts, at worst, to the pre-round-2 state the Phase 8B merge accepted as
// design-sanctioned self-healing on a throwaway DB — and the un-locked CLI seed
// (`npm run db:seed:demo`) always had identical exposure, so the advisory lock never closed that
// cross-process class either.
const resetFlight = singleFlight(resetPracticeDataUnguarded);

/**
 * The guarded entry (§5.3): refuses unless the connected database is erp_practice, so a mis-set
 * PRACTICE_MODE on a production-pointed app can NEVER truncate real data. This refusal is the RED
 * safety test (it fires in the erp_test process), and it runs UN-memoized for EVERY caller —
 * callers that go on to join an in-flight reset included — before the single-flight engages.
 */
export async function resetPracticeData(): Promise<void> {
  await assertPracticeDatabase(prisma);
  return resetFlight();
}
