# Task 7 — #95 the two SSI tripwires — implementer report

**Commit:** `3873f69` `test(quotes): dangerous-direction tripwires for the delete-vs-quote-writer SSI pairings (#95)`
**Branch:** `group-e-close-gl`

## What landed

Tests only, no production change — one new file, `erp/tests/quote-delete-races.test.ts`, two
dangerous-direction tripwires for the Phase 6 §4.2 delete-vs-quote-writer SSI pairings. The SSI
cycle holds today; these tests exist so a future isolation relaxation goes RED instead of
silently orphaning rows. Both use the close-periods gate technique (a Read Committed gate holding
a row the racer must claim FOR UPDATE), both racers are the real service functions, fixtures are
raw prisma, and the file header restates the house rules that bit before (immediate handler
attachment, 20000ms gate timeouts, the 200ms settle, never `vi.spyOn` a delegate).

- **Test A — deleteCustomer ↔ createQuote.** Gate holds `quote_number_next` FOR UPDATE (created
  explicitly after `truncateAll()` — the quote-links counter-row trap is called out in a comment).
  `createQuote` (free-text line only, `quotedById` named explicitly for the id-less system actor)
  fixes its snapshot at the customer liveness read, blocks at `allocateNumber`; the real
  `deleteCustomer` commits (quote count 0); release. Attempt 1's 40001 is absorbed by
  `retryAllocation` (the #115 wrinkle, documented), attempt 2's fresh snapshot answers
  400 "That customer does not exist". Asserted: the rejection (HttpError 400, exact message) AND
  the invariant — zero live quotes on the customer, zero quote rows at all, customer soft-deleted,
  and the counter still at 1000 (the failed save consumed no number — the pinned allocation
  contract, a bonus invariant the same race exercises for free). The comment also records the
  **immutability dependency**: the guard counts rows whose `customerId` never changes because
  `updateQuote` refuses re-points; relax that refusal and a header-only re-point (which doesn't
  even run Serializable — `assignsFk`) lands on a just-counted customer with no race at all.
- **Test B — deletePart ↔ attachPart.** Gate holds the QUOTE row FOR UPDATE; `attachPart`'s
  first statement is `claimQuote`, so its snapshot is fixed there and it blocks BEFORE its part
  read — the clean 400 deliberately cannot fire, only SSI stops the write (the
  template-assignments dangerous-direction shape). The real `deletePart` commits (zero live
  order/quote-line references); release; `attachPart` writes `QuoteLine.partId` on the stale
  snapshot and SSI aborts it at commit. No retry wrapper on `attachPart`, so the abort surfaces:
  asserted HttpError 409 AND the invariant — no live quote line carries the dead part, the line's
  `partId` still null, part soft-deleted.

## RED verification (the downgrade table — this task's substitute for plain TDD RED)

Tripwires can't RED against today's correct code, so the brief's procedure was: pin each delete
service's transaction to Read Committed, watch the tripwire fail for the right reason, restore,
watch it pass. Both downgrades were local-only sed edits, never staged, verified restored via
`git status` (working tree clean but the new test file).

| Downgrade | Result observed |
|---|---|
| `customers.ts:464` `deleteCustomer` → `ReadCommitted` | **Test A RED**: `AssertionError: expected 'resolved' not to be 'resolved'` at quote-delete-races.test.ts:125 — both sides committed, i.e. a live quote landed on the soft-deleted customer, the exact orphan the guard prevents. Test B stayed green (independent pairing). |
| `parts.ts:325` `deletePart` → `ReadCommitted` (customers.ts already restored) | **Test B RED**: `AssertionError: expected 'resolved' not to be 'resolved'` at quote-delete-races.test.ts:217 — the attach committed a live quote line carrying the soft-deleted part. Test A back green in the same run, doubling as proof the customers.ts restore took. |

After restoring `parts.ts`: file green twice consecutively (flake shake) — 2/2 tests, ~1.25s per
run, no flake.

## Gates

| Gate | Result |
|---|---|
| `npx vitest run tests/quote-delete-races.test.ts` (×2) | PASS both runs (2 tests) |
| `npx vitest run tests/quotes.test.ts tests/quote-links.test.ts tests/parts.test.ts tests/customers.test.ts` | PASS — 4 files, 181 tests |
| `npx tsc --noEmit` | PASS |
| `npx eslint src tests` | PASS |

No E2E run: tests-only change, no UI, function, or flow touched (the E2E rule's trigger is
untouched code).

## Reviewer-attention items

- **Test A asserts more than the brief's minimum**: exact 400 message, total quote count 0, and
  the counter unmoved at 1000. All three are deterministic (attempt 2's fresh snapshot cannot see
  a live customer; both attempts roll back whole; attempt 2 throws before `allocateNumber`). If
  any is judged over-pinned, the candidate to drop is the message equality — but it is the same
  literal `customers.test.ts` and `quotes.test.ts` already pin elsewhere.
- **Test B's 409 is asserted as a status, not just "rejected"** — deliberate: `attachPart` has no
  retry wrapper, and the surfaced retryable 409 (vs a silent absorb) is part of what the tripwire
  pins. If a future change legitimately adds a retry wrapper to `attachPart`, this test should
  change WITH it (the retry's fresh snapshot would then see the part dead → 400), exactly as
  quote-links.test.ts's comment block documents happening to the order-save side under #115.
- The gate comments say the abort surfaces "P2034 → withDbErrors → HttpError 409"; in principle
  the abort can also surface mid-transaction as a raw 40001 wrapped in P2010 — `withDbErrors`
  translates both to the identical 409 (`isRawRetryableFailure`, db-errors.ts), so the assertion
  is stable either way.
