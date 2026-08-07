# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

`docs/HANDOFF.md` is the portable project memory and the entry point for any new session — it carries the scope decisions, the model facts, the current phase's state, the current backlog, and the next phase's kickoff instruction. Read it before planning work; it is kept short enough to read in one pass, and keeping it that way is part of the job.

Every **merged** phase's full narrative — its owner rulings, review findings, and the lessons behind them — lives in `docs/history/`, one dated file per phase, moved verbatim out of the handoff when the phase closed. HANDOFF §4 keeps one paragraph per phase and points there. Read a history file only when you need that phase's detail; don't read them all.

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
docker compose up -d db           # Postgres 18; creates erp + erp_test via db-init/
npm install
npx prisma generate                # client is gitignored; generate before typechecking or testing
npx prisma migrate deploy          # dev DB
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
npm run db:seed                   # admin/admin
npm run dev                       # http://localhost:3000
```

Quality gates — every one of these must stay green:

```bash
npm test                          # vitest integration suite against the real erp_test DB
npx tsc --noEmit
npx eslint src tests
npm run test:e2e                  # Playwright flows against `npm run dev` + the DEV db (erp, not erp_test); bundled Chromium
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

**Audit** (`src/server/audit.ts`). Every mutation goes through `auditedCreate` / `auditedUpdate` / `auditedSoftDelete` — `settings.ts`'s direct write is the one sanctioned exception. Phase 3 added two more: the order-draft service (`order-drafts.ts`, pre-entity scratch — spec-authorized, sweep-allowlisted) and `allocateNumber`'s counter bump (the consuming entity's own create entry is the audit trail). `auditedUpdate` snapshots before and after, and `SNAPSHOT_INCLUDE` decides which relations are pulled into those snapshots. **When you add an auditable entity, extend both `AuditableModel` and `SNAPSHOT_INCLUDE`** — omitting the relations means changes made through join tables never show up in history. `redact()` scrubs keys matching password/token/secret/signatureImage recursively, but treat it as defense-in-depth: don't hand a secret-bearing payload to the audit layer in the first place.

**Row locks, not isolation levels, guard cross-transaction invariants.** `workingRevision` and `lockCurrentRevision` (`part-process-steps.ts`) and `claimOrder` (now in the leaf module `src/server/order-locks.ts`) all claim their row with `SELECT … FOR UPDATE` before reading the state they act on. The lock works at ANY caller isolation; making one side Serializable is never a substitute (Postgres only serializes transactions that are all Serializable). Order mutations, traveler prints, revision cuts, and every shipment/cert mutation all serialize through these claims — do not bypass them with a bare read, and do not "simplify" a claim into a plain `findFirst`.

**Multi-order writes claim through `claimOrdersInOrder`, one sorted statement.** A write touching several orders (a multi-order shipment save, its void, its child replaces) must claim them via `claimOrdersInOrder(tx, orderIds)` (`order-locks.ts`): deduplicated, ascending, and locked in ONE `SELECT … WHERE id = ANY(…) ORDER BY "id" FOR UPDATE` statement. A loop of per-row `claimOrder` calls — even a sorted loop — reopens the ABBA deadlock window between statements; the single ordered statement is the shape that closes it (`EXPLAIN` shows `LockRows` above `Sort`). Never add a second, differently-ordered claim path. **The guarded state must live on, or be locked with, the claimed row**: if the invariant you check after a claim lives on a different row (a cert's or shipper's `deletedAt`), lock that row too, uniformly after the order claims — a Serializable snapshot fixed before the claim will otherwise re-read stale state, and SSI only saves you by accident (Phase 4's whole-branch review found print-vs-void completely unprotected this way).

**Deletion is always soft** (`deletedAt`), with active flags for hiding. Hard deletes only in tests. Unique columns on soft-deletable models are unique **only among live rows** (a partial index filtered on `deletedAt IS NULL`), so re-using a deleted code creates a genuinely new row with its own id and its own audit history — there is no revival-on-create, and adding one back is a regression. **Never `findUnique`/`upsert` on such a column**: the generated client still types it unique, so both compile, and `findUnique` silently returns the deleted row. Use `findFirst({ where: { code, deletedAt: null } })`. `tests/partial-unique-sweep.test.ts` enforces both halves. Five columns are deliberately plain `@unique` on soft-deletable models — `Order.orderNumber`/`clientRequestId` and `Shipper.shipperNumber`/`bolNumber`/`clientRequestId` — because voided rows keep them forever and they are never re-entered (allocation-only / idempotency-key). All five carry documented sweep exemptions beside `User.username`; do not convert them to partial-unique. **`Cert` has no unique column at all and adds no sweep exemption** — a cert carries no number of its own (spec §3.19; its label is its order number + scope instance), and one-live-cert-per-scope-instance is service-enforced under the order claim, not indexed (Postgres treats NULLs as distinct, so no index could express it). Do not "fix" either by adding a column.

**Shipper children and cert requirements snapshot what they print (snapshot + release, owner rulings 23–24, 2026-08-06).** `ShipperLine`/`ShipperContainer`/`ShipperSerial`/`CertRequirement` carry snapshot columns (part number/name/description + ordered totals; container type/customer id; serial/description; line position + part identity) captured at save/seed time, and their FKs to the order-side rows are nullable `ON DELETE SET NULL` — order corrections (`removeLine`, `replaceContainers`, `replaceSerials`) must never be blocked by a shipment or cert reference. **Every code path that creates one of these child rows must populate the snapshot columns** (NOT NULL where the paper needs them), reads go live-join-first with snapshot fallback (`toDetail` in shippers.ts, `toCertDetail` in cert-results.ts), released rows (null FK) render read-only in the shipment grids, and shipper-side replaces preserve them (delete only rows with a live FK). Don't "simplify" a fallback away, and don't re-tighten the FKs.

**Settings** (`src/server/settings.ts`) is a typed zod registry validated on both read and write, guarded with `Object.hasOwn` against prototype keys.

## Constraints that will bite you

- **Client components must not import from `src/server/**`** — it drags `node:async_hooks` and Prisma into the browser bundle. Shared constants go in `src/lib/` (`permission-constants.ts` is the precedent).
- **`src/proxy.ts` runs on the Edge runtime and cannot reach the database.** (Next 16 renamed the `middleware` file convention to `proxy` — same execution model and same `config.matcher`, only the file and exported function names changed.) It is a cookie-*presence* redirect only, and it deliberately re-declares `SESSION_COOKIE` instead of importing it, because importing from `@/server/http` would pull Prisma into Edge. Keep the two literals in sync by hand. Real authorization is `requireUser` + `mustCan` in every route.
- **Any server-rendered page that fetches data must call `requireUser` itself.** The proxy does not authorize it. Phase 1 pages sidestep this by being client components against guarded APIs.
- **Route handler tests must pass ctx**: `handler(request, { params: Promise.resolve({}) })`. The `Handler` type requires it — Next's ParamCheck rejects an optional ctx (true through 15 and 16).
- Tests share one database and call `truncateAll()` in `beforeEach`; `vitest.config.ts` sets `fileParallelism: false` to keep that safe. Don't parallelize them.
- **`StoredDocument`'s kind→owner rule is a hand-written DB `CHECK`, not schema syntax.** Prisma's schema language has no check constraints, so `StoredDocument_kind_owner_check` is created in `prisma/migrations/20260804122700_certs_and_shipping/migration.sql` and **re-stated whole** in `prisma/migrations/20260806221500_pricing_and_invoicing/migration.sql` — the latter is the current definition (TRAVELER needs `orderId`; SHIPPER needs `shipperId` with `orderId` as an optional sub-scope — which order's ticket, null = the whole set — deliberately looser, do not "tighten" it; BOL needs `shipperId` alone; CERT needs `certId` alone; INVOICE and CREDIT need `invoiceId` alone). Adding a `DocumentKind` means a new migration DROPping and re-ADDing the CHECK **and** the `DocumentOwner` union + `AREA_FOR_KIND` in `src/server/documents.ts`; keep schema comment and SQL in step by hand. **The `ADD VALUE`s go in their own, earlier migration directory** — Postgres refuses to use a new enum value in the transaction that added it, and `migrate deploy` runs one directory per transaction (`20260804122600_document_kind_values`, `20260806221400_document_kind_invoice_values`).
- **`BillingConfig` is a one-row table by construction** — `CHECK ("id" = 'singleton')`, same migration and same style, with the row itself seeded by that migration so `getBillingConfig` is a plain `findFirst` and never a lazy create (P5A spec §4.5). `truncateAll()` (`tests/helpers/db.ts`) re-seeds it after the TRUNCATE for exactly that reason; don't drop that line.
- **`npx prisma migrate dev` needs a TTY.** It refuses outright in a non-interactive shell — including a Claude Code session driving Bash — with "the environment is non-interactive, which is not supported," and neither `CI=true` nor `--create-only` gets past it (it worked fine before Prisma 7). Without a TTY: `npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script`, read the output in full, hand-write it into a new `prisma/migrations/<timestamp>_<name>/migration.sql`, then apply with the usual two `migrate deploy` calls. Every migration since Prisma 7 has been made this way (handoff §5.18); Phase 3 added four more with it.
- **Never `vi.spyOn` a Prisma model delegate** — `mockRestore()` does not put the original method back on this client, silently corrupting the shared `prisma` singleton for every later test in the run. Stub with plain property save/restore instead.
- **`renderPdf` output is not byte-deterministic across calls.** Tests that compare freshly rendered PDFs must pin content (e.g. the uncompressed `/Count N` page marker), never `Buffer.compare` two renders. Comparing STORED bytes on reprint is exact by design and stays `Buffer.compare`.
- **pdfmake's browser build wants a global `window` and will not run under Node.** Server-side PDF rendering (the traveler, `src/server/pdf/render.ts`) has to use pdfmake's actual Node entry, `PdfPrinter` (`pdfmake/src/printer.js`), fed font buffers decoded from pdfmake's own bundled vfs rather than the file paths `PdfPrinter` normally wants — nothing then has to survive `output: "standalone"`'s file tracing. That needs `next.config.ts`'s `serverExternalPackages: ["pdfmake", "bwip-js"]` alongside it: both are CJS with their own `require` graphs and megabytes of embedded font/barcode data the bundler would otherwise inline into every route that touches a document.

## Working conventions

TDD per task: failing test → implement → pass → commit. Conventional commit messages, with **no attribution trailer on individual commits** — owner's instruction, 2026-08-01. Every branch is squash-merged, so a per-commit `Co-Authored-By` / `Claude-Session` line gets concatenated N times into one squash message. Attribution goes in the **PR body**, where the squash preserves it exactly once. (Commits before 2026-08-01 carry the trailer; that is history, not the convention.)

The Phase 1 process is worth keeping: a fresh subagent per task, an independent spec-and-quality review of each task, fix rounds until approved, then a final whole-branch review before merge. Those per-task reviews caught real bugs the plan itself contained — a plaintext password in an audit payload, a `__proto__` registry crash, silent empty backups. The review loop is not ceremony.

**When to stop reviewing** (owner ruling, 2026-08-06, after Phase 4's seventh round). Review of review-fixes converges slowly — roughly half the findings in a late round are in code written for the previous round — and an LLM reviewer has no natural zero: severity converges, count never does. So from round 6 onward, findings are triaged to issues **unless they are correctness, concurrency, or data-integrity defects**. Do not read a non-empty round 7 as "not ready to merge."

**The execution record goes in `docs/execution/<date>-<phase>/`, and gets committed on the first task — not at the end.** Task briefs, implementer reports, reviewer verdicts and the progress ledger are the only account of *why* each task landed as it did, and none of it is reproducible from source. They used to live in `.superpowers/sdd/`, whose `.gitignore` is owned and rewritten by the SDD skill machinery: it has been clobbered back to a bare `*` repeatedly — twice across sessions and once *within* one — which hides every **untracked** file beneath it from `git status` and `git add`. That is how Phase 3's record was lost and how Phase 5A's nearly was. Two facts drive the rule: git applies ignore rules **only to untracked paths** (so a committed file is permanently immune, and the whole exposure window is "created but not yet committed"), and a nested `.gitignore` always beats the root one, so the root's `!.superpowers/sdd/` cannot rescue it. Committing early closes the window; `docs/execution/` keeps it closed. The `review-*.diff` packages stay in `.superpowers/sdd/` and stay ignored — they regenerate from two commits already in history. Historical phase ledgers stay where they are; they are already committed, hence already immune.

**Run `npm run test:e2e` whenever a change touches any UI, function, or flow** — even incidentally, and even when the flow isn't what you were fixing (owner instruction, 2026-08-06). Server-side fixes routinely alter behavior the Playwright flows exercise (warnings, headers, guards) that the unit gates never see. It needs the dev server and the DEV database (`erp`, not `erp_test`).

**Updating the docs is part of the work, not a follow-up** (owner instruction, 2026-08-06). A change that alters a decision, a convention, or the state of the build updates `docs/HANDOFF.md`, the spec's decision log (§15, if it amends the contract), and this file in the same breath — **without asking permission first**, and never deferred to the closing summary. Match each document's existing entry format.

**Maintaining this file.** No counts, totals, or version numbers that ordinary commits move (test tallies, E2E flow counts, migration counts) — say what a command does, not how much it currently runs; the moving numbers belong in `docs/HANDOFF.md`, where they are dated. Keep it curated at roughly its current length: new guidance should displace guidance it supersedes, not be appended beneath it.

## Environment notes (Fedora)

If Postgres init or the backup container hits `permission denied` on the `./db-init`, `./scripts/backup.sh`, or `./backups` bind mounts, append `:z` to those three mounts in `erp/docker-compose.yml`. Prefer SELinux labels over disabling SELinux. The named `dbdata` volume needs nothing.
