# Task 4 brief — Quote service: update, close/reopen, delete, attach-part + routes

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-11 · **Depends on:** Tasks 1–3 (data layer, `endingStatement` kind, and the create/read/list half of `quotes.ts` are on-branch)

**Binding documents (read in this order):**
1. `CLAUDE.md` — especially the row-lock rules and the audit/§5.17 conventions.
2. `docs/superpowers/specs/2026-08-10-phase-6-quoting-design.md` — §3 rulings 3, 6, 8, 10; §5.1 (edit/close/delete bullets); §4.2.
3. `docs/superpowers/plans/2026-08-10-phase-6-quoting.md` — Global Constraints + Task 4.
4. `docs/execution/2026-08-10-phase-6-quoting/task-03-report.md` — the create-path shapes you extend, its deviation list (esp. the Serializable-two-jobs warning for your update path), and the fix-round section.

**Deliverable:** the mutation half of `erp/src/server/quotes.ts` (update, close, reopen, delete, attach-part) plus ALL `/api/quotes*` routes from the plan's file map except `print` (Task 10) and `eligible` (Task 5), with route tests. TDD throughout.

## What to build (plan Task 4, spec §5.1)

1. **`updateQuote`** (`quotes.edit`, OPEN quotes only — a CLOSED or deleted quote 400s/404s):
   - **Claim the quote row first** (`SELECT … FOR UPDATE` on the caller's tx) before reading any state acted on; heed Task 3's warning that the create transaction's Serializable serves two masters — decide and DOCUMENT what isolation update needs (the row claim is the guard; Serializable only if you also assign registered FKs, matching the `assignsFk` pattern).
   - `customerId` immutable (400, field-anchored).
   - Header fields editable; line/price/break **array-replace semantics matching the part-prices editing pattern** (read how `replacePartPrices`/its kin diff-and-write; live rows updated in place vs delete-and-recreate — follow the precedent, and keep `QuoteLine` ids STABLE for lines that persist, because `OrderLine.quoteLineId` points at them).
   - **§5.14 refusals**: deleting a quote line — or changing its `partId` — while any `OrderLine.quoteLineId` references it is refused with the blockers NAMED (order numbers) in the error; free-text edits and price-row edits on a linked line are always allowed (ruling 8). The blocker read happens under the quote row claim, on the same tx.
   - Re-validate everything create validates (dates, XOR, part-customer match, one live line per part, dup step codes, LOT-breaks, contact, quotedBy, endingStatement) — shared helpers, not copy-paste.
   - **Audit**: `auditedUpdate` with real before/after — this is the FIRST exercise of `SNAPSHOT_INCLUDE.quote`'s relation tree (Task 3's reviewer flagged it as never yet run). Assert audit CONTENT in tests: a price edit must show in the diff, a break add must show, and the snapshots must exclude soft-deleted children.
2. **`attachPart`** (`quotes.edit`): sets `partId` on a live free-text line of an OPEN quote — same validation as create (customer match, live part, one-live-line-per-part vs the quote's other lines); refuses on a line that already has a part; audited. Keep the free-text columns as-is (dormant history — spec §4.1).
3. **`closeQuote` / `reopenQuote`** (`quotes.edit`): reason trimmed non-empty IN THE SERVICE (§5.17); close sets status/closedAt/closedById/closeReason; reopen returns to OPEN (decide and document what happens to the stored close fields — the void/unvoid precedents in shippers are the reference); both under the row claim (second close 400s "already closed"; reopen of an open quote 400s). The close response carries `linkedOpenOrders` — open, not-yet-fully-invoiced orders still linked (ruling 6's warn-and-list, NEVER a block). Define "not-yet-fully-invoiced" by reading how order status/invoice guards actually work (`invoice-guards.ts`, `Order.status`) and document your definition in the report.
4. **`deleteQuote`** (`quotes.delete`): reason required (§5.17, trimmed in service); **refused-and-named** while ANY order line references any of its lines (§5.14 — the full list with order numbers; the Excel export of blockers rides the blockers route below); soft-delete stamps the quote AND its live children through the audited path (read how deletePart cascades stamp children and mirror it).
5. **Routes** (thin: `mustCan` first line, zod `.strict()`, delegate):
   - `api/quotes/route.ts` — GET (list + worklist params), POST (create — wires Task 3).
   - `api/quotes/[id]/route.ts` — GET, PATCH (update), DELETE (reason in body).
   - `api/quotes/[id]/close/route.ts`, `api/quotes/[id]/reopen/route.ts` — POST with reason.
   - `api/quotes/[id]/attach-part/route.ts` — POST (lineId, partId).
   - `api/quotes/[id]/blockers/export/route.ts` — GET, the §5.14 blocker list as Excel (mirror an existing blockers-export route end-to-end).
   - `api/quotes/export/route.ts` — GET, the list Excel export (wires Task 3's `exportQuotes`; mirror an existing list-export route's shape/permissions).
   - Permissions: `view` for GETs/exports, `create` for POST create, `edit` for PATCH/close/reopen/attach, `delete` for DELETE. Route tests pass ctx; permission-denied cases per route; the permissions sweep must stay green.
6. **Tests (TDD, failing first):** every rule above; the §5.14 refusals with fabricated `OrderLine.quoteLineId` links; close's warn-list contents (open vs invoiced vs voided orders); update on CLOSED/deleted quotes; line-id stability across an update that keeps a line; the audit-content assertions; concurrency — close vs update racing on the row claim (RED-verify per the house rule: guard removed, competing caller pinned Read Committed).

## Hard constraints

- Commands from `erp/`; conventional commits, no trailer; don't touch `erp/.claude/`; no schema changes (STOP and report if needed).
- Gates: `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`. No UI pages in this task → E2E not required (routes are not flows).
- Update `progress.md`'s Task 4 row in your final commit.

## Report

`docs/execution/2026-08-10-phase-6-quoting/task-04-report.md`: what you built; the isolation decision for update and why; the reopen-field decision; your "not-yet-fully-invoiced" definition with citations; RED narration for the close-vs-update race; the array-replace precedent you followed and how line-id stability is guaranteed; deviations; gate results with counts; scrutiny pointers. Commit it.
