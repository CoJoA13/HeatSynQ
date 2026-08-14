# Task 0 — Report platform scaffold + the two indexes — implementer report

**Branch:** `phase-8a-reports-scoreboard` · **Commits:** `5a6a9c3` (indexes), `bf503fe` (scaffold).
No PR opened, nothing merged.

## What was built

### 1. The two indexes (migration)

Added `@@index([finalizedAt])` to `Invoice` and `@@index([receivedDate])` to `Payment` in
`prisma/schema.prisma`, then produced the migration via the **`create-migration` skill** (TTY-less
flow): `migrate diff --from-config-datasource --to-schema --script` → reviewed the two additive
`CREATE INDEX` statements → hand-wrote the directory → `migrate deploy` to **erp** and **erp_test**
→ `npx prisma generate`.

- **Migration directory:** `prisma/migrations/20260814115050_reports_indexes/migration.sql`
- **Both DBs:** `migrate status` reports "up to date", 36 migrations each.

### 2. The `/reports` index

- `src/app/reports/page.tsx` — trivial wrapper.
- `src/app/reports/ReportsIndex.tsx` — **client** component (Phase 1 precedent: a client component
  against a guarded API sidesteps the requireUser-on-server-page rule). Gated on `reports.view`,
  says-why on the missing gate (§5.16, mirroring `AgingReport.tsx`), carries a `loaded` flag so a
  failed fetch is distinguishable from a healthy-empty list, and renders the registry entries the
  index API returns.
- **No `nav.ts` change** — the Reports entry already targeted `/reports`; the 404 was only the
  missing page, now present.

### 3. The reusable skeleton

- `src/app/api/reports/route.ts` — `GET /api/reports`, gated `reports.view`, returns
  `REPORTS.filter((r) => can(user, r.area, "view"))` so each entry additionally gates on its own
  area (Task 6's cross-area entries hide correctly for a `reports.view`-only user).
- `src/lib/report-registry.ts` — client-safe `ReportEntry` type + `REPORTS` array (empty at Task 0;
  Tasks 1–6 append). Imports only `permission-constants` — no server leak.
- `src/server/reports/README.md` — documents the five-part report shape (pure core + Prisma wrapper
  → shared `query.ts` → JSON route → export route → client UI), cloned from A/R aging, plus the
  pure-read / cents / `deletedAt: null` / inline-columns house rules and the deferred
  `includeVoided` toggle.

**Design call worth noting for the reviewer:** the plan's Task-0 test bullet names "a placeholder
report route." I realized that as the **permanent index API** (`GET /api/reports`) rather than a
throwaway fake report: it is the gated report-area route the ladder test targets, and the client
index page actually consumes it, so there is no dead code and nothing for Task 1 to delete. The
canonical five-part example remains the live A/R aging report (per the plan), documented in the
README. `REPORTS` is deliberately empty — Task 0 builds no real report.

## Tests (TDD: RED → GREEN)

`tests/reports-routes.test.ts` (written failing first — confirmed RED with "Cannot find module
'@/app/api/reports/route'", then GREEN after implementation):

- **Index presence** — `pg_indexes` shows an index whose `indexdef` covers `finalizedAt` on
  `Invoice` and `receivedDate` on `Payment` (authoritative, robust to Prisma's index naming).
- **`reports.view` gate ladder** — `GET /api/reports`: 401 without a session, 403 with `orders.view`
  only, 200 + JSON array with `reports.view`. Route-handler test passes ctx
  `{ params: Promise.resolve({}) }`.

## Gate results (implementer — targeted only, per the split)

| Gate | Result |
|------|--------|
| `npx vitest run tests/reports-routes.test.ts` | **3 passed** |
| `npx tsc --noEmit` | **clean** |
| `npx eslint src tests` | **clean** |
| `migrate status` (erp + erp_test) | **up to date, 36 migrations** |
| `npm test` (full) | **PENDING** — controller runs it |
| `npm run build` | **PENDING** — controller runs it |
| `npm run test:e2e` | **PENDING** — controller runs it |

The full suite, build, and E2E were intentionally NOT run by the implementer (long runs kill
subagent turns — the controller runs the full chain detached).

## What the reviewer should scrutinize

- **Permission wiring:** the index gate is `reports.view`; per-entry filtering uses
  `can(user, entry.area, "view")`. Confirm this matches Task 6's intended cross-area gating.
- **No server import in a client component:** `ReportsIndex.tsx` imports only the `ReportEntry`
  *type* from `report-registry.ts` (type-only, erased) and `src/lib/*` helpers — no `src/server/**`.
- **Migration applied to BOTH DBs** — verified via `migrate status`; reviewer may re-confirm.
- **The index-API-as-placeholder-route design call** above — confirm it satisfies the plan's intent
  rather than expecting a separate throwaway report route.
