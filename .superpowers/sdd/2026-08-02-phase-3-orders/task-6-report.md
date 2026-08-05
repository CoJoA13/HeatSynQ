# Task 6 report — Loads service (bulk edit/renumber, re-split) + CHECK-constraint hardening

Branch: `phase-3-orders`. Two commits:
- `e0ac99d` — `feat: load editing, renumbering, re-split`
- `a4474c7` — `fix: CHECK constraints keep Part load caps splittable`

Files touched:
- `erp/src/server/order-loads.ts` (new, 184 lines) — `replaceLoads`, `resplitLoads`
- `erp/src/server/orders.ts` (647→1024→1061→1075 lines through Tasks 5→6) — 4 new exports, no
  behavior change
- `erp/tests/order-loads.test.ts` (new, 316 lines, 22 tests)
- `erp/prisma/schema.prisma` — comment update on `Part.loadQty`/`loadWeight` only
- `erp/prisma/migrations/20260803044035_part_load_cap_checks/migration.sql` (new)
- `erp/tests/orders-schema.test.ts` (+73 lines, 4 new tests)

## 1. What was implemented

### `replaceLoads(orderId, input)`

Bulk PUT of an order's Load collection. Zod: `z.array({ loadNumber: int≥1, qty: int≥1
nullable/optional, weight: decimalField(12,2,positive) nullable/optional }.strict().refine(qty ||
weight)).min(1)`. After parsing, `assertContiguousLoadNumbers` (a manual `HttpError(400, "Load
numbers must be 1..N with no gaps or repeats")` check, not a zod refine — the target set size is
the array's own length, which a per-item refine can't see) confirms the loadNumber set is exactly
`{1..N}`.

The write, `applyLoads`, is the two-phase negative-park rewrite the brief specifies: existing Load
rows (fetched ordered by their current `loadNumber`) are matched to the new input by **array
position** and rewritten in place — every surviving row is first parked at a unique negative
loadNumber, then rewritten to its real target (mirrors `reorderSteps`'s `@@unique` technique,
`part-process-steps.ts`). A longer input creates the surplus after parking; a shorter one deletes
the leftover parked rows. `LoadInput` carries no `id` (matches the brief's literal type), so array
position is the only correlation the shape allows — see Concern 1.

### `resplitLoads(orderId)`

Re-runs `splitLoads` on the order's **current** line totals (`lineTotals`, Task 4/5's cents-exact
helper) against the lead part's **current** `loadQty`/`loadWeight`, read live from `Part` inside
the transaction — not whatever they were at order-creation time, which isn't stored anywhere on
`OrderLine` anyway. Writes the result through the same `applyLoads`. Because the loads are
computed directly from the current totals, the sum-mismatch warning can never survive a resplit.

### Warnings

`buildLoadWarnings` = Task 5's `loadsMismatchWarnings(order)` (reused, not retyped) plus, when
`order.travelerPrinted` (already "any `StoredDocument` row exists" — `readDetail`'s own
derivation, no extra query needed), `"A traveler has already printed — print a fresh one"`. Never
blocks either mutator. Both warning strings were byte-compared (`cat -A`) against the brief's
source markdown to confirm the em dash is the identical UTF-8 character, not a look-alike.

### orders.ts exports (no behavior change)

Per the brief's instruction to export rather than duplicate:
- `readDetail(db, id, traffic)` — the shared post-write detail reader.
- `trafficSettings()` — the light-window settings pair `readDetail` needs.
- `loadsMismatchWarnings(order)` — the sum-mismatch warning, reused verbatim.
- `lineTotals(lines)` — parameter type **widened** from `LineInput[]` to `{ qty: number; weight:
  number }[]` (structural, backward-compatible — the function body never touched the other
  `LineInput` fields, and the one existing call site in `createOrder` still satisfies the narrower
  shape). `resplitLoads` needed this because a raw Prisma select returns `OrderLine.weight` as
  `Decimal`, not `number` — mapped to plain numbers locally before calling `lineTotals`, rather
  than re-deriving the cents-sum technique.

## 2. Decisions made where the brief was silent

