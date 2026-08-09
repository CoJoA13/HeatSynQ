# Task 17 report — E2E flow, demo walkthrough, and docs

## Deliverable 1 — the north-star E2E flow

**File:** `e2e/flows/receivables-apply-age-statement.mjs` (new), registered in `e2e/run.mjs`'s
`FLOWS` array as the 17th and last flow, `as: "admin"` (needs `write_off`, which the admin fixture
role holds via `ALL_PERMISSIONS`).

**Steps:**
1. Seed a shipped→invoiced order against a new A/R fixture customer/part — reused
   `createOrderViaUi`, `startNewShipment`, `orderPanel`, `waitForShipmentPage` from
   `e2e/lib/orders.mjs` and `waitForValue` from `e2e/lib/ui.mjs`, and the `/invoicing`
   Ready-to-invoice → Create → Finalize sequence, all lifted directly from
   `invoice-shipped-order.mjs` (the 5A precedent named in the brief). Asserted the invoice total
   (1000.00) before proceeding, since the whole flow's downstream math depends on it holding
   exactly.
2. Opened a new deposit batch on `/receivables`, added a 700.00 check payment for the A/R
   customer.
3. Expanded the payment's Apply panel and submitted one call carrying three lines against the
   invoice: PAYMENT 500.00, DISCOUNT 20.00 (the checkbox, prefilled from the server's own
   `discountAvailable` read), WRITE_OFF 30.00 with a typed reason — leaving 200.00 on-account.
   Asserted the panel's own summary text and the Payments table's "On account" cell.
4. Opened `/receivables/aging`, filtered to the A/R customer, asserted Current 450.00, 1–30
   0.00, Unapplied 200.00, Net 250.00 (the exact figures the fixture math predicts).
5. Opened `/receivables/statements` (customer preselected via `?customerId=`), checked "Combine
   family" and "Assess finance charges", asserted the preview's total due matches the aging
   report's Net (250.00), printed, and confirmed the archived STATEMENT document appears in the
   customer's own Documents list.

No `page.waitForURL` anywhere (the Phase 3/4/5A route→route/[id] trap); every wait is for
post-navigation-only content, matching every prior flow's convention.

## Fixtures added (`e2e/lib/db-fixtures.ts`)

New `FIXTURE` keys and `Fixtures` type fields: `arCustomerCode` (`E2EARCUST`, `taxable: false`,
`surchargeOptOut: true` — keeps the invoice total exactly predictable against the pre-existing
plant-wide `invSurcharge` fixture that's live for the rest of the harness run), `arPartNumber`
(one priced operation, unit price 100.00, no GL account — `invoiceWarnings` only warns, never
blocks finalize), `arPriceStepCodeCode`/`Name`, `arTermsName` (a dedicated 2/10/30 `Terms` row —
`netDays` 30, `discountPercent` 2.00, `discountDays` 10 — attached via `Customer.termsId`), and
`arPaymentTypeName` (`E2E Check`). All created inside `create()`'s existing single transaction,
reusing the already-defined `orderablePart` closure.

**Teardown — three real bugs found and fixed during this task's own development, not by
inspection:**

1. **`deleteReceivables(customerIds)`** (new): removes every `Application`/`Payment`/
   `ReceiptBatch` this flow produced, scoped through `Payment.customerId` (a `ReceiptBatch` has no
   customer column of its own, so it's reached by walking its payments). Must run before
   `deleteInvoicesAndLines` (`Application.invoiceId` is `ON DELETE RESTRICT`) and before
   `deletePartsAndCustomers` (`Payment.customerId` is `ON DELETE RESTRICT` too).
2. **The empty-batch gap, caught live:** a batch created but never paid into (this happened
   mid-development, when an earlier version of the flow failed before adding a payment) is
   invisible to `deleteReceivables`'s payment-scoped sweep — nothing references it. Fixed with an
   id-driven backstop: the flow now records `ctx.created.receivablesBatchId` the moment it reads
   the batch id off the URL (the `templateIds` precedent — a live-created row's id is only known
   once the flow that created it has run), threaded through `run.mjs`'s cleanup call into a new
   `deleteKnownEmptyBatch(id)` in `db-fixtures.ts`. A no-op both when the flow never got this far
   and when `deleteReceivables` already removed it via its payment (the normal case).
3. **The STATEMENT-document gap, caught live via a real 23514:** the archived STATEMENT document
   this flow's own print produces is owned by `StoredDocument.customerId` alone. Deleting the
   customer without deleting that document first triggers `ON DELETE SET NULL` on that column,
   which immediately violates `StoredDocument_kind_owner_check` (STATEMENT requires `customerId`
   NOT NULL). Fixed with `deleteStatementDocuments(customerIds)`, called before
   `deletePartsAndCustomers` in both `cleanup()` and `reapLeftovers()`.

`reapLeftovers()` extended in parallel with `cleanup()` throughout (natural-key lookups for the new
customer/part/step-code/terms/payment-type, folded into the existing `shipHoldCustomerIds`/
`partIds`/`stepCodeIds` aggregations the same way `invCustomerIds` already was).

## Two real Playwright bugs found and fixed in the flow itself

1. **`getByLabel(..., { exact: true })` on a `<select>` wrapped by its own `<label>` matched
   zero elements** for "Payer customer" and "Payment type" (`BatchDetail.tsx`) and "Customer /
   family" (`AgingReport.tsx`). Root cause verified directly against a live page with a throwaway
   Playwright script: the label's match text for this shape is its full `textContent`, which for a
   `<select>` child recursively includes every `<option>`'s own rendered text — so the computed
   string is never literally "Payer customer". `getByRole("combobox")`'s own accessible-name
   computation (confirmed via `ariaSnapshot()`) does NOT have this problem — it's a `getByLabel`-
   specific quirk. Fixed with `page.locator("label", { hasText: "…" }).locator("select")` at all
   three call sites; documented in the flow's own comments and in `docs/HANDOFF.md` §5a (a third
   trap alongside the existing "React controlled inputs" one).
2. **A `tr`/`table` `.filter({ has: … })` went ambiguous across the ApplyPanel's nested table** —
   it renders inside `<td colSpan={8}>` of a row in the OUTER Payments table, so both a page-wide
   `tr` filter and a `table` filter matched two elements (the real one plus an ancestor that "has"
   the same text transitively). Fixed by locating the panel's own "Write-off" column header and
   walking to its nearest ancestor `<table>` via `locator("xpath=ancestor::table[1]")`.

Both are recorded with full reasoning in the flow file's own comments so a future flow author
doesn't rediscover them the hard way.

## Deliverable 2 — the demo doc

`docs/2026-08-08-phase-5b-demo.md`, in the 5A demo's shape: what shipped, the 17 tasks in build
order, the 17th flow's narrative with screenshot references, a section on the two Playwright bugs
and two harness cleanup bugs this task's own development found (a deliberate addition beyond the
5A demo's shape, since they're genuinely useful precedent for future flows), seed state, watching
it live, what changed for daily use, and the five flagged deviations pulled from the ledger's
"Owner rulings owed" section, each as what-it-does/the-question/your-options:

1. **POSTED batch lifecycle asymmetry** — `voidPayment` refuses on POSTED with a message
   promising a `reopen` that doesn't exist; `voidBatch` has no POSTED guard at all. Four options
   offered (allow voidPayment on POSTED / add reopen / reword the message / leave as-is).
2. **Discount basis** — computed on the invoice's open balance at apply time, not the amount
   being paid or the original total. Three readings offered.
3. **`runStatements` and credit-balance customers** — the run skips only exactly-zero net, so a
   customer with a negative net (a pure credit) still gets a statement. Leave-as-is vs.
   positive-net-only.
4. **Customer A/R section scope** — single-customer only, never a family roll-up, even on a
   parent's own page. Leave-as-is vs. a follow-up needing a `Customer` column.
5. **The vestigial `"ar"` permission area** — still in `AREAS` beside `"receivables"`, granted by
   no role, checked by no route, referenced only in one generic test (confirmed by grep). Leave vs.
   remove.

## Deliverable 3 — the HANDOFF note

`docs/HANDOFF.md` §4's "The current phase" block now reads "**Phase 5B (Accounts Receivable) in
flight**" with the three binding docs named (spec, plan, execution ledger), a scope summary, and a
note that Task 17 is in progress with the whole-branch review/fix-wave/demo/PR still ahead. The
merged one-paragraph entry was NOT added to "Merged, in build order" — that waits for the PR, per
the brief. Also added a third trap to §5a's "Verifying UI findings needs the bundled Chromium"
paragraph, documenting the `getByLabel`/`<select>` quirk found above (alongside the existing "React
controlled inputs" and "global search box" traps) — a genuine testing-convention discovery future
flow authors need, not a one-off note.

## Full `npm run test:e2e` result (final clean run)

Ran the suite five times total during this task while debugging the two flow bugs and two harness
cleanup bugs above (runs 1–4 each caught and fixed one real defect — see the sections above); the
final run is clean start to finish, dev-DB verified empty of every E2E table (`customer`,
`receiptBatch`, `storedDocument`, `processTemplate`) both before and after. Verbatim tail of the
final run:

```
=== invoice-shipped-order (as admin) ===
  PASS

=== receivables-apply-age-statement (as admin) ===
  PASS

Cleaning up dev-DB fixtures (erp)...
  cleanup ok

=== Results ===
  PASS  template-build-and-load
  PASS  typed-fields
  PASS  revision-cut
  PASS  blocked-code-delete
  PASS  permission-gating
  PASS  processes-list
  PASS  order-entry-full
  PASS  board-search-scan
  PASS  loads-after-print
  PASS  void-order
  PASS  ship-partial-then-complete
  PASS  multi-order-shipment
  PASS  cert-results-print
  PASS  void-shipment
  PASS  credit-hold-block-and-override
  PASS  invoice-shipped-order
  PASS  receivables-apply-age-statement

All 17 flows passed. Artifacts: /home/cjones/Desktop/HeatSynQ/erp/e2e-artifacts
```

**17/17 flows passed** (16 prior + this task's new one).

## Other gates

- `npx tsc --noEmit` — clean.
- `npx eslint src tests e2e` — clean (one pre-existing, unrelated warning:
  `e2e/flows/cert-results-print.mjs:19` unused `order` variable — not touched by this task).
- `npm test` — **1860 tests, 120 files, all passing** (run twice across this task: once before any
  changes as a baseline, once after all changes landed — identical count both times, confirming
  the fixtures-only, e2e-only nature of this task's diff).

## Resource-crash notes

**None.** The host stayed stable throughout this task — no resource-exhaustion crash, no need to
invoke the "commit what you have and report honestly" fallback the brief flagged as a live risk.
All five E2E runs completed to their normal exit (four failed on a real, fixed defect; the fifth
passed clean).

## Self-review

- **Verified, not assumed, the two Playwright quirks.** Rather than guessing at a fix from the
  stack trace, both were reproduced against the live dev server with small throwaway Playwright
  scripts (deleted before finishing — never committed) that isolated exactly which locator variant
  matched how many elements, including comparing `getByLabel` against `getByRole("combobox")`'s own
  `ariaSnapshot()` to confirm the app itself has no real accessibility defect.
- **The two harness cleanup bugs were found by the flow's own failures during development, not by
  code review** — an honest signal that the ORIGINAL fixture/cleanup design (written before ever
  running the flow) had two real gaps a first-time reader would very plausibly also miss, which is
  exactly why they're called out explicitly in both the flow's own comments and the demo doc rather
  than folded in silently.
- **Checked FK `onDelete` behavior in the actual migration SQL**, not assumed from the schema
  comment, before writing each new cleanup function (`Application.invoiceId` RESTRICT,
  `Application.paymentId`/`creditInvoiceId` SET NULL, `Payment.batchId`/`customerId`/
  `paymentTypeId` all RESTRICT, `StoredDocument.customerId` SET NULL, `Customer.termsId` SET
  NULL) — this is what caught the STATEMENT-document ordering requirement before it became a
  second live failure (it still became one — the SQL check happened after the first cleanup crash,
  not before it — but the fix was verified against the real constraint text, not guessed).
- **Did not touch any file outside `e2e/`, `docs/2026-08-08-phase-5b-demo.md`, and
  `docs/HANDOFF.md`** — no application code, no other tests, matching the brief's expectation.
- **The demo doc's deviation section is pulled faithfully from the ledger**, not rephrased into
  something softer — each of the five keeps the ledger's own framing of what's actually broken or
  ambiguous (e.g., deviation 1 states plainly that the on-screen message describes an action that
  doesn't exist, rather than glossing it as a minor wording issue).

## Concerns

- **The `getByLabel`/`<select>` quirk likely affects other, ALREADY-MERGED code this task didn't
  touch** — nothing in the existing 16 flows happens to drive a `<select>` wrapped by a plain
  `<label>` via `getByLabel(..., { exact: true })` (the one existing precedent, `startNewShipment`'s
  "Customer" select, uses an explicit `aria-label`, which sidesteps the whole problem), so nothing
  is currently broken by it — but any FUTURE flow reaching for this pattern will hit the same wall
  without the HANDOFF §5a note now in place. Recorded there specifically so it doesn't recur.
- **Owner ruling 1 (POSTED batch lifecycle) and ruling 2 (discount basis) are the two with real
  behavioral weight** — everything else is either a UI-scope question or dead-code cleanup. Flagging
  clearly in case the whole-branch review wants to prioritize discussing those two first.
- **The demo doc's "A real bug this task's own development found and fixed" section is unusual in
  scope for a demo doc** (the 5A demo's closest analogue, "A gap this task found and closed," covers
  one item) — this one covers three (two Playwright quirks + the harness cleanup gaps). Kept it in
  because all three are genuinely load-bearing for whoever writes flow 18, but flagging that it's a
  judgment call on how much harness-internals detail belongs in an owner-facing demo doc versus this
  report alone.
