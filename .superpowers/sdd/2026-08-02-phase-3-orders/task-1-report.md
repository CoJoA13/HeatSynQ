# Task 1 report — Order schema

Status: **DONE**

## What I implemented

Per `docs/superpowers/specs/2026-08-02-phase-3-orders-design.md` §4, copied verbatim into
`erp/prisma/schema.prisma` after `ProcessTemplateStep`:

- Enums `OrderStatus` (OPEN + four Phase-4/5-reserved values) and `DocumentKind` (TRAVELER only).
- Models `Order`, `OrderLine`, `OrderContainer`, `OrderSerial`, `Load`, `OrderCharge`,
  `PartAttachment`, `OrderDraft`, `SavedView`, `StoredDocument`.
- `OrderAttachment`, expanded from the spec's one-line mirror comment into the full
  `PartAttachment` shape keyed on `orderId`/`order Order @relation(...)` instead of `partId`/`part`.
- Columns `Customer.requestDaysOverride Int?` (placed after `financeChargeRate`, before `active`)
  and `Part.requestDaysOverride Int?` (placed after `loadWeight`, before `serializationRequired`).
- Back-relations: `User.orderDraft OrderDraft?` + `User.savedViews SavedView[]`;
  `Customer.orders Order[]`; `Part.orderLines OrderLine[]` + `Part.attachments PartAttachment[]`;
  `ContainerType.orderContainers OrderContainer[]`.
- No `onDelete` added anywhere new (Prisma's own default — RESTRICT on required relations —
  applies, matching every other required-FK in the schema). `SavedView`'s partial `@@unique` is
  one line. `Order.orderNumber` is a plain `Int @unique` (deliberate, per spec).
- Ran `npx prisma format` after the hand-edit to align columns with the file's existing
  convention; `npx prisma validate` confirmed the result parses.

**Migration** — `erp/prisma/migrations/20260803003105_orders_and_loads/migration.sql`, produced
via `npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script`
(the TTY-less recipe; `migrate dev` refuses in this shell) and hand-copied into the timestamped
file. Verified purely additive: 2 `CREATE TYPE`, 2 `ALTER TABLE … ADD COLUMN`, 11 `CREATE TABLE`,
all the spec's indexes including the partial unique
`CREATE UNIQUE INDEX "SavedView_userId_name_key" ON "SavedView"("userId","name") WHERE
("deletedAt" IS NULL)`, and every new FK at `ON DELETE RESTRICT ON UPDATE CASCADE` (Prisma's
default for a required relation with no explicit `onDelete`). Applied to both `erp` and
`erp_test` via `prisma migrate deploy`; `npx prisma generate` regenerated the client;
`npx prisma migrate diff` against the dev DB afterward reported "This is an empty migration" —
confirms zero drift. `npx prisma migrate status` reports "up to date" on both databases.

**Sweep exemption** — `erp/tests/partial-unique-sweep.test.ts`'s `ALLOWED` set (the
"every soft-deletable model's unique columns are live-rows-only" test) now carries
`"Order.orderNumber"` beside `"User.username"`, with a comment explaining the no-reuse rationale
(voided orders keep their number forever; allocation-only, spec §4) and why it must not be given
the partial-unique treatment.

**Registry entry** — `erp/src/lib/reference-links.ts`: `"orderContainer"` added to
`ReferenceLinkModel`; the `orderContainer.typeId -> containerType` entry added to
`REFERENCE_LINKS` exactly as specified in the brief (label "Container", entityLabel "Order",
`liveWhere`/`include`/`blockerId`/`displayName` reading through the order to `#1042 · ACME`
formatting). This is the only new FK in the phase-1 schema that targets a `ReferenceKind`.

**Audit surface** — `erp/src/server/audit.ts`: `AuditableModel` gains
`"order" | "partAttachment" | "orderAttachment" | "savedView" | "storedDocument"`.
`SNAPSHOT_INCLUDE.order` pulls lines (ordered by position, with live part number), containers
(ordered by position, with live type name), serials (ordered by lineId then position), loads
(ordered by loadNumber), and charges (ordered by position) — every collection explicitly
`orderBy`'d per the issue #24 lesson. The four attachment/draft-adjacent models
(`partAttachment`, `orderAttachment`, `savedView`, `storedDocument`) snapshot with no included
relations (`undefined`), matching how other leaf/own-row-audited models are declared.
`redact()`'s `sensitiveKeyPatterns` gained `"filedata"` so attachment/document snapshots never
embed file bytes into `AuditLog`.

