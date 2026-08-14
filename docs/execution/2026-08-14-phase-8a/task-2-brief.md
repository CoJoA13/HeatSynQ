# Task 2 — Shipped report

**Branch:** `phase-8a-reports-scoreboard` (no PR/merge). **Plan:** §"Task 2". **Spec §4.2** (Shipped row). **Pattern:** `src/server/reports/README.md` (clone A/R aging's five parts). Register in `src/lib/report-registry.ts`.

## Goal

Actual shipped volume by period — shipped qty + weight + shipment count, filterable and Excel-exportable, sliceable by customer / part / ship-month / day.

## Measure (pin exactly — this one has two traps)

- **A NEW `shipDate`-windowed aggregation.** Join `ShipperLine → ShipperOrder → Shipper` and filter on `Shipper.shipDate` in range. **Do NOT call `shippedTotals` (`ship-ledger.ts`)** — it is keyed on `orderLineId` with **no date dimension** and it deliberately **skips released rows**; it answers the ordered-vs-shipped invariant question, not "how much did we ship in this window." Reuse only its **live-filter discipline**, not the function.
- **Live-filter discipline (from `ship-ledger.ts`):** exclude voided shipments via the relation `shipperOrder.shipper.deletedAt: null`. **Reversals are live negative-qty `ShipperLine` rows** (their parent `Shipper` links via `reversesShipperId`); summing live lines **auto-nets** a reversal — and it nets into the reversal's **own `shipDate` window**, which may differ from the original shipment's window. Do not special-case or double-handle them; just sum live lines in the window.
- **Released rows ARE included.** A `ShipperLine` with `orderLineId === null` (its order line was later deleted) is **real shipped material** — include it via its **snapshot** `qty`/`weight`/part columns. (This is the deliberate divergence from `shippedTotals`, which skips these. The snapshot part identity is what the "by part" slice uses for released rows.)
- **Columns/rows:** shipped qty, shipped weight, shipment count (distinct shippers). Group by customer · part · ship-month · day. **Filter:** `shipDate` range + customer + part. Reads never mutate (pure read).

## The five parts

`src/server/reports/shipped.ts` (pure core + `reportShipped(filter)` wrapper) · `src/app/api/reports/shipped/{query.ts,route.ts,export/route.ts}` · `src/app/reports/shipped/{page.tsx,ShippedReport.tsx}` (client, numeric table, one query string for fetch + export link). Register `{ key: "shipped", label: "Shipped", href: "/reports/shipped", area: "reports", description: "Shipped quantity and weight by period." }`.

## Tests (TDD — RED first)

- **Reversal nets into its own `shipDate` window** (seed an original shipment in month A and its reversal in month B → month A shows the full qty, month B shows the negative; the net across both = remaining). RED-verify the window attribution.
- **Voided shipment excluded** (a soft-deleted `Shipper` contributes nothing).
- **Released row counted** — a `ShipperLine` with `orderLineId = null` still contributes its snapshot qty/weight (RED-verify: this is the guard against accidentally reusing `shippedTotals`' skip).
- Grouping by customer / part / ship-month / day each correct; `shipDate` range filter; shipment-count is distinct shippers.
- Route gate `reports.view` (ctx `{ params: Promise.resolve({}) }`).

## Acceptance

- `/reports` shows Shipped; `/reports/shipped` renders + exports. Targeted tests green (`npx vitest run tests/reports-shipped.test.ts`); tsc + eslint clean. Controller runs the full suite + build + E2E after handoff (do NOT run them yourself).

## House rules

Client components must not import `src/server/**`. Route-handler tests pass ctx. `deletedAt: null` on the `Shipper`. Commit small units, conventional messages, **no attribution trailer**. Write `docs/execution/2026-08-14-phase-8a/task-2-report.md` and update the Task 2 ledger row when done. Report back concisely. No PR/merge.
