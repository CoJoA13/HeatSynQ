# Task 7 — Comparison scoreboard

**Branch:** `phase-8a-reports-scoreboard` (no PR/merge). **Plan:** §"Task 7". **Spec §4.3** (D2/D3, and the approval steer: invoiced-$ by **invoice date**). **Pattern:** clone the report shape; reuse Task 2's shipped aggregation. Register on `/reports`.

## Goal

The weekly parallel-run eyeball page — one page, pick a period, three HeatSynQ figures to compare against Visual Shop's own reports. **Our numbers only** — no VS data entry, no variance computation (D2). A numeric table (no charts). Excel-exportable.

## The three figures (each prints its basis on the page)

1. **Orders entered** — **count of orders** by `Order.receivedDate` in the period, **voided excluded** (`deletedAt: null`). (Not by `createdAt` — receivedDate matches how VS dates an order.)
2. **Shipped** — **pounds & pieces** (D3 — no dollars). **Reuse Task 2's aggregation** (`reportShipped`/`buildShipped` in `src/server/reports/shipped.ts`) for the same window — do not re-derive; the scoreboard's shipped number must equal the Shipped report's for the same window.
3. **Invoiced $** — **Σ `Invoice.total`** for `FINALIZED` invoices by **`invoiceDate`** (owner ruling — the Visual-Shop-eyeball basis; uses the existing `invoiceDate` index), `deletedAt: null`, **credits netted** (CREDIT `total` is negative; show credits on their own line and a net). **This is deliberately `invoiceDate`, NOT `finalizedAt`** (the Sales report uses finalizedAt; the scoreboard is a VS eyeball, not a books tie-out — §4.3/§8). Gross tax-inclusive `Invoice.total`.

## Period control

A date-range picker with **this-week** and **this-month** shortcut buttons (compute the window client-side; weekly is the parallel-run rhythm, the month is the acceptance milestone). One query string drives the page AND the export.

## The parts

- `src/server/reports/scoreboard.ts` — a service returning the three figures for a `{from, to}` window (pure read). Reuse `buildShipped`/`reportShipped` for the shipped figure.
- `src/app/api/reports/scoreboard/{query.ts,route.ts,export/route.ts}` — JSON + xlsx export, gated `reports.view`, shared parse. **The export IS required (spec §4.3)** — `toXlsx` per the `receivables/aging/export` template, same query string so the file mirrors the on-screen figures/window.
- `src/app/reports/scoreboard/{page.tsx,Scoreboard.tsx}` — client, numeric table, the three figures with their bases labeled, the presets. Register `{ key: "scoreboard", label: "Comparison scoreboard", href: "/reports/scoreboard", area: "reports", description: "Weekly parallel-run comparison vs Visual Shop." }`.

## Tests (TDD — RED first)

- **Orders entered** counts by `receivedDate`, **excludes voided** (RED-verify a voided order doesn't count).
- **Invoiced-$ by `invoiceDate`** (the load-bearing basis): an invoice **finalized in a different month than its invoiceDate** buckets by its **invoiceDate**, not finalizedAt (RED-verify — a naive finalizedAt copy would fail). Credits netted.
- **Shipped equals the Shipped report** for the same window (reuse, don't re-derive).
- **The export mirrors** the on-screen figures/window.
- Presets compute correct windows (this-week, this-month).
- Route gate `reports.view` (ctx `{ params: Promise.resolve({}) }`).

## Acceptance

- `/reports` shows the scoreboard; `/reports/scoreboard` renders the three figures + presets + export. Targeted tests green (`npx vitest run tests/reports-scoreboard.test.ts`); tsc + eslint clean. Controller runs full suite + build + E2E after handoff (do NOT run them yourself).

## House rules

Client components must not import `src/server/**`. Route-handler tests pass ctx. `deletedAt: null`. Reads never mutate. Commit small units, conventional messages, **no attribution trailer**. Write `docs/execution/2026-08-14-phase-8a/task-7-report.md` and update the Task 7 ledger row — show a RED transcript for the invoiceDate-basis test. Report back concisely. No PR/merge.
