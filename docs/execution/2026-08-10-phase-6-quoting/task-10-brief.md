# Task 10 brief — The quote PDF, print route, documents route, `User.title` surfaces (rulings 12, 14)

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-11 · **Depends on:** Tasks 1–9

**Binding documents (read in this order):**
1. `CLAUDE.md` — the PDF constraints (pdfmake Node entry, `renderPdf` non-determinism, stored-byte reprints) and the StoredDocument rule.
2. `docs/superpowers/specs/2026-08-10-phase-6-quoting-design.md` — **§6 whole (the layout transcription is your contract)**, §3 rulings 12 + 14, §8 (settings keys — already registered in Task 1).
3. The sample itself: `docs/samples/Quote_Sample_Form.jpeg` — LOOK at it (it is an image; open it), §6 transcribes it but the sample is the tiebreaker.
4. `docs/superpowers/plans/2026-08-10-phase-6-quoting.md` — Global Constraints + Task 10.
5. `docs/execution/2026-08-10-phase-6-quoting/task-08-report.md` — deviation 1: the detail page is ALREADY WIRED to `GET /api/quotes/[id]/documents` (404→empty-state today); **you must land that route at exactly that path**, and the disabled Print button placeholder you now bring to life.
6. The precedents: the traveler print path (`src/server/pdf/`, its print route, StoredDocument storage + print history) and the invoice/cert PDF builders (`src/server/pdf/invoice.ts`, cert builder) — layout conventions, fonts, footer shapes.

**Deliverable:** the eighth document type end-to-end — print a quote, store it byte-for-byte, reprint exactly, list it on the quote page — plus `User.title` on the admin form and BOTH signature blocks (quote + cert).

## What to build (plan Task 10, spec §6)

1. **`erp/src/server/pdf/quote.ts`** — a pure `TDocumentDefinitions` builder (the invoice-builder precedent: data in, definition out, no I/O), fed precomputed data. Layout per spec §6's transcription, sample as tiebreaker:
   - Header: "Quotation", company block from settings, "Quotation Number: N", pdfmake footer page function ("Page: N of M" — code-rendered layout, legal here).
   - Right block: Effective / Expires On / Terms (customer terms name) / "Your R.F.Q. Number" / customer phone-fax where the model has them.
   - Attn block: contact name when picked, customer name, bill-to address (mirror the invoice's address resolution).
   - Intro line from `quote_intro_text` (settings).
   - Lines: quantity (quotedQty, "Unlimited", or blank), part number/name/description (live from part for linked lines, own text for free-text), each weight, total lbs (qty × each-weight when both known), material.
   - Price section per line, per row: step name + row notes, "Setup charge: $X **Plus** / Price per <unit>: $Y **Or** / Minimum charge: $Z" in 5A vocabulary; break rows listed when present; **indicative extended amount computed through the pure engine** (`priceOrder` with a synthetic line from quotedQty + each-weight; omit when unlimited or qty/weight unknown) — NO second pricing formula, the engine is the only math.
   - Footer: the quote's ending statement text; `quote_liability_text`; signature block — quotedBy displayName + `User.title` (blank title prints nothing).
2. **Print route** — `POST` (or the traveler's verb — mirror it) `api/quotes/[id]/print`: gated `quotes.view` (the documents API's own kind gate covers reads; cite the precedent you mirror), renders → `storeDocument` (kind `QUOTE`, owner `quoteId`) → responds with the PDF; reprint of a STORED document returns the stored bytes exactly (`Buffer.compare`-tested); a deleted quote's print behavior mirrors the closest precedent (report it).
3. **`GET /api/quotes/[id]/documents`** — at exactly the path Task 8 wired (its 404→empty-state must transparently become the live list); mirror the closest existing documents-list route (order hub's? cert page's?) including its permission filtering via `AREA_FOR_KIND`.
4. **Wire the detail page**: the Print button comes alive (gate: `quotes.view` per your route decision; keep §5.16 titles); the documents section lists prints with dates and download links through the existing `/api/documents/<id>` mechanism.
5. **`User.title`**: admin users form field (through `users.ts`'s audited update — check whether the update schema needs the field added server-side; that IS in scope); the CERT signature block gains the title line (closing Phase 4 ping #4 — find the cert builder's signature block and add title beneath/beside name per the cert sample's shape); the quote signature uses it from day one.
6. **Tests (TDD):** builder content pinned (intro text, ending statement text, "Unlimited" vs blank qty, indicative amounts matching the engine to the cent incl. a minimum-floor case and a break case, liability text, signature name+title, blank-title omission) — content-pinning, never `Buffer.compare` on fresh renders; print route (perms, 404s, stored-byte reprint exact via `Buffer.compare` on STORED bytes); documents route (list + filtering); cert builder title line (existing cert tests extended, not rewritten); the admin form field (route/service test).

## Hard constraints

- Commands from `erp/`; conventional commits, no trailer; NO schema changes (`User.title` exists since Task 1 — if anything else seems needed, STOP and report); don't touch `erp/.claude/`.
- `serverExternalPackages` and the pdfmake Node-entry constraints are settled — do not fight them; follow `render.ts` as-is.
- Gates: `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`, AND `npm run test:e2e` watched synchronously to completion (the detail page and admin users form change; 18 flows must stay green; clear dev-DB fixtures).
- Update `progress.md`'s Task 10 row in your final commit.

## Report

`docs/execution/2026-08-10-phase-6-quoting/task-10-report.md`: what you built; where the layout deviates from the sample and why (the demo reviews these); the print-verb/permission precedent you mirrored; the deleted-quote print decision; the cert-signature change's shape; deviations; gate + E2E results with counts; scrutiny pointers. Commit it.
