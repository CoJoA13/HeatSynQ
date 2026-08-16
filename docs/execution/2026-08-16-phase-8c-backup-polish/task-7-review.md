# Task 7 review — the shell warning bar

## Spec Compliance: ✅ Spec compliant

- 403 renders nothing (health route confirmed `mustDo(requireUser(), "manage_backups")`,
  `src/app/api/admin/backups/health/route.ts:12`) and `state:"ok"` renders nothing —
  `BackupBannerView`, `erp/src/components/BackupBanner.tsx:133-141`.
- Mounted above `<Shell>` in `erp/src/app/layout.tsx:45`, matching `SetupBanner`.
- Throttled refetch on navigation (`REFRESH_MS = 5*60*1000`, `BackupBanner.tsx:78`),
  correctly distinct from `SetupBanner`'s once-per-session fetch.
- `/login`: `advanceBannerState` short-circuits before any fetch (`BackupBanner.tsx:117-120`);
  test asserts `fetchMock).not.toHaveBeenCalled()` (`tests/backup-banner.test.tsx:297-304`), not
  just empty markup.
- No `src/server/**` import in the client component; `permissions-sweep.test.ts`'s "no client
  component imports from src/server" check passes over it.
- `isHealthy()` confirmed fully deleted (`erp/src/lib/backup-constants.ts` diff) — grepped
  `src`+`tests`, zero remaining references.
- Commit has no attribution trailer (`git log 7a28410..6c0e60b`).

## Testability restructuring — verified sound

Confirmed no DOM test env: `vitest.config.ts` sets `environment: "node"`; grep of `package.json`
for jsdom/happy-dom/@testing-library/react-test-renderer returns nothing. The split is a genuine
constraint, not a style preference.

`BackupBanner()` (`BackupBanner.tsx:143-161`) is a genuinely thin wrapper: `usePathname()`,
`useState`/`useRef` bookkeeping, one call `advanceBannerState(pathname, stateRef.current,
Date.now())`, an effect-cancellation guard (standard React idiom, no domain logic), and
`<BackupBannerView health={health} />`. No throttle comparison, latch check, or pathname
branching lives in the wrapper that `advanceBannerState` doesn't already own — all of it moved
into the tested function.

Tests call `advanceBannerState(pathname, state, now)` in the same (pathname, state, now) order/
shape the component feeds it, and hand-built `BannerFetchState` fixtures (e.g. `{ health: null,
lastFetchedAt: NOW, forbidden: true }`) match exactly what `fetchHealth`'s own branches produce —
not an invented shape. Not a false green.

## 403-latch judgment call — matches its stated reasoning

Transient (non-403) failures reset `lastFetchedAt` to 0, forcing an immediate retry on the next
navigation (`BackupBanner.tsx:127-128`, tested at `tests/backup-banner.test.tsx:326-330`) — the
latch does not swallow network blips. The latch resets unconditionally on `/login`
(`BackupBanner.tsx:117-120`), verified by a dedicated test (`tests/backup-banner.test.tsx:290-294`)
distinct from the "stays latched across navigation" test (`tests/backup-banner.test.tsx:280-288`,
which jumps `NOW + REFRESH_MS*100` and asserts the fetch mock was never called) — so a user who
logs out and back in as an admin does see the bar again. Both tests assert what they claim.

## Strengths

- The wrapper/logic split is a faithful, input-preserving extraction, not an approximation.
- Effect-cancellation guard in the real component is a defensive improvement over `SetupBanner`'s
  precedent (untested, but low-risk idiom, not a behavior-altering decision).
- Test suite ran pristine (19/19, no warnings): `tests/backup-banner.test.tsx`,
  `tests/practice-banner.test.tsx`, `tests/permissions-sweep.test.ts`.

## Issues

### Critical (Must Fix)
None.

### Important (Should Fix)
None.

### Minor (Nice to Have)
- `BackupBanner.tsx:148-158`'s `cancelled` race guard has no test coverage (can't, without a DOM
  env) — low risk since it only matters under rapid client-side navigation faster than the fetch
  round-trip, and its failure mode is a discarded stale update, not a wrong one. Worth a one-line
  comment noting it's untested-by-design, not a blocker.

## Assessment
**Task quality:** Approved
**Reasoning:** The hook-free split is a faithful extraction — the mounted wrapper is genuinely
thin, tests feed the real call shape, and the 403-latch/transient-retry/logout-reset behavior all
matches its stated reasoning with dedicated coverage.
