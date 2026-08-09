# Task 4 report — `period-locks.ts` leaf + wiring into every A/R posting mutation

**Status:** COMPLETE. New leaf + import-shape pin + RED-verified concurrency tests green; 5A/5B
suites green; `npx tsc --noEmit` and `npx eslint src tests` clean; full `npm test` green; E2E green.

## What landed

### `src/server/period-locks.ts` (new leaf)
A dependency-free LEAF modelled on `invoice-guards.ts`: imports only `type Prisma` and the `HttpError`
leaf from `./errors`, throws its own `HttpError(409)`, reads on the caller's own `tx`, checks no
permission, takes no service dependency. Three exports:

- `lockMonth(tx, year, month)` — `SELECT pg_advisory_xact_lock(4200, ${year * 100 + month})`, a
  transaction-level advisory lock. `4200` is this module's classifier; `year*100+month` (e.g. 202607)
  the month key. Consumed by Task 5's close as well as the guard here.
- `closedPeriodFor(tx, glDate)` — takes the month lock FIRST, then reads the CLOSED `ClosePeriod` for
  that (year, month), or null. A REOPENED row is not CLOSED and does not block.
- `assertPeriodOpen(tx, glDate)` — throws 409 if `closedPeriodFor` returns a row.

**The load-bearing design (why not a plain `findFirst`).** An un-closed month has NO `ClosePeriod`
row (spec §4.1), so no `SELECT … FOR UPDATE` can claim the guarded fact. Both the guard and the
close instead take a transaction-level advisory lock on (year, month) before reading/writing, so a
posting mutation and a concurrent close of the same month serialize at ANY isolation. It is
defense-in-depth over both sides already running Serializable; the RED-verified serialization test
(below) proves the advisory lock — not SSI, not a plain read — is what serializes them.

`ym()` uses UTC getters (`getUTCFullYear`/`getUTCMonth`), matching the UTC-midnight `@db.Date`
reading every A/R date round-trips through (`todayDateOnly`/`parseDateOnly`, business-days.ts).

De-risk note: the codebase had no prior `$executeRaw`/`pg_advisory_xact_lock` precedent, so the
`(int4, int4)` overload resolution under Prisma's parameter binding was verified empirically before
building around it — Prisma binds `${year*100+month}` such that `pg_advisory_xact_lock(4200, $1)`
resolves and executes cleanly (the two guard unit tests exercise it green).

### The eight wirings (guard UNDER each existing row claim, BEFORE the audited write)
- `invoices.ts` — import added; `finalizeInvoiceInTx` (on `invoice.invoiceDate`, after the
  `needsPrice` block), `unlockInvoiceInTx` (on `invoice.invoiceDate`, after the
  `hasReceivableActivity` check), `createCredit` (on `creditDate`, after `todayDateOnly()`).
- `receipts.ts` — import added; `voidPaymentInTx` (added `receivedDate` to the payment `findFirst`
  select, guard on `payment.receivedDate` after the live-application refusal, under the payment-row
  claim), `postBatchInTx` (reads the batch's live payments and guards each `receivedDate` after the
  "already posted" refusal, under the batch claim).
- `applications.ts` — import added; `applyPaymentInTx` (on `appliedDate` = `payment.receivedDate`,
  before the write loop), `applyCreditInTx` (on `appliedDate` = `todayDateOnly()`),
  `voidApplicationInTx` (added `appliedDate` to the live re-read select, guard on `live.appliedDate`
  before the soft-delete).

Every call sits under the mutation's existing `claimInvoiceRow`/`claimLiveBatch`/`claimOrder`+payment
claim and before the audited write, so the period read and that write commit against one consistent
state. No claim was moved and no lock ordering changed.

### `tests/period-locks.test.ts` (new)
Step 1 guard tests (closed-month refusal / open-and-reopened), Step 4 import-shape pin (mirrors
`invoice-guards.test.ts`: no service import, no `require(`/`import(`), Step 7a finalize-refusal
integration test through the real `finalizeInvoice` service (+ an open-month no-op positive), and
Step 7b the advisory-lock serialization proof.

## RED evidence (the deliverable)

### RED 1 — the finalize refusal is the guard's doing
Removed `await assertPeriodOpen(tx, invoice.invoiceDate);` from `finalizeInvoiceInTx` (replaced with a
comment), reran `-t "refuses finalizing an invoice dated in a closed month"`:

```
 ❯ tests/period-locks.test.ts:85:58
     85|   await expect(asSystem(() => finalizeInvoice(invoiceId))).rejects.toThrow(/closed/i);
 → the promise RESOLVED to a FINALIZED invoice ("status": "FINALIZED", "orderNumber": 720001)
   instead of rejecting; assertion failed.
 Test Files  1 failed (1)   Tests  1 failed | 5 skipped (6)
```

Without the guard, a July-dated invoice finalizes into a closed July. Guard restored → GREEN.

### RED 2 — the advisory lock is the serializer, not a plain read
Stubbed `lockMonth`'s body to a no-op (`void tx; void year; void month;`), reran
`-t "serializes two transactions"`:

