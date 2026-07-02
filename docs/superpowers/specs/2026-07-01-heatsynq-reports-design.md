# HeatSynQ Plan 9 — Reports (design)

Date: 2026-07-01
Status: approved in brainstorming (shape/coverage/clock/roles user-ruled; design approved)
Reference: `docs/superpowers/reference/2026-06-30-heatsynq-grounded-reference.md` (Reports §5.1/§5.2 line 328, ReportGroup §2 line 218)
Prototype ground truth: `Visual Shop.dc.html` lines 353–368 (markup) + 1095–1100 (`reportGroups` data) — verified first-hand.
Prior specs: Plan 5 `2026-07-01-heatsynq-shop-floor-equipment-design.md` (pure read projection), Plan 6 `2026-07-01-heatsynq-schedule-design.md` (DEMO_NOW), Plan 8 `2026-07-01-heatsynq-equipment-maintenance-design.md` (per-page DEMO_NOW adoption).

## 1. Overview

Plan 9 retires the `/reports` placeholder with the prototype's **report catalog** — a 2-column grid of 4
group cards (Sales ☷ · Accounts Receivable $ · Production & Tracking ◉ · Quotes ☷), each listing 4 report
names — plus what the prototype only gestures at: every one of the 16 names becomes a **live drill-down
report** at `/reports/<key>`, derived **entirely at read** from existing repos at `asOf = DEMO_NOW`.

No new entity, no repo collection, no writes, no permission, **no seed changes** (badge stays `q3-o9-c3`;
every existing pinned count holds). The prototype's `ReportGroup` is static config (like `NavItem`), and
that is exactly how it is built. The plan also completes the **full DEMO_NOW clock migration**: the four
remaining wall-clock pages and the three wall-clock mutation hooks switch to the frozen clock, fixing the
already-visible bug where Today's "Invoiced MTD" renders $0 because the real date rolled past June.

User rulings (brainstorming):
1. **Shape:** catalog + drill-down routes (`/reports` catalog faithful to prototype; each item links to
   `/reports/<key>`). Sidebar already prefix-highlights `/reports/*`; zero nav changes.
2. **Coverage:** all 16 canon report names go live, thin — one shared config-driven report view; each
   report = KPI strip + one table. No dead links, no muted rows.
3. **Clock:** full migration — read-side `asOf` **and** write-side stamps move to `DEMO_NOW`. Topbar keeps
   the machine date (the one intentional wall-clock).
4. **Roles:** ungated, identical for every role. No `view_reports` permission invented; `useCan` untouched.

Honesty rules for this slice:
- **No invented metrics** — the 16 report names are prototype canon; each renders only what existing data
  honestly supports, with explicit framing where the name promises more than the data holds
  (Equipment Utilization = current-state snapshot; On-Time Delivery = open orders vs due, the same meaning
  as the existing manager "On-Time %" tile).
- **No time series / trends / sparklines** — the seed has no honest history (all `trackedInAt/OutAt` are
  the same instant; `createdAt` is frozen). Single-window aggregates only.
- **No WO-status ↔ invoice joins** — invoices aggregate on their own statuses/dates, so the known
  `inv-summit-48120` seed quirk (to_bill invoices whose WOs never shipped) never surfaces as a wrong join.
- Empty is a result: Past-Due Detail and Reject Report render honest empty states over real derivations.

## 2. Decision table

