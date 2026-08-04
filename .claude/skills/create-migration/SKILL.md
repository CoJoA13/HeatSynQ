---
name: create-migration
description: Create a Prisma migration the HeatSynQ way — TTY-less migrate diff, hand-written SQL reviewed in full, applied to BOTH databases, client regenerated, status verified. Use whenever prisma/schema.prisma changed and a migration is needed; never run `prisma migrate dev` here (it refuses without a TTY).
---

# Create a migration (both databases, no TTY)

Takes one argument: a short snake_case migration name (e.g. `order_client_request_id`).
All commands run from `erp/`. Node 26 (`nvm use 26`) required.

## Why this exists

`npx prisma migrate dev` refuses in any non-interactive shell since Prisma 7. Every
migration in this repo since then is produced by this recipe. There is one shared test
database — skipping the second deploy leaves tests running against a stale schema, and
skipping `generate` leaves typechecking against a stale client. Editing an
already-applied migration is forbidden (a PreToolUse hook blocks it) — always create a
new one.

## Steps

1. **Confirm the schema change is saved** in `erp/prisma/schema.prisma`. Partial
   `@@unique(...)` attributes stay on ONE line (sweep limitation, HANDOFF §5.11).

2. **Generate the SQL** and read it IN FULL — never apply unreviewed SQL:

   ```bash
   npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script
   ```

   Verify it is purely additive unless the task explicitly says otherwise. Anything
   destructive (DROP, data-typed ALTER) stops here for an explicit decision.

3. **Hand-write the migration directory** using a real timestamp:

   ```bash
   mkdir -p prisma/migrations/$(date +%Y%m%d%H%M%S)_<NAME>
   ```

   Write the reviewed SQL into `migration.sql` inside it (a NEW file — the protection
   hook allows creation, blocks edits to existing ones).

4. **Apply to BOTH databases, then regenerate:**

   ```bash
   npx prisma migrate deploy
   DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
   npx prisma generate
   ```

5. **Verify:** both `migrate status` calls report no pending migrations; then
   `npx tsc --noEmit` and the covering tests.

   ```bash
   npx prisma migrate status
   DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate status
   ```

## Failure notes

- `P3009` on `erp_test` usually means test debris violates a new constraint (it happened
  in Phase 3 Task 6): inspect the offending rows, clean them deliberately, then
  `npx prisma migrate resolve --rolled-back <name>` and re-deploy. Never weaken the
  constraint to get past it.
- If the diff is empty, the schema change didn't save or is already migrated — check
  `migrate status` before assuming.
