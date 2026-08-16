# Task 8 — scoped re-review of fix rounds 1 & 2 (75124d8..fe059f6)

## ITEM 1 — unguarded gzip compress step: **ADDRESSED**

- `erp/scripts/backup.sh:47-52` — the compress step is now `if ! gzip < "$TMP" > "$DIR/erp_${STAMP}.sql.gz"; then`,
  and the failure arm removes **both** artifacts (`rm -f "$TMP" "$DIR/erp_${STAMP}.sql.gz"`, line 48),
  calls `write_status false "could not compress the dump"` (line 49) **before** `exit 1` (line 51).
  Ordering is right: the `rm -f` precedes `write_status`, so on a genuinely full disk the multi-GB
  temp dump is freed before the ~100-byte status write is attempted. Every other failure arm
  (lines 34, 42, 55) has the same rm-then-write-then-exit ordering.
- Reproduced both directions in scratch (no repo mutation), fake `pg_dump` on PATH + a `gzip` stub
  exiting 1, with a pre-seeded `{"ok":true}` status file:
  - PRE-FIX copy: exit 1, status file **unchanged (stale `ok:true`)**, plus a 0-byte
    `erp_<stamp>.sql.gz` and an orphaned `.erp_<stamp>.sql.tmp` left behind — the original finding, verbatim.
  - SHIPPED script: exit 1, status flips to `ok:false` / `"could not compress the dump"`, directory
    contains only `backup-status.json` — no `.gz`, no `.tmp`.
  So `tests/backup-script.test.ts` is **non-vacuous**: its three assertions (`status.ok === false`,
  no `.sql.tmp`, no `.sql.gz` — `tests/backup-script.test.ts:413-419`) are each exactly what the
  pre-fix script violates. The control test (`tests/backup-script.test.ts:436-446`, no gzip override)
  proves the failures come from the stub, not the doctored PATH. It drives the real
  `scripts/backup.sh` via `spawnSync("sh", [SCRIPT])` (`:391`), not a paraphrase.

### Whole-script `set -e` re-audit (siblings)

Read `backup.sh` end to end. Every externally-fallible command that gates a status write is now
guarded: `pg_dump` (:33), the empty-dump test (:41), compress (:47), `gzip -t` (:54).
- `rm -f` (:34, :42, :48, :53, :55) — returns 0 for a missing target; only a non-writable directory
  makes it fail, which is the same condition that would defeat `write_status` anyway.
- `STAMP=$(date …)` (:31) — an aborting `date` would exit before any status write, but it precedes
  every use of `$STATUS` and is not a reachable production failure.
- The two `find … -delete` (:62, :64) — a failure here skips `write_status true`; this is the
  sibling the previous round explicitly triaged **do-not-fix** (fails toward red, the safe
  direction). Unchanged, still that shape.
- `write_status`'s own `printf … > "$tmp"` (:25-27) and `mv` (:28) — if these fail the script aborts
  with no status update. Inherent to writing the status into the same directory being backed up;
  the disk-full path is already mitigated by the rm-before-write ordering above. Deferred, not new.
No un-guarded sibling of the original defect remains.

## ITEM 2 — drift guard strengthened: **ADDRESSED**

`erp/tests/backup-permission-backfill.test.ts:216-219` now asserts
`[...REQUIRED_PERMISSIONS].sort()` deep-equals `ALL_PERMISSIONS.filter(p => p !== "action.manage_backups")`
sorted. That is set equality against the real source of truth — `ALL_PERMISSIONS`
(`src/server/permissions.ts:9-12`) is derived from `AREAS`/`CRUD_ACTIONS`/`SPECIAL_ACTIONS` in
`src/lib/permission-constants.ts`, with no path back to the migration text, so a typo'd entry paired
with an omitted real one (which the old count/uniqueness/absence trio passed) now fails. The count
and no-duplicate assertions (`:202-206`) are retained, so a regex that starts matching junk still
fails loudly rather than degrading the other tests to "0 required permissions".