| Decision | Ruling |
|---|---|
| Data home | Pure read projection (Plan-5 pattern). Catalog config + all math in `lib/logic/reports*.ts`; no entity, no repo, no writes, no "report config" storage (YAGNI, user-flagged). |
| Report identity | `ReportKey` string-literal union of 16 kebab keys; registry `REPORTS: Record<ReportKey, ReportDef>`; groups `REPORT_GROUPS` (4 × 4, canon icons `☷ $ ◉ ☷`, canon titles, canon item order). |
| Descriptor shape | `ReportDef.build(data: ReportData, asOf: string) → { kpis: KpiDescriptor[]; table: { columns: string[]; rows: ReportCell[][] } }` — logic stays JSX-free; one generic renderer maps cell kinds to the existing vocabulary. `KpiDescriptor` reused from `dashboard.ts`. |
| Cell kinds | `text` · `mono` · `date` (ISO → `formatDate`) · `money` (cents → `formatMoney`) · `pct` (pre-formatted string, mono) · `pill` (`{label, tone}` → `StatusPill`) · `progress` (`pct` → canonical two-div bar). |
| Data bundle | `ReportData = { quotes, orders, invoices, customers, equipment }` — the only collections any of the 16 reports read. Certifications/maintenance/scheduleBlocks are NOT needed (no cert/pyrometry/schedule report exists in the canon 16). |
| Routes | `app/(app)/reports/page.tsx` (catalog) + `app/(app)/reports/[reportKey]/page.tsx` (generic report view; client pages per house convention). Unknown key → `EmptyState` "No such report" + back link (no `notFound()` — matches in-app unknown-id handling). |
| MTD window | "MTD" = same UTC calendar month as `asOf`. `dashboard.ts`'s private `sameMonth` is **exported** and reused (no duplicate implementation). |
| Presentation | Existing tokens/components only: `KpiTile`, `ListCard`, `StatusPill`, `MonoId`, `DetailHeader`, `EmptyState`, mono numbers. **No chart library** (confirmed absent; stays absent). Only quantitative visuals: KPI tiles, table money columns, the two-div progress bar (WIP rows), aging mini-cards precedent. |
| Roles/permissions | View ungated for all roles (house rule: views ungated, actions gated; this slice has no actions). |
| Clock | Reports pass `DEMO_NOW`; every report shows "As of Jun 30, 2026". Full migration of remaining wall-clock call sites (§7). |
| Seed | Untouched. All 16 reports derive presentable truth from the existing seed (verified — §6 appendix). |

## 3. Out of scope (carry-forwards)

- Report filters, date-range pickers, export/print, saved views, scheduling/email.
- Time-series and trend visuals (no honest source until a real history/event log lands — Plan-4/8 carry-forward).
- Cash-receipt/payment-application entity (Cash Receipts reads `paidDate` off invoices; receipt records deferred with period-close semantics, reference Q16).
- Shipped-delivery-history OTD (needs WO ship timestamps / partial shipments; On-Time Delivery ships with open-order framing + explicit note).
- The `inv-summit-48120` / `inv-midwest-48177` seed quirk (unchanged; still deferred to partial shipments).
- `/setup` (the last placeholder), backend atomicity ledger (this plan adds zero multi-aggregate writes — zero writes at all).
- Nav badge for Reports (prototype shows none).

## 4. Pure logic

New files (each with sibling `.test.ts`):

- `lib/logic/reports.ts` — `ReportKey`, `ReportCell`, `ReportTable`, `ReportResult`, `ReportData`,
  `ReportDef` types; `REPORT_GROUPS` catalog config; `REPORTS` registry assembling the four group modules;
  shared helpers `ageDays(dateIso, asOf)` (UTC floor-day difference in whole days) and any tiny shared
  formatters. One-decimal percentage convention matches `onSchedulePct` ("66.7").
- `lib/logic/reports-sales.ts` — Sales by Customer, Sales by Process, Sales Summary, Bookings vs. Shipments.
- `lib/logic/reports-ar.ts` — A/R Aging, Customer Statements, Cash Receipts, Past-Due Detail.
- `lib/logic/reports-production.ts` — Equipment Utilization, On-Time Delivery, Reject Report, Work-in-Process.
- `lib/logic/reports-quotes.ts` — Quotes Dashboard, Win / Loss, Quote Aging, Quoted vs. Won.

Change to existing logic: `lib/logic/dashboard.ts` exports its private `sameMonth(iso, asOf)`. Builders
compose existing exports wherever they exist (`ageInvoices`, `customerBalanceCents`, `customerAging`,
`daysPastDue`, `openOrders`, `lateOrders`, `isLate`, `onSchedulePct`, `openQuotes`,
`awaitingApprovalCount`, `openQuoteValueCents`, `quoteTotalCents`, `equipmentLoads`, `shopFloorSummary`,
`netDaysByCustomer`, `parseNetDays`) — no aggregate is re-implemented.

