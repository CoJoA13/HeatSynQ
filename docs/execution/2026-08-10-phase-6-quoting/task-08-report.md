# Task 8 report — `/quotes` UI: worklist + list + detail (ruling 11)

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-11 · **Implementer:** Task 8 subagent

## What was built

One commit (`7d1f16f`), four pages plus one shared module, all client components over the
Task 4/5 routes — **zero server-side changes**:

- **`erp/src/app/quotes/quote-form.ts`** — the shared client-safe module: local mirrors of the
  quote read models, the detail page's form state, and the ONE place the PATCH payload is built
  (`headerPatch` / `linesPayload` / `linesComparable`). The round-trip contract lives here and
  nowhere else.
- **`erp/src/app/quotes/page.tsx` + `Quotes.tsx`** — ruling 11's page: the two §5.4 worklist
  sections first (counts in the headings; inline open link, bump-follow-up date picker that
  PATCHes `{followUpDate}`, close-with-reason via the house `prompt()` dialog, rendering the
  response's `linkedOpenOrders` as a linked warn-list banner), then a **New quote** section (the
  ReceivablesList "New batch" precedent: customer picker + first line as memorized-part XOR
  free-text part number, POST, `router.push` to the new detail where the server defaults — quote
  number, dates, default ending statement, quotedBy — are visible), then the full list: search,
  status filter incl. **derived Expired** (maps to `expired=1`, never a fake status token),
  follow-up-due, customer, three date ranges, Excel export sharing one `buildQuery` with the
  list fetch (the InvoicingList mirror-of-`parseQuoteFilter` shape). Status cells render the
  derived label exactly as the server's own export does.
- **`erp/src/app/quotes/[id]/page.tsx` + `QuoteDetail.tsx`** — `key={id}` remount wrapper
  (§5.12) + the detail body: a **single-save form** (header incl. the notes pair + the whole
  line/price/break tree, one Save), status banner (Open / Closed with reason-by-at / derived
  Expired chip / Deleted chip), lines grid mirroring the 5A part-prices card UX (per-line price
  cards, breaks tables with per-card add drafts, the verbatim basis-change `confirm()` warning,
  move up/down, synthesized fallback options for missing pick-list rows — the R3 rule), the
  part-picker/free-text toggle with prefill-on-detach, the dedicated **attach-part** action on
  persisted free-text lines (`POST .../attach-part`), linked-line indicators from the detail
  payload with proactive §5.14 locks, close/reopen/delete prompt-reason dialogs, the delete
  refusal rendered as the shared `BlockerPanel` (list derived from the detail payload, Excel via
  the existing `blockers/export` route), documents section (kind QUOTE) with empty state,
  disabled Print placeholder, `HistoryPanel entity="quote"`.

## The single-save model (and how it differs from the sibling pages)

