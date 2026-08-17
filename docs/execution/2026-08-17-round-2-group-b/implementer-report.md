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

Re-run in full at every round, never carried forward:

| Gate | Round 0 | Round 1 (review fixes) |
|---|---|---|
| `npm test` | 3118 / 183 files | **3121 / 183** |
| `npx tsc --noEmit` | clean | clean |
| `npx eslint src tests` | clean | clean |
| `npm run build` | clean | clean |
| `npm run test:e2e` | 23/23 | **23/23**, exit code checked directly |
| `prisma migrate status` | both DBs up to date | both DBs up to date |

**Three migrations**, all applied to `erp` and `erp_test`, none destructive:
`20260817121500_terms_discount_pair_normalize` (added in review round 1, deliberately timestamped
AHEAD of the constraint it protects — see its own header), `20260817121616_terms_discount_pair_check`
and `20260817121950_invoice_terms_discount_snapshot` (additive columns + the backfill).

## A mistake worth recording

**My first E2E run failed and my own wrapper reported exit 0.** `npm run test:e2e > log 2>&1; echo
"EXIT=$?"` captures the echo's status, not the run's. The failure was real — the dev server used for
browser verification still held port 3000, so Next refused to start the E2E server — and it was only
caught by reading the log. That is exactly the fails-while-reporting-success shape this project keeps
hunting, built into my own tooling. Re-run with the port free and the exit code checked directly.

## Review round 1 — TWO independent reviewers, and they agreed

Codex posted 6 findings on PR #135 (1 P1, 5 P2); the task reviewer returned Spec Compliance ❌ /
**Needs fixes** with 2 Important. **Both found the same two Important issues independently**, which is
the strongest signal either could have given.

| Finding | Source | Disposition |
|---|---|---|
| **The CHECK migration fails on an upgraded install carrying a half-pair** — `ADD CONSTRAINT` validates immediately, and production applies migrations on container start | Codex **P1** | **Fixed.** A normalization migration slotted *ahead* of the constraint nulls both halves of any half-pair. Behaviour-preserving, not a data decision: `discountFor` already returns 0 unless BOTH are set, so this writes down what the row already meant. Proven against the real scenario — violating row present, constraint refuses; normalize; constraint adds. Checking my own two databases said nothing about anyone else's, which was the actual mistake. |
| **`openItemsForCustomer` dropped all three point-in-time cuts**, so a post-dated check breaks the sum #83 exists to establish | **Both** | **Fixed.** One `asOf` is sampled once and handed to both halves, with the same three filters (`receivedDate`, `appliedDate`, `finalizedAt`). The task reviewer's worst repro — a fully post-dated settlement showing an empty table reading "Nothing open — this customer is settled" beneath a net of the entire receivable — is now a test. |
| **#85's per-division detection is scoped to ACTIVE while both service halves use LIVE**, so a parent whose divisions are merely deactivated still printed parent-only | **Both** | **Fixed.** The screen fetches `includeInactive=1`; inactive customers are listed and *labelled*, which also makes an inactive division's statement reachable at all. |
| Per-division prints documents the preview never showed | Codex P2 | **Fixed** — the confirm names every member (marking inactive ones) and says the preview covers this customer only. |
| The generated per-division documents are unreachable from the screen | Codex P2 | **Fixed** — each result links to its own archived PDF. |
| The credit-apply picker offers only the customer's OWN invoices, though `applyCredit` permits a family target | Codex P2 | **Not changed — raised for the owner.** The section is single-customer *by design* (the Task 15 fix round closed a real bug where family invoices leaked in), so widening it reverses a prior decision on a UX question the shop should answer. The task reviewer separately confirmed a cross-family credit **reconciles correctly in both directions**, so this is a reach gap, not a correctness one. |
| Schema comment overstated when the pair is null | task reviewer | **Fixed** — "null until first finalize"; unlock leaves the pair standing. |
| A `Terms` CHECK violation surfaces as a raw 500 | task reviewer | **Not changed** — consistent with the `Application_source_check` precedent; noted. |
| No cleanup pass for an already-negative `financeChargeRate` | task reviewer | **Not changed, deliberately.** Nulling it means "inherit the plant rate", which could *start* charging a customer who is not charged today — a business consequence, and #76 (are finance charges even used?) is PARKED on the accounting meeting. |
| Loose `/discount/i` matcher | task reviewer | **Fixed** — pinned to "no early-pay discount applies", verified that string exists. |
| A second green-on-arrival test unnamed | task reviewer | **Fixed here:** the CREDIT half of the #79 finalize test (`termsDiscount* === null`) is trivially green once the columns exist; the reported RED covered only the INVOICE half. |
| Cosmetics: `-Math.abs` redundancy, O(n^2) filter | task reviewer | **Fixed** — `creditRemaining` is already positive; the invoice list is hoisted out of the row map. |

