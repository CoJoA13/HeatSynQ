# Task 9 report — E2E flow, demo doc, and documentation

**Status: complete.** Commit `28b80ee` on `phase-5c-close-qbo-export` (docs(5c): E2E close flow,
demo, and handoff/house-rule updates).

## Deliberate deviation from the brief's literal file path

The brief said `erp/tests/e2e/close.spec.ts`. This repo's actual E2E convention (confirmed by
reading `erp/package.json`'s `"test:e2e": "node e2e/run.mjs"` and finding no `playwright.config.ts`
anywhere) is a hand-rolled harness: `erp/e2e/run.mjs` drives the bundled Chromium directly against a
throwaway `next dev`, running numbered flow modules from `erp/e2e/flows/*.mjs`, registered in
`run.mjs`'s own `FLOWS` array — not a Playwright Test file discovered by a config. A raw `.spec.ts`
under `tests/e2e/` would never execute under `npm run test:e2e` at all. I followed the actual
convention: `erp/e2e/flows/close-month-end.mjs`, registered as the 18th (last) flow in
`erp/e2e/run.mjs`'s `FLOWS` array, run and gated the same way every other flow is.

## What was built

- **`erp/e2e/flows/close-month-end.mjs`** (new, 18th flow): sets the four Admin → Billing GL
  defaults through the real UI; keys an order for a dedicated close-flow customer/part, ships it,
  finalizes the invoice; opens a batch, adds a check, applies a partial payment + the early-pay
  discount + a small write-off; **posts** both this flow's own batch and
  `receivables-apply-age-statement.mjs`'s (17th flow) leftover open batch — a genuine discovery, not
  a workaround: `computeSchedule` only counts a POSTED batch's cash, so leaving either open makes the
  variance nonzero, exactly what the close screen's own preliminary report flags; opens
  `/receivables/close`, confirms the preliminary schedule reconciles (variance 0, read from the same
  API the screen renders) and readiness is clear (0 gaps); closes the month; exports; downloads the
  CSV and confirms it balances (Σdebit = Σcredit, parsed from the file); reopens the month; voids the
  write-off application (the reachable correction — see the flow's own file header on why
  `voidPayment` itself isn't reachable, since it refuses on a POSTED batch and the batch must stay
  posted for its cash to count in the close at all); re-closes; re-exports; confirms a non-empty,
  **exactly**-balanced reversing delta (30.00/30.00, both lines `isReversal`) — uncontaminated by any
  other flow's own events in the same month, since every other in-scope event is unchanged between
  the two exports.
- **`erp/e2e/lib/db-fixtures.ts`**: a full close-flow fixture set (customer/part/step
  code/terms/payment type + six dedicated GL accounts), a snapshot-and-restore of `BillingConfig`'s
  four GL-default columns (the one singleton-row mutation this flow can't avoid, since those columns
  have no per-customer escape hatch), an id-driven `deleteClosePeriodFixture` (scoped by the exact
  `(year, month)` this run tested — not name-based, since a `ClosePeriod` carries no fixture name of
  its own and a broader sweep risks touching a real close after this ships), and — the key
  discovery — a one-line **backfill** of two already-merged Phase 5B fixtures
  (`arPriceStepCode`/`arPaymentType`) with GL accounts, because `resolveReadiness`/
  `buildCurrentJournal` scan every finalized invoice/posted payment dated in the target month
  **globally**, not per-customer, and `receivables-apply-age-statement.mjs`'s own invoice stays
  FINALIZED (never unlocked) for the rest of a run.
- **`erp/e2e/run.mjs`**: registers the 18th flow; adds `closeBatchId`/`closePeriodYear`/
  `closePeriodMonth` to `state.created` and the cleanup payload (separate fields from
  `receivablesBatchId`, so the two A/R flows' id-driven backstops can't clobber each other).
- **`docs/2026-08-09-phase-5c-demo.md`** (new): the walkthrough, the 18th flow's own narrative, two
  real harness bugs this task's own development found and fixed (a `page.on("dialog", …)` listener
  accumulation crash, and a shared "Type" column-header ambiguity between two nested tables), the two
  owner-homework items from spec §14 restated individually, and the final-review Minors from the
  ledger surfaced for the owner (not fixed — housekeeping for the whole-branch review).
- **`CLAUDE.md`**: two new house rules in Architecture — "The period lock (Phase 5C)" and "The
  GL-export delta (Phase 5C)" — per the task's own specified text, displacing nothing.
