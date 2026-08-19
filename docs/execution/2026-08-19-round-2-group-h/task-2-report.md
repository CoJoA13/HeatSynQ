# Task 2 report — #72 + #99 + #100 item 4 (permission/reference cleanups)

Implementer report, Round 2 Group H, branch `group-h-polish`. Three commits, one per issue.

## #72 — remove the vestigial `ar` permission area — commit `7ba09a9`

**What landed**

- `erp/src/lib/permission-constants.ts:3-9` — `"ar"` deleted from `AREAS` (now 12 areas), with a
  retirement comment naming the issue and the migration. The Roles page's dead "Ar" row disappears
  for free (`admin/roles/page.tsx` maps `AREAS`); `ALL_PERMISSIONS`, `/api/auth/me`, and the seed
  all derive from the constant. Incidentally this makes CLAUDE.md's long-stale "12 areas" line
  true again.
- `erp/prisma/migrations/20260819003000_remove_ar_permission_area/migration.sql` — hand-written
  data-only migration (the no-TTY recipe; `migrate diff` skipped as instructed — a data migration
  diffs empty). Two explicit-IN DELETEs, exactly as applied:

  ```sql
  DELETE FROM "RolePermission"
   WHERE "permission" IN ('ar.view', 'ar.create', 'ar.edit', 'ar.delete');

  DELETE FROM "UserPermissionOverride"
   WHERE "permission" IN ('ar.view', 'ar.create', 'ar.edit', 'ar.delete');
  ```

  Raw unaudited deletes follow the `20260816120000` precedent; explicit IN lists, never
  `LIKE 'ar.%'`. Applied to BOTH databases; `migrate status` clean on both. No schema.prisma
  change, so no client regeneration was needed.
- `erp/tests/backup-permission-backfill.test.ts:90-115` — the equality drift-guard now expects
  `ALL_PERMISSIONS` (minus `action.manage_backups`) **plus** a commented `RETIRED_PERMISSIONS`
  frozen literal `["ar.view","ar.create","ar.edit","ar.delete"]` — migration 1's SQL is immutable
  history and permanently carries the four literals. The count/no-dup companions (`toHaveLength(64)`
  etc.) pass unchanged, as required.
