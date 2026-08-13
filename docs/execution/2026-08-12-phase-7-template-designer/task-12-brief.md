# Task 12 brief — Invoice/credit conversion (+ processName snapshot, #98)

**Branch:** `phase-7-template-designer` (Tasks 1–11 APPROVED; four documents converted; the `pageFooterSpec.above` strip infra is in place; suite at 2530; E2E 19/19).
**Read first:** the spec §5.4/§5.6 + **§5.7 (the invoice half of `processName` — CREATE-TIME into the existing `Invoice.processNames` snapshot, NEVER at render)** + plan Task 12; CLAUDE.md's **frozen-paper rule** ("An invoice is frozen paper — its snapshot columns are read UNCONDITIONALLY, the opposite of the shipment grids' live-join-first"); **Task 11's report** (its Task 12 notes: the invoice is the OPPOSITE snapshot rule — the config maps over FROZEN data, introduces no live-join fallback; the data-seam-vs-config text-block fork; the `above` strip infra reusable; sentinel `e2e-task12.done`; defer `npm run build` until E2E finishes — shared `.next`); `gh issue view 98`. Then `erp/src/server/pdf/invoice.ts` in full, `readInvoicePdfData`/`printInvoice` + invoice assembly (`processNames` write site) in `erp/src/server/invoices.ts`, the invoice contract, and `src/lib/invoice-constants.ts` (`LINE_INPUT`, `PRICE_SOURCE_LABELS`).

## The frozen-paper invariant is the defining constraint

The invoice builder consumes config to lay out FROZEN snapshot columns. It must **not** introduce any live re-join — no live customer address, no live part name, no re-priced anything. The config controls placement/labels/widths/fonts/formats/logo over the snapshot data the builder already receives; a template edit changes future invoices' layout, never a raised invoice's numbers. The invoice contract (Task 2) already maps fields only to frozen columns — do not widen it.

## Deliverable

1. **`buildInvoiceDefinition(data, config)`** — config-consumer (`completeSections`, §5.6 both halves; serves BOTH invoice and credit — the title/number/negative-signs stay data, per Task 2's contract); the **negative-number format knob** (ruling 3 — today's `$-937.44` `SIGN_AFTER_SYMBOL` is the default) drives credit amounts; number/date/label/width/font/logo from config; the per-page company strip rides the `pageFooterSpec.above` infra when `pageFooter` is on (default OFF — golden). Any static footer text ("Contact: Accounts Receivable") becomes config where the contract declares it.
2. **`processName` snapshot source (spec §5.7, ruling 4 — CREATE-TIME):** in invoice assembly (`invoices.ts`), where `Invoice.processNames` is written, use `part.processName` when non-blank, else today's priced-operation comma-join. **This is the ONLY behavioral change to invoice data** and it is at CREATE time — prints keep reading the snapshot unconditionally; a `processName` edit after finalize provably changes nothing on raised paper (test it); pre-existing invoices are untouched (their snapshot already holds the comma-join). Credits copy the source invoice's snapshot as today.
3. **#98** (`gh issue view 98`): `LINE_INPUT` (the manual invoice-lines save) gains a `.refine` allowing `sourceQuoteNumber` only when `priceSource === "QUOTE"` — keep the echo-back working, do not add authenticity verification against live quotes (deliberately not wanted on frozen paper). Test the refine both ways.
4. **`printInvoice`** — resolve `resolveTemplateForPrint(tx, "INVOICE", <invoice customerId>)` on the claimed tx (BOTH invoice and credit resolve `INVOICE`); logo; stamp `templateVersionId`; the `claimInvoiceForPrint` order+invoice claim and print-vs-discard serialization untouched.
5. **Page N of M** knob (default OFF). **Overflow investigate-first** (the Task 10/11 precedent): can an invoice overflow one page (many lines)? If yes, the continuation band (invoice number, "(continued)") via the `above`/continuation infra; if provably not, say so.

## Tests (TDD; RED evidence REQUIRED)

Golden: `tests/invoice-pdf.test.ts` untouched, green; the 5A invoice/credit suites untouched. Config-driven: label/width/font/format overrides over FROZEN data; the negative-format knob on a credit fixture (all three enumerated styles render); §5.6 shapes; resolution + stamp through the real path for BOTH an invoice and a credit; the frozen-paper proof (a template edit after an invoice is raised changes nothing on reprint — decode the stored bytes). `processName`: create-time source (set → in snapshot; blank → comma-join; **edit-after-finalize changes nothing** — the load-bearing test); pre-existing invoice untouched. #98: the refine both directions. Overflow finding's test.

## Gates — E2E REQUIRED

Four unit gates + full E2E **detached, sentinel `e2e-task12.done`** (and heed Task 11's build-after-E2E note — the shared `.next` means a `build` racing a running dev server can flake; run `build` after E2E ends). Rows from the run's own output or PENDING; dev-DB fixtures cleared. Commit in small logical units.

## Report

`docs/execution/2026-08-12-phase-7-template-designer/task-12-report.md`: the frozen-paper preservation argument, the `processName` create-time wiring, #98, the overflow finding, RED evidence (especially the edit-after-finalize proof), all five gates watched, deviations, notes for Task 13 (statement — the fully-live-rebuild document + #87 filename sanitize). Final message: 5-line summary + report path. Update your ledger row.
