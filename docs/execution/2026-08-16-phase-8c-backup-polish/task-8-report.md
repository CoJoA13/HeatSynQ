# Task 8 report — Deploy wiring: image, compose, nightly script, permission backfill

## What changed

- `erp/Dockerfile` — added `RUN apk add --no-cache postgresql18-client` to the `run` stage,
  directly after `ENV NODE_ENV=production`, exactly as specified.
- `erp/docker-compose.yml`:
  - `app` service: added `BACKUP_DIR: /backups` env and `volumes: [./backups:/backups]`.
  - `backup` service: added `BACKUP_DIR: /backups` env (script now reads it instead of a
    hardcoded path).
  - `app-practice` service: added the "NO BACKUP_DIR, deliberately" comment; no env/volume
    added there.
- `erp/scripts/backup.sh` — rewritten per the brief: reads `BACKUP_DIR` (falls back to
  `/backups`), writes `backup-status.json` via temp-then-rename after every run (success and
  failure), fails loud on an empty dump, verifies gzip integrity before keeping the archive,
  and prunes both `erp_*.sql.gz` (30 days) and orphaned `.erp_*.sql.tmp` (1 day). See judgment
  call 2 below for one deliberate addition beyond the brief's literal text.
- `erp/.env.example` — appended the `BACKUP_DIR="./backups"` block with the local-dev note.
- `erp/prisma/migrations/20260816120000_grant_manage_backups_to_full_roles/migration.sql` —
  new, hand-written (no schema change, so no `migrate diff` output to start from). Backfills
  `action.manage_backups` onto any live role that already holds all 64 other permissions.
- `erp/tests/backup-permission-backfill.test.ts` — new. Parses the 64-permission list straight
  out of the migration's own SQL text (never re-typed) and executes that same SQL text via
  `prisma.$executeRawUnsafe(SQL)` against hand-built fixture roles.

## grep -c count

```
$ grep -c "^    ('" erp/prisma/migrations/20260816120000_grant_manage_backups_to_full_roles/migration.sql
64
```

Matches the expected 64 (13 areas × 4 CRUD + 12 special actions, i.e. all 13 `SPECIAL_ACTIONS`
in `src/lib/permission-constants.ts` except `manage_backups` itself).

## Container verification (Steps 5–6)

### Alpine base check

```
$ docker run --rm node:26-alpine cat /etc/alpine-release
3.24.1
```

### apk add postgresql18-client (fresh install, shown outside the cached build layer)

```
$ docker run --rm node:26-alpine sh -c "apk add --no-cache postgresql18-client"
(1/8) Installing postgresql-common (1.3-r0)
  Executing postgresql-common-1.3-r0.pre-install
(2/8) Installing lz4-libs (1.10.0-r1)
(3/8) Installing libpq (18.6-r0)
(4/8) Installing ncurses-terminfo-base (6.6_p20260516-r0)
(5/8) Installing libncursesw (6.6_p20260516-r0)
(6/8) Installing readline (8.3.3-r1)
(7/8) Installing zstd-libs (1.5.7-r2)
(8/8) Installing postgresql18-client (18.6-r0)
Executing busybox-1.37.0-r31.trigger
Executing postgresql-common-1.3-r0.trigger
* Setting postgresql18 as the default version
* find: /usr/share/man: No such file or directory
* WARNING: opening from cache https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/APKINDEX.tar.gz: No such file or directory
* WARNING: opening from cache https://dl-cdn.alpinelinux.org/alpine/v3.24/community/x86_64/APKINDEX.tar.gz: No such file or directory
OK: 16.0 MiB in 26 packages
```

### Image build (`docker build --target run -t heatsynq-8c-check .`)

Build succeeded (multi-stage: deps → build → run). Relevant tail:

```
#13 [run 3/9] RUN apk add --no-cache postgresql18-client
#13 CACHED
#14 [run 4/9] COPY --from=build /app/.next/standalone ./
#14 DONE 0.4s
...
#20 exporting to image
#20 naming to docker.io/library/heatsynq-8c-check:latest done
#20 unpacking to docker.io/library/heatsynq-8c-check:latest done
#20 DONE 20.8s
```

### Version checks — both report 18.x

