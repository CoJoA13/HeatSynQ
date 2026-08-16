# Phase 8C — Backup polish: progress ledger

Branch: `phase-8c-backup-polish`. Plan: `docs/superpowers/plans/2026-08-16-phase-8c-backup-polish.md`.
Binding spec: the Phase 8 design spec §6 + **§6.4** (owner kickoff rulings, 2026-08-16).

## Baseline gates on `main` (2026-08-16, before branching)
vitest 2898 / 171 files · tsc clean · eslint clean · build clean · E2E 22/22 · 37 migrations.

## Tasks
| # | Task | Implementer | Review | Notes |
|---|---|---|---|---|
| 1 | Pure leaf: constants + path safety | sonnet, DONE | **Spec ✅ · Approved** (round 1) | `bbc2611..e5f2c56`. 14/14 new tests; tsc/eslint clean. Reviewer independently re-ran the tests and verified by execution that `UNSAFE_CHARS` is a well-formed character class and that neither archive regex can match a name containing `/`, `..`, or an embedded newline — i.e. the filename-shaped escape guard actually holds. |
| 2 | `manage_backups` + `backup_stale_hours` | | | |
| 3 | Health evaluation + archive listing | | | |
| 4 | `runBackupNow` | | | |
| 5 | API routes | | | |
| 6 | Backups admin page | | | |
| 7 | Shell warning bar | | | |
| 8 | Deploy wiring (Dockerfile/compose/backup.sh) | | | |
| 9 | Restore runbook + E2E flow + docs | | | |

## Deferred minors (triage input for the whole-branch review)
- **T1** `isHealthy()` is exported from `backup-constants.ts` but untested and, so far, unused — the
  page reads `health.state === "ok"` directly. Inherited verbatim from the plan's code block, so it is
  a plan-level gap, not an implementer defect. **If no consumer exists by Task 7, delete it (YAGNI)
  rather than write a test for dead code.**

## Process notes
- **2026-08-16, Task 1:** `.superpowers/sdd/.gitignore` was found reverted to a bare `*` *during this
  session* — the clobber CLAUDE.md documents as having cost Phase 3's record. It was hiding the task
  briefs from git; the implementer restored it before touching anything else. The durable record
  (this directory) was unaffected, which is the whole point of the `docs/execution/` rule.
- **2026-08-16, pre-Task 2:** the plan's test code named three helpers that do not exist
  (`tests/helpers/actor.ts`, `tests/helpers/http.ts`, `userWithPermissions()`). Corrected in `22d0e33`
  against the real tree: `runWithContext(...)` for actor context, `signInWith(perms)` returning a
  **cookie string**, and `permissions.test.ts`'s local DB-free `user()` helper. Caught before dispatch.
  Standing correction: verify a task's helper names against the tree before dispatching it.