**One defect I introduced during the fixes and caught myself:** hoisting that filter left a reference
to a variable I had not defined. `tsc` caught it; `npm run build` did **not** (0 errors) and neither
did eslint — a reminder that the build is not a typecheck.

Also added `type="button"` to both new buttons. They are not inside a form today, so nothing was
broken, but an untyped `<button>` defaults to `submit` and the codebase sets it explicitly elsewhere
(`LogoPanel.tsx`).

## Review round 2 — five more from Codex (2 P1, 3 P2)

All five verified against the code first; all five fixed.

| Finding | Disposition |
|---|---|
| **P1 — the divisions route returned financial totals on `receivables.create` alone.** Permissions resolve independently (DENY → GRANT → role), so create-without-view is reachable, and the body carries every member's code, name and Total Due | **Fixed** — the route requires BOTH grants. The test now pins all three cases: view-only 403, **create-only 403**, both 200. |
| **P1 — the terms LABEL and the terms FIGURES could describe different terms.** `termsName` is stamped at create and is editable on a draft; `dueDate` and (now) the discount pair derive at finalize. So finalized paper could say "2/10 Net 30" over a null pair — promising a discount `applyPayment` refuses — or say "Net 30" while quietly granting one | **Fixed** — finalize stamps the label from the SAME terms as the figures, because finalize is the moment the paper is issued. **Only when the customer HAS terms:** with none, the operator's typed text is the only description of the terms on that invoice, and blanking it would erase real information to fix nothing (the figures are null either way). That guard is its own test, and it was green before the fix — it exists to catch the over-correction, not to prove the fix. |
| **P2 — `finalizedAt` is a bare `DateTime` with a time of day while `asOf` is midnight**, so an inclusive `lte` dropped everything finalized since midnight TODAY while the aging strip (date-only) counted it | **Fixed** — half-open upper bound. **CLAUDE.md documents this exact trap** for the GL export's month interval; this was the same bug one scope down, walked into with the lesson already written. |
| **P2 — a `Terms` CHECK violation escaped as a raw 500.** Reaching it means two writers raced past the service validation: the loser's request was not wrong, it lost | **Fixed** — `db-errors.ts` translates the NAMED constraint to a 409 "try again". Deliberately a named allowlist, not a "message contains 'check constraint'" sniff, so a CHECK nobody has reasoned about still surfaces loudly. Round 1 had marked this "not changed, consistent with precedent"; two reviewers raising it earned the fix. |
| **P2 — the per-division button was enabled for a view-only user**, who would confirm a multi-document print and get a 403 | **Fixed** — the button's gate now includes `receivables.create` whenever per-division mode is active (§5.16: disabled and says why, never offered then refused). |

## Review round 3 — two more, both in round 2's own code

| Finding | Disposition |
|---|---|
| **P1 — my round-2 no-terms exception produced the exact bug it was added to prevent.** A draft created under `2/10 Net 30` whose customer's terms are cleared before finalize kept the INHERITED label over a null pair — paper promising a discount `applyPayment` refuses | **Fixed by REVERSING round 2.** The label now always follows the terms, blank included. Nothing in the stored state distinguishes an inherited label from a typed one, so the conditional could only ever guess. Stated cost: a hand-typed label for a customer with no terms record is cleared at finalize; restoring it needs real state (`Invoice.termsId`, or an edited flag), named on the PR thread if the shop ever hits it. |
| **P2 — the print path was decided from an asynchronously-populated list.** Opening with `?customerId=` before the fetch lands, or after it fails, or without `customers.view`, made `customers` empty → ordinary single print → silently the parent alone | **Fixed** — a `familyKnown` flag distinct from "the array is empty" (§5.15 again), and printing is disabled with a reason until the family lookup succeeds. Which path is correct genuinely depends on that list, so acting without it is a guess. |

**The pattern is worth naming.** Round 2's finding was in round 1's code; round 3's P1 was in round 2's
code — on the same field, in opposite directions. That is this project's recorded lesson 4 ("when
consecutive rounds keep finding defects in the code written for the previous round, the design is the
finding"), and here the design finding is real: `termsName` is free text that is supposed to describe
structured terms, with no link to the `Terms` row it came from. The fix rounds have been patching a
missing FK. `Invoice.termsId` is the actual answer, and it is now written down rather than rediscovered.

## Review round 4 — two, and the first one hit a limit I had written down but not fixed

