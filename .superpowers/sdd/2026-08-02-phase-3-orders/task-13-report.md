# Task 13 report — Order entry UI + autosave

**Status: complete.** All four quality gates green; dev-server smoke test executed end to end
against real seeded fixtures (created and cleaned up in the `erp` dev DB, not `erp_test`).

## Files

- Created `erp/src/app/orders/new/page.tsx` (662 lines) — state, mount-time fetches, autosave,
  validation, save/retry, and the customer/dates/containers/charges/notes sections.
- Created `erp/src/app/orders/new/Combobox.tsx` (86 lines) — generic keyboard-first typeahead,
  reused for the customer picker and every line's part picker.
- Created `erp/src/app/orders/new/OrderLineCard.tsx` (257 lines) — one part line: picker,
  qty/weight (derived-until-touched), the lead's revision-lock check + preview, serial entry.

**Decomposition beyond the brief's literal "Create: page.tsx"**: split into three files because
the top-level task prompt explicitly sanctioned "may decompose into colocated components... note
any split in your report." Combobox is genuinely shared (customer + every line's part picker);
OrderLineCard is the single most stateful unit (its own async lead-validation effect) and repeats
once per line. Containers/charges/dates stayed inline in `page.tsx` — each is a simple grid with
no reuse and no async concerns of its own.

## Context findings noted per the task's explicit asks

- **`GET /api/parts` has no `customerId` filter.** Verified by reading
  `erp/src/app/api/parts/route.ts` and `listParts` in `erp/src/server/parts.ts` — only
  `includeInactive`/`search`. Fetches the whole active catalog once on mount (gated on
  `parts.view`) and filters to the chosen customer client-side (`customerParts` in `page.tsx`).
- **Parts list payload carries no steps-status column.** `PartRow`/`PartOption` have no
  `stepCount`/`hasSteps` field. Per the task's steer, implemented lazy validation instead of
  upfront per-option disabling: `OrderLineCard` fetches `GET /api/parts/[id]/process/revisions`
  only for the part actually picked as lead (not for every option in the dropdown), takes the
  highest-numbered revision (`revs[0]`, already `orderBy: desc`), and — only if it has
  `stepCount ≥ 1` — fetches `GET /api/parts/[id]/process/revisions/[n]` for the preview. A part
  with no revisions or zero steps shows an inline "No process steps — this part cannot be the
  lead" and sets `leadValid = false`, which blocks Save client-side (`validate()`) in addition to
  the server's own 400. Gated on `processes.view`; if absent or the fetch fails, the check reports
  "unknown" and does **not** block Save — the server's 400 remains the real gate. This trades one
  fetch per pick against N fetches per dropdown open, which was the brief's own reasoning for
  steering this way.
- **`GET /api/customers` already returns the full `CustomerRow` shape** (`defaultPo`,
  `orderNotes`, `creditHold` included), identical to `GET /api/customers/[id]`. One list fetch on
  mount is therefore sufficient — no per-selection detail fetch needed.
- **Container type picklist**: `GET /api/picklists/containerType`, session-only gate (no
  permission beyond signed-in), confirmed against `erp/src/app/api/picklists/[kind]/route.ts` and
  `PICKLIST_KINDS`. Rendered as a plain `<select>` (not the Combobox) — the brief calls the
  customer/part pickers "autocomplete" explicitly but only says "picklist" for containers, and a
  plain select matches every other reference-table picker in the app (Material, Terms, etc.).

## The binding state model — self-review

**Draft payload keys** (captured live from a real `GET /api/order-drafts` response mid-test,
included verbatim so the shape is inspectable, not just asserted):

