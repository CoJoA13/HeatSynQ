// Practice-vs-production, decided authoritatively by DATABASE IDENTITY (Phase 8B §5.1), alone in
// its own dependency-free leaf (the order-locks.ts / invoice-guards.ts precedent — importing only
// the db types, the `prisma` singleton, and the zero-import `errors.ts` leaf). This ONE helper is
// the single source every practice-mode consumer reads: the root-layout banner (T5), the render.ts
// watermark (T6), and the reset guard (T13). db-identity is authoritative; a `PRACTICE_MODE` env
// var may only CORROBORATE it (and trips a loud throw on the dangerous disagreement), never flip it
// — so no single mis-set variable can un-watermark training paper, mispoint the reset, or drop the
// banner.
import type { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";

export const PRACTICE_DB_NAME = "erp_practice";

type Db = Prisma.TransactionClient;

async function currentDatabase(db: Db): Promise<string> {
  const [row] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  return row?.name ?? "";
}

// current_database() is constant for the process lifetime (§5.1 introduces NO per-request DB
// switching), so the root layout can await this on every render without a per-request round-trip.
let cached: Promise<boolean> | undefined;

export function practiceMode(): Promise<boolean> {
  // Cache the resolved boolean (constant per process) but NOT a rejection: a transient failure of
  // the first current_database() query (DB briefly unreachable at deploy/failover) must not poison
  // the layout render for the whole process lifetime — clear the cache on rejection so the next
  // render retries. The intentional loud throw (PRACTICE_MODE mismatch) simply re-throws on every
  // render while the misconfiguration persists, which is the desired fail-closed behaviour.
  return (cached ??= resolvePracticeMode().catch((err) => {
    cached = undefined;
    throw err;
  }));
}

async function resolvePracticeMode(): Promise<boolean> {
  const name = await currentDatabase(prisma);
  const isPractice = name === PRACTICE_DB_NAME;
  // The dangerous direction: the flag claims practice while the connected DB is production. Refuse
  // loudly rather than silently trusting db-identity and leaving an operator convinced a prod box
  // is a training copy. (The reverse — flag unset but DB is erp_practice — is safe: db-identity is
  // authoritative, so practice mode still engages.)
  if (process.env.PRACTICE_MODE === "true" && !isPractice) {
    throw new Error(
      `PRACTICE_MODE=true but the connected database is "${name}", not "${PRACTICE_DB_NAME}". ` +
        `Refusing to run: db-identity is authoritative and a mis-set flag must never treat ` +
        `production as practice.`,
    );
  }
  return isPractice;
}

// The load-bearing reset guard (§5.3): an UN-memoized, in-request re-check on the CALLER'S client,
// so a mis-set PRACTICE_MODE on a production-pointed app can never reach a destructive practice-only
// action. Throws a clean 403 otherwise. Every destructive practice route re-checks through this.
export async function assertPracticeDatabase(db: Db = prisma): Promise<void> {
  const name = await currentDatabase(db);
  if (name !== PRACTICE_DB_NAME) {
    throw new HttpError(
      403,
      `This action is only available on the practice database (connected to "${name}").`,
    );
  }
}
