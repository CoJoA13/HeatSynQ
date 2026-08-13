# Task 13 brief — Statement conversion (+ #87 filename sanitize)

**Branch:** `phase-7-template-designer` (Tasks 1–12 APPROVED; five documents converted; suite at 2578; E2E 19/19).
**Read first:** the spec §5.4/§5.6 + plan Task 13; CLAUDE.md (the statement is a **fully-live rebuild** — the third snapshot posture: invoice=frozen-unconditional, shipper/cert=live-join-with-fallback, statement=live rebuild every print, no snapshot at all); **Task 12's report** (its Task 13 notes: statement is the OPPOSITE of the invoice — fully live; #87 is scope; the `above` company-strip infra + the `column_header`-owns-widths grid pattern copy over); `gh issue view 87` (the Content-Disposition crash/injection). Then `erp/src/server/pdf/statement.ts` in full, `buildStatement`/`printStatement` + the preview GET in `erp/src/server/statements.ts` (~:318–350), the statement contract, `erp/src/server/documents.ts` (`resolveDocumentFilename` + the download route), and the statement/document routes that emit `Content-Disposition`.

## Deliverable

1. **`buildStatementDefinition(data, config)`** — config-consumer (`completeSections`, §5.6 both halves): sections/fields/labels/widths/fonts/formats over the LIVE-rebuilt `StatementData` (aging strip, open-items, finance-charge line). The aging labels come from `ar-constants.ts` (the contract already references them — Task 2); the config controls layout/labels/widths/fonts/formats, not the numbers. `negativeStyle` where the statement prints negative money (credit/payment rows — Task 2 gave the statement contract that knob). No text blocks on the statement (verify against the contract — if none, no text-block seam).
2. **#87 — the shared safe-Content-Disposition helper** (`gh issue view 87`): a customer `code` (or any interpolated field) with a newline/quote currently crashes the `Headers` constructor AFTER the PDF has been archived — the operator sees a failed print while an unseen archive committed. Build **one** RFC 5987-encoding helper (a leaf, e.g. in `documents.ts` or a small `content-disposition.ts`) and adopt it in EVERY filename-emitting route: the statement print/preview route AND the generic `/api/documents/[docId]` download route (both interpolate `resolveDocumentFilename`). The hostile-code regression test: a customer code with an embedded newline/quote → a clean response with a sanitized filename, and — for the statement print path — no orphaned archive (or, if archive-then-name ordering can't be reversed cleanly, at minimum a non-crashing response; state which in the report).
3. **`printStatement`** — resolve `resolveTemplateForPrint(tx, "STATEMENT", customerId)` on its Serializable tx (the statement is claim-free by design — no single owner row; keep that); logo; stamp `templateVersionId`. **The preview GET** (un-archived) uses the same builder + config path but writes NO `StoredDocument` (that's a Task 19 concern too, but the preview here must stay side-effect-free as today).
4. **Page N of M** knob (default OFF). **Overflow investigate-first**: a statement with many open items overflows — if reachable, the continuation band (customer identity, "(continued)"); the aging strip/totals must land correctly across pages.

## Tests (TDD; RED evidence REQUIRED)

Golden: `tests/statement-pdf.test.ts` untouched, green; the 5B statement suites untouched. Config-driven: label/width/font/format overrides over live data; §5.6 shapes; resolution + stamp through the real print path (`createTemplate → editDraft → publishDraft → assignTemplate → printStatement`); the live-rebuild character preserved (a data change between two prints shows in the second — the opposite of the invoice's frozen test). #87: the hostile-code regression (newline/quote in code → clean sanitized response, no crash; the archive-ordering finding stated) on BOTH the statement route and the generic document download. Overflow finding's test.

## Gates — E2E REQUIRED

Four unit gates + full E2E **detached, sentinel `e2e-task13.done`**, `build` after E2E (shared `.next`). Rows from the run's own output or PENDING; dev-DB fixtures cleared. Commit in small logical units.

## Report

`docs/execution/2026-08-12-phase-7-template-designer/task-13-report.md`: the live-rebuild preservation, the #87 helper + the archive-ordering finding, the overflow finding, RED evidence, all five gates watched, deviations, notes for Task 14 (quote — the LAST conversion: footer-callback retirement + the two-money-precisions trap + the settings-retirement completion). Final message: 5-line summary + report path. Update your ledger row.