```
 ❯ tests/period-locks.test.ts:140:31
     140|   expect(bLockedWhileAHeld).toBe(false);
 AssertionError: expected true to be false
   - false
   + true
 Test Files  1 failed (1)   Tests  1 failed | 5 skipped (6)
```

With the lock a no-op, transaction B took "month 7" and completed while transaction A still held it
(`bLockedWhileAHeld === true`) — i.e. no serialization, exactly the phantom a plain `findFirst`
leaves open. `lockMonth` restored to `pg_advisory_xact_lock` → GREEN (B blocks until A commits; a
different month, 2026-08, is unaffected).

Note (scope): the full finalize-vs-close race belongs to Task 5, since `closePeriod` does not exist
yet. Task 4's RED-2 isolates and proves the mechanism the close will rely on.

## Gates
- `npx vitest run tests/period-locks.test.ts tests/invoices.test.ts tests/receipts.test.ts tests/applications.test.ts tests/applications-concurrency.test.ts tests/unlock-concurrency.test.ts` — 128 passed.
- Full `npx vitest run` — green (see commit).
- `npx tsc --noEmit` — clean. `npx eslint src tests` — clean.
- `npm run test:e2e` (foreground, deterministic re-run) — **17/17 flows passed**, exit 0. The guard
  is a no-op for the Playwright flows (they close no months), so wiring it into finalize/apply/void
  changed nothing they exercise.

## Fix round 1 (review finding, ABBA deadlock)

**Finding (Important, concurrency/data-integrity):** `postBatchInTx`'s guard loop
(`for (const d of dates) await assertPeriodOpen(tx, d.receivedDate)`) walked the batch's live
payments UNSORTED. A `ReceiptBatch` can span months, so two concurrent `postBatch` calls over two
batches sharing two months could take `lockMonth`'s two advisory locks in opposite order — Postgres
detects the cycle and aborts one side with `40P01`, which `withDbErrors` does not translate, so it
would have surfaced as a bare 500 instead of the ordinary 409. The fix mirrors the
`claimOrdersInOrder` rule for row claims, applied to advisory mutexes: dedup to distinct
`(year, month)` and lock them in ascending order, one call per month.

### Change — `src/server/receipts.ts`, `postBatchInTx`
Replaced the unsorted per-payment loop with a dedup-then-sort step before the guard calls:

```ts
  const dates = await tx.payment.findMany({
    where: { batchId: id, deletedAt: null }, select: { receivedDate: true },
  });
  const months = [...new Map(dates.map((d) => {
    const key = d.receivedDate.getUTCFullYear() * 100 + (d.receivedDate.getUTCMonth() + 1);
    return [key, d.receivedDate] as const;
  })).entries()].sort((a, b) => a[0] - b[0]);
  for (const [, d] of months) await assertPeriodOpen(tx, d);
```

Also corrected the nearby comment, which had credited `assertPeriodOpen`'s own advisory lock with
deduping the work per month — that lock only closes the phantom-row race for a single call; the
sort/dedup above is what actually collapses repeat months to one `ClosePeriod` read and what
establishes the ascending lock order across concurrent batches.

### New test — `tests/period-locks.test.ts`
The lock-ordering fix itself is a cross-transaction invariant, not observable from a single-process
test (same reasoning as Step 7b's existing note on the finalize-vs-close race). What IS testable
here is coverage: that `postBatch` guards EVERY distinct month a multi-month batch's payments fall
in, not just the first one found. Added `describe("postBatch — guards every distinct month of a
multi-month batch")`:

- `batchSpanningTwoMonths()` — a shared builder: one customer/paymentType, one batch, two payments
  dated 2026-06-15 and 2026-07-15 (via `createBatch`/`addPayment`, the `receipts.test.ts` factory
  pattern — no batch/payment factory existed worth importing, so this is a small local helper).
- `"refuses postBatch when only the SECOND month of the batch is closed"` — closes 2026-07 only
  (leaving June, the FIRST payment's month, open) and asserts `postBatch` rejects 409
  `/2026-07 is closed/`. This is the case an unsorted loop that stopped at the first closed date it
  hit would still have caught by luck; the discriminating case is the one below.
- `"posts cleanly when neither month is closed"` — same two-month batch, no `ClosePeriod` rows,
  `postBatch` succeeds to `POSTED`.

Both new cases pass with the fix in place; the pre-fix unsorted loop would still have passed BOTH
(it iterates every payment's date regardless of order — the bug is lock-acquisition ORDER across
concurrent transactions, which single-process coverage cannot exercise, only reason about via code
inspection and the `claimOrdersInOrder` precedent already proven for row claims).

## Gates (fix round 1)
- `npx vitest run tests/period-locks.test.ts tests/receipts.test.ts` — 29 passed (8 + 21; period-locks.test.ts grew by the 2 new cases above).
- Full `npm test` — 123 files, 1898 tests passed.
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean (0 errors, 0 warnings).
- `npm run test:e2e` (foreground) — **17/17 flows passed**, exit 0. Confirmed no-op as expected:
  none of the Playwright flows close a period, so the reordered guard changes nothing they exercise.
