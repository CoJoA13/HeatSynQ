# Task 8 brief — `/quotes` UI: worklist + list + detail (ruling 11)

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-11 · **Depends on:** Tasks 1–7 (the whole quote service + route surface exists; the UI consumes it)

**Binding documents (read in this order):**
1. `CLAUDE.md` — the client/server boundary rule (no `src/server/**` imports; mirror types locally), §5.12 remount-per-record, §5.13 error-banner rule.
2. `docs/superpowers/specs/2026-08-10-phase-6-quoting-design.md` — §3 rulings 9, 11; §5.1, §5.4; §7 (§5.15/§5.16 bullets).
3. `docs/superpowers/plans/2026-08-10-phase-6-quoting.md` — Global Constraints + Task 8.
4. `docs/execution/2026-08-10-phase-6-quoting/task-04-report.md` — the route payload shapes, `linesPayloadFrom` (the round-trip contract) **and its known eachWeight omission (review Minor 2)**: a client that copies it as-is will silently NULL a free-text line's stored eachWeight on every save. YOUR round-trip must carry `eachWeight`.
5. The existing UI precedents: the 5A part-prices grid (price rows + breaks editing), the receivables worklist page, the customers/parts list pages (search/filter/Excel), `HistoryPanel`, the §5.16 gate helper.

**Deliverable:** `/quotes` (worklist + list) and `/quotes/[id]` (detail) as client components against the Task 4/5 routes. No new server code except what a UI gap PROVES missing (STOP and report if you find one — do not extend services silently).

## What to build (plan Task 8)

1. **`/quotes` page** (`erp/src/app/quotes/page.tsx` + `Quotes.tsx`):
   - Leads with the two §5.4 worklist sections, each with count: **Follow-up due** and **Expired** (a quote may appear in both). Inline actions per row: open; **bump follow-up** (date picker, PATCHes the quote, `quotes.edit`-gated); **close with reason** (dialog; renders the response's `linkedOpenOrders` warning list with order links after closing).
   - Below: the full list — search box, filters (status incl. derived Expired, follow-up due, customer, date ranges), Excel export button hitting `api/quotes/export`. The house list pattern (customers/parts pages), NOT the order board machinery.
   - §5.15: customer filter options via `/api/picklists` where applicable; §5.16: every gated control disabled-with-tooltip naming the missing permission (use the shared gate helper).
2. **`/quotes/[id]` detail** (`page.tsx` + `QuoteDetail.tsx`, remounted per record — `key={id}`):
   - Header form: customer (DISPLAY ONLY — immutable), contact picker (the customer's live contacts), quote date, effective/expiry (with the auto-expiry default visible behavior on create-page flows if you build creation here — see 3), follow-up date, RFQ number, quotedBy (user picker), ending-statement picker (via picklists), notes (printed) + internal notes — as a SINGLE-SAVE form (the notes-pair optimistic-PATCH clobber is a known three-page bug family; do not add a fourth).
   - Lines grid: part-picker line vs free-text line toggle; free-text fields (number/name/description/material/**eachWeight**); quotedQty + unlimited; **attach-part** action on free-text lines (`api/quotes/[id]/attach-part`); per-line price-rows editor with breaks — mirror the 5A part-prices grid UX and validation messages; linked-line indicators (which order lines reference a line — from the detail payload) with the §5.14 explanation when a delete/re-point is refused.
   - Actions: close/reopen with reason dialogs (close shows the linked-open-orders warning list); delete with reason + the blockers panel + Excel (refusal renders the named orders); print button placeholder DISABLED with "Printing lands in Task 10" title (§5.16 style) unless Task 10 landed first.
   - `HistoryPanel` wired to the quote; documents/print-history section reading the existing documents API (kind QUOTE — will be empty until Task 10; render the empty state).
   - Status banner: OPEN / CLOSED (with reason/by/at) / derived Expired.
3. **Creation flow**: a "New quote" path (page or dialog per the closest existing precedent — parts/customers pages' create shape) with customer picker, and the server-side defaults surfaced after create (quote number, dates, default ending statement).
4. **Round-trip integrity**: build the save payload from current form state such that an unchanged load→save round-trip is a NO-OP server-side (Task 4's diff-and-write skips no-ops) — including `eachWeight` (the Task 4 Minor) and `sourceQuoteNumber`-style fields you must NOT invent client-side. Test the round-trip in E2E or narrate the manual verification.
5. **Shell**: the existing nav entry already points at `/quotes` — verify it lights up with the `quotes` area and the pages 404/redirect correctly for a user without `quotes.view` (follow the existing pattern for area-gated pages).

## Hard constraints

- Client components; NO imports from `src/server/**` (mirror types as local `type` aliases); fetches through the house `api<T>()` helper; no `.catch(() => {})` — failures surface in the banner (§5.13: roll back to server truth FIRST, then report).
- Commands from `erp/`; conventional commits, no trailer; don't touch `erp/.claude/`.
- Gates: `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`, AND **`npm run test:e2e` run synchronously and watched to completion** (this task is pure UI; the existing 18 flows must stay green — the new quote E2E flow itself is Task 11's). Clear dev-DB fixtures afterwards.
- Update `progress.md`'s Task 8 row in your final commit.

## Report

`docs/execution/2026-08-10-phase-6-quoting/task-08-report.md`: what you built; the round-trip no-op verification narrative (including eachWeight); every §5.16 gate on the pages; deviations; gate + E2E results with counts; scrutiny pointers (especially any place you had to interpret a route payload). Commit it.
