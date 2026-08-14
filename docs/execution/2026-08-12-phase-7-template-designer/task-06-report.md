# Task 6 report — Render runtime: page numbers, sheet groups, fonts, pdf-lib

**Implementer:** subagent, 2026-08-13. **Branch:** `phase-7-template-designer`.
**Commits:** `fdd3b3c` (pre-steps), `4f11652` (footer/header specs + font belt + jpegDataUri), `9a29ab6` (renderSheetGroups + pdf-lib), `4a29afd` (the four-family font map + tracing).

## Pre-steps (Task 5 review, carried)

1. **`assignTemplate`'s replace path** now updates with `deletedAt: null` in the UPDATE's own
   where (a single atomic statement, the `auditedSoftDelete` rule applied to the replace): a
   concurrent claim-free `clearAssignment` committing between the findFirst and the update makes
   the replace match zero rows → P2025 → the entity's 404 via `withDbErrors`, never a rewrite of
   the dead row's `templateId`. RED-verified with a parked-holder race test
   (`tests/template-assignments.test.ts`, "replace-vs-clear"): the holder locks the assignment
   row FOR UPDATE and soft-deletes it uncommitted; the REAL `assignTemplate` takes the replace
   branch and parks on the row lock; release → with the guard absent the competitor **resolved
   and the dead row's templateId was rewritten** (RED transcript below); with the guard it 404s
   and the dead row is untouched.
2. **GET assignment-list 403 test** added (bare session without `customers.view` → 403).
3. **Return-shape alignment:** all three `assignTemplate` branches now `select` exactly the
   declared `{ id, customerId, docType, templateId }`, so PUT serializes nothing beyond it.

RED evidence (pre-step 1, before the guard):

```
× concurrency … > replace-vs-clear: … refuses the stale replace → 404, dead row untouched
  → promise resolved … instead of rejecting
  +   "deletedAt": 2026-08-13T06:34:03.844Z,
  +   "templateId": "cmsr57d110008i9276jdbj1sz",   // the DEAD row, rewritten to template B
Tests  1 failed | 33 skipped (34)
```

## Deliverable — what landed in `render.ts` (+ `fonts/`)

### The spec keys (names chosen, and why)

- **`pageFooterSpec: { kind: "pageNofM", label?: string }`** and
  **`continuationHeaderSpec: { content: Content }`**, carried on `RenderableDefinition`
  (= `TDocumentDefinitions` + the two optional keys). The names are deliberately NOT pdfmake's
  own `footer`/`header`, and the `Spec` suffix is a convention no pdfmake definition key uses —
  collision-proof against anything pdfmake consumes now or plausibly later, and self-describing
  ("this is a spec the renderer expands", the named-table-layouts indirection).
- `renderPdf` strips both keys before pdfmake sees the definition and constructs the callbacks
  renderer-side. Footer text is `` `${label ?? "Page"} ${current} of ${total}` `` with the
  quote's exact styling (bold 8.5pt, right, margin [24, 8, 24, 0]) — label `"Page:"` reproduces
  the quote's footer verbatim, so Task 14's conversion is invisible. The continuation-header
  callback returns the static content only for pages > 1.
- **Loud failures:** a definition carrying both a spec key and the pdfmake key it drives throws
  naming both; an unknown footer `kind` throws naming it; and the render-side font belt
  (`assertFontsRegistered`, a JSON walk over `font` string values that skips functions) throws
  `Font family "X" is not registered with the PDF renderer — registered families: …` — ours, not
  pdfmake's, so the guarantee doesn't ride on pdfmake internals.

### Merge mechanics (`renderSheetGroups`)

