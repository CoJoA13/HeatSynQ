// The one statement of "is this DATABASE_URL the local dev database?", shared by every script
// that would do something it cannot take back if the answer were wrong (#167a fix round).
//
// It was FOUR hand copies before this file — `e2e/lib/db-fixtures.ts`, `e2e/lib/manual-ids.ts`,
// `prisma/manual-seed.ts` and `scripts/db-reset.ts` — and they had already drifted: three accept
// `[::1]` as a local host and `manual-ids.ts` does not. A guard that four files each state their
// own way is a guard whose next edit lands in one of them.
//
// A PURE LEAF on purpose: no fs, no db, no Prisma, no `process.env`. It is the `backup-paths.ts`
// shape — the caller reads the environment, opens the connection and throws its own error type
// (an `Error` in a script, an `HttpError` in `manual-seed.ts`), so this file stays importable from
// a CLI script, from the e2e harness and from vitest without dragging anything behind it, and its
// whole behaviour is pinned by `tests/dev-db-guard.test.ts` rather than by four sets of eyes.
//
// WHAT IT CAN AND CANNOT DECIDE. The database NAME proves nothing on its own: `docker-compose.yml`
// runs the production app against `postgresql://erp:…@db:5432/erp`, the very same name. So the
// HOST is the discriminator, and a legitimately non-local dev database is refused rather than
// given an escape hatch — an override on a destructive guard is the kind of thing that gets set
// once and never unset. What that leaves standing is stated where it bites hardest, in
// `scripts/db-reset.ts`'s header: on the production HOST itself the published port makes the
// production database reachable at `localhost:5432/erp`, which this cannot tell apart from a
// developer's. Callers that destroy data need a barrier beyond this one.

/** The local development database's name. `erp_test` (vitest) and `erp_practice` (the practice
 *  copy) are refused by construction — neither is this. */
export const DEV_DB_NAME = "erp";

/** Every spelling of "this machine" a `DATABASE_URL` can carry. `new URL()` normalises an IPv6
 *  literal to the bracketed form in `hostname`, so both are listed rather than either alone. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLocalDbHost(host: string): boolean {
  return LOCAL_HOSTS.has(host);
}

/** The database name a connection string lands on, i.e. its path with the leading slash off. */
export function dbNameFromUrl(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

export function hostFromUrl(url: string): string {
  return new URL(url).hostname;
}

/**
 * `null` when `dbName`@`host` is the local dev database, otherwise the refusal message to throw.
 *
 * `dbName` is what the CALLER decided to trust: `manual-seed.ts` passes the server's own
 * `SELECT current_database()` answer (a URL can lie about where it lands — `practice-mode.ts`'s
 * rule), the URL-only callers pass `dbNameFromUrl`. The host can only ever come from the URL,
 * because the server cannot report how it was reached.
 *
 * `subject` names the command in the first person ("db:reset", "e2e fixtures"); `consequence` says
 * what it was about to do, so the message explains the refusal rather than merely announcing it.
 */
export function devDbRefusal(
  { subject, consequence, dbName, host }: { subject: string; consequence: string; dbName: string; host: string },
): string | null {
  if (dbName === DEV_DB_NAME && isLocalDbHost(host)) return null;
  return (
    `${subject} only ever runs against the LOCAL dev database — expected database ` +
    `"${DEV_DB_NAME}" on localhost, got "${dbName}" on "${host}". Refusing: ${consequence}, and ` +
    `the production compose profile uses the database name "${DEV_DB_NAME}" too, so the name on ` +
    `its own proves nothing. Point DATABASE_URL at your local dev database and re-run.`
  );
}