| Finding | Disposition |
|---|---|
| **P1 — the backfill copied the customer's CURRENT terms**, so an invoice finalized before a terms reassignment gets the wrong pair *permanently* once this ships: a `Net 30` invoice granted a discount it never offered, or a `2/10 Net 30` invoice losing one | **Fixed** by a follow-up migration that re-derives the pair from the invoice's OWN frozen `termsName` (`Terms.name` is unique among live rows, so the match is unambiguous). Proven on the exact scenario: the old backfill left a `2/10 Net 30` invoice with a null pair; the new one restores 2.00. **I had written this limit into this very report** as "not archaeology… the backfilled figure is the post-reassignment one" — and left it. Codex was right that `termsName` is better evidence than the relation that caused the original bug. Stating a limit is not the same as accepting it. |
| **P2 — a partial family batch threw away committed work.** Each member is its own committed transaction; a later failure threw, the screen cleared its list, the already-archived documents became unreachable, and a retry duplicated them | **Fixed** — `printStatementsPerDivision` returns PARTIAL results: every member is reported, successes keep their `documentId`, failures carry the reason. Atomicity was the wrong direction (it would mean holding N Serializable transactions open across N PDF renders). The screen now shows failures in amber and says "Printed X of Y". |

## Review round 5 — and the point at which inference had to stop

| Finding | Disposition |
|---|---|
| **P1 — even the label-based backfill cannot reconstruct history.** `updateReference` permits changing a Terms row's figures and its NAME independently, so a matched row may carry figures it did not have when the invoice was issued (2% issued, 3% today), and a renamed row matches nothing and gets cleared | **Fixed by drawing a provable line instead of guessing again.** `Terms.updatedAt` proves it: if the row has not been touched since `finalizedAt`, its current figures ARE the issued figures. Everything else is cleared. Deliberately conservative — `updatedAt` bumps on any field change, so some rows whose discount never moved are declined. Declining costs a discount an operator can grant by hand; guessing costs money out the door on paper the shop cannot take back. |
| **P1 — #86 left existing negative rates in place**, so the silent not-being-charged persists until someone edits that one field | **Fixed** — a migration clears them to null (inherit the plant rate), the only meaning a negative could ever have had. In practice it changes nothing today: finance charges are opt-in per run and the plant rate is itself null unless configured. |
| **P2 — the partial-result body carried RAW exception text.** The route returns 200 with the message inside, walking around `handle`'s HttpError-only discipline; Prisma diagnostics or server paths could reach any receivables user | **Fixed** — `HttpError` messages pass through (they are written for operators), anything else is logged server-side and reported as a generic line. The test asserts the raw text does NOT appear. |

**This is where the inference stopped, and that is the finding.** Four successive backfills — customer's
current terms → the invoice's own label → label plus a provability guard — each was a better guess,
and each review round found the next way a guess could be wrong. The design finding underneath is
simple: **history that was never recorded cannot be reconstructed.** The provability guard is not a
fourth guess; it is the boundary of what the stored data can actually support, with the un-provable
set explicitly emptied and documented rather than filled with something plausible.

**The question this raises for the owner** — asked on the PR and worth repeating here: *does the
production database contain any finalized invoices at all?* The parallel-run month has not happened,
and if the answer is none, every one of these backfills is a no-op and the whole line of argument was
about an empty set.

## Review round 6 — the stop-reviewing rule applied

One P2: `familyMembers` comes from a one-time fetch, so a division created while the page is open is
silently omitted from a per-division print.

**Triaged to #136, not fixed** — CLAUDE.md's 2026-08-06 owner ruling: from round 6 onward, findings go
to issues unless they are correctness, concurrency or data-integrity defects. This is stale client
state: every document that prints is correct, one can be missing, nothing is corrupted, and the
result list shows the operator exactly which members were printed.

**And three rounds have now landed on the same seam** — the client choosing the print path from a
list it holds: round 1 (the list was `active`-only), round 4 (it might not have loaded), round 6 (it
can be stale). That is the convergence signal the ruling exists for. A fourth client-side patch is
predictably wrong; #136 records the server-side fix and the one question inside it that belongs to the
owner — whether a parent-only statement is ever legitimately wanted, which decides whether the single
-print route should simply refuse for a parent printed uncombined.

## Review round 7 — fixed, not triaged, and why the rule allows it

One P2: a rejected credit application routed its message into the section's shared `error`, which
gates the whole summary (`loaded && !error && summary`) — so the failure **unmounted the very form
that produced it**, removing the only control that could clear it. The operator's only way back was a
page reload.

**Fixed rather than triaged**, and the round-6 rule permits it: the exception is for correctness
defects, and a delivered control that traps the operator on a mistyped amount is not a working
control. It is also the §5.14 principle applied to a form — a block must name a route out of itself,
and this one removed the route. The fix is one piece of local state with no design question attached,
which is the opposite of the churn the stop-reviewing rule guards against.

Verified in the browser rather than by reasoning: typed $400 against a $100 invoice, confirmed the
form stayed mounted with the amount preserved and "That exceeds the invoice's open balance of 100"
beside it, corrected to $100 in place, and watched it apply — invoice settled, credit drawn down
500 → 400, error cleared, rows still summing to the net.

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