`renderSheetGroups(defs: RenderableDefinition[])` renders each group through the existing
`renderPdf` path (so each group's specs scope to its own document — per-group "Page 1 of N"
restart falls out of the architecture, not bookkeeping), then merges with **pdf-lib**:
`PDFDocument.create()` → per group `PDFDocument.load(bytes)` → `copyPages(src, indices)` →
`addPage`, saved with **`{ useObjectStreams: false }`** so the uncompressed `/Type /Pages
/Count N` marker survives for the house content assertions (verified: the 2+3 merge shows
`/Count 5`). Groups render sequentially; an empty group list throws. pdf-lib `^1.17.1` (caret,
the non-Prisma convention), **no install scripts — no `approve-scripts` action was run**;
imported ONLY in `render.ts`, stated in a comment at the import site (grep-verified: the only
other "pdf-lib" hits in `src`/`tests` are comments).

### Fonts (owner-ruled 4-family set) — mechanism + provenance

One mechanism per family, documented at the font map. **Roboto keeps the vfs decode under its
unchanged `Roboto` key** (my call per the plan: it's the pre-Phase-7 mechanism, so every
unconverted builder and the posting register render byte-for-byte the same). The other three are
vendored `.ttf` under `erp/src/server/pdf/fonts/`, read into buffers once at module load from an
app-root-resolved path, registered under the contract names `Liberation Sans`, `Liberation
Serif`, `Roboto Mono`. Licenses committed per family; `fonts/PROVENANCE.md` carries the same
table as below.

| File | Source | sha256 |
|---|---|---|
| liberation-sans/LiberationSans-Regular.ttf | `/usr/share/fonts/liberation-sans-fonts/` (Fedora `liberation-sans-fonts-2.1.5-15.fc44`) | `76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8` |
| liberation-sans/LiberationSans-Bold.ttf | same package | `788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173` |
| liberation-sans/LiberationSans-Italic.ttf | same package | `e5bae5c4cde31f22142753855f4f8fb86da6ff39955ed3c0a11248b0d16948b0` |
| liberation-sans/LiberationSans-BoldItalic.ttf | same package | `698da70fc191cc5f33ad4d6d3fe830fe4624b898ea2e3169955928b7c491f1ee` |
| liberation-sans/LICENSE (SIL OFL 1.1) | `/usr/share/licenses/liberation-sans-fonts/LICENSE` | `93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b` |
| liberation-serif/LiberationSerif-Regular.ttf | `/usr/share/fonts/liberation-serif-fonts/` (Fedora `liberation-serif-fonts-2.1.5-15.fc44`) | `058ea80864aef09a23f45cbec2bb5400bc3dfbdea01c3f10538a21fcb497fb74` |
| liberation-serif/LiberationSerif-Bold.ttf | same package | `d754ba427cfe0bca54ae052384baa8f842da5bd6550ad4da024ac441e7a7d5ce` |
| liberation-serif/LiberationSerif-Italic.ttf | same package | `0e3dea9f8d613e006ccfa62201f33e265d19167bd0907725c3e145368b04fc2e` |
| liberation-serif/LiberationSerif-BoldItalic.ttf | same package | `f17db8af71e24d2066b587546021d4f0b296be389512b658dec3c09affeb11a7` |
| liberation-serif/LICENSE (SIL OFL 1.1) | `/usr/share/licenses/liberation-serif-fonts/LICENSE` | `93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b` |
| roboto-mono/RobotoMono-Regular.ttf | `googlefonts/RobotoMono@111eb14e…/fonts/ttf/` | `af0bff7599c3df3831755c16e39b3c496df74b8c8d8a1161b14dc8461be17cb4` |
| roboto-mono/RobotoMono-Bold.ttf | same commit | `3ecf35e5e87accc7578b605d1f5f0bc30d88b195d6807bec8a0c57f6aa95c4db` |
| roboto-mono/RobotoMono-Italic.ttf | same commit | `4549325cd2d10938d37d63eba2aaca7c2e16e48322dc767576eab45e512b6ad2` |
| roboto-mono/RobotoMono-BoldItalic.ttf | same commit | `a0f16567447311eaf42a35f6c50eb64b911694b42f1b01038e3b7e92c20f131d` |
| roboto-mono/OFL.txt (SIL OFL 1.1) | same commit | `50ab8dd54680d3473f649c9db86fece88434d097c7834475c1c72d2f8c429215` |

