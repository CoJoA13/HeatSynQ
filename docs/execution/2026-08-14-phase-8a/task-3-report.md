# Task 3 — Turnaround report — implementer report

**Branch:** `phase-8a-reports-scoreboard` (no PR/merge). **Spec §4.2 / §12.** Five-part clone of the
Backlog/Shipped reports, registered in `src/lib/report-registry.ts`. **Commits:** `d7d99fd` (service
+ tests), `86eb3a6` (API routes), `560f18f` (UI + registry).

## Built

Average order-to-ship days over currently-`SHIPPED` orders, with the completion date **derived from
shipments** (there is no stored completion timestamp). Filterable by completion-date range + customer
+ part, sliceable by customer / part / completion-month (each group carries count / avg / min / max),
plus an overall average-and-count summary and an Excel export.

## Files

- `erp/src/server/reports/turnaround.ts` — `buildTurnaround` (pure core) + `reportTurnaround` (Prisma wrapper).
- `erp/src/app/api/reports/turnaround/query.ts` — the one shared `parseTurnaroundFilter`.
- `erp/src/app/api/reports/turnaround/route.ts` — `GET /api/reports/turnaround` (`reports.view`).
- `erp/src/app/api/reports/turnaround/export/route.ts` — `GET .../export` → xlsx (`Turnaround.xlsx`).
- `erp/src/app/reports/turnaround/page.tsx` + `TurnaroundReport.tsx` — client screen (ShippedReport clone).
- `erp/src/lib/report-registry.ts` — added the `turnaround` entry.
- `erp/tests/reports-turnaround.test.ts` — 19 tests (pure core, DB derivation, population, REOPENED, filters/grouping, route gates, export).

## The completion-date derivation — how I mirrored `ship-ledger.ts`'s `lineComplete` rule (REVIEW FOCUS)

The brief's hard part: no stored order-completion timestamp exists, so the completion date is derived
from shipments, never the audit log.

- **`lineComplete`, copied verbatim from the ledger.** `recomputeOrderStatus` (ship-ledger.ts) decides
  a line is complete when it has **at least one live shipper line** (`shipperOrder.shipper.deletedAt:
  null`) **with `lineComplete = true`** — quantities never enter that decision. My query filters the
  order line's `shipperLines` with the SAME predicate: `{ lineComplete: true, shipperOrder: { shipper:
  { deletedAt: null, … } } }`. I did **not** re-derive "complete" from net quantities or any other
  rule — it is the ledger's flag rule, reached through the same one relation a shipper line has back
  to its shipment.
- **Per-line earliest → order MAX (full-ship, owner default §12).** For each order line I take the
  **earliest** `Shipper.shipDate` among its complete shipper lines (the day that line first became
  complete); the **order's** completion date is the **MAX** of those per-line dates (the day the last
  line completed). A line with no complete shipment leaves the order un-derivable and it is skipped
  (defensive against a stale `status`; a genuinely-SHIPPED order always has one per the ledger's own
  SHIPPED rule).
- **Population = currently `status === "SHIPPED"`, `deletedAt: null`.** Open/partial work lives in
  Backlog; an `INVOICED` order — even one with a fully derivable completion date — is excluded because
  it is not *currently* SHIPPED (test seeds exactly that and asserts exclusion).
- **REOPENED-then-re-completed — ignore the reversed cycle (§12).** This is the one place the base
  `lineComplete` rule needs a refinement, and the brief calls it out explicitly. I read the reversal
  mechanics from `shippers.ts` (`reverseShipperInTx`, ~L1627–1666): a reversal is a **live** negative
  shipment with `reversesShipperId` set and its lines `lineComplete: false`, and it **never voids the
  original** — so after "shipped → reversed → re-shipped" the original outbound stays live with its
  `lineComplete: true` rows and would otherwise win the "earliest complete shipDate". The refinement:
  a completing shipment whose shipper has been reversed by a **live** reversal no longer counts —
  `shipper: { reversedBy: { none: { deletedAt: null } } }` drops it, leaving the re-ship as the
  completion that stands. (If the reversal is itself voided, the original counts again — pinned by a
  dedicated test.)

## RED-first evidence (the two hard behaviors)

Tests were written first; the service's derivation was then deliberately implemented as the **wrong**
convention — **first-ship** (the earliest complete shipDate anywhere on the order, no reversal
exclusion), the exact "first-ship vs full-ship" alternative the spec flags in §12 — to prove the two
targeted tests genuinely pin the derivation. Targeted run against that first cut:

```
 × reportTurnaround — the completion-date derivation > derives completion = MAX of each line's earliest complete shipDate (multi-shipment order)
   → expected '2026-06-10' to be '2026-06-20' // Object.is equality
     Expected: "2026-06-20"
     Received: "2026-06-10"
 × reportTurnaround — REOPENED-then-re-completed > recomputes from the CURRENT live shipments, ignoring the reversed prior cycle
   → expected '2026-06-01' to be '2026-07-05' // Object.is equality
     Expected: "2026-07-05"
     Received: "2026-06-01"

 Test Files  1 failed (1)
      Tests  2 failed | 17 passed (19)
```

- **Completion-MAX** failed because first-ship returned the earliest line's date (`2026-06-10`) instead
  of the MAX per-line date (`2026-06-20`).
- **REOPENED** failed because without the `reversedBy` exclusion the reversed original outbound
  (`2026-06-01`) still won, instead of the re-ship (`2026-07-05`).

Correcting the reduction to per-line-earliest → order-MAX and adding the `reversedBy: { none: {
deletedAt: null } }` exclusion turned both green with the tests unchanged.

## Design calls worth a reviewer's eye

- **"By part" attributes a per-order measure to EACH distinct part on the order.** The measure is
  per-order (completionDate − receivedDate); the "by part" slice credits that turnaround to every
  distinct part the order carries, counting the order once per part. A part appearing on two lines of
  one order counts that order ONCE (per-order dedupe of the dimension keys). Pinned by two pure-core
  tests. The **overall** `orderCount`/`avgDays` are always over DISTINCT orders (never re-derivable by
  weighting the part-slice rows, which double-count an order across its parts), so the core returns
  them directly.
- **Range filter is in memory, after the derivation.** The completion date is derived, not stored, so
  it cannot be a SQL `WHERE`; the `from`/`to` bounds are applied to the derived date. Both dates are
  `@db.Date` (UTC-midnight), so the whole-day difference is exact and an inclusive `to` is correct.
- **Averages rounded to one decimal in the core** (`roundAvg`) — a single deterministic display
  precision; the raw inputs are integer days, so the only fraction is the division.
- **`partId` filter matches the live `orderLine.partId`** (`lines: { some: { partId } }`) to select the
  population of orders containing that part; grouping then slices independently (the backlog precedent).
- Pure read: no claim, no transaction, no audit (asserted `auditLog.count() === 0` in a DB test).

## Targeted gate results (watched to completion)

- `npx vitest run tests/reports-turnaround.test.ts` → **19 passed** (13:26).
- `npx tsc --noEmit` → clean.
- `npx eslint` over all new/changed files → clean.
- `npx vitest run tests/reports-routes.test.ts` → **3 passed** (registry entry is safe; the index test
  uses `toBeGreaterThan(0)`).
- Full `npm test` / `npm run build` / `npm run test:e2e` **deferred to the controller** per brief
  (implementer runs targeted only; no dev-server startup, so no browser preview — the UI is a straight
  ShippedReport clone).
