# Task 9 report — Restore runbook, E2E flow, and the docs

## What changed

- **`erp/e2e/flows/backups.mjs`** (new) — the `backups` E2E flow: page renders with the resolved
  folder; "Back up now" writes a real archive via the real host `pg_dump` and the on-page indicator
  turns green; the shell staleness bar clears once a fresh backup exists.
- **`erp/e2e/run.mjs`** — four edits per the brief: a `BACKUP_DIR` constant beside `ARTIFACTS_DIR`
  (harness-owned `e2e-backups/` folder, never the developer's `.env` value or `erp/backups`);
  `BACKUP_DIR` added to `startDevServer()`'s spawn env (the dev server is what runs `pg_dump`);
  create-fresh in `main()` beside the `ARTIFACTS_DIR` reset; remove in the single shared `teardown()`
  (covers both the normal `finally` path and SIGINT/SIGTERM). Registered `backups` as the 23rd/last
  `FLOWS` entry with a run-order comment matching the file's existing convention.
- **`erp/README.md`** — replaced the two-line `## Backups` section with the folder/staleness/practice
  bullets and a five-step restore runbook (see "Judgment call 1" below for what changed from the
  brief's draft), plus a note on the `## Updating` section confirming migrations backfill
  `manage_backups` automatically on `docker compose up -d --build` — no manual `npm run db:seed` step.
- **`CLAUDE.md`** — added the Phase 8C architecture paragraph verbatim from the brief, after
  cross-checking every specific claim in it against `backup-paths.ts`, `backups.ts`, and
  `scripts/backup.sh` (all confirmed accurate: the argv spawn, the temp-then-check-then-gzip
  sequence, the derived `lastSuccessAt`, the `-mtime +30` prune, the never-shared filenames,
  `assertNotPracticeDatabase`). Placed directly after the Phase 8B paragraph; nothing displaced.
- **`docs/HANDOFF.md`** — three edits:
  - §4: replaced "Phase 8C is the sole remaining sub-phase" with a full entry stating 8C is
    code-complete on `phase-8c-backup-polish` (all 9 tasks), what it shipped, final gates, and that
    this completes every build phase in the 8-phase roadmap — pending the standing whole-branch
    review/PR/merge, not yet claimed as merged to `main`.
  - §8: added `postgresql` (client) to the Fedora fresh-machine tooling line, with a note on why
    (the E2E `backups` flow, the restore runbook) and the major-must-match-the-image-tag constraint.
  - §9: rewritten kickoff — Phase 8 done, no ninth phase; the three open tracks are now the
    parallel-run acceptance month, issue #115 (P1), and the backlog burn-down. Removed 8C's three
    "must not rediscover" bullets (spent) and the old four-item candidate list.
- **`erp/tests/backup-paths.test.ts`** — fixed a pre-existing, out-of-my-file-list bug found while
  running the full gate chain (see "Off-brief fix" below).
- **`docs/execution/2026-08-16-phase-8c-backup-polish/`** — copied `task-9-brief.md` in, filled the
  Task 9 row of `progress.md`.

## Off-brief fix: `tests/backup-paths.test.ts` leaked `.env`

Running the full `npm test` (not scoped to backup files, which is what Task 8's own gate check ran)
turned up a real failure: `resolveBackupDir > defaults to /backups when BACKUP_DIR is unset` failed,
expecting `/backups` and getting `/home/.../erp/backups`.

Root cause: `resolveBackupDir(raw = process.env.BACKUP_DIR)` — calling it with an explicit `undefined`
argument still falls through to the *default parameter expression*, which reads the ambient
`process.env.BACKUP_DIR` at call time, not "definitely unset." Task 8 added `BACKUP_DIR="./backups"`
to `.env.example` (and this machine's `.env` mirrors it), and `tests/helpers/setup.ts` calls
`dotenv.config()` unconditionally at suite startup — so on any checkout that followed the documented
`cp .env.example .env` setup step, this test silently tested the wrong branch of the function and,
once BACKUP_DIR ceased to already resolve to the hardcoded default, started failing outright.

Verified pre-existing (not something my own diff caused) by stashing my changes and re-running the
one test file against the untouched Task-8 tip — it failed identically. Fixed with the same
save/restore idiom `tests/backups-routes.test.ts` already uses for the same env var: delete
`process.env.BACKUP_DIR` before the call, restore it in `finally`. This is a test-isolation fix only;
`resolveBackupDir`'s production behavior is untouched.

## Judgment call 1 — the restore runbook

Verified every command in the brief's draft against this repo's actual `docker-compose.yml` before
trusting it:

- `db` carries no `profiles:` key, so it's always available; `app`/`backup` are gated on `["prod"]`.
  Confirmed live: `docker compose config --services` → `db`; `docker compose --profile prod config
  --services` → `db app backup`. So `docker compose exec -T db …` needs no `--profile` flag, while
  `docker compose --profile prod stop/start app` does — exactly as the brief's draft had it.
- Ran a harmless `docker compose exec -T db pg_dump -U erp -d erp --schema-only` (discarded output,
  exit 0) and `docker compose exec -T db psql -U erp -d postgres -c 'SELECT 1;'` (the maintenance-db
  connection pattern `DROP`/`CREATE DATABASE` needs) to confirm the exec syntax actually works against
  this box, not just reads plausibly.
- **One addition beyond the brief's draft**: inserted a `pg_terminate_backend` step against the
  `postgres` maintenance db between "stop the app" and "drop the database." The published
  `127.0.0.1:5432:5432` port means a stray `psql`/Prisma Studio session on the host is enough to make
  `DROP DATABASE erp` refuse with "database is being accessed by other users" — a failure mode the
  brief's draft didn't guard and that would strand an operator mid-restore.
- Confirmed the app's `CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]` re-runs in
  full on `docker compose start` (not just `up`/build), so step 5's "any migration newer than the
  archive applies automatically" claim is accurate.
- Kept the brief's ordering (dump-current-before-drop) — it was already correct — and renumbered to
  five steps to fit the added connection-termination step.

## Judgment call 2 — the E2E flow's third assertion

The brief flagged a specific risk: `BackupBanner`'s `advanceBannerState` throttles its own health
re-fetch to once per 5 minutes and latches a 403 for the rest of the session — could the flow's third
assertion (navigate to `/customers`, assert the staleness bar is gone) be flaky against that?

Read `BackupBanner.tsx` closely: the throttle/latch state lives in a `useRef` initialized to
`INITIAL_BANNER_STATE`, refreshed only via a `useEffect` keyed on `pathname`. Both of the flow's
navigations use `page.goto(...)` — a full browser navigation, not a client-side route change — which
tears down and remounts the entire React tree, including that ref. So the 5-minute throttle never
actually spans the flow's own step boundaries; it cannot cause this assertion to observe stale state.

The REAL race is different and unaddressed by the brief's draft: `page.goto` resolves on the `load`
event, which can land *before* the freshly-mounted banner's own health fetch (fired from its
post-mount effect) resolves. Reading the DOM immediately after `goto` could therefore see "nothing
rendered yet" (banner still `null`) rather than "confirmed healthy" — a vacuous pass that would look
identical whether the backup actually succeeded or not.

Fixed by arming `page.waitForResponse` on `GET /api/admin/backups/health` *before* the `page.goto`
call and awaiting it before the assertion, so the check is on settled state, not a race against the
fetch. Verified in the real run this doesn't introduce its own race: the pre-navigation page
(`/admin/backups`) also fires a health fetch on its own mount (in step 1), but that fetch has already
resolved by the time step 3 arms its listener — `waitForResponse` only observes responses that occur
*after* it is called, so there is no way for it to catch a stale, already-settled response instead of
the fresh one from the `/customers` mount.

## Gate results (all watched to completion — none guessed)

```
$ cd erp && npm test
 Test Files  179 passed (179)
      Tests  2984 passed (2984)
```
(First full run hit the pre-existing `backup-paths.test.ts` failure described above — 178/179 files,
2983/2984 tests, 1 failed. Fixed, re-ran clean as shown.)

```
$ npx tsc --noEmit
(clean, zero diagnostics)

$ npx eslint src tests
(clean, zero findings)

$ npm run build
(clean; standalone build completed, full route manifest printed, exit 0 — verified by re-running
with the exit code captured directly, not through a pipe)
```

```
$ npm run test:e2e          # run in background, watched via the log to completion, exit 0
=== Results ===
  PASS  template-build-and-load        PASS  ship-partial-then-complete
  PASS  typed-fields                   PASS  multi-order-shipment
  PASS  revision-cut                   PASS  cert-results-print
  PASS  blocked-code-delete            PASS  void-shipment
  PASS  permission-gating              PASS  credit-hold-block-and-override
  PASS  processes-list                 PASS  invoice-shipped-order
  PASS  order-entry-full               PASS  receivables-apply-age-statement
  PASS  board-search-scan              PASS  close-month-end
  PASS  loads-after-print              PASS  quotes
  PASS  void-order                     PASS  templates-admin
                                        PASS  reports
                                        PASS  setup-checklist
                                        PASS  backups

All 23 flows passed. Artifacts: erp/e2e-artifacts
```

Post-run verification: `erp/e2e-backups/` (the harness-owned BACKUP_DIR) was removed by `teardown()`
as designed — confirmed absent after the run. `erp/e2e-artifacts/backups/` holds
`01-logged-in.png`, `02-backups-after-run.png`, and `video.webm`. Dev-DB fixture cleanup reported
"cleanup ok" — no `ClosePeriod` debris to hand-clean for the next run.

## Final gate table

| Gate | Result |
|---|---|
| `npm test` | **2984 tests / 179 files, all passed** |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | clean |
| `npm run test:e2e` | **23/23** |

## Commit

Not yet committed at the time this report was written — committing immediately after, in one commit
covering `erp/e2e`, `erp/README.md`, `erp/tests/backup-paths.test.ts`, `docs/HANDOFF.md`, `CLAUDE.md`,
and `docs/execution`.
