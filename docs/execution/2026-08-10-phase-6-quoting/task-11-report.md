# Task 11 report — The quote E2E flow, docs, final gates

**Implementer:** subagent (task-11) · **Date:** 2026-08-11 · **Branch:** `phase-6-quoting`

## Commits

- `34666c6` feat(e2e): the quote lifecycle flow — 19th and last (spec §12, plan Task 11)
- the docs commit carrying this report, the HANDOFF §4 build-complete state, the two CLAUDE.md
  standing-convention sentences, and the ledger's Task 11 row + closing entry

## The flow's shape and what it proves

`erp/e2e/flows/quotes.mjs`, registered as the 19th and last flow in `e2e/run.mjs`, as admin.
**Deviation from the plan's file name:** plan Task 11 says `erp/tests/e2e/quotes.spec.ts`, but the
E2E harness has never been Playwright-test-runner specs — it is `e2e/run.mjs` + `e2e/flows/*.mjs`
(HANDOFF §5a's bundled-Chromium path drives the raw `playwright` library). The flow follows the
harness's real convention, exactly as every phase's E2E task before it did.

One coherent lifecycle, against its own fixture customer/part (`E2EQUOTECUST`/`E2E-QUOTE-PART`,
`e2e/lib/db-fixtures.ts`):

1. **Ending statement** created live on the admin reference page with Default ticked — exercises
   the Task 2 boolean extra column and the at-most-one-live-default promote through the real
   audited service. The pre-run default (if the dev DB has one) is demoted by that promote and
   **snapshot-and-restored by cleanup** (`priorDefaultEndingStatementId`, the `priorBillingConfig`
   precedent).
2. **Quote created** from `/quotes`' New-quote section with the part-linked first line; the detail
   page's server defaults asserted: allocated number, quote/effective date = today, expiry ≥
   effective, and the header select sitting on THE default ending statement with its text rendered
   (ruling 13). Dates are asserted on the **UTC calendar day** — `todayDateOnly()` floors to UTC
   midnight, so at 10pm CDT the app's "today" is the next local date; the flow's first run caught
   this live and the flow now computes every date UTC-side.
3. **The agreement built out**: line 1 gains a priced operation (setup 25.00 / unit 4.50 /
   minimum 50.00, price-per EACH) plus a **price break** (threshold 100 → 4.00) and a quoted qty;
   line 2 is a **free-text line** with its own each-weight (ruling 1's XOR; the eachWeight carry
   is the Task 4 Minor that Task 8's diff-builder closed). One single-save PATCH; the break's
   server round-trip is asserted back out of the re-adopted form.
4. **Print** → the Task 10 print→archive seam: the stored QUOTE document appears in the page's own
   Documents list.
5. **Order entry**: customer + the quoted part through the real entry page; the **"Quote #N"
   auto-link preview appears BEFORE the save** (spec §5.2 — the preview is display, the wire stays
   ABSENT, the server resolves the same answer inside the save); after save, the hub's Lines table
   shows the **stored** link (ruling 6).
6. **Ship complete → DRAFT invoice**: the invoice grid shows exactly ONE operation row, zero
   "needs price", the row's source label **"Quote #N"**, and the amount at the quote's own
   arithmetic — 25.00 setup + max(10 × 4.50, 50.00 minimum) = **75** (the 5A "Plus/Or" reading;
   the first run of the flow expected 70 and the app was right). The proof is sharp because the
   fixture part carries **no PartPrice at all**: a failed link could only read "needs price",
   never a silently part-priced row (ruling 4's no-fallback, demonstrated structurally).
7. **Close with a reason** → the warn-and-list banner names the one open, not-yet-fully-invoiced
   linked order, linked (ruling 6's close warning), scoped to the banner because the line card's
   own §5.14 "Priced on order(s)" indicator links the same number.
8. **Worklist**: a second quote backdated (effective −40d, expiry −2d, follow-up −5d, all UTC)
   lands in BOTH §5.4 sections — follow-up due AND expired, the deliberate same-quote overlap —
   with the derived Expired badge on its heading, while the CLOSED first quote appears in neither.

**Why the invoice deliberately never finalizes** (three stacked reasons, also in the flow header):
the close warning needs a linked order that is not fully invoiced; the flow runs after
`close-month-end`, which leaves the current month CLOSED until teardown, and finalize is
period-guarded while draft creation is not a posting mutation; and a draft has no `finalizedAt`,
so it can never contaminate the close flow's readiness/export scope (which is also why the quote
fixtures carry no GL accounts).

**Fixture hygiene:** `db-fixtures.ts` gains `deleteQuotesAndChildren` (QUOTE documents first —
`StoredDocument.quoteId` is SET NULL, which would violate the kind→owner CHECK; then breaks →
prices → lines → quotes, all RESTRICT; audit rows keyed entity-"quote" and per-document swept;
runs before the step-code/part/customer/user deletes, all RESTRICT) and
`deleteEndingStatementFixture` (name-driven — the `liveTemplateName` precedent — with the pre-run
default re-promoted from `create()`'s snapshot). The quote customer rides every existing scope
the other document-producing flows ride (invoices, shipping, orders, parts). Verified empty
after the standalone run AND after the final full run: quotes/lines/prices/breaks 0, E2E
customers/parts/users 0, fixture statement gone, no live default left behind, QUOTE documents 0,
entity-"quote"/"endingStatement" audit rows for fixture rows 0.

## Product defects exposed (reported, not patched)

**None.** Both mid-development failures were wrong expectations in my own flow, not app bugs
(the UTC "today" and the Plus/Or minimum arithmetic — both now documented in the flow).

One **pre-existing dev-DB hygiene finding**, not from this flow: the dev database holds **4
orphaned `entity: "quote"` AuditLog rows** (two create/delete pairs, actor "Administrator",
2026-08-11 17:26–17:33 UTC) whose quote rows no longer exist — residue of the Task 10 controller
verification pass, whose smoke-fixture purge removed the quote rows but not their audit rows.
My cleanup correctly does not touch them (they are another actor's rows outside the fixture
scope). Flagged for the whole-branch review to note; harmless (the admin audit log shows two
deleted-quote trails with no surviving entity).

## Docs updated and why

- **`docs/HANDOFF.md` §4** — the current-phase state replaced with the build-complete state:
  all 11 tasks, dated final gate numbers, and the owner-ratification queue assembled in one
  place (below). §9's kickoff note untouched (the merge itself moves the narrative to history).
- **`CLAUDE.md`** — two standing-convention changes, each displacing nothing:
  (1) the row-locks paragraph gains the Phase 6 **STANDING INVARIANT** sentence (the period-lock
  precedent): the order save that links a quote line is Serializable AND reads the quote line
  in the same transaction, SSI-paired with the quote side's Serializable writers — either side
  downgraded breaks §5.14 silently; `tests/quote-links.test.ts`'s dangerous-direction test pins
  it. (2) `quote-links.ts` joins the dependency-free-leaf enumeration beside
  `order-locks.ts`/`errors.ts`/`invoice-guards.ts`. No counts added (the "Maintaining this
  file" rule); the gate numbers live in HANDOFF, dated.
- **Spec §15 amendment table (original spec) — verified, not duplicated.** Every §11-listed
  amendment from the Phase 6 design is present in the original spec's "Amendments for Phase 6 —
  Quoting (owner Q&A 2026-08-10)" table (per-order-line granularity, wholesale tier 1,
  judged-at-link-time, latest-effective-wins, live-until-finalize, ending statements as the
  eleventh reference kind, `User.title`); the §5.1 Quote-row supersession is carried by the
  table's pointer to the design spec. Nothing was added.
- **`progress.md`** — Task 11 row + the closing "ready for whole-branch review" entry listing
  the triage inputs.

## The owner-ratification queue (assembled from the ledger, one place)

1. **Inactive-part acceptance asymmetry** (Task 3): `createQuote` refuses an inactive customer
   but accepts an inactive part on a linked line (the task brief said "live", not "active").
2. **CLOSED-quote-blocks-delete** (Task 7): a CLOSED quote still blocks `deletePart`/
   `deleteCustomer` (only deletion clears the block). The task reviewer ruled it clearly right
   under the standing-agreement model (resolution path orders → quote → part/customer, never a
   dead end); owner to ratify.
3. **Dormant-column churn on first save after attach-part** (Tasks 4/8): the first line-tree
   save after attaching a part blanks the free-text dormant columns, minting a one-time
   audit-diff churn entry (upstream Task 4 array-replace contract).
4. **Grid-vs-PDF source-label asymmetry** (Task 6, routed to the demo): the invoice grid names
   EVERY operation line's source; the PDF annotates QUOTE-sourced lines only (5A sample
   fidelity).
5. **Part-page Active-quotes gate area** (Task 9): the indicator reads `/api/quotes/eligible`
   gated `orders.view` — safe but arguably wrong-area by that route's own §5.15 reasoning
   (should `parts.view`/`quotes.view` suffice?).
6. **`quotedBy` picker options need `manage_users`** (Tasks 8/10): `/api/admin/users` is the
   only users list, so a `quotes.edit` user without the special sees only the synthesized
   current option.
7. **`QuoteLine.eachWeight` at Decimal(10,4)** (Task 1): mirrored at the Part's real scale
   rather than the spec draft's; the spec text was corrected in place — surfaced for the nod.
8. **The quote PDF's 9 documented layout deviations** (Task 10, routed to the demo): page count
   bottom-right via the sanctioned footer callback, 5A price vocabulary over VS labels,
   setup-on-top making the sample's $100 row $102, 4-decimal unit prices, and the rest in the
   Task 10 report.

## Final gates (2026-08-11, every run watched to its own final output)

| Gate | Result |
|---|---|
| `npm test` | ✅ **130 files / 2122 tests, all passed** (206.6s; vitest's own summary read at exit) |
| `npx tsc --noEmit` | ✅ exit 0, zero errors |
| `npx eslint src tests` | ✅ exit 0, zero findings |
| `npm run build` | ✅ exit 0 (standalone build compiled) |
| `npm run test:e2e` | ✅ **All 19 flows passed** — the run's own Results block lists 19 PASS / 0 FAIL, `cleanup ok`, process exit 0. Run as a tracked background task and read at completion; the quotes flow is the 19th. Dev DB re-verified clean afterwards (quotes/lines/prices/breaks 0, fixture customers/parts/users/statements 0, QUOTE documents 0, no stray live default; the only `entity:"quote"` audit rows are the 4 pre-existing "Administrator" orphans documented above, count unchanged) |

The E2E gate before this final one: the flow was developed against a temporarily-trimmed FLOWS
list (quotes alone — it builds all its own state), which went red twice on my own wrong
expectations (the UTC "today", the Plus/Or minimum) and then green; the trim was restored before
`34666c6` was committed and the final gate above ran the full 19 in committed order.

## Scrutiny pointers for the whole-branch reviewer

- **The triage inputs are the ledger's carried Minors**, per task: T2 (soft-deleted-row promote
  200s silently — inherited generic-service hole; the latent Serializable-snapshot comment; §5.16
  polish on the inactive-row Default checkbox), T4 (same-customerId-only payload no-op audit
  entry; warn-list SHIPPED/REOPENED literal coverage), T5 (judgeQuoteLine naming-only refactor;
  the SSI test's 200ms sleep can false-RED under load; create-vs-update audit shape asymmetry),
  T6 (zero-net LEAD-line 500s where non-lead skips; `sourceQuoteNumber` forgeable on the
  manual-lines save — cheap `.refine`; recalculate link-removed/link-added coverage), T7 (**no
  dangerous-direction test for the two new delete guards** — the customerId-immutability
  dependency is load-bearing and untested in that direction, ticket-worthy), T9 (LineQuoteRepick
  lacks the sibling's useLatest guard; pure-logic vitest wish on pickOrUndefined), T10 (no
  individually-watched REDs for the cent cases/reprint/route perms; ops[i] index coupling; the
  ungated TitleCell; float qty×eachWeight), and this task's orphaned-audit-rows note above.
- **The flow's sharpest evidence is structural**: the fixture part has no PartPrice, so the
  invoice's priced, "Quote #N"-labelled 75.00 row cannot be anything but tier-1 substitution.
  If a reviewer wants to weaken-test it, give the part a PartPrice and watch the assertions
  still hold (the label and amount pin the quote's numbers, not the part's).
- **The cleanup's two restore paths** (`priorDefaultEndingStatementId`,
  `deleteEndingStatementFixture`) only run when `cleanup()` receives the create()-time payload —
  a crash hard enough to skip teardown loses the prior-default id, documented in
  `reapLeftovers`' NOTE (the BillingConfig limitation's exact shape).
- The flow deliberately asserts **membership, not counts**, in the worklist sections (the dev DB
  may legitimately hold the developer's own due/expired quotes).