Percentage/ratio edge rules: win rate = won/(won+lost); conversion = won MTD ÷ quoted MTD; book-to-ship =
shipped MTD ÷ booked MTD; utilization = running ÷ (total − outOfService). All ×100, one decimal; render
`"—"` when the denominator is 0.

## 5. The 16 reports — exact definitions

Every report: `DetailHeader` (back to Reports) + KPI strip + one `ListCard` table + uniform
"As of Jun 30, 2026" line; `framing` note where flagged; `empty` copy shown as `EmptyState` when the table
has no rows (KPI strip still renders — zeros are honest).

### Sales (icon ☷)

**sales-by-customer — "Sales by Customer"**
Rows: customers having ≥1 invoice (any status) or ≥1 open (non-shipped) WO; sort invoiced desc, then open
value desc, then name asc. Columns: CUSTOMER · INVOICED (sum sent+paid `amountCents`) · OPEN ORDER VALUE
(sum open WO `orderValueCents`) · OPEN A/R (`customerBalanceCents`).
KPIs: Invoiced total $19,500 · Open order value $27,390 · Customers (row count) 7.

**sales-by-process — "Sales by Process"**
Rows: group all WOs' `pricing[]` lines by `process`; sort booked desc. Columns: PROCESS · BOOKED (sum
`amountCents`) · ORDERS (count of distinct WOs with that line). Negative-amount lines (Discount rows from
`createOrderFromQuote`) roll up as their own row, honest and last by sort.
KPIs: Booked total $27,390 · Processes 8. Seed rows: Carburize $11,180/3 · Neutral harden $4,180/1 ·
Vacuum harden $3,120/1 · Carbonitride $2,910/1 · Nitride $2,880/1 · Temper $2,080/2 · Certification $800/1 ·
Anneal $240/1.

**sales-summary — "Sales Summary"**
Fixed rows (DOCUMENT · STATUS · COUNT · VALUE): Quotes open 3 $12,560 · Quotes won 2 $3,740 · Quotes lost 1
$11,736 · Work orders open 9 $27,390 · Work orders shipped 0 $0 · Invoices to bill 2 $7,090 · Invoices sent
1 $6,740 · Invoices paid 2 $12,760. (Quote values = computed `quoteTotalCents`.)
KPIs: Quoted (open) $12,560 · Won $3,740 · Booked (open WOs) $27,390 · Invoiced (sent+paid) $19,500 ·
Collected (paid) $12,760.

**bookings-vs-shipments — "Bookings vs. Shipments"**
MTD windows on `asOf`. Bookings = WOs by `orderedDate`; shipments = invoices by `shippedDate` (invoices are
the shipping ledger — no WO-status join). Rows: per customer with either value > 0; sort booked desc.
Columns: CUSTOMER · BOOKED · SHIPPED.
KPIs: Booked MTD $27,390 · Shipped MTD $26,590 · Book-to-ship 97.1%.

### Accounts Receivable (icon $)

**ar-aging — "A/R Aging"**
KPIs: the 5 buckets from `ageInvoices` (Current $6,740 · 1–30 $0 · 31–60 $0 · 61–90 $0 · 90+ $0), A/R-page
mini-card meaning, KpiTile rendering. Rows: per **sent** invoice, sort `invoicedDate` asc. Columns:
INVOICE · CUSTOMER · AMOUNT · INVOICED · BUCKET (pill: current/neutral, else warn; 61+ danger). Seed: 1 row
(INV-30412 · Delta · $6,740 · Jun 27 · Current).

