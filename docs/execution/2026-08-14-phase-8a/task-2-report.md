# Task 2 — Shipped report — implementer report

**Branch:** `phase-8a-reports-scoreboard` (no PR/merge). **Spec §4.2.** Five-part clone of the
Backlog report, registered in `src/lib/report-registry.ts`.

## Built

Actual shipped volume by period — shipped qty + weight + shipment count, windowed on
`Shipper.shipDate`, filterable (ship-date range + customer + part) and sliceable
(customer / part / ship-month / day), with an Excel export.

## Files

- `erp/src/server/reports/shipped.ts` — `buildShipped` (pure core) + `reportShipped` (Prisma wrapper).
- `erp/src/app/api/reports/shipped/query.ts` — the one shared `parseShippedFilter`.
- `erp/src/app/api/reports/shipped/route.ts` — `GET /api/reports/shipped` (`reports.view`).
- `erp/src/app/api/reports/shipped/export/route.ts` — `GET .../export` → xlsx (`Shipped.xlsx`).
- `erp/src/app/reports/shipped/page.tsx` + `ShippedReport.tsx` — client screen (BacklogReport clone).
- `erp/src/lib/report-registry.ts` — added the `shipped` entry.
- `erp/tests/reports-shipped.test.ts` — 18 tests (pure core, DB wrapper, route gates, export attachment).

## The two traps — how they were handled (review focus)

1. **Did NOT call `shippedTotals`.** A brand-new aggregation reads `ShipperLine` and joins
   `shipperOrder.shipper` for the `shipDate` window + void filter. `shippedTotals` was read only for
   its live-filter discipline (`shipper.deletedAt: null`), never called — it is keyed on
   `orderLineId`, has no date dimension, and skips released rows, so it answers a different question.
2. **Reversal netting.** Reversals are live negative-qty `ShipperLine` rows on a shipper carrying its
   own `shipDate` (and `reversesShipperId`). The measure simply sums live lines, so a reversal
   auto-nets into the reversal's own `shipDate` window — no special case, no double-handling. Pinned
   by both a pure-core test and a DB test seeding an outbound in June (+10) and its reversal in July
   (−10): June shows 10, July shows −10, net 0. The reversal lands in **July**, not back in June.
3. **Released rows counted.** Rows with `orderLineId === null` are included (the query filters on the
   shipper, never on `orderLineId`) and rendered from their snapshot `qty`/`weight`/`partNumber`/
   `partName`. Reads are live-join-first (`orderLine?.part.partNumber ?? snapshot`) so a live row shows
   the part's current identity and a released row falls back to the snapshot. Guarded by a dedicated
   test that seeds ONE released row and asserts it contributes qty 7 / weight 4 / partNumber
   "REL-SNAP" — the direct guard against reusing `shippedTotals`' skip.

## Design calls worth a reviewer's eye

- **Part grouping key = `customerId + " " + partNumber`.** Parts are customer-scoped (two customers'
  identical numbers are different parts), and released rows have no `partId` — only a snapshot number —
  so a partNumber-based key is the one thing that spans both live and released rows. A cuid customerId
  never contains a space, so the first space is always the delimiter. Documented in `groupLabel`.
- **`partId` filter matches the LIVE `orderLine.partId`, deliberately excluding released rows.** A
  released row has no verifiable part linkage, so it cannot be positively matched to a chosen part; the
  default (no part filter) still counts released material via the snapshot. Documented at the query.
- **Inclusive `lte` on the `to` bound** — `shipDate` is `@db.Date` (UTC-midnight, no time-of-day), so
  the `finalizedAt` half-open subtlety does not apply. Matches Backlog's `receivedDate` handling.
- **Shipment count = distinct shippers** (a two-line shipment counts once) via a `Set<shipperId>`.
- Pure read: no claim, no transaction, no audit (asserted `auditLog.count() === 0` in a DB test).

## Targeted gate results (watched to completion)

- `npx vitest run tests/reports-shipped.test.ts` → **18 passed** (13:01).
- `npx tsc --noEmit` → clean.
- `npx eslint` over all new/changed files → clean.
- Full `npm test` / `npm run build` / `npm run test:e2e` **deferred to the controller** per brief
  (implementer runs targeted only; no dev-server startup).

## Note

TDD RED-first: the tests were written before the implementation. During the first run 3 of the 18
failed — the failures were the three part-key assertions, and the root cause was a stray control
character (null byte) that had slipped into the test's part-key string literals, not a logic error;
replacing them with spaces made all 18 green with the implementation unchanged. (Flagging per the
Task-1 review note about RED evidence.)
