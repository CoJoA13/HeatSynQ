# Phase 8C — Backup polish: progress ledger

Branch: `phase-8c-backup-polish`. Plan: `docs/superpowers/plans/2026-08-16-phase-8c-backup-polish.md`.
Binding spec: the Phase 8 design spec §6 + **§6.4** (owner kickoff rulings, 2026-08-16).

## Baseline gates on `main` (2026-08-16, before branching)
vitest 2898 / 171 files · tsc clean · eslint clean · build clean · E2E 22/22 · 37 migrations.

## Tasks
| # | Task | Implementer | Review | Notes |
|---|---|---|---|---|
| 1 | Pure leaf: constants + path safety | sonnet, DONE | **Spec ✅ · Approved** (round 1) | `bbc2611..e5f2c56`. 14/14 new tests; tsc/eslint clean. Reviewer independently re-ran the tests and verified by execution that `UNSAFE_CHARS` is a well-formed character class and that neither archive regex can match a name containing `/`, `..`, or an embedded newline — i.e. the filename-shaped escape guard actually holds. |
| 2 | `manage_backups` + `backup_stale_hours` | sonnet, DONE | **Spec ✅ · Approved** (round 1) | `cce97df`. Full suite 2917 / 173 files. The task's real risk was the permission-count growth: the reviewer independently swept `src`/`tests`/`prisma` for hardcoded counts and for bare numeric literals encoding one, found the single site (`permissions.test.ts:46`, `13*4+12`→`13*4+13`), and confirmed the arithmetic from source (13 areas × 4 + 13 actions = 65) rather than accepting the edit as self-evident. |
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
- **2026-08-16, pre-Task 6 (found while pre-flighting, not by an implementer):** the nav model
  (`src/lib/nav.ts` — NOT `Shell.tsx`, which merely renders `visibleAdmin(...)`) gates every entry on
  `<area>.view`. **`manage_backups` is a special ACTION**, so there is no `backups.view` to gate on, and
  gating the entry on `admin.view` would leave a `manage_backups`-only user able to *use* the Backups
  page but unable to *find* it — the §5.15 silent dead end that `nav.ts`'s own Templates note exists to
  avoid. Fixed in the plan (`54c09c9`, `210e582`): `NavEntry` becomes a discriminated union (area-gated
  **or** action-gated), both list builders route through one `canSeeEntry`, and `nav.test.ts` gains the
  case that pins it. **This was a genuine gap between the permission model and the nav model**, not a
  transcription slip.