**customer-statements — "Customer Statements"**
Rows: customers with ≥1 `sent` or `to_bill` invoice; sort balance desc, then unbilled desc. Columns:
CUSTOMER · OPEN INVOICES (sent count) · BALANCE (sent $) · UNBILLED (to_bill $) · TERMS.
KPIs: Open balance $6,740 · Unbilled $7,090 · Customers 3. Seed rows: Delta 1/$6,740/$0/Net 30 ·
Summit 0/$0/$4,180/Net 30 · Midwest 0/$0/$2,910/Net 30.

**cash-receipts — "Cash Receipts"**
Rows: `paid` invoices, sort `paidDate` desc. Columns: INVOICE · CUSTOMER · AMOUNT · PAID.
KPIs: Receipts MTD $12,760 (paid `paidDate` in `asOf` month) · Receipts 2. Seed: INV-30408 $11,200 Jun 29 ·
INV-30401 $1,560 Jun 25.

**past-due-detail — "Past-Due Detail"**
Rows: sent invoices with `daysPastDue > 0` at `asOf`; sort days past due desc. Columns: INVOICE · CUSTOMER ·
AMOUNT · DUE (`invoicedDate ?? shippedDate` + net days) · DAYS PAST DUE.
KPIs: Past due $0 · Invoices 0 · Oldest —. Seed: **honest empty**; `empty`: "Nothing past due as of
Jun 30, 2026."

### Production & Tracking (icon ◉)

**equipment-utilization — "Equipment Utilization"**
`framing`: "Current equipment state — utilization history isn't tracked yet."
Rows: `equipmentLoads(orders, equipment, asOf)` in roster order. Columns: EQUIPMENT · KIND
(`equipmentKindMeta` label) · STATE (pill via `equipmentStateMeta`) · WORK ORDER (mono, or —) · CUSTOMER.
KPIs from `shopFloorSummary` + roster: Running · Idle · Out of service · Utilization % = running ÷ (total −
outOfService). (Seed values pinned by TDD from the seed projection; out of service = 2.)

**on-time-delivery — "On-Time Delivery"**
`framing`: "Open orders against due date — shipped-delivery history isn't tracked yet."
Rows: open (non-shipped) WOs, sort due asc. Columns: WORK ORDER · CUSTOMER · DUE · STATUS (pill,
`orderStatusMeta`) · LATE (danger pill when `isLate`, else —).
KPIs: On-time % 66.7 (`onSchedulePct`) · Open 9 · Late 3.

**reject-report — "Reject Report"**
Rows: across all WOs, steps with `inspectResult === "fail"`; sort WO number asc. Columns: WORK ORDER ·
CUSTOMER · STEP (op) · OPERATOR (initials) · RESULT (danger pill "Fail").
KPIs: Inspect failures 0 · Steps inspected 0 (steps with non-null `inspectResult`). Seed: **honest empty**
(all seed `inspectResult` are null); `empty`: "No inspection failures recorded." Runtime inspect-fails
(Plan-4 flow) appear here honestly.

**work-in-process — "Work-in-Process"**
Rows: WOs with status `in_process` or `on_hold` (on the floor), sort due asc. Columns: WORK ORDER ·
CUSTOMER · PROCESS (`processSummary`) · DUE · PROGRESS (progress cell, `progressPct`) · VALUE.
KPIs: WIP orders 5 · WIP value $17,970 · Late in WIP 2.

### Quotes (icon ☷)

**quotes-dashboard — "Quotes Dashboard"**
Rows: open quotes (`draft/sent/approve`), sort date desc. Columns: QUOTE · CUSTOMER · DATE · VALID UNTIL ·
VALUE (computed) · STATUS (pill, `quoteStatusMeta`).
KPIs: Open quotes 3 · Open value $12,560 · Awaiting approval 1.

**win-loss — "Win / Loss"**
Rows: decided quotes (`won`/`lost`), sort date desc. Columns: QUOTE · CUSTOMER · DATE · VALUE · STATUS
(pill). KPIs: Won 2 · Lost 1 · Win rate 66.7% · Won value $3,740.

