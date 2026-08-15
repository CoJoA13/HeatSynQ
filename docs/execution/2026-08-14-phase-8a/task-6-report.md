# Task 6 — Home the invoice register + A/R aging under /reports — implementer report

**Commit:** `a92ae9d` `feat(reports): home invoice register + A/R aging under /reports`
**Approach:** LINK, not relocate (§4.1 / §12 item 7) — registry entries point at the existing pages; no new page or API built.

## What was built

Two `ReportEntry`s appended to `src/lib/report-registry.ts`, each carrying its **source** area so
`GET /api/reports`'s per-entry `can(user, r.area, "view")` filter gates it on where it actually lives
(invoicing / receivables), not on `reports.view`:

| key | label | href | area | description |
|-----|-------|------|------|-------------|
| `invoice-register` | Invoice register | `/invoicing` | `invoicing` | Finalized invoices/credits by date. |
| `aging` | A/R aging | `/receivables/aging` | `receivables` | Open A/R balances as of a date. |

No client-side server import introduced (`report-registry.ts` is already the client-safe catalog; it
imports only the `Area` type from `permission-constants.ts`).

## Area keys — verified against the guards, not guessed (the brief's explicit ask)

- **Invoice register → `area: "invoicing"`, `href: "/invoicing"`.** The invoicing list nav route is
  `/invoicing` (`src/lib/nav.ts:26`). There is **no** `/api/invoicing` directory — the list's data
  comes from `/api/invoices`, whose list handler guards `mustCan(requireUser(), "invoicing", "view")`
  (`src/app/api/invoices/route.ts:10`). So the area that reveals this page is `invoicing`, not
  `invoices` (there is no `invoices` area — `AREAS` has `invoicing`).
- **A/R aging → `area: "receivables"`, `href: "/receivables/aging"`.** The page is
  `src/app/receivables/aging/page.tsx`; its data route
  `src/app/api/receivables/aging/route.ts:11` guards `mustCan(requireUser(), "receivables", "view")`.
  Note `AREAS` contains BOTH `ar` and `receivables`; the aging page gates on **`receivables`** (the
  sibling `ar` area is the wrong key here). Confirmed by reading the route guard.

## Tests (`tests/reports-routes.test.ts`, extended in place)

Added the **per-entry area-filter behavioral test** the Task 0 reviewer noted was still missing
(`REPORTS` was empty at Task 0, so no cross-area entry existed to filter). Two new cases:

1. A `reports.view`-only user reaches the index (200) and still sees same-area entries (`backlog`),
   but the response does **not** contain `invoice-register` or `aging` (gated on areas it lacks).
2. A `reports.view` + `invoicing.view` + `receivables.view` user sees both homed entries, and each
   carries its real route/area (`toMatchObject { href, area }`). Plus a light static assertion that
   each href resolves to a real App Router `page.tsx` on disk.

**RED-first evidence:** before the registry entries landed, case (2) failed with
`expected undefined to match object { href: '/invoicing', … }`. After implementing the two entries, all
green.

## Targeted gate results (watched to completion, ~15:11)

- `npx vitest run tests/reports-routes.test.ts` → **5 passed** (was 3; +2).
- `npx tsc --noEmit` → clean.
- `npx eslint src/lib/report-registry.ts tests/reports-routes.test.ts` → clean.

Full `npm test` / `npm run build` / E2E deferred to the controller per the brief (implementer runs
targeted only; no dev-server startup). No browser preview — LINK-only, no new UI surface.

## Files touched

- `erp/src/lib/report-registry.ts` — two `ReportEntry`s appended.
- `erp/tests/reports-routes.test.ts` — per-entry area-filter describe block added (2 cases).
- `docs/execution/2026-08-14-phase-8a/PROGRESS.md` — Task 6 ledger row + gate snapshot.
- `docs/execution/2026-08-14-phase-8a/task-6-report.md` — this file.
