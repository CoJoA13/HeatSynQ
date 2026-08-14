# Quotes E2E flake — root cause and fix (2026-08-13)

Filed against Task 7's round (the controller records it there; this report is the account).
The `quotes` Playwright flow failed 2 of 4 recent full-suite runs, both as element-detached
churn in the quote detail page's Lines section — `locator.fill` detachment at quotes.mjs:179
(Task 6 run 1) and a 45s `locator.click` detach-retry timeout at quotes.mjs:185 (the Task 7
re-run). Task 6's reviewer had already judged the failure pre-existing (zero client-code
changes in that task's diff); this closes the mechanism question that record left open.

## Root cause

**`QuoteDetail.tsx`'s initial-load effect had no stale-response gate, so React StrictMode's
dev-only double-mount left an abandoned duplicate `GET /api/quotes/[id]` in flight whose late
response re-`adopt()`ed pre-edit server truth over the user's in-progress draft** — wiping the
just-added price row, the six filled fields, and the quoted qty in one commit, and detaching
the exact DOM nodes Playwright was acting on.

The chain, in this repo's terms:

1. Next 16 defaults `reactStrictMode` on (nothing in `next.config.ts` disables it), and the
   E2E harness runs `next dev` — so every mount of `QuoteDetail` runs its effects twice:
   mount → cleanup → mount. The load effect (`useEffect(() => { load()... }, [load])`)
   dispatched a detail GET from **both** mounts, and both `.then(adopt)` callbacks stayed
   live — the first mount's fetch was never cancelled or ignored.
2. `adopt()` is the single-save form's baseline-replace: it overwrites `detail`, `header`,
   AND the whole `lines` tree. Both duplicate responses carry pre-edit server truth (the
   quote as created: one line, no prices), so whichever lands **last** resets the form.
3. The flow types fast: quotes.mjs step 3 adds the price row and fills six fields within
   ~1s of the heading appearing. If the straggler response lands inside (or after) that
   window, the draft is wiped mid-action — `fill`/`click` see their element detached, and
   since the price row never comes back (its only existence was client state), the retry
   loop runs out the full 45s timeout.

### Evidence

- **The failure screenshot** (`e2e-artifacts/quotes/05-failure.png`, preserved from the
  failing run): the Lines section back at "No priced operations yet", Quoted qty empty,
  "Unsaved changes" badge absent, Save/Discard disabled — the form is CLEAN at server truth,
  which only `adopt()` (or a remount, excluded below) produces. A dev-server compile pause
  (the Task 6 hypothesis) cannot produce this: a pause stalls rendering, it does not reset
  React state.
- **The duplicate GET pair is real and its straggler routinely lands after first paint.** A
  temporary instrumented rig (single-flow driver + network event log; removed before commit)
  showed, on EVERY page view, two mount-time `GET /api/quotes/<id>` requests dispatched in
  the same millisecond, with the second response arriving 100–300ms AFTER the detail heading
  was already visible even on a quiet machine:

  ```
  +10.96s  REQ  GET /api/quotes/cmsraznww00043k2792jzk2dn
  +10.96s  REQ  GET /api/quotes/cmsraznww00043k2792jzk2dn
  +11.10s  RES  200 GET ...   ← adopt #1, heading renders
  +11.15s  detail heading visible (Quote #1033)
  +11.25s  RES  200 GET ...   ← adopt #2, AFTER the page is interactive
  ```

  Under full-suite load (19th flow, per-flow video recording, first-hit route compiles of
  `/api/quotes/[id]`, `/documents`, the audit route — all queued behind the browser's
  six-connections-per-origin limit against the ~9 API calls this page fires at mount) that
  100–300ms stretches into seconds, which is why the flake is intermittent and why a quiet
  single-flow run rarely shows it.
- **RED (deterministic repro, before the fix):** holding the FIRST GET's response for 4s —
  the StrictMode-abandoned request resolving late, exactly the dangerous direction — wiped
  the draft **2/2 iterations** and reproduced the suite failure verbatim:

  ```
  +4.61s  edits done (price row + 6 fills)
  +6.15s  RES  200 GET /api/quotes/...      ← the held stale response
  +6.28s  WIPE DETECTED: emptyState=1 qty=""
  +9.28s  Add break click FAILED: TimeoutError: locator.click: Timeout 3000ms exceeded.
  ```

- **GREEN (same rig, after the fix):** identical held-response timing, **0/2 wiped**, the
  draft held and "Add break click OK" both iterations.
- **Ruled out:** stray dev-DB quote fixtures (zero `Quote` rows for any `E2E%` customer
  before the run; the overlap advisory is also only set from mutation responses, and the
  flow's first save happens after the failing lines); unstable React keys (loaded rows key
  by server id, client rows by a monotonic `new-N` — stable across renders); polling/refetch
  loops (nothing in the page, `usePermissions`, or `HistoryPanel` re-fetches after mount).

## The fix

`src/app/quotes/[id]/QuoteDetail.tsx` — the initial-load effect now carries the house
stale-flag cleanup gate (the `LinesSection.tsx` / `ActiveQuotesSection.tsx` idiom): the
fetch's `then`/`catch` are ignored wholesale once the effect instance is cleaned up, so only
the LIVE mount's response can adopt, and the heading (the flow's interaction gate) can only
appear after that adopt. `load()` itself is unchanged for its other callers (the
close/reopen rollback paths, which reload deliberately, on a clean form, under their own
error handling).

## Why it's safe

- **Dev-only mechanics, correct everywhere:** production builds don't double-mount, so prod
  never raced; the gate also stops setState-into-an-unmounted-instance on real navigation.
- **§5.13 intact:** nothing new clears the error banner — `setError(null)` still runs only
  on a successful live adopt, exactly as before; a stale request's failure can no longer
  paint an error over a page whose live request succeeded (a strict improvement), and a
  stale success can no longer clear a live failure's banner.
- **§5.12 intact:** `page.tsx`'s `key={id}` remount-per-record is untouched; the effect
  re-runs on `id`/`adopt` change exactly as the old `[load]` dependency resolved to.
- **No business logic moved into the component** — the change is fetch-lifecycle plumbing.
- **Same-class exposure elsewhere:** flagged for a separate sweep (sibling detail pages'
  adopt-into-form load effects) rather than widened into this diff.

## TDD note

The fix is client-component effect lifecycle; this repo's vitest harness is node-environment
(no jsdom/RTL), so there is deliberately no component unit test. The RED evidence is the
deterministic browser repro above (2/2 wiped before, 0/2 after, same forced timing), plus
the full suite run below. The rig was temporary instrumentation and is not committed.

## Gates (all watched to completion)

| Gate | Result |
| --- | --- |
| `npm test` (vitest, erp_test) | PASS |
| `npx tsc --noEmit` | PASS |
| `npx eslint src tests` | PASS |
| `npm run build` | PASS |
| `npm run test:e2e` (full 19 flows) | PASS — 19/19, quotes included |

Dev-DB fixtures cleaned by the harness's own teardown ("cleanup ok"), and verified empty
afterwards (no `E2E%`-customer quotes, orders, or sessions left behind).