```
$ docker run --rm heatsynq-8c-check pg_dump --version
pg_dump (PostgreSQL) 18.6

$ docker run --rm heatsynq-8c-check pg_restore --version
pg_restore (PostgreSQL) 18.6
```

Matches `docker-compose.yml`'s `postgres:18` server exactly (18.6 client against an 18.x
server — pg_dump never refuses a same-or-older-major server).

### End-to-end success run

```
$ rm -rf /tmp/8c-backups && mkdir -p /tmp/8c-backups && chmod 777 /tmp/8c-backups
$ docker compose up -d --wait db
 Container erp-db-1  Running
 Container erp-db-1  Waiting
 Container erp-db-1  Healthy

$ docker run --rm --network host \
    -e DATABASE_URL="postgresql://erp:erp_local_dev@127.0.0.1:5432/erp" \
    -e BACKUP_DIR=/backups -v /tmp/8c-backups:/backups \
    -v "$PWD/scripts/backup.sh:/backup.sh:ro" postgres:18 sh /backup.sh
backup complete: erp_2026-08-16_103203.sql.gz

$ ls -la /tmp/8c-backups
total 32
drwxrwxrwx.  2 cojoa13 cojoa13    80 Aug 16 05:32 .
drwxrwxrwt. 53 root    root     6280 Aug 16 05:32 ..
-rw-r--r--.  1 root    root       96 Aug 16 05:32 backup-status.json
-rw-r--r--.  1 root    root    25989 Aug 16 05:32 erp_2026-08-16_103203.sql.gz

$ cat /tmp/8c-backups/backup-status.json
{
  "lastRunAt": "2026-08-16T10:32:03Z",
  "ok": true,
  "source": "nightly",
  "error": null
}

$ gzip -t /tmp/8c-backups/erp_*.sql.gz && echo "integrity OK"
integrity OK
```

One archive, `"ok": true`, no leftover `.tmp`, gzip integrity check passes. No `permission
denied` was hit on the plain `/tmp` bind mount, so no `:z` SELinux label was needed for this
verification run (`/tmp` is not part of the labeled repo tree the CLAUDE.md note targets — the
real `./backups` mount under the repo may still need `:z` on this host; noted for the runbook).

### Forced-failure run (bad credentials)

```
$ docker run --rm --network host \
    -e DATABASE_URL="postgresql://erp:wrong@127.0.0.1:5432/erp" \
    -e BACKUP_DIR=/backups -v /tmp/8c-backups:/backups \
    -v "$PWD/scripts/backup.sh:/backup.sh:ro" postgres:18 sh /backup.sh || true
pg_dump: error: connection to server at "127.0.0.1", port 5432 failed: FATAL:  password authentication failed for user "erp"
backup FAILED: pg_dump error

$ cat /tmp/8c-backups/backup-status.json
{
  "lastRunAt": "2026-08-16T10:32:09Z",
  "ok": false,
  "source": "nightly",
  "error": "pg_dump error"
}

$ ls -la /tmp/8c-backups
total 32
drwxrwxrwx.  2 cojoa13 cojoa13    80 Aug 16 05:32 .
drwxrwxrwt. 53 root    root     6280 Aug 16 05:32 ..
-rw-r--r--.  1 root    root      108 Aug 16 05:32 backup-status.json
-rw-r--r--.  1 root    root    25989 Aug 16 05:32 erp_2026-08-16_103203.sql.gz
```

Status flips to `"ok": false` with a non-null error, and the previous good archive
(`erp_2026-08-16_103203.sql.gz`) is untouched — file size and name are identical to the success
run. The failure path never deletes a working backup.

## Migration applied to both databases, client regenerated

```
$ npx prisma migrate deploy          # dev (erp)
Applying migration `20260816120000_grant_manage_backups_to_full_roles`
All migrations have been successfully applied.

$ DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
Applying migration `20260816120000_grant_manage_backups_to_full_roles`
All migrations have been successfully applied.

$ npx prisma generate
✔ Generated Prisma Client (7.9.1) to ./prisma/generated/prisma in 245ms

$ npx prisma migrate status          # dev (erp)
38 migrations found in prisma/migrations
Database schema is up to date!

$ DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate status
38 migrations found in prisma/migrations
Database schema is up to date!
```

## The two judgment calls

### 1. How the backfill test drives the migration's own SQL

