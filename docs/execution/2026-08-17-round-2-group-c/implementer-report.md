# Round 2 Group C — implementer reports

## #65 — reversal-aware void

**Branch:** `group-c-shipping-status` · **Commits:** `3742a87` (migration), `281cc42` (reversal
stores cleared ids), `8d162a2` (reversal-aware voidShipper), `6e56779` (detail flag + UI).
Implemented exactly the brief's "Design — #65" mechanism; no redesign.

### What changed, file by file

- **`erp/prisma/schema.prisma`** — `Shipper.reversalClearedLineIds String[] @default([])`, with a
  doc comment stating the immutable-snapshot contract (written once at creation, read by the void
  restore, `[]` on non-reversals / nothing-cleared / pre-#65 rows).
- **`erp/prisma/migrations/20260817225536_shipper_reversal_cleared_line_ids/migration.sql`** — the
  migration (created via the `create-migration` skill's TTY-less diff flow; SQL reviewed in full:
  one purely additive `ADD COLUMN … TEXT[] DEFAULT ARRAY[]::TEXT[]`). Applied to BOTH `erp` and
  `erp_test`; `migrate status` clean on both; `npx prisma generate` re-run.
- **`erp/src/server/shippers.ts`**
  - `reverseShipperInTx`: `completeLineIds` hoisted from step 6b up to step 6 and stored as
    `reversalClearedLineIds` on the reversal's create; also added to `reverseAuditPayload` so the
    create entry's after-snapshot describes the row it created. Step 6b now consumes the hoisted
    value (behavior unchanged).
  - `claimShipperRows(tx, ids)` added beside `claimShipperRow`: deduplicated ascending
    (`sortedClaimIds`, reused from order-locks.ts), ONE
    `SELECT "id" FROM "Shipper" WHERE "id" = ANY(…) ORDER BY "id" FOR UPDATE` — the
    `claimOrdersInOrder` shape applied to Shipper rows. Other mutators' single-row
    `claimShipperRow` claims untouched.
  - `voidShipper` rewritten reversal-aware: pre-claim stub reads discover the pair ids (a
    reversal's original unconditionally; an original's LIVE reversals), then
    `claimOrdersInOrder` over the target's own orders, then `claimShipperRows` over target +
    pair (uniformly AFTER the order claims), then the liveness re-read. `refuseIfInvoiced` stays
    FIRST. New blocker: an original with a live reversal is refused 400 —
    `This shipment has been reversed by Packing List N — void the reversal first` — with the
    brief's global-invariant argument stated in the comment. New restore: voiding a reversal
    restores `lineComplete: true` on the original's lines named by `reversalClearedLineIds`
    (skipped when the original is itself voided; filtered to currently-false rows so no no-op
    audit entry — step 6b's own discipline), via `auditedUpdate("shipper", originalId, …)` with
    the void reason. Existing cert cascade and two-arg `recomputeOrderStatus` unchanged.
  - `ShipperDetail` gains `reversedByShipperNumber: number | null` (live reversal's packing-list
    number, via a `reversedBy` filtered take-1 join in `DETAIL_INCLUDE`).
- **`erp/src/app/shipping/[id]/ShipmentDetail.tsx`** — local mirror type gains the field;
  `voidGate` renders Void disabled-with-title naming the blocker for an original with a live
  reversal (§5.16). A reversal's own field is always null (a reversal cannot be reversed), so
  Void stays ENABLED on reversal documents — the blessed undo. Server refusal remains the
  enforcement.
- **`erp/tests/shipper-reverse.test.ts`** — 2 new tests (storage of cleared ids; `[]` when
  nothing was complete).
- **`erp/tests/shipper-void.test.ts`** — new `describe("voidShipper — reversal-aware (#65)")`
  (9 tests), plus a house-legal ship-ledger boundary wrap (`vi.fn(actual.recomputeOrderStatus)`,
  the shipper-reverse.test.ts precedent) and copied invoiced-fixture pieces (copying across test
  files is the repo convention).

### How each test was RED-verified

Pre-implementation reds were watched fail against the committed pre-fix code; post-implementation
reds were produced by a momentary deliberate wrong implementation, watched fail, then reverted
(`git checkout` against the committed correct code) — the suite re-ran green after every revert.

| Test | RED evidence |
|---|---|
| reverse records cleared ids | Pre-impl: failed `[] !== [lineId]` (column existed, nothing wrote it) |
| reverse records `[]` when nothing complete | Post-impl mutation: store ALL line ids instead of complete ones → failed `[lineId] !== []` |
| void-reversal restores flags, order → SHIPPED | Pre-impl: failed — status stuck PARTIAL_SHIPPED (the issue's first half) |
| restore is an audited update with the void reason | Pre-impl: failed — latest update entry on the original was the clear's, reason `wrong parts loaded` |
| refuse void-of-original naming the packing list | Pre-impl: failed — the void succeeded (the issue's second half) |
| void-of-original allowed once reversal voided | Post-impl mutation: blocker's `deletedAt: null` dropped (over-blocking) → failed |
| net shippedTotals never negative through the sequence | Pre-impl: failed at the refused-void step (void succeeded, net would go −10) |
| legacy `[]` reversal restores nothing but recomputes | Post-impl mutation: restore ignores stored ids, restores from live data → failed (flag restored + extra audit entry) |
| invoiced pair refused both sides with refuseIfInvoiced's message | Post-impl mutation: blocker moved BEFORE `refuseIfInvoiced` → failed (message said "reversed by Packing List") — proves guard order |
| detail carries `reversedByShipperNumber` | Pre-impl: failed `undefined !== 1001` |
| pair-void concurrency: void of reversal blocks on a holder of the ORIGINAL's row | Pre-impl: failed `'settled' !== Symbol(timed out)`; ALSO post-impl mutation `claimShipperRows(tx, [id])` → same discriminating failure. Deterministic Read Committed holder (the shipper-reverse claim-test technique), not a race harness |

Process note, for honesty: mid-red-verification a `git checkout -- src/server/shippers.ts`
reverted the then-uncommitted voidShipper implementation; it was re-applied identically from the
session's own edit record, re-run green, and committed (`8d162a2`) before the remaining
red-verifications, which all ran as mutations of that committed state.

### Gate results

- `npm test` — **183 files, 3139 tests, all passed** (398s), run after all code commits.
- Targeted: `tests/shipper-void.test.ts` (16) + `tests/shipper-reverse.test.ts` (16) — 32 passed.
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.
- `npx prisma migrate status` — no pending migrations on `erp` or `erp_test`.
- `npm run test:e2e` — **all 23 flows passed** (exit 0), including `void-shipment`,
  `ship-partial-then-complete` and `multi-order-shipment`. Run now because the change touches UI
  (CLAUDE.md owner instruction); the group brief's group-end run still applies after later tasks.

### Deviations from the brief

1. **The detail field carries the NUMBER, not a bare boolean.** The task summary suggested
   `hasLiveReversal: boolean`; §5.16 requires the disabled button's title to NAME the blocker, and
   a boolean cannot name Packing List N. `reversedByShipperNumber: number | null` subsumes the
   boolean (null ⇔ false) and lets the UI title match the server refusal word-for-word.
2. `reverseAuditPayload` also records `reversalClearedLineIds` (not required, but the create
   entry's after-snapshot should describe the column now being written).
3. No HANDOFF/CLAUDE.md edits: the owner ruling was already recorded in spec §15 at kickoff
   (`40e1054`), and `claimShipperRows` is an application of the existing documented lock rules
   (one sorted statement; Order rows first, then the entity's own rows), not a new convention.

### Brief-vs-code findings

None — the brief's ground-truth recon matched the code exactly (step 6b computed
`completeLineIds` as described; `recomputeOrderStatus` skips INVOICE_OWNED so the void path needs
no new direct status writes; `refuseIfInvoiced` covers invoiced pairs on both sides). The
adjacent hole the brief flags (editing a reversed original's lines can drive the net ledger
negative — out of #65's scope) is filed as
[#139](https://github.com/CoJoA13/HeatSynQ/issues/139).

### Review round 1 (task-reviewer) + fix wave

**Verdict: Spec Compliance ✅ · Task quality Approved.** Zero Critical. The reviewer independently
confirmed the isolation story (at Read Committed the pair lock + fresh re-read still catch a racing
reversal, so the SSI comment covers only Serializable's fixed-snapshot window — a coverage wish,
correctly a comment), judged the double-reversal edge unreachable in honest data and benign on
corrupt data (pair-2's cleared ids are computed against already-cleared flags; the
`lineComplete: false` filter makes any overlap a no-op), and verified the human's-re-decision
semantics do what spec §15 ruled.

**One Important finding, fixed on-branch the same round:** the restore/recompute claim-set comment
assumed a reversal's membership is immutable, and nothing enforces that explicitly. The fix widens
`voidShipper`'s claim set **by construction**: the cleared lines' order ids are discovered
pre-claim and unioned into the order claims, `refuseIfInvoiced`, and the recompute — so the restore
is covered under any membership shape, with no dependence on how the reversal got that way.

**What building the regression test taught:** there is NO product path that shrinks a reversal's
membership today — `removeOrderFromShipper` on a reversal is refused by the
at-least-one-positive-line survivor invariant (`shippers.ts` ~1088), because every reversal line is
negative. That protection is INCIDENTAL (the guard exists for an unrelated document invariant), the
same accidental-protection shape #65 itself existed to close, so the union stays and the test pins
the union against a directly-shrunk membership (raw deletes — the state any future relaxation of
that unrelated guard would produce). Recorded on #139, whose class covers both sides of the pair.

**Also from the review's minors:** the restore-audit test now asserts CONTENT, not existence — the
entry's before/after snapshots must show the flag flipping (`lineComplete` false → true).

**RED verification of the fix wave:** the union test was watched to fail against a
deliberately-dropped union (order B stuck PARTIAL_SHIPPED — the exact stale-status hazard); the
audit-content assertions were watched to fail against a wrong-direction restore
(`lineComplete: false`), each then reverted. Green: 33/33 across both shipper test files,
`tsc`/`eslint` clean.

## #52 — print-time coverage

Whole-shipment paper (a whole-set shipping ticket, a BOL) now records at print time which member
orders its render covered, and `listDocumentsForOrder` reads that recorded coverage — never the
shipment's editable current membership. Owner ruling implemented exactly: membership stays
editable after a print; the newcomer's coverage comes from printing fresh paper.

### What changed, file by file

- `erp/prisma/schema.prisma` + `erp/prisma/migrations/20260817234046_stored_document_covered_order_ids/migration.sql`
  — `StoredDocument.coveredOrderIds String[] @default([])`, NOT an owner column (the
  `templateVersionId` precedent; the hand-written kind→owner CHECK is untouched, no enum change).
  The migration's second statement backfills every pre-existing whole-set row
  (`kind IN ('SHIPPER','BOL') AND "shipperId" IS NOT NULL AND "orderId" IS NULL`) with its
  shipment's CURRENT member order ids, ordered by ticket position — stated in the SQL comment as
  the best available approximation for paper whose true at-print set was never recorded.
- `erp/src/server/documents.ts` — `DocumentOwner` splits the SHIPPER variant: a per-order ticket
  (`orderId: string`) carries no list (its covered order IS its `orderId`); the whole-set variant
  (`orderId: null`) and `BOL` REQUIRE `coveredOrderIds`, so a whole-set store cannot forget
  coverage at compile time. `ownerColumns` maps it (every other kind stores `[]`), which also puts
  the recorded coverage in the create's audit payload for free. `listDocumentsForOrder`'s last OR
  branch is now `{ orderId: null, coveredOrderIds: { has: orderId } }`; the relation-derived
  `shipper: { orders: { some: { orderId } } }` branch is deleted. Per-order branch `{ orderId }`
  untouched — sibling exclusion (the round-4 finding) preserved.
- `erp/src/server/shippers.ts` — `printShippingTickets`' whole-set store passes
  `shipmentOrderIds`; `printBol` captures `shipperOrderIds(tx, …)` into `memberOrderIds` (the very
  set it already claimed) and passes it. Both are the SAME Serializable-snapshot reads the renders
  themselves consume — no re-read, no new claim, exactly the brief's "read under the claims those
  prints already hold". Reprint-stored-bytes paths untouched (they never reach `storeDocument`).
- Tests: new coverage describes in `erp/tests/bol.test.ts` and `erp/tests/shipping-ticket.test.ts`
  (3 + 3 tests); `erp/tests/documents.test.ts` gains the empty-coverage honest-failure test and a
  backfill-pin describe that executes the migration file's UPDATE verbatim; existing
  BOL/whole-set stores in `documents/shipper-children/shipper-routes/shipper-void` test files now
  carry the compile-required coverage (assertions unchanged).

### Migration + backfill verification

Applied via the `create-migration` skill (TTY-less diff → hand-written SQL → both DBs →
`prisma generate`; both `migrate status` calls clean). The diff emitted only the ADD COLUMN; the
backfill UPDATE is hand-written. Verified by hand:

- **Dev `erp`**: `SELECT kind, count(*)` over the backfill's WHERE matched **0 rows** before the
  deploy — no whole-set paper exists there, so the backfill was a no-op (recorded, not assumed).
- **`erp_test`**: planted legacy-shaped rows BEFORE its deploy (shipper `bf_ship` with members
  `bf_ord2` at position 1 and `bf_ord1` at position 2 — insert order deliberately inverted — plus
  whole-set SHIPPER, BOL, per-order SHIPPER, and TRAVELER documents). After deploy: whole-set and
  BOL rows read `{bf_ord2,bf_ord1}` — current membership in POSITION order, proving the
  `ORDER BY so."position"` — while the per-order ticket and traveler stayed `{}`. Rows were wiped
  by the next suite's `truncateAll`.
- The backfill-pin test re-proves this on every run by executing the migration's own UPDATE
  (sliced from the file at `UPDATE "StoredDocument"`), so the pin cannot drift from what
  `migrate deploy` ran.

### How each test was RED-verified

Phase A reds ran against the committed pre-migration code; Phase C reds ran after the migration
but before any documents.ts/shippers.ts change (the column existed, nothing wrote or read it).

| Test | RED evidence |
|---|---|
| BOL: order added after print does not list it; at-print members do | Phase A: failed `expected [documentId] to not include documentId` — the newcomer listed the pre-add BOL (the issue's exact defect) |
| Ticket: same for the whole-set print | Phase A: same discriminating failure |
| BOL: fresh print after the add covers the newcomer | Green-before pin (relation branch listed everything for members) — guards the fix against over-correction |
| Ticket: fresh print covers the newcomer | Green-before pin, same |
| BOL: stores exactly the member set; never rewrites stored paper | Phase C: failed `expected [] to deeply equal [orderA, orderB]` — prints stored the column default |
| Ticket: whole-set stores member set; per-order stores none | Phase C: same `[]` failure on the whole-set half; per-order half green (column default is the contract) |
| Whole-set row with empty coverage lists for NO order, stays on shipment list | Phase C: failed — the relation branch listed the bare row on both orders |
| Backfill pin (migration UPDATE executed verbatim) | Green from birth — its implementation is the already-committed migration. RED-verified the house way: `$executeRawUnsafe` deliberately skipped → failed `expected [] to deeply equal [orderA, orderB]` → restored, green. (First run also caught a test bug: slicing at the word `UPDATE` matched the migration's own comment — anchor fixed to the statement head) |

### Gate results

- `npm test` — **183 files, 3148 tests, all passed** (398s), after all code commits.
- Targeted: the six touched test files in one run — **162 passed, 0 failed** (documents.test.ts's
  36 among them).
- `npx tsc --noEmit` — clean. `npx eslint src tests` — clean (exit 0).
- `npx prisma migrate status` — no pending migrations on `erp` or `erp_test`.
- `npm run test:e2e` — **all 23 flows passed** (exit 0), including `void-shipment`,
  `invoice-shipped-order` and `close-month-end`, against the migrated DEV db. Run now per the
  CLAUDE.md owner instruction (the change alters flow-visible server behavior); the group brief's
  group-end run still applies after later tasks.

### Deviations from the brief

1. **Coverage is compile-required, not merely populated.** The brief says the two stores
   "populate" the column; splitting `DocumentOwner`'s SHIPPER variant makes a whole-set/BOL store
   WITHOUT coverage a type error — the mechanism that keeps a future whole-set caller from
   silently minting empty-coverage rows (which would list nowhere). Test-only cost: 14 existing
   store call sites now pass their fixture's real member ids.
2. The backfill orders ids by `ShipperOrder.position` (the brief's sketch had a bare
   `array_agg`) — the order the paper itself prints in, and deterministic for the pin test.
3. No HANDOFF/CLAUDE.md edits: the ruling was recorded in spec §15 at kickoff; the column follows
   documented precedents (`templateVersionId`, snapshot-at-write) rather than adding a convention.

### Brief-vs-code findings

The brief's ground truth matched the code (the defect branch at documents.ts:201, the two store
sites, the pre-claim snapshot reads). One ADJACENT occurrence of the same class found and left
deliberately untouched: `removeOrderFromShipper`'s printed-paper guard (shippers.ts ~1063) treats
ANY whole-set document as covering the removal target — current-membership-derived, but in the
OVER-blocking (safe) direction, and pinned by an existing test. Loosening a refusal is an owner
call — filed as **#140** with the precise `coveredOrderIds`-based fix sketched.
