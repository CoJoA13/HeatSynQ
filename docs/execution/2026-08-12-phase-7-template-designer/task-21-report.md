# Task 21 report — The restyle-print proof, the docs pass, and the final gate baseline

**Implementer:** fresh subagent, 2026-08-14
**Branch:** `phase-7-template-designer` (Tasks 1–20 approved; THE FINALE — proves the roadmap's Phase 7 testable outcome, closes the phase docs, and produces the whole-branch review's gate baseline)
**Commits:** `635c184` the restyle-print proof (`tests/traveler-restyle.test.ts`), `0572fa9` the docs pass (HANDOFF §4 + CLAUDE.md), plus this report + the ledger row

## Deliverable 1 — the restyle-print proof (the roadmap outcome "Owner restyles the traveler/logo")

**Form: a real-services integration test** (`tests/traveler-restyle.test.ts`), the LOAD-BEARING form
per the brief — the E2E harness can drive the editor/preview/assignment UI (the existing
`templates-admin` flow does, end to end) but it cannot decode PDF bytes, and "the paper shows it" is a
byte-level fact. So the decode + stamp assertion lives in the integration test, which drives the whole
loop through the exact services an owner touches.

The flow, as an owner would:

1. `createTemplate("TRAVELER", "Restyled Traveler")` — a v1 draft opens.
2. `editDraft` renames the header's `order_number` label to the distinctive marker
   **`RESTYLED-TRAVELER-MARKER`** and places a header-center logo; `uploadLogo` uploads the real
   **fixture logo** (`e2e/fixtures/logo.png`, a genuine 160×48 RGB PNG) through the Task-4 sniff/cap
   path.
3. `renderPreview` renders the WORKING draft against the real order — the **side-effect-free** render
   (spec §5.5): the assertion `drawnText(previewPdf).toContain(MARKER)` passes, the logo + barcode are
   both painted (`paintedImageCounts` sums to 2), and `StoredDocument.count()` is unchanged across the
   preview (no archive, no `printedAt`, no allocation).
4. `publishDraft` — v1 becomes the immutable published version; its `versionId` is captured.
5. `assignTemplate(customer.id, "TRAVELER", templateId)` — the published template is the customer's.
6. `printTraveler(order.id)` — the real print path.
7. **The load-bearing assertion, decoded from the ARCHIVED bytes** (`getDocument(documentId).fileData`,
   read back from `StoredDocument`, via the `/Length`-hardened `tests/helpers/pdf.ts`):
   - `drawnText(paper)` **contains `RESTYLED-TRAVELER-MARKER`** and **does not contain `Order Number`**
     (the contract default label is gone),
   - `paintedImageCounts` sums to 2 — the placed logo is on the shop paper beside the barcode,
   - the `StoredDocument.templateVersionId` column **equals the published `versionId`** (a direct DB
     read; note `getDocument`'s projection deliberately omits `templateVersionId`, so the row is read
     directly), and that id is NOT `standard-traveler-v1`.

**RED evidence (TDD).** The second test pins the failing direction as a permanent GREEN control: an
UNpublished/unassigned restyle never reaches the paper — `printTraveler` falls to the seeded Standard
default (`drawnText` carries `Order Number`, not the marker; one image — the barcode alone; stamp
`standard-traveler-v1`). To capture the assertion's actual RED, a throwaway copy of the first test with
the publish + assign steps removed was run: `expect(paper).toContain('RESTYLED-TRAVELER-MARKER')`
failed against exactly that Standard-default paper — decoded received text began
`"Restyle Test CoOrder NumberLoad10001Part Quantity…"` (the default traveler, no marker). The copy was
deleted; the tree carries only the two committed tests.

Did NOT add a new E2E flow (Task-18 lesson — no bonus E2E-RED left dirtying the tree): the
`templates-admin` flow already covers the editor → logo-upload → publish → assign → preview UI loop,
and the byte-decode outcome is the integration test's job by the brief's own reasoning.

## Deliverable 2 — the docs pass

- **`docs/HANDOFF.md` §4:** the current-phase state rewritten to **"Phase 7 build complete (all 21
  tasks), whole-branch review pending"** — NOT "merged" (the PR/merge is the controller's, post-review).
  The document-conversion track, the UI stretch, Task 21's proven outcome, the five landed fold-ins, the
  final gate baseline, and the carried whole-branch notes are named in one lean paragraph; per-task
  detail stays in this ledger.
- **`CLAUDE.md`:** the Phase 7 standing conventions — template contracts as the single source of truth
  (contract → generated zod schema → editor → config-consuming builders; a template re-arranges what the
  data layer collects, never adds a source); **locked elements (§5.6)** + the **§5.3 `DEFAULT_CONFIG`
  backfill** and its three-copies drift guard; **publish-by-immutability** (prints resolve the last
  published version correct at any isolation WITHOUT locking the template row — do not add a print-time
  template claim; mutations claim `claimTemplate` first); the **four retired standing-text Settings keys**
  now in template content; and **`pdf-lib` confined to `render.ts`** (per-sheet-group merge only). Also
  fixed the carried **stale sample handler**: `requireUser()` is no-arg and synchronous, so the sample
  reads `mustCan(requireUser(), …)`, not `mustCan(await requireUser(req), …)`. No moving numbers added;
  superseded guidance displaced in place.
- **Master spec §15 Phase 7 amendment table — verified, NO drift.** All seven rows match what shipped:
  draft→publish (immutability-not-locking); the four format knobs (labels/number/date/column-width,
  tear-off flow-based); step-fields + barcode locked; curated bundled `.ttf` font set, no upload;
  division→nearest-ancestor→type-default resolution with never-published-can't-be-default/assigned;
  `Part.processName` (traveler live + invoice create-time snapshot); the four standing-text keys retired.
  No correction was needed.

