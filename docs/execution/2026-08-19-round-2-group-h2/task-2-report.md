# Task 2 — implementer report (#144 list-page error channels, #145 in-flight guards)

Branch `group-h2-client-state`. Eight code commits, one file (or one two-file mechanism) each,
in scope order. All refs below are at the post-commit tree.

## What changed and why

### #144 — split the error channels

- **`erp/src/app/shipping/ShippingList.tsx`** (`03bee03`): the customers-picker failure now
  lands in its own `customersError` state with its own amber banner (the NewShipment
  `loadError` precedent), never the shared `error` that `load()`'s success clears. Never
  auto-cleared — nothing retries the picker, so nothing can honestly clear it.
- **`erp/src/app/invoicing/InvoicingList.tsx`** (`1b1bc1e`, carries both issues): same
  `customersError` split; the picker failure no longer lands in `invoicesError`, which fixes
  the mislabel too — the "Could not load invoices:" banner now only ever shows invoice-list
  failures, and the picker failure gets its own "Could not load the customer filter:" banner.
- **`erp/src/app/certs/CertList.tsx`** (`2b9d006`): same `customersError` split, with the
  old comment (which declared the shared channel a feature) reworked to state why the shared
  channel is wrong. Also added the `loaded` flag (the `candidatesLoaded` precedent): `load()`
  sets it in both ticket-gated landings, and the "No certifications match these filters."
  empty-state row now gates on `rows.length === 0 && loaded && !error`, so it cannot render
  while the first fetch is still in flight.
- **`erp/src/app/customers/page.tsx`** (`e54b986`): the opposite defect, per the controller
  call — split into `loadError` (set by `load()`'s ticket-gated catch, cleared by its
  ticket-gated success, so a superseded search failure's banner no longer persists over fresh
  rows) and `actionError` (written and cleared only by `add()`, so a later load success can
  never wipe an add failure — the filed trade-off dissolves instead of picking a victim).
  Two banners; `loadError` keeps sharing the perms-error slot the old `error` had.
- **`erp/src/components/AttachmentsSection.tsx`** (`d663f08`): per-operation scoping via a
  tagged single channel — `{ source: "load" | "upload" | "delete"; message }`. Upload success
  clears the banner only if the current failure is NOT a delete's; delete success only if it
  is NOT an upload's; either still clears a load failure (exactly as today — the success's own
  reload immediately refreshes the list or re-reports). The #38 size-precheck message is
  tagged `upload`. `load()`'s deliberate no-clear-on-success stays, comment updated in place.

### #145 — in-flight guards (the templates `togglingActive` precedent)

- **`erp/src/app/quotes/Quotes.tsx`** (`f1f3225`): `bumpingIds: Set<string>` keyed by quote
  id; `bumpFollowUp` early-returns if that row is already in flight and clears its id in a
  `finally`; the date input disables (`title="Saving…"`) while its row's PATCH is in flight.
  The one render site serves both worklist sections, so the row-id key covers both renders.
- **`erp/src/app/page.tsx` + `erp/src/app/board-parts/SavedViewsBar.tsx`** (`8bc4415`):
  `settingDefault` state + early-return in `setSelectedDefault` (local mirror kept verbatim),
  cleared in `finally`; a `settingDefault: boolean` prop threads through SavedViewsBar's
  Props and disables the Set-as-default checkbox (`title="Saving…"`).
- **`erp/src/app/parts/[id]/PricingSection.tsx`** (`b7cfe25`): the in-file `addingRow` shape
  ported as three booleans — `removingRow`, `addingBreak`, `removingBreak` — each with guard
  at the top of its handler, `finally` clear, and disable+title on its buttons. The
  `invalidateHistory()` + `load()` sequencing inside each handler is untouched (guards wrap
  the existing body; nothing reordered).
