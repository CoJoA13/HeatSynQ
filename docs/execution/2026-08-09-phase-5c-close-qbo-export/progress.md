# Phase 5C SDD progress ledger

- **Plan:** docs/superpowers/plans/2026-08-09-phase-5c-close-qbo-export.md
- **Spec:** docs/superpowers/specs/2026-08-09-phase-5c-close-qbo-export-design.md (7 owner rulings, §3)
- **Branch:** phase-5c-close-qbo-export
- **Branch base (merge-base main):** 580e74406f7624e2fa737bf2e5189e8f8de705a6
- **Docs commits before Task 1:** 5780745 (spec), 56ae80a (plan + spec reconciliation)
- **Plan hardened pre-execution** by a 3-agent adversarial critique (coverage/reachability, cross-task consistency, code fidelity). Notable fixes folded in: per-event GL delta with isReversal-by-provenance + single (sourceType,sourceId) key; per-event balanced cash pairs (no aggregate A/R sourceId:""); advisory-locked period guard + two-concurrent-closes RED test; period-scoped readiness; getExportBatch{File,Register}; currentActor().id; GlPosting.memo. Verified false positive: close_ar_period/run_qbo_export already exist in SPECIAL_ACTIONS + granted via ALL_PERMISSIONS.
- **Environment note:** Postgres is up (29 migrations, schema current). The docker *CLI* is permission-blocked in agent shells (unix socket), but `npx prisma migrate deploy/generate` connect directly and work — do NOT run `docker compose up`.

## Tasks

- [x] Task 1: Data model, migration, audit + counter registration — **implementation complete** (code `e283b65`, report `63d9ec6`; not yet reviewed)
- [x] Task 2: BillingConfig GL defaults — service, delete-blocker registry, admin UI
- [x] Task 3: gl-mapping.ts — pure journal + readiness engine
- [x] Task 4: period-locks.ts leaf + wiring into every A/R posting mutation
- [x] Task 5: close-periods.ts — close/reopen lifecycle + preliminary report + routes
- [ ] Task 6: gl-export.ts — per-event delta, CSV, batch write + export/readiness routes
- [ ] Task 7: posting-register PDF
- [ ] Task 8: /receivables/close UI
- [ ] Task 9: E2E flow, demo doc, documentation

## Log

### Task 1 — implementation complete (code `e283b65`, report `63d9ec6`)
- `ClosePeriod`/`GlExportBatch`/`GlPosting` added; `BillingConfig` gained `arGlAccountId`/
  `discountGlAccountId`/`writeOffGlAccountId` (nullable FKs to `GlAccount`, named relations).
  Migration `20260809130000_phase_5c_close_and_gl_export` applied to `erp` and `erp_test`; client
  regenerated. `closePeriod`/`glExportBatch` registered in `AuditableModel`/`SNAPSHOT_INCLUDE`
  (`GlPosting` deliberately not auditable). `gl_export_batch_number_next` counter added.
  `GlExportBatch.exportNumber` exempted in the partial-unique sweep.
- Gates: smoke test + partial-unique-sweep + `tsc` + eslint on touched files — all green, per the
  brief's Step 8. Full `npm test` also run as a diligence check: 1879/1881 pass; the one failing
  file (`reference-links-sweep.test.ts`) is an **expected** transient gap — the 3 new
  `BillingConfig` GL-account FKs aren't registered in `reference-links.ts` yet, which is Task 2's
  explicit job (plan lines 280–371). See the report's Concerns section for a 4th, unplanned FK
  (`GlPosting.glAccountId`) the same sweep will need once whichever task writes `GlPosting` rows
  (likely Task 6) registers it — flagged there with a runtime-safety note (`liveWhere: {}`
  required; `GlPosting` has no `deletedAt`), not fixed in Task 1 since it needs a
  UI-adjacent design call (`Payment.paymentTypeId` is the "register now, no detailPath" precedent).
- Not yet reviewed.

