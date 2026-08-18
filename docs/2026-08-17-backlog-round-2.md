# Backlog round 2 — grouped (2026-08-17)

**Paste this into a fresh session to continue clearing issues.** Round 1 (the burn-down,
`docs/2026-08-16-issue-burndown-handoff.md`) closed 14. **66 issues remain open.** This groups all 66.

## Why this round exists and what it is racing

The parallel-run acceptance month is gated on **two owner conversations, not on code** — the bookkeeper's
import method and the GL chart (HANDOFF §7 items 2 and 4). The question list for that meeting is
`docs/company-confidential/2026-08-17-accounting-questions.md`. **This backlog is what gets worked while
those answers come back**, so the ordering below deliberately front-loads everything that does NOT need
an accountant, and parks everything that does.

> **The 2026-08-17 QuickBooks finding changes Part 1 of that meeting.** Intuit's own toolkit says
> Excel/CSV import *"can only import lists. Transactions cannot be imported using this method."* Our GL
> export is a journal entry. And the toolkit is **Desktop** documentation while every note here assumes
> **Online**. Nothing is built against either assumption, so nothing here is invalidated — but do not
> build an import format until Q1 is answered.
>
> **ANSWERED later the same day (2026-08-17)** — the question list came back hand-annotated by the
> bookkeeper, with their QuickBooks item-list export alongside (HANDOFF §7 item 2; the transcription
> is appended to the question list itself). **QuickBooks ONLINE, and the journal entry is KEYED BY
> HAND — no import format ever needs building.** Q12 is "No" (nobody reads revenue-by-furnace, so
> the step-code decision collapses to ~15–20 codes pending owner ratification), sales tax is not
> charged, discounts net straight against revenue. The PARKED table below now carries each item's
> answer — **actioning them still waits on the owner**.

## Read first

`CLAUDE.md`, then `docs/HANDOFF.md` §4 (state), §6 (backlog), §7 (owner-owed), §9 (tracks). Every standing
rule in CLAUDE.md binds this work.

**Round 1's four lessons carry forward** (`docs/2026-08-16-issue-burndown-handoff.md`, "outlives it"):
RED-verify every test by making it fail on purpose; three of round 1's defects were in TESTS, not
production code; and when consecutive review rounds keep finding defects in the code written for the
*previous* round, the design is the finding — delete the mechanism rather than repair it a seventh time.

---

## Task 0 — DONE 2026-08-17 · **63 issues open**

All three suspects were re-verified against the code and closed with their evidence: **#6** (ruling 14
built in full — registry, service, nine `/blockers` route pairs, the sweep test), **#10** (revival-on-create
was *removed*, not consolidated — partial unique indexes, §5.18), **#7** (§5.16 decided and adopted in
**68 of 83** client files; the four exceptions are correct — `login` has no session, `Combobox` and
`LogoPanel` take gating from their parents, and the audit page's only button is a search — so no
surviving sweep). The four missing triage labels now exist. The original reasoning is kept below.

<details><summary>Task 0 as originally scoped</summary>

## Task 0 — Triage the list before trusting it (~1 hour) · DO THIS FIRST

Round 1's Task 0 existed because a dirty measurement makes every later estimate wrong. Same reasoning:
**at least three open issues describe mechanisms that no longer exist**, and until they are closed, "66
open" is not a real number.

Verified on 2026-08-17, each by reading the code rather than the issue:

| # | Why it looks stale | Evidence |
|---|---|---|
| **#6** | "Decide what happens when a reference row that other records point at is deleted" — **ruled AND built.** | Owner ruling 14 (2026-07-31); `src/lib/reference-links.ts` (the registry the ruling asked for), `src/server/reference-blockers.ts`, **eight** `/blockers` API routes, and `tests/reference-links-sweep.test.ts` — the sweep test the ruling specified. |
| **#10** | "Reusing a deleted customer code inherits the predecessor's audit identity" — **the mechanism was removed.** The issue is about revival-on-create; that was replaced by partial unique indexes, so a reused code now creates a genuinely new row with its own id and history. | CLAUDE.md's deletion section states there is no revival-on-create and re-adding one is a regression; `reference.ts:182` is the live-rows-only `findFirst`. |
| **#7** | "Decide how the UI should reflect permissions the user does not have" — **decided.** §5.16 (a control the user cannot use is disabled and says why) is enforced in review and was the explicit shape of this round's #123 fix. | §5.16 appears throughout HANDOFF as a review category. |

