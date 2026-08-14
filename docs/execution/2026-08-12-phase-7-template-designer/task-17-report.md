# Task 17 report — The structured editor: panels + logo

**Branch:** `phase-7-template-designer` · the heart of the template designer — the contract-driven
editing panels behind `/admin/templates/[id]/edit`. **Takeover note:** the previous implementer was
terminated mid-task by a transient stream error (not a fault in its work). It had landed all the
unit-testable core and both carried pre-steps; I inherited that sound base and built the React
components + the E2E on top of it. Nothing inherited was redone.

## Inherited (verified sound, built on — NOT redone)

- `ac0a54a` — **pre-step 1**: `lockedElements` namespaced by scope (`{scope: "section"|"field", key,
  reason}`), so a section key and a field key that collide can't render one ambiguous padlock. Its
  contract test (`tests/template-contracts.test.ts`) is green.
- `c5796f8` — **pre-step 2**: the ctx-typed 401/403/200 test for `GET /api/templates/[id]/blockers`
  (mirrors the `/blockers/export` sibling). Green.
- `c5796f8`/`29c2e41` — the **pure config-editing logic** (`src/lib/template-editor.ts`, 25 tests):
  show/hide, pin-aware section reorder, field reorder, label override, column width, format knobs,
  fonts, text blocks, logo placement/width, and `tableBudgets` (the data-returning mirror of the
  server's width guardrail). Immutable throughout. Plus the defense-in-depth tests confirming the
  **server still refuses** a hand-built locked-element-hiding or over-budget config.
- The E2E fixture logo `erp/e2e/fixtures/logo.png` (160×48 PNG, 214 B) — committed with the E2E work.

## What I added

### `lockIndex` — the one fresh pure helper (`e6bff36`, TDD RED-first)

The panels render padlocks from the contract's own `lockedElements` (spec §5.6), keyed by
`(scope, key)` so a locked section and a free field sharing a key never collide — the same reason
string the server quotes on refusal, one source. Added `lockIndex(contract): Map<string,string>`
(keyed via `lockKey(scope, key)`). **RED evidence:** the two new tests failed with
`TypeError: (0 , lockIndex) is not a function` before the function existed; green after (27/27 in
`tests/template-editor.test.ts`). The collision test builds a synthetic contract with a locked
section `shared` and a free field `shared` and asserts `section:shared` resolves while `field:shared`
does not — the namespace pre-step made load-bearing.

### The editor components (`7170d16`) — ONE tree, all 8 docTypes, no per-type branch

- **`page.tsx`** — a thin client page: `useParams` → `<TemplateEditor templateId={id} />`.
- **`TemplateEditor.tsx`** (orchestrator) — loads `GET /api/templates/[id]`, holds the draft config
  in component state, hands every panel one `apply(fn)` (= `setConfig(fn(config))`, marks dirty).
  `contractFor(detail.docType)` selects the contract; every panel renders from it. Handles the
  no-open-draft and load-error states. Client component against the guarded API (the templates-admin
  list precedent) — **no `src/server/**` import** anywhere in the tree.
- **`panels.tsx`** — the pure-config panels, each a thin wrapper over a tested editor function:
  - **SectionsPanel** — sections in config order; per section a show/hide toggle (disabled when
    `!hideable`), reorder ↑/↓ (disabled per `canMoveSection` — a pin never moves, a move never
    displaces a pin), and nested per-field rows (show/hide per `removable`, reorder, **label
    override** input with the contract default as placeholder). Locked sections/fields render a 🔒 +
    the reason (from `lockIndex`) and their controls are disabled.
  - **WidthsPanel** — column fields grouped by table, a numeric width input each, **live budget**
    from `tableBudgets`: the per-table `total / budget` and an inline red over-budget alert. Hidden
    columns show greyed and are excluded (hiding a column frees budget, matching the server).
  - **FormatsPanel** — renders only the knobs the contract declares (negative style, price decimals,
    thousands separator, date format), from the enumerated option lists. No per-type branch — a
    traveler shows just its thousands toggle; a billing doc shows its dropdowns.
  - **FontsPanel** — the curated 4-family list + the three role sizes.
  - **TextBlocksPanel** — a textarea per contract text block (absent when the contract declares none,
    e.g. the traveler).
  - **PageFooterPanel** — the "Page N of M" toggle (reflects the contract default; quote = true).
- **`LogoPanel.tsx`** — the one non-pure-config panel (below).

### The logo panel (`7170d16`)

The bytes live on the draft **version row**, not in the config; the config carries only placement +
width. So the panel does two separable things: (1) upload/clear the bytes via a multipart
`POST`/`DELETE /api/templates/[id]/logo` (the Task 4 route that sniffs magic bytes, caps at 512 KB,
allow-lists PNG/JPEG — its 400 is surfaced cleanly); (2) placement + width as plain config edits
(`setLogoPlacement`/`setLogoWidth`/`clearLogoPlacement`). The FormData fetch goes direct, not through
`api()` (a multipart body needs the browser's own boundary Content-Type — the `UserSignatureControl`
precedent). **The bytes write bumps the draft's `updatedAt`**, so on upload/clear the panel calls
`onLogoChanged` → the orchestrator refreshes ONLY the `updatedAt` precondition + the logo-present flag
(never the config, so in-progress unsaved edits survive).

## THE SAVE SEAM (for Task 18)

`save()` in `TemplateEditor.tsx` does a **plain `PATCH /api/templates/[id]/draft`** with
`{ config, updatedAt }` (the config held in state + the `updatedAt` loaded from the draft). On success
it advances `updatedAt` from the response so a second save in the same session still matches the
precondition, clears the dirty flag, and shows a transient "Saved". On **any** error — **including a
409 stale-precondition** — it surfaces the server message in the error banner. **There is NO
409-specific UX.** Task 18 hardens exactly this `catch`: detect `ApiError.status === 409`, offer the
reload/re-apply flow, etc., building on the config state + PATCH wiring this component establishes.
The Save button is gated on `templates.edit` and disabled unless the draft is dirty. (The logo route
is a separate write and already functions — it is not part of this seam.)

## Defense in depth (UI + server)

A locked-element-hiding or over-budget config is **impossible to produce from the UI** (locked
toggles/reorders disabled; widths surfaced against the budget live) **AND** the server refuses a
hand-built one regardless — the inherited `template-editor.test.ts` "defense in depth" block asserts
`validateConfig` throws `TemplateConfigError` for a hidden locked section, a hidden locked field, and
an over-budget table. Not UI-alone (spec §5.6).

## Browser verification (DOM-level, dev DB)

Verified live as admin against the dev DB (created an INVOICE and a TRAVELER draft via the API, opened
each editor, then hard-deleted both — dev DB confirmed 0 `Smoke *` templates, 8 seeded live):
- The INVOICE editor renders every contract section/field, the 4-column width budget ("202 / 564pt"),
  the invoice's declared format dropdowns (negative style / price decimals / date format), fonts,
  footer, logo — all from the contract, no per-type branch.
- The TRAVELER editor renders the **locked** Header section and Order-barcode field and the **locked**
  Process-steps section with their §5.6 reasons; their checkboxes are `disabled: true`, while free
  sections/fields (Part lines, Part quantity) are enabled. No app console errors (only dev HMR
  websocket noise). (Interactive click-through was left to Playwright — the browser pane wasn't
  compositing, so coordinate clicks were unreliable; the DOM state was authoritative.)

## Tests / RED evidence

- **`lockIndex`** — 2 new tests, RED-first (`is not a function`), green at 27/27.
- The inherited pure-logic + defense-in-depth tests stay green (verified before and after my changes).
- The rendered UI (no jsdom in the node-only vitest harness) is proven in the **E2E** below.

## Gates (five — CONTROLLER-RUN on final HEAD `a10fb85`, 2026-08-13 late)

The implementer parked mid-close-out (tsc/eslint done, vitest/E2E/build left PENDING) waiting on
completion notifications its ended turn could not receive; a controller watcher then hung on a
`pgrep` self-match bug (it grepped for "vitest"/"test:e2e", matching its own command line — see
memory `watcher-pgrep-self-match`). The controller re-ran the three PENDING gates directly:

| Gate | Result |
|------|--------|
| vitest (full, `erp_test`) | **2702 passed / 1 failed (2703)** — the ONE failure is `quote-templates.test.ts` "a label override prints through the real path", **pre-existing since Task 14** (verified: it fails identically at Task 14's approved commit `b13a876`), NOT introduced by Task 17's diff (which touches only the editor UI + pure logic + the E2E flow). Being fixed separately (`quote-label-override-fix-report.md`); Task 17's OWN new tests all pass. |
| tsc `--noEmit` | **PASS (exit 0)** |
| eslint `src tests` | **PASS (exit 0)** |
| E2E (`npm run test:e2e`, `erp` dev DB) | **PASS — all 20 flows** (controller-run, EXIT 0) |
| build (`npm run build`) | **PASS (exit 0)** (controller-run, after E2E) |

Task 17's review is held until the quote-test fix lands the full suite green, so the reviewer sees
a clean baseline.

### E2E extension

The `templates-admin` flow, after its create/publish/re-draft lifecycle, opens the v2 draft in the
editor and exercises the panels: a **locked** element (barcode + steps) renders locked and disabled
with its §5.6 reason; a **free** section toggles (draft goes dirty); a **label override** is set; a
**format** knob is picked; and the **fixture logo** is uploaded through the sniff/cap route with a
header placement chosen. It does **NOT** click Save (Task 18 owns save + conflict). The template — logo
bytes and all — is reaped by name in teardown (`deleteDocumentTemplatesByName`), no seeded/shared
state mutated.

## Deviations / notes

- **No new API route, schema, or migration** — the editor is pure client + the existing Task 4/16
  routes.
- **No CLAUDE.md / spec §15 change** — this is UI over an already-decided contract; nothing amends a
  binding convention or the spec contract. Recorded here + the ledger; HANDOFF §4 carries the state.
- **Format knob exercised in E2E is the traveler's thousands-separator** (its only declared knob, so
  the fully-owned fixture stays a traveler for the locked-element requirement); the billing docs'
  format dropdowns are the same `FormatsPanel` with no per-type branch, verified in the browser check.

## Notes for Task 18 (save/conflict UX)

- Build on `TemplateEditor.tsx`'s config state + the `save()` PATCH seam above. The only change is the
  `catch`: detect `ApiError.status === 409` (the service's message is
  "The draft changed since you loaded it — reload the editor and re-apply your changes") and drive a
  reload/re-apply flow instead of the plain banner.
- `updatedAt` is already threaded (loaded, advanced on save success, refreshed after a logo write).
  A logo upload/clear bumps it server-side, which `onLogoChanged` already keeps fresh — Task 18's
  conflict detection must not regress that path.
