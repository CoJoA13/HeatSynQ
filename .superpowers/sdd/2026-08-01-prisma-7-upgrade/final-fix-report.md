# Final fix wave — report

Branch `prisma-7-upgrade`, applied on top of `0759773`. Four commits, in order:

1. `1c92af6` — test: close two holes in the partial-unique sweep (item 1, **blocking**)
2. `acb682f` — fix: revert tsx to devDependencies (item 2)
3. `800f743` — fix: restore loud failure on an unset DATABASE_URL (item 4)
4. `d1be95a` — docs: correct stale claims and the User.username exception rationale (items 3, 5, 6)

Item 7 (Docker boot) is a verification step, not a commit — see below. No deviations from the
plan were required; nothing here turned out riskier than described.

---

## Item 1 — partial-unique sweep, both holes

### Hole (a) mutation proof

Added, temporarily, to `erp/src/server/customers.ts` (end of file):

```ts
// TEMPORARY mutation-proof for the partial-unique sweep — must be reverted before commit.
export async function __sweepProofUpdate() {
  return prisma.customer.update({ where: { code: "X" }, data: {} });
}
```

`npx vitest run tests/partial-unique-sweep.test.ts` output (verbatim):

```
 ❯ tests/partial-unique-sweep.test.ts (2 tests | 1 failed) 8ms
   × partial unique sweep > no findUnique, findUniqueOrThrow, upsert, update, or delete is keyed on a live-rows-only unique column 7ms
     → Use findFirst({ where: { <col>, deletedAt: null } }) instead — upsert on a
partially-unique column silently reuses a dead row when only a dead row exists (and throws
P2039 when both a dead and a live row exist); findUnique/findUniqueOrThrow return the
soft-deleted row; update/delete silently write to, or hard-delete, the archived row while the
live row goes untouched.: expected [ Array(1) ] to deeply equal []
   ✓ partial unique sweep > every soft-deletable model's unique columns are live-rows-only 1ms

AssertionError: ... : expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "src/server/customers.ts: .update({ where: { code … } })",
+ ]
```

Reverted the addition. `git diff --exit-code src/server/customers.ts` → exit 0 (clean).

### Hole (b) mutation proof

Added, temporarily, to `erp/prisma/schema.prisma`, inside `model Customer`:

```prisma
  @@unique([code], where: raw("\"deletedAt\" IS NULL"))
  @@unique([code, name])
  @@index([name])
```

`npx vitest run tests/partial-unique-sweep.test.ts` output (verbatim):

```
 ❯ tests/partial-unique-sweep.test.ts (2 tests | 1 failed) 8ms
   ✓ partial unique sweep > no findUnique, findUniqueOrThrow, upsert, update, or delete is keyed on a live-rows-only unique column 3ms
   × partial unique sweep > every soft-deletable model's unique columns are live-rows-only 5ms
     → These columns are @unique (or a bare @@unique([...]) block) on a
soft-deletable model. A deleted row will occupy the value forever, forcing revival-on-create
back into existence (handoff §5.18). Use @@unique([col], where: raw("\"deletedAt\" IS NULL"))
instead — for a compound block, @@unique([a, b], where: raw("\"deletedAt\" IS NULL")).: expected [ 'Customer.@@unique([code, name])' ] to deeply equal []

AssertionError: ... : expected [ 'Customer.@@unique([code, name])' ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "Customer.@@unique([code, name])",
+ ]
```

Reverted the addition. `git diff --exit-code prisma/schema.prisma` → exit 0 (clean).

Both mutations correctly name the offender; both reverts left the tree byte-identical to
before the mutation. Confirmed with `npx vitest run tests/partial-unique-sweep.test.ts` after
each revert: 2 passed / 2 tests.

### What was actually built

- `partialUniqueColumns()` now also adds the compound-key field name (`cols.join("_")`, e.g.
  `customerId_partNumber`) alongside the individual columns, so test 1 covers compound-key
  lookups against a future Phase 2C `Part` model.
- Test 1's method alternation is now `(findUnique|findUniqueOrThrow|upsert|update|delete)`,
  exactly as specified. Verified `updateMany(`/`deleteMany(` still can't match: the regex
  requires `(` immediately after the method name, and the character after "update"/"delete" in
  those two identifiers is `M`/`M`, not `(`.
