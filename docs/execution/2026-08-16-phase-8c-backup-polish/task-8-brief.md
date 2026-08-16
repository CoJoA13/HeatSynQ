### Task 8: Deploy wiring — image, compose, the nightly script, and the permission backfill

**Files:**
- Modify: `erp/Dockerfile`
- Modify: `erp/docker-compose.yml`
- Modify: `erp/scripts/backup.sh`
- Modify: `erp/.env.example`
- Create: `erp/prisma/migrations/20260816120000_grant_manage_backups_to_full_roles/migration.sql`
- Create: `erp/tests/backup-permission-backfill.test.ts`

> **Why this task grew a migration** (owner decision, 2026-08-16). Without it, upgrading an **existing**
> install to 8C leaves **no role holding `action.manage_backups`** — the nav entry is hidden and every
> route 403s, so the feature looks like it never shipped. The documented upgrade path
> (`git pull && docker compose --profile prod up -d --build`) runs the container's `prisma migrate
> deploy` but **never the seed**, and `prisma/seed.ts` is the only thing that grants `ALL_PERMISSIONS`.
> The owner chose the backfill that **preserves an existing invariant rather than granting a new
> power**: a role that already held *every other* permission keeps holding everything. Roles with
> partial grants are untouched, so no limited user silently gains a dangerous action.

**Interfaces:**
- Consumes: `BACKUP_DIR`, `BACKUP_STATUS_FILENAME` (Task 1).
- Produces: a `pg_dump`-capable app image; a status-file-writing nightly script.

- [ ] **Step 1: Add the postgres client to the app image**

In `erp/Dockerfile`, in the `run` stage, directly after `ENV NODE_ENV=production`:

```dockerfile
# Phase 8C §6.1: "Back up now" runs pg_dump inside the app container, so the run image needs the
# client tools. The MAJOR must match the db service's server — pg_dump hard-refuses a server newer
# than itself — so this stays version-locked to docker-compose.yml's `postgres:` image tag, the same
# rule the backup container already follows. pg_restore ships alongside it for the restore runbook.
RUN apk add --no-cache postgresql18-client
```

- [ ] **Step 2: Wire compose**

In `erp/docker-compose.yml`, `app` service — add the env and the mount:

```yaml
    environment:
      DATABASE_URL: postgresql://erp:erp_local_dev@db:5432/erp
      SESSION_SECRET: ${SESSION_SECRET:?set in .env}
      # Phase 8C §6.4: the SAME folder the backup container writes to, so the app can list archives
      # and write on-demand ones. A deploy value, deliberately not a runtime Setting — the nightly
      # container cannot honor a live change, and a setting the writer ignores is half a feature.
      BACKUP_DIR: /backups
    volumes:
      - ./backups:/backups
```

`backup` service — add the env (the script now reads it):

```yaml
    environment:
      DATABASE_URL: postgresql://erp:erp_local_dev@db:5432/erp
      BACKUP_DIR: /backups
```

**`app-practice` gets NEITHER** — add this comment there so nobody "fixes" the asymmetry:

```yaml
      # Phase 8C §6.3: NO BACKUP_DIR and NO ./backups mount, deliberately. The practice copy's data
      # is disposable (the reset re-seeds it) so it has no backup responsibility, and a trainer's
      # "Back up now" must never pollute production's archive list or staleness signal. The routes
      # also refuse it via assertNotPracticeDatabase — this is the belt to that pair of braces.
```

> **SELinux (Fedora):** if the app or backup container hits `permission denied` on `./backups`,
> append `:z` to the bind mount — CLAUDE.md's environment note. Do not disable SELinux.

- [ ] **Step 3: Teach the nightly script the status file**

Rewrite `erp/scripts/backup.sh`:

```sh
#!/bin/sh
# Nightly pg_dump; keeps 30 days of compressed backups.
# Dump to a temp file first and verify pg_dump's own exit status —
# piping straight into gzip would mask a failed dump as "complete".
#
# Phase 8C §6.4: also writes a tiny status file the app reads for its staleness indicator. The file
# carries the LAST RUN only — the app derives `lastSuccessAt` from the newest integrity-passing
# archive, which is precisely what lets this be a single overwrite with no JSON read-merge. Written
# temp-then-rename so a reader never sees a half-written file.
set -e
DIR="${BACKUP_DIR:-/backups}"
STATUS="$DIR/backup-status.json"

write_status() {   # $1 = true|false, $2 = error message (may be empty)
  tmp="$STATUS.$$.tmp"
  printf '{\n  "lastRunAt": "%s",\n  "ok": %s,\n  "source": "nightly",\n  "error": %s\n}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" \
    "$([ -n "$2" ] && printf '"%s"' "$(echo "$2" | tr -d '"\\')" || echo null)" > "$tmp"
  mv "$tmp" "$STATUS"
}

