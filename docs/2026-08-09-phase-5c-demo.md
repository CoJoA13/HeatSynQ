# Phase 5C demo — Month-end close & QuickBooks Online summary export (2026-08-09)

A walkthrough for the owner: what shipped across the nine tasks of Phase 5C, the 18th E2E flow with
its screenshots, how to watch it live, what changed for daily use, and — named individually, not
left for you to find — the two owner-homework items spec §14 gates the demo on, plus the low-stakes
housekeeping the whole-branch review will triage before this merges.

## What Phase 5C delivered

Your shop can now **close a month's books and hand a bookkeeper a QuickBooks-ready journal.** A
**preliminary closing report** (`/receivables/close`) shows the month's continuity schedule —
beginning A/R + invoiced − credits − payments − discounts − write-offs = ending A/R — reconciled
against an **independent point-in-time aging total** at the same period end; the two must agree
(variance 0) before the month can close. **Close** freezes that schedule into a `ClosePeriod` row and
**locks the month**: every A/R posting mutation (finalize, unlock, a payment, an application, a
credit) dated inside a closed month is refused, naming the period and pointing at reopen. A closed
month is never permanently stuck — **Reopen** (reason required, audited) lifts the lock so a
correction can be posted, and a subsequent re-close/re-export **never double-posts**: only the
*delta* since the last export goes out, and a correction that removes something already sent
generates an automatic **reversing entry**, never a manual fix.

**Export to GL** turns a closed month into a downloadable **summary-journal CSV** (the file the
bookkeeper imports into QuickBooks Online) plus a human-readable **posting register PDF**, both
stored byte-for-byte and re-downloadable forever. The mapping: finalized invoices/credits debit A/R
and credit revenue (+ tax); posted payments debit cash and credit A/R; discounts and write-offs debit
their own accounts and credit A/R — one line per GL account per side, summarized, never a raw
line-by-line dump (detail stays in the ERP). **Readiness** names every account-less step code,
surcharge, payment type, or missing plant default *before* you try to export, each linked to the
record that fixes it, Excel-exportable; export itself is refused, never silently short, if anything
is still missing, and `exportClose` independently asserts the batch balances (Σdebit = Σcredit)
before it ever writes a row. Three new plant-default GL accounts (A/R, discount, write-off — plus the
existing sales-tax account) live in **Admin → Billing**, alongside the freight/other-charge/cert
defaults 5A/5B already put there.

All of it is covered by **the vitest suite** (1938 tests) and the **eighteen-flow Playwright
harness** this task adds the 18th flow to. Spec:
`docs/superpowers/specs/2026-08-09-phase-5c-close-qbo-export-design.md` (7 owner rulings, §3). Plan:
`docs/superpowers/plans/2026-08-09-phase-5c-close-qbo-export.md`. Execution ledger (every task's
brief, report, and review verdict): `docs/execution/2026-08-09-phase-5c-close-qbo-export/`.

**The nine tasks, in build order:** the schema (`ClosePeriod`/`GlExportBatch`/`GlPosting`, six
`BillingConfig → GlAccount` FKs, the `gl_export_batch_number_next` counter, audit/sweep
registration); the `BillingConfig` GL defaults' service + delete-blocker registration + Admin →
Billing UI; `gl-mapping.ts` (the pure journal + readiness engine); `period-locks.ts` wired into every
5A/5B posting mutation; `close-periods.ts` (close/reopen + the reconciliation) + routes;
`gl-export.ts` (the per-event delta + CSV + batch write) + routes; the posting-register PDF; the
`/receivables/close` UI; and this task — the E2E flow, this demo, and the doc updates.

