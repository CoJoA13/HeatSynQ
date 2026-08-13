# Task 5 brief — Eligibility leaf + order-side auto-link (rulings 5–7)

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-11 · **Depends on:** Tasks 1–4

**Binding documents (read in this order):**
1. `CLAUDE.md` — row-lock rules, the multi-order claim rule, the concurrency-test rule.
2. `docs/superpowers/specs/2026-08-10-phase-6-quoting-design.md` — §3 rulings 5, 6, 7; §5.2 (the whole section is your contract).
3. `docs/superpowers/plans/2026-08-10-phase-6-quoting.md` — Global Constraints + Task 5.
4. `docs/execution/2026-08-10-phase-6-quoting/task-04-report.md` — the isolation decision you are now the counterparty to, `applyQuoteLines`' id-stability guarantee, and the §5.14 refusal shapes.

## ⚠️ MANDATORY: the §5.14 SSI pairing contract (Task 4's review, Important #1)

Task 4's `updateQuote`/`deleteQuote` guard "no dropping/re-pointing a linked quote line" with a cross-table predicate read (order lines referencing the quote's lines) inside a **Serializable** transaction. The other half of that guarantee is YOURS: SSI only aborts the racing pair if the link writer (the order save that sets `OrderLine.quoteLineId`) **(a) runs Serializable AND (b) reads the quote line it links inside that same transaction** — without the read there is only one rw-antidependency edge, no cycle, and SSI catches nothing. orders.ts is already Serializable everywhere, but its own comments say "Serializable for uniformity", which is exactly what a future refactor would cite to downgrade it. You must:

1. **Amend the orders.ts isolation comment** (near its Serializable transaction options): one or two sentences stating the §5.14 quote-link pairing is now load-bearing — naming BOTH halves (the isolation level AND the in-transaction eligibility read of the quote line).
2. **Ship the dangerous-direction test**: the link writer pinned to Read Committed while a Serializable `updateQuote` drops the linked line → both commit (the link lands pointing at a dead line) → that is the RED; restored to Serializable → one side aborts (409) or serializes correctly. This is the close-periods STANDING-INVARIANT pattern; narrate it in the report.
3. While in that comment area, add the reviewer's sanctioned one-liner: a link committing concurrently onto a just-closed quote is **spec-sanctioned** (judged-at-link-time, the `OrderLine.quoteLineId` schema comment) — so a future "no links to CLOSED quotes" hardening knows it is NOT already guaranteed by isolation.

## What to build (plan Task 5, spec §5.2)

1. **`erp/src/server/quote-links.ts` — a dependency-free LEAF** (imports Prisma types only; no quotes.ts/orders.ts/invoices.ts imports; throws nothing; checks no permission — the `order-locks.ts`/`invoice-guards.ts` precedent):
   - The eligibility predicate, ONE place: quote `OPEN` + live, quote line live + `partId` set, quote.customerId = the order's customer, `effectiveDate ≤ receivedDate ≤ expiryDate` (inclusive both ends).
   - `eligibleQuoteLines(db, customerId, partId, receivedDate)` — ordered latest-`effectiveDate` first, tie → higher `quoteNumber` (ruling 7), returning what the entry UI needs (quote id/number/dates + line id).
   - `resolveAutoLink(db, ...)` — first of that ordering or null.
   - `linkedOpenOrders` already lives quote-side (Task 4's `quoteOrderBlockers`/`linkedOpenOrdersFor`) — do NOT duplicate it; if consolidation into the leaf is cleaner, move it WITH its tests and leave quotes.ts importing the leaf (leaf direction stays legal), documenting the move.
2. **orders.ts integration** — inside the existing one-transaction save, NOT a rewrite:
   - `createOrder`: per line — payload `quoteLineId` **explicit id** → validate the full eligibility predicate against THIS order's customer/receivedDate/part (400 naming the line position and the failing reason); **explicit null** → no link; **field absent** → `resolveAutoLink`. The eligibility read runs on the order tx's client (this IS the SSI read — see the mandatory section).
   - `addLine`: same three-way semantics. `updateLine`: a part swap clears + re-resolves (absent-field semantics); an explicit `quoteLineId`/null in the updateLine payload behaves as in create.
   - Received-date edits do NOT re-judge stored links (ruling 6) — test proves the link survives an edit that moves receivedDate outside the quote window.
   - The idempotent replay (clientRequestId) returns the same links.
   - Voided-order paths and everything else untouched.
3. **`GET /api/quotes/eligible?customerId=&partId=&receivedDate=`** — session + `orders`-area view (it serves order entry, not quote management — cite the §5.15 reasoning in a comment), returning the ordered candidates plus which one auto-resolves. Thin route; zod query parsing; ctx tests.
4. **Order read payloads** (detail + the entry-serving reads): expose per-line `quoteLineId`, quote number, and quote id for display. Keep it minimal — Task 9 builds the UI.
5. **Tests (TDD):** the predicate's every edge in the leaf's own file (closed, expired at both boundaries INCLUSIVE, soft-deleted quote/line, wrong customer, free-text line, tie-break by quoteNumber, latest-effective ordering); create/addLine/updateLine three-way semantics; the explicit-id validation failures (each names position + reason); link survival across received-date edits; replay identity; the MANDATORY dangerous-direction test; audit — the order's audit snapshot showing the link (check whether SNAPSHOT_INCLUDE.order needs the quote relation named to make link changes visible in history, and extend it if so — that is in-scope for this task).

## Hard constraints

- Commands from `erp/`; conventional commits, no trailer; no schema changes (STOP and report); don't touch `erp/.claude/`.
- The eligibility predicate exists ONCE. quotes.ts's own close-warning query stays where Task 4 put it unless you consolidate deliberately (see 1).
- Gates: `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`. Order-entry behavior changes → run `npm run test:e2e` (the existing order flows must stay green; clear dev-DB fixtures).
- Update `progress.md`'s Task 5 row in your final commit.

## Report

`docs/execution/2026-08-10-phase-6-quoting/task-05-report.md`: what you built; the MANDATORY items' narration (comment text, dangerous-direction RED story); the SNAPSHOT_INCLUDE.order finding; consolidation decision on linkedOpenOrders; deviations; gate + E2E results with counts; scrutiny pointers. Commit it.
