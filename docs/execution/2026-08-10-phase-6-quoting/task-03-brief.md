# Task 3 brief — Quote service: create, read, list, worklist

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-10 · **Depends on:** Tasks 1–2 (the data layer and the `endingStatement` kind are on-branch)

**Binding documents (read in this order):**
1. `CLAUDE.md`.
2. `docs/superpowers/specs/2026-08-10-phase-6-quoting-design.md` — §3 rulings 1–3, 9; §4.1; §5.1 (create bullet), §5.4 (worklist queries).
3. `docs/superpowers/plans/2026-08-10-phase-6-quoting.md` — Global Constraints + Task 3.
4. `docs/execution/2026-08-10-phase-6-quoting/task-01-report.md` + `task-02-report.md` — what already exists and its shapes.

**Deliverable:** `erp/src/server/quotes.ts` (create/get/list/worklist/export-data), `erp/src/lib/quote-constants.ts`, full TDD in `erp/tests/quotes.test.ts` (extending Task 1's smoke file). NO routes (Task 4), NO update/close/delete (Task 4), NO order-side anything (Task 5).

## What to build (plan Task 3)

1. **`quote-constants.ts`** (client-safe, `src/lib/`): `QUOTE_STATUSES = ["OPEN", "CLOSED"]`, labels, and whatever list/worklist filter keys the UI will need named centrally. Follow `invoice-constants.ts`'s style.
2. **`createQuote`** — one transaction, `auditedCreate`, `allocateNumber("quote_number_next", tx)`. Defaults per spec §5.1: quoteDate = today when absent; effectiveDate = quoteDate; expiryDate = quoteDate + `quote_valid_days` (read through the settings registry); endingStatementId = the kind's live default row (if any); quotedById = the actor (context), overridable by input. Validation (field-anchored 400s, enforced in the service): `effectiveDate ≤ expiryDate`; line identity XOR (`partId` xor non-empty trimmed `partNumberText`); a linked part must belong to the quote's customer and be live; one live line per part per quote (also refuse duplicates *within* one payload — the partial unique is per (quoteLineId, stepCode), it will NOT catch two lines for one part); price rows keyed to live step codes, no duplicate step code within a line (the partial unique backstops, but the service message beats a P2002); LOT rows refuse breaks (mirror the exact part-prices rule/message — read `part-prices.ts` first); Decimal scale/positivity constraints mirroring part-prices' zod shapes; `contactId` must be one of the customer's live contacts; `quotedById` must be a live user.
3. **`getQuote`** (detail): live part joins for linked lines (number/name/description/each-weight/material name), own text fields for free-text lines; contact live-join (blank when deleted — spec §4.1); derived `expired` boolean; per-line linked-order summary (count + order numbers via `OrderLine.quoteLineId` — the column exists; links can be fabricated in tests with raw prisma); price rows with breaks ordered by position/threshold.
4. **`listQuotes`**: search (quote number as typed digits, customer name/code, RFQ, part number incl. free-text `partNumberText`), filters (status; derived expired; follow-up-due; customer; date ranges on quoteDate/effective/expiry), ordered newest-first by quoteNumber. **Worklist**: the two §5.4 queries + counts — follow-up due (`OPEN`, live, `followUpDate ≤ today`), expired (`OPEN`, live, `expiryDate < today`); a quote may appear in both. Date comparisons against `todayDateOnly()` or the house date helper — find and reuse it, do not invent a second one.
5. **Excel export data** for the list (the house exporter shape other lists use — data-side only if the export route is Task 4's; check how existing list/export pairs split service vs route and mirror it).
6. **Tests (TDD, failing first):** every validation above; defaults incl. the settings-driven expiry and the default ending statement; number allocation under two concurrent creates (distinct numbers, no gap-on-conflict assumptions); worklist boundary days INCLUSIVE/EXCLUSIVE exactly per spec (`≤ today` vs `< today`); search/filter combinations; the derived-expired display state; audit content asserted (a real before/after diff, not just the action — the Phase 2B lesson).

## Hard constraints

- Commands from `erp/`; conventional commits, no trailer; don't touch `erp/.claude/`.
- Money/decimal handling mirrors part-prices exactly (scales, string-accepting decimal fields — reuse the shared zod decimal helpers, do not re-declare).
- No schema changes. If one seems needed, STOP and report.
- Gates: `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`. No UI touched in this task → E2E not required.
- Update `progress.md`'s Task 3 row in your final commit.

## Report

`docs/execution/2026-08-10-phase-6-quoting/task-03-report.md`: what you built, RED→GREEN narration for the concurrent-create test and the one-live-line-per-part rule, every deviation, gate results with counts, scrutiny pointers. Commit it.
