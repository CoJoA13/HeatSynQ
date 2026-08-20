# Phase 5B demo — Accounts Receivable (2026-08-09)

A walkthrough for the owner: what shipped across the 17 tasks of Phase 5B, the 17th E2E flow with
its screenshots, how to watch it live, what changed for daily use, and five deviations that need
your ruling before this merges — named here individually, not left for you to find.

## What Phase 5B delivered

Your shop can now **collect on the invoices Phase 5A raises.** A deposit **batch** (`/receivables`)
holds one or more checks/cards/ACH payments received the same day; each payment can be **applied**
across one or more finalized invoices — including across a parent customer's divisions, one payer
settling several children's paper at once — as a **partial or full payment**, an **early-pay
discount** (offered automatically once the customer's Terms carry `discountPercent`/`discountDays`
and the payment lands inside the window), and a **write-off** (always requires a reason, gated on
the new `write_off` special action). Whatever a payment doesn't settle sits **on-account** — an
unapplied receipt, appliable to a later invoice at any time, never a negative balance and never
posted anywhere.

No balance is ever cached: `Invoice`, `Payment`, and `Credit` all derive their open/on-account/
remaining figures **live from `Application` rows** every time they're read (spec §4.2) — the same
discipline 5A held for invoice totals. **Aging** (`/receivables/aging`) buckets every open invoice
by due date **as of any chosen date** — Current / 1–30 / 31–60 / 61–90 / 90+ — with a separate
**Unapplied** column for open credit remaining and payment on-account (never folded into a bucket),
filterable by customer or a parent's whole family, Excel-exportable. Point-in-time by construction:
re-running a past as-of date reproduces the exact figures that stood then, because only invoices
finalized on/before that date and only applications applied on/before it ever enter the sum — the
same reproducibility 5C's month-end close will lean on. **Statements** (`/receivables/statements`)
assemble a customer's (or, combined, a family's) open items, aging summary, and an **opt-in finance
charge** (a monthly percent on non-exempt past-due balances, informational only — never posted, spec
§7) into a PDF, print it through the same render → archive bracket every other document in this
system uses, and list every statement ever printed for that customer. A **run** prints one for
every customer carrying a nonzero balance in one click.

A finalized invoice that has taken a payment, discount, write-off, or credit can no longer be
unlocked, discarded, or have its order voided out from under it — `invoice-guards.ts`'s new
`hasReceivableActivity` (and, for the order-wide case, `hasReceivableActivityForOrder`) refuses
each of those, naming the guard, the correction being to void the application first.

All of it is covered by **the vitest suite** (1860 tests) and the **seventeen-flow Playwright
harness** this task adds the 17th flow to. Spec:
`docs/superpowers/specs/2026-08-08-phase-5b-accounts-receivable-design.md`. Plan:
`docs/superpowers/plans/2026-08-08-phase-5b-accounts-receivable.md`. Execution ledger (every task's
brief, report and review verdict): `docs/execution/2026-08-08-phase-5b-accounts-receivable/`.

**The 17 tasks, in build order:** `ar-constants.ts` + the `receivables` permission area + the
`write_off` special action + the batch-number counter; the schema (three new tables, two
hand-written `CHECK`s, the registry/audit/sweep surface); the credit raise-date fix (5A carry) +
`Invoice.dueDate` at finalize; Terms/BillingConfig column additions + their admin UIs;
`ar-balances.ts` (the pure open/on-account/remaining derivations); `receipts.ts` + its routes
(batch/payment CRUD, post, void); `applications.ts` (payment/discount/write-off/on-account) + its
routes; credit application; the `invoice-guards.ts` extension + the unlock/discard/void refusals;
`aging.ts` (pure) + its route; `finance-charges.ts` (pure); `statements.ts` + `pdf/statement.ts` +
the STATEMENT document kind + its routes; the `/receivables` batch-entry-and-apply screen; the
aging report screen; the statements screen + the customer page's own A/R section; the routes
401/403 sweep; and this task — the E2E flow, this demo, and the doc updates.

## The 17th E2E flow

Run with `npm run test:e2e` from `erp/` — this now runs **seventeen** flows in sequence (the
sixteen from Phases 2C–5A, unchanged, plus this one, last). Screenshots and a `video.webm` land in
`erp/e2e-artifacts/receivables-apply-age-statement/` (gitignored — reviewed locally, not
committed).

### 17. `receivables-apply-age-statement` — apply a payment, age a balance, print a statement

