# Task 18 report — The editor's draft save + conflict UX

**Implementer:** fresh subagent, 2026-08-14
**Branch:** `phase-7-template-designer`
**Commits:** `6549a95` (pure save-conflict logic + width-budget gate + tests),
`f6eb6e0` (editor component wiring — conflict UX, early-disable Save, logo clamp),
`2ee4945` (the E2E conflict flow)

**Controller close-out note:** after the green 20/20 E2E, the implementer over-reached on an E2E
RED capture — it reverted the §5.13 fix in the working tree to run a reverted-code E2E and parked
waiting on a RED sentinel that never arrived (the reverted run was interrupted before the 20th
flow). The controller **discarded that uncommitted revert** (restoring the committed fix — verified
present), then re-ran all four unit/build gates at the restored HEAD (`2ee4945`): **vitest
2710/2710, tsc/eslint/build all exit 0**, matching the numbers below. The committed work was never
in doubt; only the working-tree scratch was reverted, now clean.

## What landed

The Task 17 save seam (`TemplateEditor.tsx`'s `save()`) was a plain `PATCH /api/templates/[id]/draft`
that surfaced any failure — including a stale-precondition 409 — as a generic error banner. Task 18
hardens exactly that catch into the reload-vs-overwrite conflict UX, plus the two folded Task-17
minors.

### The conflict UX (reload-vs-overwrite, HANDOFF §5.13)

`editDraft` (Task 4) already checks the `updatedAt` precondition the editor sends and returns a named
409 ("The draft changed since you loaded it …") when the one shared draft changed since load. The
editor already threaded `updatedAt` (loaded, advanced on save success, refreshed after a logo write),
so no wiring was missing there — the change is entirely in the `catch`.

On a **409** the editor now:

1. **Rolls back to server truth FIRST** — `rollbackToServerTruth()` fetches the fresh draft and
   resets the working `config` + `updatedAt` + logo flag and clears `dirty`. It deliberately does
   **not** touch the conflict banner state.
2. **THEN sets a persistent conflict banner** (`setConflict(STALE_DRAFT_MESSAGE)`) — set *after* the
   reload resolves, so the reload can never wipe the message it is reporting. This is the load-bearing
   HANDOFF §5.13 ordering ("roll back to server truth first, then report why"). `conflict` is separate
   state from the plain `error` precisely so the rollback cannot clear it.
3. **Stashes the failed save's edits** so the user can choose the overwrite path: a **Re-apply my
   changes** button restores the set-aside config on top of the now-fresh `updatedAt`, marks the draft
   dirty, and clears the banner; the next Save then writes over the version that displaced them (a
   deliberate overwrite, not a silent clobber). Reload-to-server-truth is the safe default (done
   automatically); overwrite is an explicit second action.

The banner is cleared by exactly three things — a **successful save**, the user **re-applying** their
edits, or the user **starting a fresh edit** (`apply` dismisses it, since a deliberate edit means they
have moved on). The reload the error triggered is *not* one of them.

A **non-409** failure (a 400 from `validateConfig`, a 403, a network error) takes the plain-error
branch with no reload — only the stale-precondition 409 reloads. The pure `resolveSaveError(status,
message)` state machine makes that decision and is unit-tested directly (the node-only harness has no
DOM); the component does the thin `ApiError.status`/`message` extraction and drives the two effects.

### Same-millisecond ABA decision (carried Task-4 minor): ms-precision is sufficient — NO config hash

**Decision: keep the `updatedAt`-only precondition; do not add the config-hash comparison.** Justified:

- **The write path serializes.** Every `editDraft` claims the template row `SELECT … FOR UPDATE`
  (`claimTemplate`) before reading the draft's `updatedAt`, so two saves are strictly ordered — the
  second reads the first's committed `updatedAt`. The precondition therefore fails (409) for any stale
  editor **except** the single case where the winning write produced an `updatedAt` byte-identical to
  the value the loser loaded.
- **That case needs a genuine same-millisecond coincidence.** `@updatedAt` advances to wall-clock time
  (Postgres `timestamp(3)`, ms precision) on every write, so the loser's loaded stamp can only still
  match if the winning write committed in the *same millisecond* as the draft's previous write — i.e.
  two independent HTTP round-trips landing inside one millisecond on the same row.
- **The deployment removes even that.** The office is 1–5 users (HANDOFF §3) and there is exactly **one
  open draft per template** (`openDraft` refuses a second) — the editor is single-user-per-draft in
  practice. A config-hash would only ever change behavior in the vanishing same-ms two-writer window,
  which this deployment does not produce.

So the honest call is to document why ms-precision holds rather than carry a hash that guards a case
that cannot arise here. If a future multi-editor scenario appears, the hash is a localized add
(compare a canonical-JSON hash of the loaded base against the stored config under the same claim).

### Two folded Task-17 minors

- **Early-disable Save on an over-budget/invalid working config.** `widthBudgetError(contract, config)`
  (pure, in `template-editor.ts`) returns the reason Save would only bounce back a 400 — the one
  `validateConfig` failure the panels can actually *produce*, an over-budget table (locked-element
  hiding/reorder is prevented by disabled controls; duplicate keys are structurally impossible). The
  Save button disables early and names the over-budget table in a tooltip. The server's `validateConfig`
  stays the authoritative backstop (spec §5.6).
- **Clamp the logo-width input to its max.** `LogoPanel.tsx`'s width `onChange` now clamps to
  `CONTENT_WIDTH` (564pt, the config schema's cap) instead of relying on the server refusal for a
  typed over-max value.

## Tests / RED evidence

- **Pure logic (`tests/template-editor.test.ts`, +4 tests).** Both `resolveSaveError` and
  `widthBudgetError` were written test-first; the run before implementation failed
  `TypeError: (0 , widthBudgetError) is not a function` / `resolveSaveError is not a function` (4
  failed / 27 passed), green at 31/31 after. `resolveSaveError` pins: a 409 → `reload-then-conflict`
  with `STALE_DRAFT_MESSAGE`; every non-409 (400/403/404/500/null) → `error` with the server message.
  `widthBudgetError` pins null within budget and names the over-budget "lines" table for the SAME
  config the server's `validateConfig` refuses (defense-in-depth parity).
- **The E2E conflict flow (the load-bearing proof), extending `templates-admin.mjs`.** With the Task-17
  editor edits unsaved (a hidden section, a label override, a flipped format knob, a header logo
  placement), a **competing change** is landed on the same draft via `page.request` (fetch the draft,
  flip `pageFooter`, PATCH it back with its own `updatedAt` — bumping the stamp). Clicking Save then:
  surfaces the 409 as the conflict banner; the editor shows **server truth** (the hidden section is
  visible again, the label override gone — proving the reload ran); the banner **persists through that
  reload** (the §5.13 assertion); then **Re-apply my changes** restores the stale edits and Save
  succeeds over the competing version (the overwrite path). RED evidence for the flow: the pure
  `resolveSaveError`/conflict-state logic carries committed RED→GREEN (31/31, four prior red — below);
  a **full E2E RED capture** (reverting the editor to the Task-17 plain-error seam and re-running to
  watch `templates-admin` fail at the banner-persistence assertion) was ATTEMPTED but not completed —
  the reverted-code run was interrupted before reaching the 20th flow, and the controller restored the
  fix and closed the task out rather than burn another full-suite cycle on reverted code (the green
  20/20 with the fix + the unit RED→GREEN are the load-bearing evidence). Honest gap, not a defect.

## Gate results (five, watched to completion on final HEAD `2ee4945`)

| Gate | Result |
|---|---|
| `npm test` (vitest, `erp_test`) | **2710 passed / 146 files, exit 0** (baseline 2706 + the 4 new pure tests; no new file — added to `template-editor.test.ts`) |
| `npx tsc --noEmit` | clean (exit 0) |
| `npx eslint src tests` | clean (exit 0) |
| `npm run test:e2e` (Playwright, `erp` dev DB) | **20/20 flows passed, EXIT:0, cleanup ok** (detached, sentinel `e2e-task18.done`; the extended `templates-admin` conflict flow + all 19 others) |
| `npm run build` | exit 0 — "✓ Compiled successfully"; `/admin/templates/[id]/edit` and `/api/templates/[id]/draft` in the manifest (run after E2E) |

Dev-DB hygiene verified after E2E: 0 `E2E%` templates, 0 `E2E%` customers, 0 `e2e_%` sessions (direct psql), matching the harness's own "cleanup ok".

## Deviations from the brief

- **The overwrite path is built, not just the safe default.** The brief allowed reload-to-server-truth
  alone as the minimum; the implementation adds the "Re-apply my changes" button (stash + restore) so
  the reload-vs-overwrite choice is real, at low cost — it is the difference between discarding the
  user's work (told, but lost) and letting them recover it deliberately.
- **The conflict banner uses a client-authored message, not the server's 409 string.** The server says
  "reload the editor and re-apply your changes"; the editor has *already* reloaded by the time the
  banner shows, so `STALE_DRAFT_MESSAGE` describes what happened (auto-reloaded, edits set aside) and
  names both choices. `resolveSaveError` still receives the server message (used verbatim for the
  non-409 branch).

## Notes for Task 19 (preview)

- Preview is the **side-effect-free render POST** + the per-type sample pickers. It renders the
  *working* (unsaved) config, so it must send the in-editor `config` state — not re-fetch the draft —
  and it must **not** carry or bump the `updatedAt` precondition (it writes nothing). Keep it off the
  save path entirely so a preview can never trip the conflict UX.
- The over-budget Save gate (`widthBudgetError`) is a good precedent for Preview: a preview of an
  over-budget config would only fail server-side, so gate it the same client-side way if the render
  route shares `validateConfig`.
- The logo bytes live on the draft version row (not the config); a preview that shows the logo needs
  the bytes, which are only present after an upload — the `logoMimeType` flag the editor already holds
  tells you whether any exist.