### Controller note (after Task 1, before Task 1 review cleared): plan gap resolved
- Task 1 surfaced a 4th unplanned reference-targeting FK: `GlPosting.glAccountId -> glAccount`
  (a frozen `onDelete: SetNull` snapshot). The reference-links sweep exempts ONLY `onDelete: Cascade`,
  so — like the `InvoiceLine.glAccountId` precedent (reference-links.ts:203, "posted history is
  permanent") — it MUST be registered, or the sweep stays red even after Task 2's BillingConfig FKs.
- **Plan amended (Task 2):** register `GlPosting.glAccountId` via a new `GL_POSTING_BLOCKER`
  (`liveWhere:{}` since no `deletedAt`; names itself by its export batch), add `"glPosting"` to the
  `ReferenceLinkModel` union, add `glPosting.glAccountId -> glAccount` to the sweep's expected list
  (sorted after customerSurcharge.*, before invoiceLine.*), and a runtime blocker test. This adds no
  new restriction (the account is already blocked by the invoice line / payment that generated the
  posting) — it only satisfies the sweep. Not a Task 1 defect (registration is Task 2's scope).

Task 1: complete (code e283b65, plan-amend a4cac3b; review clean — spec ✅, quality Approved).
  Minors for the final review to triage (not fixed — cosmetic):
  - schema.prisma ~119 comment "Three separate FKs from BillingConfig..." is now stale (six GL FKs). One-word touch-up.
  - partial-unique-sweep ALLOWED entry GlExportBatch.exportNumber is inert (GlExportBatch has no deletedAt) — brief-required, mirrors ReceiptBatch.batchNumber; documents intent.

Task 2: complete (commit 156fafc; review clean — spec ✅, quality Approved). Gates: 1884 tests, tsc/eslint clean, E2E 17/17.
  Minor (final review): reference-links.ts:117 BILLING_CONFIG_BLOCKER comment says "four FKs", now seven.
  SIBLING GROUP for the final review's one-pass fix — stale FK-count comments: schema.prisma ~119 ("Three separate FKs...", now six) + reference-links.ts:117 ("four FKs", now seven). Fix together.
  Note: .superpowers/sdd/.gitignore clobbered to bare `*` again (recurring). Non-issue for us — execution record is in docs/execution/ (committed); .superpowers/sdd/ only holds regenerable review-*.diff.

Task 3: complete (impl 52af93a + fix 6b6d13c; docs a9a4443; re-review Approved — spec ✅). gl-mapping 6/6, eslint pristine, tsc clean.
  IMPORTANT finding FIXED (data-integrity): readinessGaps didn't flag a missing sales-tax GL account, yet a taxable invoice's total includes tax while salesJournal drops the tax credit when taxGlAccountId is null → an UNBALANCED journal could pass readiness. Fixed: ReadinessInput gains salesTaxGlAccountId+hasTax; readinessGaps emits the gap. Plan+spec §7 amended. Aligned with owner-ratified §15 (refuse-without-account), not a deviation.
  ⚠️ FOR TASK 6 (resolve before its review): resolveReadiness must derive `hasTax` from the SAME export-scope delta (glDate<=periodEnd invoices with taxTotal!=0) and the plant-default salesTaxGlAccountId it checks must be the account every in-scope taxable event's taxGlAccountId resolves to. Fold into Task 6 dispatch + reviewer notes.
  Minor (noted, low-risk): fixer ran scoped eslint (not `eslint src tests`) and didn't re-run full `npm test` — unconsumed leaf; Task 4 runs the full suite next.

Task 4: complete (impl c49e1dc + fix d8a7631; docs bf7e688; opus review + re-review Approved). Gates: full suite 1898, tsc/eslint clean, E2E 17/17 foreground. Both concurrency tests RED-verified.
  IMPORTANT fixed (concurrency): postBatch guarded a multi-month batch with an UNSORTED per-payment advisory-lock loop → ABBA deadlock (P2010/500). Fixed: dedup to distinct (year,month), sort ascending, one lock per month (claimOrdersInOrder rule). +2 multi-month coverage tests.
  ⚠️ FORWARD to Task 5: closePeriod must take its month lock as a SINGLE lockMonth(year,month); if it ever locks multiple months, reuse ascending year*100+month order (the single-ascending-order invariant is what keeps postBatch-vs-close deadlock-free).
  Minors (final review): period-locks import-shape pin blocks a named service list + require/import, not a strict "only type Prisma + ./errors" (mirrors invoice-guards precedent, no live exposure). Observation: db-errors.ts translates 40001 but not 40P01/P2010 (deadlock) — latent; unreachable now that all lock acquisition is ordered.

Task 5: implementation complete (not yet reviewed). `close-periods.ts` (preliminaryReport/closePeriod/reopenPeriod + computeSchedule/priorEndingAr) + routes preliminary(GET, receivables.view)/close(POST)/reopen(POST, edit+close_ar_period). Single lockMonth per close (Task 4 invariant honored). Gates: full suite green, tsc/eslint clean, E2E foreground green. Both concurrency tests RED-verified (transcripts in task-5-report.md).
  TWO DESIGN DECISIONS FOR THE WHOLE-BRANCH REVIEW (both flagged in the report):
  1. **Isolation: closePeriod/reopenPeriod run at READ COMMITTED, not Serializable (the brief's sample showed Serializable).** Empirically forced: a Serializable txn fixes its snapshot at its FIRST statement, and when that is the BLOCKING `lockMonth` SELECT the snapshot predates the lock grant → post-lock reads are stale. Probe-verified: under Serializable the 2nd of two concurrent closes reads 0 rows post-block, re-inserts, and takes P2034 (→409) — it ERRORS, breaking the brief's own "neither errors / the second sees the first's row and updates it" acceptance; under Read Committed both succeed with one CLOSED row. The advisory lock (not SSI) is the documented serializer (period-locks.ts / the brief's own reconciliation note), so RC is correct AND is the only isolation that meets the acceptance. preliminaryReport keeps Serializable (takes no lock → never blocks → never stale).
  2. **Prior-month rule = spec §4.1 line 107 "prior month closed OR first close" (genesis / chain-from-zero, ruling 5), NOT the brief's sample.** The brief's `priorEndingAr` returned $0 for any missing prior (couldn't refuse); its "refuses" test (close August on an empty DB) is itself a valid genesis close and can't refuse. Implemented: missing prior is allowed only when nothing STRICTLY earlier is closed (genesis); an earlier close with the immediately-prior month unclosed = a SKIPPED month → refuse. Tests rewritten to the spec: a first close begins $0 (genesis) + a skipped-month refusal + a variance refusal (June residual vs a July genesis close).

Task 5: IMPLEMENTED (impl e1fda3d; docs b8c30f7) but review = NEEDS FIXES (Critical). NOT yet complete.
  CRITICAL (data-integrity), confirmed by opus review + controller's independent Postgres analysis:
    The implementer ran closePeriod/reopenPeriod at Read Committed (to make two-concurrent-closes pass).
    That STRIPS the SSI backstop from the Serializable posting side: a Serializable finalize fixes its
    snapshot at claimInvoiceRow (before assertPeriodOpen's advisory lock); if a close commits after that
    snapshot, the CLOSED row is invisible (plain findFirst, no FOR UPDATE), SSI can't abort a RC writer
    → a FINALIZED invoice LEAKS into a just-closed month (the exact invariant the guard exists to protect).
    The concurrency test only exercised the SAFE direction (a hand-scripted RC holder taking the lock
    first), masking it.
  FIX (plan+spec amended, commit pending): keep close/reopen SERIALIZABLE (both sides Serializable →
    SSI predicate-locks catch the phantom), absorb the two-close conflict with retryOnSerializationConflict
    (canonical Serializable retry: re-run → fresh snapshot sees the row → UPDATE). Keep lockMonth (orders
    closes). NO Task 4 change (assertPeriodOpen's plain findFirst is correct once both sides are
    Serializable). Minors: clear reopenReason on re-close; variance message includes the delta value.
    NEW dangerous-direction test: real Serializable finalizeInvoice vs a close that wins the lock first,
    assert refuse-or-abort (never leak), RED-verified by reverting close to RC. Test 2 (two-closes) RED
    by removing the retry.
  Also accepted from the review: prior-month/genesis logic grounded in spec §4.1+ruling 5 (implementer's
    spec-correct departure from the brief's self-contradictory sample); agingReport cross-connection read
    justification holds; single-lockMonth invariant honored.

Task 5: Fix round 1 LANDED — the Critical fix is now applied in code (the earlier f022f85 was docs-only;
  close-periods.ts still ran Read Committed). Changes: retryOnSerializationConflict added to db-errors.ts;
  closePeriod/reopenPeriod restored to Serializable + wrapped in the retry (lockMonth kept); file-header
  ISOLATION section rewritten; minors (reopenReason:"" on re-close, variance message names the delta).
  Tests: safe-direction Test 1 REPLACED with the dangerous direction (real Serializable finalize vs a real
  close that commits first, via an order-row gate); Test 2 asserts one CLOSED row + neither errors. BOTH
  RED-verified (transcripts in task-5-report.md "Fix round 1"): dangerous test leaks FINALIZED under a
  Read-Committed close; Test 2 loser surfaces P2002 with the retry disabled. Gates: full suite 1910, tsc/
  eslint clean, E2E 17/17 foreground. Superseded design decision #1 (Read Committed) — it was the defect.

Task 5: COMPLETE (impl e1fda3d/b8c30f7 + Critical fix bad2e79; docs f022f85 + plan-nesting fix pending; opus review + re-review Approved). Gates: full suite 1910, tsc/eslint 0/0, E2E 17/17 foreground. Both concurrency directions RED-verified.
  STANDING INVARIANT (record in CLAUDE.md at Task 9): the period lock's posting-vs-close correctness DEPENDS on every 5A/5B posting mutation (finalize/unlock/createCredit/postBatch/voidPayment/applyPayment/applyCredit/voidApplication) running SERIALIZABLE — that is what lets SSI abort the finalize-vs-close phantom cycle (both sides must be Serializable; a RC writer carries no SIRead locks). If any posting mutation is ever downgraded to Read Committed, the close-vs-posting guard silently breaks. The dangerous-direction test (close-periods.test.ts) drives the real finalizeInvoice, so a regression there would surface it.
  Minors (final review): (a) retryOnSerializationConflict retries on ANY P2002, not only ClosePeriod's @@unique([year,month]) — harmless (sole reachable unique in the close txn) but a genuinely non-transient P2002 would spin `tries` times; consider scoping to serialization-only. (b) [FIXED in the plan doc now] plan sample had the retry nesting reversed (retry OUTSIDE withDbErrors) — the shipped code is correct (retry inside, catches the raw conflict); plan aligned.
