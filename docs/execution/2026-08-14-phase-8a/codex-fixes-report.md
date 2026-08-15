# Phase 8A — Codex PR-review fixes (PR #106)

Date: 2026-08-14. Branch: `phase-8a-reports-scoreboard`. Five Codex P2 findings, all legitimate;
several were the same pattern cloned across the report screens, so each is fixed consistently in
every affected screen. Small commit per finding, no attribution trailer. `tsc`/`eslint` clean;
the seven report test files pass (102 tests). Full `npm test`/`build`/E2E left to the controller.

Report screens touched: `erp/src/app/reports/{backlog/BacklogReport,shipped/ShippedReport,
turnaround/TurnaroundReport,sales/SalesReport,payments/PaymentsReport,scoreboard/Scoreboard}.tsx`
and `erp/src/app/reports/ReportsIndex.tsx`. New shared client-safe UI: `erp/src/lib/report-ui.tsx`
(`GateNotice` for finding 2, `ExportLink` for finding 5).

---

## Finding 1 — Consistent snapshot for the scoreboard's three reads
Codex `comment_id`: **3788228597** — `scoreboard.ts:122`

**Fix.** `reportScoreboard` issued the orders-count, shipped, and invoice reads as three separate
autocommit queries that could observe different DB states. Wrapped all three in ONE read-only
`RepeatableRead` transaction (`prisma.$transaction(fn, { isolationLevel: RepeatableRead })`, the
`aging.ts` `agingReport` precedent). To thread the tx through the delegated shipped read, gave
`reportShipped` an optional `db: Prisma.TransactionClient = prisma` param and switched its one
`prisma.shipperLine.findMany` to `db.shipperLine.findMany`; the standalone Shipped report still calls
`reportShipped(filter)` unchanged. Malformed-date parsing stays BEFORE the transaction (still a
field-anchored 400). Changed the scoreboard's `import type { Prisma }` to a value import for
`Prisma.TransactionIsolationLevel.RepeatableRead`. Still a pure read: no claim, no audit, not
Serializable.

- Files: `erp/src/server/reports/scoreboard.ts`, `erp/src/server/reports/shipped.ts`.
- Test added: `erp/tests/reports-shipped.test.ts` — "reads through a passed tx client and returns the
  SAME result as the autocommit read" (runs `reportShipped(filter, tx)` inside `prisma.$transaction`
  and asserts it equals the autocommit call). The existing end-to-end `reportScoreboard` tests now
  exercise the transaction wrapper.
- Commit: `77af36f`.

## Finding 2 — Surface permission-fetch failure BEFORE the gate
Codex `comment_id`: **3788228601** — `ReportsIndex.tsx:35` + every report screen

**Fix.** When `/api/auth/me` failed, `permissions` stayed `undefined`, so `gate()` returned
`allowed:false` and every screen rendered "Requires reports.view" — misreporting a transient failure
as an authorization denial and hiding the retryable error banner behind that early return. Introduced
a shared `GateNotice` (`erp/src/lib/report-ui.tsx`) that renders three DISTINCT states, and reordered
each screen's early return to `if (permsError || perms === undefined || !viewGate.allowed)`:
- `permsError` set → retryable red error banner (NOT a denial);
- `perms === undefined` → "Loading…" (initial in-flight state);
- otherwise → the permission "why" message (genuine denial).
The screen's own chrome (back-link + heading) is passed as `header`. The main-body banner no longer
folds in `permsError` (it can only be null past the gate). `AgingReport.tsx` (Phase 5) left untouched
per the brief; the new ordering matches its clearly-correct intent.

- Files: `ReportsIndex.tsx` + all six report screens + new `report-ui.tsx`.
- Commit: `9b1014e`.

## Finding 3 — Separate option-fetch errors from report errors
Codex `comment_id`: **3788228605** — `SalesReport.tsx:92` + every customer/part report screen

**Fix.** The report request and the customer/part-options request shared one `error` state, so a
report success (`setError(null)`) erased an options-fetch failure — leaving an enabled dropdown with
only "All …" and no explanation. Added a separate `optionsError` state; the option-fetch `.catch`
handlers now call `setOptionsError` instead of `setError`; the banner shows `error ?? optionsError`.
The report `load()` still only clears its own `error`.

- Files: `BacklogReport`, `ShippedReport`, `TurnaroundReport` (customer + part), `SalesReport`,
  `PaymentsReport` (customer). Scoreboard has no options — unaffected.
- Commit: `d8a0d67`.

## Finding 4 — Load inactive master data into filter options
Codex `comment_id`: **3788228607** — `BacklogReport.tsx:106` + every report screen with customer/part filters

