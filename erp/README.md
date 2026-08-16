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
- Nightly `pg_dump` gzip into `./backups/`, 30 days kept (backup container).
- Restore: `gunzip -c backups/erp_<stamp>.sql.gz | docker compose exec -T db psql -U erp -d erp`

## Updating
`git pull && docker compose --profile prod up -d --build` — users just refresh.
