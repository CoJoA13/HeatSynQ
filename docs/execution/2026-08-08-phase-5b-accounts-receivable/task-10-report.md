# Task 10 report — `aging.ts` — point-in-time aging into buckets + the unapplied column

**Status:** Complete. All four gates green (`npm test` 1804/1804, `tsc`/`eslint`/`build` clean).

## What was built

- `src/server/aging.ts` — `bucketAging` (pure) + `agingReport` (Prisma-reading wrapper).
- `src/app/api/receivables/aging/route.ts` + `query.ts` — JSON aging report, `receivables.view`.
- `src/app/api/receivables/aging/export/route.ts` — Excel export, reusing the shared `toXlsx`
  helper (the `parts/export`/`invoices/export` precedent — no new export mechanism).
- `tests/aging.test.ts` (13 tests) + additions to `tests/receivables-routes.test.ts` (2 route
  tests: happy-path/403 for both routes, plus a 404 case).

## `bucketAging`'s point-in-time logic (the correctness heart)

Pure, integer-cent, no Prisma — the `ar-balances.ts` shape. For each customer in the `customers`
array, it walks `snap.invoices`:

1. **`if (!inv.finalizedAt || parseDateOnly(inv.finalizedAt).getTime() > asOfMs) continue;`** — an
   invoice not yet finalized as of `asOf` is excluded entirely, full stop.
