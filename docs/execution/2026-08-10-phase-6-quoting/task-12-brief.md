# Task 12 brief (fix wave) — Ruling 7's overlap-save warning

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-11 · **Owner ruling:** build in-phase (2026-08-11, F1 of the whole-branch review)

**Binding:** spec §3 ruling 7's second sentence — "Saving a quote that overlaps an existing open quote for the same part **warns but doesn't block**"; CLAUDE.md; the §5.7-warnings precedent (`shipmentWarnings` — warnings ride the mutation response, never block); the whole-branch review's F1 (ledger, bottom section).

**Deliverable:** overlap warnings on every mutation that can create an overlap, surfaced in the UI, tested. NOTHING else — this is a fix wave, not a feature round.

## What to build

1. **Service** (`quotes.ts`): `createQuote`, `updateQuote` (when `lines` present), and `attachPart` responses gain `warnings: string[]` computed inside the same transaction after the write: for each live part-linked line of THIS quote, find OTHER live OPEN quotes (same customer — a part belongs to one customer, so customer-scoping is implicit via partId; verify and say so) holding a live line for the same part whose `[effectiveDate, expiryDate]` window overlaps this quote's (inclusive both ends — two windows sharing one day overlap). One warning per (part, other-quote), naming part number and the other quote's number: the §5.7 message style. Free-text lines never warn (no part). No status/schema changes; warns never block (ruling 7).
2. **Routes**: the create/update/attach responses already serialize the service return — verify the `warnings` member rides through; extend the response zod/type mirrors as needed.
3. **UI**: `QuoteDetail.tsx` (save + attach-part) and the create flow render the warnings in the house warning-banner style (amber, non-blocking, dismissed by navigation — mirror the shipment warning banner). §5.13 discipline: the banner must not be cleared by a reload that follows the save.
4. **Tests (TDD, RED first):** overlap detected — partial overlap both directions, containment, exact single-day touch (inclusive boundary); NOT warned — windows disjoint, other quote CLOSED, other quote deleted, other line deleted, free-text lines, the quote's own lines (self); the attachPart path warns when the attach creates the overlap; update that SHRINKS a window out of overlap stops warning. Assert message content (part number + quote number), not just count.

## Hard constraints

- Commands from `erp/`; conventional commits, no trailer; NO schema changes; don't touch `erp/.claude/`.
- Gates: `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`, AND `npm run test:e2e` (UI changed — all 19 flows watched to completion; **never pre-write a gate row**; clear dev-DB fixtures).
- Update `progress.md` with a Task 12 row in your final commit.

## Report

`docs/execution/2026-08-10-phase-6-quoting/task-12-report.md`: what you built, RED narration, the customer-scoping verification, deviations, gate + E2E results with counts, scrutiny pointers. Commit it.
