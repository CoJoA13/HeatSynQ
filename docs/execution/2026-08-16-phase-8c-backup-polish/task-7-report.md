# Task 7 report — the shell warning bar

## What I implemented

- `erp/src/components/BackupBanner.tsx` (new). A `"use client"` clone of `SetupBanner.tsx`, mounted
  by the root layout above `<Shell>` so it survives Shell's `/login` and me-null early returns.
  Polls `GET /api/admin/backups/health` on navigation, throttled to `REFRESH_MS = 5 * 60 * 1000`,
  and renders nothing while `health` is `null` or `state === "ok"`.

  One structural deviation from the brief's literal code, driven by a real constraint discovered
  while reading the test precedent (see "Why the component is split" below): the throttle/fetch/
  latch decision and the presentational render are pulled out of the hook body into three plain,
  hook-free exports:
  - `advanceBannerState(pathname, state, now)` — the whole decision as one async step: `/login`
    resets everything (including the forbidden latch); a latched-forbidden or not-yet-due state is
    returned unchanged with **no fetch attempted**; otherwise it fetches, classifies the outcome,
    and returns the next state.
  - `BackupBannerView({ health })` — pure JSX, no hooks; renders the red bar or `null`.
  - `BackupBanner()` — the mounted component; holds `useState`/`useRef`, calls
    `advanceBannerState` from `useEffect`, renders `<BackupBannerView>`.

- `erp/src/app/layout.tsx` — added the import and `<BackupBanner />`, mounted directly below
  `<SetupBanner />` and above `<Shell>`, matching the brief exactly.

- `erp/tests/backup-banner.test.tsx` (new) — 10 cases against `advanceBannerState` and
  `BackupBannerView` directly (see "Why the component is split" and "Test mapping" below).

- `erp/src/lib/backup-constants.ts` — deleted `isHealthy()`.

## Why the component is split (a constraint, not a style choice)

Before writing the test I confirmed this repo has **no DOM test environment**: `vitest.config.ts`
sets `environment: "node"`, and neither `jsdom`, `happy-dom`, `@testing-library/react`, nor
`react-test-renderer` appears in `package.json` or `node_modules` (checked directly). This matches
the repo's own documented convention — `tests/practice-banner.test.tsx`'s header comment says so
explicitly ("The repo tests UI via E2E and has no DOM test env, so we render the presentational
banner to static markup … structure, not pixels"), and `tests/fetcher.test.ts` notes "no jsdom
needed for this one" for the same reason. `PracticeBanner`, the only other banner with a component
test, has no hooks at all — its test never needed to run an effect.

`BackupBanner`, as given in the brief, is a `useEffect`+`useState`+`usePathname` component. Without
jsdom/testing-library/react-test-renderer, there is no way in this repo to mount it and let a real
`useEffect` fire — `react-dom/server`'s `renderToStaticMarkup` (the only renderer available here)
never runs effects, by design, in any React version. So the four required behaviors — "fetches and
renders," "ok renders nothing," "403 renders nothing without throwing," "`/login` doesn't fetch" —
can't be asserted against the mounted `<BackupBanner />` itself without adding a new devDependency,
which I didn't do without asking (a decision that reaches beyond this one component: lockfile,
future component tests, etc.).

Instead I split the effect body into `advanceBannerState`, a plain async function with the exact
same inputs/outputs/side-effects (network calls) the effect would have, and `BackupBannerView`, the
render half. Both are directly callable and assertable from plain Node — `advanceBannerState` with
a stubbed `global.fetch` (the same pattern `fetcher.test.ts` already uses), `BackupBannerView` with
`renderToStaticMarkup` (the same pattern `practice-banner.test.tsx` already uses). `BackupBanner`
itself is then a thin `useEffect` wrapper that calls the former and passes its result to the latter
— so the mounted component's actual behavior is exactly what the tests exercise, not an
approximation of it. I did not add a runtime dependency and did not touch `vitest.config.ts`.

If tighter mount-level coverage (or coverage of other interactive client components) becomes a
priority, `react-test-renderer` (official, DOM-free, matches installed React 19.2.8) is the
narrowest addition that would close this gap — flagging it rather than adding it unasked.

## The 403-latching decision

**Chosen: latch off for the session.** `BannerFetchState.forbidden` starts `false`; a 403 sets it
`true`; while `true`, `advanceBannerState` returns the input state unchanged and **does not call
`fetch` at all** (asserted directly in the test — see "does not re-fetch on a later navigation once
latched forbidden"); `/login` resets the whole state, including the latch, so the next session (even
for the same browser, a different signed-in user) retries fresh.

