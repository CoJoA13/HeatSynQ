# Task 9 review — Restore runbook, E2E flow, docs close-out

## Spec Compliance
✅ Spec compliant. All §6.3/§9/§10/§11 items this task owns are present and verified against the
live repo, not just plausible-sounding.

## Strengths
- Restore runbook (`erp/README.md:119-140`) independently verified command-by-command: `db` has no
  compose `profiles:` key so `docker compose exec -T db …` needs none, while `app`/`backup` are
  `profiles: ["prod"]` (confirmed via `docker compose config app` and `docker compose stop --dry-run`
  on this box — Docker was live). Ordering is genuinely safe: the pre-restore dump (`README.md:130`)
  hits the `db` container directly and never depends on `app`; DROP/CREATE/restore happen strictly
  before `docker compose --profile prod start app` (`README.md:770-783`), so the app never opens a
  connection to a half-restored database.
- The added `pg_terminate_backend` step (`README.md:772-773`) is correctly scoped
  (`datname = 'erp' AND pid <> pg_backend_pid()`) and correctly ordered — it runs before the restore
  connection exists, so it cannot terminate the restore itself.
- Filenames/paths match production exactly: `erp_<stamp>.sql.gz` / `erp_manual_<stamp>_<hex>.sql.gz`
  (`src/lib/backup-constants.ts`), `backup-status.json`, host `./backups` bind mount — all confirmed
  against `docker-compose.yml` and `scripts/backup.sh`.
- E2E flow (`erp/e2e/flows/backups.mjs`): all four harness edits present and correct —
  `BACKUP_DIR` constant, spawn-env plumbing into `startDevServer()` (`e2e/run.mjs:919`), fresh
  create in `main()` (`:964-965`), removal in the single shared `teardown()` (`:942`). Confirmed
  `resolveBackupDir()` is called with no argument at every production call site
  (`src/server/backups.ts:92,155,172,219`), so env-injection is the only correct way to redirect it —
  matches the harness's approach exactly. `.gitignore` already excludes `/e2e-backups` and
  `/backups`; post-review filesystem check shows neither directory present.
- The fetch-timing race fix is real and correctly diagnosed: `BackupBanner`'s throttle/latch state
  is a `useRef` reset by `page.goto`'s full navigation (confirmed by reading `BackupBanner.tsx`), so
  the actual risk was `page.goto` resolving before the post-mount health fetch — fixed by arming
  `page.waitForResponse` before navigating. This is the SAME idiom already used elsewhere
  (`e2e/flows/reports.mjs:59-63`, arm-before-mutate-await-before-assert), not a novel pattern.
  "Open Backups" / "Backups are up to date" / "Backup folder:" text assertions all match the real
  source (`BackupBanner.tsx:83`, `admin/backups/page.tsx:78,101`).
- Off-brief fix (`tests/backup-paths.test.ts`) correctly diagnosed (`.env`'s `BACKUP_DIR="./backups"`
  leaking through `dotenv.config()` into `resolveBackupDir`'s default-parameter fallback) and fixed
  with the exact save/restore idiom already used in `tests/backups-routes.test.ts:54-62` — confirmed
  by direct read, and the fixed test passes (`npx vitest run tests/backup-paths.test.ts` → 14/14).
- Both `manage_backups` backfill migrations (`20260816120000_..._full_roles`,
  `20260816130000_..._admin_roles`) exist and do what the docs claim; "no manual `npm run db:seed`"
  claim (`README.md:795-798`, `HANDOFF.md:124`) is accurate and correctly scoped (fresh-install
  seeding elsewhere in the README is unaffected and unaltered).
- CLAUDE.md paragraph placed correctly (directly after the Phase 8B paragraph, before "Constraints
  that will bite you," nothing displaced) and contains no moving counts/totals — compliant with the
  file's own rule. Migration count claim ("39 migrations") verified exact
  (`ls -d prisma/migrations/*/ | wc -l` → 39).

## Issues

### Critical (Must Fix)
None.

### Important (Should Fix)
None.

### Minor (Nice to Have)
- `docs/HANDOFF.md:319` ("It does not block 8C...") is now slightly stale phrasing now that 8C is
  code-complete — harmless (still factually true that #115 didn't block 8C's build), and §6 wasn't
  in this task's file list, so this is a pre-existing nit rather than a task defect.
- The E2E fix's `waitForResponse`-then-immediate-`.count()` pattern still leaves a small window
  between the network response settling and React's state update/re-render landing in the DOM before
  the assertion runs; this is an accepted, pre-existing idiom in this codebase
  (`e2e/flows/reports.mjs:59-68`) rather than something new introduced here, so not worth blocking on.

## Assessment
**Task quality:** Approved
**Reasoning:** The restore runbook, E2E harness plumbing, and the fetch-timing race fix were all
verified against the live repo and a live Docker/Postgres box — commands, service/profile flags,
filenames, migrations, and UI text all match reality, and the off-brief test fix is a correct,
precedent-following isolation fix, not a behavior change.
