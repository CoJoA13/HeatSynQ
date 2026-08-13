# Task 9 brief — Order entry, order hub, and part page surfaces

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-11 · **Depends on:** Tasks 1–8 (the eligible route, order-detail link exposure, and the /quotes pages all exist)

**Binding documents (read in this order):**
1. `CLAUDE.md` — client/server boundary, §5.16.
2. `docs/superpowers/specs/2026-08-10-phase-6-quoting-design.md` — §3 ruling 7 (overridable auto-link), §5.2 (Display bullet), §4.2 (Part row).
3. `docs/superpowers/plans/2026-08-10-phase-6-quoting.md` — Global Constraints + Task 9.
4. `docs/execution/2026-08-10-phase-6-quoting/task-05-report.md` — the `/api/quotes/eligible` payload (`{ candidates, autoLink }`), the three-way save semantics (explicit id / explicit null / absent), and the OrderDetail per-line link fields.

**Deliverable:** the quote link visible and controllable everywhere the spec puts it. UI only; no server changes (STOP and report if a gap proves one necessary).

## What to build (plan Task 9)

1. **Order entry** (the Phase 3 entry form): when a line's part is chosen, fetch `/api/quotes/eligible` (customer + part + the form's received date) and show the resolution — "Quote #1006" when `autoLink` exists, nothing when null. A re-pick control lists the candidates (latest-effective first, as served) plus "No quote"; the pick writes the three-way field into the save payload (absent = server auto-resolve, explicit id, explicit null — match Task 5's semantics exactly; an untouched control sends ABSENT, not the displayed id, so the server's resolution stays authoritative). Drafts carry the pick (verify the draft payload passes it through). §5.16 on the control for users without `orders.edit`/`orders.create`. Received-date changes refresh the PREVIEW for unsaved lines (saved lines keep their stored link — ruling 6; do not re-fetch for them).
2. **Order hub**: each line shows its linked quote number, linked to `/quotes/<id>`, in the overview/parts sections (follow the hub's existing per-line display conventions). The edit surface (if the hub's line editor allows `quoteLineId` changes per Task 5's updateLine) gets the same re-pick control; if the hub has no line editor for this, display-only is correct — say which you found.
3. **Part page**: the active-quote indicator (spec §4.2) — the part's in-date OPEN quote line(s), latest-effective first, each linked to its quote. Use an existing endpoint if one serves this (the eligible route with today's date is the closest fit — cite what you use); §5.15 considerations if a new read is needed (STOP and report rather than widening a route silently).
4. **Invoice grid check**: Task 6 added the source display; verify the order-hub→invoice flow shows it coherently (no work expected — flag anything odd).

## Hard constraints

- Client components only; mirror types locally; house `api<T>()`; §5.13 error discipline; §5.16 gates; no `.catch(() => {})`.
- Commands from `erp/`; conventional commits, no trailer; don't touch `erp/.claude/`.
- Gates: `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`, AND `npm run test:e2e` watched synchronously to completion (order-entry flows change — all 18 must stay green; clear dev-DB fixtures).
- Update `progress.md`'s Task 9 row in your final commit.

## Report

`docs/execution/2026-08-10-phase-6-quoting/task-09-report.md`: what you built; the absent-vs-explicit payload discipline narrative (how the untouched control stays ABSENT); the hub edit-surface finding; what serves the part-page indicator; deviations; gate + E2E results with counts; scrutiny pointers. Commit it.
