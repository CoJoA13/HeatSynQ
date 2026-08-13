# Task 6 brief — Render runtime: page numbers, sheet groups, fonts, pdf-lib

**Branch:** `phase-7-template-designer` (Tasks 1–5 APPROVED; suite at 2330).
**Read first:** `CLAUDE.md` — the pdfmake/render section ("renderPdf output is not byte-deterministic", the `serverExternalPackages` reasoning, the standalone file-tracing trap) and the E2E rule; the spec `docs/superpowers/specs/2026-08-12-phase-7-template-designer-design.md` **§6.1 (the primitives + per-sheet-group rendering + pdf-lib, owner-approved) + §6.2 (fonts — the real mechanism: vendored `.ttf`, NOT the Roboto vfs path) + §6.3 (JPEG)**; the plan Task 6 + Global Constraints (**`pdf-lib` is used ONLY inside `src/server/pdf/render.ts`'s module boundary**); `erp/src/server/pdf/render.ts` in full (97 lines — you are extending the one pdfmake-aware file); one existing PDF content test (e.g. `tests/traveler.test.ts`) for the house content-assertion technique.

## Pre-steps (carried from Task 5's review)

1. `assignTemplate`'s replace path: guard the update with `deletedAt: null` in the where (an `updateMany`-style conditional or equivalent) so a concurrent claim-free clear can't have its dead row's `templateId` rewritten — plus a test tweak asserting the stale replace 404s/refuses rather than mutating the dead row.
2. Add the GET assignment-list 403 test (bare session without `customers.view`).
3. Align `assignTemplate`'s declared return type with what PUT actually serializes (or `select` down).

## Deliverable — all inside `erp/src/server/pdf/render.ts` + `erp/src/server/pdf/fonts/`

1. **The footer spec.** Definitions may carry a declarative key (e.g. `pageFooter: { kind: "pageNofM", label?: string }` — pick a name that cannot collide with pdfmake's own definition keys; document it): `renderPdf` reads it, strips it from what pdfmake receives, and constructs the pdfmake footer callback renderer-side (the named-table-layouts indirection — callbacks exist ONLY in this file). Definitions stay pure JSON — the round-trip contract extends to the new key.
2. **The continuation-header spec.** A declarative key carrying **static JSON content** (text/images) rendered by a renderer-side header callback on **every page after the first** of the definition. Same purity rules.
3. **`renderSheetGroups(defs: TDocumentDefinitions[]): Promise<Buffer>`** — renders each definition via the existing path, merges the PDFs with **`pdf-lib`**, saved with **`{ useObjectStreams: false }`** (the uncompressed `/Count N` page marker must survive for the house content assertions). Each group's footer numbers ITS OWN pages ("Page 1 of N" restarts per group). `pdf-lib` is imported nowhere else — add a comment saying so at the import.
4. **`pdf-lib` the dependency**: `npm install pdf-lib` following the prevailing version convention for non-Prisma deps (caret). It has no install scripts — npm 12's skip-by-default needs **no** `approve-scripts` action; do not run it.
5. **Fonts (§6.2, owner-ruled 4-family set):** vendor `.ttf` assets under `erp/src/server/pdf/fonts/` — **Liberation Sans** and **Liberation Serif** (prefer the system copies under `/usr/share/fonts/liberation-*` — Fedora ships them; copy, don't symlink), **Roboto Mono** (fetch the TTFs from the official `google/fonts` GitHub repository), and **Roboto** (your call per the plan: keep the vfs decode or vendor it — ONE mechanism per family, documented in a file-header comment; **Roboto's font-map key must not change** so every unconverted builder and the posting register render byte-for-byte the same paths they do today). Commit each family's license file alongside (SIL OFL for Liberation; Apache-2.0 for Roboto/Roboto Mono). **Record provenance (source path/URL + sha256) for every font file in your report.** Buffers decoded once at module load; registered in the `PdfPrinter` font map under the exact family names the contracts enumerate (`Roboto`, `Liberation Sans`, `Liberation Serif`, `Roboto Mono`).
6. **Standalone tracing**: add `outputFileTracingIncludes` to `erp/next.config.ts` for the fonts directory; after `npm run build`, **verify the `.ttf` files are physically present in the standalone output** (`ls .next/standalone/...`) and put the listing in your report — the build compiling is NOT the proof; the trace surviving is.
7. **JPEG embedding**: a `jpegDataUri` (or extend `pngDataUri` to a mime-aware helper) beside the existing one.
8. **A definition naming an unregistered font family fails the render loudly** (throw naming the family) — never a silent fallback. (The contracts already refuse unknown families at config-validation time; this is the render-side belt.)

**Untouched:** every builder, every print path, every service. Their tests must pass unchanged — the new keys are opt-in.

## Tests — `erp/tests/render-primitives.test.ts` (TDD; RED evidence REQUIRED)

- Footer spec: a 2-page definition renders with the footer text present (use the house content-assertion technique from the existing pdf tests) and `/Count 2`; a spec-less definition renders byte-shape-identical behavior to today (no footer).
- Continuation header: page 1 lacks it, page 2 carries it (content assertion).
- `renderSheetGroups`: two definitions of 2 and 3 pages merge to `/Count 5`; each group's footer says "of 2" / "of 3" respectively (per-group restart proven, not per-document).
- Purity: definitions carrying the new spec keys survive `JSON.parse(JSON.stringify(...))` and render identically after the round trip.
- Fonts: a definition using each of the four families renders; an unregistered family throws naming it.
- JPEG helper produces a data URI pdfmake accepts (render succeeds).
- All existing tests green — especially every current PDF content test, unchanged.

## Gates — E2E REQUIRED this task

`render.ts` sits in every print flow, so the standing rule applies: run **`npm run test:e2e`** (dev server + DEV db `erp`), watch it end, record the real flow count. **The E2E discipline (Phase 6 Task 10 lesson, binding):** long E2E runs can outlive an agent turn — if that risk materializes, use a `setsid`-detached run writing to a log file with a completion sentinel, then read the result from the log; a gate row is written from the run's own output after it ends, or it says PENDING — never pre-written. Clear any fixtures you create out of the DEV database afterwards. Plus the four unit gates watched as usual.

## Report

`docs/execution/2026-08-12-phase-7-template-designer/task-06-report.md`: the spec-key names chosen and why, the merge mechanics, font provenance (source + sha256 each), the standalone-tracing verification listing, RED evidence, all five gate results watched, deviations, notes for Task 7 (the first consumer: traveler conversion + stamp plumbing). Final message: 5-line summary + report path. Update your ledger row.