2. For a live `INVOICE`, its open balance is `ar-balances.invoiceOpenBalance(inv.total, apps)`
   where `apps` is `liveAsOf(...)` — every application targeting this invoice whose
   `appliedDate ≤ asOf` (an application dated after `asOf` doesn't reduce anything at that `asOf`).
   The open balance (if `> 0`) is bucketed by `daysPastDue = asOf − dueDate` into
   current/d1_30/d31_60/d61_90/d90_plus.
3. For a `CREDIT`, `ar-balances.creditRemaining` (same `liveAsOf` filter, matched on
   `creditInvoiceId`) — if `> 0`, added to `unapplied`, never a bucket (a CREDIT carries no
   `dueDate`).
4. Every live payment for the customer contributes `paymentOnAccount(amount, [{amount:
   appliedPaymentTotal, type: "PAYMENT", deletedAt: null}])` to `unapplied` if positive.
5. `net = Σ buckets − unapplied`.

`snap.applications` carries no `deletedAt` field at all — the caller (`agingReport`) only ever
queries `deletedAt: null` rows into the snapshot, so "live" is true by construction and
`bucketAging`'s own job is exactly the `appliedDate ≤ asOf` half of the cut. **As documented in
`liveAsOf`'s comment and per the assignment's framing:** a truly retroactive void (voided today,
but the application's `appliedDate` predates a past `asOf` being re-run) is **not** un-counted at
that past `asOf` — this is the spec's literal §6 reading (point-in-time keys on `appliedDate`, not
on `deletedAt` vs. `asOf`), and I did not try to "fix" it.

## Point-in-time filtering of payments (a design decision beyond the literal brief)

The brief's `SnapshotPayment` shape (`{ customerId, amount, appliedPaymentTotal }`) carries no
per-application detail for `bucketAging` to filter itself the way it does for invoices — there's no
`appliedDate` or `receivedDate` on the snapshot row. Rather than leave a hole in point-in-time
correctness for the Unapplied column, `agingReport`'s `readSnapshot` does this filtering at the
query layer: only payments with `receivedDate ≤ asOfDate` are included at all, and
`appliedPaymentTotal` is the sum of only the live `PAYMENT`-type applications with `appliedDate ≤
asOfDate`. This is an implementer decision (the brief's steps only explicitly test invoice/
application point-in-time behavior), made in the direction the spec's stated goal (§6 reproducible
point-in-time reconstruction, §13's parallel-run acceptance test) points — flagging it explicitly
in case the owner wants a different call.

## The family roll-up shape

Per the parent task's explicit resolution of the brief's two alternatives: **per-child rows plus a
synthesized family-total row keyed on the parent** (not "combine everything into the parent's
single row"). `agingReport({ customerId: parent })`:

1. Looks up the target customer (404 if none live) and its live children (`parentId = target`,
   `deletedAt: null`).
2. If there are no children, returns that customer's own single `AgingRow` — no family involved.
3. If there are children, reads one snapshot over the whole family (`[parent, ...children]`), then:
   - `childRows = bucketAging(snap, asOf, children)` — one row per child.
   - `parentOwnRow = bucketAging(snap, asOf, [parent])[0]` — the parent's own invoices, if any
     (rare, but real: nothing stops a parent-level customer from carrying its own invoices too).
   - `totalRow = sumRows([parentOwnRow, ...childRows], parent)` — every family member's numbers
     summed in integer cents, keyed with the parent's own id/code/name. The parent itself gets **no
     separate row** — only the total (matching "per-child breakdown with a family total", not
     "per-family-member breakdown").
4. Returns `[...childRows, totalRow]`.

The snapshot query (`readSnapshot`) is scoped to the whole family's invoice/credit ids via one
`OR`-based application query (`invoiceId IN familyInvoiceIds OR creditInvoiceId IN
familyInvoiceIds`), which — I traced through — correctly captures every relevant application even
under `applyCredit`'s actual (unconstrained) cross-customer behavior: a credit issued to one
customer can be applied to a different customer's invoice (exercised directly in
`applications.test.ts`'s `applyCredit` tests, which deliberately put the credit and the target
invoice on two different, unrelated customers). Whichever side (target invoice or source credit)
belongs to our family, the query catches it from that side independently.

## No-filter default (`agingReport({})`)

Not explicitly specified by the brief's numbered steps, so I made a deliberate, documented choice:
every customer with **any A/R history** — a live finalized invoice/credit, or a live payment — gets
one row (customers with zero history are omitted rather than padding the report with all-zero
rows for e.g. inactive/prospect customers who never invoiced). The final customer lookup is
**deliberately not filtered by `deletedAt: null`** — see the in-code comment at the call site: a
customer can only be soft-deleted with zero live orders (`customers.ts`'s `deleteCustomer`), and a
finalized invoice with residual A/R keeps its order alive (`voidOrder` is blocked by
`hasReceivableActivity`, Task 9), so a deleted customer can only ever surface here with an
all-zero row — but point-in-time reconstruction of a past `asOf` must not silently drop a
customer's real history just because the customer entity was later deleted.

## The export route

`src/app/api/receivables/aging/export/route.ts` follows the `parts/export`/`invoices/export`
precedent exactly: `mustCan(requireUser(), "receivables", "view")`, the **same** `parseAgingFilter`
the JSON list route uses (so list and export can never disagree about what a query string means —
the `invoices/export` "SAME filter parse" comment convention, copied), `agingReport`, then
`toXlsx("Aging", columns, rows)` with the standard
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` content-type and
`Content-Disposition: attachment; filename="Aging.xlsx"`. No new export mechanism — despite the
brief's "tsv/export helper" phrasing, the actual codebase-wide precedent (traced through
`parts/export/route.ts`, `invoices/export/route.ts`, and eight other export routes) is `toXlsx`
(`src/server/excel.ts`, an ExcelJS wrapper), so that's what I reused.

## TDD RED/GREEN evidence

Wrote implementation and tests together (as is typical for a scoped subagent task), then went back
and genuinely RED-verified the three load-bearing behaviors by temporarily disabling each guard,
confirming the specific test failed, then restoring:

1. **`finalizedAt ≤ asOf` cut removed** (`aging.test.ts`, point-in-time test) →
   `expected 2000 to be 1000` (the late-finalized invoice leaked in). Restored → green.
2. **`appliedDate ≤ asOf` cut removed** (same test) → `expected 600 to be 1000` (the future-dated
   application wrongly reduced the balance). Restored → green.
3. **Family-total summation short-circuited to just the parent's own row** (`aging.test.ts`,
   family-roll-up test) → `expected +0 to be 1000` (children dropped out of the total). Restored →
   green.

All three are genuine RED→GREEN pairs, not just passing-on-first-try assertions. Full suite run
after restoring: `tests/aging.test.ts` 13/13, `tests/receivables-routes.test.ts` 9/9 (including the
2 new aging-route tests), full `npm test` 1804/1804.

### Test inventory (`tests/aging.test.ts`)

- **Buckets by due date** (3 tests): 15-days/40-days/future-due → d1_30/d31_60/current; the
  `d61_90`/`d90_plus` boundary (exactly 90 days past due stays in `d61_90`); a fully-settled
  invoice drops out of every bucket.
- **Point-in-time** (1 test, the mandated one): the same fixture (a late-finalized invoice + a
  future-dated application) ages to `1000` at `asOf` and `1600` the next day.
- **Unapplied column** (2 tests): open credit remaining + payment on-account both roll into
  `unapplied`, never a bucket, with `net` reflecting the subtraction; a fully-applied credit and a
  fully-applied payment contribute zero.
- **Integer-cent correctness** (1 test): `0.3 − 0.1 = 0.2`, not float-drifted.
- **`agingReport` service wiring** (4 tests): real-Decimal wiring end to end + zero audit entries;
  default `asOf` + the no-history exclusion; 404 on a dead `customerId`; 400 on a malformed `asOf`.
- **Family roll-up** (2 tests): the mandated parent + two children (500 past-due each) → both
  child rows at 500 and the synthesized total row at 1000, keyed with the parent's own
  code/name; a childless customer returns just its own single row.

### Route tests (`tests/receivables-routes.test.ts`)

`GET /api/receivables/aging` — 403 without `receivables.view`, 200 (array) with it, plus a 404 for
a dead `customerId`. `GET /api/receivables/aging/export` — 403 without `receivables.view`, 200 with
the correct xlsx content-type and `Content-Disposition` header with it.

## Gate results

- `npm test` — **1804/1804 passed** (117 files).
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.
- `npm run build` — clean; `/api/receivables/aging` and `/api/receivables/aging/export` both
  registered as dynamic routes in the build output.

Playwright E2E was not run — this task adds new read-only routes with no UI wired to them yet
(Task 14 builds the aging report UI) and touches no existing flow; per the phase's process
decision (progress.md), E2E is sequenced at Task 17 and the closing gate, not per-task, except when
a task makes a high-risk change to an *existing* flow — this one doesn't.

## Self-review

- **`bucketAging` is pure — no Prisma.** Confirmed: its only imports are `ar-balances` functions,
  `type ApplicationTypeValue`, and `parseDateOnly` (a pure lib function). No `prisma`/`Prisma`
  import in scope for that function.
- **Point-in-time filters applied on both halves** (`finalizedAt` and `appliedDate`), RED-verified
  individually (see above).
- **Decimal→number in the service.** Every `Prisma.Decimal` (`Invoice.total`, `Application.amount`,
  `Payment.amount`) is `.toNumber()`'d exactly once, at the `readSnapshot` boundary — confirmed by
  grep: no raw `Decimal` value crosses into `bucketAging` or an `AgingRow` field.
  `agingReport`'s own end-to-end test (`ages one customer's finalized invoice off real Decimal
  fields`) exercises this against the real DB, not just the pure-snapshot tests.
  `d1_30` came back as a plain `750.5`, not a stringified/boxed Decimal.
  `d1_30` also exact — no float drift on a real fractional total.
- **`net = Σ buckets − unapplied`** — enforced identically in both `bucketAging` (per-row) and
  `sumRows` (the family-total row, which sums each already-computed `net` rather than
  re-deriving it from summed buckets/unapplied — these are equivalent by linearity of the
  subtraction, and I did not spot-check that equivalence with a dedicated test; noting it here
  since it's a `sumRows`-specific assumption worth a second look).
- **Export reuses `toXlsx`** — no bespoke CSV/TSV writer, no new content-type; verified against
  `parts/export/route.ts` and `invoices/export/route.ts` line by line before writing the aging
  export route.
- **Audit irrelevance** — asserted directly (`prisma.auditLog.count()` stays `0` after a real
  `agingReport` call against a DB with a real invoice in it).

## Concerns / open items for the reviewer

1. **Payment point-in-time filtering is my own addition, not literally specified by the brief's
   `SnapshotPayment` shape or its numbered steps.** See "Point-in-time filtering of payments"
   above — I believe it's the correct call given spec §6's stated goal, but it's worth the reviewer
   (and eventually the owner) confirming this is the intended behavior, since the interface as
   given doesn't strictly require it and a different implementer might reasonably have left
   payments unfiltered by date.
2. **The parent's own invoices, if any, get folded into the family total but never their own
   displayed row** — matches the given resolution ("per-child rows plus a synthesized family-total
   row keyed on the parent"), but is worth flagging since it means a parent-with-its-own-invoices
   scenario is asymmetric with the children (each child gets its own row; the parent doesn't,
   only the blended total). No test exercises a parent that itself carries invoices — only that
   the code path (`parentOwnRow`) exists and folds correctly into the sum, by construction/code
   inspection, not by a dedicated regression test. Flagging as a coverage gap, not a defect.
3. **No dedicated test for the credit-applied-cross-family / cross-customer application scenario**
   inside aging specifically (i.e., a family member's invoice paid down by an outside customer's
   credit, or vice versa) — I traced through the query logic by hand (see "family roll-up" section
   above) and I'm confident it's correct, but there's no aging-specific regression test pinning it;
   `applications.test.ts`'s existing cross-customer `applyCredit` tests are the closest coverage,
   and they're at the application layer, not aging's.
4. **No explicit test for a `CREDIT` invoice missing its `dueDate` defensive fallback** (the
   `inv.dueDate ? ... : asOfMs` branch in `bucketAging`) — unreachable in practice since only
   `INVOICE` rows read `dueDate` at all (the `CREDIT` branch never touches it), so the fallback is
   dead code for `CREDIT` and only a genuine defensive guard for an `INVOICE` somehow missing its
   `dueDate` (shouldn't happen post-Task-3, but not schema-enforced). Not worth a synthetic test
   given the schema-level improbability, but noting the branch is unexercised.
