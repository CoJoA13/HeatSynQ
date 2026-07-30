# Shop ERP

Self-hosted web ERP for the heat-treat shop. Next.js + Prisma + PostgreSQL.

## Development
1. `cp .env.example .env`
2. `docker compose up -d db`
3. `npm install && npx prisma migrate dev`
4. Apply migrations to the test DB:
   `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy`
5. `npm run db:seed` (creates admin/admin — change the password after first login)
6. `npm run dev` → http://localhost:3000
7. `npm test`

## Production (single box on the shop network)
1. Copy `.env.example` → `.env`; set a strong `SESSION_SECRET` and change the db password
   in `docker-compose.yml` + `DATABASE_URL`s together.
2. `docker compose --profile prod up -d --build`
3. First run only: seed from a checkout with dependencies installed, not from inside the
   container — the production image is a pruned standalone build and doesn't carry `tsx`
   or other dev tooling needed to run `prisma/seed.ts`. From a machine with network access
   to the db (e.g. the box itself, since `db` publishes 5432):
   `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp" npm run db:seed`
   (match host/credentials to whatever you set in step 1).
4. App at http://<server>/ — migrations apply automatically on start.

## Backups
- Nightly `pg_dump` gzip into `./backups/`, 30 days kept (backup container).
- Restore: `gunzip -c backups/erp_<stamp>.sql.gz | docker compose exec -T db psql -U erp -d erp`

## Updating
`git pull && docker compose --profile prod up -d --build` — users just refresh.
