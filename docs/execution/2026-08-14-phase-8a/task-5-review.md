# Task 5 — Payments received report — review verdict

**Reviewed:** `git diff 8467128..a9c3604` (branch `phase-8a-reports-scoreboard`).

## Spec Compliance — ✅ Spec compliant

- **POSTED-only filter correct.** `reportPayments` filters `batch: { status: "POSTED", deletedAt: null }` plus `deletedAt: null` on the payment (`src/server/reports/payments.ts:186-193`) — byte-for-byte the `close-periods.ts:175` `paymentTotal` basis, and deliberately NOT `aging.ts:197-198` (which has no batch filter → all payments). OPEN-batch, voided-batch, and voided-payment are all excluded; the two service tests pin each (`tests/reports-payments.test.ts:156-198`).
- **RED transcript genuine.** Omitting only the batch filter (payment `deletedAt: null` retained) yields exactly total 1099 (100 + OPEN 999) and 300 (100 + voided-batch 200; the voided *payment* 300 still dropped by `deletedAt`) — consistent with the reported numbers (`task-5-report.md:54-74`).
- **Shared `toXlsx` change additive/backward-compatible.** All ~20 existing callers pass 3 args → the `else` branch (`excel.ts:24-25`) is identical to the pre-change line. Verified in a standalone ExcelJS run: no-caption path keeps header on row 1 + keyed data on row 2+ (unchanged); caption path places A1=caption, row 2=headers, rows 3+ correctly keyed. `spliceRows` + keyed `addRow` map correctly.
- **No part filter** — parser has no `partId` (`query.ts`), service rejects `groupBy: "part"` with a 400 (`payments.ts:141-146`; test at :243). Correct — a payment pays invoices.
- **Basis printed** on the page chip (`PaymentsReport.tsx:119-121`), the export A1 caption (`export/route.ts:41`), and the JSON result `basis` (`payments.ts` result union; route test :262). One source: `PAYMENTS_BASIS`.
- **`receivedDate` inclusive `[from,to]`** on `@db.Date` (`schema.prisma:1442`) via plain gte/lte (`payments.ts:170-177`); boundary test at :200-216.
- **Grouping** customer/month/type each aggregate in integer cents (`payments.ts:107-140`); tests :218-239.
- **Pure read** — no claim/transaction/audit; `auditLog.count() === 0` asserted (:176).
- **Client/server boundary** honored — `PaymentsReport.tsx` mirrors row types locally, imports nothing from `src/server/**` (:18-30). **Shared parse** — `parsePaymentsFilter` imported by both routes. **Route gate** `reports.view`, 401/403/200, ctx passed (:251-283).

## Strengths

- The books-consistent basis is exactly right and well-defended: it matches `close-periods.ts` and consciously diverges from `aging.ts`, with the divergence documented in-code.
- Minimally-invasive shared-helper change: the existing path is untouched; only a new opt-in branch was added, and the export test reads A1 back to prove the stamp is in the file, not just the header shifted.
- §5.15 `loaded` flag distinct from empty, §5.16 disabled-with-tooltip on the customers dropdown, no reload-after-error, stale-response guard (`useLatest`).

## Issues

### Minor (Nice to Have)
- `excel.ts:4` JSDoc says the caption "is written as a **bold** cell A1" but the implementation renders it italic (`excel.ts:22`), header bold. Doc-vs-code cosmetic mismatch; no behavioral impact.

## Assessment

**Task quality:** Approved
**Reasoning:** The load-bearing POSTED-only filter is correct (matches `close-periods.ts`, excludes OPEN/voided-batch/voided-payment, RED genuine) and the shared `toXlsx` change is verified truly additive — every existing xlsx export is untouched. Only a one-word doc nit remains.