Reasoning: a 403 here means "this signed-in user lacks `manage_backups`" — a fact fixed for the rest
of that session; it cannot flip true mid-session, only across a login. A transient failure (network
blip, 500) is exactly the opposite: it says nothing about *this* request being retried, so those keep
`lastFetchedAt` reset for an immediate retry on the next navigation, matching SetupBanner's existing
behavior for its own transient-failure case. Latching the 403 case specifically avoids the
brief-noted problem verbatim: the common case is every non-`manage_backups` user on every single page
view, forever, for a result that cannot change without a logout — a fixed cost model that doesn't
scale with navigation count is strictly better here. The added state (`forbidden`) resets correctly
on logout because the `/login` branch already had to reset `health`/`lastFetchedAt` for the "allow a
fresh session to see a fresh answer" reason SetupBanner documents; folding the latch into the same
reset was a one-line addition, not new complexity.

Covered by two tests: "does not re-fetch on a later navigation once latched forbidden" (fetch mock
asserted `not.toHaveBeenCalled()` after a huge time jump) and "re-arms the forbidden latch on
/login."

## `isHealthy()`

Grepped `src/` and `tests/` for `isHealthy` — the only occurrence was its own definition in
`backup-constants.ts`. The Backups page reads `health.state === "ok"` directly (as noted in the
task prompt), and `BackupBannerView` does the same for consistency. No consumer, so I deleted it
per the brief's YAGNI instruction rather than writing a test for dead code.

## Test mapping (the four required cases, plus the judgment call and throttle)

| # | Required behavior | Test(s) |
|---|---|---|
| 1 | red payload renders bar + reason + `/admin/backups` link | "fetches a non-ok payload and renders its reason with a link to /admin/backups" |
| 2 | `state: "ok"` renders nothing | "renders nothing for state: ok" (+ "renders nothing before any health has loaded") |
| 3 | 403 renders nothing, does not throw | "a 403 clears health, renders nothing, latches forbidden, and does not throw" |
| 4 | `/login` renders nothing AND does not fetch | "does not fetch on /login, even when a fetch is otherwise due" |
| — | 403-latch judgment call | "does not re-fetch on a later navigation once latched forbidden", "re-arms the forbidden latch on /login" |
| — | throttle (not required, added for completeness) | "throttles: skips the fetch…", "refetches once REFRESH_MS has elapsed…" |
| — | transient-failure retry (not required, added for completeness) | "a transient (non-403) failure resets lastFetchedAt…" |

## Manual browser check (brief Step 4)

Ran `npm run dev` against the dev DB, signed in as `admin`/`admin` (a fresh checkout with an empty
`erp/backups` folder → `state: "unknown"`, reason "The backup folder could not be read: ENOENT…"):

- `/customers` (an ordinary page): the red bar rendered with that exact reason text and an
  `href="/admin/backups"` "Open Backups" link. Confirmed via the accessibility tree, not just a
  screenshot.
- `/admin/backups` itself: same bar rendered above the page's own (different-styled) health card,
  confirming the shell bar and the page's own big status card coexist without conflict.
- `/login` (after signing out): the accessibility tree showed only the login form — no banner, no
  nav, no shell chrome at all (Shell's own early return), confirming the "renders nothing on
  /login" leg live, not just in the unit test.
- Did **not** confirm the "disappears after a successful Back up now" leg live: clicking "Back up
  now" in the headless browser pane did not produce a `POST /api/admin/backups/run` in the dev
  server log (the pane reported it wasn't compositing frames for a screenshot, so the click may not
  have landed on the actual button — an artifact of the harness, not of `BackupBanner`). This leg
  is covered by the unit test ("renders nothing for state: ok" exercises the exact same
  `BackupBannerView` the mounted component renders once `health.state` flips to `"ok"`), so I did
  not spend further time chasing the click issue, which is unrelated to Task 7.

## Commands run (real output)

```
$ cd erp && npx vitest run tests/backup-banner.test.tsx tests/practice-banner.test.tsx tests/permissions-sweep.test.ts && npx tsc --noEmit && npx eslint src tests

 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp

 ✓ tests/permissions-sweep.test.ts (6 tests) 17ms
 ✓ tests/backup-banner.test.tsx (10 tests) 7ms
 ✓ tests/practice-banner.test.tsx (3 tests) 5ms

 Test Files  3 passed (3)
      Tests  19 passed (19)
   Start at  05:20:09
   Duration  374ms (transform 43ms, setup 14ms, collect 89ms, tests 29ms, environment 0ms, prepare 71ms)
```

`npx tsc --noEmit` produced no output (clean). `npx eslint src tests` produced no output (clean).
Ran `npx prisma generate` first (per CLAUDE.md, required before `tsc` on a checkout whose client may
be stale) — succeeded, no schema changes in this task.

## Files touched

- `erp/src/components/BackupBanner.tsx` (new)
- `erp/src/app/layout.tsx` (modified — import + mount)
- `erp/tests/backup-banner.test.tsx` (new)
- `erp/src/lib/backup-constants.ts` (modified — deleted unused `isHealthy()`)

## Commit

Committed as a single conventional commit with no attribution trailer (per CLAUDE.md's working
convention). SHA recorded in the top-level response.
