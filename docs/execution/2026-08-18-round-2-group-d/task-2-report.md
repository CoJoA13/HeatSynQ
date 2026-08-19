# Task 2 — #3 + #15: the save-scope helper + both detail pages — implementer report

**Branch:** `group-d-stale-loads` · **Commits:** `dc00c5c` (helper + tests, TDD), `02a3da5`
(adoptions). Gate evidence below is from the final tree state.

## What was built

**`erp/src/lib/save-scope.ts`** — `makeSaveScope()` / `useSaveScope()`, client-safe (zero React
in the factory, zero src/server imports; the hook is the `useLatest` lazy-`useState` shape). One
scope per page/section state slice:

- `begin(settled)` — called at every optimistic-apply site, at save CALL time, with the save's
  settlement promise (the `serial()` queue-chain tail on the pages; the request round-trip itself
  in the queue-less sections). Bumps a monotonic epoch, holds the promise in a Set until it
  settles (both arms handled, so a rejecting chain neither lingers nor leaks an unhandled
  rejection).
- `reload(fetchData, apply)` — the brief's algorithm verbatim: internal latest-gate ticket taken
  at call time (before any await, the dispatch rule), then loop { `await allSettled(pending)`;
  capture epoch; fetch; superseded ticket → return without applying (on the REJECTION path too —
  the F7 rule, a stale failure is swallowed while a current one propagates); epoch moved → loop;
  else apply }. Terminates because the epoch advances only on user actions.

The internal gate reuses `makeLatestGate` from use-latest.ts rather than a third counter
implementation.

## RED table (watched, exact failure text)

The RED run was made against a stub `save-scope.ts` whose `reload` is today's page behavior —
`apply(await fetchData())`, unguarded — and a no-op `begin`, per the brief's protocol. Run:
`npx vitest run tests/save-scope.test.ts` → **4 failed | 2 passed**.

| Test case | Watched RED failure (verbatim) | GREEN |
|---|---|---|
| #3 same-key trace (rollback GET answered with pre-v1 truth while save#2 in flight) | `AssertionError: expected 'v0' to be 'v2' // Object.is equality` at save-scope.test.ts:119 | `dc00c5c` |
| #15 cross-key trace (rollback GET resolves carrying B's pre-edit value mid-flight of B's save) | `AssertionError: expected 'b0' to be 'b1' // Object.is equality` at :153 | `dc00c5c` |
| Ticket-before-dispatch (older reload resolving after a newer one) | `AssertionError: expected 'newer' to be 'v0' // Object.is equality` at :204 | `dc00c5c` |
| Superseded rejection swallowed (F7's other half) | `promise rejected "Error: network down" instead of resolving` at :227 (plus a vitest-caught unhandled rejection) | `dc00c5c` |
| Ordinary failure: prompt rollback + error survives | green on the stub too (the no-clear/detach contract lives at the call site the harness models; this pins it as a regression guard) | `dc00c5c` |
| Lone reload's rejection propagates | green on the stub too (regression guard on the real helper's throw path) | `dc00c5c` |

