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