**Schema smoke test** — `erp/tests/orders-schema.test.ts`, modeled on
`tests/process-schema.test.ts`: a full graph round-trip (order → line → serial; container →
type; load; charge; draft; saved view; stored document; one attachment of each kind, read back
through both `Order`'s and `Part`'s relations), the `orderNumber` no-reuse contract (a duplicate
is rejected even once the first order is soft-deleted — the opposite of every partial-unique
column elsewhere), and `SavedView.name` unique only among live rows per user.

## One fix outside the brief's literal file list (necessary, not scope creep)

The brief's Files section doesn't list `tests/reference-links-sweep.test.ts` as something to
modify — only "run it, green." But that file's "finds every known reference FK when nothing is
registered" test walks the *entire* schema (not the registry) with an empty registered-set and
asserts against a hardcoded, alphabetically-sorted array of every FK pointing at a reference
kind. Adding `OrderContainer.typeId -> ContainerType` makes that walk find an 11th entry
regardless of whether it's registered, so the hardcoded array needed
`"orderContainer.typeId -> containerType"` inserted in sorted position (between
`inspectionCode...` and `part.materialId...`). Without this the "registered" test passes but
this completeness fixture fails — leaving it broken would violate "run the sweep — green."
Fixed and verified; documented here since it wasn't in the brief's file list.

## Testing and results