STAMP=$(date +%Y-%m-%d_%H%M%S)
TMP="$DIR/.erp_${STAMP}.sql.tmp"
if ! pg_dump "$DATABASE_URL" > "$TMP"; then
  rm -f "$TMP"
  write_status false "pg_dump error"
  echo "backup FAILED: pg_dump error" >&2
  exit 1
fi
# Fail loud on an empty dump: pg_dump can exit zero having written nothing, and an empty archive
# that looks like a backup is worse than no archive at all.
if [ ! -s "$TMP" ]; then
  rm -f "$TMP"
  write_status false "pg_dump produced an empty dump"
  echo "backup FAILED: empty dump" >&2
  exit 1
fi
gzip < "$TMP" > "$DIR/erp_${STAMP}.sql.gz"
rm -f "$TMP"
if ! gzip -t "$DIR/erp_${STAMP}.sql.gz"; then
  rm -f "$DIR/erp_${STAMP}.sql.gz"
  write_status false "the written archive failed its gzip integrity check"
  echo "backup FAILED: integrity check" >&2
  exit 1
fi
# Retention (a deploy value, not a setting). The pattern covers BOTH writers' archives — on-demand
# names also start `erp_` — which is the owner's one-retention-rule decision (§6.4).
find "$DIR" -name 'erp_*.sql.gz' -mtime +30 -delete
# Orphaned temps from a crashed dump would otherwise accumulate forever.
find "$DIR" -name '.erp_*.sql.tmp' -mtime +1 -delete
write_status true ""
echo "backup complete: erp_${STAMP}.sql.gz"
```

- [ ] **Step 4: Document the env**

Append to `erp/.env.example`:

```bash

# Phase 8C: the folder the nightly backup container writes to and the app lists / backs up into.
# A DEPLOY value shared by both writers, not a runtime setting. In docker compose this is the
# container path /backups (host side: the ./backups bind-mount). For a LOCAL dev run, point it at a
# real folder you have created — /backups does not exist on a dev host:
#   mkdir -p backups
BACKUP_DIR="./backups"
```

- [ ] **Step 5: Prove the image actually gets pg_dump**

```bash
cd erp && docker build --target run -t heatsynq-8c-check . \
  && docker run --rm heatsynq-8c-check pg_dump --version \
  && docker run --rm heatsynq-8c-check pg_restore --version
```

Expected: both print **18.x**. If the tag `postgresql18-client` is not found, the base image's Alpine
release has moved — check `docker run --rm node:26-alpine cat /etc/alpine-release` and pick the
client package whose major still matches `docker-compose.yml`'s `postgres:` tag. **Do not** silently
drop to an older major: pg_dump refuses a newer server.

- [ ] **Step 6: Prove the nightly script end to end**

```bash
cd erp && mkdir -p /tmp/8c-backups && docker compose up -d --wait db
docker run --rm --network host \
  -e DATABASE_URL="postgresql://erp:erp_local_dev@127.0.0.1:5432/erp" \
  -e BACKUP_DIR=/backups -v /tmp/8c-backups:/backups \
  -v "$PWD/scripts/backup.sh:/backup.sh:ro" postgres:18 sh /backup.sh
ls -la /tmp/8c-backups && cat /tmp/8c-backups/backup-status.json
gzip -t /tmp/8c-backups/erp_*.sql.gz && echo "integrity OK"
```

Expected: one `erp_<stamp>.sql.gz`, one `backup-status.json` reading `"ok": true`, no `.tmp` left,
and the integrity check passing. Then prove the failure path writes `"ok": false`:

```bash
docker run --rm --network host \
  -e DATABASE_URL="postgresql://erp:wrong@127.0.0.1:5432/erp" \
  -e BACKUP_DIR=/backups -v /tmp/8c-backups:/backups \
  -v "$PWD/scripts/backup.sh:/backup.sh:ro" postgres:18 sh /backup.sh || true