One mid-implementation correction, recorded honestly: my first GREEN run failed 2/6 because the
test's end-of-trace assertions expected the error banner to survive to the END of the #3/#15
traces — but the harness (correctly mirroring the pages) has the intervening save's own SUCCESS
clear it (`setError(null)`-on-success is the pages' design). The assertions were corrected to
`toBeNull()` with a comment; §5.13's rollback-apply-never-clears is pinned by the
ordinary-failure case, where nothing else touches the error. The helper did not change.

The test's harness contains a **verbatim clone of the pages' `serial()` per-key queue** and fires
rollbacks detached from inside the queued fn exactly as the pages now do — a same-key deadlock
would present as a vitest timeout, so the passing #3 trace is the no-deadlock proof.

## Adoptions (files touched, current line refs)

**`erp/src/app/customers/[id]/page.tsx`** (#3)
- Scope + split load: `useSaveScope` :144; `fetchDetail`/`applyDetail` (editGuard.merge kept on
  apply) :146–158; ordinary `load` (clears error, unchanged semantics) :154; `rollbackLoad`
  (no-clear variant, §5.13) :160–163.
- `begin` at the four optimistic sites: `save` :277, `toggleContactFlag` :427,
  `saveAddressField` :452, `saveContactField` :476 — each registering its `serial()` chain tail.
- All four catches: `setError` first, then `void rollbackLoad().catch(() => {})` — detached, per
  the brief. Every other `load()` caller (mount :164, saveParent, call(), saveAddressKind, the
  address-active toggle) now routes through the scope's reload, which also closes the audit's
  :144 reload-vs-reload finding via the internal gate.

**`erp/src/app/parts/[id]/page.tsx`** (#15)
- `useEditGuard` ported (the Phase 4 fix-wave guard this page never received) :88; `applyPart`
  routes `setPart` through `merge` :97.
- Scope :94; guarded `load` :98–101; `rollbackLoad` :104–107; `begin` in `save` :140; detached
  no-clear rollback in save's catch :128–135. `patchDraft` explicitly does NOT register (comment
  :144–147) — typing protection is editGuard's job.

**`erp/src/app/parts/[id]/IdentitySection.tsx`**
- New `editGuard: EditGuard` prop; local `focusedValue`/`noteFocus`/`onBlurSave` replaced by
  `editGuard.onFocusField`/`onBlurSave` (the customers `noteFocusC` shape) :44–58.
- All eight text fields register their Part property key (:75, :82, :89, :101, :123, :137, :169,
  :183). The two int fields' invalid-value revert uses the guard's `atFocus` snapshot (:159,
  :191 — the customers requestDaysOverride precedent).

**`erp/src/app/parts/[id]/PricingSection.tsx`** (section-local analog)
- The bare `useLatest` ticket is replaced by the scope's reload (:79–86) — its internal gate is
  the same newest-wins discipline, now also gating the rejection path (previously ungated there)
  and settle-deferring behind registered saves.
- `begin` + detached rollback: `saveRow` :114, `move` :191, `saveBreak` :249. The registered
  promise is the api round-trip itself (no queue here); `move`'s success-path `await load()` is
  safe because the registered PUT has settled by then (comment states it).

**`erp/src/app/parts/[id]/InspectionsSection.tsx`**
- Scope + the previously-missing load ticket :46–53; `begin` + detached rollback in `saveRow`
  :100 and `move` :144.
- The `rowsReady` add-guard ported from PricingSection: state :34, `add()` refusal :163,
  Add-button gating + title :308–310.

## Deviations from the brief

1. **InspectionsSection `move` (:144) also adopted.** The brief's list named only `saveRow` :85
   for this section, but `move` has the identical rollback-reload shape (the brief's own
   PricingSection list includes its `move`), and leaving one unguarded rollback beside three
   guarded ones in the same two files would be an incoherent half-fix of "their rollback
   reloads". Same-shape, same-task; flagged for the reviewer to confirm.
2. **PricingSection's `rowsLatest` removed** rather than kept alongside the scope: two
   independent gates over the same state would disagree; the scope's internal gate subsumes the
   old ticket's job exactly (and adds the F7 rejection-path gating the old load lacked).
3. Test assertion correction described in the RED table — a test fix, not a helper change.

## Gate outputs (final tree)

- `npx vitest run tests/save-scope.test.ts tests/use-latest.test.ts tests/idempotent-save.test.ts`
  → **3 files, 24 tests, all passed**, no unhandled errors.
- `npx tsc --noEmit` → exit 0.
- `npx eslint src tests` → exit 0.
- Full suite / E2E deliberately not run here (controller's runs, per the task rules). No DB
  touched — the new tests are pure node.

## For the reviewer to scrutinize

- **The epoch-loop's interaction with the ordinary (error-clearing) load variant.** If an
  ordinary success-path load is looping when a save fails, the failed save's own rollback reload
  takes a NEWER ticket, so the looping ordinary load is superseded and drops — the no-clear
  variant wins and the banner survives. That supersession (not the loop itself) is what keeps
  §5.13 intact; worth independently tracing.
- **`begin`-site completeness.** The brief's four customers sites and one parts site are done;
  `call()` on customers deliberately does NOT register (it has no optimistic set — its own
  comment says so — and it awaits its mutation before reloading). Confirm no other optimistic
  site exists.
- **The section `move` functions' success path** awaits the guarded `load()` after the
  registered PUT settles — no deadlock, but it is the one place a registered promise and an
  awaited reload coexist in one function.
- The InspectionsSection deviation (item 1 above).
