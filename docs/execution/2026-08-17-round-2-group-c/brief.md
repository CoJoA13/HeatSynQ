# Round 2, Group C — Shipping and order-status integrity · task brief

**Branch:** `group-c-shipping-status` · **Base:** `a9cd97a` (main)
**Source of scope:** `docs/2026-08-17-backlog-round-2.md`, Group C.

## Why this group exists

The accounting answers came back and were actioned (three closes, two unparks — see the backlog's
PARKED table); Group C is the next track in the recommended order. **#65 is the one that matters**
— real status/ledger corruption on non-invoiced reversal pairs — and the rest are papercuts that
share the same screens.

## Scope — eight issues

| # | Defect |
|---|---|
| #65 | Voiding a reversal (or the shipment it reverses) corrupts order status / the net ship ledger |
| #52 | Whole-shipment document coverage derives from CURRENT membership, not print-time membership |
| #42 | Generated loads are not validated against `Load.qty`/`weight` column ranges — unmapped Postgres overflow 500s |
| #41 | The printed-traveler warning appears only after a loads mutation, never on editor load (its own text calls it P1) |
| #44 | Save & Print is gated on `orders.create` alone, then redirects to a page requiring `orders.view` |
| #45 | The board's customer filter drops inactive customers, so a saved view stays silently scoped with a blank select |
| #46 | The order hub hides customer code/name without `customers.view`, though the board shows exactly that under `orders.view` |
| #51 | New shipment: an in-flight add-order response lands after a customer switch |

## Owner rulings taken at kickoff (2026-08-17, recorded in spec §15)

**#65 — void is reversal-aware.** Voiding the ORIGINAL of a live reversal pair is **refused naming
the reversal** (§5.14 name-the-blocker shape). Voiding the REVERSAL is the blessed undo: it
**restores the `lineComplete` flags the reversal itself cleared** and recomputes status. Invoiced
pairs stay behind `refuseIfInvoiced` — unlock is their correction route (§5.7).

**#52 — persist print-time coverage.** A whole-set ticket/BOL records which orders it covered at
print; `listDocumentsForOrder` reads coverage, not current membership. Membership stays editable
after a print (freeze-membership was considered and rejected: the printed paper is not falsified by
a later addition — print a fresh BOL).

## Design — #65 (the mechanism, from the kickoff recon)

Ground truth in `shippers.ts` / `ship-ledger.ts` / `order-locks.ts`:

- `reverseShipperInTx` (shippers.ts ~1702): claims orders (one sorted statement) → original Shipper
  row → creates the negated reversal (`lineComplete: false` on its own lines) → **step 6b clears
  `lineComplete` on the ORIGINAL's lines that were complete** (`completeLineIds`) → REOPENED direct
  for invoiced orders, two-arg `recomputeOrderStatus` for the rest. Nothing records WHICH lines it
  cleared.
- `voidShipper` (~1615): `claimLiveShipper` → `refuseIfInvoiced` → soft-delete + cert voids →
  `recomputeOrderStatus`. Completely reversal-unaware.
- `recomputeOrderStatus` derives OPEN/PARTIAL_SHIPPED/SHIPPED from flags only, skipping
  INVOICE_OWNED. Since `refuseIfInvoiced` blocks any void where an order carries a finalized
  invoice, the void path never meets REOPENED/INVOICED — the status side needs **no** new direct
  writes, only correct flags before the existing recompute.

The fix:

1. **Migration**: `Shipper.reversalClearedLineIds String[] @default([])` — the ORIGINAL's
   `ShipperLine` ids whose `lineComplete` this reversal cleared, written once at creation in
   `reverseShipperInTx` (step 6b already computes `completeLineIds`; store them on the reversal
   row). Immutable snapshot; no edit-path bookkeeping. Use the `create-migration` skill (TTY-less
   diff flow), apply to BOTH databases.
2. **Void-of-original blocker**: in `voidShipper`, refuse when a live reversal points at the target
   (`Shipper.reversesShipperId = id, deletedAt: null`), naming it: "This shipment has been reversed
   by Packing List N — void the reversal first." **Invariant argument worth stating in a comment:**
   with every live reversal fully covered by its live original, Σ(live originals) − Σ(live
   reversals) ≥ 0 per line by construction — this blocker is what makes the net ledger non-negative
   globally, not just at reversal creation.
3. **Void-of-reversal restore**: when the target IS a reversal (`reversesShipperId !== null`):
   after soft-delete, restore `lineComplete: true` on the original's lines named by
   `reversalClearedLineIds` (skip entirely if the original is itself voided — pre-fix corrupt data
   only), via `auditedUpdate("shipper", originalId, …)` with the void reason (mirror of the clear's
   audited write). Then the existing `recomputeOrderStatus` over the claim set settles status.
   Lines replaced/edited since the reversal simply don't match (ids died) — the human re-decided;
   restore no-ops gracefully. Pre-migration reversals carry `[]` and restore nothing (dev/practice
   data only; the shop is not live).
