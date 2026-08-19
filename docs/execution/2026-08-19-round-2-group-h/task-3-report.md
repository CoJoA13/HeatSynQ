# Task 3 — #100 items 1, 2, 5, 8, 9 + #101 — the quoting surface — implementer report

Branch `group-h-polish`. TDD per item (failing test → watch it fail for the right reason →
implement → pass → commit); explicit-pathspec commits only.

## #100 item 1 — empty effective PATCH mints no audit entry — `486123b`

- **Landed:** `erp/src/server/quotes.ts` (updateQuote, ~:1336): when the effective patch is
  empty (`Object.keys(patch).length === 0 && data.lines === undefined` — covers both the
  tolerated `customerId=<current>` echo and the bare `{}` PATCH), the `auditedUpdate` wrapper is
  skipped entirely; the fall-through to `readDetail` + `overlapWarnings` is unchanged, so every
  update response still carries the advisory surface.
- **Test:** `erp/tests/quotes.test.ts` ("an EMPTY effective patch mints NO audit entry…"),
  TDD by audit-row count: echo and `{}` leave the count untouched; a real field change mints
  exactly one entry; the echo's response still answers `warnings`.
- **RED evidence:** `expected 2 to be 1` — the `customerId=<current>` PATCH minted an entry
  (count 1 → 2) before the fix.

## #100 item 2 — SSI test's 200ms sleep → bounded lock-state poll — `096d200` (test-only)

- **Landed:** `erp/tests/quote-links.test.ts` (~:622): the fixed
  `setTimeout(…, 200)` is replaced by a bounded poll (25ms interval, 10s cap) of
  `pg_locks JOIN pg_stat_activity` for a **current-database** backend waiting on an UNGRANTED
  lock — proof the parked save has run its SSI eligibility read and blocked at
  `allocateNumber`'s `SELECT … FOR UPDATE` on the gated counter row. The join to
  `pg_stat_activity.datname = current_database()` is deliberate: a row-lock wait surfaces as an
  ungranted `transactionid` lock whose `pg_locks.database` is NULL, so the database filter has
  to come from the activity view. The ASSERTIONS are untouched (the test was never false-GREEN;
  only the timing gate could false-RED under load).
- **Verification:** six consecutive green runs of the file (26/26 each).

## #100 item 5 — float qty × each-weight products → Decimal(10,4) grain — `2cbca1a`

- **Landed:** `erp/src/server/quotes.ts`: a `round4` helper beside `decEq` (~:1104), applied at
  both computation sites — the engine's synthetic LB basis `shippedWeight` (~:1631) and the PDF
  payload's `totalLbs` (~:1710).
- **Test:** `erp/tests/quote-pdf.test.ts` ("rounds the qty × each-weight products…"): a
  3 × 0.1 LB line's payload carries exactly `0.3` for `totalLbs` AND the $1.00/lb engine amount.
- **RED evidence:** `expected 0.30000000000000004 to be 0.3`.

## #100 item 8 — stale overlap banner + stop-panel dismiss — `485a813` (client-only)

- **Landed:** `erp/src/app/quotes/[id]/QuoteDetail.tsx`: `setOverlapWarnings([])` on the
  SUCCESS paths of both `closeQuote` (~:325) and `reopenQuote` (~:362) — the warnings describe
  a save on an OPEN quote. `erp/src/app/quotes/Quotes.tsx` (~:380): the create stop-panel gains
  a second "Stay on this page" button that clears `createdQuote`, resets the draft, and
  `reloadAll()`s so the new quote appears in the worklists.
- **Deviation (small, deliberate):** the dismiss also resets the draft form
  (`setDraft({customerId:"", partId:"", partNumberText:""})`) beyond the brief's named two
  actions — the panel's own recorded purpose is preventing a stray duplicate create from a
  kept-alive form, and dismissing back into a still-armed form would reopen exactly that hole.
- **Coverage:** pure client state — group-level E2E + review (per the brief; E2E not run here).

## #100 item 9 — suppress the bare Material label (owner ruling 8) — `784dc86`

