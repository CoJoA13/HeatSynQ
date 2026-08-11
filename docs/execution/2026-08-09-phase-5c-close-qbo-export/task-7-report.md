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

---

## TDD RED evidence (added post-review — report-contract Important)

The original report omitted the RED transcripts every prior Phase 5C task documents. Captured here
by temporarily reverting each piece and re-running the exact test that exercises it, then restoring
and re-confirming GREEN. Both reverts were later verified to leave a clean `git diff` (only the
intended fix-round-1 changes below remained once restored).

### 1. `exportClose` stores the real register (`tests/gl-export.test.ts -t "register"`)

Reverted `gl-export.ts`'s `register = new Uint8Array(await renderPdf(buildPostingRegister(registerData)))`
back to the Task 6 placeholder `register = new Uint8Array()`, then ran:

```
npx vitest run tests/gl-export.test.ts -t "register"
```

**RED:**

```
 FAIL  tests/gl-export.test.ts > gl-export delta > stores a non-empty posting-register PDF with a stable page marker (Task 7)
AssertionError: expected 0 to be greater than 1000
 ❯ tests/gl-export.test.ts:180:37
    178|     const { batchId } = await asSystem(() => exportClose(period.id));
    179|     const row = await prisma.glExportBatch.findUniqueOrThrow({ where: …
    180|     expect(row.register.byteLength).toBeGreaterThan(1000); // a real P…
       |                                     ^

 Test Files  1 failed (1)
      Tests  1 failed | 11 skipped (12)
```

Restored the render call, re-ran the same command:

**GREEN:**

```
 ✓ tests/gl-export.test.ts (12 tests | 11 skipped) 294ms

 Test Files  1 passed (1)
      Tests  1 passed | 11 skipped (12)
```

### 2. The builder module itself (`tests/posting-register-pdf.test.ts`)

Temporarily moved `src/server/pdf/posting-register.ts` out of the tree (simulating "builder
absent"), then ran:

```
npx vitest run tests/posting-register-pdf.test.ts
```

**RED:**

```
 FAIL  tests/posting-register-pdf.test.ts [ tests/posting-register-pdf.test.ts ]
Error: Cannot find module '@/server/pdf/posting-register' imported from
'/home/cjones/Desktop/HeatSynQ/erp/tests/posting-register-pdf.test.ts'.
 ❯ tests/posting-register-pdf.test.ts:2:1
      1| import { describe, it, expect } from "vitest";
      2| import { buildPostingRegister, type PostingRegisterData } from "@/serv…
       | ^

 Test Files  1 failed (1)
      Tests  no tests
```

Restored the file, re-ran the same command:

**GREEN:**

```
 ✓ tests/posting-register-pdf.test.ts (3 tests) 52ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

---

## Fix round 1 — review findings (2026-08-09)

**Commit:** `fix(5c): register download filename; TDD RED evidence`.

Task 7 review: **Approved**, with one Important (this report omitted RED evidence — closed above)
and one Minor (register filename) to close before merge-readiness.

### MINOR — register route had no filename on its `inline` disposition
Every other inline-PDF route (`certs/[id]/print`, `invoices/[id]/print`,
`receivables/statements`, `orders/[id]/traveler`, `documents/[docId]`) sets
`inline; filename="..."`; the register route set bare `inline`. Fixed:
- `getExportBatchRegister` (`gl-export.ts`) now also selects `periodEnd` and returns a derived
  `fileName: gl-register-<YYYY>-<MM>.pdf` (the same year/month the CSV's own `fileName` uses, read
  off the batch's own frozen `periodEnd` — never recomputed from live data).
- The register route now sets `content-disposition: inline; filename="${fileName}"`.
- `tests/receivables-routes.test.ts`'s register-route test gained one assertion:
  `expect(res.headers.get("content-disposition")).toBe('inline; filename="gl-register-2026-07.pdf"')`.

The reviewer's `money()` blank-zero/no-`$` style note was explicitly NOT changed per the
coordinator's instruction — it reads correctly for a GL posting register (unlike the customer-facing
invoice/statement templates, which prefix `$`).

### Gate results (fix round 1)
- `npx vitest run tests/gl-export.test.ts tests/posting-register-pdf.test.ts tests/receivables-routes.test.ts`
  → **46 passed** (12 + 3 + 31).
- **Full `npm test`** → 125 files, **1937 passed**.
- `npx tsc --noEmit` → clean (exit 0). `npx eslint src tests` → clean (exit 0).
- **`npm run test:e2e` (foreground)** → **all 17 flows PASS** (exit 0).
