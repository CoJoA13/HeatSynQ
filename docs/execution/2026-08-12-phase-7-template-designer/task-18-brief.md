# Task 18 brief — The editor's draft save + conflict UX

**Branch:** `phase-7-template-designer` (Tasks 1–16 APPROVED; Task 17 in review — its editor PRODUCES the config + does a plain PATCH-save WITHOUT conflict handling, the seam it left YOU; suite controller-confirmed 2706/2706, E2E 20/20). Small, focused UX-hardening task.
**Read first:** the spec §5.1 (the draft-save's `updatedAt` precondition → named 409) + §5.5; the plan Task 18; HANDOFF **§5.13** (BINDING: "a reload that clears the error banner must never run after the error is set — roll back to server truth FIRST, then report why"); **Task 4's report** (the service side: `editDraft({config, updatedAt})` returns a named 409 on a stale precondition — this task surfaces THAT as the reload-vs-overwrite choice); **Task 17's report** (the exact SAVE SEAM it left — read what the Save button does today: a plain `PATCH /api/templates/[id]/draft` with the config, gated on `templates.edit` + dirty, NO conflict handling); the ledger's carried Task-4 minor about the same-millisecond `updatedAt` ABA window (from Task 4's review → Task 18) — decide whether to also add the config-hash comparison it suggested, or record why the ms-precision precondition is sufficient. Then `TemplateEditor.tsx` (the save wiring Task 17 built) and one existing page that handles a save-conflict/optimistic-error gracefully for the house pattern (e.g. the quote/customer detail pages post the §5.13 fixes).

## Deliverable — harden `TemplateEditor.tsx`'s save

1. **Send the `updatedAt` precondition.** The editor loaded the draft with its `updatedAt`; the save PATCH carries it (Task 4's `editDraft` already checks it and returns a named 409 when the draft changed since load). Confirm the client actually sends it (Task 17 may have sent it already or not — the report names the seam; wire it if absent).
2. **The 409 conflict UX.** On the named 409 ("draft changed since you loaded it" or Task 4's exact message):
   - Present a **reload-vs-overwrite choice**, not a silent clobber and not a silent discard: tell the user their copy is stale, and offer to reload the server's current draft (losing their in-editor edits) OR — if the design supports it — re-apply their edits onto the fresh `updatedAt` and retry (a deliberate overwrite). At minimum: reload-to-server-truth as the safe default, clearly labeled.
   - **§5.13 is the load-bearing rule:** the error/conflict banner must NOT be cleared by the reload that follows it. Roll back to server truth FIRST (fetch the fresh draft, reset the editor state), THEN show the "your edits were stale — reloaded the current draft" message; the message persists until the user acts, never wiped by the reload itself. A save that succeeds clears the banner; a reload triggered BY the error does not.
3. **Ordinary save success** stays as-is (dirty→clean, no error). A non-409 error (validation 400 from `validateConfig`, 403) surfaces its message without the reload path (only the stale-precondition 409 gets the reload-vs-overwrite treatment).
4. **The same-ms ABA note (carried Task-4 minor):** either add the config-hash comparison (a save whose precondition `updatedAt` matches but whose base config differs is still refused) OR record in the report why the ms-precision precondition is sufficient for a 1–5-user office (the honest call — a same-ms double-save requires two round trips landing inside one ms, and the editor is single-user-per-draft in practice). Your choice, justified.

## Tests (TDD; RED evidence REQUIRED)

- The vitest harness is node-only (no jsdom) — so unit-test the PURE conflict-resolution logic (given a 409 response + current editor state → the resulting action: reload vs. the message shown; the state-machine that decides), and prove the UI in E2E.
- **The E2E conflict flow** (the load-bearing proof): open a draft in the editor, simulate a competing change to the same draft (e.g. a second PATCH via API, or a second browser context — read how the E2E harness can bump the draft's `updatedAt`), then attempt a save → assert the 409 is surfaced as the reload-vs-overwrite choice, the banner is NOT cleared by the reload, and after reload the editor shows server truth. This is Task 18's whole point — make it a real flow.
- Existing suites green; Task 17's editor E2E steps still pass.

## Gates — E2E REQUIRED

Four unit gates + full E2E **detached, per-task sentinel `e2e-task18.done`**, `build` after E2E. **Wait on the sentinel FILE, not a process grep** (the controller's Task-17 lesson: a `pgrep` for "vitest"/"test:e2e" self-matches). Rows from the run's own output or PENDING; dev-DB fixtures cleared. Commit in small logical units.

## Report

`docs/execution/2026-08-12-phase-7-template-designer/task-18-report.md`: the conflict-UX design (reload-vs-overwrite, the §5.13 ordering), the same-ms ABA decision + justification, RED evidence (esp. the conflict-flow), all five gates watched, deviations, notes for Task 19 (preview — the side-effect-free render POST + the per-type pickers). Final message: 5-line summary + report path. Update your ledger row.