## ITEM 3 — the superseding migration: **ADDRESSED**

- **Predicate is exactly the stated rule.**
  `erp/prisma/migrations/20260816130000_grant_manage_backups_to_admin_roles/migration.sql:35-47`:
  `INSERT INTO "RolePermission" ("id","roleId","permission") SELECT gen_random_uuid()::text, r."id",
  'action.manage_backups' FROM "Role" r WHERE r."deletedAt" IS NULL AND EXISTS(… 'admin.view') AND
  EXISTS(… 'action.manage_users') ON CONFLICT ("roleId","permission") DO NOTHING;`
  — `deletedAt IS NULL` at :38, the two `EXISTS` joined by **AND** (:39-46, not OR),
  `gen_random_uuid()::text` for the NOT-NULL-no-default `id` (:36), `ON CONFLICT … DO NOTHING` (:47).
  Note the correlated subqueries key on `rp."roleId" = r."id"` (:41, :45), so a permission held by a
  *different* role cannot satisfy either arm.
- **Genuinely a superset.** `'admin.view'` and `'action.manage_users'` are both members of migration
  1's 64-row `VALUES` list (`…20260816120000_…/migration.sql:65` and `:82`), so every role that
  satisfied the all-64 predicate satisfies this one.
- **Original migration untouched.** The review package lists only 4 changed files, none of them the
  20260816120000 directory; focused check `git diff --stat 75124d8..fe059f6 --
  erp/prisma/migrations/20260816120000_…/` returns empty and `git log 75124d8..fe059f6 -- <that dir>`
  returns 0 commits. No hook violation, no P3009 hazard.
- **Sequence interaction asserted as a count of 1**, not merely "no error":
  `tests/backup-permission-backfill.test.ts:314-325` builds an all-64 role, runs migration 1, then
  migration 2, then `expect(rows).toHaveLength(1)` on the fetched `action.manage_backups` rows (:324).
- **Both suites drive the shipped SQL files**, not a paraphrase: `MIGRATION_1_PATH`/`MIGRATION_2_PATH`
  + `readFileSync` (`:150-160`) and `$executeRawUnsafe(SQL_ALL_64 | SQL_ADMIN_ROLES)` (`:175-181`).
- **The motivating case is covered**: "grants it to a role holding admin.view + action.manage_users
  with FEW other permissions" (`:271-275`, fixture = `["admin.view","action.manage_users","orders.view"]`).
- **Negatives all present**: `admin.view` only (`:277-281`), `action.manage_users` only (`:283-287`),
  neither (`:289-293`), soft-deleted role holding both (`:295-301`), plus migration-2 re-run
  idempotence asserting exactly one row (`:303-311`).

## New breakage introduced by the fix diff

None found (Critical or Important). Ran the three permitted files — `tests/backup-script.test.ts`,
`tests/backup-permission-backfill.test.ts`, `tests/permissions-sweep.test.ts` — 23 tests, 3 files,
all passing, **pristine output, zero warnings**, matching the report's fix-round-2 numbers exactly.
The new migration is a pure INSERT keyed on live roles and is a no-op on a fresh DB, so it cannot
contaminate `erp_test` (every suite starts from `truncateAll()`, which wipes `Role`).

## Deferred (out of scope — do not extend this loop)

1. `write_status` cannot report a failure when `$DIR` itself is unwritable (read-only mount /
   permission denied): the script aborts with no status update, leaving any pre-existing status file
   stale. Distinct from the fixed disk-full class, which the rm-before-write ordering does cover.
2. `backup.sh` hardcodes `backup-status.json` while the brief's Interfaces line names
   `BACKUP_STATUS_FILENAME` as a consumed env var — pre-existing, unchanged by this diff.
3. The retention `find` skipping `write_status true` on failure — previously triaged do-not-fix.

## Verdict

**All three items ADDRESSED; no new breakage. Approved.**
