# Task 4 Report — Make the 13 unique columns unique only among live rows

## Status: DONE

## Starting state confirmed

- `previewFeatures = ["partialIndexes"]` was already present in `erp/prisma/schema.prisma`'s
  generator block (from Task 2) — confirmed by reading the file before editing.
- Working tree was clean on `prisma-7-upgrade`, 8 migrations applied on both databases, none
  pending (`npx prisma migrate status` before starting: "Database schema is up to date!" on
  both `erp` and `erp_test`).

## Deviation from the brief's literal command — reported honestly

`npx prisma migrate dev --name partial_unique_live_rows` (and even with `--create-only`)
**failed** in this environment with:

```
Error: Prisma Migrate has detected that the environment is non-interactive, which is not supported.

`prisma migrate dev` is an interactive command designed to create new migrations and evolve
the database in development.
To apply existing migrations in deployments, use prisma migrate deploy.
See https://pris.ly/d/migrate-deploy
```

This happened both with and without `CI=true` set, and with `--create-only`. Prisma 7's
`migrate dev` refuses to run at all without a TTY, even to just draft the migration file. No
prior task on this branch appears to have hit this (their migration commands are recorded but
none note this failure), so this is a new finding for the branch, not a previously-known issue.

**Workaround used**, which produces an identical end state without ever touching an
interactive prompt or the reset path:

1. `npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script`
   — a read-only diff between the live dev database and the edited schema. This is the same
   diff engine `migrate dev` uses internally to draft a migration; the command is documented
   as safe/non-interactive by design.
2. Read the diff output in full (reproduced verbatim below) and confirmed it contained only
   `DROP INDEX` / `CREATE UNIQUE INDEX ... WHERE` pairs — no column drops, no table
   drops/recreates, nothing destructive.
3. Created the migration directory by hand,
   `prisma/migrations/20260801031309_partial_unique_live_rows/migration.sql`, using the exact
   same naming convention (`YYYYMMDDHHMMSS_name`) and file layout as the eight existing
   migrations, and wrote the diff's SQL into it verbatim.
4. Applied it with `npx prisma migrate deploy` (non-interactive by design) against dev, then
   against `erp_test` — the same two commands the brief specifies for steps 3/5, just reached
   via a hand-authored migration file instead of an interactively-drafted one.

I'm flagging this because the brief's literal command did not work as written in this
sandbox, and I want the deviation visible rather than silently substituted. The resulting
migration SQL, applied to both databases, is byte-for-byte the SQL the brief predicted.

## Verbatim generated migration SQL

File: `erp/prisma/migrations/20260801031309_partial_unique_live_rows/migration.sql`

```sql
-- DropIndex
DROP INDEX "Carrier_name_key";

-- DropIndex
DROP INDEX "CommentSnippet_name_key";

-- DropIndex
DROP INDEX "ContainerType_name_key";

-- DropIndex
DROP INDEX "Customer_code_key";

-- DropIndex
DROP INDEX "GlAccount_name_key";

-- DropIndex
DROP INDEX "InspectionCode_name_key";

-- DropIndex
DROP INDEX "InspectionScale_name_key";

-- DropIndex
DROP INDEX "Material_name_key";

-- DropIndex
DROP INDEX "PaymentType_name_key";

-- DropIndex
DROP INDEX "ProcessStepCode_code_key";

-- DropIndex
DROP INDEX "Role_name_key";

-- DropIndex
DROP INDEX "Specification_name_key";

-- DropIndex
DROP INDEX "Terms_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "Carrier_name_key" ON "Carrier"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "CommentSnippet_name_key" ON "CommentSnippet"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "ContainerType_name_key" ON "ContainerType"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_code_key" ON "Customer"("code") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "GlAccount_name_key" ON "GlAccount"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "InspectionCode_name_key" ON "InspectionCode"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "InspectionScale_name_key" ON "InspectionScale"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Material_name_key" ON "Material"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentType_name_key" ON "PaymentType"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessStepCode_code_key" ON "ProcessStepCode"("code") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Specification_name_key" ON "Specification"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Terms_name_key" ON "Terms"("name") WHERE ("deletedAt" IS NULL);
```

Exactly 13 `DROP INDEX` / `CREATE UNIQUE INDEX ... WHERE ("deletedAt" IS NULL)` pairs (26
statements), one per column in the brief's table. No column drops, no table drops or
recreations, no data-affecting statements of any kind.

**I read this SQL in full before applying it** — both as the `migrate diff --script` output
(before writing the file) and again from the written `migration.sql` file — before running
`migrate deploy` against either database.

## `npx prisma migrate status` — both databases, after applying

Dev (`erp`):
```
9 migrations found in prisma/migrations

Database schema is up to date!
```

Test (`erp_test`, via `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test"`):
```
9 migrations found in prisma/migrations

Database schema is up to date!
```

Also spot-checked directly in Postgres (`\d "Material"` on `erp_test`):
```
Indexes:
    "Material_pkey" PRIMARY KEY, btree (id)
    "Material_name_key" UNIQUE, btree (name) WHERE "deletedAt" IS NULL
```
Confirms the partial predicate is live on the actual index, not just present in the migration
file.

## RED evidence — Step 7, before marking the test skipped

Ran the new test while it was still a plain (non-skipped) `it(...)`:

```
npx vitest run tests/reference-gl.test.ts -t "permits a deleted row and a live row"
```

Result: **1 failed**, exactly as predicted —

```
 FAIL  tests/reference-gl.test.ts > reference delegate contract > permits a deleted row and a live row to share a name, but not two live rows
AssertionError: expected 'cms9ssbxv0000izijqi79r8oc' not to be 'cms9ssbxv0000izijqi79r8oc' // Object.is equality
 ❯ tests/reference-gl.test.ts:164:27
    162|     // A live row may now take that name — and is a genuinely new row.
    163|     const second = await createReference("material", { name: "4140" });
    164|     expect(second.id).not.toBe(first.id);
```

`second.id` and `first.id` are literally the same cuid — revival-on-create is still finding
and reusing the soft-deleted row, which is exactly the intermediate state the brief describes
as proof the test is real (it fails for the *right* reason: revival, not a broken index). The
partial index itself is doing its job — the create did *not* 400 with a duplicate error, which
it would have under the old plain `@unique`.

After capturing this, the test was changed to `it.skip(...)` with the comment `// Revival-on-
create is still in place until Task 7 removes it — un-skip there.`, body left byte-for-byte
unchanged.

## Test counts (Step 8 — all four gates)

```
npm test            → Test Files  30 passed (30) / Tests  255 passed | 1 skipped (256)
npx tsc --noEmit     → clean, no output
npx eslint src tests → clean, no output
npm run build        → "✓ Compiled successfully", 25 routes generated, no errors
```

Matches the brief's expectation of 255 passing, 1 skipped, output pristine.

## Files changed

- `erp/prisma/schema.prisma` — 13 models converted from field-level `@unique` to block-level
  `@@unique([...], where: raw("\"deletedAt\" IS NULL"))`: `Role.name`, `GlAccount.name`,
  `Material.name`, `InspectionScale.name`, `InspectionCode.name`, `ContainerType.name`,
  `Carrier.name`, `Terms.name`, `PaymentType.name`, `CommentSnippet.name`,
  `Specification.name`, `ProcessStepCode.code`, `Customer.code`. Ran through `npx prisma
  format` afterward for column alignment only — no semantic changes from formatting.
- `erp/prisma/migrations/20260801031309_partial_unique_live_rows/migration.sql` — new,
  hand-authored from `prisma migrate diff` output (see deviation note above).
- `erp/tests/reference-gl.test.ts` — added the one new (now skipped) test to the `reference
  delegate contract` describe block, right after the existing cross-kind `it.each` round-trip
  test (that describe already owns `truncateAll()` in its `beforeEach` and already imports
  `prisma`, matching the brief's note that no new import is needed).

Untouched, as required: `src/server/**`, `prisma/seed.ts`, `Dockerfile`, `package.json`,
`prisma/migrations/migration_lock.toml` (still `provider = "postgresql"`, unedited).

## Self-review findings

- Diffed `prisma/schema.prisma` line by line against the pre-edit version: every one of the 13
  columns lost its field-level `@unique` and gained the matching block-level `@@unique(...,
  where: raw(...))`; every existing `@@index` survived (`Customer.@@index([name])`,
  `CustomerAddress.@@index([customerId, kind])`, `CustomerContact.@@index([customerId])`);
  both `Customer` `Decimal` precision comments (`Decimal(12, 2)` / `Decimal(6, 4)`) are intact
  verbatim; the `GlAccount.name` inline comment (`// the account number, e.g. "4010"`) survived
  `prisma format`'s realignment, just moved to sit after the bare `String` type instead of
  after `@unique`.
- Confirmed the four explicitly-excluded constraints were **not** touched: `User.username`
  still a plain `@unique`; `Session.tokenHash` still a plain `@unique`;
  `RolePermission.@@unique([roleId, permission])`,
  `UserPermissionOverride.@@unique([userId, permission])`, and
  `ProcessStepFieldDef.@@unique([codeId, label])` all unchanged.
- Confirmed via `git status --porcelain` that only the three intended paths are staged/changed;
  `prisma/generated/prisma` (the regenerated client) is gitignored and did not appear in the
  diff.
- Verified `npx prisma generate` was run once after `migrate deploy` on dev, so the generated
  client matches the new schema for the subsequent test run.
- Re-ran `npx prisma migrate status` against both databases one more time after the commit —
  both report "Database schema is up to date!", confirming the migration is recorded and not
  merely applied ad hoc.

## Concerns

- **Environment gap, not a schema/data concern**: `prisma migrate dev` cannot run at all in
  this non-interactive shell (confirmed with and without `CI=true`, and with
  `--create-only`), which is a change in tooling behavior from what the brief assumed. I used
  `prisma migrate diff --script` + a hand-written migration file + `migrate deploy` instead,
  which is a supported, documented Prisma pattern for exactly this situation ("generate a
  migration for a hotfix already applied on production" is even the tool's own example in
  `--help`). The resulting SQL is identical to what the brief predicted verbatim, and both
  databases show a clean, in-sync migration history — but future tasks on this branch that
  also need `migrate dev` should expect the same non-interactive refusal and use the same
  workaround (or run outside this sandboxed shell if a real TTY is available there).
- No other concerns. No service code, no revival logic, and no existing test were touched;
  the one new test is skipped exactly as instructed, with its RED failure captured for the
  record above.