- Test 2 now also flags block-level `@@unique([...])` without a `where:` argument on any
  soft-deletable model, while leaving the 13 existing correct
  `@@unique([col], where: raw(...))` blocks (and the two non-soft-deletable compound uniques,
  `RolePermission.@@unique([roleId, permission])` and
  `UserPermissionOverride.@@unique([userId, permission])`, and
  `ProcessStepFieldDef.@@unique([codeId, label])`, none of which live on a soft-deletable
  model) untouched.
- Confirmed by direct grep against `src/` and `prisma/seed.ts` that, on the pre-change tree,
  nothing keys `.update(`/`.delete(` on `name`/`code`/`username`; the only `.update(` calls
  found key on `id`, and there is no `.delete(` Prisma call anywhere in the codebase today.
  So the extended sweep is green on the current tree, as the brief predicted — no real finding
  surfaced.
- Also confirmed, by `grep -rn "connect\(OrCreate\)\?:" src/ prisma/seed.ts`, that there is no
  nested `connect`/`connectOrCreate` usage anywhere today, so leaving those out of the
  alternation (per the literal "Fix:" instruction, which lists only
  `findUnique|findUniqueOrThrow|upsert|update|delete`) costs nothing on this tree.

## Item 2 — tsx back to devDependencies

Lockfile diff stat: `erp/package-lock.json | 31 ++++++++++++++++++++++++++++++-` (31
insertions, 2 deletions — one line each in the top-level `dependencies`/`devDependencies`
blocks, plus `"dev": true` added to `tsx` and 19 `esbuild` platform-binary entries plus
`esbuild` and `fsevents` themselves). `package.json` diff is exactly two lines: `tsx` moved
from the `dependencies` block to the `devDependencies` block, same version range
(`^4.23.1`). No version numbers changed anywhere in the lockfile diff — confirmed by reading
the full diff, not just the stat.

## Item 4 — db.ts loud failure

Added:

```ts
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
```

immediately before `export const prisma = ...`, with a comment explaining the v6/v7 parity
rationale. Verified two ways:
- `npm test` still passes 258/258 (confirms `tests/helpers/setup.ts` sets `DATABASE_URL` in a
  setupFile before this module is evaluated, so the throw never fires in the suite).
- Direct check: `env -u DATABASE_URL npx tsx -e "import('./src/server/db.ts')..."` printed
  `THREW: DATABASE_URL is not set`, confirming the throw actually fires when unset.

## Items 3, 5, 6 — doc/comment corrections

- `erp/tests/partial-unique-sweep.test.ts`: verified (grep) there is no `deleteUser` in
  `erp/src/server/users.ts` and no DELETE handler in either
  `erp/src/app/api/admin/users/route.ts` or `erp/src/app/api/admin/users/[id]/route.ts` (that
  file exports only `PUT`). Rewrote the `User.username` exception comment to cite "nothing
  ever sets `User.deletedAt`" instead of "users are never hard-deleted," and added a sentence
  on what a future `deleteUser` would require.
- `erp/README.md:9`: narrowed "Prisma 7's `migrate dev`/`migrate deploy` no longer generates it
  for you" to "Prisma 7's `migrate dev` no longer generates it for you" — matches
  `CLAUDE.md`'s own wording (`npx prisma generate  # v7 no longer does this for you`, placed
  directly under the `migrate dev` step, not the `migrate deploy` step).
- Root `README.md`: status line now reads "Phase 1 (Foundation), Phase 2A (reference data) and
  Phase 2B (customers) complete and merged to `main` ... The Prisma 7 upgrade is in progress on
  a branch; Phase 2C (parts) is next." Build-phases table line 2 now reads "customers, parts,
  process steps & process step codes, reference tables" instead of "process masters." Neither
  edit restructures the file; both are targeted line replacements.

## Item 7 — Docker boot of the final tree

Pre-existing state: `erp-db-1` already running (up 42 min), `SELECT count(*) FROM "User"` = 1.

