# Task 8 report — the `/receivables/close` UI

**Status:** COMPLETE. All gates green, browser-verified end to end.

**Commit:** `c209b91` — `feat(5c): month-end close & GL-export UI (/receivables/close)`

## What landed

- **`erp/src/app/receivables/close/Close.tsx`** (new, `"use client"`) — modelled on `AgingReport.tsx`
  (guarded `api()` fetch + `useLatest()` + `gate(perms, ...)`) and `Statements.tsx` (mutation shape,
  disabled-with-tooltip buttons, fetch-blob-open precedent, a refresh counter). A year/month picker
  (`<input type="number">` + a month `<select>`, defaulting to the most recently COMPLETED month —
  July relative to today's 2026-08-09) drives ONE combined `Promise.all` fetch of
  `GET .../close/preliminary?year=&month=` and `GET .../close/readiness?year=&month=` for the SAME
  month, so the readiness panel and the Export button's disabled-count can never disagree with what
  `exportClose` itself refuses on. Renders:
  - The **continuity schedule** as a table: beginning → +invoiced/−credits/−payments/−discounts/
    −write-offs → ending, with the independent aging figure and the variance beside it (red when
    nonzero, green at zero).
  - A **readiness panel**: the gap list (each with its `href` "Fix" link) or a "ready to export"
    message when clear, plus `<a href=".../readiness/export?...">` to the xlsx (the aging/export
    precedent — plain link, no fetch-blob).
  - A **Close** button: `gate(perms, "receivables.edit")` + `gateDo(perms, "close_ar_period")`,
    disabled-with-title when the variance is nonzero, the prior month isn't closed (a client-side
    mirror of `close-periods.ts`'s own genesis rule — computed from the closed-periods list already
    on screen, never a second server round trip; the server re-derives and enforces this
    independently, so a stale hint only ever costs an extra click, never a wrong close), or
    permission is missing.
  - A **closed-periods list**: each row's frozen figures, its export batches with **File** and
    **Register** download links (plain `<a href>`, cookie-authenticated GETs — the aging/statements
    precedent), a **Reopen** button (`gateDo` `close_ar_period`, `confirm` + a reason `prompt`, 400s
    surfaced if the reason is blank), and an **Export** button (`gateDo` `run_qbo_export`, disabled
    when the row isn't CLOSED or — for the row matching the picker's own month, where a fresh
    readiness count is actually known — a gap remains; documented in-code why a non-selected
    historical row doesn't get its own per-row readiness fetch, and that `exportClose`'s own 409
    still catches it if one exists).
  - Every disabled control carries `title` naming why (§5.16); every fetch is `useLatest()`-guarded;
    no `.catch(() => {})` anywhere — failures land in an error banner.
