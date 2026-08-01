# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

`docs/HANDOFF.md` is the portable project memory and the entry point for any new session — it carries the scope decisions, the model facts, the current backlog, and the Phase 2 kickoff instruction. Read it before planning work.

Two documents are binding, not advisory:

- `docs/superpowers/specs/2026-07-29-heat-treat-erp-design.md` — the approved spec. §3 (non-goals) and §15 (decision log) are the contract.
- `docs/superpowers/plans/2026-07-29-roadmap.md` — the 8-phase build order.

**The owner's prime directive: DO NOT MAKE ASSUMPTIONS.** When the spec and the handoff don't answer a question, ask the owner rather than inventing an answer. A large list of features is deliberately out of scope (scheduling, shop-floor tracking, inventory, order duplication, CAR, and more — handoff §3); do not re-add them because they seem like obvious ERP functionality.

## Layout

The Next.js app is in `erp/` — **all commands below run from there.** The repo root holds only documentation and the Visual Shop reference report.

## Commands

```bash
cd erp
cp .env.example .env              # first run only
docker compose up -d db           # Postgres 16; creates erp + erp_test via db-init/
npm install
npx prisma generate                # client is gitignored; generate before typechecking or testing
npx prisma migrate deploy          # dev DB
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
npm run db:seed                   # admin/admin
npm run dev                       # http://localhost:3000
```

Quality gates — all three must stay green:

```bash
npm test                          # vitest, 258 integration tests against the real erp_test DB
npx tsc --noEmit
npx eslint src tests
```

Single test file or single case:

```bash
npx vitest run tests/users.test.ts
npx vitest run tests/users.test.ts -t "rejects duplicate usernames"
```

`npm run build` produces the standalone build the Docker image ships. Production is `docker compose --profile prod up -d --build` (db + app + nightly backup); migrations apply automatically on container start.

## Schema changes apply to two databases

There is one shared test database and no per-run migration. After editing `prisma/schema.prisma`:

```bash
npx prisma migrate dev                                                     # dev DB, creates the migration
npx prisma generate                                                        # v7 no longer does this for you
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
```

Skipping the second command leaves you typechecking against a stale client; skipping the third leaves the tests running against a stale schema. `npx prisma generate` is also required before typechecking a fresh checkout — the client is generated into `prisma/generated/`, and is gitignored, so without it every Prisma type in `src/server/` and the tests is missing.

`--skip-generate` and `--skip-seed` no longer exist as flags, and `migrate diff --to-schema-datamodel` is now `--to-schema`. Seeding is now declared in `prisma.config.ts` (`migrations.seed`), not `package.json`'s `prisma.seed` key — v7 no longer reads that.

## Architecture

**Request path.** Every API route is `handle(async (req) => ...)` from `src/server/http.ts`. `handle` resolves the session from the `erp_session` cookie, runs the handler inside an `AsyncLocalStorage` actor context (`src/server/context.ts`) so the audit layer knows who acted without threading a user parameter through every call, and converts `HttpError` and `ZodError` into clean JSON responses. Anything else escaping a handler is a bug, not an expected failure.

Handlers stay thin and follow a fixed shape — authorize, parse, delegate:

```ts
export const POST = handle(async (req) => {
  mustCan(await requireUser(req), "admin", "edit");
  const { name } = z.object({ name: z.string().min(1) }).parse(await req.json());
  return NextResponse.json(await createRole(name));
});
```

Business rules live in the services under `src/server/*.ts`. React components hold no business logic.

**Permissions** (`src/server/permissions.ts`, constants in `src/lib/permission-constants.ts`). 12 areas × view/create/edit/delete, plus 10 named special actions. Resolution order is DENY override → GRANT override → role grant → deny. Use `mustCan(user, area, action)` / `mustDo(user, special)` in routes; `can`/`canDo` return booleans for UI gating.

**Audit** (`src/server/audit.ts`). Every mutation goes through `auditedCreate` / `auditedUpdate` / `auditedSoftDelete` — `settings.ts`'s direct write is the one sanctioned exception. `auditedUpdate` snapshots before and after, and `SNAPSHOT_INCLUDE` decides which relations are pulled into those snapshots. **When you add an auditable entity, extend both `AuditableModel` and `SNAPSHOT_INCLUDE`** — omitting the relations means changes made through join tables never show up in history. `redact()` scrubs keys matching password/token/secret/signatureImage recursively, but treat it as defense-in-depth: don't hand a secret-bearing payload to the audit layer in the first place.

**Deletion is always soft** (`deletedAt`), with active flags for hiding. Hard deletes only in tests. Unique columns on soft-deletable models are unique **only among live rows** (a partial index filtered on `deletedAt IS NULL`), so re-using a deleted code creates a genuinely new row with its own id and its own audit history — there is no revival-on-create, and adding one back is a regression. **Never `findUnique`/`upsert` on such a column**: the generated client still types it unique, so both compile, and `findUnique` silently returns the deleted row. Use `findFirst({ where: { code, deletedAt: null } })`. `tests/partial-unique-sweep.test.ts` enforces both halves.

**Settings** (`src/server/settings.ts`) is a typed zod registry validated on both read and write, guarded with `Object.hasOwn` against prototype keys.

## Constraints that will bite you

- **Client components must not import from `src/server/**`** — it drags `node:async_hooks` and Prisma into the browser bundle. Shared constants go in `src/lib/` (`permission-constants.ts` is the precedent).
- **`src/middleware.ts` runs on the Edge runtime and cannot reach the database.** It is a cookie-*presence* redirect only, and it deliberately re-declares `SESSION_COOKIE` instead of importing it, because importing from `@/server/http` would pull Prisma into Edge. Keep the two literals in sync by hand. Real authorization is `requireUser` + `mustCan` in every route.
- **Any server-rendered page that fetches data must call `requireUser` itself.** The middleware does not authorize it. Phase 1 pages sidestep this by being client components against guarded APIs.
- **Route handler tests must pass ctx**: `handler(request, { params: Promise.resolve({}) })`. The `Handler` type requires it — Next 15's ParamCheck rejects an optional ctx.
- Tests share one database and call `truncateAll()` in `beforeEach`; `vitest.config.ts` sets `fileParallelism: false` to keep that safe. Don't parallelize them.
- **`npx prisma migrate dev` needs a TTY.** It refuses outright in a non-interactive shell — including a Claude Code session driving Bash — with "the environment is non-interactive, which is not supported," and neither `CI=true` nor `--create-only` gets past it (it worked fine before Prisma 7). Without a TTY: `npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script`, read the output in full, hand-write it into a new `prisma/migrations/<timestamp>_<name>/migration.sql`, then apply with the usual two `migrate deploy` calls. That is how this branch's one migration was made (handoff §5.18).

## Working conventions

TDD per task: failing test → implement → pass → commit. Conventional commit messages, ending with the `Co-Authored-By` line already used throughout `git log`.

The Phase 1 process is worth keeping: a fresh subagent per task, an independent spec-and-quality review of each task, fix rounds until approved, then a final whole-branch review before merge. Those per-task reviews caught real bugs the plan itself contained — a plaintext password in an audit payload, a `__proto__` registry crash, silent empty backups. The review loop is not ceremony.

## Environment notes (Fedora)

If Postgres init or the backup container hits `permission denied` on the `./db-init`, `./scripts/backup.sh`, or `./backups` bind mounts, append `:z` to those three mounts in `erp/docker-compose.yml`. Prefer SELinux labels over disabling SELinux. The named `dbdata` volume needs nothing.