```
$ docker compose --profile prod build app
... (succeeds, "Image erp-app Built")

$ docker compose --profile prod up -d app
 Container erp-db-1 Recreate
 Container erp-db-1 Recreated
 Container erp-app-1 Creating
 Container erp-app-1 Created
 Container erp-db-1 Starting
 Container erp-db-1 Started
 Container erp-db-1 Waiting
 Container erp-db-1 Healthy
 Container erp-app-1 Starting
 Container erp-app-1 Started
```

Note: `db` was recreated (not just started) because the prod profile run picks up the compose
project fresh; this only recreates the *container*, not the `dbdata` *volume* (it's a named
volume, not a bind mount — confirmed in `docker-compose.yml`), so no data was at risk. Verified
below.

`docker compose --profile prod logs app` (verbatim):

```
app-1  | Loaded Prisma config from prisma.config.ts.
app-1  |
app-1  | Prisma schema loaded from prisma/schema.prisma.
app-1  | Datasource "db": PostgreSQL database "erp", schema "public" at "db:5432"
app-1  |
app-1  | 9 migrations found in prisma/migrations
app-1  |
app-1  |
app-1  | No pending migrations to apply.
app-1  | npm notice
app-1  | npm notice New major version of npm available! 10.9.8 -> 12.0.2
app-1  | npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.0.2
app-1  | npm notice To update run: npm install -g npm@12.0.2
app-1  | npm notice
app-1  |    ▲ Next.js 15.5.22
app-1  |    - Local:        http://f13aacc748ba:3000
app-1  |    - Network:      http://f13aacc748ba:3000
app-1  |
app-1  |  ✓ Starting...
app-1  |  ✓ Ready in 199ms
```

Exactly "9 migrations found ... No pending migrations to apply," as expected.

```
$ curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:80/login
200
```

Dependency-group verification inside the image:

```
$ docker run --rm --entrypoint sh erp-app:latest -c "ls -d node_modules/dotenv 2>/dev/null || echo 'dotenv MISSING'; ls -d node_modules/tsx 2>/dev/null || echo 'tsx absent (expected)'"
node_modules/dotenv
tsx absent (expected)
```

`dotenv` present, `tsx` absent — item 2 took effect without breaking boot.

Teardown:

```
$ docker compose --profile prod down
 Container erp-app-1 Stopping / Stopped / Removing / Removed
 Container erp-db-1 Stopping / Stopped / Removing / Removed
 Network erp_default Removing / Removed

$ docker compose up -d db
 Network erp_default Creating / Created
 Container erp-db-1 Creating / Created / Starting / Started
```

`--volumes`/`-v` was never used. Post-teardown:

```
$ docker compose ps -a
NAME       IMAGE         SERVICE   STATUS
erp-db-1   postgres:16   db        Up (healthy)

$ docker compose exec -T db psql -U erp -d erp -c 'SELECT count(*) FROM "User";'
 count
-------
     1
```

`erp-db-1` running and healthy; `User` count is 1, unchanged from the pre-boot baseline — the
owner's dev data survived.

---

## Gate results (final state, after all four commits)

- `npm test`: **258 passed (258)**, 0 skipped, 31 test files — matches the expected count; no
  new test cases were added by this wave (item 1 extends assertions inside the two existing
  tests, it doesn't add new `it()` blocks).
- `npx tsc --noEmit`: clean, no output.
- `npx eslint src tests`: clean, no output.
- `npm run build`: succeeds (standalone build produced, all routes listed).
- Re-run of these four gates happened three times over the course of the wave (after item 1,
  after item 2, after item 4, and again after items 3/5/6) — reported result above is the
  final, post-all-commits state.

## Deviations from the brief

One process deviation, self-corrected, no content impact: item 1's first pass (comment fix for
`User.username`) was initially edited in the same pass as hole (b), which would have mixed it
into the item-1 commit despite the brief saying "the sweep extension ... should stand alone."
Caught before committing further work; used `git reset --soft` (twice, both times reverting
purely local, unpushed commits made in this same session — no data loss, index/working tree
preserved throughout) to re-split the work so item 1's commit contains only the two-hole fix,
and the `User.username` comment rewording landed in the items-3/5/6 doc-corrections commit
instead. Final commit boundaries match the brief's grouping exactly:
{item 1} / {item 2} / {item 4} / {items 3, 5, 6}.

No other deviations. All seven items completed as specified; no item was skipped or found to
require stopping.
