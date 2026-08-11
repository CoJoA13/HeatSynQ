# Task 11 brief — The quote E2E flow, docs, final gates

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-11 · **Depends on:** Tasks 1–10 (everything is built; this task proves and records it)

**Binding documents (read in this order):**
1. `CLAUDE.md` — the E2E section (dev server + DEV db), the docs-update-is-part-of-the-work rule, the "Maintaining this file" rules (no moving counts in CLAUDE.md; they belong in HANDOFF, dated).
2. `docs/superpowers/plans/2026-08-10-phase-6-quoting.md` — Global Constraints + Task 11.
3. `docs/execution/2026-08-10-phase-6-quoting/progress.md` — every task's carried flags (what the whole-branch review must triage; you are ASSEMBLING that list, not resolving it).
4. The existing E2E suite (`erp/tests/e2e/*.spec.ts`) — harness patterns, fixture conventions, the Task 5b Playwright traps in HANDOFF §5a (select-inside-label, controlled inputs, two search boxes).

**Deliverable:** the new quote Playwright flow, the full five-gate run green, and the docs brought current — the state a whole-branch reviewer can pick up cold.

## What to build (plan Task 11)

1. **`erp/tests/e2e/quotes.spec.ts`** — one coherent flow exercising the phase end-to-end through the real UI:
   - Create an ending statement (admin reference page) and mark it default.
   - Create a quote for a seeded customer: one part-linked line (price rows incl. a break), one free-text line (with eachWeight); verify the defaults (number, dates, default ending statement).
   - Print the quote; verify the stored document appears in the documents section.
   - Order entry: select the quoted part → the "Quote #N" preview appears → save → the hub line shows the linked quote.
   - Ship and invoice the order (the existing flows' helpers); verify the invoice grid line names "Quote #N".
   - Close the quote with a reason → the linked-order warning appears; verify the worklist sections (set a follow-up date in the past on a second quote → it appears under Follow-up due; an expired quote appears under Expired).
   - Fixture hygiene: everything created is cleaned from the DEV db afterwards (the harness's conventions).
2. **Docs:**
   - `docs/HANDOFF.md` §4 current-phase state: tasks complete, final gate numbers (dated), the owner-ratification queue assembled in one place (from the ledger: accept-inactive-part asymmetry; CLOSED-quote-blocks-delete; dormant-column churn on first save after attach-part; the grid-vs-PDF source-label asymmetry routed to the demo; anything else the ledger carries).
   - `CLAUDE.md`: ONLY if a standing convention changed — candidates: the quote-links leaf joining the leaf enumeration in the Architecture section, the §5.14 SSI-pairing standing invariant if you judge it CLAUDE.md-worthy (the close-periods precedent suggests yes — one sentence in the row-locks paragraph, displacing nothing). No counts.
   - The spec's §11 amendment list — verify every §15-bound amendment from the design is actually recorded in the original spec (they were committed at kickoff; confirm, don't duplicate).
   - The ledger's Task 11 row + a "ready for whole-branch review" closing entry listing the triage inputs.
3. **Final gates:** `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`, `npm run test:e2e` (now 19 flows) — all green, all watched, exact counts in the report.

## Hard constraints

- Commands from `erp/`; conventional commits, no trailer; NO code changes outside the E2E spec and docs (a failure the flow exposes gets reported to the controller, not quietly patched — unless it is a fixture/selector issue inside your own spec).
- The Playwright traps in HANDOFF §5a are real; read them before writing selectors.
- Update `progress.md`'s Task 11 row in your final commit.

## Report

`docs/execution/2026-08-10-phase-6-quoting/task-11-report.md`: the flow's shape and what it proves; any product defect the flow exposed (reported, not patched); the docs updated and why; the assembled owner-ratification queue; final gate table with exact counts; scrutiny pointers for the whole-branch reviewer. Commit it.
