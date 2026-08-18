# Group D — out-of-class findings to file as issues at close-out (brief Task 9)

Surfaced by the 2026-08-18 sweep audit; deliberately NOT fixed on `group-d-stale-loads` (they are
adjacent families, not the stale-load class the group closes). Line refs are pre-Group-D tree
(`a9ff2ca`); anchors may shift a few lines by merge. File each with `gh issue create` at close-out.

## 1. List-page error-channel hygiene: picker failures erased, stale banners never cleared

Four files share one shape-family: a secondary fetch reports into a channel another fetch clears
(or never clears), so the on-screen error state can misdescribe reality. All display-only.

- `src/app/shipping/ShippingList.tsx:58` — the customers-picker failure lands in the shared
  `error`, and `load()`'s success clears it on every search keystroke → enabled-but-silently-empty
  Customer select, the §5.16 state the fetch exists to avoid. Fix: the NewShipment `loadError`
  shape (its :144–149) — a separate, never-auto-cleared picker banner.
- `src/app/invoicing/InvoicingList.tsx:110` — same mechanism (catch writes `invoicesError`,
  `loadInvoices` success nulls it), and the banner text mislabels the failure "Could not load
  invoices:". Fix: own `customersError` state.
- `src/app/certs/CertList.tsx:117` — same (deliberately-shared channel, comment :112–114);
  a certs-list success erases the customers-picker failure. Also: no `loaded` flag, so the
  pre-first-load empty rows render "No certifications match these filters" (the §5.15
  trust-an-empty-list defect InvoicingList fixed with `candidatesLoaded`).
- `src/app/customers/page.tsx:45` — the opposite direction: the ticket-gated success path never
  clears `error`, so a superseded search failure's banner persists over fresh rows (the file's own
  F7 comment calls that state a bug). Note the trade before fixing: clearing on load success
  opens the narrow add()-failure-wipe window the detail page accepted (its :229–235).
- `src/components/AttachmentsSection.tsx:101` (post-Task-5 line) — the Task 5 review's minor 3:
  the handler-side `setError(null)` on delete success still wipes a concurrent upload's failure
  banner (Task 5's load-side deviation closed only the reload half of that window).

## 2. Missing in-flight guards on mutation controls (the `togglingActive` family)

The house precedent is processes/templates/[id]/page.tsx:104–123 (`togglingActive`): disable the
control while its own mutation is in flight. Sites the audit found without it, where the miss has
a server-side or selection-visible consequence:

- `src/app/quotes/Quotes.tsx:149` — `bumpFollowUp`'s per-row date input stays enabled during its
  PATCH; `<input type="date">` fires onChange per segment edit, so two unordered PATCHes race and
  the DB can keep the EARLIER pick (display converges via the gated reload; the data silently
  reverts). Fix: per-row `bumpingId` in-flight disable.
- `src/app/page.tsx:189` — the saved-view "Set as default" checkbox: two quick toggles are two
  unordered PATCHes applied to `savedViews` in ARRIVAL order, never refetched → UI can
  permanently show the opposite of the DB, surfacing only as the wrong view auto-applied next
  session. Fix: `settingDefault` disable (or useMutationGate on the response).
- `src/app/parts/[id]/PricingSection.tsx:268–286` — addBreak/removeRow/removeBreak have no
  in-flight guard; a double-click sends two POST/DELETEs and can create a duplicate break row
  server-side (display stays ordered via the gated reload). addRow already has the guard
  (`addingRow`); port it.
- `src/app/invoicing/InvoicingList.tsx:159` — related, not a guard: `createInvoices` restores
  `ticked` from its click-time snapshot, silently unticking any order the user ticked during the
  run. Fix: functional update preserving out-of-run ticks, or disable row checkboxes while
  `creating`.

## 3. BatchDetail: a failed post-apply refresh is silently swallowed

`src/app/receivables/batches/[id]/BatchDetail.tsx:730` — `onApplied={() => { void load(); }}`:
`load` rethrows, so a network blip after a successful apply = unhandled rejection + a silently
stale page (header Entered/Balance, onAccount, applications table all pre-apply) with no banner —
immediately after the operator was told nothing. The same file already handles this exact case in
`voidBatchAction` (:555–559: "succeeded, but the page could not be refreshed"). Fix: catch and
report the same way.

## 4. Close page: readiness section renders affirmatively from un-loaded state

`src/app/receivables/close/Close.tsx:319` — "No GL account gaps for this period — ready to
export…" has no `loaded` guard (and the error path never clears `readinessGaps`), so before the
first load / after a failed load / mid month-switch it can assert readiness or show the previous
month's gaps; `exportTitle`/`gapCount` (:351–356) lack the `!loaded` arm `closeTitle` has (:237),
so Export is momentarily enabled on stale `gapCount=0`. Bounded — `exportClose` re-checks
server-side and 409s — so the cost is a confusing refusal, never wrong data. Fix: mirror
`closeTitle`'s discipline (a `!loaded` arm + gate the affirmative line on `loaded && !error`).

## 5. CustomFieldsSection: the success-path reload wipes values typed during the save

`src/app/parts/[id]/CustomFieldsSection.tsx:50` — inputs stay editable while `save()` PUTs the
dirty rows captured at click time; the success `load()` wholesale-replaces `rows`+`original`, so
anything typed into ANOTHER field during the round trip silently reverts. This is precisely what
ProcessStepsSection's `editsAfterSave`/`clearSubmittedEdits` machinery exists to prevent
(its :217–229). Fix: the editsAfterSave port, or readOnly inputs while `saving`.

## 6. Typed-text overlay gaps: the T16 clobber family's remaining sites

The Phase 4 fix-wave's `useEditGuard` protects the focused-and-dirty field of the SINGLE entity
state on customers/cert/shipment. Two audited gaps in the same family (HANDOFF already carries
the notes-pair three-page group; these extend that list, not the stale-load class):

- `src/app/customers/[id]/page.tsx:142` — `setAddresses`/`setContacts` never route through any
  focus-preserving merge (the file's own :313–314 comment confirms), so any load landing
  mid-typing in an address/contact cell reverts the un-blurred keystrokes (reachable: click
  "make default" on row 1, immediately type into row 2 — the reload lands within its RTT). Fix
  shape: a row-scoped keyed variant of `editGuard.merge` for the arrays.
- `src/app/orders/[id]/page.tsx:232` — Overview/Notes scalar inputs are controlled straight from
  `order`; an accepted mutation response (e.g. the Received-date save, which saves onChange)
  replaces `order` and resets a sibling field mid-typing; `onBlurSave` then diffs against the
  focus-time value and silently never saves the lost keystrokes. The bulk grids avoid this with
  local overlays (top comment :11–14); the scalars never got one.
