# Task 7 — Comparison scoreboard: implementer report

**Branch:** `phase-8a-reports-scoreboard` · **Commits:** `49dad72` (service + presets + routes + tests), `e482350` (page + registry). No PR/merge.

## What was built

The Phase 8A parallel-run eyeball page (spec §4.3): one page, one `{from,to}` window, **three HeatSynQ figures** to eyeball against Visual Shop's own reports. A numeric table, no charts, pure read (no claim, no audit, no Serializable).

The three figures, each printing its basis on the page:

1. **Orders entered** — `prisma.order.count` by `Order.receivedDate` in the window, `deletedAt: null` (voided excluded).
2. **Shipped** — pounds & pieces, by **reusing `reportShipped`** for the same window and summing its rows (see below). Not re-derived.
3. **Invoiced $** — Σ `Invoice.total` for `status = FINALIZED`, `deletedAt: null`, by **`invoiceDate`** (owner ruling — the VS-eyeball basis, **not** `finalizedAt`), gross tax-inclusive, credits netted (a CREDIT `total` is stored negative → invoices / credits / net all fall out of one kind-split sum).

The invoiced window uses an **inclusive `lte`** because `invoiceDate` is `@db.Date` (UTC-midnight, no time-of-day) — deliberately *not* the Sales report's half-open `finalizedAt` window. The one window is applied verbatim to both `receivedDate` and `invoiceDate` (both `@db.Date`).

## Files

- `erp/src/server/reports/scoreboard.ts` — `buildScoreboard` (pure core: shipped summation in integer hundredths, invoiced kind-split in integer cents) + `reportScoreboard` (Prisma wrapper; delegates the shipped read to `reportShipped`).
- `erp/src/lib/scoreboard-presets.ts` — client-safe `thisWeekWindow` (Monday–Sunday ISO week) / `thisMonthWindow` (first–last calendar day), pure UTC date-only math. Imported by BOTH the screen and the test so a preset button and its assertion can never disagree.
- `erp/src/app/api/reports/scoreboard/query.ts` — `parseScoreboardFilter`, the single parse shared by both routes.
- `erp/src/app/api/reports/scoreboard/route.ts` — JSON, gated `reports.view`.
- `erp/src/app/api/reports/scoreboard/export/route.ts` — xlsx (`toXlsx`, `Scoreboard.xlsx`); one row per figure (metric · basis · value) with the window stamped into cell A1 as the caption.
- `erp/src/app/reports/scoreboard/{page.tsx,Scoreboard.tsx}` — the client screen; date inputs + This-week / This-month buttons + Export link (same query string as the fetch).
- `erp/src/lib/report-registry.ts` — `{ key: "scoreboard", label: "Comparison scoreboard", href: "/reports/scoreboard", area: "reports", … }`.
- `erp/tests/reports-scoreboard.test.ts` — 15 tests.

## How the shipped figure reuses the Shipped report

`reportScoreboard` calls `reportShipped({ from, to })` (default `groupBy: "none"`) for the **same** window and sums the returned rows — qty as integers, weight in integer hundredths to match `buildShipped`'s no-drift rule. Because it is the same call the Shipped report makes, the scoreboard's shipped number is by construction exactly what the Shipped report shows: voids excluded, reversals netted into their own shipDate window, released rows counted via snapshot — all inherited, nothing re-derived. The test proves the equality directly: it asserts `figures.shipped` equals both the known seeded totals (`qty 17`, `weight 7.75`, excluding a July shipment and a voided one) **and** `reportShipped(window)` summed the same way.

## RED transcript — the load-bearing invoiceDate basis

The invoiced figure is recognized by `invoiceDate`, not `finalizedAt`. To prove the test actually catches a naive `finalizedAt` copy (the Sales report's basis), the service's invoice `where` was temporarily flipped from `invoiceDate: window` to `finalizedAt: window` and the load-bearing test run. The seeded invoice is **dated August 15 but finalized July 20** — so a `finalizedAt` implementation misses it in the August window:

```
FAIL  tests/reports-scoreboard.test.ts > reportScoreboard — invoiced $ by invoiceDate (the load-bearing basis) > buckets by invoiceDate, NOT finalizedAt (a doc finalized in a different month counts by its invoiceDate)
AssertionError: expected +0 to be 1000 // Object.is equality

- Expected
+ Received

- 1000
+ 0

 ❯ tests/reports-scoreboard.test.ts:241:35
    239|     // August window sees it by invoiceDate…
    240|     const aug = await reportScoreboard({ from: "2026-08-01", to: "2026…
    241|     expect(aug.invoiced.invoices).toBe(1000);
       |                                   ^

 Test Files  1 failed (1)
      Tests  1 failed | 14 skipped (15)
```

The `finalizedAt` copy returns **0** for the August window (the doc was finalized in July) — exactly the bug the owner ruling guards against. Reverting the one word `finalizedAt` → `invoiceDate` turns it green. (The initial run of the whole file was also RED — `Cannot find module '@/server/reports/scoreboard'` — before the service existed.)

## Gates (targeted, per brief)

- `npx vitest run tests/reports-scoreboard.test.ts` → **15 passed** (watched to completion).
- `npx vitest run tests/reports-routes.test.ts tests/reports-scoreboard.test.ts` → **20 passed** (registry entry safe; the index test uses `toBeGreaterThan(0)`).
- `npx tsc --noEmit` → clean.
- `npx eslint src tests` → clean.

Full `npm test` / `npm run build` / E2E deferred to the controller per the brief (Task 7 is a real new page → the controller runs the full E2E). No browser preview (needs the dev server); the UI is a Sales/Shipped-report clone plus two preset buttons.

## Notes for the whole-branch review

- The scoreboard has **no part filter and no groupBy** — by design it is three window-scoped figures, so the "how reports slice by part" consolidation (PROGRESS.md tracked cleanup) does not touch it.
- `thisWeekWindow` is Monday–Sunday (ISO 8601). Defensible and test-pinned; flag if the owner wants Sunday–Saturday.
