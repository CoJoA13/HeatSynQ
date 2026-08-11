# Task 6 report — Tier-1 substitution at invoice assembly + the frozen source (rulings 4, 8)

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-11 · **Implementer:** Task 6 subagent

## What was built

**Commit 1 — the engine pass-through (`c7eaf2a`).** `PriceRowInput` gains optional `priceSource`
(default `"PART_PRICE"`) and `sourceQuoteNumber` (default `null`); `ComputedLine` gains
`sourceQuoteNumber`; the OPERATION push emits `row.priceSource ?? "PART_PRICE"` /
`row.sourceQuoteNumber ?? null` instead of the hardcoded literal. No math reads either field —
the existing 64 pricing tests green untouched are the proof; 3 new pass-through cases (defaulted,
supplied, and the needs-price line of a rowless order line carrying no source at all).
`pricing.ts` stays a pure leaf (the purity sweep in `pricing.test.ts` still passes).

**Commit 2 — the assembly + persistence (`57917ff`).** In `invoices.ts`:

- **`quotePriceRowInputs(tx, ol)`** — the tier-1 row builder: verifies the linked quote line is
  live under a live quote (else the plain-Error invariant, below), asserts
  `quoteLine.partId === orderLine.partId` (plain Error), then reads the line's LIVE `QuotePrice`
  rows with their LIVE breaks, keyed through the just-verified live parent (the Task 4
  dangling-grandchildren shape — a soft-deleted row's still-live breaks are unreachable by
  construction). GL is resolved from each row's step code **exactly as `listPartPrices` resolves
  it** (same select: `glAccountId` + `glAccount.name ?? ""`), rows ordered
  `position asc, id asc`, breaks `threshold asc` — the tier-2 conventions mirrored 1:1. Every
  read runs on the invoice transaction's OWN `tx` client (the #60 lesson; deliberately unlike
  `listPartPrices` itself, whose bare-client read is the owner-deferred issue #60 and was NOT
  touched). Rows land with `priceSource: "QUOTE"`, `sourceQuoteNumber: quote.quoteNumber`.
- **`buildPricingInput`'s per-line loop branches on `ol.quoteLineId`** — the link taken means the
  part's rows are **not fetched** (ruling 4's wholesale; the `listPartPrices` call is on the other
  arm of the ternary, unreachable for a linked line). Zero live quote rows → `prices: []` → the
  engine's needs-price branch. Because `buildPricingInput` is shared, `recalculateInvoice`
  re-resolves tier 1 live through the same code (ruling 8's unlock-and-recalculate) with no
  second path to drift.
- **The lead-price path branches too**: `createInvoiceInTx`'s `processNames` (the header's
  "Process:") comes from the quote rows' step names when the lead line is linked — the steps the
  invoice actually bills. (`recalculateInvoice` deliberately never rewrites `processNames`; its
  own comment says header snapshots are not touched.)
- **`ORDER_LINE_SELECT`** extracted — one shared select (now carrying `quoteLineId`) for the two
  `orderLine.findMany` reads in create and recalculate, so the two assembly paths cannot see
  different line facts.
- **Persistence end to end**: `InvoiceLineWrite`/`mapComputedLines` carry `sourceQuoteNumber` to
  the row write; `toLineDetail`/`InvoiceLineDetail` expose it; `createCredit`'s line copy carries
  it (sign untouched — it is identity, not money); `recalculateInvoice`'s preserved-manual-lines
  re-create carries it; `LINE_INPUT` + `lineColumns` accept/persist it so the UI grid's
  whole-array lines save cannot blank the frozen number on an unrelated edit;
  `readInvoicePdfData` emits it onto `InvoicePriceRow` (from the frozen column, when
  `priceSource === "QUOTE"`). `tests/quote-pricing.test.ts` — 11 tests (below).

**Commit 3 — display (`b9a0ddb` + the PDF half in `57917ff`).** The invoice/credit PDF's price
block prints a centered "Quote #1006" line (`PRICE_SOURCE_LABELS.QUOTE` + the frozen number)
beneath a quote-priced operation, before its price detail lines; non-quote rows print exactly as
the approved 5A sample (no annotation — sample fidelity). The invoice UI grid's part/operation
rows gain a source sub-label under the description ("Part price" / "Manual" / "Quote #1006" —
`sourceLabel()`, reading `PRICE_SOURCE_LABELS` with the number appended for QUOTE), and the grid
round-trips `sourceQuoteNumber` as a hidden field exactly like `priceSource`.

