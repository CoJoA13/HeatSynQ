# Shop ERP

Self-hosted web ERP for the heat-treat shop. Next.js + Prisma + PostgreSQL.

## Development
1. `cp .env.example .env`
2. `docker compose up -d db`
3. `npm install`
4. `npx prisma generate` — the client is gitignored, and Prisma 7's `migrate dev` no longer generates it for you
5. `npx prisma migrate deploy` (dev DB)
6. Apply migrations to the test DB:
   `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy`
7. `npm run db:seed` (creates admin/admin — change the password after first login)
8. `npm run dev` → http://localhost:3000
9. `npm test`

Changing `prisma/schema.prisma`? Use `npx prisma migrate dev` instead of step 5 to create the
migration — it needs a TTY and refuses in a non-interactive shell (see `CLAUDE.md`'s "Constraints
that will bite you" for the workaround), then run steps 4 and 6.

### Reference data
Admin → Reference data maintains GL accounts, materials, inspection codes/scales, container types,
carriers, terms, payment types, comment snippets, and specifications. Admin → Process step codes
maintains the billable step vocabulary and the fields each step kind asks for.
Every list exports to Excel and accepts spreadsheet paste.

### Customers
Customers → list, search, and open a customer. Each carries a unique code, an optional parent
(for divisions billed together), credit terms, typed addresses (ship-to / bill-to / received-from,
one default per kind), and contacts flagged for which documents they receive. The list exports to
Excel and accepts spreadsheet paste (columns: code, name, default PO, order notes).

## End-to-end tests
Six owner-reviewable UI flows, driven with the bundled Chromium against a throwaway `next dev`
on port 3100 (dev DB `erp` — fixtures it creates are cleaned up automatically, even on failure).

1. One-time: `npx playwright install chromium` (no sudo needed).
2. `npm run test:e2e` — runs all six flows headless, exits non-zero if any fails.
3. `HEADED=1 npm run test:e2e` — same, but watch it click through live.

Each flow writes numbered checkpoint screenshots and a `video.webm` to
`e2e-artifacts/<flow>/` (gitignored) for review after the run. This is separate from `npm test`
(vitest) — it needs a live dev server and isn't part of that gate.

## Production (single box on the shop network)
1. Copy `.env.example` → `.env`; set a strong `SESSION_SECRET` and change the db password
   in `docker-compose.yml` + `DATABASE_URL`s together.
2. `docker compose --profile prod up -d --build`
3. First run only: seed from a checkout with dependencies installed, not from inside the
   container. The production image is a pruned standalone build that doesn't ship `src/`
   (only `prisma/`, `.next/standalone`, `.next/static`, `public`, `prisma.config.ts`, and
   `node_modules` survive the trace), and `prisma/seed.ts` imports `../src/server/permissions`
   — that import has nothing to resolve to inside the container. (`tsx` and `dotenv` themselves
   *are* in the pruned image now, as production dependencies Prisma 7 needs at container start
   too — verified by running `npm run db:seed` inside a built image, which gets past module
   resolution for both before failing on the `src/` import above. Don't be misled by that into
   thinking seeding works in-container — it doesn't.) From a machine with network access
   to the db (e.g. the box itself, since `db` publishes 5432):
   `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp" npm run db:seed`
   (match host/credentials to whatever you set in step 1).
4. App at http://<server>/ — migrations apply automatically on start.

## Practice copy (training)
A separate training instance on its own database (`erp_practice`) + port (8080), under the
`practice` compose profile — never mixed with production. Practice-vs-production is decided by
database identity (`practiceMode()`), so a mis-set flag can't touch production.

1. **Provision `erp_practice`.** `db-init/` runs ONLY on a fresh `dbdata` volume, so an existing
   install must create the database once by hand:
   `docker compose exec db createdb -U erp erp_practice`
2. `docker compose --profile practice up -d --build` — the `app-practice` service migrates
   `erp_practice` on start and serves it at http://<server>:8080/ with a PRACTICE banner and
   watermarked documents. (Leaving out this step means the prod bring-up is unchanged.)
3. First population: seed the representative demo slice once, pointed at the practice DB —
   `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_practice" npm run db:seed:demo`
   (or run `npm run db:seed:demo` inside the `app-practice` container, whose `DATABASE_URL` already
   points there). Thereafter, "Reset practice data" on the `/practice` page re-seeds it in-app.
4. Access practice in a **separate browser profile** from production: the two use distinct session
   cookies (`erp_practice_session` vs `erp_session`), so they no longer clash on a shared host.

## Backups

The nightly `backup` container `pg_dump`s the production database into the shared backup folder and
keeps 30 days. The app mounts the **same** folder, so `/admin/backups` (which needs the
`manage_backups` action) lists the archives, shows the resolved folder, and can take an on-demand
backup. Both writers also maintain `backup-status.json`, which is what the staleness indicator reads.

- **Folder:** set by `BACKUP_DIR` (container `/backups`, host `./backups`). A deploy value shared by
  both writers — deliberately not a runtime setting, because the nightly container cannot honor a
  live change.
- **Staleness:** `backup_stale_hours` (Admin → Settings, default **36**). The indicator is green only
  when the newest integrity-passing archive is inside that window **and** the last recorded run did
  not fail **and** the status file is readable. **Anything else is red, including a missing status
  file** — if the backup container never started, that silence is the failure you need to see.
- **Practice copy:** has no backup folder, no Backups page, and its routes refuse. Its data is
  disposable; the reset re-seeds it.

### Restoring

Restore is a deliberate terminal command, never a button. **Read all five steps before starting.**
Every command below is `erp/`-relative — run the whole block from `erp/`, same as every other
command in this file — and the block assumes `bash` (for `set -euo pipefail`; paste it into a `bash`
shell, not `sh`). `set -e` means the block stops itself at the first failing command, so it cannot
walk forward into the destructive steps after step 2's safety dump fails.

```bash
set -euo pipefail

# 1. Pick the archive and verify it BEFORE you touch the live database.
ls -la backups
gzip -t backups/erp_2026-08-16_020000.sql.gz && echo "integrity OK"

# 2. Take a fresh dump of the CURRENT database first — restoring is destructive and this is your
#    only way back if the archive turns out to be the wrong one. `db` has no compose profile, so it
#    needs no --profile flag; it is always up alongside `app`. Without `set -o pipefail` a failed or
#    truncated pg_dump here would still exit 0 (gzip's own exit code masks it), so the archive is
#    verified before anything destructive happens — `gzip -t` it and require it be non-empty. The
#    dump lands inside `backups/` (already gitignored), not the repo root.
docker compose exec -T db pg_dump -U erp -d erp | gzip > "backups/before-restore-$(date +%s).sql.gz"
SAFETY_DUMP=$(ls -t backups/before-restore-*.sql.gz | head -1)
gzip -t "$SAFETY_DUMP"
test -s "$SAFETY_DUMP"
echo "safety dump verified: $SAFETY_DUMP — safe to continue"
# Do NOT continue past this point unless that line printed. If it didn't, `set -e` already stopped
# you — you do not yet have a way back if the restore below goes wrong.

# 3. Stop the app AND the nightly backup worker so nothing writes mid-restore. `docker-compose.yml`
#    runs `backup` as a `while true; do sh /backup.sh; sleep 86400; done` loop — if it fires while
#    the database is empty-then-restoring, it happily archives a partially restored database and
#    still reports `ok:true`, which is exactly the "failure that reports success" this feature
#    exists to prevent. Then drop every other connection to `erp` (a stray psql/Prisma-Studio
#    session on the published 5432 port is enough to make DROP DATABASE refuse).
docker compose --profile prod stop app backup
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U erp -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'erp' AND pid <> pg_backend_pid();"

# 4. Recreate the database empty, then restore into it. `-v ON_ERROR_STOP=1` makes psql abort at the
#    FIRST failed statement instead of its default of silently continuing past it — without it, a
#    missing extension/role/dependency mid-restore leaves a partially restored database that reads
#    as a clean run, and step 5 would start the app on top of it.
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U erp -d postgres -c 'DROP DATABASE erp;'
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U erp -d postgres -c 'CREATE DATABASE erp OWNER erp;'
gunzip -c backups/erp_2026-08-16_020000.sql.gz | docker compose exec -T db psql -v ON_ERROR_STOP=1 -U erp -d erp
echo "restore completed without error"

# 5. Bring the app AND the backup worker back — the app's start command runs `prisma migrate deploy`
#    before serving, so any migration newer than the archive applies automatically. This only runs
#    if step 4 exited 0 (see `set -e` above).
docker compose --profile prod start app backup
```

**Verify before you trust it:** sign in, open `/orders` and `/receivables`, and confirm the newest
order and the A/R total match what you expect from the archive's date. If the restore was wrong, the
step-2 dump (`backups/before-restore-<epoch>.sql.gz`) is your way back — repeat steps 3–5 with it in
place of the chosen archive.

**Keeping an archive longer than 30 days** — copy it out of the backup folder. Everything inside is
pruned at 30 days, on-demand archives included.

## Updating
`git pull && docker compose --profile prod up -d --build` — users just refresh. Migrations apply
automatically on container start, including permission backfills: an existing install picks up
`manage_backups` on whichever live role already holds `admin.view` and `action.manage_users` (or
every other permission) the moment it updates — no manual `npm run db:seed` step is needed.
