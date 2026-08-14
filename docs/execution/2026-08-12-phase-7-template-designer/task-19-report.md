# Task 19 report — Preview: the side-effect-free render + per-type pickers

**Implementer:** fresh subagent, 2026-08-14
**Branch:** `phase-7-template-designer`
**Commits:** `accc164` (the preview service + route + 14 route tests, RED→GREEN),
`29886a4` (the preview pane UI + the per-type `previewRecordSpec` mapping + 4 unit tests),
`a72f032` (the E2E extension + the voided-order picker filter + the stable button aria-label)

## What landed

`POST /api/templates/[id]/preview` renders the editor's **SUBMITTED** (working, possibly-unsaved)
config against a real record the user picks and streams the PDF bytes with **ZERO side effects** —
no `StoredDocument`, no `printedAt`, no finance-charge assessment, no `updatedAt` bump, no number
allocation. Plus the editor's live **preview pane** with the per-docType record picker and a
rendered-PDF `<iframe>` view showing the working config.

### The side-effect-free render (`src/server/template-preview.ts` + the route)

`renderPreview(ctx, input, signerUserId)` reuses **the exact per-type read + builder the print path
uses**, minus the store/stamp/printedAt/allocation:

| docType | read | builder | render |
|---|---|---|---|
| TRAVELER | `readTravelerData` | `buildTravelerDefinitions` | `renderSheetGroups` |
| SHIPPER / MOS_SHIPPER | `readShippingTicketData` (liability text from the submitted config) | `buildShippingTicketDefinitions(…, docType, …)` | `renderSheetGroups` |
| BOL | `readBolData` (existing bolNumber or the shipper number as a sample stand-in — **never allocates**) | `buildBolDefinition` | `renderPdf` |
| CERT | `readCertPdfData` (cert_statement from the submitted config; signer = the acting user) | `buildCertDefinition` | `renderPdf` |
| INVOICE | `readInvoicePdfData` | `buildInvoiceDefinition` | `renderPdf` |
| STATEMENT | `buildStatement` (**`assessFinanceCharges: false` forced**; asOf/combineFamily params) | `buildStatementDefinition` | `renderPdf` |
| QUOTE | `readQuotePdfData` (intro/liability from the submitted config) | `buildQuoteDefinition` | `renderPdf` |

**The config is rendered DIRECTLY — never through `resolveTemplateForPrint`** (which requires a
PUBLISHED version), so a never-published draft previews exactly as an assigned one would. The only
two facts read from the template row are its `docType` (drives the record-area gate + the render
dispatch) and its open draft's **logo bytes** (the logo lives per-version — §6.3 — so the preview
embeds the DRAFT's logo, keyed by the mime the editor holds, only when the submitted config places
one). The record reads run on one read-only RepeatableRead snapshot; nothing claims a row or writes.

`template-preview.ts` is a top-level consumer of every print service + builder; nothing imports it
back, so the wide import graph opens no cycle.

### The permission pairing (route-tested)

