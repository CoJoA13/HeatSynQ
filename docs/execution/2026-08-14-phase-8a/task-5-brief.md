# Task 5 — Payments received report

**Branch:** `phase-8a-reports-scoreboard` (no PR/merge). **Plan:** §"Task 5". **Spec §4.2** (Payments received row) + §12 item 2. **Pattern:** `src/server/reports/README.md`. Register in `src/lib/report-registry.ts`.

## Goal

Cash received by period — filterable and Excel-exportable, sliceable by customer / month / payment type.

## Measure (pin exactly)

- **Population: POSTED-batch payments only.** A `Payment` counts only if its `ReceiptBatch.status = POSTED` (matches deposits and the month-end close; the two existing consumers disagree — the close counts POSTED, aging counts all — and this report deliberately picks the **books-consistent** basis). `deletedAt: null`.
- **Date anchor:** `Payment.receivedDate` (`@db.Date`; inclusive `[from, to]`). Range filter on it.
- **Slices/group:** by customer · month (of `receivedDate`) · **payment type** (each `PaymentType` FK'd to a GL account). **"By part" does NOT apply** — a payment pays invoices, not parts; do not add a part filter.
- **Print the basis** ("Posted payments only") on the page AND in the export, so un-posted cash is never mistaken for missing money.
- Amounts in integer cents. Pure read (no claim/audit/Serializable).

## The five parts

`src/server/reports/payments.ts` (pure core + `reportPayments(filter)` wrapper) · `src/app/api/reports/payments/{query.ts,route.ts,export/route.ts}` · `src/app/reports/payments/{page.tsx,PaymentsReport.tsx}` (client, numeric table, one query string, the basis label rendered). Register `{ key: "payments", label: "Payments received", href: "/reports/payments", area: "reports", description: "Cash received (posted), by customer/month/payment type." }`.

## Tests (TDD — RED first)

- **POSTED-only:** a payment in a **non-posted** batch does NOT appear (RED-verify — the load-bearing filter); a POSTED-batch payment does.
- Grouping by customer / month / payment type each correct.
- `receivedDate` range filter (inclusive bounds; blank = not set).
- The basis label ("Posted payments only") is present in the response/export.
- Route gate `reports.view` (ctx `{ params: Promise.resolve({}) }`).

## Acceptance

- `/reports` shows Payments received; `/reports/payments` renders + exports. Targeted tests green (`npx vitest run tests/reports-payments.test.ts`); tsc + eslint clean. Controller runs full suite + build + E2E after handoff (do NOT run them yourself).

## House rules

Client components must not import `src/server/**`. Route-handler tests pass ctx. `deletedAt: null`; no `findUnique` on soft-deletable models. Reads never mutate. Commit small units, conventional messages, **no attribution trailer**. Write `docs/execution/2026-08-14-phase-8a/task-5-report.md` and update the Task 5 ledger row — show a RED transcript for the POSTED-only test. Report back concisely. No PR/merge.
