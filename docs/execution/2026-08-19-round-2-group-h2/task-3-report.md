# Task 3 — #146 + #147 + #148, the three precedent-copies — implementer report

Branch `group-h2-client-state`. Three fix commits, one per issue, plus this report.

## Commits

- `de21da0` — fix(receivables): report the batch page's swallowed post-apply refresh failure (#146)
- `60a5fb0` — fix(receivables): gate close-page readiness display and export gating on a landed load (#147)
- `96f588b` — fix(parts): keep mid-save typing in custom fields across the save's success reload (#148)

## What changed and why

### #146 — `erp/src/app/receivables/batches/[id]/BatchDetail.tsx`

The `onApplied={() => { void load(); }}` callback fired the outer `load` detached; `load`
rethrows (only its mount effect catches), so a network blip after a SUCCESSFUL apply or
application-void was an unhandled rejection plus a silently stale page. The callback now runs
`load().catch(...)` and reports via `setError` with the in-file `voidBatchAction`
second-try/catch precedent's shape. Wording is generic ("The operation succeeded, but the page
could not be refreshed — reload to see the current state. (…)") because both `apply()` and
`voidApplicationAction()` fire it. ApplyPanel's own `load` self-catches and the mount call
already catches — both untouched, per the brief.

### #147 — `erp/src/app/receivables/close/Close.tsx`

Two consumer sites of `readinessGaps` were reading un-landed state, and — the brief's critical
subtlety — the load catch sets `loaded = true` while leaving the PRIOR month's gaps in state, so
`!loaded` alone is insufficient; every consumer now gates on `loaded && !error`:

- The readiness section gains the continuity-schedule (`:292`-idiom) `Loading…` arm, and BOTH
  branches (the affirmative all-clear AND the gap list) render only when `loaded && !error`. On
  error the top banner reports; neither a false all-clear nor a stale prior-month gap list can
  render.
- The selected row's `gapCount` becomes unknown (`null`) while un-loaded OR errored:
  `const gapCount = !isSelected ? 0 : loaded && !error ? readinessGaps.length : null;`.
  `exportTitle` gains the arm `closeTitle` has — `gapCount === null` disables Export with
  `"Loading…"` while loading and `"GL-export readiness could not be loaded"` after a failure
  (a plain `"Loading…"` would lie in the errored state, so the arm distinguishes the two).

Deliberate choices, for the reviewer to probe:

- **I did NOT clear `readinessGaps` in the catch.** The brief calls clearing acceptable
  belt-and-suspenders, not a substitute. I skipped it because it points the failure the
  dangerous way for any future ungated consumer: cleared gaps make `readinessGaps.length === 0`
  read as an affirmative all-clear (and would ENABLE Export) on error, whereas stale gaps at
  worst over-disable. Gating every consumer is the required fix and is done; the comment at the
  section documents the rule for future consumers.
- The stale `preliminary` in the same catch (closeTitle's variance arm, the schedule table) is
  out of scope per the brief/issue, and untouched.

### #148 — `erp/src/app/parts/[id]/CustomFieldsSection.tsx` + new leaf

The merge port per the controller call — the row stays editable during the request
(`ProcessStepsSection.tsx:217-219`'s rule), so freezing inputs was never an option. `save()` now
captures `rowsAtSave` at click; on success it fetches the fresh server rows itself (instead of
`await load()`'s wholesale replace) and applies the merge inside a functional `setRows`, so the
"current" side is the freshest draft even across React batching. `original` is always the server
data, which keeps a preserved in-flight edit correctly dirty (Save stays enabled for it).

The merge is the new pure leaf **`erp/src/lib/field-drafts.ts`** — `rowsAfterSave(server,
atSave, current)`. **Why a new leaf rather than extending `step-drafts.ts`:** step-drafts models
a separate touched-fields overlay composed at render time; CustomFieldsSection holds one `rows`
array that is simultaneously server copy and draft, diffed against an `original` map on Save.
The shapes share a rule (typed-in-flight survives the success handler) but no types or code —
grafting the array-snapshot merge onto the overlay leaf would couple two editors' models for
zero reuse. The new file's header states the kinship.

Merge semantics (each pinned by a test):
- Per server row: value kept from the CURRENT draft iff it moved between `atSave` and now
  (typed in flight); server's value elsewhere.
- Typed away and back to the at-save value = no longer the user's; server shows through (the
  `editsAfterSave` submitted-unchanged rule).
- An untouched field adopts another user's concurrent change (the step-drafts carry-forward
  lesson — no stale clean copy can mask it).
- The row LIST is always the server's: added rows appear with server values, dropped rows
  disappear (even if typed into — no input remains to hold the draft), and non-value metadata
  (name/active/sort/type) comes from the fresh row even where the draft value is kept.

TDD: `erp/tests/field-drafts.test.ts` written first and run RED (module absent), then the leaf
GREEN — 12 tests covering every input surface the brief lists: checkbox toggle, the H-added
clear control ("" staged mid-flight is typing, not "nothing typed"), date, number, text.

The `:37-41` no-optimistic-apply comment is extended (not replaced) to state the success path's
mirror-image duty.

One behavior note, unchanged from before the fix: if the follow-up GET fails after a successful
PUT, `original` stays stale, so already-saved fields still read dirty and a re-Save re-sends
them — an idempotent PUT, same exposure the old `await load()` failure path had. The component
also still has no `useLatest` ticketing anywhere (mount load vs save fetch); pre-existing, not
widened, out of scope.

## Deviations

- None from the brief's prescriptions. The two judgment calls (no gap-clearing in Close's catch;
  a new leaf over extending step-drafts) are justified above.

## Gates (task scratch DB `erp_scratch_h2t3`, dropped after)

- `npx vitest run tests/field-drafts.test.ts` — RED before the leaf existed, then **12/12 pass**.
- `npm test` (full suite, scratch DB) — **200/200 files, 3345/3345 tests pass** (2 formerly
  skipped now run; tree state at run time included Tasks 1 and 2's landed working-tree changes).
- `npx tsc --noEmit` — **exit 0**.
- `npx eslint src tests` — **exit 0**.

## Incident: the scratch-DB override the brief prescribes does not reach `npm test`

The brief (and the H2 conventions section) says to run suites with the same `DATABASE_URL`
override used for `migrate deploy`. That override is silently discarded for suite runs:
`tests/helpers/setup.ts:4` unconditionally does
`process.env.DATABASE_URL = process.env.DATABASE_URL_TEST`, and `.env`'s `DATABASE_URL_TEST`
points at the shared `erp_test`. My first full-suite run therefore hit `erp_test` DESPITE the
override — concurrently with another implementer's run — producing 119 failed files of
truncate-vs-reseed FK carnage (both runs' results invalid; no durable damage, `erp_test` is
truncated per test). **The working override for `npm test` is `DATABASE_URL_TEST`, not
`DATABASE_URL`** (`DATABASE_URL` remains correct for `prisma migrate deploy`, which resolves via
`prisma.config.ts`). The green run above used
`DATABASE_URL_TEST="postgresql://erp:erp_local_dev@localhost:5432/erp_scratch_h2t3" npm test`,
verified against `pg_stat_activity` (my one connection on the scratch DB; the other
implementer's on `erp_test`, un-collided). Any other task's full-suite result from roughly
06:33–06:50 on 2026-08-19 should be treated as invalid and re-run; the group brief's convention
wording should be corrected for future waves.

## For the reviewer to probe

- #146: is the generic wording right for both firing paths? The panel's own `await load()` after
  `onApplied()` cannot interact with the new catch at all: it self-catches BOTH fetch stages into
  the panel-local `loadError` (`BatchDetail.tsx:148/:159`) and never rejects, so there is no
  double-`setError` path. (Corrected in fix round 1 — the report originally claimed the two
  surfaces shared `setError` last-writer-wins, which was wrong in the safe direction; the
  shipped code was and is right. See the fix-round note below.)
- #147: the errored-state Export title wording, and the choice NOT to clear gaps in the catch.
- #148: the `before !== undefined && now !== undefined` guard in `rowsAfterSave` — a field
  absent from either snapshot cannot be proven typed-in-flight, so it takes the server value;
  in the component both maps are always populated for every rendered row.

## Fix round 1 (review round 1: Spec ✅ · Approved, one Minor + one report correction)

- **Minor applied — `653e516`**: the field-drafts suite's fixtures all kept server/atSave/current
  in one shared array order, so an index-keyed (positional) merge would have passed all 12 tests.
  Added a fixture holding a mid-flight edit while the server returns the rows RE-SORTED (`sort`
  is server metadata), asserting the kept value follows its fieldId, not its position. Verified
  it catches the positional variant: with `rowsAfterSave` temporarily rewritten to index keying,
  exactly this test went red and the original 12 stayed green; leaf restored untouched
  (`git diff` clean on `src/lib/field-drafts.ts`). Gates: `npx vitest run
  tests/field-drafts.test.ts` 13/13, `npx tsc --noEmit` exit 0, `npx eslint src tests` exit 0.
- **Report correction (this commit)**: the #146 probe note claimed the panel's post-`onApplied`
  `await load()` "self-reports via onError — the two error surfaces are the same setError,
  last-writer-wins." Reviewer-verified false: the panel's `load` self-catches both fetch stages
  into the panel-local `loadError` and never rejects, so no double-`setError` path exists. Wrong
  in the safe direction; no code change. The probe note above is corrected in place.
- For the record (controller, no action): the month-switch transient stale-affirmative window
  goes to the ledger record-only — the page's deliberate sibling idiom (`closeTitle`/schedule
  share the identical window), self-correcting via the ticket, server-backstopped by
  `exportClose`'s 409.