**Four data-integrity/concurrency defects the task reviews caught and fixed on-branch** (full detail
in `docs/HANDOFF.md` §4 and the execution ledger's `progress.md`): a missing sales-tax readiness gap
that could export an unbalanced taxable journal; an unsorted per-payment advisory-lock loop in
`postBatch` that could ABBA-deadlock a multi-month batch; `closePeriod`/`reopenPeriod` briefly built
at Read Committed to pass a sample test, which strips the SSI backstop that keeps a finalize from
leaking into a just-closed month; and a readiness scan that missed FREIGHT/CHARGE/CERT lines plus a
cumulative (rather than strictly per-period) export delta that could double-post an earlier month.
None of these reached a merge — every one was caught by task review and fixed before this state was
recorded. CLAUDE.md's two new house rules ("The period lock" and "The GL-export delta") record the
standing invariants these fixes established, so a future change can't reintroduce them silently.

## The 18th E2E flow

Run with `npm run test:e2e` from `erp/` — this now runs **eighteen** flows in sequence (the
seventeen from Phases 2C–5B, unchanged, plus this one, last). Screenshots and a `video.webm` land in
`erp/e2e-artifacts/close-month-end/` (gitignored — reviewed locally, not committed).

### 18. `close-month-end` — set the GL defaults, close a month, export, reopen/correct/re-export

Sets the four Admin → Billing GL defaults (A/R, discount, write-off, sales tax) through the real
screen. Keys an order for the close fixture's one-operation part (ten units at 100.00 each, no
surcharge or tax — total exactly 1000.00, the `receivables-apply-age-statement.mjs` fixture-math
precedent) and ships it complete, then on `/invoicing` creates and finalizes the invoice. Opens a
deposit batch, adds a **600.00 check**, and applies it: a **400.00 payment**, the **20.00 early-pay
discount** (2% of the 1000.00 open balance, Terms 2/10/30), and a **30.00 write-off** with a typed
reason — leaving **550.00 open** on the invoice and **200.00 on-account**. Before the schedule can
reconcile, both this batch and the earlier `receivables-apply-age-statement.mjs` flow's own batch
(which the close screen's own preliminary report flags as "not yet posted") get **posted** — the real
month-end-prep step a bookkeeper takes, not a workaround.

Opens `/receivables/close` for the current month and confirms — by reading the SAME
`preliminary`/`readiness` endpoints the screen itself renders, not a DOM scrape — that the schedule
**reconciles exactly (variance 0)** and readiness is **clear (0 gaps)**. **Closes** the month, then
**exports**: downloads the emitted CSV and confirms it **balances** (Σdebit = Σcredit, parsed from
the file itself). **Reopens** the month (confirm + reason dialogs), then **voids the write-off
application** — the reachable correction unit; see the flow's own file header for why "void the
payment" itself isn't reachable here (`voidPayment` refuses once its batch is posted, and the batch
has to stay posted for its cash to count in the close at all — §4.1/§6 name `voidApplication` as the
post-reopen correction path). **Re-closes**, **re-exports**, and confirms the second batch's CSV is a
**non-empty, exactly-balanced reversing delta** — precisely the voided 30.00 write-off, debit and
credit both, `isReversal` both lines — untouched by anything else finalized in the same month.

**Demonstrates:** the whole close→export→reopen→correct→re-export lifecycle in one pass (§4.1/§4.3),
the roll-forward-vs-aging reconciliation (§6), the readiness refusal and the balance backstop (§7),
and the per-event delta's idempotency and reversal-safety (§4.3) — a re-export with nothing changed
would emit nothing; a correction emits exactly its own reversing entry, nothing more.

Artifacts: `erp/e2e-artifacts/close-month-end/02-billing-gl-defaults-set.png` through
`18-exported-second.png` (18 screenshots in all, including `07-batch-created.png`), `video.webm`.

*(The same disclosure the 5A/5B demos gave, since it still applies: these come from the Playwright
harness's own `page.screenshot()` calls, run as real headless Chromium against a real `next dev` +
database — not hand-captured through an interactive browser tool for this document. Every PNG named
above is a byte-real file on disk after the run below.)*

## Two real bugs this task's own development found and fixed

Both in the E2E harness itself, not the application — worth recording because the fixes are
precedents future flows need, the same spirit as the 5B demo's own harness-bug section.

