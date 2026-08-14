# Reports platform (Phase 8A)

8A is a **reporting platform**, not five bespoke pages. Every report is the same five parts,
cloned from the canonical live example, **A/R aging** (`src/server/aging.ts` +
`src/app/api/receivables/aging/*` + `src/app/receivables/aging/*`). A report is a **pure read**:
no row claim, no audit, no Serializable (spec §11). Money stays in integer cents inside the core
and is humanized (dates via `formatDateOnly`, enums to labels) before the rows leave the service.
Every `where` carries `deletedAt: null` and excludes voided/discarded rows — the safe default.
(The `includeVoided` toggle is intentionally **deferred** for 8A: default-exclude only, no param, no
UI.)

## The five parts (clone these for report `<name>`)

1. **Service** — `src/server/reports/<name>.ts`. A **pure aggregation core** (no Prisma, no I/O,
   unit-testable in isolation — the `bucketAging` precedent) plus a thin Prisma wrapper
   `report<Name>(filter)` that reads and calls the core.
2. **Filter parse** — `src/app/api/reports/<name>/query.ts`. ONE parser imported by BOTH routes
   below (the `receivables/aging/query.ts` single-parse discipline: `orUndefined`, let the service
   own malformed-date 400s), so the table and the Excel file can never disagree about a query
   string.
3. **JSON route** — `src/app/api/reports/<name>/route.ts`:
   `mustCan(requireUser(), "reports", "view"); return NextResponse.json(await report<Name>(parse(url)))`.
4. **Export route** — `src/app/api/reports/<name>/export/route.ts`. Same `mustCan` + same parse,
   then `toXlsx(sheet, columns, rows)` (`src/server/excel.ts`), the xlsx content-type and
   `attachment; filename` header (the `receivables/aging/export/route.ts` template). **Inline the
   columns per export route** — the house default; do not over-abstract into a shared column map on
   the first report.
5. **UI** — `src/app/reports/<name>/{page.tsx, <Name>Report.tsx}`. `page.tsx` is a trivial wrapper;
   `<Name>Report.tsx` is a **client** component (`"use client"`, no `src/server/**` import — mirror
   the row type locally) against the guarded API, filters in React state, ONE query string reused
   for the JSON fetch AND the `<a href=".../export?query">Export to Excel</a>` link, date inputs
   `type=date`. A **numeric table — no charts** (§3 dashboard-graphs non-goal). Then register the
   report in `src/lib/report-registry.ts` so it appears on the `/reports` index.

## Scaffold already in place (Task 0)

- **`/reports` index** — `src/app/reports/{page.tsx, ReportsIndex.tsx}` renders the registry,
  gated on `reports.view`.
- **Index API** — `src/app/api/reports/route.ts` (`GET /api/reports`) returns the registry entries
  the actor may open, per-entry area-filtered.
- **Registry** — `src/lib/report-registry.ts` (client-safe `ReportEntry` + `REPORTS`).
- **Indexes** — `Invoice.finalizedAt` and `Payment.receivedDate`
  (migration `20260814115050_reports_indexes`) back the Sales and Payments-received range scans.
