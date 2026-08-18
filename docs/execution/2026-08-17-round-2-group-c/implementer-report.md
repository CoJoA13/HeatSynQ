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
- `npm run test:e2e` — run (UI touched; CLAUDE.md owner instruction) even though the group brief
  schedules a group-end run; result recorded in the final task message / progress ledger.

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
