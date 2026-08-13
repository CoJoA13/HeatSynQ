# Task 2 brief — The billing-side contracts (cert, invoice, statement, quote)

**Branch:** `phase-7-template-designer` (Task 1 APPROVED at `605797b`; the machinery in `erp/src/lib/template-contracts/` is yours to build on).
**Read first, in this order:** `CLAUDE.md`; the approved spec `docs/superpowers/specs/2026-08-12-phase-7-template-designer-design.md` §5.3 + §5.6 + §3 ruling 3; the plan `docs/superpowers/plans/2026-08-12-phase-7-template-designer.md` — Global Constraints + Task 2; **Task 1's report** `docs/execution/2026-08-12-phase-7-template-designer/task-01-report.md` (the machinery's shape, the zero-field-section precedent, the notes it left you); the ledger's "Carried minors" section (`progress.md` — one is YOURS, see below). Then the four builders you are deriving contracts from: `erp/src/server/pdf/cert.ts`, `erp/src/server/pdf/invoice.ts`, `erp/src/server/pdf/statement.ts`, `erp/src/server/pdf/quote.ts` (+ their `<Doc>Data` types, and `erp/src/lib/ar-constants.ts` for the statement's aging labels).

## Deliverable

1. **`erp/src/lib/template-contracts/{cert,invoice,statement,quote}.ts`** — same client-safe, pure-declaration rules as Task 1 (NO `src/server/**` imports; copy any settings-default literal, never import the server module). Each ends in a `DEFAULT_CONFIG` reproducing today's hardcoded builder values EXACTLY (labels, widths, fonts, date/number styles, text defaults). Register all four in `index.ts`'s `CONTRACTS`; update the test file's `REGISTERED` list to eight.
   - **Cert** (spec §2's constraint, test-pinned): internal no-print notes NEVER appear as a field — add the test asserting the contract omits them. `cert_statement` is a text block (default = the code default literal from `settings.ts`, copied). The signature block is a section; its rendering semantics are the builder's (Task 11 consumes; you only declare).
   - **Invoice**: fields map ONLY to the frozen snapshot columns — add the test that walks the contract's field keys against `InvoicePdfData` (the type in `pdf/invoice.ts`) and fails on any key with no frozen source. Credits are covered by this contract (spec §4.1); ruling 3's `negativeStyle` knob binds here — today's value is the `$-937.44` style (5A ruling: sign between $ and digits); enumerate the fixed picker options (at minimum: `sign-after-symbol` [today], `leading-minus`, `parentheses`).
   - **Statement**: aging labels come from `src/lib/ar-constants.ts` — reference that lib constant (client-safe, allowed) rather than duplicating strings. The finance-charge line and aging strip are sections.
   - **Quote**: `quote_intro_text`/`quote_liability_text` as text blocks (settings literals copied); `pageFooter` defaults **true** for the quote alone — its builder already prints "Page: N of M" today, and golden compatibility means reproducing THAT (every other type stays false, as Task 1 set). Prices print `money4` (4-decimal) — the `priceDecimals` knob's default here is 4 where the invoice's is 2 (ruling Q7's accepted deviation is the default, now editable).
2. **The carried machinery fix (from Task 1's review, routed to you):** `assertLocksHonored` must treat hiding a section as hiding its fields for lock purposes — hiding a *hideable* section that contains a non-removable field is refused with the field's lock reason. Implement in `types.ts`, test both directions (a hideable section with a locked field refuses to hide; the same section with the field removed from the contract hides fine). Re-run the full contract test suite — Task 1's traveler/ticket pins must not regress.

## Tests — extend `erp/tests/template-contracts.test.ts` (TDD: RED first, and your report MUST include a failing-run output snippet — the RED evidence rule, new from Task 1's review)

- Each new `DEFAULT_CONFIG` validates; content pins for exact labels/widths/text literals (the Task 1 style — assert strings, not shapes).
- The cert no-internal-notes assertion; the invoice frozen-columns walk; the quote `pageFooter: true` + `priceDecimals: 4` defaults; the statement ar-constants reference.
- The section-hide lock fix (both directions).
- All existing tests untouched and green.

## Conventions

TDD; conventional commits, no attribution trailer; four gates watched from `erp/` (`npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`) with real numbers in the report; no UI/flow → E2E n/a. Do not modify `prisma/schema.prisma` or `src/server/**`.

## Report

`docs/execution/2026-08-12-phase-7-template-designer/task-02-report.md`: derivation decisions per document, the RED evidence snippet, gate numbers (watched), deviations with reasons, notes for Task 3 (which needs your eight `DEFAULT_CONFIG`s as the seed migration's SQL literals). Final message: 5-line summary + report path. Update your ledger row in `progress.md` (state: IMPLEMENTED — awaiting review).