The test (`tests/backup-permission-backfill.test.ts`) reads
`prisma/migrations/20260816120000_grant_manage_backups_to_full_roles/migration.sql` as a raw
string once at module load, then:

- **Parses the 64-permission list straight out of that SQL text** with
  `[...SQL.matchAll(/\('([a-z._]+)'\)/g)]` rather than re-typing the 64 strings a second time in
  the test file. The pattern is safe against false matches in this specific file — the only
  `('...')`-shaped literals anywhere in the migration are the 64 VALUES rows; the INSERT target,
  the `ON CONFLICT` clause, and the `'action.manage_backups'` literal being inserted are all
  quoted without the wrapping parens. A first test (`"lists exactly the 64 permissions..."`)
  pins the parse itself (length 64, no duplicates, `manage_backups` absent) so a future edit to
  the SQL that broke the regex's assumption would fail loudly there rather than silently
  degrading the other four tests to "0 required permissions."
- **Executes that exact SQL text** via `prisma.$executeRawUnsafe(SQL)` against fixture roles
  built with `prisma.role.create` (mirroring the `Role`/`RolePermission` shape other tests in the
  suite already use, e.g. `admin-routes.test.ts`), rather than reimplementing the "holds all 64
  others" predicate in TypeScript and asserting against that. This was the brief's own
  requirement: a paraphrase would pass even if the shipped SQL had a bug, and a migration only
  runs once for real. Concretely, the test builds a role with all 64 parsed permissions, runs the
  raw SQL, and asserts `action.manage_backups` now exists on it (and symmetric roles for
  "missing one," "missing all," "already applied twice," and "soft-deleted role" to pin every
  clause of the `WHERE` — including `r."deletedAt" IS NULL`, which the brief's four minimum cases
  didn't explicitly ask for but which is part of the same predicate and cheap to cover).

This is the same shape `tests/template-seed.test.ts` already uses for the standard-template seed
migration (parse the file, don't re-implement it), so it is a repeated pattern in this codebase,
not a one-off choice.

### 2. `write_status`'s sh string handling

Looked at it critically per the brief. In the *shipped* script, every message passed to
`write_status` is a static, compile-time-known literal (`"pg_dump error"`,
`"pg_dump produced an empty dump"`, `"the written archive failed its gzip integrity check"`) —
none of them interpolate `pg_dump`'s actual stderr text today, so none of them can currently
contain a quote, backslash, newline, or `%`. The concrete failure mode the brief describes (a
dynamic message breaking the JSON) is not reachable with today's call sites.

That said, `write_status` is a small reusable helper, not a call-site-specific one-liner. I made
one robustness improvement to it, staying in POSIX `sh`:

- Changed `echo "$2"` to `printf '%s' "$2"` before sanitizing. POSIX `echo`'s handling of
  backslash sequences in its argument is implementation-defined (`dash`'s builtin `echo`
  interprets `\n`, `\t`, etc. by default; other shells' `echo` do not), so piping a future dynamic
  message through `echo` could silently reinterpret escape sequences inside it before the
  `tr -d '"\\'` ever sees them. `printf '%s'` has no such ambiguity — the argument is copied
  byte-for-byte.
- Added `tr '\n\r\t' '   '` to the existing `tr -d '"\\'` sanitization pass, folding newline,
  carriage return, and tab to a plain space. This is the load-bearing part: JSON strings cannot
  carry a raw (unescaped) control character, so a message with an embedded newline — the exact
  scenario the brief calls out — would previously have produced a status file whose JSON is
  syntactically invalid. A reader (`parseStatus`) rejecting that file reads as "no readable status
  file," i.e. red, which silently discards the real reason. Folding the whitespace controls to
  spaces keeps the file valid JSON on one line no matter what a future dynamic message contains.
- Moved the "is this empty?" check (`[ -n ... ]`) to run **after** sanitization rather than before,
  so a message that sanitizes down to nothing (e.g. a lone `"` character) correctly renders as
  JSON `null` rather than an empty-but-present string `""`.

**Explicit limitation, stated rather than silently left**: this is still lossy, not a full JSON
escaper. `tr -d '"\\'` *deletes* quotes and backslashes rather than escaping them
(`\"`/`\\`), so a dynamic message containing either loses that content rather than round-tripping
it exactly — the brief's own words ("safe but lossy") already accepted this trade for the
literal script it specified, and I kept that trade rather than trying to hand-write a full
character-class escaper in POSIX `sh` (a per-byte loop over `$2` in pure `sh`/`tr`/`sed` to escape
arbitrary control bytes 0x00–0x1F is fragile across `dash` vs BusyBox `sh` and slow for what is a
once-a-night, small-string operation). Given every call site today passes a fixed, safe literal,
I judged "guarantee valid JSON, accept lossy content" as the right stopping point rather than
reaching for a heavier general-purpose escaper that isn't exercised by any current caller.

## Gate commands — real output

```
$ cd erp && npx vitest run tests/backup-permission-backfill.test.ts tests/permissions-sweep.test.ts

 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp

 ✓ tests/permissions-sweep.test.ts (6 tests) 16ms
 ✓ tests/backup-permission-backfill.test.ts (6 tests) 454ms

 Test Files  2 passed (2)
      Tests  12 passed (12)
   Start at  05:33:44
   Duration  820ms (transform 112ms, setup 12ms, collect 169ms, tests 471ms, environment 0ms, prepare 47ms)

$ npx tsc --noEmit
(no output — clean)

$ npx eslint src tests
(no output — clean)
```

## Commit

```
$ git add erp/Dockerfile erp/docker-compose.yml erp/scripts/backup.sh erp/.env.example \
          erp/prisma/migrations/20260816120000_grant_manage_backups_to_full_roles/ \
          erp/tests/backup-permission-backfill.test.ts
$ git commit -m "feat(backups): wire BACKUP_DIR through deploy and backfill manage_backups"
```

Commit SHA: **75124d8**

---

## Fix round 1 (review response)

Coordinator review verdict: **Spec ❌ / Needs fixes — one Important finding**, plus a Minor
worth doing while in the file. Both addressed below; three items were explicitly marked "do NOT
fix" by the coordinator (recorded for whole-branch triage, not touched here): unreachable control
chars in `write_status` beyond `\n\r\t`, a failing retention `find` skipping `write_status true`
(fails toward red, the safe direction), and the practice copy showing a permanent red bar to a
trainer holding `manage_backups`.

### Finding #1 (Important, REQUIRED) — unguarded `gzip` compress step

`scripts/backup.sh`'s compress line ran with no exit-status check:

```sh
gzip < "$TMP" > "$DIR/erp_${STAMP}.sql.gz"
rm -f "$TMP"
```

Under `set -e`, a failing `gzip` (reviewer's repro: a stub returning "No space left on device")
aborted the script **before `write_status` ever ran**, so a disk-full night left the *previous*
night's `{"ok":true}` in place — `evaluateHealth` then reads green for up to
`backup_stale_hours` (36h) after the archetypal backup failure. This inverts §6.2's "absence is
failure" in exactly the direction that matters (silently green, not silently red).

Fixed to match the guard shape every other step in the script already uses:

```sh
if ! gzip < "$TMP" > "$DIR/erp_${STAMP}.sql.gz"; then
  rm -f "$TMP" "$DIR/erp_${STAMP}.sql.gz"
  write_status false "could not compress the dump"
  echo "backup FAILED: compress error" >&2
  exit 1
fi
rm -f "$TMP"
```

Removes both the temp file and the partial `.gz` — a truncated archive at a real archive name is
debris nothing else cleans up (`gzip -t` would reject it, but only if someone thinks to run that
check).

**New regression test — `erp/tests/backup-script.test.ts`.** The brief's own escape hatch
("if a test would be more contrivance than value, say so") turned out not to be needed: this
codebase already has the exact precedent this fix needed. `tests/backup-run.test.ts` stubs
`pg_dump` via `tests/fixtures/fake-pg-dump.sh` and a `dumpBin` override to test the *other*
(TypeScript, on-demand) backup path without touching a real database. `scripts/backup.sh` has no
such override — it resolves `pg_dump` and `gzip` by bare name off `PATH` — so the equivalent lever
for a shell script is a doctored `PATH`. The new test:

- Runs the **real** `scripts/backup.sh` as a child process (`spawnSync("sh", [SCRIPT], ...)`), not
  a paraphrase of its guard structure.
- Prepends a temp bin directory to `PATH` containing `pg_dump` (a copy of the existing
  `fake-pg-dump.sh` fixture, left in its default "ok" mode — this suite only exercises the
  compress step) and, for the failure tests, a `gzip` stub that always exits 1 with "No space left
  on device" — the reviewer's exact repro.
- Asserts: exit code non-zero; `backup-status.json` has `ok:false` and an error mentioning
  "compress"; no leftover `.sql.tmp` or truncated `.sql.gz`; and — the property the reviewer
  called out by name — a **pre-seeded "previous good archive" file survives byte-for-byte** and is
  the only `.sql.gz` left after the failed run.
- A fourth "control" test runs the same invocation with **no** `gzip` override (falls through to
  the real system `gzip`, the same reliance `backups.ts`'s own suite already has on a real
  `gzip -t`) and asserts full success, proving the failure assertions above are actually driven by
  the stub, not some artifact of the doctored `PATH`.

**Verified the test catches the actual regression**, not just the fixed code: temporarily
reverted `scripts/backup.sh`'s compress step to the unguarded pre-fix form and reran
`tests/backup-script.test.ts` — 2 of 3 tests failed (the third, the no-override control, still
passed as expected):

```
$ npx vitest run tests/backup-script.test.ts   # against the UNGUARDED script, temporarily restored
 FAIL  ... a failing gzip is caught: ...
 Error: ENOENT: no such file or directory, open '.../backup-status.json'
 FAIL  ... a pre-existing good archive survives a failed gzip run ...
 AssertionError: expected [ Array(2) ] to deeply equal [ 'erp_2020-01-01_000000.sql.gz' ]
 Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)
```

The "no status file at all" failure mode there is actually worse than the reviewer's stale-green
repro (this fixture had no pre-existing status file to leave stale) — same root cause, same class
of silent failure. Restored the fix and reran — all green (see below).

**Re-verified end to end in a real `postgres:18` container** (as originally, plus a third run
that stubs `gzip` inside the container itself to reproduce the reviewer's exact scenario under
real `dash`, not just under vitest's Node child-process spawn):

```
$ rm -rf /tmp/8c-backups-v2 && mkdir -p /tmp/8c-backups-v2 && chmod 777 /tmp/8c-backups-v2
$ docker compose up -d --wait db
 Container erp-db-1  Healthy

# --- success run ---
$ docker run --rm --network host \
    -e DATABASE_URL="postgresql://erp:erp_local_dev@127.0.0.1:5432/erp" \
    -e BACKUP_DIR=/backups -v /tmp/8c-backups-v2:/backups \
    -v "$PWD/scripts/backup.sh:/backup.sh:ro" postgres:18 sh /backup.sh
backup complete: erp_2026-08-16_104847.sql.gz
$ cat /tmp/8c-backups-v2/backup-status.json
{"lastRunAt": "2026-08-16T10:48:47Z", "ok": true, "source": "nightly", "error": null}
$ gzip -t /tmp/8c-backups-v2/erp_*.sql.gz && echo "integrity OK"
integrity OK

# --- forced-failure run (bad credentials, as in the original verification) ---
$ docker run --rm --network host \
    -e DATABASE_URL="postgresql://erp:wrong@127.0.0.1:5432/erp" \
    -e BACKUP_DIR=/backups -v /tmp/8c-backups-v2:/backups \
    -v "$PWD/scripts/backup.sh:/backup.sh:ro" postgres:18 sh /backup.sh || true
pg_dump: error: ... FATAL:  password authentication failed for user "erp"
backup FAILED: pg_dump error
$ cat /tmp/8c-backups-v2/backup-status.json
{"lastRunAt": "2026-08-16T10:48:53Z", "ok": false, "source": "nightly", "error": "pg_dump error"}
$ ls -la /tmp/8c-backups-v2
... erp_2026-08-16_104847.sql.gz   # the success run's archive, untouched

# --- forced gzip-failure run, the reviewer's own repro, under real dash inside postgres:18 ---
$ rm -rf /tmp/8c-fakebin && mkdir -p /tmp/8c-fakebin
$ printf '#!/bin/sh\necho "gzip: error: No space left on device" >&2\nexit 1\n' > /tmp/8c-fakebin/gzip
$ chmod +x /tmp/8c-fakebin/gzip
$ rm -rf /tmp/8c-backups-v3 && mkdir -p /tmp/8c-backups-v3 && chmod 777 /tmp/8c-backups-v3
$ echo "previous good archive contents" > /tmp/8c-backups-v3/erp_2020-01-01_000000.sql.gz
$ docker run --rm --network host \
    -e DATABASE_URL="postgresql://erp:erp_local_dev@127.0.0.1:5432/erp" \
    -e BACKUP_DIR=/backups \
    -e PATH="/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    -v /tmp/8c-backups-v3:/backups -v /tmp/8c-fakebin:/fakebin:ro \
    -v "$PWD/scripts/backup.sh:/backup.sh:ro" postgres:18 sh /backup.sh || true
gzip: error: No space left on device
backup FAILED: compress error
$ cat /tmp/8c-backups-v3/backup-status.json
{"lastRunAt": "2026-08-16T10:49:04Z", "ok": false, "source": "nightly", "error": "could not compress the dump"}
$ ls -la /tmp/8c-backups-v3
... backup-status.json
... erp_2020-01-01_000000.sql.gz          # the pre-seeded "previous good" archive — nothing else
$ cat /tmp/8c-backups-v3/erp_2020-01-01_000000.sql.gz
previous good archive contents           # byte-for-byte unchanged
```

Status correctly flips to `ok:false` with `"error": "could not compress the dump"`, no truncated
`.gz` or leftover `.tmp` was left in `/tmp/8c-backups-v3`, and the pre-seeded "previous good"
archive survives byte-for-byte. All scratch directories (`/tmp/8c-backups-v2`,
`/tmp/8c-backups-v3`, `/tmp/8c-fakebin`) were removed after verification.

### Finding #3 (Minor) — the drift guard could pass on a typo paired with an omission

`tests/backup-permission-backfill.test.ts`'s original "lists exactly 64" test only checked count,
uniqueness, and the absence of `action.manage_backups` — a mistyped permission string *paired
with* an omitted real one would still satisfy all three and pass, and a wrong entry only ever
**loosens** the migration's rule (the dangerous direction: a role that should have been excluded
from the backfill gets it anyway). Added a new test comparing the parsed list against the actual
source of truth:

```ts
import { ALL_PERMISSIONS } from "@/server/permissions";
...
it("is exactly ALL_PERMISSIONS minus action.manage_backups — no typo'd or substituted entry", () => {
  const expected = ALL_PERMISSIONS.filter((p) => p !== "action.manage_backups");
  expect([...REQUIRED_PERMISSIONS].sort()).toEqual([...expected].sort());
});
```

### Gate commands — real output (post-fix)

```
$ cd erp && npx vitest run tests/backup-permission-backfill.test.ts tests/permissions-sweep.test.ts

 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp

 ✓ tests/backup-permission-backfill.test.ts (7 tests) 453ms
 ✓ tests/permissions-sweep.test.ts (6 tests) 16ms

 Test Files  2 passed (2)
      Tests  13 passed (13)
   Start at  05:49:10
   Duration  810ms (transform 106ms, setup 11ms, collect 164ms, tests 469ms, environment 0ms, prepare 45ms)

$ npx tsc --noEmit
TSC_OK  (no diagnostics)

$ npx eslint src tests
ESLINT_OK  (no findings)
```

Also ran the new `tests/backup-script.test.ts` alongside the above (not part of the coordinator's
literal re-run command, since that file didn't exist for the original review, but covered here for
completeness):

```
$ npx vitest run tests/backup-script.test.ts tests/backup-permission-backfill.test.ts tests/permissions-sweep.test.ts
 ✓ tests/backup-script.test.ts (3 tests) 17ms
 ✓ tests/backup-permission-backfill.test.ts (7 tests) 439ms
 ✓ tests/permissions-sweep.test.ts (6 tests) 15ms
 Test Files  3 passed (3)
      Tests  16 passed (16)
```

### Commit (fix round 1)

```
$ git add erp/scripts/backup.sh erp/tests/backup-permission-backfill.test.ts erp/tests/backup-script.test.ts
$ git commit -m "fix(backups): guard the gzip compress step and tighten the permission drift guard"
```

Commit SHA: **8716166**

---

## Fix round 2 (owner scope decision — a superseding migration, not an in-place edit)

### What happened, in order

1. The coordinator asked me to rewrite `20260816120000_grant_manage_backups_to_full_roles`'s SQL
   **in place** to the new `admin.view` + `action.manage_users` rule, after clearing its applied
   record from both `erp` and `erp_test`'s `_prisma_migrations` tables.
2. I cleared both applied records as instructed (`DELETE FROM "_prisma_migrations" WHERE
   migration_name = '20260816120000_grant_manage_backups_to_full_roles'` against `erp` and
   `erp_test` via `docker exec erp-db-1 psql`), then attempted the edit with both the Edit and
   Write tools.
3. **Both were denied** by a repo-configured `PreToolUse` hook,
   `.claude/hooks/protect-applied-migrations.sh` (wired in `.claude/settings.json` on the
   `Edit|Write` matcher). Reading the hook's source: it is a pure path/file-existence check —
   `[[ "$f" == *"/prisma/migrations/"*"/migration.sql" && -f "$f" ]]` — with no database query at
   all, so clearing the applied-migration rows did nothing to unblock it. Its denial text ends
   with *"If this file is genuinely still being authored, ask the user to approve the edit
   manually."* That is a request for the actual project owner's sign-off, which I cannot supply as
   an agent (per my own instructions, no agent message — including a coordinator's — substitutes
   for the user's own consent when a control explicitly asks for it). I did not attempt to route
   around it via a raw `Bash` write (e.g. a heredoc), since that would defeat a guard the comment
   in the hook says exists because of a real past incident ("the P3009 failure class from Phase 3
   Task 6").
4. Instead I restored both databases to a state consistent with git HEAD — re-ran
   `npx prisma migrate deploy` against `erp` and `erp_test`, which re-applied the **still-current,
   unedited** file and recorded it as applied again — confirmed clean working tree, and reported
   the blocker back rather than guessing at a resolution.
5. The coordinator took it to the owner, as the hook asked. **The owner's decision: do not edit
   the existing migration; add a superseding one.** This is exactly the CLAUDE.md-documented,
   hook-compliant path — a brand-new `migration.sql` at a path that does not yet exist is
   explicitly allowed by the same hook (`Writing a brand-NEW migration.sql (file does not exist
   yet) stays allowed — that is the hand-written TTY-less recipe from CLAUDE.md`, per the hook's
   own comment).

This is worth having in the permanent record: **the guard did exactly what it was built for.** It
stopped an in-place edit to an applied migration, forced the decision up to an actual human, and
the resulting design (two migrations, the second a strict superset of the first) is arguably
better than the in-place edit would have been — it leaves an honest trail of *why* the rule
changed instead of silently rewriting history a `git blame` would show as one commit.

### What changed

- **`20260816120000_grant_manage_backups_to_full_roles/migration.sql` — untouched.** Same SQL,
  same directory name, same applied record on both databases (verified below). It still ships and
  still runs; it is simply narrower than the new one, not wrong.
- **New: `erp/prisma/migrations/20260816130000_grant_manage_backups_to_admin_roles/migration.sql`.**
  Implements the owner's rule: grant `action.manage_backups` to any live role
  (`"deletedAt" IS NULL`) holding both `admin.view` and `action.manage_users`, via two `EXISTS`
  subqueries against `RolePermission` (no `VALUES` list — there is nothing to enumerate for a
  two-permission predicate). Same `gen_random_uuid()::text` id pattern and the same
  `ON CONFLICT ("roleId", "permission") DO NOTHING` as the first. The comment block states the rule,
  why a second migration exists rather than an edited first, the decay argument for why the
  original predicate needed replacing (`SPECIAL_ACTIONS` has grown three times since Phase 1 —
  `override_credit_hold` in P4, `write_off` in 5B, `manage_backups` now — and only the seed ever
  backfills an existing role, so an upgraded install holds ~58 permissions and would never satisfy
  the all-64 predicate), and why running both in sequence is safe (this rule is a strict superset:
  any role holding all 64 permissions necessarily holds these two).
- **`erp/tests/backup-permission-backfill.test.ts` — extended, not replaced.** Kept every existing
  test for migration 1 (the all-64 rule, including the `ALL_PERMISSIONS` drift guard — it still
  guards that migration's list) and added a parallel suite for migration 2, driving **its own SQL
  file** via `readFileSync` + `$executeRawUnsafe`, exactly as migration 1's tests do. New coverage:
  a role with `admin.view` + `action.manage_users` and few other permissions (the case the old rule
  missed) → granted; `admin.view` alone → not; `action.manage_users` alone → not; neither → not; a
  soft-deleted role holding both → not; re-running migration 2 alone → clean no-op; and — the
  interaction the owner's superset choice makes possible — running **both** migrations in sequence
  against an all-64 role leaves exactly one `action.manage_backups` row, no duplicate, no error.

### Verifying both databases: both migrations applied, both healthy

Before applying the new migration, confirmed the first one's applied record (re-established in fix
round 1's restoration) is genuinely healthy on both databases, rather than assuming:

```
$ docker exec erp-db-1 psql -U erp -d erp -c "SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at FROM \"_prisma_migrations\" WHERE migration_name = '20260816120000_grant_manage_backups_to_full_roles';"
                  migration_name                   | finished | rolled_back_at
-----------------------------------------------------+----------+----------------
 20260816120000_grant_manage_backups_to_full_roles | t        |
(1 row)

$ docker exec erp-db-1 psql -U erp -d erp_test -c "SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at FROM \"_prisma_migrations\" WHERE migration_name = '20260816120000_grant_manage_backups_to_full_roles';"
                  migration_name                   | finished | rolled_back_at
-----------------------------------------------------+----------+----------------
 20260816120000_grant_manage_backups_to_full_roles | t        |
(1 row)
```

`finished = t`, `rolled_back_at` empty, on both. Then applied the new migration:

```
$ cd erp
$ npx prisma migrate deploy                    # dev (erp)
39 migrations found in prisma/migrations
Applying migration `20260816130000_grant_manage_backups_to_admin_roles`
All migrations have been successfully applied.

$ DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
39 migrations found in prisma/migrations
Applying migration `20260816130000_grant_manage_backups_to_admin_roles`
All migrations have been successfully applied.

$ npx prisma generate
✔ Generated Prisma Client (7.9.1) to ./prisma/generated/prisma in 234ms

$ npx prisma migrate status                    # dev (erp)
39 migrations found in prisma/migrations
Database schema is up to date!

$ DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate status
39 migrations found in prisma/migrations
Database schema is up to date!
```

Post-apply confirmation that BOTH migrations are recorded healthy on BOTH databases:

```
$ for DB in erp erp_test; do
    docker exec erp-db-1 psql -U erp -d "$DB" -c \
      "SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at
         FROM \"_prisma_migrations\"
        WHERE migration_name LIKE '2026081612%' OR migration_name LIKE '2026081613%';"
  done

=== erp ===
                   migration_name                   | finished | rolled_back_at
----------------------------------------------------+----------+----------------
 20260816120000_grant_manage_backups_to_full_roles  | t        |
 20260816130000_grant_manage_backups_to_admin_roles | t        |
(2 rows)

=== erp_test ===
                   migration_name                   | finished | rolled_back_at
----------------------------------------------------+----------+----------------
 20260816120000_grant_manage_backups_to_full_roles  | t        |
 20260816130000_grant_manage_backups_to_admin_roles | t        |
(2 rows)
```

### Gate commands — real output

```
$ cd erp && npx vitest run tests/backup-permission-backfill.test.ts tests/backup-script.test.ts tests/permissions-sweep.test.ts

 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp

 ✓ tests/backup-permission-backfill.test.ts (14 tests) 913ms
 ✓ tests/backup-script.test.ts (3 tests) 17ms
 ✓ tests/permissions-sweep.test.ts (6 tests) 16ms

 Test Files  3 passed (3)
      Tests  23 passed (23)
   Start at  08:39:58
   Duration  1.37s (transform 110ms, setup 13ms, collect 176ms, tests 945ms, environment 0ms, prepare 69ms)

$ npx tsc --noEmit
TSC_OK  (no diagnostics)

$ npx eslint src tests
ESLINT_OK  (no findings)
```

### Commit (fix round 2)

```
$ git add erp/prisma/migrations/20260816130000_grant_manage_backups_to_admin_roles/ \
          erp/tests/backup-permission-backfill.test.ts
$ git commit -m "feat(backups): add superseding migration for the admin-role manage_backups grant"
```

Commit SHA: **fe059f6**