`requireUser` → `mustCan(user, "templates", "view")` → read the template's docType → `mustCan(user,
RECORD_AREA[docType], "view")`. Both gates must pass or 403; the record itself is read only after
both pass (no amounts leak before the record-area gate). `RECORD_AREA`: TRAVELER→orders,
SHIPPER/MOS_SHIPPER/BOL→shipping, CERT→certs, INVOICE→invoicing, STATEMENT→receivables, QUOTE→quotes
— exactly each type's print-route gate (§5.5: a preview must never be a cheaper read than the print).

### The preview pane (`PreviewPane.tsx`, wired into `TemplateEditor.tsx`)

Beside the panels: a `<select aria-label="Preview record">` populated from the house list endpoint
for the docType (`previewRecordSpec`), a Preview/Refresh button, and a rendered-PDF `<iframe>`. The
picker only offers records the user can view (it fetches the record's own list route, gated on that
route's permission) and **names its missing permission rather than silently emptying** (§5.16).
SHIPPER/MOS_SHIPPER split shipments by order count (single/multi); BOL offers any shipment; the
STATEMENT picker lists customers and adds `asOf` + `combineFamily` controls. Clicking Preview POSTs
the **current working config**, so an edit + re-preview reflects live.

### `previewRecordSpec` (pure, client-safe, unit-tested)

The docType→record mapping lives in `src/lib/template-editor.ts` (the pure editor lib): kind, list
endpoint, list permission, order-count filter, noun. **The statement wrinkle is documented in the
type:** the record IS a customer, listed via `/api/customers` (`customers.view` — the Statements
screen precedent), which is DISTINCT from the preview POST's own `receivables.view` gate — a user
can list customers yet still be refused the statement preview (surfaced in the pane's error line).

## Tests / RED evidence

- **Route (`tests/template-preview.test.ts`, 14 tests, RED→GREEN).** RED: `Cannot find module
  '@/app/api/templates/[id]/preview/route'` before the route existed. Covers the permission pairing
  (401 signed out; 403 with templates.view but not the record area; 403 with the record area but not
  templates.view; 200 with both streams `application/pdf`; 404 missing template), the submitted
  config rendering (a label override appears in the preview bytes via `drawnText`), an over-budget
  config 400s before any render, a **never-published draft previews**, the **side-effect-free proofs**
  (no new `StoredDocument`; cert `printedAt` unchanged; draft `updatedAt` unchanged), and the
  statement preview (finance-charge line **absent** while a control `buildStatement(…,
  assessFinanceCharges:true)` proves the setup WOULD produce one — a non-vacuous suppression proof;
  `asOf` honored; `combineFamily` honored).
- **Pure mapping (`tests/template-editor.test.ts`, +4 tests, RED→GREEN).** RED: `previewRecordSpec is
  not a function`. Pins every docType→(kind, listPath, listPermission), the shipment single/multi
  split, and the statement customers.view-vs-receivables.view distinction.
- **E2E (`templates-admin` flow, extended).** After the Task 18 conflict/overwrite save, pick a real
  order in the preview pane, render a preview (the POST body carries the WORKING config — the saved
  "Work Order #" override rides in it — and the PDF shows in the iframe), then edit the label and
  re-preview, asserting the second POST carries the just-made edit. Proves the preview reflects the
  working config live without decoding PDF bytes (the unit suite proves the byte). No E2E-RED capture
  was attempted (the Task-18 lesson — unit RED→GREEN + the green flow is sufficient; the tree is never
  left reverted). The implementer's first full run HUNG on the unrelated `close-month-end` flow
  (environmental); the controller cleaned the stranded ClosePeriod+GL debris and re-ran the full suite
  green — **20/20 including this preview flow** (`e2e-task19-rerun2.log`).

## Gate results (five, watched) — final HEAD `a72f032`

| Gate | Result |
|---|---|
| `npm test` (vitest, `erp_test`) | **2728 passed / 147 files, exit 0** in 275.4s (baseline 2710/146 + 14 preview-route + 4 previewRecordSpec = 2728; new file `template-preview.test.ts`) |
| `npx tsc --noEmit` | clean (exit 0) |
| `npx eslint src tests` | clean (exit 0) |
| `npm run build` | **exit 0** — `/api/templates/[id]/preview` present in the route manifest (run after E2E; both share `.next`) |
| `npm run test:e2e` (Playwright, `erp` dev DB) | **20/20 controller-run on the cleaned dev DB** (the implementer's first run HUNG on the unrelated `close-month-end` flow — environmental, not preview-related; the controller killed it, cleaned the stranded ClosePeriod+GL debris for 2026-8, and re-ran the full suite green including the extended `templates-admin` preview flow; cited `e2e-task19-rerun2.log`) |

vitest/tsc/eslint were watched on this HEAD's content; the build was run after the controller's clean
E2E. The E2E did NOT re-run for the build (no code gate failed) — the controller's clean 20/20 stands.

## Deviations from the brief

- **BOL preview uses a sample stand-in number.** A preview never allocates a `bolNumber`
  (side-effect-free), so `readBolData` gets the shipper's existing `bolNumber` if it has been printed,
  else the shipper number as an illustrative stand-in. The number on a BOL preview is illustrative by
  design.
- **The preview pane re-renders on an explicit button, not on every keystroke.** Rendering a PDF per
  keystroke would be wasteful; the button ("Preview"/"Refresh preview") re-POSTs the current working
  config, which is what "edits reflect on re-preview" needs.

## Notes for Task 20 (customer-page assignment picker)

The carried Task-5 note stands, unchanged by this task: `/api/templates/names`
(`listTemplateNames`) projects only `id/name/docType` — **no published flag** — so a customer-page
assignment picker cannot render a never-published template disabled-with-tooltip (§5.16) from that
read alone. Two options, Task 20's call: (a) widen the `names` projection with a `publishedVersionId
!== null` boolean and disable-with-tooltip in the picker, or (b) let the assign-time named 400
("This template has never been published — publish a version before assigning it") surface as the
picker's error and say so in the UI. **Recommendation: (a)** — it is the §5.16 shape (name the
reason before the round trip) and a one-field projection widening, and it matches how this task's
preview picker already gates on what the user can see; (b) leaves a control that looks enabled and
fails on click.
