# Round 2, Group B — implementer report

**Branch:** `group-b-ar` · **Base:** `1c1fc77` · **PR:** #135
**Gate evidence is re-run per round**, never carried forward (round 2's own lesson on Group A).

| Commit | Covers |
|---|---|
| `122043b` | the #75 owner ruling, recorded before any code |
| `31b96be` | #86 — negative finance-charge rate |
| `35d846b` | #82 — the Terms discount-pair DB CHECK |
| `26dd0a9` | #79 — the invoice's frozen issued terms (+ migration and backfill) |
| `ce828af` | #83 + #75 — complete open items, and applying a credit from there |
| `773ea2e` | #85 — per-division statements |
| `a514ab9` | the docs, including the two rules that generalize |

## What changed, and why it is shaped this way

### #79 — the invoice carries the numbers behind its own `termsName`

`discountAvailable` and `applyPayment` both read `invoice.customer.terms` — the customer's terms
RIGHT NOW — so moving a customer between terms rewrote what invoices already in their hands were
worth. An invoice sent under `2/10 Net 30` lost its discount; one sent under plain `Net 30` gained
one it never offered. An invoice is frozen paper (§5.4).

`termsDiscountPercent`/`termsDiscountDays` are written at finalize beside `dueDate`, INVOICE-only (a
credit offers no early-pay discount and gets no due date either). `netDays` is deliberately **not**
duplicated — `dueDate` already freezes its only effect.

**Two things the issue did not say, and both matter:**

1. **The migration has to BACKFILL.** Without it every already-finalized invoice reads a null pair
   and offers no discount — the fix would silently withdraw something the shop has already promised
   in writing. The backfill copies each finalized invoice's customer's current terms, which is
   precisely what those invoices compute today, so existing paper behaves identically.
2. **There are TWO read sites.** `discountAvailable` feeds the screen, but `applyPayment` caps the
   DISCOUNT line independently. Fixing only the first would have left the SAVE granting a discount
   the screen refused to offer. Both go through one `issuedTerms` helper, and there is deliberately
   **no fallback** to the live relation — a fallback is how the retroactive read creeps back in.

### #83 + #75 — one task, because the second acts on what the first builds

The aging strip has always folded open credits and on-account cash into `unapplied`/`net`; the table
listed finalized INVOICES alone. The number above the table could not be arrived at from the rows in
it, and a customer holding nothing but a $200 credit read "−$200.00" over "No open invoices".

`openItemsForCustomer` composes all three kinds — credits and cash NEGATIVE, as they move the net —
on the same `ar-balances` bases the strip uses. **The rows sum to the net, and that sum is the
test.** Both halves are read from ONE RepeatableRead transaction (the `agingReport` precedent named
in CLAUDE.md): reconciliation is the entire point of this pair, so it must not depend on two
autocommit reads landing on the same side of a commit. Still a pure read — no claim, no write.

The Apply control sits on the credit's own row, prefilling the oldest open invoice and the smaller of
the two balances so it never offers an amount the save would refuse. Gated on `receivables.create` —
the route's own gate — disabled-with-a-reason rather than offered and then refused (§5.16).

### #85 — the per-division choice actually prints per division

`printStatementsPerDivision` archives one statement per live family member, shaped exactly like
`runStatements` (settings read once outside, one Serializable print transaction per member) because
it is the same act at a different scope. A childless customer yields exactly its own, so no caller
has to ask whether this one is a family head. Unlike the run it does **not** skip a settled member:
the operator asked for this family by name, and a division owing nothing still gets the paper saying
so. The route returns the LIST rather than a PDF (N documents cannot be one blob) and takes no
`combineFamily` flag — accepting one that could only ever be false invites a caller to set it true
and quietly get something else.

### #86 / #82 — small, with disproportionate failure modes

#86 is one missing word (`nonnegative`), which the sibling field two lines below and
`BillingConfig`'s own rate both carry. The failure is **silent**: a negative override wins over a
valid plant rate, `financeCharge` returns a negative, and its `> 0` gate collapses that to null — the
customer simply stops being charged.

#82's service validation reads the stored row BEFORE the row-locking update at the default isolation
level, so two concurrent PATCHes can each validate against the same stale view and the loser leaves
the broken pair. `Terms_discount_pair_check` closes it at the only layer both transactions share.
Written `(a IS NULL) = (b IS NULL)` — a plain boolean, never NULL — so it cannot be accidentally
permissive on exactly the null case it polices. It also catches a case no service check covered: a
row **created** broken.

## Testing

RED-verified, each failing for the filed reason before its fix:

| Test | RED failure |
|---|---|
| #86 negative rate | create **resolved** instead of rejecting |
| #82 DB CHECK | the broken pair **wrote through** (constraint dropped to prove it) |
| #79 discount kept | **0**, expected 20 — the discount the paper promised |
| #79 discount not granted | **20**, expected 0 |
| #79 apply refuses | **resolved** instead of rejecting — the save would have allowed it |
| #79 finalize freezes | **undefined**, expected 2 (the write reverted to prove it) |
| #83 rows sum to net | table summed **1000** under a net of **650** |
| #83 credit-only customer | **empty** table |
| #83 on-account labels | **empty** |
| #85 per-division | `printStatementsPerDivision` did not exist; then the route returned parent-only |

**Two needed the honest technique rather than a normal run.** A DB constraint cannot go RED while it
exists, so #82's was verified by DROPPING it, watching the broken pair write through, and restoring
it — which left one violating row that had to be cleared deliberately before the constraint would
re-add (`erp_test` only; `truncateAll` would have cleared it next run anyway). #79's finalize write
was verified by reverting just that write.

One test is **green on arrival** and is kept as a regression guard, not offered as evidence: "omits
settled items entirely" in `customer-receivables.test.ts` — a settled invoice was already filtered
before this branch.

**Three of the six are UI deliverables and were verified in the browser** — real data seeded, real
flows driven, data cleaned up afterwards (the dev DB was empty before and after):

- **#83/#75:** the table showed all three kinds summing exactly to the net (590). A real credit apply
  moved the invoice 940 → 740, consumed the credit, dropped unapplied 350 → 150, and left the net at
  590 — applying a credit moves money between buckets rather than changing what is owed. No console
  errors.
- **#85:** all four button states verified (family head un-combined → "Print per division"; head
  combined, a division, a standalone → "Print"). Running it produced three statements with the
  correct per-member totals (100 / 200 / 300) and three archived PDFs, each owned by its own
  customer, confirmed in the database.

