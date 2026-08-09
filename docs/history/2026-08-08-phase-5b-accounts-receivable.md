# Phase 5B — Accounts Receivable (full narrative)

**Squash-merged to `main` as `b55da3b` (PR #74, 2026-08-09).** Branch `phase-5b-accounts-receivable`.
Final gates: **`npm test` 1879 · `tsc`/`eslint`/`build` clean · E2E 17/17.** 29 migrations on `main`.

Binding documents: spec `docs/superpowers/specs/2026-08-08-phase-5b-accounts-receivable-design.md`,
plan `docs/superpowers/plans/2026-08-08-phase-5b-accounts-receivable.md` (17 tasks). The complete
per-task record — briefs, implementer reports, reviewer verdicts, the whole-branch review, the two
Codex rounds, every owner ruling and deferred minor — is the execution ledger
`docs/execution/2026-08-08-phase-5b-accounts-receivable/progress.md`. This file is the condensed
narrative; read the ledger for the blow-by-blow.

## What it delivered

Turns Phase 5A's finalized `Invoice`/credits into a working A/R ledger:

- **Receipts ledger** — `ReceiptBatch → Payment → Application`, three new auditable tables. Deposit
  batches (check/card/ACH via `PaymentType`) with a live balancing total; `OPEN → POSTED` lifecycle.
- **Cash application** (`applications.ts`) — one unified `Application` table typed
  `PAYMENT`/`DISCOUNT`/`WRITE_OFF`/`CREDIT`, source = a payment XOR a credit, enforced by a
  hand-written `Application_source_check`. Apply a payment across one or more invoices, including
  across a parent's divisions, under one sorted `claimOrdersInOrder` + sorted invoice `FOR UPDATE`
  claim; partials, terms-based early-pay discounts, write-offs (gated on a new `write_off` special
  action), on-account remainders, and credit-memo application (both balances guarded).
- **Derived balances** (`ar-balances.ts`, pure) — invoice open balance, payment on-account, credit
  remaining are **never cached on `Invoice`**; every figure derives from live `Application` rows.
- **Aging** (`aging.ts`, pure) — point-in-time buckets (Current/1–30/31–60/61–90/90+) by due date
  with a separate Unapplied column, per customer and per family, Excel-exportable.
- **Finance charges** (`finance-charges.ts`, pure) — informational-only, opt-in per statement run,
  never posted (5C inherits nothing to post).
- **Statements** (`statements.ts` + `pdf/statement.ts`) — open-item statements, combined/per-division
  for a family, archived byte-for-byte as `STATEMENT` `StoredDocument`s owned by the customer;
  reprints reissue stored bytes.
- **Cross-phase guard** — `invoice-guards.ts` gained `hasReceivableActivity`/`hasReceivableActivityForOrder`;
  5A's `unlockInvoice`/`discardInvoice` and `orders.ts`'s `voidOrder` refuse once an invoice has
  live A/R activity.
- **Schema** — 3 tables + `ApplicationType` enum + Terms(`netDays`/discount)/Invoice(`dueDate`/
  `financeChargeExempt`)/BillingConfig(`financeChargeRate`)/StoredDocument(`customerId`) additions +
  two hand-written CHECKs. The `STATEMENT` `DocumentKind` value went in its own earlier migration
  (Postgres refuses a new enum value in the transaction that adds it — the Phase 4/5A precedent).
- **UI** — a new `/receivables` area (batch worklist, batch-entry & apply screen with a
  void-application correction path, aging report, statements) + a customer-page A/R section; a new
  `receivables` permission area (view/create/edit/delete) + the `write_off` action.

The two changes 5B made to 5A: `createCredit` stamps the credit's **own** date (owner ruling 6), and
a finalized `INVOICE` gets a `dueDate = invoiceDate + terms.netDays` at finalize.

## Owner rulings taken during execution

- **Apply gate = `receivables.create`** (not `edit` as the Task 13 brief said) — creating an
  `Application` is entity-creation, consistent with add-payment/create-batch; post-batch = `edit`,
  voids = `delete`.
- The ten §3 design-session rulings (all four cash primitives; one payment → many invoices incl.
  across a parent's children; check/card/ACH; no prepayments — on-account is only an unapplied
  receipt; a credit applies to an invoice or sits on account; a credit takes its own date;
  terms-based discounts; aging by due date + a separate Unapplied column; finance charges
  informational + opt-in; open-item statements, family on demand, archived) were all honored — the
  spec/non-goals whole-branch reviewer confirmed no §16 non-goal was built and every §17 5C hook is
  present-but-unposted.

## What the review process caught (bugs unit tests would not have)

The per-task reviews (opus on the concurrency/money/schema tasks) plus a **5-dimension whole-branch
review** (concurrency · money/point-in-time · schema/audit · routes/permissions · spec/non-goals/
5C-hooks) caught and fixed, on-branch, real correctness/concurrency/data-integrity bugs the gates
never saw:

- `voidOrder` could orphan a live applied credit on a voided order (Task 9 review).
- the apply-screen permission gate didn't match its route (Task 13 review).
- the customer A/R section leaked sibling-division invoices (Task 15 review).
- `applyPayment`/`applyCredit` re-read the invoice under the claim but omitted `status`/`kind`/
  `deletedAt`, so a payment could be applied to an invoice concurrently unlocked to DRAFT
  (whole-branch — the code's own comment had conceded "status cannot be trusted from here").
- `voidPayment` could strand a live application, sequentially and then via a residual race closed by
  a payment-row claim (whole-branch).

Both mandated concurrency tests are RED-verified with the competing caller pinned to Read Committed
(SSI off the table — the Phase 4 lesson).

## The Codex PR reviews (two rounds, all deferred to issues by owner ruling)

Codex reviewed the PR twice. **Round 1 (17 findings):** 11 fixed on-branch (cross-family
application; per-line discount cap; a source-less-PAYMENT CHECK tightening; statement on-account
reconciliation; family-footer double-count; export/screen filter parity; aging snapshot in one tx;
Terms both-or-neither on clear; a void-application UI; apply-on-POSTED per §5.2) — re-reviewed
Approved by opus — and 6 filed. **Round 2 (7 findings)**, on the fix commits, all filed by owner
ruling. Full triage in the ledger.

**Open follow-up issues #68–#87** (none blocking; the 5A #59–#65 pattern): the POSTED-batch
lifecycle, discount basis, credit-balance statements, customer-section family roll-up, the vestigial
`"ar"` area, post-dated payments, credit-apply UI, finance-charge-exempt setter, standalone bad-debt
write-off, point-in-time reproducibility after later voids/unlocks, issued-terms discount snapshot,
postBatch balance check, **the aggregate (multi-line) discount cap (#81)**, a Terms both-or-neither
DB CHECK (#82), customer-section open-item completeness (#83), **`deleteCustomer` blocking a customer
with live payments (#84)**, per-division statement printing (#85), a nonnegative `Customer.financeChargeRate`
(#86), and customer-code filename sanitization (#87). #81 and #84 are the P1s among them.

## Lessons

1. **`vi.spyOn` a Prisma delegate is still banned** (as CLAUDE.md says); the phase added no audit
   exceptions.
2. **The enum-value-in-its-own-migration split** is a hard Postgres rule, re-confirmed for
   `STATEMENT`.
3. **`renderPdf` is not byte-deterministic across calls** — the statement reprint test compares
   STORED bytes (`Buffer.compare`) and pins content on the pdfmake definition (`allText`), never two
   fresh renders.
4. **A Playwright `getByLabel(..., {exact:true})` on a `<select>` nested in its own `<label>` can
   match ZERO elements** — the label's text is the full recursive `textContent` including every
   `<option>`. Use `page.locator("label", {hasText}).locator("select")`, or `getByRole("combobox")`.
   (Recorded in HANDOFF §5a during Task 17.)
5. **The review blind spot Codex exposed:** per-task reviews verified each task against its brief,
   and the whole-branch review covered cross-cutting concerns — but neither systematically asked "is
   every spec deliverable *reachable through the product*?" Four spec deliverables shipped API-only
   (credit apply, void/correct, exempt flag, standalone write-off) and one brief-vs-spec conflict
   (POSTED apply) slipped past, because the demo/E2E flow only exercised the happy path. A future
   phase's review should add an end-to-end deliverable-reachability pass.
6. **Two host crashes** (environmental, resource contention) cost zero committed work — the execution
   ledger + git history held as the source of truth, and the crash-interrupted Task 13 was recovered
   from the working tree intact and gate-verified before committing. Reinforces: commit early, and
   the ledger is the recovery map.

## What 5C inherits (spec §17)

`Application` + `Payment.paymentTypeId → PaymentType.glAccountId` are the cash-side GL source (5B
posts nothing); `BillingConfig` is where 5C's remaining GL defaults belong; the month-end close reads
5B's point-in-time aging (see issue #78 on its reproducibility limits); finance charges stay excluded
from the GL/QBO export; a `WRITE_OFF` carries a reason, not a GL-account choice. 5C is month-end
close + the QuickBooks Online summary export.