**quote-aging — "Quote Aging"**
Rows: open quotes, sort age desc. Columns: QUOTE · CUSTOMER · STATUS (pill) · DATE · AGE (mono, `Nd`,
`ageDays(quote.date, asOf)`) · VALUE. KPIs: Open 3 · Avg age 8d (whole days, rounded) · Oldest 18d.
Seed ages: Q-2835 18d · Q-2840 6d · Q-2841 0d.

**quoted-vs-won — "Quoted vs. Won"**
MTD window on `quote.date`. Rows: per customer with quoted MTD > 0 or won MTD > 0; sort quoted desc.
Columns: CUSTOMER · QUOTED (all quotes dated in window) · WON (won quotes dated in window).
KPIs: Quoted MTD $25,996 · Won MTD $1,700 · Conversion 6.5%. (Q-2828 is May-dated: excluded — honest.)

## 6. Seed expectations appendix (pin-in-tests)

At `asOf = DEMO_NOW` (2026-06-30T12:00Z), over the untouched seed: invoiced (sent+paid) $19,500 · collected
$12,760 · unbilled $7,090 · open A/R $6,740 all-current · booked MTD $27,390 (9 WOs, all June) · shipped MTD
$26,590 (5 invoice `shippedDate`s) · open quotes 3/$12,560 · decided 2W/1L, won $3,740, lost $11,736 ·
quoted MTD $25,996, won MTD $1,700 · WIP 5/$17,970, late-in-WIP 2 · open 9, late 3 (WO-48190/48142/48120),
on-time 66.7 · process rollup as §5 · quote ages 0/6/18d · past due none · rejects none · equipment: 10
units, out of service 2 (eq-temper-2 down, eq-vac-1 maintenance); running/idle pinned at implementation
from `shopFloorSummary(equipmentLoads(seedOrders, seedEquipment, DEMO_NOW))`.

## 7. Clock migration (full — every call site mapped)

Switch to `DEMO_NOW` (import from `@/lib/clock`, existing page precedent):

| # | Site | Today | Becomes |
|---|---|---|---|
| 1 | `app/(app)/today/page.tsx:33` `asOf` | `new Date()` | `DEMO_NOW` — fixes live $0 Invoiced-MTD bug → $19,500; pins Late 3 / On-time 66.7 |
| 2 | `app/(app)/tracking/page.tsx:23` `asOf` | `new Date()` | `DEMO_NOW` — pins 3 LATE cards |
| 3 | `app/(app)/ar/page.tsx:19` `asOf` | `new Date()` | `DEMO_NOW` — pins aging all-current |
| 4 | `app/(app)/invoicing/page.tsx:23` bill/pay `at` | `new Date()` | `DEMO_NOW` — billed invoice gets `invoicedDate` 06-30, stays in June windows |
| 5 | `app/(app)/orders/[id]/page.tsx:40` ship/hold/resume `at` | `new Date()` | `DEMO_NOW` |
| 6 | `app/(app)/quotes/new/page.tsx:30` `todayIso` | `new Date()` | `DEMO_NOW` — quote date 06-30, validUntil 07-30 |
| 7 | `app/(app)/quotes/[id]/page.tsx:78` `todayIso` (revise) | `new Date()` | `DEMO_NOW` |
| 8 | `lib/query/hooks.ts:144` `useWinQuote` `nowIso` arg | `new Date()` | `DEMO_NOW` — no-requiredBy quotes become due 06-30 (never late vs frozen clock) |
| 9 | `lib/query/hooks.ts:210` `useTrackInStep` `at` | `new Date()` | `DEMO_NOW` |
| 10 | `lib/query/hooks.ts:229` `useTrackOutStep` `at` | `new Date()` | `DEMO_NOW` |

Stays wall-clock (intentional): `components/shell/topbar.tsx:16` machine date. If implementation surfaces
another cosmetic time-of-day site (e.g. a greeting), it is topbar-class: allowed to stay wall-clock, listed
in the PR. **Verification invariant:** after migration, `new Date(` in `app/` + `components/` + `lib/`
(tests excluded) matches only topbar-class sites.

## 8. Screens