**Fix.** The option fetches omitted `includeInactive`, but `listCustomers`/`listParts` default to
`active: true` — so an inactive-but-LIVE customer/part whose historical shipments/invoices/payments
still appear in a report could not be selected in its filter. Added `?includeInactive=1` to every
report filter-option fetch. Verified both list routes honor the param
(`src/app/api/customers/route.ts`, `src/app/api/parts/route.ts` pass `includeInactive` through to the
services, which drop the `active: true` filter while keeping `deletedAt: null` — the same flag the
customer/part admin pages already use). Live rows only; soft-deleted stay excluded.

- Files: `BacklogReport`, `ShippedReport`, `TurnaroundReport` (customers + parts), `SalesReport`,
  `PaymentsReport` (customers).
- Commit: `1449f04`.

## Finding 5 — Keep the export link aligned with the displayed table
Codex `comment_id`: **3788228610** — `BacklogReport.tsx:86` + every report screen

**Fix.** Changing a filter updated `query` (and the export href) immediately, but the table kept
showing the previous result until the new fetch resolved — so during a slow/failed load the export
used new filters against on-screen old data, breaking the screen==export guarantee. Each screen now
tracks `appliedQuery` (the query string of the currently-DISPLAYED result, set on a successful load),
and the export link is built from THAT via a shared `ExportLink` — which renders an inert `<span>`
(not a clickable link) while `!upToDate` (`loaded && appliedQuery === query`), i.e. while the table
is stale or nothing has loaded yet. The table container is dimmed (`opacity-60`) and an "Updating…"
hint shows while stale. On a FAILED reload the export stays pinned to the old (still-displayed) data
and the error banner shows — export and table never disagree.

- Files: all six report screens + the scoreboard + new `ExportLink` in `report-ui.tsx`.
- E2E note: the export control is a real `<a role=link>` once loaded, so `reports.mjs`'s
  `getByRole("link", { name: "Export to Excel" })` still resolves; it is only inert during the brief
  stale window, which Playwright auto-waits through.
- Commit: `cf93e74`.

## Finding 6 — Require a SUCCESSFUL load before enabling Export (regression in fix 5)
Codex `comment_id`: **3788330346** — `BacklogReport.tsx:151` + every report screen (re-review of pushed commit `1d6ee76`)

**Fix.** Fix 5 initialized `appliedQuery` to `""`, which equals the default empty `query`, and a
FAILED initial request still sets `loaded=true` — so `upToDate = loaded && appliedQuery === query`
went true after a failed first load, enabling Export on an empty result that never loaded. Introduced
a pure, client-safe, unit-tested helper `erp/src/lib/report-export-state.ts` — `exportState(appliedQuery,
currentQuery)` → `{ exportable, showingStale }` — and initialized `appliedQuery` to the distinct
sentinel `null` (set to `query` ONLY on a successful load, never on failure). `exportable` is
`appliedQuery !== null` (never true until the first success), and `showingStale` is
`exportable && appliedQuery !== currentQuery`. Every screen now derives its Export-readiness and
stale flags from this one helper instead of the inline `upToDate`; `ExportLink`'s `query` prop widened
to `string | null` and it renders inert when `query === null`. Behavior: Export stays inert until the
first successful load; a failed/slow reload keeps it pinned to the last successfully-loaded query
(table dimmed) — screen==export still holds; a never-succeeded screen is inert.

- Files: `erp/src/lib/report-export-state.ts` (new), `erp/src/lib/report-ui.tsx` (`ExportLink`), all
  six export-bearing screens (backlog, shipped, turnaround, sales, payments, scoreboard). ReportsIndex
  has no export — unaffected.
- Test added: `erp/tests/reports-export-state.test.ts` — 3 cases, incl. the **failed-initial-load**
  case (`exportState(null, …)` → `exportable: false`), the matched-success case, and the
  stale-reload-stays-exportable case.
- Commit: `fe7f94d`.

---

## Docs
`CLAUDE.md` reports paragraph amended to note a report MAY wrap several must-agree reads in ONE
read-only `RepeatableRead` transaction (the scoreboard/`agingReport` precedent) — still a pure read,
still not Serializable — so the scoreboard's `$transaction` is not misread as a violation of
"reports are pure reads." HANDOFF §4 / spec §15 merge-state left for the controller.

## Gates run here
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` (report scope) — clean.
- `npx vitest run` on all seven `tests/reports-*.test.ts` — 102 passed.
- Not run (controller owns): full `npm test`, `npm run build`, `npm run test:e2e`.

## Environment note
Docker was inactive at session start (the known "disabled at boot" issue; `sudo systemctl start
docker` needs an interactive password a subagent can't supply). Brought up an equivalent Postgres 18
via **rootless Podman** (`podman run --name erp-db … -p 127.0.0.1:5432:5432 -v ./db-init:…:z
docker.io/library/postgres:18`), applied `migrate deploy` to both `erp` and `erp_test`, and ran the
tests against it. The container is left running as `erp-db`; the controller may `podman rm -f erp-db`
and start the real Docker stack for the full gates/E2E.