Keys an order for the A/R fixture's one-operation part (ten units at 100.00 each, no surcharge or
tax on this customer — total exactly 1000.00) and ships it complete, the `invoice-shipped-order.mjs`
precedent for reaching a finalized invoice. On `/invoicing`, creates and finalizes the invoice — the
1000.00 total is asserted before anything downstream depends on it. Opens a new deposit **batch**
on `/receivables`, adds a **700.00 check**, then **applies** it: a **500.00 payment**, the
**20.00 early-pay discount** (2% of the 1000.00 open balance — the customer's Terms are 2/10/30 and
the check arrives same-day, well inside the 10-day window), and a **30.00 write-off** with a typed
reason — leaving **200.00 on-account**. The batch screen's own summary line ("Payment 700.00 ·
Applied 500.00 · On account 200.00") and its Payments table both confirm it.

Opens the **aging report**, filters to this customer, and asserts the row precisely: **Current
450.00** (the invoice's remaining open balance — 1000.00 − 550.00 applied — not yet past due, since
its due date is 30 days out), **1–30 empty**, **Unapplied 200.00** (the payment's on-account cash),
**Net 250.00**. Opens **Statements**, ticks **Combine family** and **Show finance charge (not
billed)** (renamed from "Assess finance charges" by #162 — the figure is shown, never levied),
confirms the preview's total due (250.00) matches the aging report's own Net, **prints** — the
statement archives and reappears in the customer's own **Documents** list.

**Demonstrates:** the whole receipts-to-statement chain in one pass — batch/payment/application
(§4.1), the balance rule with no cached figures anywhere (§4.2), the early-pay discount window and
write-off-requires-reason (§5.2), point-in-time aging with the Unapplied column (§6), and the
statement's print → archive → list seam, combined-family and finance-charge options both exercised.

Artifacts: `erp/e2e-artifacts/receivables-apply-age-statement/02-order-created.png`,
`03-shipment-saved.png`, `04-invoice-draft.png`, `05-invoice-finalized.png`, `06-batch-created.png`,
`07-payment-added.png`, `08-apply-panel-filled.png`, `09-applied.png`, `10-aging-report.png`,
`11-statement-preview.png`, `12-statement-printed-archived.png`, `video.webm`.

*(A note on how these screenshots were produced, the 5A demo's own disclosure repeated here since it
still applies: they come from the Playwright harness's own `page.screenshot()` calls, run as real
headless Chromium against a real `next dev` + database — not hand-captured through an interactive
browser tool for this document. I did not composite or otherwise fabricate any image; every PNG
named above is a byte-real file on disk after the run below.)*

## A real bug this task's own development found and fixed

Two, actually — both in the E2E harness itself, not the application, but worth recording because
the fixes are precedents future flows need.

1. **`getByLabel(..., { exact: true })` on a `<select>` wrapped by its own `<label>` (not
   `aria-label`) can match zero elements.** Playwright's label-text computation for that shape is
   the label's full `textContent`, which for a `<select>` child recursively includes every
   `<option>`'s own rendered text — so "Payer customer" never appears alone; it's concatenated with
   every customer option in the dropdown. Confirmed live (0 matches with `exact: true`, 1 without),
   and confirmed this is a `getByLabel`-specific quirk, not a real accessibility defect —
   `getByRole("combobox")`'s own accessible-name computation collapses to the clean "Payer
   customer". Fixed with a scoped `page.locator("label", { hasText: "…" }).locator("select")`
   instead of chasing `exact`; recorded in `docs/HANDOFF.md` §5a alongside the existing "React
   controlled inputs don't expose `value`" trap, for the next flow that reaches for a `<select>`.
2. **A `<tr>` (or even a `<table>`) `.filter({ has: … })` goes ambiguous across a nested table.**
   The batch apply screen renders its ApplyPanel inside `<td colSpan={8}>` of a row in the OUTER
   Payments table — so a page-wide `tr` filtered on "contains this invoice's order number" matches
   BOTH the actual candidate row AND the outer wrapper row (which "has" that text transitively,
   through its nested table), and the same trap re-appears one level up if you try to disambiguate
   with `table.filter({ has: … })` instead (the outer table "has" it too). Fixed by locating the
   apply table's own unique "Write-off" column header and walking to its **nearest** ancestor table
   (`locator("xpath=ancestor::table[1]")`), sidestepping `has:`'s transitivity entirely.
3. **The dev-DB cleanup harness itself had two real gaps**, both caught by this flow actually
   failing mid-run during development (not by inspection): a `ReceiptBatch` a run creates but never
   pays into is invisible to the customer-scoped cleanup sweep (no `Payment` row to find it
   through) — fixed with an id-driven backstop (`ctx.created.receivablesBatchId`, the `templateIds`
   precedent). And the archived STATEMENT document this flow's own print produces is owned by
   `customerId` alone; deleting the customer without deleting it first NULLs that column out from
   under it via `ON DELETE SET NULL`, which immediately trips `StoredDocument_kind_owner_check`
   (STATEMENT requires `customerId` NOT NULL) — fixed with a dedicated cleanup step that removes it
   first. Both gaps are now closed in `e2e/lib/db-fixtures.ts`, and both surfaced from a real 23514
   / a real orphaned row on this task's own machine, not from reading the code.

## Seed state

Nothing beyond the standard seed: `npm run db:seed`. The E2E run creates its own throwaway fixtures
in the dev database — on top of the existing fixture customers, this task adds an A/R customer
(`E2EARCUST`, `taxable: false`, `surchargeOptOut: true` so its invoice total stays exactly
predictable) with one part carrying **one** priced operation (`E2E-AR-OP`, unit price 100.00), a
dedicated **2/10/30 Terms** row (`netDays` 30, `discountPercent` 2, `discountDays` 10), and a
payment type (`E2E Check`). Everything is torn back out afterward — the invoice, the batch, the
payment, the applications, the printed statement, the shipment, the order, and every audit row — on
success, on a thrown error, or on Ctrl-C mid-run.

## Watching it live

- **Headed Playwright, watch the bundled Chromium click through all seventeen flows:**
  `HEADED=1 npm run test:e2e` from `erp/` — same fixtures and cleanup, just a visible browser.
- **Interactively in your own browser** against `npm run dev` — ask for a specific thing (e.g.
  "open a batch, add a check, apply it with a discount and a write-off, then print a statement")
  and it'll be driven live in a real Chrome window.

## What changed for daily use

- **Receivables** (left nav) is the new area, with its own sub-nav: **Batches** (the deposit
  worklist — open a batch, add payments, apply them across a payer's open invoices), **Aging** (an
  as-of report with a customer/family filter and Excel export), and **Statements** (single or a
  run, combined or per-division, an opt-in finance-charge toggle, print → archive, a documents
  list).
- **The customer page gains an A/R section** (net balance, open items, an aging strip, and
  Apply/Statement links straight into `/receivables`) — the order hub's Invoices-section precedent
  from 5A.
- **Admin → Reference data → Terms** gains net days and the early-pay discount pair (percent +
  days, both-or-neither); **Admin → Billing** gains the plant-wide finance-charge rate.
- Unlocking or discarding a finalized invoice, or voiding the order behind it, is now **refused,
  naming the A/R activity**, once a payment, discount, write-off, or credit has been applied to it
  — void the application first.

## Five things to rule on before this merges

Named here individually, pulled straight from the execution ledger's own "owner rulings owed"
section (`docs/execution/2026-08-08-phase-5b-accounts-receivable/progress.md`) — nothing here is
hidden in the diff for you to find later. Each is presented as what it does / the question / your
options.

> **Owner ruling needed, 2026-08-09 (at demo):**

### 1. The POSTED batch lifecycle is asymmetric, and the on-screen message promises an escape hatch that doesn't exist

**What it does today:** posting a batch (`Post`) locks out adding or voiding *payments* on it
(`receipts.ts`'s `voidPayment` refuses on POSTED) — but `voidBatch` has **no** POSTED guard at all,
so a POSTED batch with **zero live payments** can still be voided, while a POSTED batch that still
holds payments is **fully frozen**: you can't void a payment on it, and you can't void the batch
itself (it isn't empty). The refusal message on `voidPayment` reads "This batch is posted — reopen
or void a payment to change it" — but there is no `reopen`, so the message describes an action that
doesn't exist. On-account cash on those frozen payments can still be applied to invoices at any
time (spec §5.2) — posting a batch never blocks *using* the money, only editing the batch's own
entries.

**The question:** is a POSTED batch supposed to be permanently frozen once it holds any payment
(current behavior, modulo the misleading message), or should there be a way back?

**Your options:**
- **(a) Allow `voidPayment` on a POSTED batch** — the message's own implied behavior; a small code
  change.
- **(b) Add a `reopen`** (POSTED → OPEN) action, so the message becomes literally true.
- **(c) Reword the message** to match what the system actually does (frozen-by-design) and leave
  the behavior as-is.
- **(d) Leave it exactly as built** — POSTED is a deliberate one-way door once a batch holds
  payments, and the message is a minor wording bug to fix separately.

No code change until you rule.

### 2. The early-pay discount is computed on the invoice's OPEN BALANCE, not the amount paid or the original total

**What it does today:** when a payment is applied inside the discount window, the eligible discount
amount is `discountPercent% × the invoice's open balance at that moment` — in this demo's own
numbers, 2% of the full 1000.00 (nothing had been applied to this invoice yet), not 2% of the 500.00
actually being paid, and not tied to whether the payment fully settles the invoice. This is a
genuine billing-policy choice with at least three defensible readings.

**The question:** which basis is correct for your shop's terms?

**Your options:**
- **Open balance at apply time** (current behavior) — the discount tracks whatever's still owed,
  regardless of how much of this particular payment goes toward it.
- **The amount actually being paid** — a partial payment only earns a discount on its own portion.
- **The invoice's original total** — the discount is fixed at issue time regardless of partial
  payments or prior discounts/write-offs.

No code change until you rule — this is the discount-computation function itself
(`applications.ts`'s `discountFor`), not a display issue.

> **RULED 2026-08-19 (issue #69, spec §15) — this question is closed, and the answer changed the
> question.** The basis stays option 1, the **open balance** — nothing about the computation moved.
> What the owner added is a *settlement guard* on top of it, which none of the three options above
> contemplated: **the discount is earned only by a payment that settles the invoice**, so a partial
> payment inside the window earns nothing at all. In this demo's own numbers, the 500.00
> part-payment above would now be offered — and allowed — **no discount**; the 2% is earned by
> remitting 980.00 against the 1,000.00. Both read sites enforce it (`discountAvailable` offers,
> `applyPayment` caps independently), and the two E2E flows that used to take 20.00 on a partial now
> assert that the offer is absent. Left in place because the reasoning above is still the record of
> what was asked and why.

### 3. `runStatements` sends a statement to a customer with a CREDIT balance (you owe them), not just an open balance

**What it does today:** the "run for everyone with a balance" batch print skips only customers with
an exactly-zero net; a customer whose net is negative — a pure credit sitting on their account,
nothing currently owed — still receives a statement. Spec §8 says "everyone with an open balance,"
which doesn't say whether a credit balance counts as one.

**The question:** should a credit-balance customer get a statement in the run, or only customers who
owe money?

**Your options:**
- **Leave it as-is** — arguably correct: a customer holding a credit should see it reflected on
  paper, the same as one who owes.
- **Positive-net only** — a one-line change (`runStatements`, `statements.ts`) if you'd rather the
  run stay strictly "who owes us."

### 4. The customer page's A/R section shows that customer's OWN activity only — never its family's

**What it does today:** the A/R section on a customer's own page (net balance, open items, aging
strip) is scoped to that one customer's own rows, even when it's a parent with children or a
division with siblings — it deliberately does NOT roll up the whole family the way the aging report
and a combined-family statement do. (This was a real fix mid-build — Task 15's first review round
caught the section originally composing mismatched scopes, a division's own net shown above the
whole family's open items.)

**The question:** is single-customer scope correct for this page, or do you want the option to see
a parent's whole family at a glance without navigating to `/receivables/aging`?

**Your options:**
- **Leave as-is** — the page mirrors "this record's own paper," and the aging report already
  answers the family question.
- **Add a family roll-up option** — a follow-up task; needs a `Customer` column on the open-items
  table so rows from different divisions can be told apart on one page.

### 5. A vestigial `"ar"` permission area still sits in `AREAS`, doing nothing, beside the real `"receivables"` area

**What it does today:** `src/lib/permission-constants.ts`'s `AREAS` list carries both `"ar"` (a
placeholder from the original 12-area model, long before this phase existed) and `"receivables"`
(the area this phase actually built and wired to every A/R route). `"ar"` is granted by no seeded
role, checked by no route, and referenced nowhere except one generic permissions test that iterates
every area — confirmed by grep across the whole codebase.

**The question:** leave the dead entry, or clean it up now that the real area exists?

**Your options:**
- **Leave it** — harmless; nothing grants it, nothing checks it, and removing it is pure
  housekeeping with zero behavior change.
- **Remove it** — a small, contained change (`permission-constants.ts`'s `AREAS` array plus the one
  test assertion that names it) now that `"receivables"` has made it fully redundant, rather than
  carrying a confusing "which one is real" question into Phase 5C and beyond.

## Gate results this doc is based on

All four quality gates plus the E2E suite were run clean on the `phase-5b-accounts-receivable`
branch immediately before writing this doc: `npm test` — **1860 tests, 120 files, all passing**;
`npx tsc --noEmit` clean; `npx eslint src tests e2e` clean (one pre-existing, unrelated warning in
`cert-results-print.mjs`); and `npm run test:e2e` — **17/17** flows passed. Both databases report no
pending migrations. See `docs/execution/2026-08-08-phase-5b-accounts-receivable/task-17-report.md`
for the full run history, including the two flow bugs and the two harness cleanup bugs this task's
own development found and fixed (recorded above) before reaching this clean run.
