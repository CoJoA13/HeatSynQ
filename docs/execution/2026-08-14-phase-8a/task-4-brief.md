# Task 4 — Sales report (the careful one)

**Branch:** `phase-8a-reports-scoreboard` (no PR/merge). **Plan:** §"Task 4". **Spec §4.2** (Sales row) + §8 (recognition basis) + §12 item 8. **Pattern:** `src/server/reports/README.md`. Register in `src/lib/report-registry.ts`.

This report drew the most plan-review scrutiny. Two things MUST be exactly right: the SURCHARGE handling and the reconciliation identity.

## Goal

Invoiced **revenue, excluding sales tax**, net of credits — sliceable by customer / part / finalized-month, filterable and Excel-exportable, reconciling to the GL export's revenue accounts.

## Measure (pin exactly)

- **Recognition:** `Invoice.status = FINALIZED`, `deletedAt: null`, recognized by **`finalizedAt`** (owner ruling 8 — NOT `invoiceDate`), range **half-open `[from, nextDay)`** because `finalizedAt` carries a time-of-day (an inclusive `lte` at midnight drops a last-day finalize).
- **Frozen snapshot — read it, never re-join.** Sum from the stored `Invoice`/`InvoiceLine` snapshot columns (partNumber/name, price/amount fields). **NEVER live-join `Part`/`StepCode`** — a later rename/reprice must not rewrite a past month (the frozen-paper rule, CLAUDE.md).
- **Line kinds (get SURCHARGE right):** sum **ALL non-`TAX`** lines = **OPERATION + SURCHARGE + FREIGHT + CHARGE + CERT**. The `PART` header line is `amount = 0` (harmless to include). **SURCHARGE carries real revenue AND a blank `partNumber`** (`pricing.ts` `blank("SURCHARGE")`) — dropping it undercounts sales and breaks the reconciliation. (Verify the `InvoiceLineKind` enum values in `prisma/schema.prisma` before coding.)
- **Credits:** `kind = CREDIT` invoices store `total` negative; credits **copy their source lines** (carrying `partNumber`). Net them (subtract) so Sales = Σ invoice non-tax lines − Σ credit non-tax lines.
- **By-part slice:** part-bearing lines group by `partNumber`; the **blank-`partNumber` kinds (SURCHARGE/FREIGHT/CHARGE/CERT)** fall into an explicit **"(no part)"** bucket, so the part-sliced total still equals the unsliced total. Do **not** re-join a surcharge to the part it surcharges (frozen-paper; the snapshot carries no part identity on it).
- **Group:** by customer · part · finalized-month. Pure read.

## Reconciliation test (the headline — spell out the fixture)

On a **fully GL-mapped, closeable month with no prior `GlPosting`** (so the export delta = the full journal): seed the month's invoices/credits with complete GL mapping, **close** the period, **export** (`exportClose()`), then assert:

> Sales grand total (Σ all-non-tax finalized lines − credits) **==** the sum of `exportClose()`'s **revenue-side postings** (exclude the A/R control account and the TAX/sales-tax-liability account).

This is a property of a **clean month**, not of the report — the Sales report itself needs no GL accounts and sums `line.amount` regardless. Do **not** assert equality with the close roll-forward *gross* (which includes tax). Read `close-periods.ts` (`computeRollForward`) and `gl-export.ts` (`buildCurrentJournal`/`aggregateLines`) to find the exact revenue-side postings to sum.

## The five parts

`src/server/reports/sales.ts` (pure core + `reportSales(filter)` wrapper) · `src/app/api/reports/sales/{query.ts,route.ts,export/route.ts}` · `src/app/reports/sales/{page.tsx,SalesReport.tsx}` (client, numeric table, one query string). Register `{ key: "sales", label: "Sales", href: "/reports/sales", area: "reports", description: "Invoiced revenue (ex-tax), by customer/part/month." }`.

## Tests (TDD — RED first)

- **Ex-tax:** a taxed invoice's Sales figure excludes the TAX line.
- **Surcharge included:** a surcharged invoice's figure **includes** the surcharge revenue; in the by-part cut it lands in **"(no part)"**; and the month still **reconciles to GL** (the RED-critical one — a naive "part lines only" reading fails this).
- **Frozen snapshot:** rename the part / change its price *after* finalize → the report is unchanged.
- **Credit reduces** the total (a credit copies part lines and nets out).
- **"(no part)" bucket** holds the blank-partNumber kinds; sliced total == unsliced total.
- **`finalizedAt` half-open boundary:** a last-second-of-month finalize lands in the right month; `invoiceDate` is NOT used.
- Route gate `reports.view` (ctx `{ params: Promise.resolve({}) }`).

## Acceptance

- `/reports` shows Sales; `/reports/sales` renders + exports. Targeted tests green (`npx vitest run tests/reports-sales.test.ts`); tsc + eslint clean. Controller runs full suite + build + E2E after handoff (do NOT run them yourself).

## House rules

Client components must not import `src/server/**`. Route-handler tests pass ctx. `deletedAt: null`; read the FROZEN snapshot, never live-join. Reads never mutate. Commit small units, conventional messages, **no attribution trailer**. Write `docs/execution/2026-08-14-phase-8a/task-4-report.md` and update the Task 4 ledger row — **show a RED transcript** for the surcharge/ex-tax/reconciliation tests (the report contract wants RED-then-GREEN evidence). Report back concisely. No PR/merge.
