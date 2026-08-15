# Task 1 — Backlog report

**Branch:** `phase-8a-reports-scoreboard` (work here; no PR/merge). **Plan:** §"Task 1". **Spec §4.2** (Backlog row). **Pattern:** `src/server/reports/README.md` — clone the five-part shape from A/R aging.

## Goal

The Backlog report: open orders not yet fully shipped, filterable and Excel-exportable, sliceable by customer / part / received-month. Register it on the `/reports` index.

## Measure (pin exactly — do not guess)

- **Population:** order lines of orders whose `status ∈ {OPEN, PARTIAL_SHIPPED, REOPENED}` and `deletedAt: null`. **`REOPENED` MUST be included** — it is genuinely un-shipped work again (an invoiced order reversed back open); dropping it silently undercounts backlog. Exclude `SHIPPED` and `INVOICED` and any voided/deleted order.
- **Amounts:** **qty + weight ORDERED** (the order line's ordered quantity/weight — per spec §4.2's words), **not** remaining-to-ship. Do NOT compute shipped-remainder here (that would pull in the ship-ledger and is a different, unrequested measure). *(Controller note: "ordered vs remaining-to-ship" is a definitional choice the owner approved as "ordered"; if it later needs to be remaining, that's a small follow-up — build "ordered" now.)*
- **Columns/rows:** order number, customer, part (number/name), qty ordered, weight ordered, receivedDate, days-open (`todayDateOnly()` − `receivedDate`, whole days). The base grain is the open order line (a report row per open order line); the customer/part/month slices aggregate over that grain.
- **Slices/group:** by customer · by part · by received-month. **Filter:** `receivedDate` range (the `dateRange`/`parseDate` helper) + customer + part. A current-open snapshot that a received-date window narrows.

## The five parts (per the README)

1. `src/server/reports/backlog.ts` — pure core (aggregate/shape open lines) + `reportBacklog(filter)` Prisma wrapper. Pure read: no claim/audit/Serializable. Integer cents for weight if fractional; humanize before rows leave.
2. `src/app/api/reports/backlog/query.ts` — one parser (`orUndefined`; service owns malformed-date 400s), imported by both routes.
3. `src/app/api/reports/backlog/route.ts` — `mustCan(requireUser(), "reports", "view")` → JSON.
4. `src/app/api/reports/backlog/export/route.ts` — same gate+parse → `toXlsx` (inline columns), xlsx content-type + `attachment; filename`.
5. `src/app/reports/backlog/{page.tsx, BacklogReport.tsx}` — client component, filters in state, ONE query string for the fetch AND the export link, date inputs `type=date`, a numeric table (no charts). Then **register** in `src/lib/report-registry.ts`: `{ key: "backlog", label: "Backlog", href: "/reports/backlog", area: "reports", description: "Open orders not yet fully shipped." }`.

## Tests (TDD — RED first)

- **REOPENED included**; SHIPPED/INVOICED and voided/deleted excluded (RED-verify: seed one of each; only OPEN/PARTIAL_SHIPPED/REOPENED appear).
- Grouping by customer, by part, by received-month each correct.
- `receivedDate` range filter narrows correctly; blank param = not set (`orUndefined`).
- **Export mirrors the on-screen filter** (Task 1 is the report that carries this explicit test — the shared-parse invariant covers Tasks 2–5).
- Days-open math (a fixed `receivedDate` → expected whole-day count against `todayDateOnly()`).
- Route gate: `reports.view` required (ctx `{ params: Promise.resolve({}) }`).

## Acceptance

- `/reports` shows the Backlog entry; `/reports/backlog` renders the table + export.
- Targeted tests green (`npx vitest run tests/reports-backlog.test.ts`). tsc + eslint clean.
- Controller runs the full suite + build + E2E after handoff (do NOT run them yourself — long runs kill subagent turns).

## House rules

Client components must not import `src/server/**` (mirror the row type locally). Route-handler tests pass ctx. Soft-delete: `deletedAt: null` everywhere; no `findUnique` on soft-deletable models. Commit small units, conventional messages, **no attribution trailer**. When done, write `docs/execution/2026-08-14-phase-8a/task-1-report.md` (built, files, targeted gate results watched, review-focus notes) and report back concisely. No PR/merge.