**Fixtures changed:** three build finalized invoices directly rather than through `finalizeInvoice`,
so they now write the frozen terms that finalize writes — otherwise they model an invoice that cannot
exist. Two route tests asserted the old open-item row shape; their intent (no family roll-up) is
preserved and **strengthened**, since on-account cash is now a ROW and a leak shows up as an extra
row as well as a wrong total.

## Gates

| Gate | Result |
|---|---|
| `npm test` | **3118 passed / 183 files** (from 3104) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | clean |
| `npm run test:e2e` | **23/23**, exit code checked directly |
| `prisma migrate status` | up to date on **both** databases |

**Two migrations**, both applied to `erp` and `erp_test`, neither destructive:
`20260817121616_terms_discount_pair_check` (verified against zero violating rows in both databases
first) and `20260817121950_invoice_terms_discount_snapshot` (additive columns + the backfill).

## A mistake worth recording

**My first E2E run failed and my own wrapper reported exit 0.** `npm run test:e2e > log 2>&1; echo
"EXIT=$?"` captures the echo's status, not the run's. The failure was real — the dev server used for
browser verification still held port 3000, so Next refused to start the E2E server — and it was only
caught by reading the log. That is exactly the fails-while-reporting-success shape this project keeps
hunting, built into my own tooling. Re-run with the port free and the exit code checked directly.

## Known limits, stated rather than hidden

- **#79's backfill uses the customer's CURRENT terms**, because that is what those invoices compute
  today and the goal was to change nothing for existing paper. It is not archaeology: if a customer
  was reassigned *before* this branch landed, the backfilled figure is the post-reassignment one. No
  record of the original assignment exists to recover, which is the very gap this column closes going
  forward.
- **#85 prints a statement for a settled division.** Deliberate (the operator named this family), but
  it means "print per division" on a large family produces paper for members who owe nothing.
- **#75's apply targets only the customer's OWN open invoices**, not the family's, because the
  section is single-customer by design (the Task 15 fix round). `applyCredit` itself permits a family
  target; reaching one still needs the batch screen.
