# Task 21 brief — The restyle E2E flow (the roadmap's testable outcome), docs, final gates

**Branch:** `phase-7-template-designer` (Tasks 1–19 APPROVED; Task 20 in review; suite 2741/2741, E2E 20/20). **The capstone** — proves the roadmap's Phase 7 testable outcome end to end, then closes the phase's docs and issues.
**Read first:** the roadmap Phase 7 row (**testable outcome: "Owner restyles the traveler/logo"**); the plan Task 21; the spec §5.1 (draft→publish→print); **the whole ledger** `docs/execution/2026-08-12-phase-7-template-designer/progress.md` (every carried whole-branch note + the approved-task summaries feed the docs pass); the fixture logo at `erp/e2e/fixtures/logo.png` (Task 17). Then the existing `templates-admin` E2E flow (it already exercises the editor + preview + assignment picker — you EXTEND it or add a sibling flow for the restyle-print outcome), `docs/HANDOFF.md` §4, and `CLAUDE.md`.

## Deliverable 1 — the restyle-print E2E flow (the roadmap outcome)

A Playwright flow that demonstrates the whole loop, end to end, as an OWNER would:
1. Create a draft from the Standard **traveler** template (or open a draft on it).
2. In the editor: **upload the fixture logo** (`erp/e2e/fixtures/logo.png`) with a header placement, and **rename a label** (e.g. a traveler field label → a distinctive marker like `RESTYLED-TRAVELER-MARKER`).
3. **Preview** it against a real order (the side-effect-free render — assert the preview shows the marker).
4. **Publish** the draft (the `edit_templates` act).
5. **Assign** the published traveler template to the order's customer (or set it default) so the print resolves it.
6. **Print** that order's real traveler (`POST /api/orders/[id]/traveler`).
7. **Assert the stored PDF carries the restyle**: decode the stored bytes (via the /Length-hardened `tests/helpers/pdf.ts` if in a unit test, or assert content/markers if in the E2E harness's own way) — the renamed label marker is present, and the `StoredDocument.templateVersionId` is stamped with the published version's id. This is the roadmap's "the paper shows it."

This can be an E2E flow (`templates-restyle` or folded into `templates-admin`) AND/OR a unit-level integration test that drives the real services (createTemplate→editDraft→uploadLogo→publishDraft→assignTemplate→printTraveler→decode) — the unit form is more decodable (the E2E harness may not easily decode PDF bytes); do BOTH if practical, but the load-bearing assertion (marker in the stored bytes + stamp) must exist somewhere real. State which in the report.

## Deliverable 2 — the docs pass (owner instruction: docs are part of the work)

1. **`docs/HANDOFF.md`**: update §4 (the current-phase state → Phase 7 essentially complete, all 21 tasks; the moving numbers — final test/file counts, E2E flow count, migration count [35]; the deferred findings → issues). Keep §4 lean (one-pass readable — the per-task detail stays in the execution ledger). Do NOT yet write the "MERGED" narrative (the PR/merge is the controller's, post-whole-branch-review) — write it as "Phase 7 build complete, whole-branch review pending."
2. **`CLAUDE.md`**: add the new standing conventions Phase 7 established (per the plan Task 21 + spec): **template contracts + locked elements + the §5.3 default backfill; publish-by-immutability (prints resolve the last published version, correct at any isolation because published versions are immutable — NOT by locking); pdf-lib confined to render.ts; the four retired standing-text settings keys now live in template content.** Also fix the carried **stale sample handler** (Task 4/20 note: `requireUser()` is no-arg/synchronous — the sample should read `mustCan(requireUser(), …)`, not `await requireUser(req)`). Keep CLAUDE.md curated (displace superseded guidance, don't just append; no moving numbers).
3. **spec §15 decision log**: the master spec's Phase 7 amendment table was written at kickoff — verify it still matches what shipped (draft→publish, the four format knobs, curated fonts, division→ancestor resolution, Part.processName, settings retirement); correct any drift.
4. **Close the fold-in issues from the branch**: #36 (traveler continuation header), #43 (bounded all-loads), #87 (safe Content-Disposition), #97 (indicativeAmounts assert), #98 (sourceQuoteNumber refine) — do NOT `gh issue close` them now (they close via the PR body's `Fixes #NN` at merge — the controller's job); INSTEAD, list them in the report as "closed via PR body at merge" and confirm each is genuinely resolved on the branch (a one-line pointer to the task that fixed each).

## Deliverable 3 — final full gates (the whole-branch baseline)

Run ALL FIVE gates to completion, watched, on the final HEAD: `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`, `npm run test:e2e` (detached, sentinel `e2e-task21.done`, wait on the FILE; if a run hangs/you kill it, clean the ClosePeriod+GL debris in FK order before re-running). Also `migrate status` clean on BOTH DBs. These numbers become the phase's final baseline for the whole-branch review — record them prominently.

## Tests (TDD; RED evidence for the restyle assertion)

The restyle flow's marker-in-stored-bytes + stamp assertion (RED: it fails against an UNpublished/unassigned state — the print falls to the Standard default with no marker); existing suites green.

## Gates & Report

All five gates watched; both DBs migrate-status clean. `docs/execution/2026-08-12-phase-7-template-designer/task-21-report.md`: the restyle flow (which form, the assertion), the docs updated, the 5 issues' resolution pointers, the FINAL gate numbers, deviations. **This is the last task — the report should also give a one-paragraph "state of the branch for the whole-branch review": what's done, the carried whole-branch notes (from the ledger — #102, the decoder's dormant fallback, the quote continuation band, the locked-field-in-hideable-section convention, the preview label-field cosmetics), and the final gate baseline.** Final message: 5-line summary + report path. Update your ledger row (Task 21 → done; note the phase build is complete pending whole-branch review).