## Every assembly site found (and how)

`grep -rn "listPartPrices(" src/` and `grep -rln "PriceRowInput" src/`:

1. **`buildPricingInput`'s per-line loop** (`invoices.ts` ~493) — the per-line builder; branched.
   Reached by BOTH `createInvoiceInTx` and `recalculateInvoice`, so one branch covers create and
   recalculate.
2. **`createInvoiceInTx`'s lead-price path** (`invoices.ts` ~748, `processNames`) — branched.
3. `src/app/api/parts/[id]/prices/route.ts` — the parts admin page's own tier-2 price list, not
   invoice assembly; deliberately untouched.

No other file assembles `PriceRowInput[]` (`pricing.ts` only defines the type). The quote PDF's
future indicative-amount path (Task 10) does not exist yet.

## The dead-linked-line decision

**A link pointing at a soft-deleted quote line (or a line under a soft-deleted quote) throws a
plain `Error` — the same class as the partId mismatch — never a fallback to part rows.**
Citations: spec §5.1 refuses deleting a quote line (or quote) any order line references, and
§4.2's `OrderLine.quoteLineId` note says outright "the FK never dangles" because §5.14 blocks the
delete; Task 5 judges every stored link at save time. A dead target at assembly is therefore
corrupt state, constructionally unreachable through the services — a bug, exactly like the
mismatch the spec names a "belt-and-braces invariant". Falling back to part rows would be the
silent re-price §7.5 exists to prevent (ruling 4: the link declared the agreement); an HttpError
would dress a bug as an expected failure. The handler's 500 is the honest answer. Both states are
fabricated raw and tested (plain `Error`, NOT `HttpError`, zero invoices written).

**Corollary documented in code:** the needs-price line of an empty linked quote carries NO source
(`priceSource: null`, `sourceQuoteNumber: null`) — it bills nothing *from* the quote; the flag is
the engine's existing tier-3 shape, unchanged.

## RED narrations

**The empty-linked-quote fallback (the brief's named RED).** The whole `quote-pricing.test.ts`
file was written and run before any `invoices.ts` change: all 11 failed, and the failures narrate
the exact dangers. The empty-quote test (quote line whose only row is soft-deleted; part carrying
a live $9.99 row) invoiced the part's row — `expect(ops[0].needsPrice).toBe(true)` got `false`,
and the part-rows-absent assert would have caught the $1,438.56 (144 × 9.99) line — the precise
silent part-price fallback ruling 4 forbids. The wholesale test failed with the op line carrying
the PART's step-code id and `priceSource: "PART_PRICE"`; both corrupt-state tests failed with
"expected null to be an instance of Error" — pre-implementation, a mismatched or dead link priced
happily from part rows with no throw. Post-implementation all 11 green; the part-rows-absent
asserts (step-code id absent, 1438.56 absent) are the standing RED-shaped guard.

**The engine pass-through.** The 3 pricing tests ran RED first (`sourceQuoteNumber` undefined on
`ComputedLine`; `priceSource` hardcoded), then green after the pass-through landed.

## How display sites were found exhaustively

`grep -rn "PRICE_SOURCE" src/` (the labels were defined in Task 1 but rendered NOWHERE — 5A
carried `priceSource` only as a hidden grid round-trip field), `grep -rn "priceSource" src/app/`
(one file: `InvoiceDetail.tsx`), `grep -rn "InvoiceLineRow\|InvoiceLineDetail" src/` (one client
mirror), and the PDF side by reading `readInvoicePdfData` → `buildInvoiceDefinition` (the one
builder, shared by invoice and credit — the credit's copied lines carry the frozen number, so
credit paper names the quote through the same block). Sites touched: the UI grid's part/operation
rows and the PDF price block. The GL export, statements, and receivables surfaces never render
per-line price sources (verified by the greps above).

## Tests (tests/quote-pricing.test.ts — 11; tests/pricing.test.ts +3)

Wholesale substitution (QUOTE source, frozen number, quote-GL, part rows asserted absent in id
AND amount, `processNames` from the quote); live-parents-only ordering (deleted row's live breaks
never surface, live row's deleted break ignored, position order); empty-linked-quote →
needs-price never part fallback; breaks + minimum-floor + setup-on-top over quote rows through
the real engine (864 → 1000 floor → 1075 with setup); surcharge INCLUDE/EXCLUDE keyed on the
quote row's step code; live-until-finalize (edit → next invoice moves; finalized frozen; unlock →
recalculate → current rows, link honored); frozen display after legal quote deletion (unlink,
delete, invoice + PDF data + rendered definition still say "Quote #1006"); credit copy;
`replaceInvoiceLines` round-trip; the two corrupt-state invariants. The fixture asserts the Task
5 auto-link actually took, so no test can silently pass against an unlinked line.

## Deviations

1. **The UI grid names EVERY operation line's source** ("Part price"/"Manual"/"Quote #N"), not
   only QUOTE lines — §7.5's sentence is "every invoice line names its source (quote #, part
   price, manual)", and this closes what was a 5A display gap while "extending
   PRICE_SOURCE_LABELS use" as the brief words it. The **PDF annotates only QUOTE lines**: the
   5A sample is the ruled print contract and shows no source labels; "Quote #N" is the Phase 6
   spec's own addition (§5.3 names exactly that string), while "Part price" on every printed row
   would be an unruled sample deviation.