1. **A second `page.on("dialog", …)` listener on the same page crashes Playwright, not just the
   app.** `armDialog`/`armPrompt` (`e2e/lib/ui.mjs`) each register a *persistent* listener that is
   never removed — fine for every existing flow, which arms exactly one dialog per run. This flow
   needs THREE separate dialog sequences on one page (two batch-post confirms, a reopen
   confirm+prompt pair, then a void prompt); a second `armDialog`/`armPrompt` call left the FIRST
   listener still registered, and when a later dialog fired, both listeners tried to accept the SAME
   dialog object — `dialog.accept: Cannot accept dialog which is already handled!`, an *uncaught*
   promise rejection that crashed the whole harness process outright (bypassing even the normal
   per-flow try/catch and the fixture cleanup in `run.mjs`'s `finally` block). Fixed with two local,
   self-removing `page.once`-based helpers (`armConfirmOnce`, `armReopenDialogs`) instead of reusing
   the shared, single-use-per-flow `armDialog`/`armPrompt` for a flow that needs to arm dialogs more
   than once.
2. **A `<th>` column header shared between two nested tables makes `ancestor::table[1]` resolve to
   BOTH of them.** The receivables batch page nests three tables inside one payment row's expanded
   panel — a Payments-list table, an existing-applications table, and a candidate-invoices grid — and
   the existing-applications table's own "Type" column header text is *also* the OUTER Payments
   table's own "Type" (payment type) column header. `getByRole("columnheader", { name: "Type" }).
   locator("xpath=ancestor::table[1]")` (the exact technique that worked cleanly for the candidate
   grid's *unique* "Write-off" header, both here and in the 5B flow) matched BOTH headers and so
   resolved to two different tables — a strict-mode violation once the row filter beneath it ran
   across both. Fixed by locating the panel's own root `<div>` via its unique summary line instead,
   then taking that div's first nested `<table>` (JSX order guarantees the applications table renders
   before the candidate grid) — sidestepping column-header ambiguity entirely rather than chasing a
   more specific header string that might not stay unique as the page grows.

A third thing worth naming, not a bug: `close-periods.ts`'s continuity schedule and `gl-export.ts`'s
readiness/delta are **global per month, not scoped to any one customer** (by design — a real close
covers every customer's paper). This flow runs 18th, after `receivables-apply-age-statement.mjs`
(17th), whose own invoice stays FINALIZED (never unlocked) for the rest of a run and so lands inside
the SAME calendar month's close scope — its step code and payment type needed a GL account backfilled
in `db-fixtures.ts`'s `create()` (before any flow runs) or this flow's own export would be refused by
a readiness gap that isn't its fixture's to fix. Documented in both files; not a defect, a consequence
of the close being month-wide by design.

## Seed state

Nothing beyond the standard seed: `npm run db:seed`. The E2E run creates its own throwaway fixtures
in the dev database — on top of the existing fixture customers, this task adds a close-flow customer
(`E2ECLOSECUST`, `taxable: false`, `surchargeOptOut: true`) with one priced operation (`E2E-CLOSE-OP`,
unit price 100.00, its own revenue GL account), a dedicated **2/10/30 Terms** row, a payment type
(`E2E Close Check`, its own cash GL account), and six dedicated GL accounts (revenue, A/R, discount,
write-off, sales tax, cash) — plus, as noted above, a one-line backfill of the Phase 5B AR fixture's
own step code and payment type with a GL account apiece, so this flow's export isn't blocked by a
sibling flow's deliberately-account-less fixture. Everything is torn back out afterward — the
invoice, the batch, the payment, the applications, the shipment, the order, the `ClosePeriod` and its
`GlExportBatch`/`GlPosting` rows, the six GL accounts, the Terms row, the payment type, and every
audit row — on success, on a thrown error, or on Ctrl-C mid-run. `BillingConfig`'s four GL-default
columns are restored to whatever they held before this run touched them (the one shared singleton row
this flow has no choice but to mutate through the real UI — the four fields have no per-customer
escape hatch the way `salesTaxRate` does for the 5A/5B fixtures).

**One accepted, documented gap** (see `e2e/lib/db-fixtures.ts`'s `deleteClosePeriodFixture` comment):
unlike every other fixture in this harness, cleanup for `ClosePeriod`/`GlExportBatch`/`GlPosting` is
id-driven from THIS run's own `(year, month)`, not name-based self-healing — a `ClosePeriod` carries
no fixture-recognizable name of its own, so a broader sweep would risk touching a real close a
developer makes by hand after this feature ships. Two things together keep cleanup from ever
hard-deleting a REAL close it merely observed: the pre-flight guard refuses to POST into a month that
already has a `ClosePeriod` (correctly — a real one, say the owner closing the current month through
the live UI this same doc's "watching it live" section invites, must never be POSTed into again), and
— the part that actually protects *cleanup*, fixed in this task's review round — the flow only ever
records that `(year, month)` for cleanup AFTER its own `closePeriod` POST has committed, so a guard
failure (or anything earlier) leaves cleanup nothing to delete; `deleteClosePeriodFixture` also checks
`closedById` against this run's own fixture admin as a second, independent belt. A crash hard enough
to skip this flow's own cleanup AFTER a successful close would still leave that one row behind for a
human to clear by hand (`GET /api/receivables/close`), same as this harness's other documented
not-fully-airtight gaps — but it is always a row this run itself created, never a pre-existing one.

## Watching it live

- **Headed Playwright, watch the bundled Chromium click through all eighteen flows:**
  `HEADED=1 npm run test:e2e` from `erp/` — same fixtures and cleanup, just a visible browser.
- **Interactively in your own browser** against `npm run dev` — ask for a specific thing (e.g. "set
  the GL defaults, close last month, export it, then reopen and void a write-off") and it'll be
  driven live in a real Chrome window.

## What changed for daily use

- **A new `/receivables/close` screen** (Receivables nav) — a year/month picker with the continuity
  schedule and an independent aging cross-check, a readiness panel naming every account gap (linked
  to the fix, Excel-exportable), **Close**, and a **Closed periods** list with each period's frozen
  figures, **Reopen** (reason required), **Export to GL**, and download links for every export
  batch's file and posting register, forever.
- **Admin → Billing** gains three new plant-default GL account fields — **A/R**, **Discount**, and
  **Write-off** — alongside the existing sales-tax/freight/other-charge/cert defaults.
- Finalizing/unlocking an invoice, raising/discarding a credit, posting/voiding a payment or batch,
  and creating/voiding an application are all now **refused into a closed month**, naming the period
  and pointing at reopen.
- Two new named permissions gate the dangerous actions: **`close_ar_period`** (close, reopen) and
  **`run_qbo_export`** (export) — both on top of `receivables.edit`; no new permission *area* (the
  close lives under the existing `receivables` area, the same "nothing to grant, nothing to forget"
  reasoning 5B's own permission model used).

## Two things you owe before a real export (spec §14) — restated here so nothing is left for you to find

These gate the **demo**, not the spec or the build: every test and this flow itself run clean on
seeded, dev-fixture GL accounts. They gate whether a *real* export means anything.

### 1. The real GL account list — operations, surcharges, payment types, and the three plant defaults

Every process step code (operation), every surcharge, every payment type, and the A/R/discount/
write-off plant defaults need a real chart-of-accounts number keyed in before an export is anything
but seeded test data. The export **refuses** rather than posting a line with no account (§7) — so
nothing breaks if this isn't done, but nothing useful comes out either. This is data entry, not code;
`docs/HANDOFF.md` §7 item 4 has tracked it since Phase 2.

### 2. The bookkeeper's QuickBooks Online import method, and ruling 7's correction-date question

Two things only the bookkeeper can answer: **which QBO import path** the summary-journal CSV needs to
match column-for-column (a summary-journal CSV is the working default, unconfirmed), and **whether a
correction posted into an already-imported month should date at that month's period-end** (the
current, built behavior) **or at the current open period instead** (ruling 7's open half — you were
checking this with the bookkeeper as of 2026-08-10). Until you confirm, the file stays a documented
CSV and every correction dates at period-end.

## Housekeeping for the whole-branch review to triage (not open decisions — just visibility)

Small, cosmetic, all flagged by their own task's review as safe to leave for a one-pass cleanup
rather than fix piecemeal — named here so nothing from the ledger is a surprise later:

- **A stale FK-count comment SIBLING GROUP** — `schema.prisma`'s `BillingConfig` comment ("Three
  separate FKs…", now six) and `reference-links.ts`'s `BILLING_CONFIG_BLOCKER` comment ("four FKs",
  now seven) — both one-word touch-ups, flagged together for the same pass (Tasks 1–2).
- The `partial-unique-sweep` `ALLOWED` entry for `GlExportBatch.exportNumber` is inert (the table
  isn't soft-deletable) — brief-required, documents intent, mirrors the `ReceiptBatch.batchNumber`
  precedent (Task 1).
- `retryOnSerializationConflict` retries on *any* P2002 inside `closePeriod`/`reopenPeriod`, not only
  the one reachable unique constraint — harmless today, but a genuinely non-transient P2002 would
  spin the full retry budget before surfacing (Task 5).
- A frozen null-GL freight/charge line (finalized before its plant default was set) reads "clean" on
  today's readiness check (which reads the CURRENT config) but still throws when exported — self-
  protecting, no bad batch reaches QBO, but the panel doesn't name the real blocker (the invoice needs
  unlock + re-finalize). An empty no-op export still burns an export number and writes a zero-posting
  batch. `parseReadinessPeriod`'s year floor (`>= 2000`) is an arbitrary sanity bound, not a presence
  check (Task 6).
- The posting-register PDF renders money blank-for-zero with no `$` symbol — deliberately
  register-appropriate, but a stylistic outlier next to the statement/invoice `money()` convention
  (Task 7).
- The Export button's live readiness-gap count is only fresh for the month currently under the
  picker; a historical closed-period row relies on the server's own 409 refusal, which is safe by
  construction but not a live-updating count (Task 8).

## Gate results this doc is based on

All four quality gates plus the E2E suite were run clean on the `phase-5c-close-qbo-export` branch
immediately before writing this doc: `npm test` — **1938 tests, 125 files, all passing**; `npx tsc
--noEmit` clean; `npx eslint src tests` clean (`npx eslint src tests e2e` carries one pre-existing,
unrelated warning in `cert-results-print.mjs`, same as the 5B demo noted); `npm run build` clean; and
`npm run test:e2e` — **18/18** flows passed (one earlier run hit a transient strict-mode collision in
the PRE-EXISTING, unmodified `invoice-shipped-order.mjs` flow — two unrelated board cells briefly
sharing the same rendered text on a heavily-reused dev database — which did not reproduce on
immediate re-run and touches no file this task changed). Migrations: **30** total (one new since
Phase 5B's 29 — `20260809130000_phase_5c_close_and_gl_export`, Task 1), both databases report no
pending migrations.
