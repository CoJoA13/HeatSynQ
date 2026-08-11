# Phase 5C — Month-End Close & QuickBooks Online Summary Export

Squash-merged `c069b09` (PR #92, 2026-08-10). The final slice of roadmap Phase 5 (ruling 1's
three-way split 5A/5B/5C). Spec: `docs/superpowers/specs/2026-08-09-phase-5c-close-qbo-export-design.md`
(9 owner rulings, §3 — rulings 8 & 9 added by the whole-branch review). Plan:
`docs/superpowers/plans/2026-08-09-phase-5c-close-qbo-export.md`. Execution ledger (every task's brief,
implementer report, and reviewer verdict, plus the `progress.md` that records what each review found or
refuted): `docs/execution/2026-08-09-phase-5c-close-qbo-export/`. Demo: `docs/2026-08-09-phase-5c-demo.md`.

## What it delivered

The guided month-end close (a frozen continuity schedule reconciled against 5B's aging, soft and
reopenable — VS-style) and the QuickBooks Online **summary** journal export (a downloadable file, no
live Intuit API), with the period lock wired into every 5A/5B posting mutation and the whole capability
reachable through the product (the 5B API-only blind spot closed).

**The nine tasks, in build order:** the schema (`ClosePeriod`/`GlExportBatch`/`GlPosting`, the
`BillingConfig → GlAccount` GL-default FKs, the `gl_export_batch_number_next` counter, audit/sweep
registration — one migration, `20260809130000_phase_5c_close_and_gl_export`); the `BillingConfig` GL
defaults' service, delete-blocker registration, and Admin → Billing UI; `gl-mapping.ts` (the pure
journal-line + readiness engine); `period-locks.ts` (the leaf `assertPeriodOpen`/`lockMonth`) wired
into every 5A/5B posting mutation; `close-periods.ts` (the close/reopen lifecycle, the continuity
schedule, the roll-forward-vs-aging reconciliation) + its routes; `gl-export.ts` (the per-event delta
engine, the CSV, the batch write) + the export/readiness routes; the posting-register PDF; the
`/receivables/close` UI; and the last task — the E2E flow, the demo doc, and the doc updates.

## Owner rulings (spec §3)

1. QBO delivery = **downloadable file only** (no live Intuit API). 2. Close behavior = **soft,
VS-style reopenable**. 3. Write-offs = **one write-off account**. 4. Opening A/R = **chain from zero**
(first close = $0). 5. GL accounts editable in admin, seeded as needed. 6/7. Correction-JE dating =
**period-end for now** (bookkeeper homework pending). 8 (whole-branch review): **an invoice is
recognized in its FINALIZE month (`finalizedAt`), not its document date** — consistently across the
close roll-forward, the GL-export scoping, and the period lock (finalize guards ≈today; unlock/void
guard the invoice's own `finalizedAt`); the scope is the half-open `[monthStart, nextMonthStart)`
because `finalizedAt` is a timestamp. 9 (whole-branch review): **the export file/register is a SUMMARY**
— one line per `(account, side)` (`aggregateLines`), while the per-event `GlPosting` rows stay the
un-aggregated ERP-side detail + delta driver.

## Concurrency & data-integrity defects the reviews caught (all fixed on-branch)

**Four from the per-task adversarial reviews:** (1) `readinessGaps` didn't flag a missing sales-tax GL
account, so a taxable invoice could export an unbalanced journal (fixed: `ReadinessInput` gained
`salesTaxGlAccountId`/`hasTax`); (2) `postBatch` guarded a multi-month batch with an UNSORTED
per-payment advisory-lock loop — an ABBA deadlock (fixed: dedup to distinct months, sorted ascending,
one lock per month, the `claimOrdersInOrder` rule for advisory mutexes); (3) `closePeriod`/
`reopenPeriod` were implemented at Read Committed to pass a "two concurrent closes" test — that strips
the SSI backstop from the Serializable posting side, so a Serializable `finalizeInvoice` racing a
Read-Committed close could leak a FINALIZED invoice into a just-closed month (fixed: both kept
Serializable, the two-close conflict absorbed by `retryOnSerializationConflict`); (4) `resolveReadiness`
only flagged null-GL lines carrying a step code or surcharge — FREIGHT/CHARGE/CERT lines could drop
from the credit side while A/R still debited the full total, and the delta's scope was cumulative
(`≤ periodEnd`) rather than strictly per-period, so exporting a later month first could vacuum and
later double-post an earlier month's events (fixed: readiness covers every account-bearing non-TAX line
kind, `exportClose` asserts Σdebit = Σcredit before persisting as a backstop, and the delta bounds to
`[monthStart, monthEnd]`). CLAUDE.md's "The period lock" and "The GL-export delta" house rules record
the standing invariants these established.