2. **`LINE_INPUT`/`lineColumns` + the grid round-trip gained `sourceQuoteNumber`** — not named in
   the brief, but without it any lines save (the UI's whole-array PUT) would silently blank the
   frozen number; test 9 pins the round-trip.
3. **`ORDER_LINE_SELECT` extracted** — a small refactor replacing two identical inline selects so
   create's and recalculate's line reads cannot drift; behavior unchanged.
4. **`InvoicePriceRow.sourceQuoteNumber` is optional** (`?: number | null`) so the existing
   `invoice-pdf.test.ts` literals compile untouched (the no-existing-test-edits rule); absent and
   null render identically (nothing).
5. **Issue #60 untouched**: `listPartPrices` still reads the bare client inside the invoice
   transaction — the owner deferred that defect (HANDOFF, PR #58 triage); the new quote reads do
   it right on `tx`, per the brief.

## Gate results

| Gate | Result |
|---|---|
| `npm test` | **129 files passed, 2084 tests passed, 0 failed** (was 128 / 2070; `quote-pricing.test.ts` new with 11, `pricing.test.ts` 64 → 67) — every pre-existing invoice test green UNTOUCHED |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | ✓ Compiled successfully; 74/74 static pages |
| `npm run test:e2e` | **all 18 flows passed, exit 0** (invoice-shipped-order, receivables-apply-age-statement, close-month-end and the other 15 all green — run because the invoice grid and PDF display changed); dev-DB fixtures cleaned by the harness ("cleanup ok"). A first attempt died with the session turn mid-run (flow 16 aborted by the harness's SIGTERM teardown, fixtures still cleaned — the Task 5 report's identical failure mode); the recorded result is a clean full rerun watched synchronously to completion |

## For the reviewer to scrutinize

- The dead-linked-line decision (plain Error over part-row fallback or HttpError) — the §5.14
  unreachability argument above, and whether the invariant should also fire for zero-net linked
  lines (seam #3 skips them before the branch, so a corrupt link on a nothing-shipped line prices
  nothing and throws nothing — deliberate: nothing is billed, so nothing lies).
- Deviation 1's asymmetry (grid labels all sources; PDF labels only QUOTE) — both halves argued
  from the ruled sample vs §7.5's sentence; the demo is the deviations channel if the owner wants
  the print to say "Part price" too.
- `quotePriceRowInputs` reading `quoteLine.partId` mismatch BEFORE the empty-rows case — a
  mismatched link with zero rows throws rather than needs-pricing (the invariant outranks the
  empty-agreement flag; both are abnormal, one is corrupt).
- The engine's needs-price line carrying no source for an empty linked quote (corollary above) —
  an alternative reading would stamp QUOTE + number on the flag line so the paper says WHICH
  agreement is empty; the warning text and the order line's link already carry that trail.
- `processNames` on recalculate: deliberately NOT re-branched (recalculate never rewrites header
  snapshots — its own §5.5 comment); an unlock-recalculate after a re-link keeps the create-time
  process names.
