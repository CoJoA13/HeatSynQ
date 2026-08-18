# Task 4 — #110: SetupBanner readiness invalidation — implementer report

Commits: `6abc950` (mechanism + tests, TDD), `ee9f7cf` (call sites). Branch `group-d-stale-loads`.

## What was built

**`erp/src/components/SetupBanner.tsx`** — the `invalidateBackupBanner` mechanism cloned in
(module-level listener `Set`, exported `invalidateSetupBanner()`, mount-only subscription whose
handler synchronously bumps `generationRef`, re-arms the one-shot, and bumps a refresh nonce;
fetch effect keyed `[pathname, refreshNonce]`), with the component split into hook-free testable
exports per the BackupBanner recipe:

- `advanceSetupBannerState(pathname, state)` — the decision+fetch step over
  `SetupBannerFetchState { data, fetched }`, where `fetched` is the old `fetchedRef` one-shot
  carried as state. `/login` → `INITIAL_SETUP_BANNER_STATE` (reset, no fetch); `fetched: true` →
  same-object no-op; failure (incl. the non-admin 403) → `{ data: null, fetched: false }` (the
  transient-retry re-arm, preserved).
- `shouldSkipSetupInvalidation(data, pwDismissed)` — the banner-side refetch guard (the brief's
  cost ruling): skip when data is loaded AND the banner renders nothing; invalidate normally when
  data is null. Shares one internal `visibility()` with the view so the two cannot disagree.
- `SetupBannerView({ data, pwDismissed, onDismissPassword })` — markup unchanged from the
  original (curly-apostrophe strip text, `/setup` and `/admin/users` links, "Not now").
- `subscribeSetupInvalidations(listener)` — the Set's register/unsubscribe, exported so the test
  can pin the listener contract; the component's effect subscribes through the same function.
- The commit guard is **imported** — `shouldCommitBannerFetch` from `BackupBanner.tsx` (exported,
  unit-pinned there) — not cloned, so no cloned tests.

**Call sites** (`ee9f7cf`) — success path only, fired the instant the mutation resolves, BEFORE
any follow-up load (the #124/#131 ordering), each with a comment naming the moved signal:

| File | Site | Line |
|---|---|---|
| `src/app/setup/SetupChecklist.tsx` | `putState` (confirm numbers / dismiss) | :47 |
| `src/app/admin/users/page.tsx` | password reset ONLY — `patch` grew `opts?: { invalidatesSetup }`; the reset button passes it (:106); title/role/active pass nothing | :65 |
| `src/app/admin/settings/page.tsx` | `save` (unconditional across keys; comment notes the banner-side guard bounds it) | :37 |
| `src/app/admin/billing/page.tsx` | `save` (fires before `setCfg` — no follow-up load on that path) | :60 |
| `src/components/ReferenceTable.tsx` | `add` :84, `remove` :145, PasteGrid `onDone` :285 — all gated on `READINESS_COUNTED_KINDS` (:21: `glAccount, terms, carrier, containerType, material`, hardcoded beside a comment naming order-entry-readiness.ts + install-readiness.ts; no src/server import) | :84/:145/:285 |
| `src/app/admin/step-codes/page.tsx` | `add()` (the create — located fresh post-Task-3; the PUT path `save()` deliberately untouched) | :175 |
| `src/app/customers/page.tsx` | `add` :57, PasteGrid `onDone` :130 | :57/:130 |
| `src/app/parts/page.tsx` | `add` :80, PasteGrid `onDone` :164 | :80/:164 |

The customers/parts/step-codes pages got ONLY the invalidate call (+ import); their other defects
stay with Tasks 3/7. PasteGrid's `onDone` fires only after a successful POST (PasteGrid.tsx:20),
so the paste sites are success-path by construction.

## RED table (TDD)

`erp/tests/setup-banner.test.tsx` written first against the extracted API and watched fail —
13/13 RED (`npx vitest run tests/setup-banner.test.tsx`), then GREEN in `6abc950`:

| Case | Exact watched failure |
|---|---|
| fetches once + strip render; invalidation-produced state refetches; one-shot no-op; /login reset; 403 re-arm | `TypeError: (0 , advanceSetupBannerState) is not a function` |
| all 5 `shouldSkipSetupInvalidation` cases | `TypeError: (0 , shouldSkipSetupInvalidation) is not a function` |
| amber-bar render; renders-nothing render | `Error: Element type is invalid: expected a string … but got: undefined` (SetupBannerView unexported) |
| listener register/invalidate/unsubscribe | `TypeError: (0 , subscribeSetupInvalidations) is not a function` |

GREEN: 13 passed; `tests/backup-banner.test.tsx` still 16 passed.

## Two wiring decisions the reviewer should weigh

1. **The commit guard's `cancelled` argument is hardwired `false`** (SetupBanner.tsx, fetch
   effect). BackupBanner passes its effect-cleanup flag; cloning that here breaks the brief's
   nav-path rule from the other side. The one-shot must burn at DISPATCH time (the old
   `fetchedRef.current = true` before the await — kept, as an eager `stateRef` mark), or a nav
   during the in-flight initial fetch dispatches a second argon2 fetch. But with the latch burned,
   a cleanup-cancelled discard of that same in-flight result would leave the banner blank for the
   whole session with nothing re-arming it (BackupBanner can afford the discard; its throttle
   refetches on a later nav — this banner deliberately never does). So a pathname re-run lets the
   in-flight result land (exactly the old code's behavior — it had no cancellation at all), and
   only an explicit invalidation — which re-arms AND refetches — supersedes, via the generation
   check. Reasoning is in the component comment.
2. **The invalidation handler reads `pwDismissed` from localStorage, not state** — the mount-only
   handler would close over the initial value (`true`); localStorage is the dismissal's source of
   truth and the "Not now" button writes it before setting state. Commented at the handler.

Minor notes: the users-page `patch` gained an options param rather than a parallel function (one
mutation path, per the recon's suggestion); settings invalidates on every key save (the brief
listed the site unguarded; the banner-side guard plus "settings edits are rare admin actions"
bounds it — a key-gated variant is a one-line tighten if the reviewer prefers).

## Gates (from `erp/`)

- `npx vitest run tests/setup-banner.test.tsx tests/backup-banner.test.tsx` — **2 files, 29
  passed** (13 + 16).
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.

Per the task instruction: full suite and E2E not run here (they ride the group's close-out; the
render markup is byte-identical to the old banner, and `e2e/flows/setup-checklist.mjs` is
deliberately read-only).

## Out of scope

Cross-tab staleness: a mutation in tab B leaves tab A's banner stale — the module-level Set is
per-tab, the same limitation as the `invalidateBackupBanner` precedent, which also does nothing
about it. One line for the PR body.