```json
{
  "customerId": "…", "poOverride": null, "vsOrderNumber": "",
  "receivedDateOverride": null, "requestDateOverride": null, "targetDate": null,
  "notes": "…",
  "lines": [{ "id": "…", "partId": "…", "qty": "3500", "weightOverride": null,
              "serials": [{ "id": "…", "serial": "EC001", "description": "" }, …] }],
  "containers": [{ "id": "…", "typeId": "…", "count": "8", "qty": "",
                   "tareWeight": "2936", "grossWeight": "67514" }],
  "charges": [{ "id": "…", "description": "Rush surcharge", "amount": "150.00" }]
}
```

Every key is either a direct typed value or an explicit override flag (`null` = untouched,
non-null = the user's own text). **Absent, correctly**: the part's `eachWeight`/name/number, the
customer's `defaultPo`/`creditHold`/`orderNotes`, the computed request date, the locked revision
number/steps, the container type's name. All of those are recomposed at render from
`customers`/`parts`/`entryDefaultRequestDate` state, which are themselves never persisted to the
draft — confirmed live: resuming a draft re-fetched and correctly re-showed the credit-hold
banner, the "Rev 1 — locks at save" preview with its step text, and the computed line weight,
none of which exist anywhere in the JSON above.

**No server imports**: `grep -rn "from \"@/server\|from \"\.\./\.\./server"` across
`src/app/orders/new/` returns nothing.

**§5.16 gating on Save**: `saveGate = gate(perms, "orders.create")`; the Save button is
`disabled={saving || saveGate.disabled}` with `title={saveGate.title}`. Draft autosave itself is
deliberately ungated on any permission (matches the aux-routes' own "session only" design — any
signed-in user may scratch a draft regardless of `orders.create`).

**Every fetch is use-latest or single-flight guarded, or provably single-fire**: the two
*reactively re-triggerable* fetches — entry-defaults (refires on customer/lead-part change) and
the lead-steps check (refires on lead-part/isLead change) — both carry their own `useLatest()`
gate. The four *fire-once-on-mount* fetches (draft check, customers, parts, container types)
match the board page's own precedent of not needing `useLatest` when there is only one real
trigger point in the component's lifetime. The autosave PUT is a single-flight **queue**
(`autosaveChain`, chaining each attempt onto the previous one's settlement) rather than merely
debounced — debounce alone only cancels a timer that hasn't fired yet, not a request already in
flight; the queue closes that gap for real.

**No `.catch(() => {})`**: `grep -n "\.catch("` across the three files — every handler sets a
real error/warning state.

## Bugs found and fixed via the dev-server smoke test (not hypothetical — each reproduced live)

1. **Blank-visit spurious draft.** Simply visiting the page and leaving (no typing) autosaved the
   untouched blank state, so the *next* visit showed a "Resume a draft?" prompt for nothing. Fixed
   with `isDraftEmpty()`, gating the very first autosave write on the draft actually differing
   from blank (ignoring the synthetic local `id` fields). A draft that *was* edited and later
   cleared back to blank still autosaves normally — only the very first write is suppressed.
2. **Combobox re-focus bug.** Clicking back into an *already-focused* input (e.g., to change a
   just-made pick) fires no new DOM `focus` event, so the next keystroke landed inside the
   still-displayed old label instead of starting a fresh search (`"9999999 — No Steps Test
   Part3541719C3"`). Fixed by also wiring the reset onto `onClick` (fires on every click,
   focused-already or not).
3. **Autosave PUT could overlap a save's own draft-clear.** Closed the common case: `handleSave`
   now cancels any pending (not-yet-fired) debounce timer and suppresses scheduling a new one via
   a ref checked synchronously. The single-flight queue above closes the *overlapping-PUTs* case
   generally. One narrow window remains, documented in code: a PUT already dispatched (network
   round trip in flight) the instant Save is clicked isn't cancelled — worst case is a spurious,
   harmless resume prompt on the next visit to an already-saved order; not attempting request
   cancellation for a 1–5 user internal tool.
4. **Orphaned customerId showed a silently blank picker.** Discovered while deliberately testing
   a resumed draft whose customer had since been deleted: the part-side "not in this customer's
   catalog" message already existed, but the customer picker itself just went blank with no
   explanation — the same misrepresenting-stored-data shape this codebase's history repeatedly
   flags as Critical. Added the parallel inline "This customer is no longer available" message.
5. **Container's optional per-unit qty had no validation.** A non-numeric value would silently
   become `null` on the wire (`Number("abc")` → `NaN` → `JSON.stringify` strips to `null`) instead
   of surfacing an error. Added to client-side `validate()`.

All five are reflected in the current code with comments explaining what was wrong and why.

## Smoke test — concrete results

Fixtures created directly via Prisma against the **dev** DB (`erp`), matching the mockup
(`docs/samples/2025-aht-orderform-mockup.pdf`): customer `T13SMOKE` (credit hold on, standing
order note, `defaultPo`), lead part `3541719C3` (eachWeight 13.5, loadQty 336, one locked-ready
revision with one step), rider part `3541720C3` (eachWeight 13.5, `serializationRequired`), a
third part `9999999` with zero process steps, container type `T13 Drop Pan`.

Dev server driven via the Chrome-in-pane tool. The pane's synthetic `computer.left_click` proved
unreliable for this session (confirmed via direct DOM inspection — clicks landed at the right
coordinates but events weren't consistently delivered), so interaction was driven through
`javascript_tool` dispatching real DOM events (`input`, `mousedown` for the Combobox's
mousedown-committed options, `click` for plain buttons) — this exercises the actual component
code paths, not a bypass of them.

Verified, in order:
- Customer pick → credit-hold banner **exact copy** "⚠ T13SMOKE is on credit hold — orders can be
  entered; shipping will require release." + standing-notes banner + PO prefilled
  `STANDING-PO-T13` + request date `2026-08-10` (business-day chain from a Monday `2026-08-03`).
- Picking `9999999` as lead → inline "No process steps — this part cannot be the lead"; attempting
  Save while this part was still the lead → blocked client-side with "Lead line: this part has no
  process steps — choose a different lead part", **no** `POST /api/orders` fired.
- Switching to `3541719C3` → "Rev 1 — locks at save" + step preview text
  ("T13-AUS — Austemper: Furnace Temp: 1550F for 1 hour.").
- Qty 2500 → weight 33750; qty 3500 → weight 47250 (recomputed both times); manual override to
  99999 survived a further qty change to 3500; "Reset to computed" → weight back to 47250 exactly
  (13.5 × 3500).
- Rider line, part `3541720C3`, qty 2000 → "Serialization required — no serials entered yet."
- `EC{001-005}` on the lead → 5 rows `EC001`..`EC005`; editing one to duplicate another → inline
  "Duplicate serial: EC001"; fixed → warning cleared.
- Container: Drop Pan / count 8 / tare 2936 / gross 67514 → **Net: 64578** (exact).
- Charge "Rush surcharge" / 150.00; notes text.
- **Mid-entry reload → "Draft from HH:MM — Resume / Discard" banner appeared.** Resume restored
  every field exactly (qty, weight override state, all 5 serials, container row, charge, notes) —
  confirmed by direct input-value inspection, not just visual text. Derived values were correctly
  **re-computed**, not restored from storage: PO/received/request date all re-derived fresh after
  hydration.
- Discard verified separately (DELETE fires, form resets, no data reappears).
- **Save → `router.push` landed on `/orders/cmsd2y1tz…` → 404 page** (Task 14 not built — expected
  per the brief). Re-opening `/orders/new` afterward showed **no** resume banner (server-side
  clear confirmed).
- **Direct DB read of the saved order** confirmed full correctness: `orderNumber` 1002; lead
  line `revisionNumber: 1` (locked), rider line `revisionNumber: null`; lead weight 47250, rider
  weight 27000 (13.5 × 2000, computed — never touched); container net matches; 5 serials on the
  lead line; charge present; **loads auto-split into 17** (16 × qty 336 / weight 4536, 1 × qty 124
  / weight 1674 — exact match against `splitLoads`' documented math for total qty 5500 with
  `loadQty` 336: `floor(5500/336)=16` full loads + a 124-piece remainder, weights proportional and
  exact to the cent).

All fixtures (customer, parts, container type, step code, revision/step, the one order and its
children, plus a second minimal customer used to re-verify the single-flight autosave fix)
hard-deleted from the dev DB afterward via exact-key scripts, verified zero remaining rows
matching the fixture keys. Scratch scripts removed from the working tree before committing.

## Gates

`npx tsc --noEmit`, `npx eslint src tests`, `npm test` (871/871, 72 files), `npm run build` — all
green, run twice (once before the smoke test, once after the five fixes above).

## Commit

`0cfd2a3` — `feat: order entry with autosave drafts` (branch `phase-3-orders`), 3 files, 1011
insertions, no attribution trailer.

## Concerns / carried forward

- The residual save-vs-in-flight-autosave race (item 3 above) — narrow, harmless, documented in
  code rather than fixed with request cancellation.
- Task 14 (order hub) currently has no path to display the CREATE response's `warnings[]` (e.g.
  the credit-hold/serialization notices from a fresh save) since `getOrder`/`OrderDetail` carries
  no `warnings` field and the entry page navigates away immediately on success per this task's own
  contract. Not attempted here since it's Task 14's page and `OrderLineDetail.part` doesn't even
  select `serializationRequired` today. Worth Task 14 (or a later pass) deciding how — recompute
  live from a parts fetch, or accept that create-time warnings are simply transient.
- The Chrome-pane click-delivery quirk encountered this session (screenshots unavailable;
  `computer.left_click` unreliable for some elements) is worth flagging for whoever runs Task 14's
  smoke test — driving interaction via `javascript_tool`'s real DOM events was the reliable
  fallback used throughout.

---

## Fix round 1

Coordinator review flagged four Important-class items plus two minors. All addressed below.
**Correction to the original report**: item 1's race was described there as "narrow... harmless."
That characterization was wrong — the reviewer confirmed it can resurrect a stale draft and, if
an operator then clicked Resume and Save again, create a genuine duplicate order (the exact
outcome spec §15's no-duplication rule exists to prevent). It is fixed properly below, not
re-characterized as acceptable.

### 1. Save-vs-autosave race — fixed, not just documented

`handleSave` (`erp/src/app/orders/new/page.tsx`) now does three things, in order:
(a) cancels the pending (not-yet-fired) debounce timer — unchanged from before;
(b) `await autosaveChain.current` — the single-flight queue's current tail — **before** calling
`submitOnce`, so any autosave PUT already dispatched (network round trip in flight) is guaranteed
to complete before the create transaction runs and clears the draft;
(c) sets a new `savedRef` (permanent, set only on success) checked at the top of the autosave
effect alongside the existing `savingRef` (which spans one attempt and resets on failure) —
belt-and-suspenders now that a successful save with warnings no longer navigates away immediately
(item 2), so the component can stay mounted well past the point autosave must stop for good.

**Verified with hard timestamps**, not just re-reading the code: monkey-patched `window.fetch` in
the live dev server to delay the draft PUT by 6 seconds (simulating network throttling — devtools
throttling isn't reachable through this session's browser tool), logged every relevant event to
`sessionStorage` (survives the page navigation a successful save triggers), typed a quantity,
waited past the 2s debounce so the PUT dispatched and was genuinely in flight, and clicked Save in
the same continuous script (eliminating any risk from inter-tool-call latency, which the first two
attempts at this test fell into — documented as a live lesson, not hidden):

```
qty set, debounce running          t=+0ms
PUT dispatched                     t=+2997ms
Save clicked                       t=+2997ms   (same instant — the PUT is genuinely in flight)
PUT's 6s delay elapsed             t=+9997ms
PUT real request resolved          t=+10024ms
POST /api/orders dispatched        t=+10025ms  (1ms after the PUT resolved — NOT 3ms after Save was clicked)
```

`POST /api/orders` did not fire until 1ms after the in-flight PUT actually resolved — roughly 7
seconds after the Save button was clicked — conclusively demonstrating the await. The resulting
order (`orderNumber` 1008 in that run) was created correctly, and `GET /api/order-drafts`
afterward showed `payload: null` (or no row), never a resurrected draft; reloading `/orders/new`
showed no stale "Resume?" banner.

### 2. Create-time warnings shown visibly (owner ruling applied, HANDOFF issue #4 heritage)

`handleSave` now branches on `result.warnings.length`: zero warnings keeps the immediate
`router.push` (unchanged); non-empty warnings instead call `setSavedOrder({ id, orderNumber,
warnings })`, and the render swaps the entire form for a success panel — "Order #N saved." + the
warnings list + a "Go to order" button that navigates on click. `savedRef.current = true` is set
before this branch either way, so the (now longer-lived) mounted component never autosaves again.
`submitOnce`'s return type was widened to carry `orderNumber` (the server already returns it via
`OrderDetail`; only the client's narrow type declaration needed widening).

**Verified both branches live**: a customer on credit hold (`creditHold: true`) produced "Order
#1003 saved." with "T13FIXA · T13 Fix Round Credit Hold Co is on credit hold" listed, the URL
staying on `/orders/new` the whole time; clicking "Go to order" then navigated to `/orders/[id]`
(404, expected — Task 14 unbuilt). A second customer with `creditHold: false` and no
serialization-required parts produced zero warnings and navigated immediately, exactly as before
— confirming the ruling only changes behavior for the case it's meant to change.

### 3. Duplicate serials now gate Save

`findDuplicateSerials` (already used for the live inline warning) is exported from
`OrderLineCard.tsx` and reused inside `page.tsx`'s `validate()`, per line, alongside the existing
qty/weight checks — `${label}: serial "X" is entered twice.` **Verified**: keying the same serial
twice on a line and clicking Save produced exactly that message with no `POST /api/orders` in the
network log; the second, unaffected line remained untouched.

### 4. Picker shows step-status up front (spec §11, closed properly rather than downgraded)

**Server** (`erp/src/server/parts.ts`): `PartRow` gains `hasProcessSteps: boolean`. A new
`hasProcessStepsByPart(partIds)` helper runs **one additional query for the whole list** (not
N+1) — every `PartProcessRevision` row for the given parts, ordered `[partId asc, revisionNumber
desc]` so the first row seen per part is that part's *current* revision, `_count.steps > 0`
decides the flag. `listParts` and `getPart` both call it (`getPart` with a one-element array) so
the two paths can never disagree. Added `tests/parts.test.ts`: three parts — no revision, a
revision with zero steps, and a part whose revision 1 had a step but current revision 2 does not
— all correctly read `false`; adding a step to revision 2 flips it to `true`; `getPart` asserted
to agree with `listParts`. 12/12 `tests/parts.test.ts`, plus `parts-routes`/`parts-paste-export`/
`part-blockers` re-run clean (paste/export are unaffected — they use an explicit column list, not
`PartRow`'s full shape).

**Client**: `PartOption` gains `hasProcessSteps`; `Combobox`'s `ComboboxOption` gains optional
`disabled`/`disabledReason` (a per-option state, distinct from the whole-control `disabled` prop —
§5.16's "say why, never hide" applied to a single choice); the dropdown option button carries the
native `disabled` attribute (blocks the mouse path structurally) plus a `commit()`-level guard
(closes the keyboard/Enter path, which doesn't go through the button element). `OrderLineCard`
sets `disabled: isLead && !p.hasProcessSteps` — riders are never gated. The lazy post-pick
validation (`checkLead` fetching the revision detail) is unchanged and still runs — it is what
renders the "Rev N — locks at save" preview content the upfront flag alone can't provide, and it
remains the authority for any staleness between the list fetch and the actual pick.

**Verified live**: a part with no process-step revision showed, in the LEAD picker only, grayed
out with `disabled: true`, `title: "No process steps"`, and the label suffixed
"— No process steps"; dispatching a `mousedown` directly at that disabled button left the field
unselected (confirming the native `disabled` attribute blocks it, not just styling). The identical
part, added as a second (rider) line, showed `disabled: false` with no special styling and was
selected normally.

### Minors

- **Non-empty → empty now issues a real DELETE**, not silence. Added `hasEverBeenNonEmpty` ref:
  the autosave effect only skips entirely when the draft has *never* held content (still true);
  once it has, a return to `isDraftEmpty` sends `DELETE /api/order-drafts` instead of doing
  nothing. Note on reachability: the customer and part Comboboxes have no "unpick" affordance (an
  `onSelect` always supplies a real id), so `customerId`/a line's `partId`, once set, cannot revert
  to `null` through the UI — meaning the transition is unreachable via those two fields
  specifically. It **is** reachable via every other field (notes, VS#, dates, containers, charges,
  serials, qty) before a customer/part is ever picked. **Verified** exactly that path: typed into
  Notes with no customer picked (PUT fired), cleared Notes back to `""` (DELETE fired — confirmed
  via a request-method log, not inferred), and `GET /api/order-drafts` afterward showed
  `payload: null`.
- **Line weight now sent as the same trimmed-string wire shape as every other decimal field**
  (containers' tare/gross, charges' amount) regardless of whether it's the user's override or the
  computed value — `String(computeLineWeight(...) ?? 0)` on the computed branch, matching the
  override branch's already-trimmed string.
- Skipped per the coordinator's instruction: loadError append-only (existing precedent), ARIA
  semantics (backlog).

### Gates and cleanup

`npx tsc --noEmit`, `npx eslint src tests`, `npm test` (now **872**/872, 72 files — the one new
`hasProcessSteps` test), `npm run build` — all green, run twice (once after the code changes,
once more after the full re-smoke pass below confirmed nothing needed further adjustment).

Re-smoke covered, all against fresh fixtures created directly in the **dev** DB (`T13FIXA`
credit-hold-on with an orderable + a steps-less part, `T13FIXB` clean): the disabled-lead-picker
rendering, the save-with-warnings interstitial (both the panel and the "Go to order" navigation),
the save-without-warnings immediate navigate, the awaited-autosave sequence (network-delay
simulated via `fetch` patching, proven with timestamps above), the duplicate-serial Save gate, and
the non-empty→empty DELETE transition. All fixtures (2 customers, 3 parts, 1 process step code,
and every order created during testing — 6 total across both customers) hard-deleted afterward via
exact-key scripts; confirmed zero rows matching `T13%` remain in any of `Customer`,
`ProcessStepCode`, or `ContainerType`. Scratch scripts removed from the working tree before
committing.

### Files touched this round

- `erp/src/app/orders/new/page.tsx` — awaited/single-flight-queued autosave, `savedRef`,
  `hasEverBeenNonEmpty` + DELETE-on-transition, duplicate-serial validation, weight wire-shape fix,
  `orderNumber` in the submit response type, `savedOrder` state + success-panel render branch.
- `erp/src/app/orders/new/OrderLineCard.tsx` — exported `findDuplicateSerials`; lead-only
  `disabled`/`disabledReason` on part options; the "not in catalog" comment block reflowed (no
  behavior change).
- `erp/src/app/orders/new/Combobox.tsx` — `disabled`/`disabledReason` per option, both the native
  attribute and the `commit()` guard.
- `erp/src/server/parts.ts` — `hasProcessSteps` on `PartRow`, `hasProcessStepsByPart` batched
  helper, wired through `listParts`/`getPart`.
- `erp/tests/parts.test.ts` — new test for `hasProcessSteps` (both states, batched, `getPart`
  agreement).
