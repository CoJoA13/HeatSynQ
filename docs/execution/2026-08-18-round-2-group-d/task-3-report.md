# Task 3 — #23 + the step-codes page: implementer report

Branch `group-d-stale-loads`. Commits `a6e875e` (leaf + tests, TDD) and `e751a1d` (page adoption
+ the two audit finds). Scope held to the three files below plus this report; HistoryPanel,
ReferenceTable, and the #110 call-site at the step-codes create were left untouched (Tasks 4/5).

## What was built

**A. The leaf (TDD).** `erp/src/lib/field-blocker-panel.ts` — `resolveFieldBlockerPanel(gate,
fetchBlockers, fieldCtx)`, pure and client-safe (the next-sort.ts shape, zero imports), generic
over the blocker row type so it need not import from `@/components`. Ticket taken BEFORE the fetch
dispatches; both landings gated (F7). Returns the panel value (current, resolved), `null` (current,
fetch failed — clear the panel; the save's own error text explains the refusal), or `undefined`
(superseded — touch nothing). Tests: `erp/tests/field-blocker-panel.test.ts`, four cases on a
manually-resolved deferred — the brief's three plus the natural fourth (still-current rejection →
`null`) pinning the clear side of the contract.

**B. #23 wiring** (`erp/src/app/admin/step-codes/page.tsx`): `fieldBlockerGate = useLatest()` at
:98 (deliberately not `gate` — the permission-ui import shadows; the naming comment sits on
`latest` at :59–62 and covers both). The load-bearing bump is in the selection-change effect
(:99–102), which also still clears both panels — invalidation at issue time, per
`tests/use-latest.test.ts`'s pinned semantics. `save()`'s catch routes through the leaf at
:150–160: `if (panel !== undefined) setFieldBlocked(panel)`. No bump at the save's own clears
(success :144, else-branch :162) — the queue holds while the blocker GET is awaited, so the
selection change is the only racer (recon §B fact 2); a comment states this at :153–154.
`blocked`'s id-compare render guard untouched.

**C. The same-file audit finds.**
1. `load()` (:72–89) gains a `useLatest` ticket gating both paths: success at :80, and the catch
   at :82–88 swallows a superseded load's rejection (F7 — it must not surface an error over state
   a newer load already refreshed) while re-throwing a current one, so every caller's existing
   error handling is unchanged. **codesRef landing decision** (:63–71, stated in the comment): the
   surcharges Task 7 comment establishes the ref serves QUEUED runs, not the render, so it must
   not be gated by `isCurrent` — but unconditional arrival lets an older response rewind it to a
   pre-mutation field set, which a queued field op composes into its ENTIRE whole-array PUT
   (:197-region `enqueueFieldOp`) — the PR #22 clobber reopened server-side, the exact hazard my
   brief names. So the write is applied-monotonic on the load ticket via `useMutationGate`
   (`codesRefGate.accept(ticket)`, :79): an early finisher of a superseded load still lands (the
   surcharges property preserved), an out-of-order straggler drops (the rewind closed). This is
   also the discipline Task 8 moves surcharges' own `rowsRef` to.
2. Label/unit typing moved to a `textDrafts` overlay (state + `draftValue` at :32–42, the
   surcharges :49–52 pattern): `onChange` writes only the draft (:352, :374), render composes
   draft-over-server (:349, :371), the selection effect clears all drafts (:100), and each
   blur-save clears its own key when the save settles (`blurSaveLabel` :257–271, `blurSaveUnit`
   :273–280, `.finally(clearDraft)`; the unchanged/invalid early-outs clear immediately, the
   surcharges shape). `editFieldLocal` is deleted — nothing writes keystrokes into
   `codes`/`codesRef` any more.

## RED table

RED was watched with the leaf stubbed at the page's CURRENT unguarded semantics (ticket parameter
present but ignored; apply on resolve, clear on reject) — `npx vitest run
tests/field-blocker-panel.test.ts`, 2 failed | 2 passed:

| Case | Exact watched failure | GREEN commit |
|---|---|---|
| (1) bump-then-resolve → `undefined` | `AssertionError: expected { defId: 'def-1', …(2) } to be undefined` — Received: `{ "defId": "def-1", "label": "Hardness", "list": [{ "id": "part-1", "name": "P/N 100 rev A" }] }` (the stale panel value was applied) | `a6e875e` |
| (3) bump-then-reject → `undefined` | `AssertionError: expected null to be undefined` (the stale rejection cleared a current panel) | `a6e875e` |
| (2) no bump → panel value | passed at RED (unguarded and guarded coincide with no interleaved bump) | `a6e875e` |
| (4) current rejection → `null` | passed at RED (same coincidence) | `a6e875e` |

## Files touched

- `erp/src/lib/field-blocker-panel.ts` — new leaf (`a6e875e`).
- `erp/tests/field-blocker-panel.test.ts` — new, 4 tests (`a6e875e`).
- `erp/src/app/admin/step-codes/page.tsx` — imports :4/:10; textDrafts :32–42; gates :62/:71/:98;
  load :72–89; selection effect :99–102; save catch :149–163; blur saves :257–280; inputs
  :349–354/:371–376 (`e751a1d`).
- `docs/execution/2026-08-18-round-2-group-d/task-3-report.md` — this report.

## Gate outputs (all from erp/)

- `npx vitest run tests/field-blocker-panel.test.ts tests/use-latest.test.ts` — **2 files, 11
  tests, all passed** (4 + 7).
- `npx tsc --noEmit` — exit 0, no output.
- `npx eslint src tests` — exit 0, no output.

Full suite / E2E deliberately not run per the task brief (they ride the group's close-out).

## Reviewer-attention notes

1. **The F7 rejection gate in `load()` swallows superseded rejections** (:82–88 re-throw only if
   current). This is a behavior delta beyond the literal surcharges :88–102 shape (which gates
   success only), but the brief mandated "both success and rejection paths"; the swallow is the
   only way to gate a rejection whose handling lives in the callers. A CURRENT load's failure
   still reaches every caller unchanged.
2. **`codesRefGate` feeds `accept()` tickets minted by `latest.next()`** — its own `next()` is
   never called. `accept` is applied-monotonic over whatever numbers it is given, and `latest` is
   the only minter on this page, so the semantics are exactly "newest load ticket wins the ref";
   flagging because it pairs the two gate factories in a way no other page does yet (surcharges
   will, in Task 8).
3. **Panel-clear timing unchanged where the brief required it**: success-path
   `setFieldBlocked(null)` (:144) and the else-branch clear (:162) are un-bumped and
   unconditional, per the brief's "no bump needed at the queue-internal clears".
4. **Draft keys are index-based** (`${codeId}.${fieldIdx}.${column}`), matching the pre-existing
   `focused` keying and the `key={f.id ?? i}` row keying. A reorder racing an un-blurred draft
   could momentarily show the draft on the moved-into row — same exposure the `focused` ref
   already had; blur saves compose from the blur event's value, never the draft map, so nothing
   wrong can be persisted.
5. The empty-label early-out (:262–267) clears the draft immediately and reloads; between the
   clear and the reload landing the input shows the last-loaded server label — the same window
   the old `editFieldLocal` path had.
