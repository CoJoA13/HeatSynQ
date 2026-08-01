# Prisma 7 Upgrade + Removal of Revival-on-Create — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Prisma 6.19.3 → 7.9.1, then delete revival-on-create everywhere by making each soft-deleted unique column unique *only among live rows*, so a re-used code becomes a genuinely new row with its own id, its own `"create"` audit entry, and its own history.

**Architecture:** Three movements, in order. (1) Flip the package to ESM on its own, with the suite green either side, so any ESM fallout is findable. (2) Upgrade Prisma — driver adapter, generated-client path, `prisma.config.ts` — as one atomic commit, because nothing compiles halfway through. (3) Add partial unique indexes, then remove revival per service, guarded by a new sweep test. Movement 3 is where the real risk lives: the partial index does **not** make the compiler reject `findUnique({ where: { code } })`, so every conversion is a manual audit and a miss is silent.

**Tech Stack:** Next 15.5.22 · React 19.1 · Prisma 7.9.1 + `@prisma/adapter-pg` 7.9.1 · PostgreSQL 16 · Vitest 3.2 · TypeScript 5.9.3 · Node 22.23.1

## Global Constraints

- **Branch:** `prisma-7-upgrade`, cut from `main` at `2be75f2`.
- **All four gates must be green at every commit:** `npm test` (255 passing), `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`. All commands run from `erp/`.
- **Migrations apply to BOTH databases** — dev `erp` and test `erp_test` (`CLAUDE.md` → "Schema changes apply to two databases"; handoff §5.10). Skipping the second leaves tests on a stale schema.
- **Prime directive: DO NOT MAKE ASSUMPTIONS.** Where this plan says "ask the owner", stop and ask.
- **Conventional commits**, ending with the `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` line used throughout `git log`.
- **Deletion stays soft** (`deletedAt`). Hard deletes only in tests.
- **Pin exact Prisma versions** (`7.9.1`, no `^`) across `prisma`, `@prisma/client`, `@prisma/adapter-pg`. `partialIndexes` is a preview feature; a floating range could change the data-integrity constraint under the app on an unrelated `npm install`.

---

## Verified ground truth

These were confirmed empirically against a real Prisma 7.9.1 + PostgreSQL 16 spike on 2026-08-01, **not** taken from documentation. Two of them contradict handoff §5.18, which was written before the upgrade was attempted. Treat this section as authoritative over §5.18 where they disagree.

