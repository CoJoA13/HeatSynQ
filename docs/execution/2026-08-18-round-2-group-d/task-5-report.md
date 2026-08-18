# Task 5 implementer report — shared components: Shell, HistoryPanel, AttachmentsSection, ReferenceTable

Branch `group-d-stale-loads`, sweep commit `13bf9a3`. Four files, exactly the task's scope; no
tests added (mechanical idiom application — the factory is unit-pinned in
`tests/use-latest.test.ts`). Line refs below are post-change, at `13bf9a3`.

## Per-change table

| File | Race | Gate | Line refs |
| --- | --- | --- | --- |
| `erp/src/components/Shell.tsx` (search) | Blank-query branch cleared results/open synchronously but left the in-flight ticket CURRENT — a debounce-fired search for an erased term re-opened the dropdown under an empty box; `selectResult`/Enter clear-and-navigate mid-flight, and Shell never remounts, so the stale response re-opened over the NEW page. Escape/blur closes were equally re-openable by a late current-ticket response. | Bump `latest.next()` in the blank branch (a discarded ticket nothing will ever match — the makeLatestGate discipline); shared `closeSearchDropdown()` (bump + close) for Escape and blur. `runSearch` itself was already both-paths gated. | :108–121 (blank branch, bump at :115); :130–136 (`closeSearchDropdown`); :140 (Escape); :206 (blur) |
| `erp/src/components/Shell.tsx` (me-fetch) | Effect refires on EVERY pathname change with unconditional `.then(setMe)` / `.catch(() => router.push("/login"))` — a superseded request's transient rejection landing after a newer success redirected a logged-in user to /login. | Second, SEPARATE `useLatest` (`meLatest` — no shared sequence numbers with the search gate), F7 both paths: stale success dropped, stale rejection swallowed, CURRENT rejection keeps the redirect. | :45–60 (gate at :49, ticket :56, gated then/catch :58–59) |
| `erp/src/components/HistoryPanel.tsx` | Effect re-runs on `[entity, entityId]` with both paths ungated; step-codes/surcharges pass a changing `entityId` into an unkeyed subtree — row A's history under row B's heading, a stale rejection flipping a fresh "ok" to "error", a stale success masking a real 403. | Effect-scoped `let stale` cleanup flag (the QuoteDetail/templates-list shape — the sanctioned equivalent since the fetch is keyed entirely by the effect's deps), gating `setEntries`/`setStatus("ok")` AND the catch's `setStatus("error")`. Fixed inside the component → covers all twelve call sites. | :28–40 (flag :35, gated then :37, gated catch :38, cleanup :39) |
| `erp/src/components/AttachmentsSection.tsx` | `load` is the funnel for mount + upload/delete refreshes; delete stays enabled during an upload, so two list GETs overlap and the earlier snapshot landing last hides a committed change ("uploaded but not listed", "deleted but still listed"). | `useLatest` inside `load`, catch moved inside, both paths gated (`makeLatestGate` is correct — only `load` writes `rows`). Effect becomes `void load()`. | :49–71 (gate :49, ticket :59, gated catch :64, gated apply :67–68, effect :71) |
| `erp/src/components/ReferenceTable.tsx` | `load` re-runs on `showInactive` and is awaited by add/toggleFlag/remove/paste handlers; rapid toggle or handler-vs-toggle overlap lets the earlier response land last (inactive rows under an unchecked box; a flipped flag visually reverting). | `useLatest` inside `load`, the effect's `.catch` folded in, both paths gated. Binding named `latest`, not `gate` (the customers/page.tsx shadowing hazard — this file imports `gate` from permission-ui). Comment states cross-kind safety rests on the mount site's `key={kind}` (`admin/reference/page.tsx:21`) — a standing requirement for any future mount site. Task 4's three `invalidateSetupBanner` call sites preserved byte-for-byte. | :46–68 (naming comment :46–48, gate :49, ticket :58, gated catch :63, gated apply :66–67, effect :68) |

## Gate outputs (from `erp/`)

- `npx vitest run tests/use-latest.test.ts tests/setup-banner.test.tsx` — **2 files, 20 tests, all
  passed** (proves no regression to Task 4's extractions; my ReferenceTable edit does not touch the
  `invalidateSetupBanner` import or call sites).
- `npx tsc --noEmit` — exit 0, no output.
- `npx eslint src tests` — exit 0, no findings. (One intermediate `react-hooks/exhaustive-deps`
  warning — the debounce effect now touches `latest` via the blank-branch bump — resolved by adding
  the stable gate to that effect's deps, Shell.tsx:121.)

## Reviewer-attention notes

1. **AttachmentsSection §5.13 call — no clear-on-success inside `load` (deliberate deviation from
   the Quotes.tsx shape).** The old mount chain was
   `load().then(() => setError(null)).catch(...)`; folding that clear into `load`'s success path
   would make every handler refresh clear the banner — and in exactly the delete-during-upload race
   this task targets, the delete's reload succeeding CURRENT would wipe a concurrent upload-POST
   failure reported after it started (the §0 "a success-path reload must not erase a live failure"
   rule). The handlers already clear pre-dispatch (`setError(null); await load()`), which is
   preserved untouched, so the only semantics dropped is the mount chain's clear — dead in practice
   (`error` is null on first run, and the component remounts per owner page). A comment at :54–56
   states this.
2. **`load` is now always-resolving in both AttachmentsSection and ReferenceTable** (failure
   recorded via its own gated `setError` instead of rethrowing to the caller). Handler `try/catch`
   blocks therefore now only see their own mutation failures — same visible message on a refresh
   failure as before, from a different `setError` site. Side benefit in ReferenceTable: PasteGrid's
   `onDone` `void load()` can no longer produce a genuine unhandled promise rejection.
3. **ReferenceTable `remove()` interaction:** previously a `load()` rejection inside the `try`
   could, in principle, reach the catch's `e instanceof ApiError && e.status === 400` blocker
   branch and misattribute a list-GET 400 as a delete refusal; with `load` always-resolving that
   branch can now only be entered by the DELETE's own failure. Behavior change is strictly in the
   correct direction.
4. **Shell blur/Escape bump semantics:** `onFocus`'s `if (results) setOpen(true)` re-open of the
   last APPLIED results is unchanged, and the dropdown's option buttons `preventDefault()` on
   mousedown, so selecting a result never routes through the blur bump. The Enter/scan path is
   unaffected by a concurrent bump: `runSearch` returns its data unconditionally (only the
   setStates are gated), so navigation on `exactOrderId` still fires — pre-existing return-value
   flow, untouched.
5. **Shell me-fetch `/login` early-return takes no ticket** (kept minimal per the brief): a fetch
   still in flight when the user lands on /login stays CURRENT, but both of its outcomes are
   harmless there (`setMe` is invisible behind the `pathname === "/login"` passthrough render; the
   redirect pushes to where the user already is).
6. **HistoryPanel gains unmount safety for free** — the cleanup flag also covers the
   open/close-history toggles unmounting the panel mid-fetch, not only dep changes.
7. Not touched, per the brief: ShippingList/InvoicingList/CertList error channels (filed as
   issues), SetupBanner itself, and every file on the concurrent implementer's list.
