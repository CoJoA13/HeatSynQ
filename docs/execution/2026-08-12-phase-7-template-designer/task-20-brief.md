# Task 20 brief — The customer-page template-assignment picker

**Branch:** `phase-7-template-designer` (Tasks 1–18 APPROVED; Task 19 in review; the assignment SERVICE + routes exist from Task 5, the `/api/templates/names` read exists; suite 2728/2728, E2E 20/20). Second-to-last task.
**Read first:** the spec §5.2 (per-customer assignment; resolution division→ancestors→default) + §5.5 + §7 (assign/clear gated `customers.edit` + `edit_templates`; clear needs no reason) + §5.15/§5.16; the plan Task 20; **Task 5's report + its carried ledger note** (the assignment service `assignTemplate`/`clearAssignment`/`listAssignments` + `resolveTemplateForPrint` are DONE and approved; the two routes exist — `GET/PUT/DELETE /api/customers/[id]/template-assignments` and `requireUser`-only `GET /api/templates/names`); **Task 19's report Task-20 note** (RE-AFFIRMED: `/api/templates/names` projects only `id/name/docType` with NO published flag, so the picker can't render a never-published template disabled-with-tooltip from that read — **widen the projection with a `published: publishedVersionId !== null` boolean**, the §5.16 shape, rather than letting the assign-time 400 surface). Then the customer detail page (`erp/src/app/customers/[id]/`), the assignment routes + `template-assignments.ts` (Task 5), and the house permission-gating helper (`permission-ui.ts`).

## Pre-step (carried, Task 5 → Task 20; re-affirmed Task 19)

Widen `listTemplateNames`/`GET /api/templates/names` to include `published: (publishedVersionId !== null)` per row (keep `id/name/docType`; still `requireUser`-only, still the narrow projection — just the one boolean). Update the route test's projection assertion. This lets the picker disable a never-published template with a §5.16 tooltip instead of letting the assign refusal 400 surface.

## Deliverable

1. **The picker on the customer detail page** — a per-docType (8 types) template assignment control. For each docType:
   - Shows the customer's current state: its OWN assignment if any, else **"inherited from <parent>"** if a parent assignment resolves, else **"<type> default (Standard)"** — displayed, never blank (§5.15 — a customers.edit user without templates.view must still see the names via the `requireUser`-only `/api/templates/names`; no silent-empty dropdown).
   - A dropdown of the docType's live templates (from the widened names read), each never-published one **disabled with a §5.16 tooltip** ("not yet published"); selecting one **assigns** (PUT), a "clear/use default" option **clears** (DELETE).
   - Assign/clear gated on **`customers.edit` + `edit_templates`** (§5.16 — the control is disabled-with-reason naming whichever is missing; the routes already enforce it — the UI must match, not be the gate).
   - Resolution display matches `resolveTemplateForPrint`'s logic (own → nearest ancestor → default) — reuse `listAssignments` + the customer's parent chain; do NOT reimplement resolution in the component (pull it from a shared read or the service's shape).
2. **No new service logic** — Task 5 built assign/clear/list/resolve. This task is UI + the names-projection widening. If you find a genuine gap in the Task 5 service (e.g. `listAssignments` doesn't return enough to render the inherited state), extend it minimally and test it, but prefer composing the existing reads.

## Tests (TDD; RED evidence REQUIRED)

- The widened `/api/templates/names` projection (the `published` boolean present; still `requireUser`-only, 200 with a bare session).
- The picker's pure display logic (given own/parent/default state → the rendered label + which option is selected + which are disabled) unit-tested (node-only harness — pure functions, UI in E2E).
- Assign/clear round-trip through the routes (already tested in Task 5 — keep green; add the UI-path coverage the component needs).
- §5.16: the control disabled-with-reason without `customers.edit` or `edit_templates`; a never-published template disabled with its tooltip.
- Existing suites green.

## Gates — E2E REQUIRED

Four unit gates + full E2E **detached, per-task sentinel `e2e-task20.done`; WAIT ON THE SENTINEL FILE, not a process grep**; `build` after E2E. **Extend the E2E** to open a customer, assign a published template for a docType, see the state reflect it, clear it back to default. **If your E2E run hangs or you must kill it, clean the dev-DB debris before re-running** (a killed run can strand a ClosePeriod+GL chain — delete `GlPosting`→`GlExportBatch`→`ClosePeriod` in FK order; the controller hit this in Task 19). Rows from the run's own output or PENDING; dev-DB fixtures cleared. Commit in small logical units. Do NOT over-invest in a bonus E2E-RED that leaves the tree dirty (the Task-18 lesson).

## Report

`docs/execution/2026-08-12-phase-7-template-designer/task-20-report.md`: the picker's state-display design, the names-projection widening, the §5.16/§5.15 handling, RED evidence, all five gates watched, deviations, notes for Task 21 (the restyle E2E flow — the roadmap's testable outcome: create draft from Standard traveler → upload the fixture logo + rename a label → preview → publish → print a real order's traveler → assert the stored PDF's markers + the templateVersionId stamp; plus the docs pass — HANDOFF §4, CLAUDE.md's new standing conventions, and closing #36/#43/#87/#97/#98 from the branch). Final message: 5-line summary + report path. Update your ledger row.