- **`docs/HANDOFF.md` §4**: replaced "No phase is in flight" with Phase 5C's in-flight state (branch,
  spec/plan/ledger pointers, the nine tasks in build order, the four data-integrity/concurrency
  defects the task reviews caught and fixed). No merge commit/PR recorded (none exists yet — that's
  the post-merge update). Migration count not touched elsewhere in HANDOFF (the top banner's "29
  migrations on main" stays accurate; this branch is at 30, noted in §4's own paragraph).

## Two real bugs found during this task's own development (detail in the demo doc)

1. A second `page.on("dialog", …)` call on the same `page` (via the shared, single-use-per-flow
   `armDialog`/`armPrompt` helpers) leaves a stale listener registered; when a later dialog fires,
   both listeners race to accept the same dialog object and Playwright throws — an *uncaught* promise
   rejection that crashed the whole harness process, bypassing even `run.mjs`'s own cleanup. Fixed
   with local, self-removing `page.once`-based helpers instead of reusing the shared ones a third and
   fourth time in one flow.
2. The batch page nests the existing-applications table and the OUTER Payments table both carrying a
   column literally named "Type" — `getByRole("columnheader", {name:"Type"}).
   locator("xpath=ancestor::table[1]")` (the exact technique that works cleanly for the candidate
   grid's unique "Write-off" header) resolved to both tables. Fixed by locating the panel's own root
   div by its unique summary-line text, then that div's first nested `<table>`.

A third fixture omission (not a harness bug, a straightforward gap) surfaced and was fixed during
iteration: `reapLeftovers()`'s step-code lookup didn't include the new `closePriceStepCodeCode`,
so a crashed prior run's leftover step code caused a P2002 on the next `create()` — fixed by adding
it to the lookup array (`e2e/lib/db-fixtures.ts`).

## Full gate chain (run in the foreground, per the coordinator's instruction)

- `npm test` — **1938 tests, 125 files, all passing**.
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean. (`npx eslint src tests e2e` also run: one pre-existing, unrelated
  warning in `cert-results-print.mjs`, same as the 5B demo doc noted — not touched by this task.)
- `npm run build` — clean, exit 0.
- `npm run test:e2e` — **18/18** on the run this report is based on. One earlier run in this same
  session hit a transient Playwright strict-mode collision in the PRE-EXISTING, unmodified
  `invoice-shipped-order.mjs` flow (two unrelated board cells briefly sharing rendered text "1200" on
  a heavily-reused dev database) — did not reproduce on an immediate re-run, and touches no file this
  task changed. `close-month-end.mjs` itself passed on every run once its own bugs above were fixed.

Both databases report no pending migrations (`npx prisma migrate status`, checked before the gate
chain). Migrations: 30 total on this branch (29 on `main` + Task 1's
`20260809130000_phase_5c_close_and_gl_export`).

## Concerns / residual risk (documented, not blocking)

- **`ClosePeriod`/`GlExportBatch`/`GlPosting` cleanup has no name-based self-heal** — only this run's
  own `(year, month)`, passed back via `ctx.created`. A crash hard enough to skip this flow's own
  cleanup leaves that one row behind for a human to clear by hand (documented in
  `deleteClosePeriodFixture`'s own comment and in the demo doc). The flow's own pre-flight guard
  refuses to run at all if a `ClosePeriod` already covers the target month, so this can never
  silently overwrite a real one.
- **The close/export scope is global-per-month by design**, which is why this flow had to backfill
  two Phase 5B fixtures rather than staying fully self-contained — documented in three places (the
  flow's own file header, `db-fixtures.ts`'s `arOpGlAccountName` comment, and the demo doc) so a
  future flow author isn't surprised by the same coupling.
- Everything else flagged is cosmetic housekeeping already listed in the demo doc's own section for
  the whole-branch review to triage — nothing new found in this task's own code.

## Files touched (absolute paths)

- `/home/cjones/Desktop/HeatSynQ/erp/e2e/flows/close-month-end.mjs` (new)
- `/home/cjones/Desktop/HeatSynQ/erp/e2e/lib/db-fixtures.ts`
- `/home/cjones/Desktop/HeatSynQ/erp/e2e/run.mjs`
- `/home/cjones/Desktop/HeatSynQ/docs/2026-08-09-phase-5c-demo.md` (new)
- `/home/cjones/Desktop/HeatSynQ/CLAUDE.md`
- `/home/cjones/Desktop/HeatSynQ/docs/HANDOFF.md`
