# The Prisma 7 upgrade — what actually happened (merged 2026-08-01)

*Moved verbatim out of `docs/HANDOFF.md` §4b on 2026-08-06, when the handoff was split into current state plus `docs/history/`. Nothing below is edited or summarised, and the original `### 4b.` heading is kept as written so older references to "HANDOFF §4b" still resolve here. The rules this upgrade left behind are live in CLAUDE.md and HANDOFF §5.10/§5.11/§5.18.*

---

### 4b. Prisma 7 upgrade — what actually happened

**DONE 2026-08-01, branch `prisma-7-upgrade`.** This section originally recorded a pre-work survey against the official guide, to save the executing session from re-surveying. It now records the outcome instead — most of the survey held up; the parts that didn't are called out below rather than silently dropped.

**Already fine, no work — as predicted:** Node 22.23.1, TypeScript 5.9.3, no `tsc` target bump needed. `prisma.config.ts` needed `migrations.seed` added (`prisma.seed` in `package.json` is no longer read) and its `engine: "classic"` line **removed outright, not adapted** — v7 deleted the `engine` property from the config shape rather than giving it a new home. `url` came out of `schema.prisma`'s `datasource` block; `prisma.config.ts`'s `datasource.url` is the only place the connection string lives now.

**Mechanical, as predicted:**
- Generator is `provider = "prisma-client"` with `output = "./generated/prisma"`. The path is **gitignored** (`/prisma/generated` added to `.gitignore`) — the Docker standalone build regenerates it, and the client is TypeScript source, not JS-plus-`.d.ts`.
- `@prisma/client` imports moved to the generated path, **by relative import in exactly the 6 predicted files** — `src/server/db.ts`, `audit.ts`, `customers.ts`, `customer-addresses.ts`, `db-errors.ts`, `prisma/seed.ts` — deliberately not an `@/` alias and deliberately outside `src/`, so the sweep tests that walk every `.ts` under `src/` (`tests/permissions-sweep.test.ts`, `tests/partial-unique-sweep.test.ts`) aren't polluted by generated code.
- PostgreSQL requires a driver adapter, confirmed: `src/server/db.ts` and `prisma/seed.ts` both construct `new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })`.
- **Not predicted, found during the work:** `dotenv` and `tsx` had to move from `devDependencies` to `dependencies` — both are runtime dependencies of `prisma.config.ts` in the production image, which runs `npm prune --omit=dev`. The Dockerfile's run stage now copies `prisma.config.ts` too; without it the container crash-looped at start on `migrate deploy` with "The datasource.url property is required in your Prisma config file", because v7 reads the datasource URL from that file rather than the schema.
- Prisma packages are pinned **exactly** (no `^`) — `partialIndexes` (used by §5.18's partial unique indexes) is a preview feature and must not shift underneath an unrelated `npm install`.

**The ESM flip — predicted risky, actual blast radius was zero files.** `"type": "module"` landed as its own commit as planned, full suite green before and after. `vitest.config.ts`'s `__dirname` was the one thing expected to break, on the theory that `__dirname` doesn't exist in an ES module — it did not break, because Vite bundles its own config file and injects `__dirname` for it regardless of the package's module type. It was rewritten anyway (`fileURLToPath(new URL(...))`) as a robustness improvement, not because anything failed. `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, and `tsconfig` needed no changes at all.

**CLI behaviour changed beyond what the original survey anticipated.** Confirmed as predicted: `migrate dev` no longer generates the client or seeds; `--skip-generate`/`--skip-seed` are gone. Not anticipated at all: `migrate diff --to-schema-datamodel` is now `--to-schema`; `db execute` lost `--schema`/`--url`; and, the one that actually cost time, **`migrate dev` refuses to run in a non-interactive shell** — "the environment is non-interactive, which is not supported" — even with `CI=true` or `--create-only`. It works fine for a human at a terminal; automation (including a Claude Code session driving Bash) must use `migrate diff` to produce the SQL, hand-write the migration directory, and apply with `migrate deploy`. That is how this branch's one migration (`20260801031309_partial_unique_live_rows`) was created — see `CLAUDE.md`'s "Constraints that will bite you" and §5.10.

**Confirmed unused, as the survey hoped:** `prisma.$use` middleware (no hits in `src/` or `prisma/`), the metrics feature.

**Docs were the last task, not an afterthought.** `CLAUDE.md` (the two-database recipe, the first-run block, the deletion-is-soft rule) and this handoff (§4a, §5.10, §5.11, §5.18, §6, §8, §9) were rewritten in the same branch as the code, and verified by following `CLAUDE.md` verbatim against a clean clone (Task 10, this task).