- **`erp/src/app/invoicing/InvoicingList.tsx`** (`1b1bc1e`, same commit as its #144 half):
  `createInvoices` ends with the functional update — `setTicked(prev => …)` keeping every
  failure ticked (as before) plus any current tick not in the click-time `orderIds` snapshot,
  so orders ticked DURING the run survive it. Checkboxes stay enabled, per the controller call.

## Deviations from the brief, with reasons

1. **Picker channel without the accumulator** (ShippingList/InvoicingList/CertList). The
   brief's precedent pointer names NewShipment's "state + accumulator"; the accumulator
   exists there because four background fetches share one banner. Each of these pages has
   exactly ONE fetch reporting into the channel, so a plain set is the faithful port — an
   accumulator would only concatenate duplicate messages if the effect ever re-ran. The
   semantic content (separate channel, never auto-cleared, amber banner) is all present.
2. **`bumpingIds` (a Set), not the scalar `bumpingId` the brief names** (Quotes). A scalar
   forgets row A's in-flight PATCH the instant row B starts: A's `finally` then clears B's
   guard (or B's start clears A's), re-opening the exact unordered-PATCH window for a row
   whose request is still out. The Set keeps per-row blocking sound under concurrent bumps
   of different rows, which remain allowed (they target different quotes; `reloadAll` is
   ticket-gated).
3. **PricingSection guards are per operation KIND, not per target row/break.** The literal
   `addingRow` port (a boolean). During one request's window every button of that kind
   disables — accepted over-blocking for a sub-second window; a per-target scalar has the
   same forgets-the-first-flight race as (2), and a Set per operation felt heavier than the
   defect (a double-click on one button) warrants.
4. **AttachmentsSection: tagged channel** (the brief offered "two channels or a tagged one").
   One banner slot, so the visible behavior changes ONLY in the clearing rules. Note an op
   success still clears a LOAD failure — that is today's behavior, kept deliberately (the
   success's own reload either refreshes the list or re-reports the load failure).

## Commits

- `03bee03` fix(shipping): give the customer picker its own never-auto-cleared error banner (#144)
- `1b1bc1e` fix(invoicing): split the picker error channel and preserve out-of-run ticks (#144, #145)
- `2b9d006` fix(certs): split the picker error channel and gate the empty state on first load (#144)
- `e54b986` fix(customers): split the load and add error channels (#144)
- `d663f08` fix(components): scope attachment errors per operation (#144)
- `f1f3225` fix(quotes): guard the follow-up bump per row while its PATCH is in flight (#145)
- `8bc4415` fix(board): guard set-as-default against overlapping toggles (#145)
- `b7cfe25` fix(parts): guard pricing add/remove actions while their request is in flight (#145)

## Gates

- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.
- `npm test` — **200 files / 3345 tests, all green** (486s), run solo. **Actual database:
  the shared `erp_test`**, not the scratch DB: `tests/helpers/setup.ts:4` reassigns
  `process.env.DATABASE_URL = process.env.DATABASE_URL_TEST`, so the brief's
  `DATABASE_URL=…erp_scratch_h2t2 npm test` override never redirected vitest (coordinator
  ruling mid-task, after Task 3 discovered it: a solo green run against `erp_test` is valid,
  recorded with the DB named; the working override for future waves is `DATABASE_URL_TEST=…`).
  The scratch DB `erp_scratch_h2t2` was created and migrated per the brief, was only ever
  exercised by `migrate deploy`, and has been dropped.
  The same no-op override also explains the FIRST full run's mass failure (1126 tests, every
  failure inside `truncateAll` → `reseedSingletons`): all three implementers' suites were
  unknowingly truncating the one `erp_test` concurrently. Not the diff — the failing files
  passed individually right afterwards, and the solo re-run is fully green.

## What the reviewer should probe

- **AttachmentsSection**: with one banner slot, an upload failure followed by a delete
  failure OVERWRITES the message (latest failure wins) — both are still protected from the
  other op's success-clear, which is what #144 asks; verify the choice is acceptable.
- **Quotes**: the early-return reads the render closure of `bumpingIds` — the disable is the
  real guard; the return is belt-and-braces (the precedent has the same shape). Two change
  events for one row cannot share a tick, so the closure staleness window is theoretical.
- **InvoicingList**: a failing order the user UNTICKED mid-run is re-ticked at the end
  (failures always re-tick, pre-existing behavior, kept).
- **customers/page.tsx**: `add()`'s success still calls `load()`, whose success now clears
  `loadError` — the add-success path can therefore clear a stale load failure too, which is
  correct (fresh rows just landed).

All client-component changes; no pure helper was extracted, so no new vitest suite (the
brief's "if you extract any pure helper" clause was not triggered). E2E is group-level, not
run here.
