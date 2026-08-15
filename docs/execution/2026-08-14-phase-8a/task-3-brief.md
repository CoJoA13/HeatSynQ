# Task 3 — Turnaround report

**Branch:** `phase-8a-reports-scoreboard` (no PR/merge). **Plan:** §"Task 3". **Spec §4.2** (Turnaround row) + §12 item 1. **Pattern:** `src/server/reports/README.md`. Register in `src/lib/report-registry.ts`.

## Goal

Average order-to-ship days, filterable and Excel-exportable, sliceable by customer / part / completion-month.

## Measure (pin exactly — the completion date is DERIVED, there is no stored timestamp)

- **There is NO stored order-completion timestamp.** `Order.status` is a derived enum written by `recomputeOrderStatus` (`ship-ledger.ts`) with no transition date. So compute the completion date **from shipments, NEVER the audit log** (the report must read stable data, not reconstruct history).
- **Completion date derivation:** for each order line, the earliest live `Shipper.shipDate` whose `ShipperLine` satisfies the per-line `lineComplete` rule (mirror how `ship-ledger.ts` decides a line is complete); the **order's completion date = MAX** of those per-line dates (the day the last line completed). Use only **live** shipments (`shipper.deletedAt: null`).
- **Population:** only orders **currently fully `SHIPPED`** are included (open/partial work lives in Backlog; un-completable orders have no completion date). A **`REOPENED`-then-re-completed** order recomputes from its **current live shipments** — ignore prior shipment cycles (a reversal removed the old completion; the new completion is what stands).
- **Measure:** `completionDate − receivedDate` in whole days, per order; the report shows the **average** (and count; consider min/max). Both dates are `@db.Date` (UTC-midnight) — whole-day difference, deterministic.
- **Group:** by customer · part · completion-month. **Filter:** date range on the **completion date** + customer + part. Endpoint = **full-`SHIPPED` completion** (owner default). Pure read.

## The five parts

`src/server/reports/turnaround.ts` (pure core + `reportTurnaround(filter)` wrapper) · `src/app/api/reports/turnaround/{query.ts,route.ts,export/route.ts}` · `src/app/reports/turnaround/{page.tsx,TurnaroundReport.tsx}` (client, numeric table, one query string for fetch + export). Register `{ key: "turnaround", label: "Turnaround", href: "/reports/turnaround", area: "reports", description: "Average order-to-ship days." }`.

## Tests (TDD — RED first)

- **Completion-date derivation** over a multi-shipment order (lines complete on different shipDates → completion = the MAX). 
- **Excludes not-currently-SHIPPED** orders (OPEN/PARTIAL_SHIPPED/INVOICED-without-ship contribute nothing).
- **REOPENED-then-re-completed** recomputes from the current live shipments (seed an order shipped, reversed, re-shipped → turnaround uses the NEW completion date, not the old).
- Average math; range on completion date; grouping by customer/part/completion-month.
- Route gate `reports.view` (ctx `{ params: Promise.resolve({}) }`).

## Acceptance

- `/reports` shows Turnaround; `/reports/turnaround` renders + exports. Targeted tests green (`npx vitest run tests/reports-turnaround.test.ts`); tsc + eslint clean. Controller runs full suite + build + E2E after handoff (do NOT run them yourself).

## House rules

Client components must not import `src/server/**`. Route-handler tests pass ctx. `deletedAt: null` on shippers/orders. Reads never mutate. Commit small units, conventional messages, **no attribution trailer**. Write `docs/execution/2026-08-14-phase-8a/task-3-report.md` and update the Task 3 ledger row. Report back concisely. **Flag for the reviewer** exactly how you mirrored `ship-ledger.ts`'s `lineComplete` rule (do not re-derive it differently). No PR/merge.