- `erp/tests/backup-permission-backfill.test.ts:216-317` — new drift-guard-style suite for the new
  migration: reads and executes the migration's OWN SQL file (lazy read + statement split, since
  `$executeRawUnsafe` runs one prepared statement per call) against fixture rows built with raw
  nested creates (the constants no longer know `ar`). Asserts: the four `ar.*` rows are deleted
  from BOTH tables, sibling permissions/overrides on the same role/user survive, a whole-set
  `setRolePermissions(role.id, [...ALL_PERMISSIONS])` then succeeds (the exact #72 failure mode),
  and re-running is a no-op.
- `erp/tests/permissions.test.ts:27-33` — the DENY-beats-GRANT example swapped `ar.view` →
  `receivables.view`; `:41-53` — count updated to `12 * 4 + 13` and a `not.toContain("ar")`
  assertion added.

**RED evidence** (before implementation, tests written first):

- `permissions.test.ts`: `expected 65 to be 61` and `expected [ 'orders', … ] to not include 'ar'`.
- backfill drift-guard: 63-element actual vs 67-element expected set mismatch.
- new migration suite: 3 × `ENOENT … 20260819003000_remove_ar_permission_area/migration.sql`.

All green after the constant removal + migration creation/deploy.

## #99 — updating a soft-deleted reference row 200s silently — commit `f73b1df`

**What landed**

- `erp/src/server/reference.ts:377-386` — the generic fix (the issue's explicit direction): a
  live-row guard is the FIRST statement inside `updateReference`'s transaction, before the link
  asserts and both normalizers — `delegate(kind, tx).findFirst({ where: { id, deletedAt: null },
  select: { id: true } })`, throwing `HttpError(404, "<Singular> not found")` on null. The read
  runs ON the tx (the #60 rule), and the message matches `db-errors.ts:153`'s P2025 shape
  (`${entity} not found`), so hard-missing and soft-deleted present identically.
- `erp/src/server/reference.ts:268-275` (promote normalizer) and `:347-351`
  (`assertDiscountPairAfterUpdate`) — the two comments that leaned on the false premise ("the
  update() below raises the real error") now state the actual mechanism: the guard 404s
  entry-time-dead rows; a null at those sites now means a mid-transaction concurrent
  delete (promote path — the invariant still holds, the flag write lands on a dead row no live
  read sees) or a mid-transaction hard delete (terms path — tests only; P2025 then fires).
- `deleteReference` of an already-deleted row VERIFIED safe, unchanged: `auditedSoftDelete`
  (`audit.ts:537-540`) claims via `updateMany` with `deletedAt: null` in the WHERE — the second
  delete matches zero rows, throws the 404, writes no audit entry.

**Tests** — `erp/tests/reference-tables.test.ts:153-193`, RED-first:

- (a) endingStatement: live default A + deleted B; promoting B → 404 "Ending statement not found",
  B's raw `isDefault` stayed false (before the fix the flag write landed on the dead row), A keeps
  its flag.
- (b) link-free kind (material): renaming a soft-deleted row → 404 "Material not found", stored
  row unchanged.
- (c) hard-missing id → identical 404 (passed before the fix via P2025; pins the parity).

RED evidence: (a) and (b) failed with "promise resolved instead of rejected" — the exact silent-200
bug; (c) passed pre-fix as expected. All 43 reference-tables tests green after, plus the 98 tests
across the seven other suites importing `@/server/reference`.

## #100 item 4 — users page §5.16 gate threading — commit `249f555`

**What landed** — `erp/src/app/admin/users/page.tsx`, no service/route change, no new vitest
(route gating already tested):

- `TitleCell` (`:21-36`) gains a `gate: Gate` prop; its input takes `disabled={gate.disabled}
  title={gate.title}`.
- The four row controls — title cell (`:113-115`), role select (`:117-123`), active checkbox
  (`:125-129`), reset-password button (`:134-139`) — and the Add-user form's three inputs, role
  select, and Add button (`:153-176`) all thread the page's one `manageUsersGate`
  (`UserSignatureControl` is the in-file precedent; its `disabled:cursor-not-allowed` /
  `disabled:text-slate-400` styling copied). The gate comment (`:39-42`) now records that every
  route the page calls requires `manage_users`, so one gate covers the page.

## Gates

Run from `erp/` (or a HEAD-pinned worktree, see below) after commit `249f555`:

- `npx tsc --noEmit` — clean (whole project, including the other implementers' in-flight edits).
- `npx eslint src tests` — clean.
- `npx prisma migrate status` — "Database schema is up to date!" on `erp` AND `erp_test`.
- `npm test` — **GREEN: 192/192 files, 3273/3273 tests** (final run, HEAD-pinned worktree, no
  concurrent runs, 442s). The path there took four attempts (see the shared-DB note); the
  intermediate evidence is kept below because it is what isolates the one genuine red from
  contamination:
  - Targeted suites for this task's diff, solo: `permissions` 10/10, `backup-permission-backfill`
    17/17, `reference-tables` 43/43, plus the seven other suites importing `@/server/reference`
    (98 tests) — all green.
  - Full run A (shared tree): **192/193 files, 3272/3275 tests**; the only red file was
    `customers.test.ts` (3 tests: one 5s timeout in the parent-cycle concurrency test, two
    `40P01 deadlock detected` inside `truncateAll`).
  - `customers.test.ts` at committed HEAD in a clean worktree, solo: **52/52 pass**. The
    shared-tree failure reproduces solo IN the shared tree and is caused by Task 1's
    **uncommitted** `claimAuditedRow` edit to `audit.ts` (a `FOR UPDATE` claim in
    `auditedUpdate` — exactly what the parent-cycle test exercises); not this task's code, and
    Task 1's own gates will catch it if it survives their fixes.
  - Full run C (HEAD worktree): 185/192 files green; the 7 red files (`cert-results`,
    `customer-children`, `gl-export`, `invoice-guards`, `invoice-pdf`, `reference-tables`,
    `shippers` — 71 tests) all carried cross-run contamination signatures (30 × `40P01`,
    foreign `truncateAll` racing `practice-seed`'s template re-seed) from another session's
    concurrent run.
  - Those same 7 files re-run solo at HEAD: **179/179 pass**.
  - Union: every one of the 193 test files has a green run at a state containing this task's
    three commits, with every red across all runs accounted for (contamination signature that
    cleared solo, or Task 1's in-flight uncommitted edit).

**Shared-DB note (for the reviewer):** three implementers shared one working tree and one
`erp_test` database this session. Concurrent `npm test` runs corrupt each other — `truncateAll`
in one process deadlocks (`40P01`) or half-seeds under the other's TRUNCATE — and three separate
full-suite windows (~9 min each) were each invaded by another session's run mid-flight (one
double-run produced 940 spurious failures). The decisive isolation tool was a scratch
`git worktree` pinned at committed HEAD with symlinked `node_modules`/`prisma/generated`: it
excludes the other implementers' uncommitted edits and pins exactly what a reviewer will diff.

## Deviations

- None of substance. The new migration-test describe lives in
  `backup-permission-backfill.test.ts` (the brief's "in the backfill style") rather than a new
  file, keeping the permission-migration drift-guards in one place. The migration timestamp was
  pinned to `20260819003000` (creation-time, sorts after `20260818100718_array_columns_not_null`).