**The whole-branch review (two opus lenses)** then landed rulings 8 & 9 plus two clear fixes (report:
`whole-branch-fix-report.md`): finding A — the close roll-forward scoped invoices by `invoiceDate` but
the reconciling aging includes them by `finalizedAt`, so a July-dated / August-finalized invoice (the
ordinary month-end pattern) made BOTH months fail to reconcile (fixed by ruling 8's finalize-date
basis, empirically RED-verified); finding B — the export emitted one row per event-line, not the spec's
summary (fixed by ruling 9's `aggregateLines`). Plus: the aging was read INSIDE the outer Serializable
transaction (a second pooled connection held while acquiring another → P2024 pool starvation under
concurrent close-screen load) — now read OUTSIDE the transaction; and `exportClose` now stamps
`GlExportBatch.emittedById`. A final polish (`85a63bc`) closed a near-zero clock-straddle in the
finalize guard (a single `dateOnly(now)` clock).

## Codex PR-review rounds (post-open, on the same branch)

**Round 1 (commit `51d4cb8`) — 7 findings, adjudicated against the code, 3 fixed:** (#1, P1
data-integrity) the re-export delta emitted nothing for a reopen+edit+re-finalize that kept an invoice
in its recognition month (same event key in both current and prior net) — fixed with a `sameNet`
per-`(side,account)` comparison that reverses-then-reposts a changed event; RED-verified. (#3, P2
correctness) the close + preliminary routes accepted an unbounded year, letting `Date.UTC` remap 0-99
to 1900-1999 — bounded `year >= 2000`. (#5, P2 correctness) `closedAt` (default-on-INSERT) went stale
on a re-close — set explicitly. Filed #93 (export create-audit records metadata only — observability,
not data loss). Kept deferred: #2→#88, #6→#89 (already-filed, self-protecting).

**Round 2 (commit `d35acfe`, docs only) — 1 P1, SURFACED TO OWNER:** a posted payment can never be
reversed by a re-export (the delta's payment-reversal branch is dead for PAYMENT keys). Adjudicated via
a 4-agent adversarial workflow: CONFIRMED real but pre-existing (not from `51d4cb8`), self-protecting
(refuses rather than corrupting), and the fix relaxes the documented "POSTED locks the payment list"
invariant (§4.1) — a spec-silent accounting decision already tracked as OPEN owner question **#68**.
No code change; the GL-export blast radius was folded into #68.

## Gates at merge

`tsc` clean · `eslint` clean · `npm test` **1947** (125 files) · `build` clean · E2E **18/18** foreground.
Both concurrency directions RED-re-verified under the finalizedAt basis.

## Deferred to issues (none blocking)

**#88** continuity chain goes stale when a NON-latest month is reopened (owner re-chaining policy, spec
silent). **#89** freight/charge frozen-null line reads clean in readiness but 500s the export
(self-protecting; needs an invoice-attributed readiness gap, and there is no invoice detail page to
anchor its fix-link — owner UX call). **#90** cosmetic follow-ups bundle. **#91** summary netting vs the
QBO import method (tied to bookkeeper homework). **#93** GL-export create-audit completeness. **#68**
(carried from 5B, now with the 5C GL-export consequence): posted-payment correction lifecycle.

## Owner-owed before a REAL export / demo (does not block the merge)

The real GL account list (operations, surcharges, payment types — or the export runs through codes with
no accounts behind them); and the bookkeeper's QBO import method, which settles #91 (summary netting)
and ruling 7's correction-JE dating.

## Lesson

The two-lens whole-branch review was decisive: the per-task reviews structurally could not see the
cross-task reconciliation date-basis defect (finding A) that defeated the headline deliverable — it
lived in the seam between the close service and the aging it reconciles against. And the Codex rounds
confirmed the discipline of adjudicating each finding against the code (fix correctness/concurrency/
data-integrity, triage the rest) rather than applying or dismissing them wholesale — three real fixes,
one new issue, and one P1 correctly routed to a standing owner decision instead of a presumptuous code
change.
