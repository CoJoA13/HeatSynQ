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
| 3 | Health evaluation + archive listing | sonnet, DONE | **Spec ✅ · Approved** (round 1) | `e6ea01c..8c703c2`. 17 new tests; full suite 2934 / 174 files. Reviewer hunted specifically for an **unsafe green** and found none: confirmed by execution that `gzip -t` fails a zero-byte archive, and that both `listArchives` and `newestIntactAt` filter on `s.isFile()` so a *directory* named like an archive is excluded. Green-rule branch order, derived-only `lastSuccessAt`, `parseStatus`'s wrong-shape rejection, and the un-memoized `assertNotPracticeDatabase` all verified at file:line. |
| 4 | `runBackupNow` | sonnet, DONE | round 1 **Needs fixes** (1 Important, 8 Minor) → fix round 1 → **all 3 ADDRESSED, approved** | `d6e9d0e..1bb5fcb`. 15 tests here, full suite 2946 / 175. **TDD caught a real hang in the PLAN's own code**: the spawn/pipe promise registered `out.on("finish")` inside the `close` handler, but `pipe()`'s auto-`end()` can fire `finish` first — every call hung at the 5s timeout. **Review (opus) then found an Important the implementer's fix had left open**: on a write-stream error (ENOSPC — the archetypal case) the promise rejected but `pg_dump` kept running, holding a libpq connection, a REPEATABLE READ snapshot and `ACCESS SHARE` on every table; each retry click stranded another. `child.stdout` also had NO error listener (a source `destroy(err)` → uncaught exception). Fixed with `child.kill()` on the error-settle path + a bounded 30-min timeout + a guarded success path. Re-review verified exactly-once settlement, no TDZ on `clearTimeout` (probed empirically), the timer cleared on both settle paths, and that `child.kill()` cannot run on the success path. |
| 5 | API routes | sonnet, DONE | **Spec ✅ · Approved** (round 1) | `b0a82a7`. 5 route tests. The security-critical carry-forward held: POST's handler is `async () =>` with **no `req` in scope at all**, so `runBackupNow`'s test-seam options (`dumpBin`/`dir`/`timeoutMs`) cannot be reached from a request even by accident — verified at source, plus a grep confirming none of the three routes reads body/query/headers. The deliberate 200-vs-500 asymmetry was checked against the code, not just the argument: both GETs wrap their fs reads in try/catch and cannot throw for a missing folder (red state at 200 — a read reporting "folder missing" IS the answer), while POST's 500 is a genuine `HttpError` from `access(dir, W_OK)` propagated through `handle`, not an escaping exception. `/health` leaks nothing the full view withholds. |
| 6 | Backups admin page | | | |
| 7 | Shell warning bar | | | |
| 8 | Deploy wiring (Dockerfile/compose/backup.sh) | | | |
| 9 | Restore runbook + E2E flow + docs | | | |

## Deferred minors (triage input for the whole-branch review)
- **T5 (pre-existing, worth a decision at whole-branch).** `resolveBackupDir()` **throws** for a
  *malformed* `BACKUP_DIR` (unsafe characters, a `..` segment) — as opposed to a merely *missing* folder,
  which correctly red-states. That throw happens before the GET routes' try/catch, so a malformed deploy
  value **500s the page and renders NO shell banner** (the banner treats any failure as "show nothing"),
  which is closer to the silent failure this feature exists to kill than to the loud one it wants. Not
  introduced by Task 5 — it lives in the Task 1 leaf. Options: catch it into an `unknown` red state with
  the validation message as `reason`, or leave it loud on the grounds that a malformed deploy value
  should stop the box. Owner-adjacent; decide at whole-branch.
- **T4 — CARRY INTO TASK 5 (not a minor, an instruction).** `timeoutMs` is now a public option on
  `runBackupNow` with no caller outside `backups.ts`. **The route must NOT forward request-controlled
  opts** — a client-settable dump timeout (or `dir`, or `dumpBin`) would be a real hole. The POST route
  calls `runBackupNow()` with NO arguments.
- **T4** Finding #1's kill test passes today via its no-assertion branch (`backup-run.test.ts:312-320`
  measures 571ms against a 500ms `waitForPid` budget, so `waitForProcessExit` never runs). It is still a
  genuine regression guard — unfixed code reliably records the pid and reddens it — but today's green is
  absence-of-evidence. Finding #2's timeout test is the unconditional proof.
- **T4** `child.kill()` is SIGTERM only, no SIGKILL escalation. Fine for `pg_dump`, which honours it.
- **T4** A crash *mid-gzip* leaves a truncated file at the archive's REAL final name (`pipeline` writes
  straight to `finalPath`; there is no gzip-then-rename hop). It cannot masquerade as a good backup —
  `gzip -t` rejects it and `newestIntactAt` skips it — but it is permanent debris nothing cleans up, and
  an operator eyeballing the raw folder rather than the health banner could misread its *presence*.
  Closing it means a second temp-then-rename around the gzip step. Design hardening, not a task defect.
- **T4** `fail()`'s per-step best-effort `.catch(() => {})` writes are pre-existing and untouched.
- **T3** No direct test for a **zero-byte** archive or for a **directory** named like an archive. The
  reviewer verified both behaviours by execution (`gzip -t` fails a zero-byte file; both readers filter
  on `s.isFile()`), so this is coverage, not a defect. Cheap to add alongside Task 4's fixture work.
- **T3** `parseStatus` tolerates a status file missing its `error` key (coerces to `null`). It can never
  produce a false green — `ok` and `lastRunAt` are both still strictly validated — so it is leniency,
  not a hole.
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
- **2026-08-16, during Task 3 — CONTROLLER ERROR, worth not repeating.** I ran `git add -A` twice to
  commit plan/doc edits *while the Task 3 implementer was actively editing the working tree*, so two
  documentation commits silently absorbed its files: `tests/backup-health.test.ts` landed in
  `29b162d` ("docs: pin the E2E harness's backup-folder plumbing") and `src/server/practice-mode.ts`
  in `c1de215` ("chore: match the gitignore convention"). The implementer found its own work already
  committed under unrelated messages and correctly reported it as a possible second process writing
  to the branch — a good catch on its part.
  **Nothing was lost and nothing is wrong in the tree** (full suite 2934 / 174 files green), and the
  branch squash-merges so the misleading messages never reach `main`. History was deliberately NOT
  rewritten: the benefit is cosmetic and pre-merge only, and `git rebase -i` is unavailable in this
  environment. The Task 3 review package spans all three commits so the reviewer sees the complete
  task.
  **Standing correction: never `git add -A` while an implementer subagent is live — stage explicit
  paths.** Doc edits during a task must be staged file-by-file.