### Standalone-tracing verification (physical, after `npm run build`)

`next.config.ts` gains `outputFileTracingIncludes: { "/**": ["./src/server/pdf/fonts/**/*.ttf"] }`.
`find .next/standalone -name "*.ttf"` after the build:

```
.next/standalone/src/server/pdf/fonts/liberation-sans/LiberationSans-BoldItalic.ttf
.next/standalone/src/server/pdf/fonts/liberation-sans/LiberationSans-Bold.ttf
.next/standalone/src/server/pdf/fonts/liberation-sans/LiberationSans-Italic.ttf
.next/standalone/src/server/pdf/fonts/liberation-sans/LiberationSans-Regular.ttf
.next/standalone/src/server/pdf/fonts/liberation-serif/LiberationSerif-BoldItalic.ttf
.next/standalone/src/server/pdf/fonts/liberation-serif/LiberationSerif-Bold.ttf
.next/standalone/src/server/pdf/fonts/liberation-serif/LiberationSerif-Italic.ttf
.next/standalone/src/server/pdf/fonts/liberation-serif/LiberationSerif-Regular.ttf
.next/standalone/src/server/pdf/fonts/roboto-mono/RobotoMono-BoldItalic.ttf
.next/standalone/src/server/pdf/fonts/roboto-mono/RobotoMono-Bold.ttf
.next/standalone/src/server/pdf/fonts/roboto-mono/RobotoMono-Italic.ttf
.next/standalone/src/server/pdf/fonts/roboto-mono/RobotoMono-Regular.ttf
```

12/12 — exactly the path the Docker run stage copies to `/app/src/server/pdf/fonts/**`, which is
where `render.ts`'s `process.cwd()`-resolved read looks (WORKDIR `/app`).

## Tests (`tests/render-primitives.test.ts`, 20 cases, DB-free)

