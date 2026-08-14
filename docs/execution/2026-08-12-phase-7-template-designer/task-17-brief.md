# Task 17 brief — The structured editor: panels + logo

**Branch:** `phase-7-template-designer` (Tasks 1–16 APPROVED; the admin list stubs a link to `/admin/templates/[id]/edit`; suite at 2675; E2E 20/20). The heart of the designer.
**Read first:** the spec §5.5 (the editor — structured panels from the contract, beside a preview; preview itself is Task 19 — a stub/placeholder pane is fine here) + §5.6 (locked elements render locked with the reason) + §3 ruling 3 (the four format knobs) + §5.16; the plan Task 17; **Task 16's report** (the editor stub target `/admin/templates/[id]/edit`; reads `detail.draft` config from `GET /api/templates/[id]`, saves via `PATCH .../draft` with the `updatedAt` precondition — but SAVE/CONFLICT UX is Task 18, NOT this task; this task is the panels that produce a config object); the ledger's carried minors — **the `lockedElements` namespace tightening (Task 1 review) and the `/blockers` ctx-test (Task 16 review) are BOTH yours as pre-steps**. Then the contract machinery `erp/src/lib/template-contracts/` (types + `CONTRACTS` — the panels render FROM these), an existing multi-section editing page for the house component pattern, and `src/lib/permission-ui.ts` (the §5.16 gate helper).

## Pre-steps (carried)

1. **`lockedElements` namespace** (Task 1 review → here): it returns a flat `{key, reason}` list mixing section and field keys — a section key equal to a field key would render ambiguous padlocks. Tighten to distinguish namespaces (e.g. `{scope: "section"|"field", key, reason}`) before the editor renders padlocks from it; keep the contract tests green.
2. **`/blockers` ctx-test** (Task 16 review → here): add the two-line ctx-typed 401/403/200 test for `GET /api/templates/[id]/blockers` (match the `/blockers/export` sibling's test shape).

## Deliverable — `TemplateEditor.tsx` + panel components

A CLIENT component (imports the contracts from `src/lib/template-contracts/` — client-safe by design; NEVER `src/server/**`) at `/admin/templates/[id]/edit`. It loads the template detail (`GET /api/templates/[id]` → the draft's config + the docType), renders the contract-driven editing panels, and holds the edited config in component state. **This task PRODUCES the config and its in-memory editing; the PATCH-save + the `updatedAt` 409 conflict UX is Task 18** — wire a save button to a stub/no-op or a plain PATCH WITHOUT the conflict handling (Task 18 hardens it), and say clearly in the report which, so Task 18 knows the seam.

One component tree serving ALL EIGHT docTypes, driven entirely by the contract (never per-type branches in the UI — the contract is the single source):
1. **Sections panel**: show/hide toggles (respecting `hideable`), reorder (respecting `reorderable`). **Locked sections render locked with the reason** (from the namespaced `lockedElements`), disabled, tooltip = the reason — the user cannot hide the traveler steps or barcode.
2. **Fields panel** (per section): show/hide (respecting `removable`), reorder, and **label override** (a text input; empty = the contract default label). Locked fields render locked with the reason.
3. **Column widths**: numeric inputs where the contract declares a column; **validate live against the content-width budget** (the contract's width-budget rule — surface the over-budget error inline, the same 564pt/sub-budget the validator enforces server-side; the server `validateConfig` is the backstop, the client shows it early).
4. **Format pickers**: number format (negative style, price decimals, thousands separator) and date format — fixed dropdowns from the contract's enumerated options. (Note the QUOTE quirks Task 14 flagged: `pageFooter` default TRUE and `priceDecimals` default 4 are the quote contract's defaults — the editor just reflects the config; no special-case.)
5. **Fonts**: family per role from the curated 4-family list, sizes.
6. **Text blocks**: in-place editors for the contract's text blocks (cert statement, BOL legal text, quote intro/liability, shipper liability) — a textarea each, defaulting to the contract default.
7. **Logo panel**: upload (PNG/JPEG — the client sends bytes to `POST /api/templates/[id]/logo`, the Task 4 route that sniffs + caps at 512KB; surface the route's rejection cleanly) + placement slot (header-left/center/right) + width. A checked-in **fixture logo PNG** under `erp/tests/e2e/fixtures/` for the E2E (Task 21 reuses it).

**The edited config must round-trip**: what the panels produce, when sent to `validateConfig`/the PATCH, is a valid `TemplateConfig`; a locked-element-hiding or over-budget config is impossible to PRODUCE from the UI (the controls are disabled), AND the server refuses it anyway (defense in depth — do not rely on the UI alone; a test asserts the server still refuses a hand-built bad config).

## Tests (TDD; RED evidence REQUIRED)

- The namespaced `lockedElements` (both scopes); the `/blockers` ctx-test.
- Component-level where the harness allows (the vitest harness is node-only — no jsdom/RTL, per Task 7's quotes-fix note; so PURE logic — the config-building/merge/width-validation functions — is unit-tested directly, and the rendered UI is proven in E2E). Extract the config-editing logic (apply a label override, toggle a section, set a width, pick a format) into pure functions and unit-test them; the panels are thin wrappers.
- The defense-in-depth: a config that hides a locked element or over-runs the budget is refused by `validateConfig` (already tested Task 1/2 — reference it; add the editor's pure-logic guard test).

## Gates — E2E REQUIRED (UI)

Four unit gates + full E2E **detached, sentinel `e2e-task17.done`**, `build` after E2E. **Extend the E2E** to open the editor from the list, toggle a section / set a label override / pick a format / see a locked element locked, and upload the fixture logo (the panels are exercised; SAVE + conflict is Task 18's flow). Rows from the run's own output or PENDING; dev-DB fixtures cleared. Commit in small logical units. Recall §5a's Playwright traps.

## Report

`docs/execution/2026-08-12-phase-7-template-designer/task-17-report.md`: the panel architecture (contract-driven, no per-type branches), the SAVE seam left for Task 18 (exactly what the save button does now), the logo-upload wiring, the two carried pre-steps closed, RED evidence, all five gates watched, deviations, notes for Task 18 (the save/conflict UX builds on this editor's config state + the PATCH seam). Final message: 5-line summary + report path. Update your ledger row.
