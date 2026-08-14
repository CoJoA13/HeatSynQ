# Phase 8A — Reports & Scoreboard: execution ledger

**Branch:** `phase-8a-reports-scoreboard` · **Plan:** `docs/superpowers/plans/2026-08-14-phase-8a-reports-scoreboard.md` · **Spec §4.**

**Gate policy (standing):** a gate row is written **after** watching the run end, from the run's own output — or it says PENDING. Never pre-write a green claim. The controller re-verifies gate numbers before any phase/merge claim. Tests share one `erp_test` DB (`fileParallelism: false`) → tasks execute **sequentially**, one implementer at a time on the branch. Run `npm run test:e2e` on any UI/flow-touching task (dev server + DEV db `erp`).

## Task ledger

| # | Title | Implementer | Review verdict | Commit(s) | Status |
|---|-------|-------------|----------------|-----------|--------|
| 0 | Report platform scaffold + 2 indexes | general-purpose | ✅ Approved | 5a6a9c3, bf503fe | ✅ DONE (gates green, E2E 20/20) |
| 1 | Backlog report | general-purpose | ✅ Approved | c4da1e8, 641303f | ✅ DONE (gates green 2761, E2E 20/20) |
| 2 | Shipped report | general-purpose | ✅ Approved | 605da4c, dcebfab, bc13039 | ✅ DONE (gates green 2779, E2E 20/20) |
| 3 | Turnaround report | general-purpose | — | — | DISPATCHED |
| 4 | Sales report (careful one) | — | — | — | PENDING |
| 5 | Payments received report | — | — | — | PENDING |
| 6 | Home invoice register + aging | — | — | — | PENDING |
| 7 | Comparison scoreboard | — | — | — | PENDING |
| 8 | E2E flows + docs | — | — | — | PENDING |

## Gate snapshots (each written after watching the run)

- **Task 0 (implementer, targeted only):** `npx vitest run tests/reports-routes.test.ts` → 3 passed. `npx tsc --noEmit` → clean. `npx eslint src tests` → clean. Both DBs at 36 migrations, `migrate status` up to date.
- **Task 0 (controller-verified):** full `npm test` → **2747 passed / 150 files** (+3 from Task 0); `tsc` clean; `eslint` clean; `npm run build` clean — all watched to completion. **E2E:** first full run 17 flows PASS then `close-month-end` **hung** (documented Phase-5C flake) → KILL'd at 600s; cleared the strand + orphaned `:3100` server; **re-run = 20/20 clean pass** (12:21). Task 0 fully verified.
- **Task 1 (implementer, targeted only):** `npx vitest run tests/reports-backlog.test.ts` → **14 passed** (watched to completion, 12:33). `npx tsc --noEmit` → clean. `npx eslint` over all 8 new/changed files → clean. Full `npm test`/`build`/E2E deferred to the controller per brief (no dev-server startup by the implementer). No browser preview run (would need the dev server) — the UI is a straight AgingReport clone; controller/E2E to confirm the render.
- **Task 1 (controller-verified, 12:47):** full `npm test` → **2761 passed / 151 files** (+14); `tsc` clean; `eslint` clean; `npm run build` clean; **E2E 20/20 clean** (no flake this run — the `--kill-after=30` graceful timeout, port was free). Task 1 fully verified.
- **Task 2 (implementer, targeted only, 13:01):** `npx vitest run tests/reports-shipped.test.ts` → **18 passed** (watched to completion). `npx tsc --noEmit` → clean. `npx eslint` over all 7 new/changed files → clean. Full `npm test`/`build`/E2E deferred to the controller per brief (no dev-server startup by the implementer). No browser preview (needs the dev server) — the UI is a straight BacklogReport clone; controller/E2E to confirm the render. Note: 3 of 18 tests were RED on first run due to a stray null byte in the test's part-key literals (a test-authoring artifact, not a logic bug) — replaced with spaces, all 18 green with the implementation unchanged.
- **Task 2 (controller-verified, 13:13):** full `npm test` → **2779 passed / 152 files** (+18); `tsc` clean; `eslint` clean; `npm run build` clean; **E2E 20/20 clean** (no flake). Task 2 fully verified.

## Tracked cleanup (fold in ONE consolidated pass before the whole-branch review — not per-task micro-rounds)

Minors from per-task reviews that are Nice-to-Have (no correctness/concurrency/data-integrity blockers). Reviews return APPROVED with these deferred:
- **Task 1 / `BacklogReport.tsx`:** detail-row React key `${orderId}-${partNumber}` can collide when one order has two lines on the SAME part (`OrderLine` unique is `[orderId, position]`, so duplicate `partId` is allowed); and the `findMany` has no `orderBy`, so within-order row order is DB-arbitrary. Fix: carry the line id/position into the detail row for a stable key + add a deterministic `orderBy`. Low impact (UI-only; export/data correct).
- **Task 1 / test:** the ordered-vs-remaining choice isn't RED-verified against an actual partial-shipment scenario (no `ShipperLine` seeded). Add a test seeding a partial shipment that asserts the report still shows ORDERED, not remaining.
- **General / reports:** implementer reports say "RED-first" but show only GREEN transcripts — a report-writing gap (tests ARE genuinely RED-structured). Tighten the report template's RED evidence going forward.
- **Task 2 / Shipped — partId-filter vs group-by-part asymmetry** (owner-facing, spec §4.3 silent): a released row (order line deleted after shipping) is counted in the unfiltered by-part grouping under its snapshot `partNumber`, but the `partId` FILTER matches only the live `orderLine.partId`, so filtering to that part HIDES it ("part X = 16 grouped, 10 filtered"). Documented + defensible, but surprising. Candidate fix: make the part filter also match snapshot `partNumber` within the customer (so filtered == grouped). **Flagged to owner** as an FYI; low stakes.

## Notes / rulings during execution

- 2026-08-14: kickoff. Design approved (5-lens review folded); 8A plan approved (2-lens review folded — SURCHARGE in Sales, scoreboard export, reconciliation fixture, include-voided deferred). Env verified: Docker up, both DBs at 35 migrations, client generated.
- 2026-08-14 Task 0 review: `task-reviewer` → **✅ Spec Compliant + Approved** (no critical/important; minors: a per-entry-filter test deferred to Task 6, and a faithfully-copied `AgingReport` error-branch — not new damage). Verdict in `task-0-review.md`.
- 2026-08-14 E2E flake episode (Task 0 verification): `close-month-end` hung under full-suite load (documented Phase-5C flake, unrelated to Task 0). Remediation: (a) delete ClosePeriod→GlExportBatch→GlPosting for the closed month in FK order; **(b) also kill the orphaned dev server on `:3100`** — a `timeout --signal=KILL` E2E leaves `next-server` orphaned (SIGKILL can't self-clean) and the harness refuses to start on a busy port. Prefer `timeout --kill-after=30 600` (TERM first, KILL backstop) so the harness self-cleans.
- 2026-08-14 Task 0 done: migration `20260814115050_reports_indexes` (both indexes, both DBs, 36 total). Scaffold: `GET /api/reports` gated `reports.view` returns the per-entry area-filtered registry; `/reports` client index page (Phase 1 requireUser-sidestep); `src/lib/report-registry.ts` client-safe catalog (empty — Tasks 1–6 append); `src/server/reports/README.md` documents the five-part shape. Design call: the brief's "placeholder report route" is realized as the permanent **index API** (`/api/reports`), not a throwaway fake report — it is the gated report-area route the ladder test targets, and the client page consumes it (no dead code). `REPORTS` is intentionally empty at Task 0.
