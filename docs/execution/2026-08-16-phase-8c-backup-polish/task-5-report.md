# Task 5 report — the API routes

## What was implemented

Three thin route handlers, each gated on the `manage_backups` special action, plus the test file
specified by the brief:

- `erp/src/app/api/admin/backups/route.ts` — `GET`, delegates to `backupsView()`. Returns the full
  page payload: `{ folder, health, archives }`.
- `erp/src/app/api/admin/backups/health/route.ts` — `GET`, delegates to `backupHealth()`. The
  cheap endpoint the shell warning bar polls — health only, no archive listing.
- `erp/src/app/api/admin/backups/run/route.ts` — `POST`, delegates to `runBackupNow()`. Triggers a
  manual dump and returns `{ archive: ArchiveInfo }`.
- `erp/tests/backups-routes.test.ts` — the five tests from the brief, verbatim (401 anonymous,
  403 lacking permission, 200 with full view, 200 with health-only, 200-with-red-state on a
  missing `BACKUP_DIR`).

All three handlers follow the fixed shape (`mustDo(requireUser(), "manage_backups")` first, then
delegate) with zero business logic in the route itself — the code is exactly what the brief
specified, no deviation in the route bodies.

## Explicit confirmation: POST passes no arguments to `runBackupNow`

`erp/src/app/api/admin/backups/run/route.ts` calls `runBackupNow()` with **no arguments at all**.
The route does not call `req.json()`, does not read any header or query parameter, and does not
construct an options object. `runBackupNow`'s `{ dumpBin?, dumpArgs?, dir?, timeoutMs? }` parameter
is a test-only seam and is never touched by this route. Confirmed by reading the file back:

```ts
export const POST = handle(async () => {
  mustDo(requireUser(), "manage_backups");
  return NextResponse.json({ archive: await runBackupNow() });
});
```

Note the handler signature takes no `req` parameter at all — there is nothing in scope to thread
through even by mistake. `runBackupNow` re-checks `assertNotPracticeDatabase()` itself before doing
any work, so the POST route does not duplicate that guard (per the settled decision in the task
prompt); the guard lives inside the service, where a future second caller of `runBackupNow` cannot
bypass it.

## Reasoning on the 200-vs-500 question

I did not deviate from the brief's routes here — the 200-vs-500 behavior falls out of the
*existing* Task 3/4 service functions, not out of anything the route layer decides, and I believe
the shape that falls out is the right one:

- **`GET /api/admin/backups` and `GET /api/admin/backups/health`** — both call into
  `backupHealth()`/`backupsView()`, which wrap their filesystem reads in a `try/catch` that turns a
  read failure into `folderError`, which `evaluateHealth` turns into `{ state: "unknown", reason:
  "The backup folder could not be read: ..." }`. That's a normal 200 with a red state, never a 500.
  This is correct for a *read*: the whole point of the health endpoint is to let an operator (and
  the shell banner) see "the folder is missing/unreadable" as a fact about the system, not as an
  opaque 500 that gives no actionable information and that a naive banner might swallow as "no
  data" rather than "red alert." A GET that 500s on a missing folder is *worse* at the one thing
  this feature exists to do.

- **`POST /api/admin/backups/run`** — calls `runBackupNow()`, which does NOT have the same
  try/catch-to-green behavior. `doBackup` calls `access(dir, FS.W_OK)` and, on failure, throws
  `HttpError(500, ...)` via its `fail()` helper — which propagates up through `handle()` and comes
  back as a real 500 with a JSON `{ error }` body. I did not add a second layer of folder-existence
  handling in the route to convert this to a 200; the existing service behavior is already correct
  and the route should not paper over it.

  This asymmetry is intentional and, in my judgment, right: a GET is asking "what's the state of
  the world," and answering that question is never itself a failure — a missing folder IS the
  answer. A POST is asking "please cause a durable side effect (a fresh dump on disk)." If the
  folder isn't writable, the side effect did not happen, and reporting 200 with some invented
  "archive" value would be actively dangerous — it would let an operator believe a backup exists
  when it doesn't, which is strictly worse than a 500 that makes the failure visible in the UI and
  in any error logging/monitoring wired to non-2xx responses. The brief's own carried instruction
  ("a client-settable dumpBin would be arbitrary command execution...") is part of the same spirit:
  this route's failure mode should be loud, not silently smoothed into "success."

  So: the GET routes and the POST route deliberately do **not** agree on 200-vs-500 for the same
  underlying condition (folder missing), and I believe that's correct rather than an inconsistency
  to fix — reads report red state, the one write reports a real error. I did not find anything in
  the brief that got this wrong; I read the brief's own test (only exercising the GET health route
  for the 200-with-red-state case, never asserting anything about POST's behavior on a missing
  folder) as already reflecting this same asymmetry, so no deviation was needed from the routes as
  specified.

## Deviations from the brief

None. All three route files and the test file were written verbatim as given in
`task-5-brief.md`.

## Commands run, with real output

```
$ cd erp && npx prisma generate
Loaded Prisma config from prisma.config.ts.
Prisma schema loaded from prisma/schema.prisma.
✔ Generated Prisma Client (7.9.1) to ./prisma/generated/prisma in 242ms
```

```
$ cd erp && npx vitest run tests/backups-routes.test.ts tests/permissions-sweep.test.ts

 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp

 ✓ tests/permissions-sweep.test.ts (6 tests) 18ms
 ✓ tests/backups-routes.test.ts (5 tests) 654ms

 Test Files  2 passed (2)
      Tests  11 passed (11)
   Start at  02:24:07
   Duration  1.14s (transform 141ms, setup 12ms, collect 281ms, tests 672ms, environment 0ms, prepare 48ms)
```

```
$ cd erp && npx tsc --noEmit
(no output — clean)
```

```
$ cd erp && npx eslint src tests
(no output — clean)
```

All four commands were run for real, from `erp/`, with `nvm use 26` and the dev Postgres
container (`docker compose up -d db`) already healthy. No pre-existing `tsc`/`eslint` errors were
observed to report as out-of-scope — both were clean before and after this change.

## Commit

```
b0a82a7 feat(backups): add the manage_backups-gated backup routes
 4 files changed, 101 insertions(+)
 create mode 100644 erp/src/app/api/admin/backups/health/route.ts
 create mode 100644 erp/src/app/api/admin/backups/route.ts
 create mode 100644 erp/src/app/api/admin/backups/run/route.ts
 create mode 100644 erp/tests/backups-routes.test.ts
```

No attribution trailer, conventional-commit style, matching the working conventions.
