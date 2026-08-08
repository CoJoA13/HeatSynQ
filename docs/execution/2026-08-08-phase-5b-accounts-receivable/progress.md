# Phase 5B SDD progress ledger

**Plan:** `docs/superpowers/plans/2026-08-08-phase-5b-accounts-receivable.md` (17 tasks)
**Spec:** `docs/superpowers/specs/2026-08-08-phase-5b-accounts-receivable-design.md` (10 owner rulings, §3)
**Branch:** `phase-5b-accounts-receivable`
**Started:** 2026-08-08
**Branch base (merge-base main):** `ba76269`
**Docs commits before Task 1:** `8aaf8f1` design spec, `e242ca7` implementation plan. Task 1 BASE = `e242ca7`.

Execution driven by `superpowers:subagent-driven-development`: fresh implementer subagent per task,
the repo's `task-reviewer` agent gating each on two verdicts (spec compliance + code quality), fix
loops until clean, then a whole-branch review before merge. Briefs and reports live in this
directory (committed — CLAUDE.md's execution-record rule); the regenerable `review-*.diff` packages
stay under `.superpowers/sdd/` (git-ignored).

## Pre-flight plan scan (2026-08-08)

Scanned all 17 tasks once for task-vs-task and task-vs-Global-Constraints contradictions and for
anything the plan mandates that the review rubric treats as a defect. **Clean** — no blocking
contradiction requiring an owner ruling before execution. One subtlety noted for the task loop:
Task 9 asks for a `discardInvoice`-refuses-with-A/R-activity test, but applications only ever target
*finalized* invoices/credits while `discardInvoice` operates on drafts, so the guard may be
defense-in-depth with no natural fixture. Left for the Task 9 implementer/reviewer to surface rather
than pre-litigated.

## Process decisions

- **E2E sequencing.** Per-task gates are `npm test` + `tsc` + `eslint` (+`build` before review). The full Playwright suite (`npm run test:e2e`, dev server + DEV db) is sequenced at **Task 17** and the **closing gate run before the PR** — the plan's explicit ordering, and the 5A precedent. CLAUDE.md's "run E2E whenever a change touches a flow" is honored at those two points (the phase-completion claims), not per-task, because spinning a dev server 17× in the loop is impractical and E2E covers whole flows the mid-loop server state can't yet exercise. If a task makes a high-risk change to an existing 5A flow, E2E is run for it specifically.
- **Implementer stall pattern.** General-purpose implementer subagents in this environment tend to background `npm test` and pause on it. Every dispatch from Task 3 on says: run ALL gates in the FOREGROUND, never background/poll — a ~2-min block is expected.

## Task ledger

- [x] Task 1 — `ar-constants.ts`, `receivables` permission area + `write_off`, `receipt_batch_number_next` counter — **complete** (code `492bffe`, report `ac4680b`; review clean)
- [x] Task 2 — schema: 3 tables, column additions, 2 CHECKs, migration, registry/audit/sweeps — **complete** (code `2d639e2`; review clean, 2 deviations confirmed correct)
- [x] Task 3 — `createCredit` own-date + `Invoice.dueDate` at finalize — **complete** (code `3a0e8e9`; review clean)
- [ ] Task 4 — Terms & BillingConfig columns + admin UIs
- [ ] Task 5 — `ar-balances.ts` (pure)
- [ ] Task 6 — `receipts.ts` + routes
- [ ] Task 7 — `applications.ts` payment/discount/write-off/on-account + routes
- [ ] Task 8 — credit application
- [ ] Task 9 — `invoice-guards` A/R-activity + unlock/discard/void refusals
- [ ] Task 10 — `aging.ts` (pure) + route
- [ ] Task 11 — `finance-charges.ts` (pure)
- [ ] Task 12 — `statements.ts` + `pdf/statement.ts` + STATEMENT document + route
- [ ] Task 13 — `/receivables` batch entry + apply UI
- [ ] Task 14 — aging report UI
- [ ] Task 15 — statements UI + customer A/R section
- [ ] Task 16 — routes 401/403 sweep
- [ ] Task 17 — E2E + demo + docs
- [ ] Whole-branch review + fix wave

## Deferred minors (fix-wave / whole-branch-review triage input)

- **Task 2 (audit snapshot coverage)** — `Application`'s `SNAPSHOT_INCLUDE` (audit.ts) pulls only the target `invoice`, not the source credit (`creditInvoiceId`) or `Payment.customer`; a voided CREDIT application renders its source as a bare cuid in history. Not a defect (child rows are audited as their own models; the brief mandated only these relations). **Carry as an input to Task 8 (credit application)** — cheap to enrich the snapshot there; else whole-branch triage.

## Task detail

### Task 3 — complete (BASE `3d3e855`, code `3a0e8e9`; review clean)
- `createCredit` stamps `todayDateOnly()` in both the create data and the auditData (credit ages from its raise date). `finalizeInvoiceInTx` sets `dueDate = addDays(invoiceDate, terms.netDays)` for INVOICE only, keyed on `terms` presence (netDays is never null — `@default(30)`); read within the existing invoice claim, no new lock. New calendar `addDays` in business-days.ts (distinct from `addBusinessDays`).
- Brief's "amend the existing source-date assertion" had no such assertion; implementer added a dedicated non-vacuous test (30-days-ago source → credit dated today, `!==` source) + audit-content check. Reviewer verified it's a real regression guard.
- Gates: `npm test` 1704, tsc/eslint/build clean. Reviewer (sonnet): Spec ✅, quality Approved. Minors (both non-defects): an `orderBy`-less audit lookup fine today; dueDate computed-then-discarded for CREDIT via spread guard (cosmetic).

### Task 2 — complete (BASE `c0332a1`, code `2d639e2`; review clean)
- Three new tables (`ReceiptBatch`/`Payment`/`Application`), `ApplicationType` enum, column additions to Terms/Invoice/BillingConfig/StoredDocument, two hand-written CHECKs, audit/documents wiring.
- **Migration split (controller-corrected vs brief):** `20260808230000_document_kind_statement_value` (ADD VALUE 'STATEMENT' only) + `20260808230100_accounts_receivable` (everything else). The brief's Step 4 wrongly cited the older `20260804122700` file for the CHECK source and didn't call out the enum-split; I supplied the exact extended CHECK SQL (sourced from 5A's `20260806221500`, `customerId IS NULL` added to every prior arm + STATEMENT arm, SHIPPER stays loose on orderId) and mandated the two-dir split per CLAUDE.md. Both migrations applied to both DBs; 28 migrations, status clean, zero drift.
- **`Application_source_check`** verbatim to spec §4.1 (does not require paymentId on non-credit arms — standalone bad-debt write-off).
- **CLAUDE.md** updated in step (repoints the current CHECK definition to the new migration, documents STATEMENT + the customerId-null tightening, adds the new dir to the ADD VALUE list) — the mandatory docs-in-step convention.
- **Deviation A (correct):** only `Payment.paymentTypeId` registered in `reference-links.ts` — the other five FKs target non-reference-kind models (`BlockerTarget` type + the sweep only cover reference kinds); the brief's Step 7 over-listed. Reviewer independently confirmed from `REFERENCE_KINDS`.
- **Deviation B (correct):** `DocumentMeta` gained required `customerId`, forcing one-token `customerId: null` on three hand-built meta literals (certs/shippers print, traveler) + a `"STATEMENT"` enum-pin in `invoicing-schema.test.ts`. All forced, no scope creep.
- Tests: schema round-trip + a real negative asserting the DB rejects a CREDIT-with-paymentId (SQLSTATE 23514, count stays 0). Gates: `npm test` 1696, tsc/eslint/build clean.
- Reviewer (opus): Spec ✅, quality Approved. One Minor (snapshot coverage) → deferred list above.

### Task 1 — complete (BASE `c0af0a8`, code `492bffe`, report `ac4680b`; review clean)
- Added `src/lib/ar-constants.ts` (pure/client-safe: `APPLICATION_TYPES`, `RECEIPT_BATCH_STATUSES`, `AGING_BUCKETS` + label maps), `"receivables"` to `AREAS`, `"write_off"` to `SPECIAL_ACTIONS`, and the `receipt_batch_number_next` counter (default 1000) to the settings registry.
- Tests: permissions area/action case; `allocateNumber` returns 1000→1001; `partial-unique-sweep` allow-list gains `"ReceiptBatch.batchNumber"` (allocation-only exemption, inert until Task 2's schema adds the column — reviewer traced the sweep to confirm it is not a false-pass).
- Gates: `npm test` 1694/1694, `tsc`/`eslint`/`build` clean (all foreground).
- Reviewer verdict: Spec ✅, quality Approved, zero findings. Byte-diffed `ar-constants.ts` (incl. en-dash label bytes) and hand-counted 13 areas / 12 specials.
- Process note: the first implementer dispatch stalled polling a backgrounded `npm test`; redirected via SendMessage to run gates foreground, which completed cleanly. It also self-recovered a stray `git stash` mid-task — verified afterward: clean tree, empty stash list, no lost work.