All commands run from `erp/`, Node 26 (`nvm use 26` — the harness's default non-login shell
resolves system Node 22, so every command below actually ran via `bash -lc '...'` to pick up
nvm's default).

- `npx vitest run tests/orders-schema.test.ts` — 3/3 pass.
- `npx vitest run tests/partial-unique-sweep.test.ts` — 2/2 pass (see TDD evidence below).
- `npx vitest run tests/reference-links-sweep.test.ts` — 10/10 pass.
- `npm test` (full suite) — **588/588 pass, 59 files**, no failures, no stray warnings
  (grepped the full run for `warn|deprecat|error`; the only hits were the file names
  `db-errors.test.ts`/`errors.test.ts`).
- `npx tsc --noEmit` — clean, exit 0.
- `npx eslint src tests` — clean, exit 0.
- `npm run build` — compiles successfully (not one of the three mandatory gates per CLAUDE.md,
  but run as an extra confidence check since this is a schema-heavy change); exit 0, no errors
  or warnings.
- `npx prisma migrate status` — "Database schema is up to date!" on both `erp` and `erp_test`.
- `npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script`
  against the dev DB post-migration — "This is an empty migration," confirming no drift.

## TDD evidence

### Sweep exemption (Step 3)

**RED** — before adding `"Order.orderNumber"` to the allowlist (schema already had
`Order.orderNumber Int @unique` on a soft-deletable model):

```
$ npx vitest run tests/partial-unique-sweep.test.ts
 × partial unique sweep > every soft-deletable model's unique columns are live-rows-only
   AssertionError: These columns are @unique (or a bare @@unique([...]) block) on a
   soft-deletable model. ...: expected [ 'Order.orderNumber' ] to deeply equal []
   - Expected: []
   + Received: [ "Order.orderNumber" ]
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
```

Expected: the sweep exists specifically to flag a plain `@unique` column on a soft-deletable
model (handoff §5.18's revival-on-create precedent) — `Order.orderNumber` is exactly that
shape, and this proves the sweep genuinely bites on it before the exemption exists.

**GREEN** — after adding the exemption with its rationale comment:

```
$ npx vitest run tests/partial-unique-sweep.test.ts
 ✓ tests/partial-unique-sweep.test.ts (2 tests) 7ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

This RED→GREEN pair *is* the "verify both, keep the exemption" instruction: the failing run
above is the "temporarily unexempted" state (I never had to re-remove it afterward — the natural
add sequence already produced both data points), and the passing run is the kept, final state.

### Registry entry (Step 4)

Steps 1 and 4 were implemented together, so there was no natural pre-registration RED state to
capture in the moment (by the time I first ran this sweep, the schema, the registry entry, and
the exhaustive-list fixture fix were all already in place, and it went straight to green). To
avoid asserting evidence I hadn't actually gathered, I reproduced RED honestly after the fact:
temporarily deleted the `orderContainer` entry from `REFERENCE_LINKS` (`src/lib/reference-links.ts`,
keeping the `ReferenceLinkModel` union untouched), ran the sweep, restored the entry, and
confirmed the restored file is byte-identical to the committed version (`git diff --stat` on the
file produced no output; `git status` afterward showed a clean tree).

**RED** — `orderContainer` entry removed from `REFERENCE_LINKS`:

```
$ npx vitest run tests/reference-links-sweep.test.ts
 × reference links sweep > every schema foreign key pointing at a reference table is registered
   AssertionError: These foreign keys point at a reference table but are missing from
   REFERENCE_LINKS in src/lib/reference-links.ts. ...
   - Expected: []
   + Received: [ "orderContainer.typeId -> containerType" ]
 Test Files  1 failed (1)
      Tests  1 failed | 9 passed (10)
```

Expected: this is exactly the failure the sweep exists to catch — an FK against a registered
reference kind (`containerType`) with no registry entry, which would otherwise silently mean no
delete protection and no name resolution for `OrderContainer.typeId`.

**GREEN** — entry restored:

```
$ npx vitest run tests/reference-links-sweep.test.ts
 ✓ tests/reference-links-sweep.test.ts (10 tests) 7ms
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

### Schema smoke test (Step 6)

Written against the already-migrated schema (this is infrastructure, not behavior with a
meaningful pre-implementation RED state — same as `process-schema.test.ts`'s own shape). First
run:

```
$ npx vitest run tests/orders-schema.test.ts
 ✓ tests/orders-schema.test.ts (3 tests) 248ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

## Files changed

- `erp/prisma/schema.prisma` — modified (back-relations + 2 columns + 2 enums + 11 models).
- `erp/prisma/migrations/20260803003105_orders_and_loads/migration.sql` — new.
- `erp/tests/partial-unique-sweep.test.ts` — modified (allowlist entry).
- `erp/tests/reference-links-sweep.test.ts` — modified (exhaustive-FK-list fixture entry).
- `erp/src/lib/reference-links.ts` — modified (`ReferenceLinkModel` + registry entry).
- `erp/src/server/audit.ts` — modified (`AuditableModel`, `SNAPSHOT_INCLUDE`, `redact()`).
- `erp/tests/orders-schema.test.ts` — new.

Commit: `646872a feat: order schema — eleven tables, request-day overrides, registry + sweep coverage`
(no attribution trailer, per convention).

## Self-review findings

- **Completeness**: all 7 brief steps done. Cross-checked the brief's text against
  `docs/superpowers/plans/2026-08-02-phase-3-orders.md`'s own Task 1 section — identical, so no
  drift between the extracted brief and the source plan.
- **Placement judgment calls** (brief didn't specify exact field position within a model, only
  that the column exists): `Customer.requestDaysOverride` sits after `financeChargeRate`
  (grouping it with the other "additional business rule" scalars, keeping the `defaultPo` →
  `invoiceNotes` notes cluster intact); `Part.requestDaysOverride` sits after `loadWeight`
  (grouping it with the other order-entry-relevant per-part numbers). Neither placement affects
  behavior; flagging in case a reviewer wants a different grouping.
- **Quality**: comments on the new schema blocks and `SNAPSHOT_INCLUDE.order` entry follow the
  file's existing density/tone (explaining *why*, citing spec sections and issue numbers, not
  restating the code). Fixed one style slip during self-review: my first draft of
  `orders-schema.test.ts` used `--` in test titles and a comment where the codebase convention
  (confirmed by grepping ~10 other test files) is an em dash — corrected before running anything.
- **Discipline**: did not touch `src/server/customers.ts`, `src/server/parts.ts`, or any UI —
  the brief's Files list scopes this task to schema/migration/registry/audit/sweep only; the
  zod validation and detail-page fields for `requestDaysOverride` are later tasks (roadmap
  places the UI half at Task 14). Did not add service-level `orders.ts`/routes — Task 4+. The one
  deviation from the literal file list (`reference-links-sweep.test.ts`'s exhaustive-list fixture)
  was load-bearing for the brief's own "run it — green" instruction, not scope creep.
- **Testing**: the smoke test exercises real Postgres constraints (the plain unique index on
  `orderNumber` catching a duplicate post-soft-delete; the partial unique index on `SavedView`
  permitting a repeat name only after the first is soft-deleted), not just Prisma-level shape —
  both assertions would fail if the migration's SQL didn't match the schema's declared
  constraints exactly. Output is pristine across the full 588-test suite.

## Issues or concerns

None. All three mandatory gates (`npm test`, `npx tsc --noEmit`, `npx eslint src tests`) are
green, plus `npm run build` as an extra check. Both databases are migrated and drift-free.
