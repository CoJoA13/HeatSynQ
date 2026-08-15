# Task 4 — Sales report (the careful one) — implementer report

**Branch:** `phase-8a-reports-scoreboard` (no PR/merge). **Spec §4.2 / §8 / §12 item 8.** Five-part
clone of the Backlog/Shipped/Turnaround reports, registered in `src/lib/report-registry.ts`.
**Commits:** `f15e9b3` (service + tests), `9e9b3c8` (API routes), `aa5d0c6` (UI + registry).

## Built

Invoiced revenue **excluding sales tax**, net of credits, recognized by **`finalizedAt`** over a
**half-open `[from, nextDay(to))`** window, read from the **frozen `Invoice`/`InvoiceLine`
snapshot** (never a live join to `Part`/`StepCode`). Filterable by finalized-date range + customer,
sliceable by customer / part / finalized-month, with a net-revenue-and-document-count summary and an
Excel export. `buildSales` is the pure aggregation core; `reportSales` is the thin Prisma wrapper.

## Files

- `erp/src/server/reports/sales.ts` — `buildSales` (pure core) + `reportSales` (Prisma wrapper).
- `erp/src/app/api/reports/sales/query.ts` — the one shared `parseSalesFilter`.
- `erp/src/app/api/reports/sales/route.ts` — `GET /api/reports/sales` (`reports.view`).
- `erp/src/app/api/reports/sales/export/route.ts` — `GET .../export` → xlsx (`Sales.xlsx`).
- `erp/src/app/reports/sales/page.tsx` + `SalesReport.tsx` — client screen (ShippedReport clone).
- `erp/src/lib/report-registry.ts` — added the `sales` entry.
- `erp/tests/reports-sales.test.ts` — 17 tests (pure core, DB frozen-snapshot, ex-tax, surcharge/
  "(no part)", credit-net, finalizedAt half-open boundary, population, the GL reconciliation, route
  gates, export attachment).

## SURCHARGE handling (REVIEW FOCUS #1) — exactly what I did

The trap the plan flagged: `pricing.ts`'s `blank("SURCHARGE")` gives a SURCHARGE line **real
revenue and a blank `partNumber`**. A naive "sum the part lines" reading drops it, undercounting
sales and breaking the GL reconciliation.

- **It is summed.** The core sums **all non-`TAX`** lines — `const revenue = lines.filter(l =>
  l.lineKind !== "TAX")` — so OPERATION + SURCHARGE + FREIGHT + CHARGE + CERT all count (the `PART`
  header is `amount = 0`, harmless). TAX is the one kind excluded (revenue is ex-tax, §4.2). I did
  **not** filter on `partNumber`, which is the exact way a surcharge would get dropped.
- **In the by-part cut it lands in one explicit "(no part)" bucket.** `groupKey(..., "part")` keys a
  part-bearing line by `customerId + " " + partNumber` (parts are **customer-scoped** — the
  `buildShipped` precedent; two customers sharing a number mean different parts) and routes **every**
  blank-`partNumber` line to a single `NO_PART = "(no part)"` bucket. A cuid customerId never equals
  `"(no part)"`, so a real part key can never collide with it. The surcharge is **never re-joined**
  to the part it surcharges — the frozen snapshot carries no part identity on it, so there is nothing
  to join to. Because the "(no part)" bucket catches exactly the lines the part keys don't, the
  **part-sliced total equals the unsliced total** (asserted in both a pure test and a DB test).
- **Credits net automatically.** A CREDIT copies its source lines with the money sign flipped
  (`invoices.ts` `negateMoney`), so its line `amount`s are stored **negative**. Summing every line
  therefore gives `Σ invoice non-tax lines − Σ credit non-tax lines` with no `kind`-branch — the DB
  credit-net test pins it (100 invoice − 30 credit = 70).

## The GL reconciliation identity (REVIEW FOCUS #2) — the fixture and why it holds

**Test:** `reportSales — reconciles to the GL export revenue accounts`.

**Fixture — a clean, fully-GL-mapped month with no prior `GlPosting`** (so the export delta = the
full journal). Seeded directly (the `gl-export.test.ts` factory shape), all finalized in **July
2026**:

- **Invoice A** (customer X): `OPERATION 100` on the revenue account + `SURCHARGE 15` on a second
  revenue account, no tax → `total 115`.
- **Invoice B** (customer Y, taxable): `OPERATION 200` on revenue + `TAX 16` on the tax account →
  `total 216`, `taxTotal 16`.
- **Credit C** (customer X): `OPERATION −30` on revenue → `total −30` (money negated, the production
  convention).

`BillingConfig` sets the A/R and sales-tax accounts; every non-TAX line carries a live
`glAccountId`, so `resolveReadiness` finds no gap and the export proceeds.

**The identity asserted:**

> Sales grand total (Σ all-non-tax finalized lines − credits) **==** Σ `exportClose()`'s
> **revenue-side postings** (every posting whose `glAccountId` is neither the A/R control account nor
> the sales-tax account).

