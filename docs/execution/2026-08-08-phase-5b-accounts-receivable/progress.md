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

## Task ledger

- [x] Task 1 — `ar-constants.ts`, `receivables` permission area + `write_off`, `receipt_batch_number_next` counter — **complete** (code `492bffe`, report `ac4680b`; review clean)
- [ ] Task 2 — schema: 3 tables, column additions, 2 CHECKs, migration, registry/audit/sweeps
- [ ] Task 3 — `createCredit` own-date + `Invoice.dueDate` at finalize
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

_None yet._

## Task detail

### Task 1 — complete (BASE `c0af0a8`, code `492bffe`, report `ac4680b`; review clean)
- Added `src/lib/ar-constants.ts` (pure/client-safe: `APPLICATION_TYPES`, `RECEIPT_BATCH_STATUSES`, `AGING_BUCKETS` + label maps), `"receivables"` to `AREAS`, `"write_off"` to `SPECIAL_ACTIONS`, and the `receipt_batch_number_next` counter (default 1000) to the settings registry.
- Tests: permissions area/action case; `allocateNumber` returns 1000→1001; `partial-unique-sweep` allow-list gains `"ReceiptBatch.batchNumber"` (allocation-only exemption, inert until Task 2's schema adds the column — reviewer traced the sweep to confirm it is not a false-pass).
- Gates: `npm test` 1694/1694, `tsc`/`eslint`/`build` clean (all foreground).
- Reviewer verdict: Spec ✅, quality Approved, zero findings. Byte-diffed `ar-constants.ts` (incl. en-dash label bytes) and hand-counted 13 areas / 12 specials.
- Process note: the first implementer dispatch stalled polling a backgrounded `npm test`; redirected via SendMessage to run gates foreground, which completed cleanly. It also self-recovered a stray `git stash` mid-task — verified afterward: clean tree, empty stash list, no lost work.
