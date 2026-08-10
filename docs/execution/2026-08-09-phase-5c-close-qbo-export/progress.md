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
- [x] Task 6: gl-export.ts — per-event delta, CSV, batch write + export/readiness routes
- [x] Task 7: posting-register PDF
- [x] Task 8: /receivables/close UI
- [x] Task 9: E2E flow, demo doc, documentation

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

Task 6: IMPLEMENTED (impl 6158c20; docs 78f80d3) but two-lens opus review = NEEDS FIXES (2 data-integrity defects both lenses/one lens converged on; tests never exercised them — factory only builds OPERATION lines).
  CRITICAL (both lenses): resolveReadiness only flagged null-GL lines carrying a step code or surcharge. FREIGHT (freightGlAccountId), CHARGE (otherChargeGlAccountId), CERT (cert-step GL) lines also draw nullable accounts; buildCurrentJournal silently DROPS a null-GL non-TAX line from the credit side but still debits the full inv.total → an UNBALANCED GlExportBatch exports to QBO. Fix: resolveReadiness flags EVERY in-scope finalized non-TAX line with null glAccountId + nonzero amount (attribute freight/charge/cert). BACKSTOP: exportClose asserts Σdebit=Σcredit before persisting, throws otherwise.
  IMPORTANT (delta lens): new postings stamped glDate=periodEnd but scope was cumulative (≤E) → exporting a LATER month first vacuums an earlier month's events under the later date; re-exporting the earlier month re-posts them (DOUBLE-POST). Fix: bound the delta STRICTLY to the period's own [monthStart, monthEnd] (sound: the period lock keeps a closed month's events stable). Test: export Aug before Jul → no double-post.
  MINOR (fixing): parseReadinessPeriod doesn't validate year presence → Number(null)=0 → year 1900 silent-empty period instead of 400. Reject absent/empty year + test.
  MINOR (DEFERRED to final review): empty no-op export still writes a zero-posting GlExportBatch + burns an export number (harmless — idempotency intact; the implementer + reviewer both flagged; optional short-circuit).
  Plan §Task6 + spec §4.3/§7 amended (per-period bounds; readiness covers all account-bearing line kinds; balance backstop).

Task 6: COMPLETE (impl 6158c20 + fix f0bc3e0/7cdf922; docs 0c84212; two-lens opus review + opus re-review Approved). Gates: full suite 1931, tsc/eslint 0/0, E2E 17/17 foreground. 49 targeted tests; both defects fail-without-fix verified (5000¢-vs-0¢ unbalanced batch persisted with all layers off; Aug-vacuums-Jul without per-period rebound).
  Both CRITICAL/IMPORTANT closed with a triple defense (readiness flags every account-less non-TAX line → buildCurrentJournal throws → exportClose asserts Σdebit=Σcredit before persist) + strictly-per-period [monthStart,monthEnd] bounds.
  Minors (FINAL REVIEW to triage; none data-integrity — all self-protecting): (a) a FREIGHT/CHARGE line finalized BEFORE its plant default was set has a frozen null-GL snapshot; resolveReadiness gates freight/charge on the CURRENT config so it reads "clean," but buildCurrentJournal throws (500) on the frozen null line — self-protecting (no bad batch), but the panel won't name the real blocker (the invoice needs unlock+re-finalize). Cleaner fix: attribute a frozen null-GL freight/charge line to its INVOICE, not the current plant default. (b) empty no-op export still burns a number + writes a zero-posting batch (implementer+both reviewers flagged; optional short-circuit). (c) year>=2000 is an arbitrary floor vs a presence check (harmless).

Task 7: COMPLETE (impl 8994229 + fix 03bbc69; docs e663fda; sonnet review Approved). Gates: full suite 1937, tsc/eslint/build clean, E2E 17/17 foreground.
  Closed on review: Important (report omitted TDD RED evidence — now captured in the report: register-placeholder revert fails the byteLength/marker test, builder-absent fails posting-register tests); Minor (register content-disposition now carries a derived `gl-register-YYYY-MM.pdf` filename, matching every other inline-PDF route).
  Minor (final review): posting-register money() renders blank-for-zero and no `$` symbol — deliberately register-appropriate (GL registers commonly omit both) but a stylistic outlier vs statement/invoice money(); left as-is. Also incidental good cleanup: implementer restored the recurring `.superpowers/sdd/.gitignore` `*`-clobber to the tracked version.

Task 8: COMPLETE (commit c209b91; sonnet review Approved — spec ✅, REACHABILITY confirmed: all 7 capabilities operable through /receivables/close — the 5B API-only blind spot is closed). Gates: full suite 1938, tsc/eslint/build clean, E2E 17/17 foreground; browser-verified end-to-end (no screenshot — Browser pane couldn't composite in the sandbox; DOM/fetch assertions + passing E2E used instead). Added the gap-fill GET /api/receivables/close + listClosePeriods (thin gated read, tested).
  PLAN GAP (folded in, not a defect): the Tasks 5-7 routes lacked a list-closed-periods endpoint the UI needs — added in Task 8.
  Minors (final review): (a) Export button's live readiness-gap count is fresh only for the picker's selected month; historical rows rely on the server exportClose 409 (safe by construction; a per-row readiness fetch is the follow-up). (b) Close.tsx ReadinessGap.kind typed `string` vs the server union (harmless widening).
  Note: task-8-report.md was written under erp/docs/ by mistake (implementer cwd=erp/, relative path) — controller moved it to repo-root docs/execution/.

Task 9: IMPLEMENTED (commit 28b80ee) but review found ONE Important data-integrity defect — NOT complete until the fix below.
  IMPORTANT (data-integrity), confirmed: `close-month-end.mjs` recorded `ctx.created.closePeriodYear`/
  `Month` (the target month) BEFORE the pre-flight existence guard ran. `run.mjs`'s `finally {
  teardown() }` always runs `ctx.created` through `cleanup()` regardless of pass/fail, so if a REAL
  `ClosePeriod` already covered the target month (e.g. the owner closed the current month through the
  live UI — the demo doc's own "watching it live" section invites exactly this), the guard correctly
  refused to POST, the flow FAILed, and `cleanup()` -> `deleteClosePeriodFixture` (a `(year,month)`
  lookup against a `@@unique([year,month])` table) hard-deleted that REAL period plus its
  `GlExportBatch`/`GlPosting`/audit rows. The guard protected the POST, not cleanup. The flow's own
  comment, the report, and the demo doc all claimed this "can never touch a real close," which was
  false as shipped.

Task 9: Fix round 1 LANDED (commit 945df25). `ctx.created.closePeriodYear`/`Month` are now assigned
  ONLY after this flow's own `closePeriod` POST has actually committed (right after `await closed;`),
  not up front — a guard failure (or anything earlier) now leaves both `null`, so `cleanup()` has
  nothing to target. Belt-and-suspenders: `deleteClosePeriodFixture` gained a `closedById` parameter
  and only ever deletes a period whose `closedById` matches this run's own fixture admin
  (`fixtures.adminUserId`), a second independent check against the same failure mode. Corrected the
  now-accurate safety claim in `db-fixtures.ts`'s `CleanupPayload`/`deleteClosePeriodFixture` comments,
  `close-month-end.mjs`'s own file-header/inline comments, `task-9-report.md`'s residual-risk section,
  and the demo doc's "one accepted, documented gap" section. Gates: tsc/eslint clean, E2E 18/18
  foreground (close-month-end still passes).

Task 9: COMPLETE (commits 28b80ee, 945df25; not independently reviewed beyond the fix round above — final task, whole-branch review covers it). The 18th E2E flow (`close-month-end.mjs`): sets the four Admin -> Billing GL defaults, closes/exports/reopens/corrects/re-exports the current month end to end, asserts variance 0, readiness 0 gaps, CSV balance, and an exact 30.00/30.00 reversing delta after voiding a write-off application. Backfills two Phase 5B fixtures (`arPriceStepCode`/`arPaymentType`) with GL accounts — the close's readiness/delta scan is GLOBAL per month, not per-customer, and `receivables-apply-age-statement.mjs`'s own invoice stays FINALIZED for the rest of a run. Two real harness bugs found and fixed: a `page.on("dialog", …)` listener-accumulation crash (this flow is the first to need more than one dialog sequence per page) and a shared "Type" column-header ambiguity between two nested tables (fixed by locating the panel's own root div instead of the header). Demo doc `docs/2026-08-09-phase-5c-demo.md`; CLAUDE.md gained the two house rules (period lock, GL-export delta); HANDOFF.md §4 records the phase's in-flight state, the nine tasks, and the four defects the reviews caught. Gates: full suite 1938, tsc/eslint/build clean, E2E 18/18 foreground (one transient collision in the pre-existing, unmodified `invoice-shipped-order.mjs` flow did not reproduce on re-run). Deviated from the brief's literal `tests/e2e/close.spec.ts` path — this repo's actual convention is the `e2e/run.mjs` harness + `e2e/flows/*.mjs`, confirmed via package.json and the absence of any `playwright.config.ts`; used `e2e/flows/close-month-end.mjs` instead, registered as the 18th flow.
