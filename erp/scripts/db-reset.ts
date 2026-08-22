// `npm run db:reset` — put the LOCAL DEV database (`erp`) back to the state a fresh
// `npx prisma migrate deploy && npm run db:seed` leaves it in, and nothing else.
//
// WHY THIS EXISTS (#167a). The E2E suite and the demonstration dataset cannot share a database
// (docs/manual/dataset.md, "The E2E suite and this dataset cannot share a database"), and the
// harness now REFUSES a run against a dev DB carrying ambient state it cannot tolerate — printing
// this command as the way back. A refusal whose recipe does not exist is not a refusal, and until
// this script there was no supported reset at all: `db:seed` and `db:seed:demo` neither of them
// truncate, and `manual-seed.ts` is deliberately not idempotent (its reset *was* dropping the
// database by hand, in a five-line psql/tsx sequence recorded only in a doc).
//
// WHY IT TRUNCATES RATHER THAN DROPS. `prisma migrate reset` would be the obvious tool and is
// deliberately not used: it re-runs every migration (slow), and it refuses outright when it detects
// that an AI agent invoked it — which would make the one command the harness's own refusal message
// points at unusable from the sessions that most often hit that refusal. TRUNCATE + the migration-
// seeded rows restored by hand reaches the identical state: the only rows any migration inserts are
// `BillingConfig`, `SetupState` and the eight Standard document templates — exactly what
// `reseedSingletons` restores (the same call `truncateAll()` makes for the test database, and the
// same one the practice reset makes) — plus two RolePermission back-fills over roles that no longer
// exist after a truncate and that `prisma/seed.ts` re-grants in full anyway.
//
// SAFETY — it must be impossible to point this at production, so the identity is checked TWICE:
//
//   1. The URL shape: database name exactly `erp` on a local host. The name alone proves nothing —
//      `docker-compose.yml`'s prod profile runs the app against `postgresql://erp:…@db:5432/erp`,
//      the same name — so the host is the discriminator that actually holds. This is
//      `e2e/lib/db-fixtures.ts`'s `assertDevDb` guard and `prisma/manual-seed.ts`'s, reused rather
//      than re-derived, and like both of them it has NO override flag: an escape hatch on a
//      destructive guard is the kind of thing that gets set once and never unset.
//   2. The DATABASE'S OWN answer, on the very client that will do the truncating:
//      `SELECT current_database()`. `src/server/practice-mode.ts`'s rule — db-identity is
//      authoritative and the environment only corroborates it — so a `DATABASE_URL` that lies (an
//      overridden PG* env, a pooler rewriting the target) is caught by the database itself.
//
// It also refuses `erp_test` by construction: the vitest suite owns that database and truncates it
// per test file.
import "dotenv/config";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/server/db";
import { reseedSingletons } from "../src/server/practice-seed";

const ERP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEV_DB_NAME = "erp";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function assertDevDbUrl(url: string): void {
  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, "");
  const host = parsed.hostname;
  if (dbName !== DEV_DB_NAME || !LOCAL_HOSTS.has(host)) {
    throw new Error(
      `db:reset only ever runs against the LOCAL dev database — expected database ` +
      `"${DEV_DB_NAME}" on localhost, got "${dbName}" on "${host}". Refusing: this deletes every ` +
      `row in the database, and the production compose profile uses the database name ` +
      `"${DEV_DB_NAME}" too, so the name on its own proves nothing.`,
    );
  }
}

async function assertConnectedToDevDb(): Promise<void> {
  const [row] = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  const name = row?.name ?? "";
  if (name !== DEV_DB_NAME) {
    throw new Error(
      `db:reset is connected to database "${name}", not "${DEV_DB_NAME}". Refusing — the database's ` +
      `own identity is authoritative and DATABASE_URL only corroborates it.`,
    );
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  assertDevDbUrl(url);
  await assertConnectedToDevDb();

  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) {
    throw new Error(
      `the "${DEV_DB_NAME}" database has no tables — it has never been migrated. Run ` +
      `\`npx prisma migrate deploy\` first.`,
    );
  }
  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
  console.log(`Truncated ${tables.length} table(s) in "${DEV_DB_NAME}".`);

  // AFTER the truncate and BEFORE any business rows — the order reseedSingletons' own header
  // requires, or the database is left in the impossible no-billing-config / no-printable-templates
  // state.
  await reseedSingletons();
  console.log("Restored BillingConfig, SetupState and the eight Standard document templates.");

  // The seed itself, through the one documented entry point rather than a second copy of it.
  execFileSync("npx", ["tsx", "prisma/seed.ts"], { cwd: ERP_ROOT, stdio: "inherit" });
  console.log(`\n"${DEV_DB_NAME}" is back to migrate-deploy + db:seed state (admin/admin).`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