**"qty or weight" implemented as a zod `.refine()`, not a manual `HttpError`.** Unlike the
1..N-set check (which needs the array's own length — not expressible as a per-item refine), "this
one object needs qty or weight" is a pure shape constraint on a single object, the same kind of
thing `decimalField`'s own `ctx.addIssue` calls express elsewhere in this codebase. Surfaces as
`ZodError`, asserted directly in tests (mirrors `orders.test.ts`'s own `.strict()`-violation
assertions, e.g. `rejects.toBeInstanceOf(ZodError)`) — the brief gave no exact wording for this
one, only "rejects a row with neither qty nor weight."

**`applyLoads` correlates by array position, not identity.** Given `LoadInput` has no `id` field
(the brief's own type), and existing rows are fetched ordered by current `loadNumber`, the Nth
existing row (by that order) is rewritten onto the Nth input row's values. This is what makes the
renumber-swap test's "same row, new number" assertion true, and it's the only correlation the
interface as specified allows — see Concern 1 for the implication.

**Test file for the CHECK-constraint hardening.** The brief didn't name a file. I appended a new
`describe("Part load-cap CHECK constraints …")` block to `tests/orders-schema.test.ts` rather than
creating a new file: it's the established "raw DB-level, phase-scoped" schema test file (parallel
to `schema.test.ts`/`process-schema.test.ts` for earlier phases), and the constraint's whole
justification is protecting `splitLoads` (an orders/loads concern), even though the column lives
on `Part`.

**Verified, not assumed: Prisma has no native `@@check`.** Queried the Prisma docs (Context7)
before writing the migration — confirmed against `prisma/prisma`'s own functional-test source
("CHECK constraints cannot be expressed natively in schema.prisma and must be added via raw SQL")
and an internal note that "the prisma-next PSL/contract does not support defining CHECK
constraints." `schema.prisma` carries a comment on `Part.loadQty`/`loadWeight` pointing at the
migration file instead of a `@@check` attribute.

## 3. TDD evidence

### Loads service

**RED**: wrote `order-loads.ts` and `order-loads.test.ts` together, then temporarily moved
`order-loads.ts` out of the tree and ran the suite — failed with `Cannot find module
'@/server/order-loads'` across the whole file (genuine RED, not a typo in the test). Restored the
file.

**GREEN**: 21/22 passed on the first real run; the one failure was a bug in my own test's
arithmetic (250 pcs @ 40/load is 6 full loads + a 10 remainder = 7 loads, not 6 — I'd mis-divided).
Fixed the test, reran: 22/22.

```
npx vitest run tests/order-loads.test.ts
 Test Files  1 passed (1)
      Tests  22 passed (22)
```

**Extra verification beyond RED→GREEN**: to confirm the renumber-swap test actually exercises the
two-phase mechanism (and isn't accidentally passing some other way), I temporarily deleted the
negative-park loop from `applyLoads` and reran just that test — it failed with a real Postgres
unique-constraint violation (`P2002`, surfaced as `"A order with that value already exists"`),
confirming the test catches a real regression of the documented mechanism. Restored the loop,
reran: 22/22 again.

### CHECK-constraint hardening

**RED**: wrote all 4 tests in `orders-schema.test.ts` (raw `$executeRaw` UPDATE/INSERT attempts)
*before* writing or applying the migration, ran them: all 4 failed with `promise resolved "1"
instead of rejecting` — proving the constraint genuinely didn't exist yet.

**GREEN**: wrote the migration, applied it to both databases (see §4 for one real snag hit along
the way), ran `npx prisma generate`, reran: all 4 pass, plus the file's 3 pre-existing tests
(7/7 total).

```
npx vitest run tests/orders-schema.test.ts
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

One test also asserts the exact SQLSTATE reaches the app: `meta.driverAdapterError.cause
.originalCode === "23514"` — checked empirically against a real constraint violation (not just the
mocked shape `db-errors.test.ts` uses for the *serialization*-failure case), and it matched on the
first attempt.

## 4. The migration — a real snag, and how it was resolved

`npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script`
against the schema-comment-only change produced `-- This is an empty migration.` — confirmed the
CHECK constraints could not be schema-diffed and had to be hand-written, and confirmed no other
drift snuck in. Migration `20260803044035_part_load_cap_checks` (only two `ALTER TABLE … ADD
CONSTRAINT … CHECK (...)` statements) applied cleanly to the dev DB.

Applying it to `erp_test` failed on the first attempt: my own RED-phase run of the "INSERT
attempting loadQty = 0" test had *succeeded* (the constraint didn't exist yet at that point) and
left a `Part` row (`chk-insert-1`, `loadQty = 0`) sitting in the test database — untouched because
`truncateAll()` only runs in each test file's `beforeEach`, not after the process exits. Applying
the migration to `erp_test` hit that row and failed with `23514`, and the failed attempt then
blocked further `migrate deploy` calls with `P3009` until resolved. Confirmed via `\d "Part"` that
neither constraint had partially applied (Prisma wraps a migration's SQL in one transaction), then:
`docker compose exec db psql -U erp -d erp_test -c "DELETE FROM \"Part\" WHERE id = 'chk-insert-1'"`
followed by `npx prisma migrate resolve --rolled-back 20260803044035_part_load_cap_checks`, then a
clean `migrate deploy`. `npx prisma migrate status` reports "Database schema is up to date!" on
both databases afterward. `npx prisma generate` ran clean.

## 5. Full gate results (final, on committed HEAD)

```
npm test              → Test Files 66 passed (66) / Tests 772 passed (772)   [746 baseline + 22 + 4]
npx tsc --noEmit       → clean, no output
npx eslint src tests   → clean, no output
npm run build          → succeeds, standalone build produced
npx prisma migrate status → "Database schema is up to date!" — both erp and erp_test
```

Gates were run and green after EACH commit individually, not just at the end.

## 6. Self-review

- **Every brief Step-1 bullet covered**, several by more than one test:
  - 1..N set validation (400, exact message) — gap + repeat, two tests.
  - Renumber swap, two-phase pattern — covered, AND independently verified to exercise the real
    mechanism (§3, "extra verification").
  - Row with neither qty nor weight — covered (`ZodError`).
  - Resplit rebuilds from **current** lead caps after a qty edit — covered by two tests: one
    editing the line's qty (brief's literal scenario) and a second changing the part's `loadQty`
    directly via raw prisma between order creation and resplit, proving "current" means "read live
    at call time," not "cached from order creation."
  - Traveler-printed warning iff a `StoredDocument` exists, seeded directly via prisma — covered
    for BOTH `replaceLoads` and `resplitLoads`, each with a before/after comparison.
  - Voided order 404s — covered for both mutators with the exact "Order not found" message, plus a
    separate unknown-id 404 test for each (extra rigor, matches Task 5's own practice).
  - Audit diff shows the load change — covered for both mutators, asserting actual before/after
    **content** (load count and per-load qty), not just that an "update" entry exists.
- **Renumber-swap test genuinely swaps under `@@unique`** — confirmed by deliberately breaking the
  park phase and watching the test fail with a real unique-constraint error (§3).
- **Voided 404** — exact message, both mutators, both a voided-order case and a bare-unknown-id
  case.
- **Audit diffs asserted** — content-level assertions in both service test files, not
  entry-existence checks.
- **Warnings exact-text** — byte-compared (`cat -A`) against the brief's source markdown; the
  sum-mismatch string is imported/reused rather than retyped, eliminating that risk entirely for
  itself.
- **Migration purely additive** — two `ADD CONSTRAINT` statements only; `migrate diff` against the
  schema change (a comment) is empty; verified neither constraint partially applied during the
  failed first attempt.
- **No scope creep beyond the two commits** — `git diff --stat 127f184 HEAD` shows exactly 6
  files: the new service, its test, the orders.ts export additions, the schema comment, the
  migration, and the schema-test additions. No routes, no UI, no other server files.

## 7. Concerns to carry forward

1. **`applyLoads` correlates existing rows to new input rows by array position, not by a stable
   client-visible identity.** This is what the brief's `LoadInput` shape (no `id`) implies and
   requires, and it's exactly what makes the two-phase in-place rewrite meaningful rather than
   equivalent to delete+recreate — but it means a caller MUST resend the complete loads array,
   ordered the way it wants the existing rows matched (in practice: loadNumber order), every time.
   A UI that tried to patch "just load 2's qty" by sending a single-element array would instead
   collapse the order down to one load. Worth flagging for whichever later task builds the loads
   editor UI (likely Phase 3's UI tasks) so it always round-trips the full array.
2. **`resplitLoads`'s "lead part no longer exists" 400 is defensive and untested.** `OrderLine
   .partId` is `ON DELETE RESTRICT`, so the row can never be hard-deleted while referenced — only
   soft-deleted, which this lookup doesn't filter against anyway. Forcing the branch would need
   bypassing the FK, which isn't a reasonable test setup, so it's covered by reasoning, not a test.
3. **`orders.ts` is now 1075 lines** (was 1061 after Task 5), grown by the four export/comment
   additions. Still not split, per the same "note it as a concern, don't split unilaterally"
   instruction Task 5's report carried forward — a future whole-branch review's call.
4. **Sequencing hazard, not a design flaw**: a RED-phase test that inserts invalid data via raw SQL
   (to prove a not-yet-applied constraint doesn't exist) can leave rows in the shared `erp_test`
   database that block a subsequent migration attempt against that same table — as happened here
   (§4). Cleaned up this time; worth remembering for any future CHECK/constraint task built the
   same TDD-first way.
5. **Carried, unchanged from Task 5**: `linkOrder`'s group-adoption asymmetry is resolved (owner
   ruling, already fixed); the remaining Task 5 minors (case-2/3 link branches lacking audit-content
   assertions, `updateOrder({})` empty-patch untested, "Order not found" string duplication) are
   untouched by this task and out of its scope.

## 8. Environment notes

Node 26.5.1 via `nvm use 26`; Postgres 18 container already running and healthy at session start
(`erp-db-1`, up 9h). `npx prisma generate` was run twice (once at session start against a fresh
checkout, once after the migration). Baseline before this task: 746 passing (65 files). After:
**772 passing (66 files)** — 746 + 22 (loads service) + 4 (CHECK constraints), 0 removed, 0
skipped.
