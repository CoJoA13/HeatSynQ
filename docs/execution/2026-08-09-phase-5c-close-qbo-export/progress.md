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
- [ ] Task 5: close-periods.ts — close/reopen lifecycle + preliminary report + routes
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