4. **Lock shape**: `voidShipper` must lock BOTH shipper rows of a pair. Two concurrent voids on the
   pair would ABBA through single-row `claimShipperRow` calls, so add `claimShipperRows(tx, ids)` —
   deduplicated, ascending, ONE `SELECT … WHERE id = ANY(…) ORDER BY "id" FOR UPDATE` (the
   `claimOrdersInOrder` shape applied to Shipper rows), used by `voidShipper` in place of its
   single-row claim: orders first, then the shipper-row set (target + discovered pair ids),
   uniformly AFTER the order claims. Pair discovery happens on the pre-claim stub read (the
   `claimLiveShipper` shape); a reversal committing between snapshot and claim is caught by SSI
   (both paths Serializable, rw-cycle through the Order rows + the reversal predicate read) →
   40001 → `withDbErrors`' honest 409.
5. **Claim set**: the target's own orders (`claimLiveShipper`'s set) suffices. The restore's
   written rows belong to orders the reversal mirrored, which are on the reversal's own
   `ShipperOrder` set; an order added to the original later is untouched by both the clear and the
   restore.
6. **UI**: `ShipmentDetail` keeps Void on reversals (the blessed undo). For an original with a live
   reversal, carry a flag in the detail response so the Void button renders disabled with the
   blocker as its title (§5.16) — the server refusal stays the enforcement.

**Adjacent hole, out of scope — file as an issue during the group:** editing a reversed ORIGINAL's
line quantities (`replaceLines`) after the reversal exists can drive the net ledger negative; the
below-zero guard runs only at reversal creation. Same class as #65, different mutator.

**Tests (RED-verify each):** void-reversal restores flags + status (SHIPPED again; and the
PARTIAL_SHIPPED-stuck case from the issue); void-original-with-live-reversal refused naming the
reversal; void-original-after-reversal-voided allowed; net `shippedTotals` never negative through
any void sequence; pre-migration (`[]`) reversal void restores nothing but recomputes; invoiced
pair still refused both sides (`refuseIfInvoiced` precedence — assert the message names the
invoice rule, and that the blocker check does not shadow it); concurrency: two voids on the pair
serialize (the Read Committed injected-tx technique if a deterministic shape exists, else the
standard Serializable race harness).

## Design — #52

1. **Migration**: `StoredDocument.coveredOrderIds String[] @default([])` + backfill: every existing
   whole-set document (`kind IN ('SHIPPER','BOL') AND "shipperId" IS NOT NULL AND "orderId" IS
   NULL`) gets its shipment's CURRENT member order ids — the best available approximation, stated
   in the migration comment. The hand-written kind→owner CHECK is untouched (no enum change).
2. **Write path**: the whole-set ticket print (`printShippingTickets`, the `orderId: null` store)
   and `printBol` populate `coveredOrderIds` with the member order ids their render actually
   covered — read under the claims those prints already hold.
3. **Read path**: `listDocumentsForOrder`'s last OR branch becomes
   `{ orderId: null, coveredOrderIds: { has: orderId } }` — the relation-derived membership branch
   is deleted. Per-order tickets (`orderId` set) are untouched.
4. **Tests (RED-verify):** an order added after a BOL print no longer lists that BOL; orders that
   were members at print keep listing it; a fresh print after the add covers the newcomer; backfill
   shape pinned (a doc predating the column lists for current members — i.e. the migration's
   UPDATE, exercised via the test DB's migrated schema + a hand-inserted legacy-shaped row).

## Design — #42 and the five UI fixes

- **#42**: bound the generated loads at save: qty ≤ 2,147,483,647 and weight ≤ 9,999,999,999.99
  per load (`Load.qty` INTEGER, `Load.weight` DECIMAL(12,2)), checked in `saveNewOrder`/
  `replaceLoads` before the nested create, field-anchored 400 naming the offending load and the
  caps. Practical bound may live in `splitLoads` or at validation — implementer's call, but the
  message must name the real limit and the tests must pin both the qty and the weight overflow.
- **#41**: `travelerPrinted` is already on `OrderDetail` — pass it into `LoadsSection`; a
  persistent warning derived from order state, not the mutation-response list (and not clearable by
  an unrelated warning-less mutation).
- **#44**: `saveGate` also requires `orders.view` for Save & Print specifically (§5.16
  disabled-with-title naming the missing permission); plain Save keeps `orders.create` alone.
- **#45**: board customer fetch gains `includeInactive=1` (the rider-part picker precedent at
  `orders/[id]/page.tsx:237`) so a saved view's inactive customer stays a visible, named filter.
- **#46**: `OrderDetail` carries customer code/name unconditionally (it already joins the
  customer); the hub header renders them as plain text when `customers.view` is absent, linked when
  present (the board precedent).
- **#51**: gate `addOrder`'s response on the CURRENT customer via the `candidatesLatest.isCurrent`
  latest-token pattern already in the same component.

## Sequencing

#65 → #52 (both server-heavy, each with its own migration) → #42 → the five UI fixes as one task.
TDD per issue: failing test → implement → pass → commit (conventional message, no attribution
trailer). Gates re-run in full at every review round, never carried forward. `npm run test:e2e` in
the background at the end (UI touched). **Only one test-running process at a time.** Never
`git add -A`.

## The failure shape to hunt

Every serious defect this project has found **fails while reporting success**. For this group: a
void that "succeeds" while leaving flags cleared, a coverage list that looks complete, a load save
that 500s only at Postgres. Ask what each path does when it goes wrong, and whether anything
notices.
