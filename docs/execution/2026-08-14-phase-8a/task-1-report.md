# Task 1 — Backlog report: implementer report

**Branch:** `phase-8a-reports-scoreboard` · **Commits:** `c4da1e8` (backend), `641303f` (UI). No PR/merge.

## What was built

The Backlog report — the five-part clone of A/R aging (per `src/server/reports/README.md`),
registered on `/reports`. Open order lines of orders not yet fully shipped, filterable and
Excel-exportable, sliceable by customer / part / received-month.

## Files

- `src/server/reports/backlog.ts` — pure core `buildBacklog(lines, {today, groupBy})` + thin
  Prisma wrapper `reportBacklog(filter)`. Pure read (no claim, no audit, no Serializable, no
  transaction — a single `orderLine.findMany`).
- `src/app/api/reports/backlog/query.ts` — the one shared `parseBacklogFilter` (both routes import it).
- `src/app/api/reports/backlog/route.ts` — `mustCan(requireUser(), "reports", "view")` → JSON.
- `src/app/api/reports/backlog/export/route.ts` — same gate + same parse → `toXlsx` (columns inlined,
  switched on groupBy), xlsx content-type + `attachment; filename="Backlog.xlsx"`.
- `src/app/reports/backlog/{page.tsx, BacklogReport.tsx}` — client screen; filters in state, ONE
  query string for the fetch AND the export link; `type=date` inputs; numeric table (no charts).
- `src/lib/report-registry.ts` — `{ key:"backlog", label:"Backlog", href:"/reports/backlog",
  area:"reports", description:"Open orders not yet fully shipped." }`.
- `tests/reports-backlog.test.ts` — the RED-first suite (14 tests).

## The measure — pinned exactly (the ambiguous bits)

- **Population:** `OrderLine` where `order.status ∈ {OPEN, PARTIAL_SHIPPED, REOPENED}` and
  `order.deletedAt: null`. **REOPENED is INCLUDED** (`BACKLOG_STATUSES` const). SHIPPED, INVOICED
  and voided orders are excluded. `OrderLine` has no `deletedAt` column (not soft-deletable), so the
  only liveness filter is the order's own `deletedAt: null` — verified against the schema.
- **Amounts: qty + weight ORDERED** — the order line's own `qty`/`weight` straight through. No
  ship-ledger, no remaining-to-ship computed. (Controller note acknowledged: "ordered" is the
  owner-approved choice; remaining-to-ship would be a small follow-up.)
- **"(no part)" does not apply** — every open order line carries a required `partId`, so there is no
  null-part branch.

## Judgment calls for the reviewer

1. **Days-open reference date.** `daysOpen = round((today − receivedDate)/DAY_MS)`, whole days,
   both operands UTC-midnight (`@db.Date` semantics). `today` is a parameter to the pure core
   (`formatDateOnly(todayDateOnly())` in the wrapper) so the math is deterministic under test — the
   `bucketAging(asOf)` precedent. Test seeds `receivedDate = today − 12` and asserts `daysOpen === 12`.
2. **Received-month grouping.** Grouped on `receivedDate.slice(0,7)` ("yyyy-mm"), which is the group
   `key` and `label`; group rows sort by label (so months sort chronologically, customers by code,
   parts by number), with `key` as the deterministic tiebreak.
3. **Group aggregates.** `orderCount` = distinct `orderId` in the group (a `Set`), `lineCount` =
   line count, `qty` = Σqty, `weight` = Σweight summed in **integer hundredths** then /100 (the
   ar-balances integer-cent rule — a "no float drift" test pins 0.1 + 0.2 = 0.3).
4. **Result shape** is a discriminated union on `groupBy` (`{groupBy:"none", rows: DetailRow[]}` vs
   `{groupBy: customer|part|month, rows: GroupRow[]}`). The export route switches its inlined columns
   on the resolved `result.groupBy`; the UI mirrors both row types locally (no `src/server` import).
5. **groupBy validation lives in the service** (`normalizeGroupBy` → 400 on an unknown value), matching
   the "service owns malformed 400s" discipline — the parse layer passes the raw string through.
6. **No RepeatableRead transaction** (unlike aging's three-read snapshot): this is one `findMany`, so
   there is no cross-read consistency window to close. Kept it a single plain read.

## Gates watched (targeted only — per brief)

- `npx vitest run tests/reports-backlog.test.ts` → **14 passed** (watched to end).
- `npx tsc --noEmit` → clean.
- `npx eslint` over all 8 new/changed files → clean.

Full `npm test` / `npm run build` / `npm run test:e2e` were **not** run (long runs kill subagent
turns — the controller runs the full chain after handoff). No browser preview run: the UI is a
straight `AgingReport` clone and starting the dev server was out of scope for the implementer;
the E2E flows and controller pass will confirm the render.

## Export-mirror test (the invariant Task 1 carries)

`tests/reports-backlog.test.ts` seeds two customers/orders, calls the JSON route and the export
route with the SAME `customerId` query string, parses the xlsx, and asserts the export's order-number
population equals the JSON route's — proving the shared parse keeps the table and file in lockstep.
