# Task 6 — Home the invoice register + A/R aging under /reports

**Branch:** `phase-8a-reports-scoreboard` (no PR/merge). **Plan:** §"Task 6". **Spec §4.1** ("homing the two already-built reports"). **Pattern:** `src/lib/report-registry.ts` + `GET /api/reports`.

## Goal

Make the two already-built reports discoverable under `/reports` — **default: link, not relocate** (§12 item 7): the registry entries point at the existing pages; no rebuild.

## Deliverables

- Add two `ReportEntry`s to `src/lib/report-registry.ts`, each with its **source area** (so `GET /api/reports`'s per-entry `can(user, entry.area, "view")` filter gates them on where they actually live, NOT on `reports`):
  - **Invoice register** → the existing invoicing list. `href` = the invoicing list route; `area` = the invoicing area. (Verify the exact route + area key in `src/lib/nav.ts` / `src/lib/permission-constants.ts` — do not guess `invoicing` vs `invoices`.)
  - **A/R aging** → `/receivables/aging`; `area` = the receivables/AR area (verify the key).
- Descriptions per the entries (e.g. "Finalized invoices/credits by date." / "Open A/R balances as of a date.").

## Tests

- The `/reports` index (via `GET /api/reports`) shows both entries **for a user who holds the source area's view**, and **hides** the invoice register / aging entry for a user who has `reports.view` but NOT the source area's view — this is the **per-entry area-filter behavioral test the Task 0 reviewer noted was still missing** (Task 0 left `REPORTS` empty). Add it here now that cross-area entries exist.
- The links resolve to the existing pages (a light assertion; the pages themselves are already tested).

## Acceptance

- `/reports` lists all five new reports + the invoice register + aging, each correctly permission-gated. Targeted test green (`npx vitest run tests/reports-routes.test.ts` — extend the existing file, or a new one); tsc + eslint clean. Controller runs full suite + build + E2E after handoff.

## House rules

No new server import in client code. Route-handler tests pass ctx. Commit small units, conventional messages, **no attribution trailer**. Write `docs/execution/2026-08-14-phase-8a/task-6-report.md` and update the Task 6 ledger row. Report back concisely. No PR/merge.