- **Landed:** `erp/src/server/pdf/quote.ts` (~:464): the guard now also requires
  `line.material !== ""`; the adjacent comment cites ruling 8 (2026-08-12 demo) instead of the
  cert keep-the-label rule it previously (wrongly, post-ruling) claimed. Value-based
  suppression — the template CONTRACT is untouched, so the Phase 7 three-copy drift guard is
  unaffected (stated in the commit message).
- **Tests (TDD first):** `erp/tests/quote-pdf.test.ts` — a blank-material builder case and a
  data-path case (part with no material + free-text line with blank materialText) both pin the
  absence of `"Material: "`; the pre-existing assertions (~:217 builder, ~:329 data) pin that
  the non-blank case still prints.
- **RED evidence:** both new tests failed with `expected '…' not to contain 'Material: '`
  (the bare label present in the definition).

## #101 — eligible route re-gated to orders.view OR quotes.view — `2adda98`

- **Landed:** `erp/src/app/api/quotes/eligible/route.ts`: `mustCan(…, "orders", "view")`
  replaced with inline `can()` checks — `403 "Requires orders.view or quotes.view"` when the
  caller holds neither; the §5.15 doc comment extended to record the route serves TWO screens
  (order entry's resolution preview AND the part page's Active-quotes indicator).
  `erp/src/app/parts/[id]/ActiveQuotesSection.tsx`: computes the same OR
  (`quotes.view || orders.view`); the neither-case §5.16 message names **quotes.view**
  (quotes-area vocabulary on a parts screen, per the ruling).
- **Tests:** `erp/tests/quote-routes.test.ts` (~:367): quotes.view-only INVERTED 403 → 200;
  orders.view kept at 200; new neither-permission case pins status 403 and the exact named
  message. Route + tests in ONE commit (suite green at every commit).
- **RED evidence:** quotes.view-only returned 403 where the inverted test expected 200.
- **Choice documented on the issue** (the ruling's "document whichever"):
  <https://github.com/CoJoA13/HeatSynQ/issues/101#issuecomment-5337993596>.

## Gates (from `erp/`, at committed HEAD `2adda98`)

| Gate | Result |
| --- | --- |
| `npm test` | **PASS — 192 files, 3273 tests, 0 failed** (isolated DB + clean worktree, see note) |
| `npx tsc --noEmit` | PASS |
| `npx eslint src tests` | PASS |
| `npm run test:e2e` | not run — group level, per the brief |

**Shared-environment note (two isolation measures, both temporary):** the three wave-1
implementers share ONE working tree, ONE branch, and ONE `erp_test` database.

1. *Isolated scratch DB.* Concurrent vitest runs from the sibling sessions truncated each
   other's fixtures on the shared `erp_test` (observed live: a 40P01 deadlock inside
   `truncateAll`, plus cross-run failures in tests untouched by this diff that all passed in
   isolation). This task's suite runs therefore used a scratch database `erp_test_t3` (same 51
   migrations, created via `CREATE DATABASE` + `prisma migrate deploy`, injected as
   `DATABASE_URL_TEST`), dropped after the final gate.
2. *Clean worktree at HEAD.* A working-tree full-suite run failed ONE test —
   `tests/customers.test.ts` "cannot form a reciprocal parent cycle from two concurrent
   updates", a 5s timeout, deterministic on re-run. That file has no commits on this branch and
   is untouched by this diff; the tree carried Task 1's UNCOMMITTED in-flight `audit.ts` edit
   (the #9 generic claim — exactly what a two-concurrent-updates race exercises). From a clean
   `git worktree` at committed HEAD the file passes 52/52 and the FULL suite passes 192/3273 —
   pinning the timeout to the uncommitted edit, not to any committed state. **Flagged for
   Task 1:** their in-progress claim ordering deadlocks/blocks the reciprocal-parent race in
   `customers.test.ts` past the 5s timeout.

The group-level gate on the shared DB, after all wave-1 work is committed, still applies before
merge.
