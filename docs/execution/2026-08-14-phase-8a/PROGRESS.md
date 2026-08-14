# Phase 8A — Reports & Scoreboard: execution ledger

**Branch:** `phase-8a-reports-scoreboard` · **Plan:** `docs/superpowers/plans/2026-08-14-phase-8a-reports-scoreboard.md` · **Spec §4.**

**Gate policy (standing):** a gate row is written **after** watching the run end, from the run's own output — or it says PENDING. Never pre-write a green claim. The controller re-verifies gate numbers before any phase/merge claim. Tests share one `erp_test` DB (`fileParallelism: false`) → tasks execute **sequentially**, one implementer at a time on the branch. Run `npm run test:e2e` on any UI/flow-touching task (dev server + DEV db `erp`).

## Task ledger

| # | Title | Implementer | Review verdict | Commit(s) | Status |
|---|-------|-------------|----------------|-----------|--------|
| 0 | Report platform scaffold + 2 indexes | general-purpose | — | — | DISPATCHED |
| 1 | Backlog report | — | — | — | PENDING |
| 2 | Shipped report | — | — | — | PENDING |
| 3 | Turnaround report | — | — | — | PENDING |
| 4 | Sales report (careful one) | — | — | — | PENDING |
| 5 | Payments received report | — | — | — | PENDING |
| 6 | Home invoice register + aging | — | — | — | PENDING |
| 7 | Comparison scoreboard | — | — | — | PENDING |
| 8 | E2E flows + docs | — | — | — | PENDING |

## Gate snapshots (each written after watching the run)

_(none yet — Task 0 in flight)_

## Notes / rulings during execution

- 2026-08-14: kickoff. Design approved (5-lens review folded); 8A plan approved (2-lens review folded — SURCHARGE in Sales, scoreboard export, reconciliation fixture, include-voided deferred). Env verified: Docker up, both DBs at 35 migrations, client generated.
