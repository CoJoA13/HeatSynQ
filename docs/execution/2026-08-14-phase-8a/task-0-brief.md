# Task 0 — Report platform scaffold + the two indexes

**Branch:** `phase-8a-reports-scoreboard` (work here; do NOT create a PR or merge). **Plan:** `docs/superpowers/plans/2026-08-14-phase-8a-reports-scoreboard.md` §"Task 0" and §"The shape every task shares". **Spec:** `docs/superpowers/specs/2026-08-14-phase-8-reports-parallel-run-design.md` §4.1.

## Goal

Make the `reports` area real: the `/reports` index page exists (closing the dead 404 nav link), the reusable report shape is demonstrated once, and the two indexes 8A's reports need are added. This unblocks Tasks 1–7.

## Deliverables

1. **The two indexes** (a migration, via the HeatSynQ TTY-less workflow — **use the `create-migration` skill**): add `@@index` on **`Invoice.finalizedAt`** and **`Payment.receivedDate`** in `prisma/schema.prisma`. `migrate dev` refuses without a TTY — do NOT run it. Instead: `migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script`, read it in full, hand-write `prisma/migrations/<timestamp>_reports_indexes/migration.sql`, apply to **dev AND `erp_test`** (two `migrate deploy` calls), then `npx prisma generate`. Verify `migrate status` clean on both DBs.
2. **The `/reports` index page** `src/app/reports/page.tsx` (+ a small `ReportsIndex` client component if useful): a **client component** against the guarded API surface, listing the reports available to the user, each entry permission-filtered by `reports.view` (reuse the shell's `canViewArea`/nav gating pattern). The page requires `reports.view`. **No `nav.ts` change is needed** — the entry already targets `/reports`; the 404 is only the missing page.
3. **The reusable report skeleton, demonstrated once.** Establish the directory shape the report tasks will clone: `src/server/reports/` and `src/app/api/reports/`. You do NOT need to build a real report in Task 0, but leave the conventions obvious (a short README or a typed skeleton is fine) so Tasks 1–5 clone a clear pattern. The canonical precedent to mirror is **A/R aging**: `src/server/aging.ts` (pure `bucketAging` core + `agingReport` Prisma wrapper), `src/app/api/receivables/aging/{route.ts,query.ts,export/route.ts}`, `src/app/receivables/aging/{page.tsx,AgingReport.tsx}`, and `src/server/excel.ts` `toXlsx`. Do not over-abstract — the house default is inline columns per export route (see the invoices export route's own comment).

## Tests (TDD — write failing first)

- `reports.view` **required** on the `/reports` index route/page: a route-handler test that a user lacking `reports.view` is denied (403) and one with it succeeds. Pass ctx: `handler(req, { params: Promise.resolve({}) })`.
- The migration is applied and **both indexes exist** (a test asserting the index presence, or confirmed via `migrate status` + a schema check — pick the check that fits the repo's existing migration tests).
- An all-permissions user sees the index render (a light smoke test / the E2E covers the visual).

## Acceptance

- Navigating to `/reports` renders (no 404); a user without `reports.view` is denied.
- `npm test`, `npx tsc --noEmit`, `npx eslint src tests` all green. Run **`npm run test:e2e`** (this adds a real page/flow) — dev server + DEV db `erp`; a killed run strands ClosePeriod/GL debris, so if E2E was interrupted, clean per the session memory before re-running.
- Both DBs at the new migration; `prisma generate` run.

## House rules that bite (from CLAUDE.md)

- **Client components must not import from `src/server/**`** — the index page is a client component against guarded APIs.
- **Any server-rendered page that fetches data must call `requireUser` itself** — sidestep by making the index a client component (the Phase 1 precedent).
- Route-handler tests **must pass ctx** (`{ params: Promise.resolve({}) }`).
- The migration goes to **both** databases; `prisma generate` after.

## Working method

TDD: failing test → implement → pass → **commit a small unit** (so a died-mid-task turn resumes from a committed prefix). Conventional commit messages, **no attribution trailer** (owner instruction — attribution is PR-body only). Use the **`gates` skill** to run the full chain before declaring done. When done, **write your implementer report** to `docs/execution/2026-08-14-phase-8a/task-0-report.md`: what you built, the files, the migration name, the exact gate results (copied from the runs you watched end — or PENDING), and anything the reviewer should scrutinize. Do NOT open a PR or merge.
