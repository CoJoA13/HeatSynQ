# Phase 8C — Backup polish (merged `941ceab`, PR #117, 2026-08-16)

Third and final sub-phase of roadmap Phase 8. **Completes Phase 8 and, with it, every build phase in
the 8-phase roadmap.** Binding design: `docs/superpowers/specs/2026-08-14-phase-8-reports-parallel-run-design.md`
§6 (8C) and **§6.4** (the owner's kickoff rulings — §6.4 supersedes older prose in §6.1–§6.3).
Plan: `docs/superpowers/plans/2026-08-16-phase-8c-backup-polish.md`. Full execution ledger, task
briefs, implementer reports and every reviewer verdict: `docs/execution/2026-08-16-phase-8c-backup-polish/`.

**Final gates:** 2988 tests / 179 files · `tsc`/`eslint`/`build` clean · E2E **23/23** · **39
migrations** · CI green. Baseline on `main` was 2898/171 and 22 flows — **+90 tests, +8 files, +1 E2E
flow, +2 migrations.**

---

## 1. What it shipped

The nightly backup container already ran. 8C gave it a face and a pulse.

- **`src/lib/backup-constants.ts`** — client-safe types, archive-name regexes, `DEFAULT_STALE_HOURS`.
- **`src/server/backup-paths.ts`** — a **pure** leaf (no fs, no db, no permissions; the
  `order-locks.ts`/`invoice-guards.ts`/`practice-mode.ts` precedent). Resolves and validates
  `BACKUP_DIR`, builds and parses archive names, and is the **only** way a filename becomes a path.
- **`src/server/backups.ts`** — `evaluateHealth` (a pure, table-tested function holding the whole green
  rule), `listArchives`, `backupHealth`, `backupsView`, and `runBackupNow` (argv-spawned `pg_dump`,
  fail-loud on an empty dump, `gzip -t`-verified before being declared good, a 30-minute stall ceiling,
  SIGTERM→SIGKILL escalation, single-flight).
- **`manage_backups`** (new named dangerous action, spec §12 item 6) + **`backup_stale_hours`** (the
  only backup *setting*; folder, cadence and retention are deploy config).
- **Three `manage_backups`-gated routes**, the **`/admin/backups`** page (list + integrity + resolved
  folder + "Back up now" + red staleness), and the shell **`BackupBanner`**.
- **Deploy wiring** — `postgresql18-client` in the app image, `BACKUP_DIR` + the `./backups` mount on
  `app` and `backup` but pointedly **not** `app-practice`, and a hardened `scripts/backup.sh`.
- **Two data migrations** backfilling `manage_backups` onto existing installs (§3).
- **An expanded, live-verified restore runbook** in `erp/README.md`. Restore stays a terminal command.

**Upgrading an existing install now grants `manage_backups` automatically on `migrate deploy` — there
is no manual `npm run db:seed` step.**

## 2. Owner rulings (spec §6.4, 2026-08-16)

| Decision | Ruling |
|---|---|
| Folder | **`BACKUP_DIR`**, container `/backups`, host `./backups`, mounted into `app` too. `app-practice` gets **neither** env nor mount |
| Staleness threshold | **`backup_stale_hours` = 36** — a full 12h of slack past the 24h cadence: one late run never cries wolf, two consecutive misses always do |
| Cadence + retention | **Unchanged** (nightly, 30-day prune). On-demand archives obey the **same** rule — one retention rule to remember |
| **The green rule** | Green requires **all three**: newest integrity-passing archive within the threshold **AND** the last recorded run did not fail **AND** the status file is present and parseable. A recorded failure is red **immediately**, even with a 25h-old success in the window. Manual backups count as successes |
| Alerting surface | The page **and** a `manage_backups`-only shell bar — "a red light on a page nobody opens is the same silent failure this feature exists to kill" |
| E2E coverage | The host gets the `postgresql` client so the flow clicks the **real** button; vitest injects a fake dump command |

**The load-bearing design call: `lastSuccessAt` is DERIVED, never stored** — it is the newest
`gzip -t`-passing archive's mtime. The archive *is* the evidence of success. That is what lets the
status file be a single un-merged overwrite a `sh` script can write, with no JSON read-merge needed to
preserve a prior success across a failed run.

**Collision-proofing is by namespace, not a lock** (`erp_<stamp>.sql.gz` vs
`erp_manual_<stamp>_<hex>.sql.gz`, plus distinct temp names), so the two writers can never touch the
same path. **Path safety is filename-shaped, not root-shaped** — `BACKUP_DIR` is deploy-set, so
"confine to an allowed root" is meaningless; instead `archivePath` refuses any name failing a strict
regex before joining, so a filename can never escape.

## 3. The post-upgrade permission gap — two rulings, because the first decayed

Adding `manage_backups` to `SPECIAL_ACTIONS` grants it to **nobody**: the documented upgrade path runs
`prisma migrate deploy` but **never the seed**, and the seed is the only thing that grants
`ALL_PERMISSIONS`. Without a backfill the Backups page would be invisible and every route would 403 —
the feature would look like it never shipped.

**Ruling 1** (during Task 6): backfill by migration, granting only to roles already holding every
*other* permission — preserving "this role can do everything" rather than conferring a new power.

**Ruling 2** (same day, after review): that predicate would have been a **silent no-op on the very box
it protects.** `SPECIAL_ACTIONS` has grown at least three times since Phase 1 (`override_credit_hold`
P4, `write_off` 5B, `manage_backups` now) and only the seed backfills existing roles, so a once-seeded,
since-upgraded install holds ~58 permissions, not 64. The rule became: grant to any **live** role
holding **`admin.view` AND `action.manage_users`** — the same intent stated so it does not decay, since
a role that can assign permissions could already grant itself this one. Strictly a superset.

**This came from a reviewer's "⚠️ cannot verify from diff" item, not from a finding** — twice this
phase the un-verifiable item mattered more than the findings, and both times it needed deployment
history held only at the controller level.

**The fix could not be an in-place edit.** `.claude/hooks/protect-applied-migrations.sh` denies editing
any existing `migration.sql` (the P3009 desync class, Phase 3 Task 6) and its denial text asks for the
owner's manual approval. The implementer hit it, **correctly declined to route around it via raw Bash**,
and restored both databases to a git-consistent state after having already cleared the
`_prisma_migrations` rows. The owner chose the hook-compliant path: leave `20260816120000` untouched,
add `20260816130000_grant_manage_backups_to_admin_roles`. Both are idempotent; a test pins that running
both leaves exactly **one** row.

## 4. Review record

Nine per-task reviews — **seven approved on round 1**; Task 4 needed one fix round, Task 8 two. A
five-lens whole-branch review (opus) returned **zero Critical and nothing blocking**. One fix wave
closed four *silences*. Then Codex's PR review found **3 P1 + 7 P2**, and the re-review of *those* fixes
found three more problems in the fix itself.

### The defects that mattered

**Every single one had the same shape: something that fails while reporting success.**

1. **A stream race that hung every backup request** (caught by TDD, in the *plan's* own code). The spawn
   promise registered `out.on("finish")` inside the child's `close` handler — but `pipe()`'s automatic
   `end()` can fire `finish` **first**, so the listener attached too late and the promise never settled.
2. **`pg_dump` left running after a write error** (Important, whole-branch). On ENOSPC the promise
   rejected while the child kept running — holding a libpq connection, a REPEATABLE READ snapshot and
   `ACCESS SHARE` on **every table**. `pipe()` only unpipes; it never kills the source. Each retry click
   stranded another, so an operator responding to a failing backup would progressively degrade the
   database they were protecting. `child.stdout` also had **no** `error` listener at all — a source
   `destroy(err)` produced an uncaught exception.
3. **Disk-full read GREEN for 36 hours** (Important, inherited from the plan's literal script text). A
   bare `gzip < tmp > final` under `set -e` aborts **before** any `write_status`, so the previous
   night's `{"ok":true}` survived. The archetypal backup failure was precisely the one the status file
   could not report — and it failed in the green direction.
4. **Three P1s in the restore runbook** (Codex). The runbook had already passed a dedicated task review
   *and* the whole-branch review; both verified the commands **run**, neither checked what the shell
   **semantics meant**. (a) `pg_dump | gzip` without `pipefail` — a truncated dump exits 0, so the
   "safety dump" reads successful and the procedure **drops the live database with no recovery copy**.
   (b) The restore stopped only `app`, leaving the nightly `backup` loop free to archive a **partially
   restored** database and write `ok:true`. (c) `psql` without `ON_ERROR_STOP=1` continues past a failed
   statement, so a partial restore reads clean.
5. **Two problems inside the Codex fix** (re-review). Awaiting `"close"` (which needs stdio closed)
   instead of `"exit"`: a grandchild inheriting stdout means `close` **never** fires, so the promise
   never settles and `inFlight` **wedges permanently** — re-introducing the defect the stall timeout
   existed to bound, now with no ceiling. And `before-restore-*.sql.gz` never matched the
   `erp_*.sql.gz` prune, so full production dumps accumulated forever **while the README claimed
   everything was pruned at 30 days.**

### Four tests that passed for the wrong reason

A recurring failure, from four different authors by four different mechanisms — worth naming as a
class, because each one *looked* like coverage:

1. Task 4's process-kill test passed via a **no-assertion branch** (its 500ms budget expired at 571ms,
   so the assertion never executed).
2. Task 8's drift guard **pinned the permission list against itself** — a typo *paired with* an
   omission would still have counted 64.
3. Task 9's E2E assertion could pass **vacuously, before the health fetch resolved**.
4. Codex's catch: the kill test **polled for exit after the promise rejected**, proving nothing about
   whether the process was gone *before* single-flight released.

## 5. Process lessons

- **Plan code written from memory is not code written against the tree.** Seven plan defects were caught
  in pre-dispatch review, three of them invented APIs (`tests/helpers/actor.ts`, `tests/helpers/http.ts`,
  `userWithPermissions()`), one a hand-rolled `/api/auth/me` effect that would have been an **eighth**
  copy of the very pattern `use-permissions.ts` was extracted to stop — carrying the exact
  error-swallowing bug its header warns about. **Verify a task's helper names against the tree before
  dispatching it.**
- **The permission model and the nav model did not line up.** `manage_backups` is a special *action*,
  but every nav entry gated on `<area>.view`. Gating on `admin.view` would have left a
  `manage_backups`-only user able to *use* the page but unable to *find* it — the §5.15 silent dead end
  `nav.ts`'s own Templates note exists to avoid. `NavEntry` became a discriminated union.
- **CONTROLLER ERROR — never `git add -A` while an implementer subagent is live.** Two doc commits
  silently absorbed an implementer's working-tree files; it correctly reported its own work as already
  committed under unrelated messages. Nothing was lost and the branch squash-merges, so history was
  deliberately *not* rewritten. **Stage explicit paths.**
- **CONTROLLER ERROR — only one test-running process at a time.** `fileParallelism: false` serializes
  test *files* within **one** vitest invocation; it does nothing across **separate** processes sharing
  `erp_test`. Overlapping a reviewer with an implementer produced `truncateAll` deadlocks twice.
- **The controller instructed an edit a project safety hook forbade** (§3). "The rule doesn't really
  apply to my case" is precisely the reasoning such a hook exists to block, and the tidy-history
  preference behind that instruction was the controller's, not the owner's.
- **Reviewing the *fix* is not optional.** Both fix waves introduced new problems that a scoped
  re-review caught — including one that re-created a defect the phase had already fixed.

## 6. Deferred, filed as issues after merge

**#118** unbounded concurrent `gzip -t` per page load (and an uncached decompression per `/health`
poll) · **#119** preflight failures of a manual backup produce no audit row · **#120** a failing
retention `find` leaves the status green · **#121** the error bar reaches non-`manage_backups` users in
a total DB outage (the silencing 403 itself needs a DB read) · **#122** *pre-existing from 8B* —
`vitest.config.ts` sets no `include`/`exclude`, so a post-build run collects `.next/standalone/**/tests`,
which **inflated some intermediate test counts reported during this phase** (the final figures above
were taken after `rm -rf .next` and are real).
