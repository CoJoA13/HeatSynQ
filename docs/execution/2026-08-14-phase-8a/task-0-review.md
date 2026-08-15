# Task 0 — Report platform scaffold + two indexes — reviewer verdict

## Spec Compliance
✅ Spec compliant (with one ⚠️ the controller must close: the E2E/render smoke is PENDING, not in the diff).

- **Two indexes (deliverable 1):** `prisma/schema.prisma:1303` `@@index([finalizedAt])` on Invoice, `:1453` `@@index([receivedDate])` on Payment; migration `prisma/migrations/20260814115050_reports_indexes/migration.sql:1-5` is two additive `CREATE INDEX` statements, no drops, Prisma-canonical names (`Invoice_finalizedAt_idx`, `Payment_receivedDate_idx`). `migrate status` on BOTH `erp` and `erp_test` = "up to date", 36 migrations — the implementer's claim holds (verified read-only).
- **/reports index (deliverable 2):** `src/app/reports/page.tsx:1-5` server wrapper → `ReportsIndex.tsx:1` client component gated on `reports.view`; §5.16 says-why on the missing gate (`ReportsIndex.tsx:33-40`), never a silent-empty list.
- **Skeleton (deliverable 3):** `src/app/api/reports/route.ts`, `src/lib/report-registry.ts`, `src/server/reports/README.md` — the five-part aging-cloned shape, documented, not over-abstracted.
- **Gate ladder test:** `tests/reports-routes.test.ts:44-49` asserts 401 (no session) / 403 (`orders.view` only) / 200 (`reports.view`), passing ctx `{ params: Promise.resolve({}) }` via `withParams()` (`:11`). Matches `route.ts:13-15` (`requireUser()` → `mustCan(user,"reports","view")`).
- ⚠️ **Cannot verify from diff:** the "all-permissions user sees the index render" smoke / E2E — implementer marked PENDING (controller-run). The task adds a new page, so the controller must confirm `test:e2e` green (and clean ClosePeriod/GL strands first per session memory).

## Strengths
- The index-API-as-permanent-route design call is sound: `GET /api/reports` is a live gated route the ladder test targets and the client index consumes — no dead code, nothing for Task 1 to delete. Better than the plan's throwaway "placeholder report route".
- Clean client/server boundary: `ReportsIndex.tsx:9-11` imports only `@/lib/*` helpers + a type-only `ReportEntry` (`:11`); `report-registry.ts:11` imports only `permission-constants`. No `src/server/**` leak. Per-entry filtering is done server-side (`route.ts:15` `can(user, r.area, "view")`), so a `reports.view`-only user can't see cross-area entries — correct for Task 6.
- Migration is minimal and additive; index-presence test (`tests/reports-routes.test.ts:23,30`) queries `pg_indexes` rather than a Prisma-generated name — robust to naming drift.
- `ReportsIndex.tsx` faithfully mirrors `AgingReport.tsx` (same `!viewGate.allowed` early-return, same `loaded`-vs-empty flag, same error banner) — no novel divergence.
- README documents the five-part shape and reinforces the inline-columns house default without over-abstracting.

## Issues
### Critical (Must Fix)
None.

### Important (Should Fix)
None. No mutations in this task — pure-read scaffold, so no audit/transaction/row-lock surface to violate.

### Minor (Nice to Have)
- The 200 branch of the ladder test only asserts `Array.isArray` (`tests/reports-routes.test.ts:48`) because `REPORTS` is empty at Task 0 — the per-entry area-filter has no behavioral test yet (deferred to Task 6, acknowledged). Coverage wish, acceptable for a scaffold.
- `permsError` is captured (`ReportsIndex.tsx:14`) and referenced in the banner (`:46`) but is unreachable when set: a failed `/api/auth/me` leaves `perms` undefined → `viewGate.allowed` false → the §5.16 "no permission" branch renders instead of the error. This is an exact clone of `AgingReport.tsx:96-124`, i.e. a pre-existing house pattern faithfully copied — flagged for awareness, not introduced damage.

## Assessment
**Task quality:** Approved
**Reasoning:** All three deliverables land as specified with correct SQL applied to both DBs (verified) and a correct 401/403/200 gate ladder with proper ctx; no correctness, concurrency, or data-integrity defects, and the only open item is the controller-run E2E the split intentionally defers.
