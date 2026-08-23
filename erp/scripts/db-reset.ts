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
// ---------------------------------------------------------------------------------------------
// SAFETY, AND THE RESIDUAL IT CANNOT CLOSE
//
// This script TRUNCATES every table. An earlier version of this header claimed "it must be
// impossible to point this at production". That was false, and the fix-round review was right to
// say so, so here is what is actually true.
//
// The two identity checks are real but they answer the same question twice:
//
//   1. The URL shape — database name exactly `erp` on a local host (`src/lib/dev-db-guard.ts`,
//      shared with the e2e fixtures, the manual capture and the manual seed rather than copied a
//      fourth time). No override flag: an escape hatch on a destructive guard gets set once and
//      never unset.
//   2. The DATABASE'S OWN answer, on the very client that will do the truncating,
//      `SELECT current_database()` — `src/server/practice-mode.ts`'s rule that db-identity is
//      authoritative and the environment only corroborates. It catches a `DATABASE_URL` that lies
//      (an overridden PG* env, a pooler rewriting the target).
//
// **What check 2 CANNOT discriminate is the case that matters.** `practice-mode.ts`'s guard works
// because `erp_practice` is a DIFFERENT NAME; production's database is also called `erp`. So the
// whole weight rests on check 1's hostname — and `docker-compose.yml` publishes the `db` service
// as `127.0.0.1:5432:5432`, which means that ON THE PRODUCTION HOST the production database really
// is reachable at `localhost:5432/erp`. Both guards pass there. `npm install` on that host is in
// the documented quick-start, and CLAUDE.md advertises this command two lines below `db:seed`.
//
// There is no precise heuristic for "this database looks like production", and a vague one is
// worse than none: every discriminator considered — row counts, the presence of real customers, an
// age-of-oldest-order test — refuses a legitimately well-used dev database, which is exactly the
// database people reset. So instead of guessing, there are two barriers that do not need to guess:
//
//   3. `NODE_ENV=production` is refused outright. The production compose profile sets it (the
//      Dockerfile's runner stage), so a shell inheriting a production environment is turned away
//      before anything else happens.
//   4. The reset is CONFIRMED, never merely invoked. At a TTY it asks for the database name to be
//      typed back. Without a TTY — an agent session, a script, CI — it demands `--yes` on the
//      command line (or `DB_RESET_CONFIRM=yes`), so it can still be automated, but only on
//      purpose. This is the barrier that stands between `localhost:5432/erp` on a production host
//      and an empty database, and it is the honest one: it does not claim to know where it is
//      running, it requires the person running it to say so.
//
// `--yes` is part of the recipe the harness prints (`e2e/lib/preflight.mjs`), because a recipe
// that does not work in the session that reads it is the defect this whole group is about.
// ---------------------------------------------------------------------------------------------
import "dotenv/config";
import { execFileSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/server/db";
import { reseedSingletons } from "../src/server/practice-seed";
import { DEV_DB_NAME, dbNameFromUrl, devDbRefusal, hostFromUrl } from "../src/lib/dev-db-guard";

const ERP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Barrier 3. Cheapest and first: nothing has been read or connected to yet. */
function assertNotProductionEnv(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `db:reset refuses to run with NODE_ENV=production. This truncates every table; if this ` +
      `really is a development machine, unset NODE_ENV (or set it to "development") and re-run.`,
    );
  }
}

/** Barrier 1. */
function assertDevDbUrl(url: string): void {
  const refusal = devDbRefusal({
    subject: "db:reset",
    consequence: "this deletes every row in the database",
    dbName: dbNameFromUrl(url),
    host: hostFromUrl(url),
  });
  if (refusal) throw new Error(refusal);
}

/** Barrier 2. */
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

/**
 * Barrier 4 — the one that is not an identity check. Asked AFTER both identity checks so the
 * prompt can state what it is about to empty, and BEFORE the first destructive statement.
 *
 * The non-TTY path is a flag rather than a prompt on purpose: a `readline` question against a
 * non-interactive stdin resolves instantly with nothing, which would have made the confirmation a
 * no-op in exactly the sessions (agents, scripts, CI) that most often run this.
 */
async function confirm(host: string): Promise<void> {
  const flagged = process.argv.slice(2).includes("--yes") || process.env.DB_RESET_CONFIRM === "yes";
  if (flagged) return;

  if (!process.stdin.isTTY) {
    throw new Error(
      `db:reset needs confirmation and stdin is not a terminal, so it cannot ask. This TRUNCATES ` +
      `every table in "${DEV_DB_NAME}" on "${host}" — and on a production host the published ` +
      `port makes the PRODUCTION database reachable at exactly that address, which no check in ` +
      `this script can tell apart from a developer's.\n` +
      `  If that is what you want:  npm run db:reset -- --yes   (or DB_RESET_CONFIRM=yes)`,
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const typed = await rl.question(
      `This TRUNCATES every table in "${DEV_DB_NAME}" on "${host}" and re-seeds it (admin/admin).\n` +
      `Type the database name to confirm: `,
    );
    if (typed.trim() !== DEV_DB_NAME) {
      throw new Error(`Not confirmed (expected "${DEV_DB_NAME}", got "${typed.trim()}") — nothing was changed.`);
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  assertNotProductionEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  assertDevDbUrl(url);
  await assertConnectedToDevDb();
  await confirm(hostFromUrl(url));

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
  // A failure HERE is the one that leaves the database unusable rather than merely unchanged: the
  // truncate has already committed, so there is no admin user to log in with and no obvious sign
  // of why. Say what to do about it rather than letting the raw child-process error stand alone.
  try {
    execFileSync("npx", ["tsx", "prisma/seed.ts"], { cwd: ERP_ROOT, stdio: "inherit" });
  } catch (err) {
    console.error(
      `\nThe truncate succeeded but the seed did not, so "${DEV_DB_NAME}" is now EMPTY — there is ` +
      `no admin user and the app will not log in. Fix whatever the seed reported above, then ` +
      `re-run \`npm run db:reset\` (it is idempotent; a second truncate of an empty database is ` +
      `free).`,
    );
    throw err;
  }
  console.log(`\n"${DEV_DB_NAME}" is back to migrate-deploy + db:seed state (admin/admin).`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
