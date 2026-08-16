# Task 5 review — the backup API routes

## Spec Compliance: ✅ Spec compliant

All three routes match the brief verbatim (`erp/src/app/api/admin/backups/route.ts:6-9`,
`.../health/route.ts:17-20`, `.../run/route.ts:33-36`): `mustDo(requireUser(), "manage_backups")`
first line, then a single delegating call, zero business logic in the route.

## Security-critical constraint (verified at source)

POST's handler is `async () => {...}` — no `req` parameter in scope (`run/route.ts:33`). Grepped
all three files: none call `req.json()`, `req.url`/searchParams, or read any header.
`runBackupNow()` is called with literally zero arguments (`run/route.ts:35`). `handle`'s `Handler`
type is `(req, ctx) => ...` (`http.ts:126`) but JS tolerates the callee declaring fewer params, so
this compiles and runs with nothing request-derived reachable even by accident. Confirmed.

The POST comment correctly states the guard's *absence* is intentional: `runBackupNow` →
`doBackup` calls `assertNotPracticeDatabase()` itself (`backups.ts:217`, throws `HttpError(403)`
via `practice-mode.ts:74-82`) before doing any work; the route adds no redundant/substitute check.

## 200-vs-500 asymmetry — sound, and matches the code

- `backupHealth` (`backups.ts:155-167`) and `backupsView` (`backups.ts:171-178`) wrap their
  filesystem reads (`newestIntactAt`/`readStatus`, which call `readdir`/`readFile`) in `try/catch`,
  turning ENOENT/EACCES into `folderError` → `evaluateHealth` returns `state: "unknown"` with a
  200. `listArchives` in `backupsView` is separately `.catch(() => [])`. Confirmed both GET routes
  cannot throw for a missing/unreadable folder (also re-derivable from the brief's own test).
- POST's 500 for an unwritable folder is a genuine `HttpError(500, ...)` thrown by
  `access(dir, FS.W_OK)`'s catch block (`backups.ts:229-233`), which propagates through `handle`'s
  mapping (`http.ts:139-141`) — not an unhandled exception. One inaccuracy in the implementer's
  report: it describes this path as going "via its `fail()` helper" (task-5-report.md:59); the raw
  `access()` check actually throws directly, before `fail()` is ever reached (`fail()` is used only
  for later failures inside the dump/compress steps). The *behavior* claimed (500, not silently
  swallowed to 200) is correct — only the described mechanism is off. Cosmetic, not a defect.
- The asymmetry itself (reads report red state; the one write reports a real error) is sound
  reasoning and matches what the code actually does.

## Leak check

`GET /health` returns exactly `BackupHealth` (`state, lastSuccessAt, lastRunAt, lastRunOk,
staleHours, reason` — `backup-constants.ts:41-50`); no `folder`, no `archives`. The full view adds
`folder` (the resolved `BACKUP_DIR`, a deploy config value, not a secret) and `archives`
(name/source/size/mtime/integrityOk). `DATABASE_URL` is used internally by `doBackup` but never
serialized into any response. No adjacent secret rides along either payload.

## Minor / out-of-scope observations (not blocking Task 5)

- `resolveBackupDir()` throws `HttpError(500)` synchronously, outside any try/catch, for a
  *malformed* (not merely missing) `BACKUP_DIR` (unsafe chars/`..`/empty) — reachable from
  `backupHealth`'s default parameter and directly inside `backupsView`/`doBackup`
  (`backups.ts:155,172,219`; `backup-paths.ts:24-39`). That would 500 the GET routes rather than
  reading red, unlike a plain "directory doesn't exist" case, which is fully covered by the
  try/catch. This is pre-existing Task 3/4 code, untouched by this diff, and not something Task 5
  introduced — flagging only as a possible follow-up.
- My own focused re-run of `tests/backups-routes.test.ts` hit `truncateAll` deadlocks
  (`40P01`) twice, caused by an unrelated, already-running `npx vitest run` process in this
  environment (PID 1342860, started 02:24, not started by this review) contending for the shared
  `erp_test` DB — not a defect in this diff. Static reading of the route files, `backups.ts`,
  `http.ts`, and `permissions.ts` corroborates the implementer's reported clean 5/5 pass.

## Strengths

- Routes are maximally thin — a single `mustDo` line and a single delegating call each, no
  deviation from the brief.
- Test file exercises all three routes for both 401 and 403 in one pass, plus the specific
  200-with-red-state case for a missing folder — real behavior, not entry-existence checks.
- Structural coverage via `tests/permissions-sweep.test.ts`'s admin-route gate regex is satisfied
  by all three files.

## Task quality: Approved

**Reasoning:** The three routes are exactly as specified, the security-critical no-argument call
to `runBackupNow` is verified at the source, and the 200-vs-500 asymmetry is both sound reasoning
and accurately implemented; only a cosmetic mischaracterization in the report and a pre-existing,
out-of-diff edge case were found.