## The five fold-in issues (ruling 6) — resolved on the branch, close via the PR body at merge

Do NOT `gh issue close` these now; the controller's PR body carries `Fixes #NN` and closes them at
merge. Each is genuinely resolved on this branch:

| Issue | What | Fixed by | Evidence on branch |
|---|---|---|---|
| **#36** | Traveler continuation-page header | **Task 8** | `buildTravelerDefinitions` + per-load `continuationHeaderSpec` (`traveler.ts`) — one `renderPdf` per load, each with its own load's identity band |
| **#43** | Bounded all-loads traveler render | **Task 8** | `MAX_TRAVELER_LOADS_PER_PRINT = 100` (`traveler.ts:850`) — print AND preview refuse above it before any render |
| **#87** | Safe Content-Disposition filenames | **Task 13** | `src/server/content-disposition.ts` leaf + `contentDispositionValue` (RFC 5987), adopted on both filename-emitting routes |
| **#97** | `indicativeAmounts` length assert | **Task 14** | `alignOperationAmounts` throws on `ops.length !== prices.length` (`quotes.ts:1644`) before the index map |
| **#98** | `sourceQuoteNumber` `.refine` | **Task 12** | `.strict().refine(…)` on `LINE_INPUT` — `sourceQuoteNumber` only with `priceSource === "QUOTE"` (`invoices.ts:1024`) |

## Deliverable 3 — the final full gate baseline (watched on the final HEAD)

All five gates watched to completion; both DBs `migrate status` clean. **This is the phase's final
baseline for the whole-branch review.**

| Gate | Result | Notes |
|---|---|---|
| `npm test` (vitest, `erp_test`) | **2743 / 2743, 149 files, exit 0** (343s) | +2 over Task 20's 2741 / 148 (the new `traveler-restyle.test.ts`) |
| `npx tsc --noEmit` | **clean, exit 0** | |
| `npx eslint src tests` | **clean, exit 0** | |
| `npm run build` | **exit 0** | run after the E2E dev server released `.next`; full route manifest incl. the template routes |
| `npm run test:e2e` (Playwright, dev `erp`) | **20 / 20, RC=0** | controller-run after an environmental `close-month-end` hang + debris cleanup; `e2e-task21-rerun.log` ("All 20 flows passed", close-month-end + templates-admin incl.). No new flow — byte-identical to Task 20's 20/20 |
| `migrate status` (both DBs) | **35 migrations, up to date, clean** | dev `erp` AND `erp_test` |

**E2E-infra note for the whole-branch review (NOT a Phase 7 defect):** the Phase-5C `close-month-end`
flow intermittently HANGS under full-suite E2E load — now observed twice (Task 19 and Task 21), both
in untouched Phase-5C code. Each time the close itself completes in the dev DB (ClosePeriod +
GlExportBatch + GlPostings land) but the flow does not print `PASS`, stranding that debris; the fix
each time is to kill the run, clean the debris in FK order (GlPosting → GlExportBatch → ClosePeriod for
the affected month), let the harness reap its own fixtures, and re-run — which passes 20/20. A
pre-existing intermittent E2E flake for the whole-branch review to weigh, not something Phase 7
touched.

## Deviations

- **Restyle proof is an integration test, not a new E2E flow** — the load-bearing decode belongs in the
  integration form (the brief's own reasoning; the E2E harness can't decode PDF bytes), and the UI loop
  is already E2E-covered by `templates-admin`. No bonus E2E-RED (Task-18 lesson).
- **The stamp assertion reads `StoredDocument.templateVersionId` directly**, because `getDocument`'s
  `DOCUMENT_SELECT` intentionally omits that column (a document meta read has no reason to project it);
  the direct DB read is the authoritative check.

## State of the branch for the whole-branch review

**All 21 tasks are build-complete and individually task-approved (2026-08-13/14); Phase 7's build is
done, and only the whole-branch review, one fix wave, and the PR remain.** All eight document types
render from a validated `TemplateConfig` through their contracts, with draft→publish versioning
(immutability-not-locking), per-customer division→ancestor→default resolution, the structured editor +
logo upload + §5.13 save/conflict UX + side-effect-free preview + customer-page assignment picker, the
four standing-text Settings retired into template content, and the five fold-ins (#36/#43/#87/#97/#98)
landed. The roadmap's testable outcome is proven end to end against the real services. The **carried
whole-branch notes** the reviewer should pick up (from this ledger's Carried-minors sections, none
correctness-blocking): **issue #102** (render's two-pass `overflowTopMargin` leaves a spurious blank
trailing page at isolated boundary overflow counts — cosmetic, shared infra, affects every
overflow-capable document); the **`tests/helpers/pdf.ts` decoder has had TWO real bugs** (Task 8's
ligature-CMap, Task 17's `/Length` truncation) and its **non-greedy EOL-strip fallback is now dormant**
(both writers emit a direct `/Length`, so no production render exercises that branch) — the golden-test
oracle may warrant a hardening pass; the **quote's net-new continuation identity band** on page 2+
(brief-invited, identity-locked, single-page goldens unaffected); the **locked-field-in-a-hideable-section
contract-authoring convention** (today unproducible — every `removable:false` field lives in a
non-hideable section, server backstops it — but a future hideable-section-with-a-locked-field would be
UI-producible, server-only-refused); and the **preview picker's non-order label fields**
(shipperNumber/documentNumber/scope/quoteNumber/customer-code) are unverified against their list
projections (a name mismatch degrades a LABEL to blank; selection-by-id, the load-bearing path, still
works; only TRAVELER/order is E2E-exercised). **Final gate baseline: see the table above.**