**Catalog — `app/(app)/reports/page.tsx` + `components/reports/report-catalog.tsx`.** `PageHeader`
title "Reports", subtitle "Every report, grouped — no menu hunting." (canon copy). `grid gap-4
sm:grid-cols-2` of 4 cards (`rounded-card border border-border bg-surface p-4`): header = 32px icon chip
(`rounded-md bg-primary-tint text-primary`, the canon glyph as text) + group title (semibold); items =
rows separated by `border-t border-border-faint`, `Link` to `/reports/<key>`, label left + `→` right
(`text-text-faint`), hover `bg-canvas`. No data fetching — the catalog is static config. Testids:
`report-group-<groupKey>`, `report-link-<reportKey>`.

**Report view — `app/(app)/reports/[reportKey]/page.tsx` + `components/reports/report-view.tsx` +
`components/reports/report-table.tsx`.** Client page (params handling copied from
`shop-floor/[equipmentId]` — per AGENTS.md, read `node_modules/next/dist/docs/` before Next-specific
code). Resolves `REPORTS[reportKey]`; unknown → `EmptyState` "No such report" + back link. Fetches
`useQuotes/useWorkOrders/useInvoices/useCustomers/useEquipment` (react-query dedupes; loading →
`SkeletonRows`, any error → `ErrorPanel` with retry). Then `build(data, DEMO_NOW)` and render:
`DetailHeader` (backHref `/reports`, backLabel "Reports", title = canon name, subtitle = framing note when
present) · "As of Jun 30, 2026" line (`font-mono text-[11px] text-text-muted`, `formatDate(DEMO_NOW)`) ·
KPI strip (`KpiTile` grid, `data-testid="report-kpis"`) · table (`ListCard`, cells rendered by kind:
mono→`MonoId`/mono span, money→`formatMoney` mono, date→`formatDate` mono muted, pct→mono, pill→`StatusPill`,
progress→two-div bar; `data-testid="report-table"`) or `EmptyState` with the report's `empty` copy.

## 9. Testing

- **Unit (vitest):** per group module, builder tests over `buildSeed()` at `DEMO_NOW` pinning the §5/§6
  numbers, plus fabricated-data edges (empty collections → zero KPIs + empty rows; month-boundary windows;
  `—` denominators; discount-line rollup; unknown-key registry lookup). `reports.ts` tests: registry
  completeness (16 keys, 4×4 groups, canon titles/order), `ageDays` boundaries. `dashboard.ts` gains a
  `sameMonth` export test.
- **Component:** `report-catalog` renders 4 groups × 16 links with correct hrefs; `report-table` renders
  each cell kind (money formatting, pill tone, progress width); `report-view` empty-rows path shows
  `EmptyState` while KPI strip stays.
- **E2E (new `tests/e2e/reports.spec.ts`):**
  1. Happy path: `/reports` shows 4 group cards + 16 links → "A/R Aging" → `/reports/ar-aging` shows
     Current $6,740 and row INV-30412 → back via "Reports" → "Win / Loss" → Won 2 / Lost 1 / 66.7%.
  2. Clock: `/today` renders Invoiced MTD **$19,500** (deterministic post-migration proof).
- **Regression:** existing 7 e2e specs and vitest suite stay green; the quote-to-invoice spec now runs
  fully frozen (quote date/validUntil, traveler stamps, invoicedDate all 06-30 — deterministic by
  construction).
- Gate: `npm test` · `tsc --noEmit` · `eslint --max-warnings 0` · `build` · `test:e2e`.

## 10. Conventions checklist (locked)

UI depends only on async repo interfaces via Query hooks (report pages fan-in existing hooks; zero new repo
surface) · money integer cents, `formatMoney` at render · dates ISO midnight-UTC, `formatDate` at render ·
IBM Plex Mono for ids/numbers/pills/dates · exact tokens, no new colors · no new `any` (the two approved
mock-plumbing spots unchanged) · no version/concurrency concerns (zero writes) · permissions untouched ·
`viewAs` untouched (Today keeps its display-only preview; its `asOf` just freezes).