- **`erp/src/app/receivables/close/page.tsx`** (new) — wraps `<Close />` (which itself wraps a
  `useSearchParams()`-reading screen in `<Suspense>`, the `Statements.tsx` precedent — `?year=&month=`
  preselects the picker so a readiness "Fix" link's round trip returns to the same month).
- **`erp/src/app/receivables/ReceivablesNav.tsx`** — added a `Close` tab (`/receivables/close`),
  mirroring the Aging/Statements entries; the nav itself does no permission check (never has) — the
  destination page gates on `receivables.view` and shows why if denied.

### The brief's own gap: listing closed periods + their export batches

- **`erp/src/server/close-periods.ts`** — added `ClosePeriodListItem` (the frozen `ContinuitySchedule`
  fields + `id/year/month/status/closedAt/exportBatches`) and `listClosePeriods()`: every `ClosePeriod`
  row (CLOSED and REOPENED, newest first) with its `GlExportBatch`es (newest export first, `id`/
  `exportNumber`/`emittedAt`/`fileName`). A plain read — no lock, no isolation requirement, nothing to
  translate — matching `listBatches` (receipts.ts), not the Serializable+lock shape the mutators use.
  `variance` is recomputed for display only (`endingAr - agingEndingAr`; always 0 for a genuinely
  CLOSED row since `closePeriod` itself refuses a nonzero one at close time) — it isn't a stored column.
- **`erp/src/app/api/receivables/close/route.ts`** — added `GET`, gated `receivables.view` alone (the
  `batches/route.ts` GET-list-alongside-POST-create precedent), returning `listClosePeriods()`.
- **`erp/tests/receivables-routes.test.ts`** — new `describe("GET /api/receivables/close")`: 401 (no
  session) → 403 (no `receivables.view`) → 200 with it, asserting the closed period's year/month/
  status/`endingAr` and that its export batch (created via the existing `glReadyClosedJuly` + export
  helper) appears with the right `fileName`.

## TDD RED evidence (new route/service)

`git stash push` on `close-periods.ts` + `close/route.ts` (reverting the GET addition), then:

```
npx vitest run tests/receivables-routes.test.ts -t "GET /api/receivables/close\b"
```

**RED:**

```
 FAIL  tests/receivables-routes.test.ts > GET /api/receivables/close > 401s without a session, ...
TypeError: (0 , GET) is not a function
 ❯ tests/receivables-routes.test.ts:606:19
```

(The other `close/*` describe blocks in the same run also failed, expectedly — `closeRoute`/
`glReadyClosedJuly` depend on the same two stashed files.) `git stash pop` restored both files;
re-run was GREEN (11 passed in that file's `close` describe blocks, 0 failed).

## A bug caught and fixed before commit

My first `Edit` inserted `listClosePeriods` (with its own new docblock) **between** `reopenPeriod`'s
pre-existing docblock and the `reopenPeriod` function itself — syntactically valid (both are separate
top-level statements) but semantically wrong: the "Reopen a closed month…" comment would have ended up
documenting `listClosePeriods`, and `reopenPeriod` would have had no docblock immediately above it.
Caught on a self-review re-read of the diff before committing; fixed by moving the whole
`listClosePeriods` block (docblock + function) above `reopenPeriod`'s original docblock, restoring the
one-docblock-per-function pairing. Re-verified with `git diff` — `reopenPeriod`'s docblock is back
immediately above its function, `listClosePeriods` has its own directly above it.

## Gate results

- `npx vitest run tests/receivables-routes.test.ts tests/close-periods.test.ts` → **41 passed** (0 failed).
- **Full `npm test`** → 125 files, **1938 passed**, 0 failed (run before the browser session; re-run
  after the docblock fix on the two targeted files above — same pass count, no regression from the
  reorder since it changed no code, only comment placement).
- `npx tsc --noEmit` → clean. `npx eslint src tests` → clean.
- `npm run build` → clean; `/receivables/close` (static) and `/api/receivables/close` (dynamic) both
  appear in the route manifest.
- **`npm run test:e2e` (foreground)** → **all 17 flows PASS** (exit 0). No flow yet exercises
  `/receivables/close` itself — that lands in Task 9 per the brief.

## Browser verification (mandatory for this UI task)

`preview_start`'d `npm run dev` (port 3000), signed in as `admin`/`admin`.

**Found and fixed a pre-existing DEV-database staleness, not a code bug:** `/api/auth/me` showed the
Admin role missing the entire `receivables.*` grant (every other area was granted). `prisma/seed.ts`
grants `ALL_PERMISSIONS` — including `receivables` — so this is a DEV database seeded before the
`receivables` area existed in `AREAS` (an old seed run, never re-applied). Fixed through the actual
`/admin/roles` screen (checked the four `receivables` boxes for Admin), which is exactly the app's own
recovery path — re-running `npm run db:seed` would have produced the identical grants (it's an
idempotent upsert). This isn't a Task 8 fixture; it's now the correct, intended full-admin state, so I
left it granted rather than reverting it.

**Seeded fixtures** (`tmp-seed-close-demo.ts`, run via `tsx`, then deleted — never committed): two GL
accounts (A/R, Revenue), a `ProcessStepCode` with the revenue account, a `PaymentType` **deliberately
left without a GL account** (to produce a real readiness gap), `BillingConfig.arGlAccountId` set, a
customer, a SHIPPED order, a FINALIZED July invoice ($500, one OPERATION line with the revenue
account), a POSTED receipt batch, a $300 payment, and its PAYMENT application.

**End-to-end flow, verified via DOM/network inspection (see below on screenshots):**
1. Opened `/receivables/close` — picker defaulted to **July 2026** (the completed month before
   today's August 2026). Continuity schedule rendered exactly as expected: Beginning 0.00, +Invoiced
   500.00, −Payments 300.00, =Ending 200.00, **Aging ending A/R (independent check) 200.00, Variance
   0.00** — the two independent derivations agreed.
2. Readiness panel showed the seeded gap: *"Payment type Check (demo) has no GL account — Fix"*, with
   a working Export-to-Excel link.
3. **Close** button was enabled (no title) — variance 0, genesis close (no prior month), admin holds
   both permission and the special. Clicked it: period became CLOSED, appeared in the closed-periods
   list with frozen figures matching the schedule, and "This period is already closed — closing again
   re-freezes its schedule" appeared (the re-close-is-idempotent behavior, not a block).
4. **Export to GL** on the new row was correctly **disabled**: `title="1 GL account gap must be
   resolved first"` (verified via `button.disabled`/`button.title` in-page, not just visually).
5. Clicked the readiness gap's **Fix** link → landed on `/admin/reference` (confirmed via
   `get_page_text`). The generic `ReferenceTable` component turned out to support editing an FK field
   only on the **new-row draft**, not on an existing row — a pre-existing app limitation unrelated to
   this task, not something to fix here. Set the payment type's GL account via a one-line `tsx`
   script instead (the same seeding mechanism, not a UI bypass of anything this task owns).
6. Reloaded `/receivables/close`: readiness now read *"No GL account gaps for this period — ready to
   export once closed."* and **Export to GL** was enabled (`disabled:false`).
7. Clicked **Export to GL**: succeeded, `Export #1000` appeared with **File** and **Register** links.
   Verified both directly: `GET .../file` → `200`, `content-type: text/csv`,
   `content-disposition: attachment; filename="gl-2026-07.csv"`, body is a correctly-balanced CSV
   (500/500 sales lines, 300/300 cash lines). `GET .../register` → `200`,
   `content-type: application/pdf`, `content-disposition: inline; filename="gl-register-2026-07.pdf"`,
   19335 bytes.
8. Clicked **Reopen** (native `confirm`/`prompt` auto-accepted via a page-scoped JS override, since
   this browser tool has no dialog-handling API): status flipped to REOPENED; **Reopen** became
   disabled (`title="Already reopened"`) and **Export to GL** became disabled
   (`title="Must be closed (not reopened) to export"`) — both exactly as designed. Re-clicked
   **Close** to restore CLOSED (idempotent re-freeze), leaving the batch and its links intact.
9. Checked `read_console_messages({onlyErrors:true})` and `read_network_requests` at every step —
   zero console errors, zero failed requests, throughout.

**Cleanup:** all seeded fixtures deleted from the DEV `erp` database (`tmp-cleanup-close-demo.ts`, then
also deleted; never committed) — `ClosePeriod`/`GlExportBatch`/`GlPosting`/`Application`/`Payment`/
`ReceiptBatch`/`Invoice`/`Order`/`Customer`/the demo `PaymentType`/`ProcessStepCode`/the two `GlAccount`
rows all removed, `BillingConfig.arGlAccountId` reset to `null`. Verified via a fresh count query
(all zero) before finishing.

**Screenshot:** the Browser pane in this environment would not composite frames
(`computer{action:"screenshot"}` timed out every attempt — "the Browser pane is not displayed" — even
after `resize_window`), so a pixel screenshot could not be captured. In its place, verification was
done via `read_page`/`get_page_text` (full accessibility-tree and rendered-text dumps at every step),
direct in-page `fetch()` assertions on response status/headers/bytes, and `button.disabled`/
`button.title` DOM checks — the same facts a screenshot would show, captured as text evidence above
rather than as an image.

## Self-review

- Reachability: every Task 5-7 capability is now wired to this screen — preliminary, readiness (JSON
  + xlsx), close, reopen, export, file download, register download, and the new closed-periods list.
  Nothing shipped API-only (the Phase 5B lesson this task exists to not repeat).
- No `src/server/**` import in `Close.tsx` — all types are local mirrors (`ContinuitySchedule`/
  `PreliminaryReport`/`ReadinessGap`/`ExportBatchSummary`/`ClosePeriodListItem`/`ClosePeriodDetail`).
- Every disabled control has a `title`; every fetch effect goes through `useLatest()`; no silent
  `.catch(() => {})` — errors land in `error`/`closeError`/`reopenError`/`exportError` state and render
  in banners.
- `listClosePeriods` deliberately does NOT wrap in `withDbErrors` (matches `listBatches`'s plain-read
  precedent, not the mutators' `withDbErrors`+lock shape) — nothing about a `findMany` needs Prisma
  error translation.

## Concerns / follow-ups (none blocking)

- The Export button's readiness-driven disable only reflects a fresh gap count for the row matching
  the picker's own month (documented in-code); a historical closed period's Export button is
  permission/status-gated only, and a real gap on it still surfaces as the server's 409 in the error
  banner rather than as a pre-emptive disable. Deliberate scope choice, not a bug — flagging for the
  whole-branch review in case a per-row readiness fetch is wanted later.
- Task 9 (E2E flow for this screen) is next per the brief; none of today's manual browser flow is
  captured as an automated Playwright flow yet.