**Do:** re-verify each against the code, close the ones that are genuinely done with a comment saying
what closed them, and narrow any survivor to the part that is still true (#7 may survive as a *sweep*
for screens that predate §5.16 — that is a different, smaller issue than the decision).

**Also do, while in there:** the five triage labels documented in `docs/agents/triage-labels.md`
(`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) **do not exist in the
repo** — only `wontfix` does. `gh issue edit --add-label ready-for-agent` fails today. Create the four
missing labels or stop documenting them.

</details>

---

## Group A — The invoice engine · **MERGED 2026-08-17** as `1c1fc77` (PR #133)

All eight closed — #61, #62, #64, #63, #89, #59, #60, #96. Gates: **3104 tests / 182 files**
(from 3080), `tsc`/`eslint`/`build` clean, E2E 23/23 — all re-run at each of THREE review rounds,
never carried forward.

**Two of those rounds found defects in the previous round's code**, both on the same `#61` pairing
fallback: round 1 found the step-exact identity insufficient, round 2 found its replacement had
become the mirror of the bug it fixed (erasing a sibling operation's revenue). Round 3 approved.
That is round 1's lesson 4 playing out live — worth reading before the next group.

Four went further than the issue said, and those differences are in HANDOFF §6: #61's fix is one
identity rule covering *every* overridable kind (a retyped TAX line double-billed the same way), #64
is what makes #61 honest (tax follows the override), #62 had an unnamed second half in
`invoiceWarnings`, and #89 needed BOTH gaps rather than a replacement. Three test fixtures that built
line-less invoices had to gain a line — #63's guard is in the service, so they failed correctly.

<details><summary>The rulings and the original issue-by-issue scoping</summary>

> **Three owner rulings, 2026-08-17, taken before this branch opened.**
> **#61 — the manual override WINS, silently.** Recalculate suppresses the regenerated twin (match on
> `orderLineId` + `processStepCodeId`) and keeps the typed amount; **tax follows the override**. No new
> revert control — remove the row, save, Recalculate restores the computed line, and that path becomes a
> tested contract. (Ratifies what `patchRow`'s `MANUAL` stamp already intended.)
> **#62 — default the GL account SERVER-SIDE** to `otherChargeGlAccountId`; the grid stays read-only and
> now shows a real account. **No operator GL picker** — the list route is `admin.view`-gated, which an
> invoicing clerk must not hold, and ruling 15 excludes `glAccount` from the open pick-list route on
> purpose. Revisit only if the accountant asks for charges split across accounts.
> **#63 — a $0 invoice is legitimate paper** (warranty, rework, no-charge). Block the **empty line set**,
> not a zero total, and block at **finalize** — a draft may be transiently emptied mid-rebuild.

**The acceptance month's own path, and the highest-consequence group in the list.** Six of the eight are
in `invoices.ts`, most in the `recalculateInvoice` / `replaceInvoiceLines` seam, so one branch and one
review cover them. Every one of these produces *wrong money on paper the customer sees* or a broken
export — during the exact month the shop is judging whether to trust the system.

- **#61 — Recalculate double-bills a manually overridden operation.** Override a $937.44 line to $100,
  hit Recalculate, and the invoice bills BOTH. Outright double-billing; no test covers the path.
- **#62 — A manually added charge line gets no GL account and no way to assign one.** The grid renders
  the account read-only, `invoiceWarnings` only checks OPERATION lines, so it slips through silently and
  drops out of the GL export.
- **#64 — Recalculate computes no tax on preserved manual charge lines.** Tax is computed over
  order-derived lines *before* manual lines are loaded, so a taxable manual charge is under-taxed.
- **#63 — An emptied invoice finalizes to a $0 INVOICED order that cannot be rebilled.** Delete every
  line and the `needsPrice` check passes vacuously; the order then drops out of the billing candidates.
- **#89 — A frozen null-GL freight/charge line reads CLEAN in readiness and 500s the export.** Readiness
  checks the *current* plant default; the journal builder reads the line's *frozen* null. Fails while
  reporting success — the shape this project's worst defects have all had.
- **#59 — Unlocking a CREDIT recomputes the order's status back to ship-derived**, silently dropping an
  invoiced order out of INVOICED. `finalizeInvoiceInTx` branches on `kind`; `unlockInvoice` does not.
- **#60 — Invoice pricing reads part prices on the top-level client inside the Serializable
  transaction**, so a concurrent price edit is invisible to SSI and per-line reads can tear. Contradicts
  the file's own stated discipline. Fix is the `listAddresses` precedent: take an optional `tx`.
- **#96 — A zero-net LEAD line with a corrupt quote link 500s where a rider is silently skipped.** The
  asymmetry is the finding; throwing is the safe direction.

**#62 and #89 are the same defect from opposite ends and must be fixed together** — one lets a line be
saved with no account, the other lets readiness declare that fine. Fixing either alone leaves the hole.

**Note:** #61/#62/#64 all touch the manual-line handling in `recalculateInvoice`. Sequence them as one
task, not three, or the second and third will each be rewriting the first.

</details>

---

## Group B — A/R that does NOT need the accountant · **MERGED 2026-08-17** as `6bc45ea` (PR #135)

All six closed — #83, #85, #86, #82, #79, #75. Two migrations (a `Terms` CHECK, and the invoice's
frozen discount terms with a backfill). Three of the six were verified **in the browser** as well as
in tests, because they are UI deliverables: the completed open-items table, a real credit
application, and the per-division print.

**What went past the issue text:**
- **#79 needed a BACKFILL, which the issue did not mention.** Freezing the terms without one would
  have silently withdrawn the discount from every invoice already sent. The migration copies each
  finalized invoice's customer's current terms — precisely what those invoices compute today.
- **#79 has two read sites, not one.** `discountAvailable` feeds the screen, but `applyPayment` caps
  the DISCOUNT line independently, so fixing only the first would have left the SAVE granting a
  discount the screen refused to offer.
- **#86 was a one-word omission with a silent failure mode**: a negative rate is not stored and
  rejected loudly, it makes `financeCharge` return a negative that the `> 0` gate collapses to null,
  so the customer just stops being charged.
- **#83 and #75 are one task** (owner ruling), and the pair are now read from ONE RepeatableRead
  snapshot — reconciliation is the whole point, so it should not depend on two autocommit reads
  landing either side of a commit.

<details><summary>The rulings and the original issue-by-issue scoping</summary>

> **Two more owner rulings, 2026-08-17, taken during review.** **A credit applies only within ONE
> customer** — the picker lists that customer's own open invoices and not the family's. `applyCredit`
> permits a cross-family application and one reconciles correctly on both pages, so this is a
> deliberate UI scope, not a limitation: the section is single-customer by design after a fix round
> closed a real family-leak bug there. **A PARENT-ONLY statement is never wanted** (#136), which is
> what makes the print-path fix permanent: the single-print route now REFUSES an un-combined print
> for a customer with divisions, so the screen can no longer pick the wrong path from a list that is
> stale, unloaded, or active-only — the three ways review found it wrong.
>
> **Owner ruling 2026-08-17: the credit-memo application UI lives in the CUSTOMER A/R SECTION**
> (#75) — on the customer page, beside the open invoices it can pay down. That makes **#83 and #75
> ONE task**, not two: #83 is what puts open credits and on-account cash into that list in the first
> place, and #75 hangs the Apply action off the credit rows it adds. The invoice page and the
> receipt-batch screen were both considered; the batch screen was rejected because a credit memo has
> no receipt batch (it exists independently of any deposit), and the invoice page because nothing
> there tells an operator a credit exists to apply.

Clear defects and one undelivered deliverable. Nothing here waits on the meeting.

- **#83 — The customer A/R section's open items exclude credits and on-account cash**, so the net above
  the table cannot be reconciled to the table. `buildStatement` was fixed in PR #74; this half was not.
- **#85 — "Per-division" statements print only the parent**, silently omitting every division. The
  advertised option does not do what it says.
- **#86 — A negative `Customer.financeChargeRate` is accepted** and silently suppresses finance charges
  for that customer. One validation, matching the `BillingConfig` rule already added.
- **#82 — Terms both-or-neither validation has a TOCTOU race.** Enforce with a DB `CHECK`, the
  `Application_source_check` precedent, rather than a read-then-write at default isolation.
- **#79 — The early-pay discount reads the customer's CURRENT terms, not the invoice's issued terms.**
  An invoice is frozen paper (§5.4), so this is retroactive in both directions. The fix (snapshot
  `discountPercent`/`discountDays` at finalize) is correct **regardless** of how the accountant answers
  the *basis* question — Q13 decides the percentage of what, this decides which percentage. Build it.
- **#75 — Credit-memo application has no UI.** `applyCredit` and its route exist and are tested, but
  nothing calls them, so a finalized credit can only sit on account. Spec §3 ruling 5 is a deliverable.

</details>

---

## Group C — Shipping and order-status integrity · **#65, #52, #51, #41, #42, #44, #45, #46** · IN FLIGHT 2026-08-17 (`group-c-shipping-status`)

> **Two owner rulings, 2026-08-17, taken at kickoff (recorded in spec §15).**
> **#65 — void is reversal-aware.** Voiding the ORIGINAL of a live reversal pair is refused naming
> the reversal (§5.14 shape; keeps the net ledger ≥ 0 by construction). Voiding the REVERSAL is the
> blessed undo: it restores the `lineComplete` flags the reversal itself cleared — recorded at
> reversal time, so a human's re-decision in between is respected — and recomputes status. Invoiced
> pairs stay behind `refuseIfInvoiced`; unlock is their correction route.
> **#52 — persist print-time coverage.** A whole-set ticket/BOL records which orders it covered at
> print; the order hub lists only paper that actually named the order. Membership stays editable
> after a print (freeze-membership was considered and rejected — the printed paper is not falsified
> by a later addition; print a fresh BOL).

**#65 is the one that matters**; the rest are papercuts that share the same screens.

- **#65 — Voiding a reversal (or the shipment it reverses) corrupts order status and the ledger.**
  `voidShipper` is a generic soft-delete with no awareness of `reversesShipperId`. Void the reversal and
  a fully shipped order sticks at PARTIAL_SHIPPED; void the original and net shipped quantities go
  **negative**, corrupting ship-now prefill, over-ship warnings and the edit guard. The design
  explicitly blesses "undo a mistaken reversal by voiding it", which runs straight through this.
- **#52** — whole-shipment document coverage derives from *current* membership, so an order added after
  a BOL printed lists a PDF that never named it. Fix direction is a design choice (persist coverage,
  freeze membership, or mark it).
- **#51** — an in-flight add-order response lands after a customer switch. Also a member of Group D's
  class; fix it with the same idiom, wherever it lands.
- **#41** — the printed-traveler warning only appears after a loads mutation, not on load. **Filed P1**
  in its own text: an operator can edit loads on a printed order with no warning shown.
- **#42** — generated loads are not validated against `Load.qty`/`weight` column ranges; an unmapped
  Postgres overflow 500s.
- **#44** — Save & Print is gated on `orders.create` alone, then redirects to a page requiring
  `orders.view`. A legal permission combination lands the user on a forbidden page.
- **#45** — the board's customer filter drops inactive customers, so a saved view stays silently scoped
  with a blank select.
- **#46** — the order hub hides customer code/name without `customers.view`, though the board it was
  reached from shows exactly that identity under `orders.view` alone.

---

## Group D — The stale-load class · **#31 first, then #3, #5, #15, #23, #110**

**Decide #31 before fixing any of the others**, because #31 is the decision the rest are instances of.

`react-hooks/set-state-in-effect` fires **21 times across 19 files** and is switched off in
`eslint.config.mjs`. The override is defensible (the setState runs in an async continuation, not
synchronously), **but the rule is pointing at something real**: every stale-load bug this project has
had is a symptom of hand-rolled fetch-into-state, and `use-latest` was built to answer it.

- **#31** — keep the pattern with `use-latest` as the discipline, or move to a fetch library. Zero work
  vs a real migration. HANDOFF §9 flags a *sibling-page sweep* here: customers/parts/orders/certs detail
  pages likely share the hole that Phase 7 fixed on two pages.
- **#3** (customer detail), **#15** (part detail), **#5** (customer list search), **#23** (step-codes
  blocker panel names a field from a previously selected code), **#110** (SetupBanner shows stale
  readiness for the rest of the session after a setup mutation — the fix shape is the
  `invalidateBackupBanner()` precedent built in round 1, and #110 says so).

Fix them as one sweep with one idiom. Fixing them one at a time is how the class survived this long.

---

## Group E — Close, GL export and concurrency tripwires · **#88, #93, #90, #132, #95**

- **#88 — RULED by the owner 2026-08-17: option (c), surface a broken-chain flag.** `listClosePeriods`
  flags any closed month whose `beginningAr` no longer equals the prior month's `endingAr`; the operator
  re-closes to re-chain. Nothing is refused and nothing cascades — reasoning is on the issue. **Build
  it:** a derived read, no column, no write path, and per the Phase 8A rule a report must not claim,
  audit or run Serializable. Likely to fire during the parallel run, since a first month WILL be corrected.
- **#93** — the GL-export create-audit records batch metadata, not the emitted journal. Observability;
  the postings themselves are persisted.
- **#90** — the Phase 5C minors bundle. Includes two worth pulling out: `db-errors.ts` translates 40001
  but not 40P01/P2010 (deadlock), and `retryOnSerializationConflict` retries on ANY P2002.
- **#132** — a retention failure is cleared by the next manual backup, which does no retention. Filed
  from round 1 with the reasoning; every fix touches a documented design property, so it wants a
  decision. Self-corrects within one night.
- **#95** — add the two missing dangerous-direction tests for the `deletePart`/`deleteCustomer` vs
  quote-writer SSI pairings. The cycle holds today, but nothing goes red if `Quote.customerId`
  immutability is relaxed. Round 1 proved these tripwires earn their keep.

---

## Group F — Infrastructure and tooling · **#30, #111, #40, #34, #35, #112, #32, #107**

- **#30 — CI never builds the Docker image, though production IS that image.** Dependabot PR #16 showed
  a green check for a Dockerfile change the workflow never touched. ~25s to fix.
- **#111 — the practice reset pins a pool connection while seeding on the ambient client.** A
  1-connection pool deadlocks. **Read the issue's own warning before fixing:** the pinned-lock
  transaction *is* a previous review round's fix, so this is round 3 flagging round 2 — exactly the
  convergence trap Group D of round 1 fell into. Prefer deleting a mechanism to adding one.
- **#40** — `db-errors.ts`'s P2002/P2003 meta paths never match on the driver-adapter stack, so raw
  constraint messages are always generic.
- **#34** — guard `allocateNumber` against non-integer setting keys (a type, or a one-line guard).
- **#35** — scope the partial-unique sweep's column matching per-model.
- **#112** — the README documents an in-container practice seed that cannot work (`tsx` is pruned).
- **#32** — pg@9 will break `@prisma/adapter-pg`'s concurrent relation loads inside transactions.
  Forward hazard; correct today, warns once.
- **#107** — reports use unbounded `findMany` + JS aggregation. Fine at this shop's scale; revisit when
  a table grows.

---

## Group G — Documents and templates · **#102, #103**

- **#102** — `render.ts`'s two-pass leaves a spurious blank trailing page at boundary overflow counts
  (observed n=40, n=61 for the statement). Cosmetic, shared infra, affects every document type.
- **#103** — a future contract *tightening* would make an old immutable PUBLISHED config throw at print.
  Verified a NON-issue today; filed so it is not rediscovered the hard way. Read before evolving a
  template contract.

---

## Group H — Polish bundles and small cleanups · **#14, #37, #38, #33, #100, #99, #101, #72, #24, #9**

Low individual value, but cheap in a batch and they are what the office actually notices.

- **#14** parts UI papercuts (4 items, incl. audit diffs showing a raw cuid) · **#37** combobox ARIA +
  attachment tooltip wording · **#38** attachment upload cap pre-check · **#33** decompose `orders.ts`
  and the board page · **#100** the Phase 6 minors bundle (8 items) · **#99** promoting a soft-deleted
  reference row's `isDefault` 200s silently — fix in the generic path, not per-kind · **#101** re-gate
  the part page's active-quotes read to `quotes.view` (owner ruling, Phase 6 demo) · **#72** remove the
  vestigial `ar` permission area · **#24** audit snapshots of `role.permissions` /
  `processStepCode.fields` have no deterministic ordering, so History can show a spurious diff ·
  **#9** concurrent edits to different fields absorb each other into their audit diffs.

---

## PARKED — the answers are BACK (2026-08-17) · **ACTIONED same day on the owner's go-ahead**

The annotated question list answered most of these the same day this file was written (HANDOFF §7
item 2), and the owner said go: **#70, #78, #76 are CLOSED** with their evidence (#78's acceptance
is a spec §15 amendment), **#73 and #80 are UNPARKED into Group E** (`ready-for-agent`), #69 and
#77 stay parked as below. **Q12 is RATIFIED** (spec §15): one step code per process.

| # | Was waiting on | Answer 2026-08-17 → disposition |
|---|---|---|
| **#69** | Q13 — discount basis | **still open** — the bookkeeper explicitly cannot settle it alone (a third person must be included). The discount has never been taken by any customer, so parking stays free |
| **#79** | the basis half only | the built snapshot fix is independently endorsed — Q14: *"(my opinion only) terms should follow the invoice"*. The basis half still waits on Q13 |
| **#73** | Q16 — post-dated payments | **"No, not yet"** — payments post after receipt/deposit → build the guard |
| **#70** | Q17 — credit-balance statements | **confirmed as built** (checkmark) → closable |
| **#80** | Q18 — refuse an un-footed batch post | **refuse** (checkmark on "refusing is the safer default") → build it |
| **#78** | Q22 — past-aging reproducibility | **current behavior accepted** (checkmark on "the report reflects current status") → closable, the design-sized work is NOT needed |
| **#76** | Q19 — finance charges / exemptions | **"Not really"** charged → the exemption screen buys nothing; closable |
| **#77** | Q20 — bad-debt write-offs | QuickBooks handles them today; a path is wanted only if late fees are pursued → stays parked, low |
| **#71** | owner — family roll-up | informed by Q21 (*"combined"* underlined — no reason seen to divide a family) but still the owner's call |
| **#4** | owner — delivery contact with no email | unchanged — owner call |
| **#8** | owner — delete reasons (spec §9) | unchanged — owner call |

---

## Recommended order

~~**Task 0** (triage, ~1h)~~ → ~~**A** (invoice engine, merged `1c1fc77`)~~ →
~~**B** (A/R, merged `6bc45ea`)~~ → **C** (shipping/status) ← **NEXT, NOT STARTED — owner is holding
here (2026-08-17)** → **E** (close + GL + tripwires) → **D** (stale-load, after the #31 decision)
→ **F** → **G**/**H** as filler.

**A first** because it is the acceptance month's own path and the most expensive to discover live.
**D is deliberately not early**, despite being tempting: it needs a decision (#31) and a sweep across
many files, which is the worst shape to be mid-way through when the accounting answers land.

## How to work these

Per group: branch → TDD per issue (failing test → implement → pass → commit) → per-issue or per-group
review → gates → PR with attribution **in the body**, never in individual commits (this repo
squash-merges).

```bash
cd erp
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
npm run test:e2e     # run in the BACKGROUND — ~10 min
```

A gate row is written **only after watching the run end** — otherwise it says PENDING. Run
`npm run test:e2e` on any UI/flow-touching change, even incidental. A killed E2E run leaves a
`ClosePeriod` row that reds three unrelated flows next time; clear it by hand from the DEV db.

**Only one test-running process at a time.** **Never `git add -A`** — stage explicit paths; the repo is
public and `docs/company-confidential/` must never be committed.

**Docs are part of the work**, not a follow-up: a change that alters a decision or convention updates
`docs/HANDOFF.md`, the spec §15 decision log if it amends the contract, and `CLAUDE.md`, in the same breath.

## The failure shape to hunt

Every serious defect this project has found has been **something that fails while reporting success** —
a dump exiting 0 having written nothing, a readiness check declaring an export clean that then 500s
(#89, in Group A), a test passing via a branch that never executed. Ask not "does it work?" but
**"what does it do when it doesn't, and does anything notice?"**
