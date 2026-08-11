# Task 6 brief — Tier-1 substitution at invoice assembly + the frozen source (rulings 4, 8)

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-11 · **Depends on:** Tasks 1–5

**Binding documents (read in this order):**
1. `CLAUDE.md` — the frozen-invoice rule ("read UNCONDITIONALLY"), the #60 lesson (reads on the tx's own client, inside the snapshot).
2. `docs/superpowers/specs/2026-08-10-phase-6-quoting-design.md` — §3 rulings 4 and 8; §5.3 (your contract, whole); §4.2 (`InvoiceLine.sourceQuoteNumber`, the engine pass-through).
3. `docs/superpowers/plans/2026-08-10-phase-6-quoting.md` — Global Constraints + Task 6.
4. Task 4's + Task 5's reports — `applyQuoteLines`' id stability and the dangling-grandchildren shape (live prices can exist under soft-deleted lines: **every read you add must be keyed through live parents**), and the link semantics you now consume.

**Deliverable:** tier 1 live end-to-end — a linked order line invoices from its quote's rows, wholesale, with the quote number frozen onto the invoice line and displayed everywhere the source shows. This is the phase's point; treat every choice as money.

## What to build (plan Task 6, spec §5.3)

1. **`pricing.ts` (pure engine):** `PriceRowInput` gains optional `priceSource` (default `"PART_PRICE"`) and `sourceQuoteNumber` (default null); `priceOrder` emits them onto the OPERATION `ComputedLine` instead of hardcoding. NO math changes — the existing suite green is the proof. Add engine-level tests only for the pass-through (both defaulted and supplied).
2. **`invoices.ts` assembly — BOTH build sites** (the per-line builder around `listPartPrices(ol.partId)` and the lead-price path further down; find every site that assembles `PriceRowInput[]`):
   - If the order line carries a `quoteLineId` whose quote line is **live**: build the rows from that line's **live** `QuotePrice` rows (deletedAt-filtered, ordered by position) with their **live** breaks (through live parents only — the Task 4 dangling-grandchildren shape), `pricePer`/setup/unit/minimum mapped 1:1, GL resolved from each row's step code **exactly the way `listPartPrices` resolves it** (read that function first; mirror its glAccount sourcing and its ordering conventions), `priceSource: "QUOTE"`, `sourceQuoteNumber: quote.quoteNumber`.
   - **Wholesale** (ruling 4): when the link is taken, the part's rows are not fetched, not merged, not fallen back to. A linked line whose quote line has ZERO live rows produces the empty-array needs-price branch — RED-verify by asserting the part's rows do NOT appear when the quote link exists but carries no rows.
   - **Invariant assert**: `quoteLine.partId === orderLine.partId` — on mismatch THROW a plain Error (a bug, not an HttpError; the handler's 500 is correct for it). A link pointing at a soft-deleted quote line: decide from spec §5.2/§5.14 reasoning (Task 4 blocks deleting linked lines, so a dead linked line should be impossible — treat like the mismatch? or fall to part rows?) — do NOT silently re-price; document your decision and test it.
   - All reads on the invoice transaction's own client (the #60 lesson — SSI must see a concurrent quote edit).
3. **Persistence + freeze:** `InvoiceLine.sourceQuoteNumber` written at line write (already in schema); `createCredit`'s line copy carries it; recalculate-under-unlock re-resolves from live state (ruling 8 — link honored, current quote rows). Display reads the FROZEN column **unconditionally** — never a live join to the quote (the frozen-paper rule).
4. **Display:** wherever an invoice line's `priceSource` shows today (invoice UI grid + the invoice/credit PDF builder — find every site that renders `PRICE_SOURCE_LABELS` or priceSource), a QUOTE line shows "Quote #<sourceQuoteNumber>". Keep the label mechanism consistent with the existing one (extend `PRICE_SOURCE_LABELS` use, with the number appended where the design shows sources).
5. **Tests (TDD, `erp/tests/quote-pricing.test.ts` + engine additions):**
   - Wholesale substitution (quote rows only; part rows asserted absent).
   - Empty-linked-quote → needs-price, not part fallback (RED-verified).
   - Live-until-finalize: edit the quote's rows → a NEW invoice reflects the edit; a FINALIZED invoice's lines unchanged; unlock → recalculate picks up current quote rows.
   - Frozen display: finalize, then soft-delete the quote (unlink orders first or fabricate legally) → the invoice line still reads "Quote #N" from its own column.
   - Credit copy carries `sourceQuoteNumber`.
   - Surcharges compute over quote-priced operations (scope include/exclude by step code) unchanged.
   - Breaks/minimum-floor/setup-on-top on quote rows through the real engine (quote-shaped fixtures).
   - The partId-mismatch assert (fabricate the corrupt state raw; expect the throw).
   - Audit/no-regression: the full existing invoice suite stays green untouched — if any existing test needs editing, that is a red flag to explain in the report.

## Hard constraints

- Commands from `erp/`; conventional commits, no trailer; NO schema changes (STOP and report); don't touch `erp/.claude/`.
- Gates: `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`, AND `npm run test:e2e` (invoice UI/PDF display changed; existing flows must stay green; clear dev-DB fixtures).
- Update `progress.md`'s Task 6 row in your final commit.

## Report

`docs/execution/2026-08-10-phase-6-quoting/task-06-report.md`: what you built; every assembly site you found and touched; the dead-linked-line decision with citations; the RED narrations (empty-quote fallback, and anything else you RED-verified); how display sites were found exhaustively; deviations; gate + E2E results with counts; scrutiny pointers. Commit it.