The sibling detail pages PATCH per field optimistically; this page deliberately does not — the
notes-pair clobber family (the brief's named three-page bug) is an artifact of sibling
optimistic PATCHes, and `PATCH /api/quotes/[id]` is in any case the only write surface for
header and tree alike. The form is an explicit draft over the last-loaded detail:

- **Save sends a client-side diff**: only changed header keys (`updateQuote` patches every key
  it receives, unchanged or not, so unchanged keys are simply not sent — and `customerId` is
  never sent: immutable, and echoing it mints a no-op audit entry, Task 4 Minor 3), plus `lines`
  only when the tree changed. A fully clean form sends nothing — Save is disabled
  "No unsaved changes" (the empty-body 400 is unreachable).
- **A failed save keeps the draft** and surfaces the server's message verbatim (the
  InvoiceLinesGrid precedent). Nothing here is optimistic, so §5.13's rollback-first rule has no
  divergence to repair; where the page IS optimistic (the worklist's bump-follow-up) failure
  reloads server truth FIRST, then reports. No `.catch(() => {})` anywhere in the new files.
- **Actions that adopt a fresh server detail** (close, reopen, attach-part) are disabled while
  dirty ("Save or discard your changes first") — adopting would silently discard the draft.
  `useEditGuard` is unnecessary under this model: no server detail ever lands mid-keystroke.

## Round-trip no-op verification (including eachWeight) — manual, narrated

Driven live against `npm run dev` + the dev DB with the real pages, request bodies captured by
instrumenting `fetch`, DB state checked directly:

1. Created quote #1000 (customer T8FIX) with a free-text line, filled name/material/description,
   **eachWeight 12.5**, quotedQty 250, one T8HT price row (25 / 0.15 / 100, EACH, notes) and a
   break (500 → 0.12); saved; reloaded.
2. **Untouched load:** Save and Discard both disabled, title "No unsaved changes" — an unchanged
   load→save issues no request at all.
3. **Header-only edit** (notes): the PATCH body was exactly `{"notes":"…"}` — no other header
   key echoed, no `lines` key, so the tree (eachWeight included) was untouched by construction.
4. **Line edit** (break price 0.12 → 0.11): the PATCH body carried `lines` with
   `"eachWeight":"12.5"` on the free-text line — the Task 4 `linesPayloadFrom` Minor fixed —
   and stable ids at every level. After the save: `QuoteLine.eachWeight` still `12.5000`,
   `QuoteLine.updatedAt` and `QuotePrice.updatedAt` **byte-identical to their pre-save values**
   (the diff-and-write wrote neither row), only the break row updated in place (same id, not
   re-minted — threshold unchanged). One audit entry per saved change, no churn entries.

Part-linked lines send their free-text columns and eachWeight BLANK (the `linesPayloadFrom`
shape; Task 4 deviation 5's documented behavior — the detail resolves those fields from the
part, so echoing them back would write the part's live identity into the dormant columns). For
a line that was never free-text, blank IS the stored value, so that too is a no-op.

Also exercised live: create → detail redirect with server defaults visible (quote/effective =
today, expiry = +30d, quotedBy = actor); worklist Follow-up due (1) → bump from the row →
section empties; §5.14 delete refusal rendering the BlockerPanel ("Order #7940" linked, note,
Excel link) with the link fabricated via a direct `OrderLine.quoteLineId` insert (the test
suite's `linkOrderTo` shape); close → Closed banner + the linkedOpenOrders warn-list ("#7940",
judged-at-link-time explanation); CLOSED lock titles on Save and inputs; reopen clearing the
close story; attach-part flipping the line to part mode (read-only under its link lock);
derived-Expired chip + `expired=1` filter + part-number search all agreeing with the worklist;
clean delete redirecting to `/quotes`. All fixtures purged from the dev DB afterwards
(tables back to zero rows; only pre-existing audit entries remain; `t8bare` user removed).

## Every §5.16 gate on the two pages

All via the shared `gate`/`gateDo` helpers (disabled + tooltip naming the permission), plus the
two house lock shapes (`statusLocked`, dirty-lock) layered per the PricingSection compound-gate
precedent (title names whichever is actually the blocker):

`/quotes` (Quotes.tsx):
- Bump-follow-up date input, per worklist row — `quotes.edit`.
- Close… button, per worklist row — `quotes.edit`.
- New quote button — `quotes.create` (plus "Creating…" while in flight).
- New-quote customer select — `quotes.create`, then `customers.view` (options fetched only when
  held).
- New-quote part select — `quotes.create`, then `parts.view`, then "Pick a customer first" /
  "Clear the free-text part number…" (mutual-exclusion titles).
- New-quote free-text input — `quotes.create`, then "Clear the part pick…".
- Customer FILTER select — `customers.view` (the InvoicingList precedent).

`/quotes/[id]` (QuoteDetail.tsx) — `editGate` = `quotes.edit` → "This quote is closed — reopen
it before editing" (CLOSED) → "Quote is deleted" (deleted):
- Save — `editGate`, then "No unsaved changes" / "Saving…".
- Every header input/textarea (dates, follow-up, RFQ, ending statement, notes pair) — `editGate`.
- Contact select — `editGate`, then `customers.view` (options gate).
- Quoted-by select — `editGate`, then `manage_users` (the users list rides
  `GET /api/admin/users`, gated `mustDo(manage_users)` — see deviations).
- Close… — `editGate` shape ("Already closed" when CLOSED, "Quote is deleted"), then the dirty
  lock. Reopen… — mirror ("This quote is not closed").
- Delete… — `quotes.delete`, "Already deleted" when deleted.
- Print — always-disabled placeholder, title "Printing lands in Task 10".
- Per line: move/remove/add-line, all free-text fields, qty + Unlimited, part re-pick select
  (`editGate` then `parts.view`), "Switch to free text" — `editGate`; Remove line additionally
  "A quote must keep at least one line" and the §5.14 link lock ("Order(s) #N still price from
  this line — its part cannot be changed and the line cannot be removed while they do", also on
  the read-only part display of a linked line).
- Attach-part select + button — `editGate`, then the dirty lock, then `parts.view`, then "Pick
  a part first".
- Per price row: step select ("Options failed to load — reload the page" when the pick-list
  fetch failed), money fields, price-per, notes, breaks (cells, delete, add-draft inputs,
  Add break), move/remove/add-operation — `editGate`.
- Documents section — `quotes.view` (renders the gate title in place of the list, the
  InvoiceDocumentsList shape).

Area access follows the house pattern for client pages: every data API 403s without
`quotes.view` (verified live with a zero-permission user: `/api/quotes`, `?worklist=1`, and
`/export` all 403 into the page banner; the Shell nav entry hides; the page shell itself is a
client component and renders only the banner).

## Deviations

1. **No `GET /api/quotes/[id]/documents` route exists yet** — the brief's "existing documents
   API" is per-owner (`invoices/[id]/documents` etc.), and quotes have no member. Stopping on
   the whole task for it would be disproportionate: the invoices precedent (Task 18 wired the
   section; Task 19 landed the route at that exact path) covers this shape, so the section
   fetches `/api/quotes/[id]/documents`, renders a 404 as the "Nothing printed yet." empty
   state, and **Task 10 must land the documents-list route at that path** alongside the print
   route (flagged for the controller; no server code was added here).
2. **The quoted-by picker's options gate is `manage_users`** — the only users list in the app is
   `GET /api/admin/users`. A user holding `quotes.edit` but not `manage_users` sees the current
   quotedBy (synthesized option) and a §5.16 tooltip naming `manage_users`. If the owner wants
   ordinary quoting users re-assigning quotedBy, that needs a session-gated users pick-list —
   a route change, so: reported, not built.
3. **Delete is not dirty-locked** (close/reopen/attach are): deleting discards the quote anyway,
   and the prompt makes the intent explicit; a refusal leaves the draft untouched — the §5.14
   blockers panel refreshes from a fresh fetch that is deliberately NOT adopted into the form
   state (fix round 1, Important 1: the original code adopted it, silently discarding the
   draft), so the panel shows current truth while the per-line indicators keep their load-time
   links until the next adopt — the server guard, not the indicator, is the enforcement.
4. **The list page's search/filters refetch per keystroke** under the shared `useLatest` gate
   (the parts/customers list precedent) rather than debouncing — house pattern, kept.
5. **New-quote part picker is a plain filtered select**, not the orders/new `Combobox` — that
   component lives in `src/app/orders/new/` and importing across route folders would be a new
   coupling; per-customer part lists are small. Same on the detail page's pickers.
6. **`linesComparable`/`linesPayload` compare and send raw strings** ("25" not 25.00) — the
   server's `decimalField` accepts decimal strings (the 5A client precedent), and `decEq`
   compares parsed values, so "12.5" round-trips against a stored `12.5000` as a no-op.

## Gate results

| Gate | Result |
|---|---|
| `npm test` | **129 files passed, 2094 tests passed, 0 failed** (unchanged — no server code touched) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | ✓ Compiled successfully; `/quotes` + `/quotes/[id]` present in the route manifest |
| `npm run test:e2e` | **All 18 flows passed** (exit 0; the run also covers this task's UI incidentally — the permission-gating flow's restricted user exercises the Shell nav's area filter the Quotes entry now rides) |

All gates were re-run FRESH after an API-limit cutoff killed the first E2E attempt mid-flow-18
(the first 17 flows had passed; the stale `next dev`/runner processes were killed before the
rerun). Dev-DB fixtures are clean twice over: the manual-verification fixtures were purged by
hand (zero rows verified in every quote table; fixture customer/part/step-code/user removed),
and the E2E rerun's own teardown ran to normal completion (post-run check: all fixture tables
zero rows, `admin` the only live user).

## Fix round 1 (task-reviewer: Needs fixes — 1 Important, 2 Minor)

Commit `4866093`, all three findings closed:

1. **Important — refused delete discarded a dirty draft.** The blocker-refusal path called
   `adopt(fresh)`, replacing header+lines wholesale — the exact silent draft-discard the
   dirty-lock model exists to prevent, and it contradicted deviation 3. **Chosen fix: refresh
   without adopting** (the reviewer's first suggestion) rather than dirty-locking Delete — a
   dirty-locked Delete would force the user to save edits they may be deleting the quote to
   escape from. The fresh fetch now feeds ONLY `blockersFrom`; the form state is untouched.
   Verified live: with unsaved line text in the form and a fabricated order link, the refused
   delete rendered the panel naming order #7941 while the draft text, the dirty indicator, and
   the free-text eachWeight (3.25) all survived. Deviation 3 updated to record the mechanism.
2. **Minor — close/reopen rollback-reload failures were swallowed** (`.catch(() => undefined)`),
   leaving stale detail beside a banner explaining a different failure. Both now use the delete
   path's shape: reload first (§5.13), and a failed reload is APPENDED to the message
   ("… — and the page could not be refreshed (…). Reload to see the current state.").
3. **Minor — "Add break" disabled with no tooltip** when the draft threshold/price were empty.
   Now titled "Enter a threshold and price first" (§5.16 style); verified live (disabled+title
   with empty drafts, enabled+no-title once both are filled).

Gates re-run after the fixes: vitest **129 files / 2094 passed**; tsc clean; eslint clean;
build compiled; **E2E all 18 flows passed (exit 0)**, watched to completion — fix-round
fixtures purged from the dev DB (all quote tables and the fabricated
order/part/step-code/customer at zero, re-verified after the E2E teardown).

## For the reviewer to scrutinize

- **The client-side header diff** (`headerPatch`) as the mechanism making unchanged saves
  no-ops — the server patches every present key, so the no-op guarantee lives client-side; if a
  future field is added to `HeaderForm` but not to `headerPatch`, its edits would silently never
  save (the shapes are adjacent in one file to keep that visible).
- **The blank-when-linked rule in `lineShape`** — it writes ""/null over a previously-attached
  line's dormant free-text history on any lines-carrying save (Task 4 deviation 5's documented
  round-trip shape, but worth a second pair of eyes on whether the owner expects dormant text to
  survive).
- **`linesComparable` as the dirty test** — JSON over the exact wire shape; a field sent by the
  payload but omitted from the comparable (or vice versa) would produce phantom/missed dirty
  states. They share `lineShape` precisely so they cannot drift.
- **The §5.14 proactive locks derive from load-time `linkedOrders`** — a link created after load
  isn't reflected until the next adopt; the server guard remains the authority (the UI lock is
  §5.16 courtesy, not the enforcement).
- Deviation 1 (the Task 10 documents-route path contract) and deviation 2 (the `manage_users`
  options gate) — both owner-visible calls.