| Claim | Verified result |
|---|---|
| Partial unique index syntax | `@@unique([code], where: raw("\"deletedAt\" IS NULL"))`. §5.18 says `@@unique` takes no `where` — **it does**, and the value must be `raw(...)` or an object literal, never a bare string. |
| Preview feature | **Required.** Without `previewFeatures = ["partialIndexes"]`: `Error parsing attribute "@@unique": Partial indexes are a preview feature.` Owner approved the flag on 2026-08-01. |
| Emitted SQL | `CREATE UNIQUE INDEX "Customer_code_key" ON "Customer"("code") WHERE ("deletedAt" IS NULL);` |
| Behaviour | Duplicate code among deleted rows → **allowed**. A second *live* duplicate → **rejected, P2002** (so `db-errors.ts`'s P2002→400 mapping keeps working unchanged). |
| **`findUnique` trap** | The generated type is `Prisma.AtLeast<{...}, "id" \| "code">` — the column is **still a unique field on the client**. `findUnique({ where: { code } })` keeps compiling and **silently returns the soft-deleted row instead of the live one**. §5.18 predicted the compiler would force these conversions. It will not. This is why Task 9 exists. |
| `upsert` on such a column | **Unsafe, and the worst case is silent — corrected 2026-08-01 during Task 6.** Behaviour depends on database state, measured three ways against `Role.name`: with **only a soft-deleted row**, `upsert` *succeeds*, silently **reuses the dead row and leaves it deleted** — so `prisma/seed.ts` would attach the admin user to a dead, invisible role; with a **live row** it behaves normally; with **both a dead and a live row** it throws. An earlier entry here claimed it simply "throws P2039" — that was observed in one state and wrongly generalised. The ban on `upsert` for these columns stands and is stronger than first thought: the failure mode that matters is data corruption with no error, which no gate would surface. |
| `engine` in `prisma.config.ts` | **Removed in v7.** The existing `engine: "classic"` line must be deleted, not adapted. |
| Generated client format | **TypeScript source**, not JavaScript. `client.ts`, `models/`, `enums.ts`. |
| `tsc --noEmit` on generated client | **Passes clean** with this repo's existing tsconfig (`target: ES2017`, `moduleResolution: bundler`). No tsconfig `target` bump needed, despite the guide recommending ES2023. |
| Removed CLI flags | `--skip-generate` and `--skip-seed` gone from `migrate dev` / `db push`. `prisma migrate diff --to-schema-datamodel` is now `--to-schema`. |
| `$use` middleware / metrics | Repo uses neither (grepped). No work. |
| Mapped-enum v7.2.0 bug | Not applicable — this schema's three enums (`OverrideMode`, `StepFieldType`, `AddressKind`) carry no `@map` on their values. |
| Node / TypeScript floors | Node 22.23.1 ≥ 20.19 ✓ · TypeScript 5.9.3 ≥ 5.4 ✓ |
| **ESM blast radius** | **Zero files** (measured during Task 1, correcting this plan's own forecast). `vitest.config.ts`'s bare `__dirname` was expected to break under `"type": "module"` and does not — Vite bundles its config through esbuild and injects `__dirname`. `next build`, the 255 tests, `tsc` and `eslint` were all green on the flip alone. §4b's "most likely to break things" warning did not materialise. |

---

## File Structure

**Modified — configuration**
- `erp/package.json` — `"type": "module"`; pinned Prisma 7 deps; `@prisma/adapter-pg` added.
- `erp/prisma.config.ts` — drop `engine`, add `migrations.seed`.
- `erp/prisma/schema.prisma` — generator provider/output/preview flag; datasource loses `url`; 13 columns move from `@unique` to partial `@@unique`.
- `erp/vitest.config.ts` — bare `__dirname` is a ReferenceError under ESM. Only such site in the repo.
- `erp/.gitignore` — ignore the generated client.
- `erp/eslint.config.mjs` — ignore the generated client.

**Modified — the six `@prisma/client` import sites** (the complete set; grepped)
- `erp/src/server/db.ts` — construct with `PrismaPg` adapter.
- `erp/src/server/audit.ts`, `customers.ts`, `customer-addresses.ts`, `db-errors.ts` — import path only.
- `erp/prisma/seed.ts` — adapter + `dotenv/config` + the `role.upsert` fix.

**Modified — the four revival sites**
- `erp/src/server/customers.ts`, `roles.ts`, `reference.ts`, `process-step-codes.ts`.

**Created**
- `erp/tests/partial-unique-sweep.test.ts` — the guard for the silent `findUnique` trap.

**Generated, gitignored**
- `erp/prisma/generated/prisma/**`.

### Why the generated client lives outside `src/`

`output = "./generated/prisma"` resolves relative to `prisma/schema.prisma`, giving `erp/prisma/generated/prisma`. The six consumers import it by **relative path**, not an alias.

The tempting alternative — `src/generated/prisma`, imported as `@/generated/prisma/client` — is rejected deliberately. This repo's sweep tests (`tests/permissions-sweep.test.ts`) assert invariants over *every* `.ts` file under `src/`, and §5.14 plans another schema-walking sweep in 2C. `src/` means hand-written code here; filling it with generated output pollutes a contract other tests depend on and leaves a trap for the next sweep author. Relative imports in six files also avoid having to keep a path alias correct across four separate resolvers (Next, vitest, tsx, and `tsc`), which is the kind of four-place duplication `CLAUDE.md` already warns about for `SESSION_COOKIE`.

---

## Task 1: Flip the package to ESM

Its own commit, with the full suite green on both sides — handoff §4b's reasoning: if something unrelated breaks, this separation is what makes it findable. **No Prisma changes in this task.**

**Files:**
- Modify: `erp/package.json`
- Modify: `erp/vitest.config.ts:1-11`

**Interfaces:**
- Consumes: nothing.
- Produces: an ESM package. Every later task assumes `import`/`export` only, `import.meta.url` over `__dirname`.

- [ ] **Step 1: Confirm the starting point is green**

```bash
cd erp
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```
Expected: 255 tests pass; the other three silent. If not, stop — do not start the upgrade on a red tree.

- [ ] **Step 2: Add `"type": "module"`**

In `erp/package.json`, immediately after `"private": true,`:

```json
  "private": true,
  "type": "module",
```

- [ ] **Step 3: Run the suite to see whether it breaks**

```bash
npx vitest run tests/users.test.ts
```

**Executed 2026-08-01 — it does NOT break, and the prediction below was wrong.** This step originally predicted `ReferenceError: __dirname is not defined in ES module scope`. It does not happen: Vite bundles `vitest.config.ts` through esbuild before evaluating it and injects a `__dirname` binding, so the bare reference resolves fine even under `"type": "module"`. Verified twice — by the implementer and independently by the controller — with the pre-change config restored and `"type": "module"` in place: 11/11 passing.

So the real ESM blast radius of this repo was **zero files**, not one. Step 4 is kept anyway: deriving the alias from `import.meta.url` is correct ESM that does not depend on a bundler shim, and it matches `eslint.config.mjs`. But it is a robustness change, not a fix for a live break — do not describe it as one.

- [ ] **Step 4: Fix the one `__dirname` site**

Replace the whole of `erp/vitest.config.ts` with:

```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/helpers/setup.ts"],
    fileParallelism: false, // one shared test DB — keep files sequential
  },
  // `__dirname` does not exist in an ES module; this is the same idiom eslint.config.mjs uses.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
```

- [ ] **Step 5: Run all four gates**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```
Expected: 255 tests pass, all four green.

If `npm run build` fails here, **stop and report before changing anything else** — an ESM failure inside Next is the risk §4b flagged, and it must not get entangled with Prisma changes. `next.config.ts`, `postcss.config.mjs` and `eslint.config.mjs` were each checked and are already ESM-safe, so a failure here is something this plan did not foresee.

- [ ] **Step 6: Commit**

```bash
git add package.json vitest.config.ts
git commit -m "$(cat <<'EOF'
chore: flip the package to ESM ahead of the Prisma 7 upgrade

Prisma 7 ships as an ES module and requires "type": "module". Doing the flip
on its own, with all four gates green either side, keeps unrelated ESM fallout
separable from the Prisma changes (handoff §4b).

vitest.config.ts held the only bare __dirname in the repo; it now derives the
alias from import.meta.url, matching eslint.config.mjs.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Upgrade Prisma 6.19.3 → 7.9.1

One atomic commit — the generator change, the adapter and the six import sites are mutually dependent and nothing typechecks between them. **No schema semantics change in this task**; the 13 unique columns are still plain `@unique`, so revival-on-create still works and all 255 tests must still pass unchanged.

**Files:**
- Modify: `erp/package.json`, `erp/prisma.config.ts`, `erp/prisma/schema.prisma:1-13`, `erp/.gitignore`, `erp/eslint.config.mjs`
- Modify: `erp/src/server/db.ts` (whole file), `audit.ts:4`, `customers.ts:2`, `customer-addresses.ts:2`, `db-errors.ts:1`, `erp/prisma/seed.ts:1-5`

**Interfaces:**
- Consumes: the ESM package from Task 1.
- Produces: `prisma` exported from `src/server/db.ts` as before — same name, same shape, so no service or test changes. The `Prisma` namespace (including `Prisma.TransactionClient`, `Prisma.CustomerGetPayload`, `Prisma.PrismaClientKnownRequestError`) is re-exported from `prisma/generated/prisma/client` — all three were verified present.

- [ ] **Step 1: Install the pinned v7 packages**

```bash
cd erp
npm install --save-exact prisma@7.9.1 @prisma/client@7.9.1 @prisma/adapter-pg@7.9.1
```

Then confirm `package.json` shows exact pins with no `^`:

```bash
node -p "const p=require('./package.json');JSON.stringify({c:p.dependencies['@prisma/client'],a:p.dependencies['@prisma/adapter-pg'],cli:p.dependencies.prisma},null,1)"
```
Expected: all three exactly `7.9.1`.

> `require` still works here because this is a `node -p` one-liner, not a module in the package.

- [ ] **Step 2: Update the generator and datasource blocks**

In `erp/prisma/schema.prisma`, replace lines 1–13 (the header comments, `generator`, and `datasource`) with:

```prisma
// This is your Prisma schema file,
// learn more about it in the docs: https://pris.ly/d/prisma-schema

generator client {
  provider        = "prisma-client"
  output          = "./generated/prisma"
  // Partial (filtered) unique indexes are how a soft-deleted row stops occupying its own
  // unique value — see handoff §5.18 and the partial @@unique blocks below. Still a preview
  // feature in 7.9.1; the Prisma packages are pinned exactly so it cannot shift underneath us.
  previewFeatures = ["partialIndexes"]
}

datasource db {
  provider = "postgresql"
}
```

`url` is deliberately gone from `datasource` — v7 reads it from `prisma.config.ts`, which already declares `env("DATABASE_URL")`.

- [ ] **Step 3: Update `prisma.config.ts`**

Replace the whole of `erp/prisma.config.ts` with:

```ts
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // v7's `migrate dev` no longer auto-seeds, and `prisma.seed` in package.json is no longer
    // read. This is the only place the seed command is declared; `npx prisma db seed` uses it.
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
```

The `engine: "classic"` line is **deleted** — the `engine` property was removed in v7 and will error if left.

- [ ] **Step 4: Ignore the generated client**

Append to `erp/.gitignore`:

```gitignore

# prisma client (generated; run `npx prisma generate`)
/prisma/generated
```

And in `erp/eslint.config.mjs`, add to the existing `ignores` array:

```js
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "prisma/generated/**",
    ],
```

- [ ] **Step 5: Generate the client**

```bash
npx prisma generate
```
Expected: `✔ Generated Prisma Client (7.9.1) to ./prisma/generated/prisma`.

- [ ] **Step 6: Rewrite `src/server/db.ts` to use the driver adapter**

Replace the whole of `erp/src/server/db.ts` with:

```ts
import { PrismaClient } from "../../prisma/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// PostgreSQL requires a driver adapter in Prisma 7. The connection string is read here rather
// than from prisma.config.ts because tests rewrite process.env.DATABASE_URL in
// tests/helpers/setup.ts (a setupFile, so it runs before this module is imported) to point the
// process at erp_test — the same reason the v6 `datasources: { db: { url } }` override existed.
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

- [ ] **Step 7: Repoint the four type-only import sites**

Change the import path in each — **nothing else in these files changes**:

`erp/src/server/audit.ts:4`
```ts
import type { Prisma } from "../../prisma/generated/prisma/client";
```

`erp/src/server/customers.ts:2` and `erp/src/server/customer-addresses.ts:2`
```ts
import { Prisma } from "../../prisma/generated/prisma/client";
```

`erp/src/server/db-errors.ts:1`
```ts
import { Prisma } from "../../prisma/generated/prisma/client";
```

- [ ] **Step 8: Update the seed to use the same adapter**

In `erp/prisma/seed.ts`, replace lines 1–5 with:

```ts
import "dotenv/config";
import { PrismaClient } from "./generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
import { ALL_PERMISSIONS } from "../src/server/permissions";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
```

Leave the body alone for now — the `role.upsert({ where: { name: "Admin" } })` call still works while `Role.name` is a full unique. Task 7 fixes it at the moment it breaks.

- [ ] **Step 9: Confirm both databases are reachable and unchanged**

```bash
npx prisma migrate status
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate status
```
Expected, both: `Database schema is up to date!` — 8 migrations found, none pending. No migration has been added yet.

- [ ] **Step 10: Run all four gates**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```
Expected: **255 tests pass** — the same number as before. Behaviour is unchanged in this task; a changed count means something in the adapter swap altered semantics, and you should stop and investigate rather than adjust the tests.

- [ ] **Step 11: Verify the seed still runs**

```bash
npm run db:seed
```
Expected: completes without error (it is idempotent — upserts).

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json prisma.config.ts prisma/schema.prisma prisma/seed.ts .gitignore eslint.config.mjs src/server/db.ts src/server/audit.ts src/server/customers.ts src/server/customer-addresses.ts src/server/db-errors.ts
git commit -m "$(cat <<'EOF'
feat: upgrade Prisma 6.19.3 -> 7.9.1 with the pg driver adapter

- generator becomes prisma-client with a required output (prisma/generated,
  gitignored) and the partialIndexes preview flag §5.18 needs
- datasource loses `url`; prisma.config.ts is the single source, and its
  removed-in-v7 `engine` line is deleted while migrations.seed is added,
  because v7's `migrate dev` no longer auto-seeds
- PostgreSQL now requires a driver adapter: db.ts and seed.ts construct
  PrismaClient with PrismaPg
- the six @prisma/client import sites move to the generated path

Versions are pinned exactly, not caret-ranged: partialIndexes is a preview
feature and must not shift under an unrelated npm install.

No behaviour change — 255 tests pass unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Verify the production Docker image still builds

The Dockerfile's two Prisma touchpoints both changed meaning in v7 (`prisma generate` now writes to a path that is gitignored; `migrate deploy` now reads its datasource from `prisma.config.ts`). `npm run build` passing locally does not prove the image does.

**Files:**
- Modify (only if the build fails): `erp/Dockerfile`

**Interfaces:**
- Consumes: Task 2's generated-client layout.
- Produces: a proven-good production image path. No source changes if it passes.

- [ ] **Step 1: Build the production image**

```bash
cd erp
docker compose --profile prod build app
```
Expected: succeeds. The build stage runs `npx prisma generate && npm run build && npm prune --omit=dev`.

Two things to watch, both consequences of v7:
- `prisma/generated` is gitignored but **not** dockerignored, and it is produced inside the build stage by `prisma generate`, so it exists before `npm run build` needs it. Confirm the ordering in the Dockerfile is still `generate` **then** `build`.
- `npm prune --omit=dev` must not remove `@prisma/adapter-pg` — it is a runtime dependency and was installed into `dependencies` in Task 2, not `devDependencies`. Verify with `node -p "require('./package.json').dependencies['@prisma/adapter-pg']"` → `7.9.1`.

- [ ] **Step 2: If it failed, fix and re-run; if it passed, do nothing**

Do not "improve" the Dockerfile opportunistically. Its two long comments record hard-won Prisma-6 specifics; if v7 makes one obsolete, update that comment in the same commit rather than deleting it silently.

- [ ] **Step 3: Commit only if the Dockerfile changed**

```bash
git add Dockerfile
git commit -m "$(cat <<'EOF'
fix: adjust the production image for Prisma 7's generated client

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Make the 13 unique columns unique only among live rows

Schema + migration only. **Revival-on-create is still in place after this task and all 255 tests must still pass** — with the partial index, `findUnique({ where: { code } })` finds the soft-deleted row exactly as it did before, so every revival path behaves identically. This intermediate green state is deliberate: it separates "the index landed correctly" from "the services changed".

**Files:**
- Modify: `erp/prisma/schema.prisma` — 13 models
- Create: `erp/prisma/migrations/<timestamp>_partial_unique_live_rows/migration.sql` (generated)

**Interfaces:**
- Consumes: the `partialIndexes` preview flag from Task 2.
- Produces: for each of the 13 columns, a live-rows-only unique constraint. Tasks 5–8 depend on this existing before they remove revival.

- [ ] **Step 1: Convert all 13 columns**

The complete list, from handoff §5.18 — customer, role, the ten reference kinds, and processStepCode:

| Model | Column |
|---|---|
| `Role` | `name` |
| `GlAccount` | `name` |
| `Material` | `name` |
| `InspectionScale` | `name` |
| `InspectionCode` | `name` |
| `ContainerType` | `name` |
| `Carrier` | `name` |
| `Terms` | `name` |
| `PaymentType` | `name` |
| `CommentSnippet` | `name` |
| `Specification` | `name` |
| `ProcessStepCode` | `code` |
| `Customer` | `code` |

In each, drop the field-level `@unique` and add a block-level partial unique. Two worked examples — apply the same shape to all thirteen:

```prisma
model Material {
  id        String    @id @default(cuid())
  name      String
  active    Boolean   @default(true)
  deletedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  @@unique([name], where: raw("\"deletedAt\" IS NULL"))
}
```

```prisma
model Customer {
  id   String @id @default(cuid())
  code String
  name String
  // … all other fields unchanged …

  @@unique([code], where: raw("\"deletedAt\" IS NULL"))
  @@index([name])
}
```

Note the escaped double quotes: `raw("\"deletedAt\" IS NULL")`. PostgreSQL folds unquoted identifiers to lower case, and the column is `deletedAt`, so the inner quotes are required.

**Do not touch these** — they are not revival sites and changing them is out of scope:
- `User.username` — `createUser` has no revival branch and users are never hard-deleted (handoff §4). It keeps a plain `@unique`. Task 9's sweep allowlists it explicitly so the decision is recorded rather than forgotten.
- `Session.tokenHash`, `RolePermission.@@unique([roleId, permission])`, `UserPermissionOverride.@@unique([userId, permission])`, `ProcessStepFieldDef.@@unique([codeId, label])` — none has a `deletedAt`.

- [ ] **Step 2: Validate before generating a migration**

```bash
npx prisma validate
```
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 3: Create the migration against the dev database**

```bash
npx prisma migrate dev --name partial_unique_live_rows
```

Expected in the generated SQL, thirteen times over:

```sql
DROP INDEX "Material_name_key";
CREATE UNIQUE INDEX "Material_name_key" ON "Material"("name") WHERE ("deletedAt" IS NULL);
```

Read the file before continuing. If any statement drops a column or recreates a table, **stop** — that is not what this change should produce.

> v7's `migrate dev` no longer generates the client. Run `npx prisma generate` after it.

- [ ] **Step 4: Regenerate the client**

```bash
npx prisma generate
```

- [ ] **Step 5: Apply to the test database**

```bash
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
```
Expected: `1 migration found` / applied. **Skipping this leaves the tests on a stale schema** — the single most repeated trap in this repo.

- [ ] **Step 6: Prove the constraint does what it claims**

Add to `erp/tests/reference-gl.test.ts` (it already owns the cross-kind delegate round-trip):

```ts
  it("permits a deleted row and a live row to share a name, but not two live rows", async () => {
    const first = await createReference("material", { name: "4140" });
    await deleteReference("material", first.id);

    // The whole point of the partial index: the archived row keeps its real name.
    const archived = await prisma.material.findUnique({ where: { id: first.id } });
    expect(archived?.name).toBe("4140");
    expect(archived?.deletedAt).not.toBeNull();

    // A live row may now take that name — and is a genuinely new row.
    const second = await createReference("material", { name: "4140" });
    expect(second.id).not.toBe(first.id);

    // But two live rows may not.
    await expect(createReference("material", { name: "4140" })).rejects.toThrow(/already exists/i);
  });
```

- [ ] **Step 7: Run it**

```bash
npx vitest run tests/reference-gl.test.ts -t "permits a deleted row and a live row"
```
Expected: **FAIL** on `expect(second.id).not.toBe(first.id)` — revival is still in place, so the ids match. That failure is the proof the test is real. Task 7 turns it green.

Keep the body exactly as written and mark it skipped, so the suite stays green between tasks and the test is restored rather than rewritten:

```ts
  // Revival-on-create is still in place until Task 7 removes it — un-skip there.
  it.skip("permits a deleted row and a live row to share a name, but not two live rows", async () => {
```

`reference-gl.test.ts` already imports `prisma`, so `prisma.material.findUnique({ where: { id } })` needs no new import.

- [ ] **Step 8: Run all four gates**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```
Expected: 255 pass, 1 skipped.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations tests/reference-gl.test.ts
git commit -m "$(cat <<'EOF'
feat: make soft-deleted unique columns unique only among live rows

Thirteen columns — customer.code, role.name, the ten reference kinds' name,
and processStepCode.code — move from a plain @unique to a partial unique
index filtered on deletedAt IS NULL. A deleted row now keeps its own id and
its real value instead of physically occupying the constraint.

Schema only: revival-on-create still runs and every test still passes.
Tasks 5-8 remove revival now that the constraint no longer forces it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Delete revival-on-create — customers

**Files:**
- Modify: `erp/src/server/customers.ts:68-80` (delete `REVIVAL_DEFAULTS`), `:197-220` (`createCustomer`), `:186` and `:245`-ish (the `findUnique` audit)
- Modify: `erp/tests/customers.test.ts:44`, `:173`, `:317`

**Interfaces:**
- Consumes: Task 4's partial index on `Customer.code`.
- Produces: `createCustomer(input)` returning `{ id }` — unchanged signature, but the id is always a **new** row.

- [ ] **Step 1: Rewrite the two failing tests first**

In `erp/tests/customers.test.ts`, replace the test at line 44 (`"revives a soft-deleted code and brings it back active"`) and the one at line 317 (`"revival resets every field a genuine create would default, not just active"`) with a single test asserting the new contract:

```ts
  it("re-creating a deleted code makes a NEW row with its own history, not a revival", async () => {
    const first = await createCustomer({
      code: "ACME", name: "Acme Original", creditHold: true, orderNotes: "old notes",
    });
    await deleteCustomer(first.id, "keyed by mistake");

    const second = await createCustomer({ code: "ACME", name: "Acme Industries" });

    // A new identity, not the dead row wearing a new name.
    expect(second.id).not.toBe(first.id);

    // Nothing of the predecessor leaks through.
    const row = await getCustomer(second.id);
    expect(row.name).toBe("Acme Industries");
    expect(row.creditHold).toBe(false);
    expect(row.orderNotes).toBe("");
    expect(row.active).toBe(true);

    // The audit trail says "create", and carries none of the predecessor's entries.
    expect((await readAudit("customer", second.id)).map((e) => e.action)).toEqual(["create"]);

    // And the archived row keeps its own value, its own id, and its own history.
    const archived = await prisma.customer.findUnique({ where: { id: first.id } });
    expect(archived?.code).toBe("ACME");
    expect(archived?.deletedAt).not.toBeNull();
    expect((await readAudit("customer", first.id)).map((e) => e.action).sort())
      .toEqual(["create", "delete"]);
  });
```

No new imports needed — `customers.test.ts` already imports `prisma`, `readAudit`, and all five customer service functions. The same is true of `roles.test.ts` and `reference-gl.test.ts` for their tasks. `readAudit` orders **descending**, which is why the two-entry assertion is `.sort()`ed.

The test at line 173 (`"refuses a soft-deleted customer as a parent on revival"`) describes a path that no longer exists — delete it. The sibling tests at 159 and 166 (create/update) still cover the rule.

- [ ] **Step 2: Run them to watch them fail**

```bash
npx vitest run tests/customers.test.ts -t "re-creating a deleted code"
```
Expected: FAIL on `expect(second.id).not.toBe(first.id)` — revival still returns the old id.

- [ ] **Step 3: Delete `REVIVAL_DEFAULTS`**

Remove lines 68–80 of `erp/src/server/customers.ts` entirely — the comment block and the `REVIVAL_DEFAULTS` constant.

- [ ] **Step 4: Rewrite `createCustomer`'s duplicate check**

Replace the revival block (around lines 197–220) with:

```ts
  // Unique only among live rows (see prisma/schema.prisma), so a deleted code is free to be
  // re-used and simply becomes a new row. findFirst, NOT findUnique: the column is still typed
  // unique on the client, so findUnique compiles and silently returns the soft-deleted row.
  const existing = await prisma.customer.findFirst({
    where: { code: data.code, deletedAt: null },
    select: { id: true },
  });
  if (existing) throw new HttpError(400, "A customer with that code already exists");

  const row = await auditedCreate("customer", data, () =>
    withDbErrors({ entity: "Customer", conflictField: "code" }, () =>
      prisma.customer.create({ data })));
  return { id: row.id };
```

- [ ] **Step 5: Fix the remaining `findUnique` on a partial-unique column**

`erp/src/server/customers.ts:186` uses `db.customer.findUnique({ where: { id: cursor } })` — `id` is a real primary key, so **leave it alone**.

Search the file for any `findUnique` keyed on `code`:

```bash
grep -n "findUnique" src/server/customers.ts
```
Every remaining hit must be keyed on `id`. If one is keyed on `code`, convert it to `findFirst` with `deletedAt: null`.

- [ ] **Step 6: Add a regression test for the rename path — no code change**

`updateCustomer` has **no** `findUnique` rename guard; it relies on `withDbErrors` mapping Prisma's P2002 to a 400. Do not add a pre-check that was never there.

That path is fixed by Task 4 alone and needs no edit: a soft-deleted row no longer occupies the constraint, so P2002 no longer fires against an invisible row. This closes the carried backlog item "renaming onto a *soft-deleted* unique value 400s 'already exists' for an invisible row" (handoff §6) for free. Pin it so it stays fixed — add to `erp/tests/customers.test.ts`:

```ts
  it("allows renaming a customer's code onto one only a deleted row still holds", async () => {
    const dead = await createCustomer({ code: "OLD", name: "Gone" });
    await deleteCustomer(dead.id, "no longer a customer");
    const live = await createCustomer({ code: "KEEP", name: "Still here" });

    await updateCustomer(live.id, { code: "OLD" });

    expect((await getCustomer(live.id)).code).toBe("OLD");
  });
```

Run it: `npx vitest run tests/customers.test.ts -t "onto one only a deleted row"` — expected PASS, with no change to `customers.ts`. If it fails, the partial index from Task 4 did not land correctly; go back rather than editing the service.

- [ ] **Step 7: Run the customer tests, then all four gates**

```bash
npx vitest run tests/customers.test.ts
```
Expected: all pass. Then, per Global Constraints — every commit leaves all four green:

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```

- [ ] **Step 8: Commit**

```bash
git add src/server/customers.ts tests/customers.test.ts
git commit -m "$(cat <<'EOF'
feat: re-creating a deleted customer code makes a new row, not a revival

Now that Customer.code is unique only among live rows, a re-used code no
longer has to reuse the dead row — and so no longer inherits its audit
identity, its createdAt, or its history (issue #10).

findFirst, not findUnique: the partial index leaves the column typed unique
on the client, so findUnique still compiles and silently returns the deleted
row. Task 9's sweep guards that.

Also closes the carried backlog item where renaming onto a soft-deleted code
400'd "already exists" for a row the caller cannot see.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Delete revival-on-create — roles (and the seed's `upsert`)

`prisma/seed.ts` breaks in this task, not before: `role.upsert({ where: { name: "Admin" } })` throws **P2039** once `Role.name` is only partially unique. Verified in the spike.

**Files:**
- Modify: `erp/src/server/roles.ts:21-46`
- Modify: `erp/prisma/seed.ts` (the `role.upsert` call)
- Modify: `erp/tests/roles.test.ts`

**Interfaces:**
- Consumes: Task 4's partial index on `Role.name`.
- Produces: `createRole(name)` → `{ id }`, always a new row.

- [ ] **Step 1: Prove the seed is broken**

```bash
npm run db:seed
```
Expected: **FAIL** with `P2039`. This is the verified consequence, and seeing it first is what makes the fix in Step 5 an evidenced change rather than a speculative one.

- [ ] **Step 2: Rewrite the roles revival test**

In `erp/tests/roles.test.ts`, replace the revival test with:

```ts
  it("re-creating a deleted role name makes a NEW role with no inherited grants", async () => {
    const first = await createRole("Shipping");
    await setRolePermissions(first.id, ["customers.view"]);
    await deleteRole(first.id);

    const second = await createRole("Shipping");
    expect(second.id).not.toBe(first.id);

    const roles = await listRoles();
    const fresh = roles.find((r) => r.id === second.id);
    expect(fresh?.permissions).toEqual([]);

    expect((await readAudit("role", second.id)).map((e) => e.action)).toEqual(["create"]);
  });
```

The old revival semantics — "clear the stale permissions off the revived row" — is now structural: a new row has no `RolePermission` rows at all. The assertion above still guards the same user-visible rule, which is why it is kept rather than deleted.

- [ ] **Step 3: Run it to watch it fail**

```bash
npx vitest run tests/roles.test.ts -t "re-creating a deleted role name"
```
Expected: FAIL — ids match.

- [ ] **Step 4: Rewrite `createRole` and `renameRole`**

Replace lines 21–46 of `erp/src/server/roles.ts` with:

```ts
export async function createRole(name: string): Promise<{ id: string }> {
  // findFirst, NOT findUnique — Role.name is unique only among live rows, but the client still
  // types it unique, so findUnique compiles and returns the soft-deleted row instead.
  const existing = await prisma.role.findFirst({ where: { name, deletedAt: null }, select: { id: true } });
  if (existing) throw new HttpError(400, "A role with that name already exists");

  const role = await auditedCreate("role", { name }, () =>
    withDbErrors({ entity: "Role", conflictField: "name" }, () => prisma.role.create({ data: { name } })));
  return { id: role.id };
}

export async function renameRole(roleId: string, name: string): Promise<void> {
  const existing = await prisma.role.findFirst({
    where: { name, deletedAt: null, NOT: { id: roleId } },
    select: { id: true },
  });
  if (existing) throw new HttpError(400, "A role with that name already exists");
  await withDbErrors({ entity: "Role", conflictField: "name" }, () =>
    auditedUpdate("role", roleId, () => prisma.role.update({ where: { id: roleId }, data: { name } })));
}
```

`renameRole`'s rewrite also fixes the carried backlog edge "`renameRole` to a soft-deleted role's name → 500" (handoff §6).

- [ ] **Step 5: Fix the seed**

In `erp/prisma/seed.ts`, replace the `role.upsert` call with a find-then-create. `upsert` cannot be used on a partially-unique column at all:

```ts
  // Not upsert: Role.name is unique only among live rows, and upsert on such a column throws
  // P2039. Find-then-create is the equivalent, and the seed is single-threaded.
  const admin =
    (await prisma.role.findFirst({ where: { name: "Admin", deletedAt: null } })) ??
    (await prisma.role.create({ data: { name: "Admin" } }));
```

The `user.upsert({ where: { username: "admin" } })` call below it is **fine and must not be changed** — `User.username` is still fully unique (Task 4, Step 1).

- [ ] **Step 6: Verify the seed and the tests**

```bash
npm run db:seed && npx vitest run tests/roles.test.ts
```
Expected: seed completes; role tests pass.

Run the seed a second time to confirm idempotence:
```bash
npm run db:seed
```
Expected: completes again with no duplicate-Admin error.

Then all four gates, per Global Constraints:

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/server/roles.ts prisma/seed.ts tests/roles.test.ts
git commit -m "$(cat <<'EOF'
feat: re-creating a deleted role name makes a new role, not a revival

A new row has no RolePermission rows by construction, so the old "clear the
stale grants off the revived role" branch is gone rather than reimplemented.

The seed's role.upsert({ where: { name } }) had to go with it: upsert on a
partially-unique column throws P2039. user.upsert stays — username is still
fully unique.

renameRole's guard moves to findFirst too, closing the carried backlog edge
where renaming onto a soft-deleted role name 500'd.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Delete revival-on-create — the ten reference kinds

**Files:**
- Modify: `erp/src/server/reference.ts:23-36` (delete `REVIVAL_EXTRA_DEFAULTS`), `:45-54` (the `RefDelegate` type), `:76-105` (`createReference`)
- Modify: `erp/tests/reference-tables.test.ts:81`, `erp/tests/reference-gl.test.ts:73`, `:94`, `:118`

**Interfaces:**
- Consumes: Task 4's partial indexes on all ten reference `name` columns.
- Produces: `createReference(kind, input)` → `{ id }`, always a new row. `RefDelegate` gains `findFirst` and loses `findUnique`.

- [ ] **Step 1: Un-skip the test written in Task 4**

In `erp/tests/reference-gl.test.ts`, change the `it.skip(` from Task 4 Step 7 back to `it(` and delete the "un-skip there" comment above it.

- [ ] **Step 2: Rewrite the three revival tests**

Replace the tests at `reference-gl.test.ts:73` (`"revives a soft-deleted row when the same name is re-created"`), `:94` (`"revival resets extra fields…"`) and `:118` (`"revives a soft-deleted, previously-inactive row as active by default"`) with one:

```ts
  it("re-creating a deleted name makes a NEW row carrying none of the predecessor", async () => {
    const first = await createReference("glAccount", { name: "4010", description: "old" });
    await deleteReference("glAccount", first.id);

    const second = await createReference("glAccount", { name: "4010" });
    expect(second.id).not.toBe(first.id);

    const rows = await listReference("glAccount");
    const fresh = rows.find((r) => r.id === second.id);
    expect(fresh?.description).toBe("");   // schema default, not "old"
    expect(fresh?.active).toBe(true);

    expect((await readAudit("glAccount", second.id)).map((e) => e.action)).toEqual(["create"]);
  });
```

And at `reference-tables.test.ts:81`, replace `"revival resets extra fields for every kind that has one, not just active"` with the same shape run across every kind that has an extra column, so the per-kind coverage is not lost:

```ts
  const KINDS_WITH_EXTRAS = [
    { kind: "glAccount", extra: { description: "old" }, field: "description", fresh: "" },
    { kind: "inspectionCode", extra: {}, field: "defaultScaleId", fresh: null },
    { kind: "paymentType", extra: {}, field: "glAccountId", fresh: null },
    { kind: "commentSnippet", extra: { text: "old" }, field: "text", fresh: "" },
    { kind: "specification", extra: { text: "old" }, field: "text", fresh: "" },
  ] as const;

  it.each(KINDS_WITH_EXTRAS)(
    "$kind: a re-created name is a new row with default extras",
    async ({ kind, extra, field, fresh }) => {
      const first = await createReference(kind, { name: "X1", ...extra });
      await deleteReference(kind, first.id);
      const second = await createReference(kind, { name: "X1" });
      expect(second.id).not.toBe(first.id);
      const rows = await listReference(kind);
      expect(rows.find((r) => r.id === second.id)?.[field]).toBe(fresh);
    },
  );
```

- [ ] **Step 3: Run them to watch them fail**

```bash
npx vitest run tests/reference-gl.test.ts tests/reference-tables.test.ts
```
Expected: FAIL on the `not.toBe(first.id)` assertions.

- [ ] **Step 4: Delete `REVIVAL_EXTRA_DEFAULTS`**

Remove lines 23–36 of `erp/src/server/reference.ts` — the comment block and the constant.

- [ ] **Step 5: Swap `findUnique` for `findFirst` on the delegate type**

In the `RefDelegate` type (around line 48), replace the `findUnique` member:

```ts
type RefDelegate = {
  findMany: (a: object) => Promise<ReferenceRow[]>;
  // findFirst, not findUnique: `name` is unique only among live rows, but the generated client
  // still types it unique — findUnique would compile and return the soft-deleted row.
  findFirst: (a: { where: object; select?: object }) => Promise<{ id: string } | null>;
  create: (a: { data: object }) => Promise<{ id: string }>;
  update: (a: { where: { id: string }; data: object }) => Promise<{ id: string }>;
};
```

`update` stays — `updateReference` still uses it.

- [ ] **Step 6: Rewrite `createReference`**

Replace the body from the `existing` lookup to the `return` (lines ~83–104) with:

```ts
  const existing = await delegate(kind).findFirst({
    where: { name: data.name, deletedAt: null },
    select: { id: true },
  });
  if (existing) {
    throw new HttpError(400, `A ${REFERENCE_LABELS[kind].singular.toLowerCase()} with that name already exists`);
  }

  const row = await auditedCreate(kind, data, () =>
    withDbErrors({ entity: REFERENCE_LABELS[kind].singular, conflictField: "name" }, () =>
      delegate(kind).create({ data })));
  return { id: row.id };
```

- [ ] **Step 7: Leave `updateReference` alone — verify, do not edit**

`updateReference` has no rename pre-check; it relies on `withDbErrors` mapping P2002 → 400. That still works, because a *live* duplicate still raises P2002. **Do not add a pre-check that was never there.**

Task 4 also fixes the reference half of the carried backlog item "renaming onto a soft-deleted unique value 400s 'already exists' for an invisible row" here, for free and with no code change. Pin it, mirroring Task 5 Step 6:

```ts
  it("allows renaming a reference row onto a name only a deleted row still holds", async () => {
    const dead = await createReference("material", { name: "OLD" });
    await deleteReference("material", dead.id);
    const live = await createReference("material", { name: "KEEP" });

    await updateReference("material", live.id, { name: "OLD" });

    expect((await listReference("material")).find((r) => r.id === live.id)?.name).toBe("OLD");
  });
```

Run it: `npx vitest run tests/reference-gl.test.ts -t "onto a name only a deleted row"` — expected PASS with `reference.ts` untouched.

- [ ] **Step 8: Run the reference tests, then all four gates**

```bash
npx vitest run tests/reference-gl.test.ts tests/reference-tables.test.ts
```
Expected: all pass — including the test un-skipped in Step 1. Then, per Global Constraints:

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```
Expected: nothing skipped any more.

- [ ] **Step 9: Commit**

```bash
git add src/server/reference.ts tests/reference-gl.test.ts tests/reference-tables.test.ts
git commit -m "$(cat <<'EOF'
feat: re-creating a deleted reference name makes a new row, not a revival

Covers all ten reference kinds at once. REVIVAL_EXTRA_DEFAULTS is deleted:
a new row takes its schema defaults by construction, which is what that table
was hand-maintaining.

RefDelegate now declares findFirst instead of findUnique, so the dangerous
call shape is not even reachable through the shared delegate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Delete revival-on-create — process step codes

The last site, and the one that also soft-deleted children (`ProcessStepFieldDef`) on revival.

**Files:**
- Modify: `erp/src/server/process-step-codes.ts:44-49` (delete `REVIVAL_DEFAULTS`), `:66-99` (`createStepCode`)
- Modify: `erp/tests/process-step-codes.test.ts:34`, `:45`, `:57`

**Interfaces:**
- Consumes: Task 4's partial index on `ProcessStepCode.code`.
- Produces: `createStepCode(input)` → `{ id }`, always a new row with no field definitions. Signature unchanged.

> Exact exported names, confirmed against the source: `listStepCodes`, `createStepCode`, `updateStepCode`, `deleteStepCode`, `setStepFields`. Field definitions are **not** part of `createStepCode`'s input — `CREATE` has no `fields` key; they are attached separately through `setStepFields`.

- [ ] **Step 1: Rewrite the three revival tests as one**

Replace the tests at lines 34, 45 and 57 of `erp/tests/process-step-codes.test.ts` with:

```ts
  it("re-creating a deleted code makes a NEW code with no inherited fields", async () => {
    const gl = await createReference("glAccount", { name: "4010" });
    const { id: firstId } = await createStepCode({
      code: "HT-01", name: "Austenitize", glAccountId: gl.id, equipmentTag: "F1",
    });
    await setStepFields(firstId, [{ label: "Soak", type: "NUMBER", unit: "min", sort: 0 }]);
    await deleteStepCode(firstId);

    const { id: secondId } = await createStepCode({ code: "HT-01", name: "Renamed" });
    expect(secondId).not.toBe(firstId);

    const [fresh] = await listStepCodes();
    expect(fresh).toMatchObject({
      id: secondId, code: "HT-01", name: "Renamed",
      glAccountId: null, equipmentTag: "", active: true, needsGlAccount: true,
    });
    expect(fresh.fields).toEqual([]);

    // A real create entry under its own identity — the defect issue #10 was filed for.
    expect((await readAudit("processStepCode", secondId)).map((e) => e.action)).toEqual(["create"]);
  });
```

`readAudit` is already imported by this test file. It orders **descending**, which is why single-entry assertions are written as an exact array and multi-entry ones are sorted.

Keep the test at line 80 (`"still rejects a duplicate code when the existing row is not soft-deleted"`) exactly as it is — that rule is unchanged and it is the guard proving the constraint still bites.

- [ ] **Step 2: Run it to watch it fail**

```bash
npx vitest run tests/process-step-codes.test.ts -t "re-creating a deleted code"
```
Expected: FAIL — ids match.

- [ ] **Step 3: Delete `REVIVAL_DEFAULTS`**

Remove lines 44–49 of `erp/src/server/process-step-codes.ts` — the comment and the constant.

- [ ] **Step 4: Rewrite the create**

Replace everything in `createStepCode` from the `existing` lookup down to `return { id: row.id };` with the create branch alone. The whole `existing ? … : …` ternary, its long revival comment, and the `$transaction` that deleted the predecessor's `processStepFieldDef` rows all go — a new row has no children to clear:

```ts
export async function createStepCode(input: z.input<typeof CREATE>): Promise<{ id: string }> {
  const data = CREATE.parse(input);

  // findFirst, NOT findUnique: `code` is unique only among live rows, but the generated client
  // still types it unique, so findUnique would compile and return the soft-deleted row.
  const existing = await prisma.processStepCode.findFirst({
    where: { code: data.code, deletedAt: null },
    select: { id: true },
  });
  if (existing) throw new HttpError(400, "A process step code with that code already exists");

  const row = await auditedCreate("processStepCode", data, () =>
    withDbErrors({ entity: "Process step code", conflictField: "code" }, () =>
      prisma.processStepCode.create({ data })));
  return { id: row.id };
}
```

`data` is passed straight through, exactly as the old create branch did. `CREATE` carries no `fields` key, so there is no child-record handling in this function at all — that lives in `setStepFields`.

- [ ] **Step 5: Check the remaining `findUnique`**

```bash
grep -n "findUnique" src/server/process-step-codes.ts
```
The one remaining hit is keyed on `id`, a primary key. **Leave it.** Any hit keyed on `code` means Step 4 was applied incompletely.

- [ ] **Step 6: Run the tests**

```bash
npx vitest run tests/process-step-codes.test.ts
```
Expected: all pass.

- [ ] **Step 7: Run all four gates — every revival site is now converted**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```
Expected: all green, nothing skipped.

- [ ] **Step 8: Commit**

```bash
git add src/server/process-step-codes.ts tests/process-step-codes.test.ts
git commit -m "$(cat <<'EOF'
feat: re-creating a deleted step code makes a new code, not a revival

The last of the four revival sites. The transaction that soft-deleted the
old row's field definitions on revival is gone with it — a new row has no
children to clear.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Sweep test — guard the silent `findUnique` trap

The reason this task exists: the partial index leaves these columns typed unique on the client, so `findUnique({ where: { code } })` compiles, returns the wrong row, and **no gate catches it**. Verified in the spike. Every conversion in Tasks 5–8 was manual; this is what stops the fifth one from being missed the way revival-on-create was missed four times.

Same technique as `tests/permissions-sweep.test.ts`, which the repo already trusts.

**Files:**
- Create: `erp/tests/partial-unique-sweep.test.ts`

**Interfaces:**
- Consumes: `prisma/schema.prisma` as data.
- Produces: two failing-on-regression invariants. Nothing imports from it.

- [ ] **Step 1: Write the sweep**

Create `erp/tests/partial-unique-sweep.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");

/** Every `model X { … }` block in the schema, as [name, body] pairs. */
function models(): [string, string][] {
  return [...SCHEMA.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((m) => [m[1], m[2]]);
}

/** Columns declared unique only among live rows, e.g. @@unique([code], where: raw("…")). */
function partialUniqueColumns(): Set<string> {
  const cols = new Set<string>();
  for (const [, body] of models()) {
    for (const m of body.matchAll(/@@unique\(\[([^\]]+)\][^)]*\bwhere:/g)) {
      m[1].split(",").forEach((c) => cols.add(c.trim()));
    }
  }
  return cols;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [full] : [];
  });
}

describe("partial unique sweep", () => {
  // A partial unique index does NOT remove the column from the generated WhereUniqueInput —
  // verified against Prisma 7.9.1, where the type stays AtLeast<{…}, "id" | "code">. So
  // findUnique({ where: { code } }) compiles, and silently returns the SOFT-DELETED row
  // instead of the live one. upsert on the same column throws P2039 at runtime. Neither is
  // caught by tsc, eslint, or any behavioural test that happens not to have a deleted row
  // lying around. This sweep is the only thing standing between that and production.
  it("no findUnique or upsert is keyed on a live-rows-only unique column", () => {
    const partial = partialUniqueColumns();
    expect(partial.size).toBeGreaterThan(0); // the sweep is worthless if the parse silently fails

    const files = [...tsFiles(join(process.cwd(), "src")), join(process.cwd(), "prisma/seed.ts")];
    const offenders: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\.(findUnique|upsert)\(\s*\{\s*where:\s*\{\s*(\w+)/g)) {
        if (partial.has(m[2])) {
          offenders.push(`${file.replace(process.cwd() + "/", "")}: .${m[1]}({ where: { ${m[2]} … } })`);
        }
      }
    }

    expect(offenders, `Use findFirst({ where: { <col>, deletedAt: null } }) instead — findUnique on a
partially-unique column returns the soft-deleted row, and upsert throws P2039.`).toEqual([]);
  });

  // The invariant behind §5.18: if a model can be soft-deleted, a plain @unique on it means a
  // deleted row keeps occupying that value — which is exactly what forced revival-on-create,
  // and with it the audit-identity bug in issue #10.
  it("every soft-deletable model's unique columns are live-rows-only", () => {
    // User.username is deliberately excluded: createUser has no revival branch and users are
    // never hard-deleted (handoff §4), so no re-create ever collides. Recorded here rather
    // than left as an unexplained gap.
    const ALLOWED = new Set(["User.username"]);

    const offenders: string[] = [];
    for (const [name, body] of models()) {
      if (!/^\s*deletedAt\s+DateTime\?/m.test(body)) continue;
      for (const m of body.matchAll(/^\s*(\w+)\s+\S+\s+.*@unique/gm)) {
        const key = `${name}.${m[1]}`;
        if (!ALLOWED.has(key)) offenders.push(key);
      }
    }

    expect(offenders, `These columns are @unique on a soft-deletable model. A deleted row will
occupy the value forever, forcing revival-on-create back into existence (handoff §5.18).
Use @@unique([col], where: raw("\\"deletedAt\\" IS NULL")) instead.`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — it must pass**

```bash
npx vitest run tests/partial-unique-sweep.test.ts
```
Expected: 2 passing. If the first test reports offenders, Tasks 5–8 missed a call site — fix the source, not the sweep.

- [ ] **Step 3: Prove the sweep actually bites**

Temporarily reintroduce the bug in `erp/src/server/roles.ts`:

```ts
  const existing = await prisma.role.findUnique({ where: { name } });
```

```bash
npx vitest run tests/partial-unique-sweep.test.ts
```
Expected: **FAIL**, naming `src/server/roles.ts`. A sweep that has never been seen to fail is not a guard. **Revert the edit** and re-run to confirm green.

- [ ] **Step 4: Run all four gates**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```
Expected: 257-ish tests pass (the two new sweep cases, minus the revival tests collapsed in Tasks 5–8). Record the real number — Task 10 writes it into the docs.

- [ ] **Step 5: Commit**

```bash
git add tests/partial-unique-sweep.test.ts
git commit -m "$(cat <<'EOF'
test: sweep for findUnique/upsert on live-rows-only unique columns

A partial unique index does not remove the column from the generated
WhereUniqueInput (verified against 7.9.1: the type stays AtLeast<…, "id" |
"code">), so findUnique still compiles and silently returns the soft-deleted
row, and upsert throws P2039. No other gate catches either.

The second case guards the rule itself: a plain @unique on a soft-deletable
model is what forced revival-on-create in the first place.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Rewrite the documentation that this change invalidates

Handoff §4b: "Update `CLAUDE.md` and §8 in the same change, or the next fresh checkout follows instructions that no longer work." This task is not optional and not cosmetic — the documented schema-change recipe stops working the moment Task 2 lands.

**Files:**
- Modify: `CLAUDE.md` — "Commands", "Schema changes apply to two databases", "Deletion is always soft"
- Modify: `docs/HANDOFF.md` — §4a, §4b, §5.10, §5.11, §5.18, §6, §8, §9

**Interfaces:**
- Consumes: the real test count from Task 9, Step 4.
- Produces: documentation a fresh checkout can follow.

- [ ] **Step 1: Fix `CLAUDE.md`'s two-database recipe**

v7's `migrate dev` no longer generates the client, and `--skip-generate` / `--skip-seed` no longer exist. Replace the recipe under "Schema changes apply to two databases" with:

````markdown
```bash
npx prisma migrate dev                                                     # dev DB, creates the migration
npx prisma generate                                                        # v7 no longer does this for you
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
```

Skipping the second command leaves you typechecking against a stale client; skipping the third
leaves the tests running against a stale schema. `npx prisma generate` is also required before
typechecking a fresh checkout — the client is generated into `prisma/generated/` and is
gitignored, so without it every Prisma type in `src/server/` and the tests is missing.
````

- [ ] **Step 2: Fix `CLAUDE.md`'s first-run command block**

Add `npx prisma generate` after `npm install`, and correct the test count to the number from Task 9:

```bash
npm install
npx prisma generate               # client is gitignored; generate before typechecking or testing
npx prisma migrate deploy         # dev DB
```

Also correct the stale comment on the test line — it still says "75 integration tests".

- [ ] **Step 3: Record the new deletion rule in `CLAUDE.md`**

Under "Deletion is always soft", replace the sentence "Reviving a soft-deleted name must clear the stale permissions attached to it." with:

```markdown
Unique columns on soft-deletable models are unique **only among live rows** (a partial index
filtered on `deletedAt IS NULL`), so re-using a deleted code creates a genuinely new row with
its own id and its own audit history — there is no revival-on-create, and adding one back is a
regression. **Never `findUnique`/`upsert` on such a column**: the generated client still types
it unique, so both compile, and `findUnique` silently returns the deleted row. Use
`findFirst({ where: { code, deletedAt: null } })`. `tests/partial-unique-sweep.test.ts` enforces
both halves.
```

- [ ] **Step 4: Rewrite handoff §5.11 and §5.18**

§5.11 currently says "SUPERSEDED by §5.18 — being deleted, not consolidated." It is now *done*. Replace the whole numbered item with:

```markdown
11. **There is no revival-on-create — deleting it was the point of the Prisma 7 work.** Unique
    columns on soft-deletable models are unique only among live rows. A re-used code is a new
    row with a new id and a real `"create"` audit entry; the archived row keeps its own id, its
    real value and its own history. `findUnique`/`upsert` on those columns is banned and swept
    (`tests/partial-unique-sweep.test.ts`) — the client still types them unique, so both
    compile and `findUnique` returns the *deleted* row.
```

§5.18 becomes a historical record. Prefix it with `**DONE (2026-08-01, branch `prisma-7-upgrade`).**` and **correct its two factual errors in place**, so a future reader does not re-derive them:
- `@@unique` *does* take `where`; the value is `raw("…")`, not a bare string.
- The conversion to `findFirst` is **not** compiler-enforced — the column stays typed unique. Point at the sweep.
- Add: `partialIndexes` is a preview feature; owner approved it 2026-08-01.

- [ ] **Step 5: Rewrite handoff §4b as an outcome, not a forecast**

Replace §4b's "what it actually means for THIS repo" with what actually happened: the ESM flip touched exactly one file (`vitest.config.ts`'s `__dirname`); `engine` was removed not adapted; the generated client is TypeScript and lives gitignored in `prisma/generated`; `tsc` needed no target bump; the six import sites were the whole surface.

- [ ] **Step 6: Update §4a's resume point and §9's kickoff prompts**

§4a item 1 (the Prisma upgrade) is done — replace it with a one-line record and promote Phase 2C to next. In §5.10, add the `npx prisma generate` step. In §9, **delete the Prisma 7 kickoff prompt** and leave Phase 2C's as the live one.

In §6, strike the two backlog items this branch closed: "renaming onto a *soft-deleted* unique value 400s 'already exists'" and "`renameRole` to a soft-deleted role's name → 500 edge". Also strike "Make revival-on-create ONE shared helper before 2C adds a fifth site" — there is no revival to share.

Update §8's `npm test # expect 255 passing` to the real number, and add `npx prisma generate` before `npm test`.

- [ ] **Step 7: Update Phase 2C's inherited obligations**

§4a item 2 lists five obligations 2C inherits. Revival-on-create is not among them and must not be re-added. Confirm the list still reads correctly now that §5.11 has changed meaning.

- [ ] **Step 8: Verify the docs against a clean checkout**

The real test of this task. In a scratch directory:

```bash
git clone /home/cojoa13/Desktop/HeatSynQ /tmp/handoff-check && cd /tmp/handoff-check
git checkout prisma-7-upgrade && cd erp
cp .env.example .env
npm install
```
Then follow `CLAUDE.md`'s documented steps **exactly as written**, against the existing dev database, and confirm `npx tsc --noEmit` and `npm test` both pass. If any documented step is missing or wrong, fix the doc — that is the whole point of the task. Remove `/tmp/handoff-check` afterwards.

- [ ] **Step 9: Commit**

```bash
git add ../CLAUDE.md ../docs/HANDOFF.md
git commit -m "$(cat <<'EOF'
docs: rewrite the schema-change workflow for Prisma 7

v7's `migrate dev` no longer generates the client or seeds, and the client is
now generated into a gitignored path — so the recipe CLAUDE.md and handoff §8
documented no longer works on a fresh checkout. Verified by following the new
instructions verbatim in a clean clone.

§5.11 and §5.18 are rewritten as done rather than pending, with §5.18's two
factual errors corrected in place (@@unique does take `where`; the findFirst
conversion is not compiler-enforced). §4b becomes an outcome record.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification before review

- [ ] All four gates green from a clean state:

```bash
cd erp
rm -rf prisma/generated .next
npx prisma generate
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```

- [ ] Both databases carry the new migration:

```bash
npx prisma migrate status
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate status
```

- [ ] No revival machinery survives anywhere:

```bash
grep -rn "REVIVAL\|revival\|revive" src/ prisma/ | grep -v "^Binary"
```
Expected: no hits in `src/` or `prisma/` other than comments that explicitly say revival no longer exists.

- [ ] The production image builds: `docker compose --profile prod build app`

- [ ] Browser check against the dev database, per handoff §5a's bundled-Chromium recipe: delete a customer, re-create the same code, and confirm the **History panel shows only the new row's `"create"`** — the exact symptom issue #10 was filed for. Clear the fixtures out of `erp` afterwards.

---

## Open question for the owner (does not block this branch)

Issue **#4** remains the one open product decision (contacts flagged for document delivery with no email address). It binds Phases 4–5, not this work. Do not resolve it here.
