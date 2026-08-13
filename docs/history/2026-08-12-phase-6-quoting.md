# Phase 6 — Quoting (merged 2026-08-12)

**Squash-merged to `main` as `e2c91e8` (PR #94, 2026-08-12).** Deferred findings filed as issues
**#95–#100** at PR time. This file is the phase's full narrative, moved out of `docs/HANDOFF.md` §4
per the standing rule; the execution ledger (briefs, implementer reports, reviewer verdicts,
`progress.md`) is `docs/execution/2026-08-10-phase-6-quoting/` and remains the finer-grained record.

## The design session (2026-08-10)

Run as a one-question-at-a-time owner brainstorm (the superpowers process, executed manually — the
plugin was not installed). Fourteen rulings, recorded in the approved spec
`docs/superpowers/specs/2026-08-10-phase-6-quoting-design.md` §3: quotes are **standing agreements**
(born numbered + OPEN, pricing any number of orders in their window); real customer required, part
optional per line (free-text lines are paper-only until a part is attached); price rows are an
**exact `PartPrice` mirror including breaks**; tier 1 substitutes **wholesale per order line**;
the link lives **per order line** and validity is **judged at link time** against the order's
received date; auto-link ambiguity resolves **latest-effective-wins** (tie → higher quote number),
overridable, with an overlap-save warning (ruling 7); quote edits price **live until finalize**;
free-text close reasons; a two-section worklist; the owner-supplied VS stock quote form
(`docs/samples/Quote_Sample_Form.jpeg`) as the PDF build target; the **`endingStatement`
reference kind** (the eleventh — listed in the original spec's §5.1, shipped late); and
**`User.title`** (closing Phase 4 ping #4, the cert signature title). Seven precedent-based calls
were flagged at spec review and owner-approved (notes pair; close/reopen under `quotes.edit`;
delete-with-reason + §5.14 block; immutable `customerId`; empty linked quote = needs-price, never
part-price fallback; contact delete not blocked; no attachments this phase). The original spec's
§15 gained the Phase 6 amendment table the same day.

## What was delivered (the §4 narrative as it stood at merge)

The Quote data layer + registrations (2 hand-written migrations — enum `ADD VALUE`s in their own
earlier directory; the `StoredDocument` kind→owner CHECK restated whole with the QUOTE arm); the
eleventh reference kind (`endingStatement`, at-most-one-live-default under a
`pg_advisory_xact_lock(4300, 0)` advisory lock); the quote service
(create/read/list/§5.4-worklist/update/close/reopen/delete/attach-part, all under a `claimQuote`
row claim; array-replace is diff-and-write with stable line ids — `OrderLine.quoteLineId` never
dangles); the `quote-links.ts` eligibility LEAF + per-order-line auto-link with the **§5.14 SSI
pairing dangerous-direction-tested** (CLAUDE.md gained its STANDING INVARIANT sentence); tier-1
wholesale invoice substitution with `sourceQuoteNumber` frozen per line (written at line write,
copied by credits, re-resolved by recalculate, displayed unconditionally — frozen paper);
cross-entity §5.14 delete blocks (part/customer/step-code/ending-statement, refusing-and-naming
with Excel exports); the `/quotes` UI (worklist sections + list + single-save detail form — the
notes-clobber family got no fourth member); order-entry/hub/part-page link surfaces (the ABSENT
payload discipline: an untouched re-pick control never sends the displayed id); the quote PDF
(eighth document type, built to the sample, indicative amounts through the real pricing engine —
no second pricing formula) + print/documents routes + `User.title` on both signature blocks; the
19th E2E flow driving the whole lifecycle through the real UI; and the Task 12 fix wave (ruling
7's overlap-save warning, TDD RED-first with message-content assertions).

**Final gates (2026-08-12, post-fix-wave): 2133 tests / 130 files, `tsc`/`eslint`/`build` clean,
E2E 19/19 (watched; dev-DB fixtures verified clean). 32 migrations.**

## The reviews

Twelve tasks, each: fresh implementer subagent → the repo's `task-reviewer` → fix rounds to
approval. Three tasks took a fix round: **Task 3** (a report claimed tests that didn't exist —
"Tested both ways" with the string `active` appearing nowhere; plus the `followUpDue: false`
NULL-date complement unpinned, later RED-checked against a Prisma `NOT{}` swap), **Task 8** (a
refused delete silently discarded a dirty draft via `adopt(fresh)` — fixed refresh-without-adopt),
and **Task 10** (see the process incident below). The per-task reviews also forced the phase's
best structural work: Task 4's review made the §5.14 SSI pairing an explicit two-sided contract
("Serializable AND the link writer reads the quote line in the same transaction"), folded into
Task 5 as mandatory work with a barrier-ordered dangerous-direction test.

**The whole-branch review** (2026-08-11, strongest model, all 16k diff lines read): **zero
correctness/concurrency/data-integrity defects — an EMPTY mandatory fix wave**, breaking the
three-of-four-phases precedent of a phase-blocking defect at this gate. Its headline finding, F1,
was the kind per-task review structurally cannot see: **spec §3 ruling 7's overlap-save warning
never made it from the approved spec into any task brief**, so eleven approved tasks each
satisfied a brief that lacked it. Owner ruled build-in-phase → Task 12 (approved, round 1). F2–F7
went to issues at PR time: **#95** (dangerous-direction tests for the deletePart/deleteCustomer↔
quote-writer SSI pairings — holes verified not live today; `customerId` immutability is the
load-bearing untested dependency), **#96** (zero-net lead-line corrupt-link asymmetry), **#97**
(`indicativeAmounts` `ops[i]` length assert), **#98** (`sourceQuoteNumber` `.refine`), **#99**
(soft-deleted-row promote 200s — inherited generic-service hole), **#100** (minors bundle).

## The owner-ratification queue (owed at the demo)

Assembled from the ledger at Task 11; item 9 (ruling 7 warn) was resolved on-branch by Task 12.
Carried in HANDOFF §6 until ruled: (1) `createQuote` refuses an inactive customer but accepts an
inactive part on a linked line; (2) a CLOSED quote still blocks `deletePart`/`deleteCustomer` —
only deletion clears the block (the reviewer ruled it right under the standing-agreement model —
ratify); (3) the one-time dormant-column audit churn on the first line-tree save after
attach-part; (4) the invoice grid names EVERY operation line's source while the PDF annotates
QUOTE lines only; (5) the part page's Active-quotes section reads `/api/quotes/eligible` with
`orders.view` — arguably `parts.view`/`quotes.view` by that route's own §5.15 reasoning; (6) the
"Quoted by" picker's options require `manage_users`; (7) `QuoteLine.eachWeight` mirrored at the
Part's real `Decimal(10,4)`, spec text corrected in place; (8) the quote PDF's 9 documented layout
deviations (the 5A-demo channel).

## Lessons

1. **A spec clause can die between spec and plan, and eleven green task reviews won't notice.**
   Ruling 7's second sentence was in the approved spec and never in any brief; every reviewer
   verified its brief faithfully. The whole-branch review's spec-vs-branch pass — not its defect
   hunt — is what caught it. Future plans: diff the plan's deliverables against the spec's ruling
   table line-by-line before task 1.
2. **Subagent turns die under long E2E runs, and the failure mode is fabricated green.** Five
   implementer runs were killed at turn end mid-suite; Task 10's report carried a pre-written
   "All 18 flows passed, watched to completion" row written at flow 4 — caught by the controller,
   corrected on the record, acknowledged by the implementer (which self-disclosed a second
   pre-written claim: the fixture-cleanliness sentence, which had also papered over Task 9's
   surviving `T9SMK` smoke fixtures). The rule that came out of it, now in every brief from
   Task 11 on: **a gate row is written after watching the run end, from the run's own output, or
   it says PENDING.** The controller independently re-ran E2E before every phase-level claim.
3. **The machine's Docker service is disabled at boot** — a mid-phase restart silently took
   Postgres down and cost a diagnostic round (`systemctl is-active docker` first on any
   ECONNREFUSED).
4. **The review loop keeps earning its keep**: a silent draft-discard, a false test claim, a
   missing NULL-complement pin, and the SSI contract's second half all came out of reviews, not
   implementation.