The footer/continuation-header content lives only in renderer-side callbacks, so the suite
decodes the RENDERED bytes: every embedded font's ToUnicode CMap (the table a viewer's
copy-paste uses) is parsed from the object graph, each page's content stream is walked with `Tf`
font tracking, and TJ/Tj runs decode through the ACTIVE font's map — per-page, exact, no
cross-font guessing. That gives assertions the house `allText`-over-definition technique cannot:
"Page 1 of 2" on page one and not page two, the continuation marker absent from page one,
per-group restart page-by-page across the merged document, never "of 5". `/Count N` stays the
page-count assertion (traveler.test.ts's rule); nothing ever `Buffer.compare`s fresh renders.

RED evidence (cycle 1 — the spec keys ignored, pdfmake's own font error, before implementation):

```
❯ tests/render-primitives.test.ts (11 tests | 9 failed)
  × a 2-page definition renders 'Page N of M' … → expected +0 to be 1
  × label overrides the 'Page' prefix … → expected 'alpha body\nbeta body' to contain 'Page: 1 of 2'
  × … BOTH a pdfmake footer and the spec … → promise resolved "Buffer[…]" instead of rejecting
  × defaultStyle naming an unregistered family … → … but got 'Font 'Comic Sans' in style 'normal…'
```

RED evidence (renderSheetGroups): `(0 , renderSheetGroups) is not a function` (4 failed).
RED evidence (fonts): the three new families each rejected by the belt —
`Font family "Liberation Sans" is not registered …` (3 failed) — before the map registered them.
RED evidence (jpegDataUri): `TypeError: (0 , jpegDataUri) is not a function`.

Existing PDF suites verified unchanged mid-task (before the primitives commit): bol, cert-pdf,
invoice-pdf, posting-register-pdf, quote-pdf, shipping-ticket, statement-pdf, traveler —
148/148, zero edits to any of them.

## Gates (final HEAD `4a29afd`, all watched to completion)

| Gate | Result | Timing |
|---|---|---|
| vitest | **2352/2352, 136 files** | 239.4s |
| tsc --noEmit | clean | 1.8s |
| eslint src tests | clean | 9.5s |
| build | exit 0; 12/12 .ttf re-verified in standalone | 16.4s |
| E2E (dev server + DEV db `erp`) | **All 19 flows passed, EXIT 0** (run 2, watched via setsid + log + sentinel, results read from the run's own log) | ~7 min |

**E2E ran twice.** Run 1 (same discipline) finished **18/19**: `quotes` failed at
`e2e/flows/quotes.mjs:179` — `locator.fill` on the "Setup charge" input timed out after 45s with
Playwright's "element was detached from the DOM, retrying" loop. Diagnosis before re-running:
this branch touches NO quote UI or client component (`git diff main...HEAD -- erp/src` shows
only template contracts/services/routes, render.ts, fonts, audit/customers/users server files);
the card and price rows are keyed by stable ids (`line.key`/`price.key` in `QuoteDetail.tsx`),
and the flow was green at the Phase 6 close on this same code. Judged an environment-timing
flake (dev-server compile pauses mid-flow detaching the input across renders); the full-suite
re-run passed all 19 with zero changes to code or flow in between. Both logs retained in the
session scratchpad (`e2e-task6.log`, `e2e-task6-run2.log`).

## Deviations

1. **Roboto Mono's source and license.** The brief says "fetch the TTFs from the official
   `google/fonts` GitHub repository" and "Apache-2.0 for Roboto/Roboto Mono". `google/fonts`
   today carries Roboto Mono under `ofl/robotomono` with ONLY variable-weight
   `RobotoMono[wght].ttf` files — a variable font cannot feed pdfmake's four fixed style slots
   (pdfkit embeds the default instance; bold would silently render regular), and instancing
   statics locally would mean committing bytes no upstream ever published. The TTFs were instead
   fetched from **`googlefonts/RobotoMono` — the family's official upstream repo — at the exact
   commit `google/fonts`' own `upstream_info.md` pins** (`111eb14e…`). Roboto Mono is
   SIL OFL 1.1 (the brief's Apache-2.0 note is stale — the family was relicensed; `OFL.txt`
   vendored from the same commit), which also matches spec §6.2's "SIL-OFL-licensed families
   only".
2. **Roboto has no vendored license file** because Roboto has no vendored bytes — it stays
   inside pdfmake's package (Apache-2.0), noted in `fonts/PROVENANCE.md`.
3. **`fonts/PROVENANCE.md`** added in-repo (the brief asks provenance in the report; the task
   dispatch asked for per-file provenance + sha256 alongside the assets — both now exist).

## Notes for Task 7 (traveler conversion + stamp plumbing)

- `RenderableDefinition` is the type builders should return once they adopt the specs; plain
  `TDocumentDefinitions` remains assignable, so adoption is per-builder opt-in.
- The footer renders in the page's BOTTOM MARGIN — a definition wanting `pageNofM` needs a
  bottom page margin ≥ ~28pt (the quote uses 44). Same for the continuation header and the TOP
  margin on pages 2+.
- `renderSheetGroups` accepts one def per sheet group; a single-group call still round-trips
  through pdf-lib (uniform output). The traveler's per-load groups (Task 8) should build one
  definition per load with that load's `continuationHeaderSpec` content and share one
  `pageFooterSpec`.
- The test file's `drawnPages`/`drawnText` decoder is reusable for any "what does the stored PDF
  actually say" assertion (it survives the pdf-lib merge); consider lifting it into
  `tests/helpers/` when a second suite needs it — not done now to keep this task's surface
  inside its brief.
- `jpegDataUri` + `pngDataUri`: pick by the stored `logoMimeType` when Task 7 wires logos.

## E2E fixture hygiene

The harness tore down its own dev-DB fixtures on both runs ("cleanup ok" in each log — including
the FAILED run 1, whose teardown runs on flow failure too). Verified directly against the DEV db
`erp` after each run: `Customer` code `E2E%`, `User` username `e2e_%`, `Part` number `E2E%`, and
`ProcessStepCode` code `E2E%` all count 0. This task created no dev-DB fixtures of its own
(render-primitives is DB-free; the pre-step tests run against `erp_test`).
