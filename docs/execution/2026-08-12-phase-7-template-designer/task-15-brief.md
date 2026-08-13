# Task 15 brief — `Part.processName` UI

**Branch:** `phase-7-template-designer` (Tasks 1–14 APPROVED; the server half is complete — all 8 documents templated; suite at 2665; E2E 19/19). First of the UI stretch, deliberately the smallest.
**Read first:** the spec §5.7 (ruling 4 — `processName` is presentation vocabulary; the traveler prints it live, the invoice snapshots it at create — BOTH already built in Tasks 7/12); the plan Task 15; HANDOFF §5.12 (detail pages remount per record — `<Detail key={id}>`), §5.13 (a reload must never clear an error banner), §5.16 (disabled-with-reason controls), and the part export/paste round-trip contract (HANDOFF's "Export/paste round-trip" carried minor — export emits more columns than paste accepts; do NOT reintroduce that asymmetry). Then the part form/detail component under `erp/src/app/parts/`, `erp/src/server/parts.ts` (the part create/update service + its zod schema + the audit path), and the part export + spreadsheet-paste machinery (find the columns list both share).

## Context

`Part.processName String @default("")` already exists (Task 3 migration) and is already consumed by the traveler and invoice. This task ONLY surfaces it for data entry: the part form field, export, and paste. No schema change, no builder change, no print-path change.

## Deliverable

1. **The part form field** — an optional plain-text input beside the recipe/identity fields (it names the part's process for the traveler's Process: slot, e.g. "Austemper"). Bound so it remounts per record (`key={id}` / not a stale `defaultValue` — the §5.12 trap that cost a Critical in 2B). The service zod already must accept it (`processName` optional, `.max(n)` display-text shape per the parts convention — required identifiers use `.trim().min(1)`, optional display text uses `.max(n)` defaulting `""`); if `parts.ts` doesn't yet parse it, add it to the schema and the create/update writes, audited (the field appears in the before/after diff — assert a real diff, the house lesson).
2. **Export** — `processName` joins the part Excel export columns.
3. **Paste** — `processName` joins the spreadsheet-paste accepted columns, in the SAME column shape as export (the round-trip must survive export → edit in Excel → paste back; do not make export emit a column paste rejects). Mind the existing header-row / column-shape handling the parts paste already has.
4. **Permissions**: the field is editable with `parts.edit`, read-only otherwise (§5.16 — read-only input, not hidden; a `parts.view`-only user still reads it).

## Tests (TDD; RED evidence REQUIRED)

- Service: create/update with `processName` persists + audits a real before→after diff; the optional/empty-default shape (blank stays `""`, not null); a too-long value is rejected field-anchored.
- Export includes the column; paste accepts it; the round-trip (export shape === paste shape) — extend whatever round-trip/column-shape test the parts suite has, or add one.
- Existing part suites green and untouched.

## Gates — E2E REQUIRED (UI touched)

Four unit gates + full E2E **detached, sentinel `e2e-task15.done`**, `build` after E2E. The parts E2E flow(s) exercise the form — if a flow asserts the part form's field set, update it to include the new field. Rows from the run's own output or PENDING; dev-DB fixtures cleared. Commit in small logical units.

## Report

`docs/execution/2026-08-12-phase-7-template-designer/task-15-report.md`: the form-binding choice (remount discipline), the export/paste round-trip preservation, RED evidence, all five gates watched, deviations, notes for Task 16 (templates admin + nav — the first template-designer screen; the carried Task-4 minors about getTemplate's two reads and the blocker-export-standalone are its pre-notes, and the Shell nav entry gated on `templates.view` is Task 16 Step 1). Final message: 5-line summary + report path. Update your ledger row.