cat /tmp/8c-backups/backup-status.json
```

Expected: `"ok": false` with a non-null error, **and the previous good archive still present** — the
failure must not delete a working backup.

- [ ] **Step 7: Write the permission-backfill migration**

There is **no schema change**, so `prisma migrate diff` emits nothing — hand-write the directory
directly (the TTY-less workflow in CLAUDE.md, minus the diff step).

Create `erp/prisma/migrations/20260816120000_grant_manage_backups_to_full_roles/migration.sql`:

```sql
-- Phase 8C (owner decision, 2026-08-16). Backfill `action.manage_backups` onto roles that were
-- ALREADY fully privileged, so upgrading an existing install does not leave the Backups page
-- invisible and 403ing. The documented upgrade path runs `prisma migrate deploy` but never the
-- seed, and the seed is the only thing that grants ALL_PERMISSIONS.
--
-- This does NOT grant a new power to anyone: the WHERE clause fires only for a role that already
-- holds every OTHER permission in the system, so the role could already do everything else,
-- including editing roles. A role with partial grants is deliberately untouched — a limited user
-- must never silently gain a named dangerous action.
--
-- `id` is NOT NULL with NO database default: Prisma generates `cuid()` CLIENT-side, so a raw
-- INSERT has to supply one itself. `gen_random_uuid()` is core Postgres since 13 (no pgcrypto
-- extension needed); ids in this schema are opaque `text`, so a uuid sits happily beside cuids.
INSERT INTO "RolePermission" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", 'action.manage_backups'
  FROM "Role" r
 WHERE r."deletedAt" IS NULL
   AND NOT EXISTS (
         SELECT 1
           FROM (VALUES
    ('orders.view'),
    ('orders.create'),
    ('orders.edit'),
    ('orders.delete'),
    ('parts.view'),
    ('parts.create'),
    ('parts.edit'),
    ('parts.delete'),
    ('processes.view'),
    ('processes.create'),
    ('processes.edit'),
    ('processes.delete'),
    ('customers.view'),
    ('customers.create'),
    ('customers.edit'),
    ('customers.delete'),
    ('quotes.view'),
    ('quotes.create'),
    ('quotes.edit'),
    ('quotes.delete'),
    ('certs.view'),
    ('certs.create'),
    ('certs.edit'),
    ('certs.delete'),
    ('shipping.view'),
    ('shipping.create'),
    ('shipping.edit'),
    ('shipping.delete'),
    ('invoicing.view'),
    ('invoicing.create'),
    ('invoicing.edit'),
    ('invoicing.delete'),
    ('ar.view'),
    ('ar.create'),
    ('ar.edit'),
    ('ar.delete'),
    ('reports.view'),
    ('reports.create'),
    ('reports.edit'),
    ('reports.delete'),
    ('templates.view'),
    ('templates.create'),
    ('templates.edit'),
    ('templates.delete'),
    ('admin.view'),
    ('admin.create'),
    ('admin.edit'),
    ('admin.delete'),
    ('receivables.view'),
    ('receivables.create'),
    ('receivables.edit'),
    ('receivables.delete'),
    ('action.void_shipper'),
    ('action.unlock_invoice'),
    ('action.void_order'),
    ('action.change_prices'),
    ('action.edit_cert_results_after_print'),
    ('action.apply_payments'),
    ('action.run_qbo_export'),
    ('action.close_ar_period'),
    ('action.edit_templates'),
    ('action.manage_users'),
    ('action.override_credit_hold'),
    ('action.write_off')
           ) AS required(permission)
          WHERE NOT EXISTS (
                SELECT 1 FROM "RolePermission" rp
                 WHERE rp."roleId" = r."id"
                   AND rp."permission" = required.permission
              )
       )
    ON CONFLICT ("roleId", "permission") DO NOTHING;
```

That list is the **64 permissions other than `action.manage_backups`** (13 areas × 4 + 13 actions =
65 total). It was generated from `src/lib/permission-constants.ts`, not typed by hand. **Verify the
count before trusting it:**

```bash
grep -c "^    ('" erp/prisma/migrations/20260816120000_grant_manage_backups_to_full_roles/migration.sql
```
Expected: **64**.

- [ ] **Step 8: Apply the migration to BOTH databases, then regenerate**

```bash
cd erp
npx prisma migrate deploy
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
npx prisma generate
npx prisma migrate status   # and again with the erp_test DATABASE_URL
```

Both must report up to date. Skipping the second leaves the tests on a stale schema.

- [ ] **Step 9: Test the backfill**

Create `erp/tests/backup-permission-backfill.test.ts`. The migration has already run against
`erp_test`, so the test proves the **rule**, not the migration's side effect — build roles and apply
the same predicate. Cover, at minimum:

1. a role holding all 64 others **does** end up with `action.manage_backups`;
2. a role missing **exactly one** of the 64 does **not**;
3. a role with no permissions does **not**;
4. re-running is a no-op (the `ON CONFLICT` clause) — no duplicate row, no error.

Drive it by executing the migration's own SQL via `prisma.$executeRawUnsafe(readFileSync(...))` so
the test exercises the **real** statement rather than a paraphrase of it — a re-implementation here
would pass while the shipped SQL was wrong. Note that `truncateAll()` clears roles between tests, so
each case builds its own fixture.

- [ ] **Step 10: Commit**

```bash
git add erp/Dockerfile erp/docker-compose.yml erp/scripts/backup.sh erp/.env.example \
        erp/prisma/migrations/20260816120000_grant_manage_backups_to_full_roles/ \
        erp/tests/backup-permission-backfill.test.ts
git commit -m "feat(backups): wire BACKUP_DIR through deploy and backfill manage_backups"
```

---

