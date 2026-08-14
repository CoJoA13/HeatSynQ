# Phase 8A — Reports & Scoreboard: execution ledger

**Branch:** `phase-8a-reports-scoreboard` · **Plan:** `docs/superpowers/plans/2026-08-14-phase-8a-reports-scoreboard.md` · **Spec §4.**

**Gate policy (standing):** a gate row is written **after** watching the run end, from the run's own output — or it says PENDING. Never pre-write a green claim. The controller re-verifies gate numbers before any phase/merge claim. Tests share one `erp_test` DB (`fileParallelism: false`) → tasks execute **sequentially**, one implementer at a time on the branch. Run `npm run test:e2e` on any UI/flow-touching task (dev server + DEV db `erp`).

## Task ledger

| # | Title | Implementer | Review verdict | Commit(s) | Status |
|---|-------|-------------|----------------|-----------|--------|
| 0 | Report platform scaffold + 2 indexes | general-purpose | pending | 5a6a9c3, bf503fe | IMPLEMENTED — awaiting review |
| 1 | Backlog report | — | — | — | PENDING |
| 2 | Shipped report | — | — | — | PENDING |
| 3 | Turnaround report | — | — | — | PENDING |
| 4 | Sales report (careful one) | — | — | — | PENDING |
| 5 | Payments received report | — | — | — | PENDING |
| 6 | Home invoice register + aging | — | — | — | PENDING |
| 7 | Comparison scoreboard | — | — | — | PENDING |
| 8 | E2E flows + docs | — | — | — | PENDING |

## Gate snapshots (each written after watching the run)

- **Task 0 (implementer, targeted only):** `npx vitest run tests/reports-routes.test.ts` → 3 passed. `npx tsc --noEmit` → clean. `npx eslint src tests` → clean. Both DBs at 36 migrations, `migrate status` up to date. **PENDING controller verification:** full `npm test`, `npm run build`, `npm run test:e2e` (not run by the implementer per the split — long runs kill subagent turns).

## Notes / rulings during execution

- 2026-08-14: kickoff. Design approved (5-lens review folded); 8A plan approved (2-lens review folded — SURCHARGE in Sales, scoreboard export, reconciliation fixture, include-voided deferred). Env verified: Docker up, both DBs at 35 migrations, client generated.
- 2026-08-14 Task 0 done: migration `20260814115050_reports_indexes` (both indexes, both DBs, 36 total). Scaffold: `GET /api/reports` gated `reports.view` returns the per-entry area-filtered registry; `/reports` client index page (Phase 1 requireUser-sidestep); `src/lib/report-registry.ts` client-safe catalog (empty — Tasks 1–6 append); `src/server/reports/README.md` documents the five-part shape. Design call: the brief's "placeholder report route" is realized as the permanent **index API** (`/api/reports`), not a throwaway fake report — it is the gated report-area route the ladder test targets, and the client page consumes it (no dead code). `REPORTS` is intentionally empty at Task 0.
