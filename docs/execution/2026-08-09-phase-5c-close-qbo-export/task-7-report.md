# Task 7 report — the posting-register PDF

**Status:** COMPLETE. All gates green.

**Commit:** `8994229` — `feat(5c): posting-register PDF stored byte-for-byte on the export batch`

## What landed

- **`erp/src/server/pdf/posting-register.ts`** (new) — a PURE builder, the `pdf/statement.ts`
  contract: `PostingRegisterData` in, a plain-JSON `TDocumentDefinitions` out. Owns its own input
  type (`PostingRegisterLine`/`PostingRegisterData`); imports only `type Content`/`TableCell`/
  `TDocumentDefinitions` from `pdfmake/interfaces` and `LAYOUT` (by name, `LAYOUT.boxed`) from
  `pdf/render.ts` — no `renderPdf`, no I/O. Its own local `money()` (not `pdf/invoice.ts`'s or
  `pdf/statement.ts`'s — each pdf/ template duplicates its own, that module's precedent); no
  date-formatting helper of its own because `periodEnd` arrives pre-formatted from the caller.
  `buildPostingRegister` renders a header (`GL Posting Register — {periodLabel}`, `Export #N · JE
  date {periodEnd}`) then two `sideTable`s in source order, **SALES then CASH**: Account/Debit/
  Credit/Memo, one row per line, a bold Total row summing Σdebit/Σcredit for that side. A side with
  no lines still prints its table with a $0/$0 total row (never silently omitted).
- **`erp/src/server/gl-export.ts`** — replaced the Task 6 `register: new Uint8Array()` placeholder.
  Added a local `periodLabelOf(year, month)` helper (`"July 2026"`) and built `PostingRegisterData`
  from the SAME emitted `lines` the CSV and postings already come from (mapped to
  `{side, glAccountName, debit, credit, memo}`, reversal lines included — same rule as the CSV).
  `const register = new Uint8Array(await renderPdf(buildPostingRegister(registerData)))` is built
  BEFORE `tx.glExportBatch.create`; `renderPdf` is async and does no DB I/O so this stays safely
  inside the Serializable `$transaction`. Factored `periodEndStr = formatDateOnly(periodEnd)` once
  and reused it for the CSV, the register, and the returned `ExportedBatch.periodEnd` (previously
  computed twice).
- **`erp/src/app/api/receivables/close/export/[batchId]/register/route.ts`** (new) — GET, gated on
  `receivables.view`, copies the `.../file/route.ts` shape: `getExportBatchRegister(batchId)` →
  streams the batch's own frozen `register`/`registerContentType` bytes. `content-disposition:
  inline` (not `attachment` — the CSV file route's choice), since the register is meant to open in
  the browser's PDF viewer alongside the export, not force a download. `registerContentType`
  already defaulted to `application/pdf` on the `GlExportBatch` model since Task 1 — no schema
  change needed.

## Tests

- **`tests/posting-register-pdf.test.ts`** (new, 3) — `buildPostingRegister` survives a JSON round
  trip (no functions in the definition); prints period/export-number/both sub-registers with
  correctly-summed totals (SALES 100.00/100.00, CASH 40.00/40.00) plus a `%PDF-` structural pin on
  a real render; a side with zero lines still prints its (empty) table.
- **`tests/gl-export.test.ts`** (+1) — `exportClose` stores a register whose `byteLength > 1000`
  (not the placeholder), `registerContentType === "application/pdf"`, and an uncompressed `/Count
  1` page-count marker in the stored bytes (the brief's key test; PDF output is not
  byte-deterministic across calls per CLAUDE.md, so this pins content instead of comparing two
  fresh renders — the `bol.test.ts`/`shipping-ticket.test.ts` precedent).
- **`tests/receivables-routes.test.ts`** (+2) — the register route: 401 (no session) → 403 (no
  `receivables.view`) → 200 with `content-type: application/pdf`, a real PDF (`byteLength > 1000`,
  `/Count 1` marker) with it; 404 on an unknown batch id.

## Gate results

- `npx vitest run tests/gl-export.test.ts tests/receivables-routes.test.ts tests/posting-register-pdf.test.ts`
  → all green (12 + 31 + 3 tests, register/route assertions included).
- **Full `npm test`** → 125 files, **1937 passed**.
- `npx tsc --noEmit` → clean. `npx eslint src tests` → clean. `npm run build` → clean (the new
  `/api/receivables/close/export/[batchId]/register` route appears in the route manifest).
- **`npm run test:e2e` (foreground)** → **all 17 flows PASS** (exit 0).

## Self-review

- Purity checked by hand against the brief's global constraints: `pdf/posting-register.ts` imports
  nothing from the service layer; `gl-export.ts` imports the builder + re-exports nothing extra
  (callers reach `PostingRegisterData` through `gl-export.ts`'s own import, never re-exported —
  matches "the service imports the builder + re-exports the type" loosely: this task didn't need a
  re-export since no caller outside `gl-export.ts` needs the type yet). `PostingRegisterLine.side`
  is typed `"SALES" | "CASH"`, structurally identical to `gl-mapping.ts`'s `JournalSide` — `tsc`
  confirms the `lines.map(...)` assignment type-checks without a cast.
- `LAYOUT.boxed` referenced by name, never an inline callback object — the definition's JSON
  round-trip test (`posting-register-pdf.test.ts`) is the enforcement, same as `statement-pdf.test.ts`.
- No `Buffer.compare` of two fresh renders anywhere; every PDF assertion pins either the definition
  (pre-render) or a stable byte marker (`%PDF-` header, `/Count N`) on stored/rendered bytes.
- One incidental improvement, not scope creep: removed a duplicate `formatDateOnly(periodEnd)` call
  in `exportClose` by factoring `periodEndStr` once — no behavior change (same string, same input).

## Concerns / follow-ups

- None blocking. `docs/execution/.../progress.md` and the Task 8 kickoff are left for the
  controller pass, per this phase's established commit pattern (feat commit here; a separate
  `docs(5c): Task 7 complete …` commit records the ledger and next brief, as with Tasks 1–6).