- Sales grand total = `115 + 200 − 30 = 285` (the taxed invoice contributes only its `200` operation
  — tax excluded). `reportSales({from,to}).total` returns exactly `285`.
- I close July (`closePeriod(2026, 7)`) and `exportClose(period.id)`, then compute the revenue side
  as `Σ (credit − debit)` over postings with `glAccountId ∉ {arId, taxId}`. `salesJournal` credits
  revenue for an INVOICE and debits it for a CREDIT, so `(credit − debit)` is `+100 +15 +200 −30 =
  285` — which equals `sales.total`. The test also asserts the whole batch balances (`Σdebit =
  Σcredit`).

**Why it is a property of a clean month, not of the report:** the report needs **no** GL accounts —
it sums `line.amount` regardless. The reconciliation works because the export's revenue lines are
built from the **same** non-TAX invoice-line snapshots, grouped by `glAccountId`, that the report
sums by `partNumber`; both exclude TAX; and both net credits by sign. I deliberately did **not**
assert equality with the close roll-forward *gross* (which is tax-inclusive).

## RED-first evidence (the surcharge / ex-tax / reconciliation trio)

Tests were written first; the core's first cut was then the exact **naive reading the report
contract warns against** — `const revenue = lines` (TAX **not** excluded) and blank-`partNumber`
lines keyed as `""` instead of `"(no part)"`. Targeted run against that first cut (after fixing one
unrelated test-authoring slip — a `groupBy: "month"` that had been left off one `reportSales({})`
call):

```
 × buildSales — excludes sales tax (ex-tax) > drops the TAX line from the document revenue and the grand total
   → expected 108 to be 100 // Object.is equality
 × buildSales — SURCHARGE (real revenue, blank part) > includes the surcharge in the grand total and buckets it under '(no part)'
   → expected undefined to be defined            (the "(no part)" bucket did not exist)
 × buildSales — grouping > by part: parts are customer-scoped, and blank-part lines share one '(no part)' bucket
   → Cannot read properties of undefined (reading 'revenue')   (no "(no part)" row)
 × reportSales — the frozen snapshot > excludes the TAX line of a taxed invoice from the figure
   → expected 108 to be 100 // Object.is equality
 × reportSales — the frozen snapshot > includes a surcharge (blank part) and buckets it under '(no part)' in the by-part cut
   → Cannot read properties of undefined (reading 'revenue')
 × reportSales — reconciles to the GL export revenue accounts > Sales grand total (Σ non-tax − credits) == Σ revenue-side postings (excl. A/R and tax)
   → expected 301 to be 285 // Object.is equality           (301 = 285 + 16 tax)

 Test Files  1 failed (1)
      Tests  6 failed | 11 passed (17)
```

- **ex-tax** failed because the naive sum kept the TAX line (`108` not `100`; the DB case the same).
- **surcharge / "(no part)"** failed because blank-part lines were keyed `""`, so the `"(no part)"`
  row the test looks for did not exist.
- **reconciliation** failed on the headline number: the naive grand total `301` carried invoice B's
  `16` of tax, which the GL revenue side (tax on its own account, excluded) does not — the exact
  break the identity exists to catch.

The two-line fix — `lines.filter(l => l.lineKind !== "TAX")` and `key/label: "(no part)"` — turned
all six green:

```
 ✓ tests/reports-sales.test.ts (17 tests) 1232ms
 Test Files  1 passed (1)
      Tests  17 passed (17)
```

## Design calls worth the reviewer's eye

- **No `partId` filter (deliberate divergence from the Shipped UI).** A Sales report reads the frozen
  part-number snapshot; a live-part filter would need a live join to `Part` (the dropdown shows the
  *current* number), which the frozen-paper rule forbids — a renamed part would silently drop the
  sales it earned under its old number. Part is a **groupBy dimension only**; the filter set is
  customer + finalized-date range. Documented in `query.ts` and `SalesReport.tsx`.
- **`reportSales` never imports `invoices.ts`.** The document-number rule (credit number, else prefix
  + order number) is replicated as a 3-line local helper rather than imported, so this lean report
  never drags the invoice service's PDF/template graph into its bundle (the leaf-module discipline).
- **Ex-tax and "(no part)" live in the pure core**, not the wrapper, so both are unit-testable
  without a DB — the wrapper hands the core every line (TAX included) and the core owns the exclusion.

## Gates (implementer, targeted only — per brief)

- `npx vitest run tests/reports-sales.test.ts` → **17 passed** (watched to completion).
- `npx tsc --noEmit` → clean. `npx eslint` over all new/changed files → clean.
- Full `npm test` / `npm run build` / `npm run test:e2e` deferred to the controller per the brief (no
  dev-server startup by the implementer). No browser preview run (needs the dev server) — the UI is a
  ShippedReport clone; the controller / E2E confirm the render.
