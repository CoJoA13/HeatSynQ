# Task 8 — the admin sweep + TemplateEditor — implementer report

Branch `group-d-stale-loads`. Commits: `c88503e` (TemplateEditor + pure seam + tests),
`3f9629c` (the five admin pages + surcharges). All seven briefed files touched, nothing else.

## Per-change table

| File | Change | Shape cloned |
| --- | --- | --- |
| `admin/users/page.tsx` | `load()` ticket-gated, both paths; the two sequential awaits became ONE `Promise.all` under ONE ticket, so users/roles can no longer tear across two loads' snapshots. `patch`/`create` untouched — Task 4's `invalidatesSetup` opt preserved exactly. | surcharges `load()` + F7 (customers/page.tsx) |
| `admin/audit/page.tsx` | `load()` ticket-gated, both paths. The up-front `setError(null)` moved BEHIND the ticket check onto the success path, so a stale response can't clear a newer failure (§5.13). Kept the un-memoized `load` + `exhaustive-deps` disable shape — minimal churn. | customers `load()` / F7 |
| `admin/templates/page.tsx` | Two gates. `rowsLatest` on the rows `load()`, both paths. `detailLatest` shared by BOTH writers of `detail`: the selection effect's `stale` boolean replaced by tickets, and `loadDetail` (the post-mutation refresh) ticketed on the SAME gate with an added gated catch — a newer selection now automatically invalidates an in-flight post-mutation detail refresh (the publish-A-then-click-B repaint). Deselecting (`selected === null`) also bumps the gate. `removeTemplate`'s `blocked.id === detail.id` render guard untouched. | surcharges `load()`; the shared-gate merge per brief |
| `admin/roles/page.tsx` | The server-side clobber: `toggle` now enqueues on a `saveQueue` ref and composes `next` from `rolesRef.current` at the run's OWN turn, so overlapping toggles accumulate instead of PUT#B replacing the array without A's grant. `load()` ticket-gated (setRoles AND the `setSelected` re-derivation), both paths; `rolesRef` lands applied-monotonic via `useMutationGate().accept` on the load ticket, mirroring Task 3's `codesRefGate` comment. Call sites pass `selected.id` so the run never reads click-time state. | surcharges `saveQueue`/compose-inside-the-run (:169–185 there); step-codes `codesRefGate` |
| `admin/part-fields/page.tsx` | `load()` ticket-gated covering `setRows` AND the `setDraft` sort recompute, both paths. Name/Sort moved to a `textDrafts` overlay (drafts keyed `${rowId}.${field}`, composed at render, cleared when the field's OWN save settles; onChange no longer writes rows — `editLocal` deleted as now-unused). Comment at the drafts states the limiting fact: single-field save bodies mean NO whole-row write-back amplification, so no rowsRef/accept mechanism here. Sort's blur now also rejects empty (the surcharges Position guard — `Number("")` is 0, so blur-from-empty used to save sort 0, the mangled-value class). | surcharges `textDrafts` (:49–52) + Position blur guard |
| `admin/surcharges/page.tsx` | (a) Name routed through `textDrafts` exactly like the four numeric fields — onChange stops writing rows/rowsRef, blur composes+saves, `.finally` clears its own key — closing the mid-typing-text-leaks-into-other-saves'-PUT-bodies hole (`buildSurchargeBody` falls back to `row.name`). (b) the `rowsRef` write gated with `makeMutationGate.accept` on the SAME load ticket — Task-7 intent preserved (an early-arriving superseded response still lands the ref) while a late straggler that would rewind a newer applied one is dropped; the stale saveQueue comment describing the old unconditional write updated to match. (c) `clearCustomerOverride`'s blocker refetch ticketed on a scoped `makeLatestGate` — ticket taken BEFORE the DELETE (the DELETE is what changes the correct panel), checked before both `setBlocked` branches, F7 on the refetch's catch; the DELETE's own failure stays reported unconditionally (a mutation report, not a stale fetch). | step-codes `codesRefGate` (b); step-codes `fieldBlockerGate` (c) |
| `admin/templates/[id]/edit/TemplateEditor.tsx` | Edit-epoch gate (`useLatest` semantics): `apply()` bumps it, `save()` takes a ticket at dispatch. Success path: `setUpdatedAt` unconditional (the precondition genuinely advanced), `setDirty(false)`/`setSavedTick(true)` gated on `resolveSaveSettle` — an intervening apply keeps dirty and Save live. 409 path: `rollbackToServerTruth(ticket)` now ALWAYS freshens `updatedAt`/`logoMimeType` from the fetch, but skips the config reset when an apply intervened, returns whether the outcome applied, and the caller then skips the conflict banner and drops the superseded stash instead of offering to resurrect pre-edit state. `refreshDraftMeta` and the LogoPanel busy-serialization untouched. | `makeLatestGate` semantics; decision extracted pure |

## TemplateEditor seam decision

A pure seam existed cheaply: `tests/template-editor.test.ts` already drives
`src/lib/template-editor.ts` (`resolveSaveError` is the precedent). The epoch **decision** landed
there as `resolveSaveSettle(editIntervened) → { freshenPrecondition: true, applyOutcome: boolean }`,
used at BOTH settle points (success and 409-rollback); the epoch **mechanism** is `makeLatestGate`
itself, already unit-pinned in `tests/use-latest.test.ts`, so no second ticket implementation was
written. The component keeps only the wiring (bump in `apply`, ticket in `save`, two
`resolveSaveSettle` calls).

## RED table

| Test (tests/template-editor.test.ts, `resolveSaveSettle` describe) | RED evidence | GREEN |
| --- | --- | --- |
| save-success with an intervening apply keeps dirty (outcome withheld, precondition still advances) | `3 failed \| 35 passed` — `resolveSaveSettle` not exported | ✅ |
| 409-rollback with an intervening apply skips the config reset and the conflict banner | same RED run | ✅ |
| no intervening edit → both settle points apply their outcome in full | same RED run | ✅ |

## Gate outputs

- `npx vitest run tests/use-latest.test.ts tests/template-editor.test.ts` — **2 files, 45 passed** (was 42; +3 new).
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.

(Per the brief, NOT the full suite and NOT E2E — those ride the group's close-out.)

## Deviations / reviewer-attention notes

1. **Surcharges `load()` gained the F7 rejection-path guard** (a try/catch rethrowing only when
   current) — not one of the three listed surcharges fixes, but fix (b) lands a ticket-consuming
   change inside that very function and section 0's F7 rule binds both paths of every fix in the
   group; step-codes (Task 3's rebuild) already carries the identical shape. Behavior change is
   confined to the raced window (a superseded load's rejection is swallowed).
2. **Part-fields sort blur now rejects empty** (previously saved `sort: 0` via `Number("") === 0`).
   Ported as part of the surcharges Position pattern the brief named; it is exactly the "blur can
   save the mangled value" class the task targets, but it IS a user-visible validation change.
3. **Roles `toggle` keeps its existing error handling** (no §5.13 rollback reload added on failure)
   — nothing on this page is optimistic (the checkbox renders from `selected.permissions`), so
   there is no stale on-screen value to roll back; minimal churn per the brief.
4. **TemplateEditor: `reapplyStashed` does NOT bump the epoch.** It cannot race a save: the
   conflict banner (its only render site) exists only after a save has settled, and Save is
   disabled until an `apply`/re-apply makes the editor dirty again. Noted in case a reviewer looks
   for the bump there.
5. **TemplateEditor success path clears `conflict`/`stashed` unconditionally** even when superseded
   — an intervening `apply()` has already nulled both, so the clear is a no-op there; gating it
   would add a branch for no behavior.
6. **A superseded 409 rollback briefly holds `setStashed(attempted)`** (set before the fetch, per
   the §5.13 ordering) — it is dropped on the superseded branch and `conflict` stays null
   throughout, so the stash is never rendered.
7. HistoryPanel is mounted by surcharges/step-codes pages but was not touched (Task 5's file).
