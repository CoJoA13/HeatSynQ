# Task 14 report — Order hub UI

**Status: complete.** All four quality gates green; extensive dev-server smoke test executed
against real fixtures created and fully cleaned from the `erp` dev DB afterward.

## Files

- Created `erp/src/app/orders/[id]/page.tsx` (521 lines) — remount wrapper, shared types
  (`OrderDetail`/`OrderLine`/`OrderContainer`/`OrderSerial`/`OrderLoad`/`OrderCharge`/
  `OrderMutationResult`/`PartOption`), mount-time fetches, the optimistic-PATCH `saveOrder()` for
  Overview + Notes, void/link/unlink actions, and the Overview/Notes/Attachments/Documents/History
  sections inline.
- Created six colocated section components (decomposition beyond the brief's literal
  "Create: page.tsx" — the task explicitly invited this and asked the split be noted):
  - `LinesSection.tsx` (240 lines) — lead badge, per-field qty/weight edit, rider add/remove.
  - `ProcessSection.tsx` (86 lines) — read-only locked-revision render.
  - `ContainersSection.tsx` (152 lines), `ChargesSection.tsx` (93 lines),
    `LoadsSection.tsx` (159 lines) — bulk-edit grids on `src/lib/bulk-grid.ts`.
  - `SerialsSection.tsx` (172 lines) — one sub-grid per line (`LineSerialsEditor`), each its own
    `useBulkGrid` instance.
- Created `erp/src/lib/bulk-grid.ts` (109 lines) — shared generic hook for the four bulk-array
  grids: composes server rows + a touched-only edits overlay + locally-added rows + removed-id
  set at render time, the 2C-3 "keep only what the user typed" lesson generalized from
  `step-drafts.ts`'s per-field shape to arrays with add/remove.

No changes to `src/components/Shell.tsx` — the hub is reached from the board row click and global
search, exactly as the brief predicted; no nav entry needed.

## Context findings / choices made (per the brief's explicit asks)

- **Mutation response shapes.** Verified route-by-route: `PATCH /api/orders/[id]`,
  `POST`/`PATCH .../lines[/[lineId]]`, `PUT .../loads`, `POST .../loads/resplit` all return
  `{ order, warnings }`; `DELETE .../lines/[lineId]`, `PUT .../containers`, `PUT .../serials`,
  `PUT .../charges`, `POST .../link`, `POST .../unlink` return the bare `OrderDetail`.
  `unwrapMutation()` (page.tsx) is the one place this is resolved. An endpoint with no `warnings`
  key **clears** the amber banner rather than leaving a stale claim from a previous mutation on
  screen — noted in the code comment.
- **Link resolves an order NUMBER via `GET /api/orders?search=<n>&customerId=<id>`**, filtering the
  result to an exact `orderNumber` match excluding the current order — chosen over
  `/api/search` (which returns `exactOrderId` but has no customer scope, so it would need a
  *second* round trip to check the match's customer). One call does both. Documented inline.
- **`Combobox` and `computeLineWeight`/`findDuplicateSerials` imported directly from
  `src/app/orders/new/`** (Combobox.tsx / OrderLineCard.tsx) rather than lifted to
  `src/components/`. The brief sanctioned either; importing was lower-risk (no file move, no
  chance of disturbing Task 13's already-reviewed code) and the brief's own "fine to import
  across the orders/ folder" covers it.
- **Voided-reason banner**: fetches `/api/admin/audit?entity=order&entityId=<id>` (the same route
  `HistoryPanel` uses, gated `admin.view`) and reads `entries[0]` — safe because a voided order can
  never be mutated again, so the delete entry is always the most recent one when readable. Falls
  back to the brief's exact copy, `"Voided — see History for the reason"`, when `admin.view` is
  absent, the fetch fails, or (defensively) the latest entry isn't a delete. Verified both branches
  live (see smoke test).
- **Documents placeholder** uses the task prompt's literal copy, `"No documents yet — traveler
  printing arrives shortly"` (the roadmap plan's own text is shorter; the direct task instructions
  are more specific and used verbatim).
- **Serialization warning heritage**: `OrderLineDetail.part` carries no `serializationRequired`
  flag, so `SerialsSection` cross-references the customer's parts list (`GET
  /api/parts?includeInactive=1`, filtered client-side to the order's customer — the entry page's
  own no-customerId-filter workaround) fetched once by the parent and passed down as
  `partsById`. The warning is **live** (computed from the in-progress local edit count, not the
  last-saved `serials` prop), matching the entry page's identical UX. This is advisory only —
  no hub mutation endpoint re-derives `buildWarnings`' serialization check server-side outside
  `createOrder`, exactly as the services are built.
- **Lines' qty/weight edits are per-field onBlur-saves, not the bulk-grid overlay pattern** — there
  is no array-shaped endpoint here (`PATCH lines/[lineId]` is one field at a time), so a small local
  `Map<lineId, {qty?,weight?}>` (touched fields only) is enough. On failure the typed value is
  **kept** (not rolled back) so the user can see and fix it — nothing shared (`order` state) was
  ever optimistically mutated for these two fields, unlike Overview/Notes' `saveOrder()`, so there
  is nothing to roll back; §5.13 is honored by construction rather than by an explicit reload.

## Self-review findings fixed before smoke testing

- **`voidAction` originally wrapped the DELETE and the follow-up reload in one try/catch.** DELETE
  returns `{ok:true}`, not a fresh `OrderDetail`, so picking up `voided:true` needs a `load()`
  after — and if *that* fails, the void itself still succeeded. Split into two try/catches (the
  `customers/[id]/page.tsx` `call()` precedent), so a refresh failure reports "Order voided, but
  the page could not be refreshed…" instead of misrepresenting a successful void as a failure.

## Dev-server smoke test (concrete narrative)

Fixtures (customer `T14SMOKE`, container type `T14 Tote`, step code `T14-STEP`, lead part
`T14LEAD1` — `eachWeight` 10, `loadQty` 3, one locked-ready revision/step — rider part
`T14RIDER1` — `eachWeight` 5, `serializationRequired: true`) created directly via Prisma against
the **dev** DB (`erp`), matching the Task 13 precedent. Two real orders created **through the
actual `/orders/new` entry page** (not hand-crafted), driven via `javascript_tool` dispatching
real DOM events — `computer.left_click`/`type` proved unreliable in this session too (Task 13's
own documented quirk), so every interaction went through direct DOM event dispatch.

**Order #1009** (lead qty 10 → auto-split 3/3/3/1, weights 30/30/30/10 lbs, exact):
- Overview: PO prefilled from customer `defaultPo`, request date computed correctly
  (2026-08-03 + business days), status/light shown ("On target · Open"). Edited PO via
  onBlur-save → persisted server-side (`GET` confirms). Edited received/request/target dates via
  onChange → persisted. Edited Notes textarea → persisted, alongside the customer's standing
  order-notes displayed read-only.
- Lines: added rider `T14RIDER1` qty 20 (weight auto-computed 100 = 20×5) → **first amber warning
  fired**: *"Loads no longer sum to the order — re-split or edit loads."* Edited the lead's qty
  (10→15, then weight 100→155.50) via onBlur-save, both persisted; a client-side-rejected qty of
  `0` produced *"Lead: quantity must be a whole number of at least 1."* with **no** network call.
  Removed the rider line with `confirm()` → back to 1 line, verified via `GET`.
- Process: rendered "Rev 1 · locked at order save" + the exact fixture step text, read-only.
- Serials: the rider line showed *"Serialization required — no serials entered yet"*; typing
  `EC{001-003}` expanded to 3 rows and the warning **cleared live** before Save; Save persisted
  `EC001`/`EC002`/`EC003` (`GET` confirms, keyed to the correct `lineId`).
- Containers: added Type=`T14 Tote`, count 5, tare 10, gross 60 → **Net: 50** shown live; Save
  persisted exactly those values.
- Charges: added "T14 rush surcharge" / 42.50 and a second row with a **blank amount** → persisted
  as `amount: 42.5` and `amount: null` respectively (the "needs price" contract, spec §7.5.3).
- Loads: **Re-split** after the rider add recomputed 10×(qty 3, weight 20) exactly (30 qty / 200 lb
  total) and cleared the mismatch warning. Inserted a `StoredDocument` row directly (simulating a
  Task-16-unbuilt traveler print) and edited a load's weight → **both amber warnings rendered
  together**: *"Loads no longer sum…"* + *"A traveler has already printed — print a fresh one."*
  Re-split again cleared only the sum warning, leaving the traveler-printed one (correct — a
  resplit can't un-print a stored document). Removed a load row (creating a numbering gap:
  1,3,4…10), clicked **Renumber** (→ 1,2,3…9 locally), clicked **Save loads** → persisted as
  1..9 exactly.
- Attachments: uploaded a real file via a `DataTransfer`-injected `<input type="file">` change
  event → listed correctly.
- History: after a reload (HistoryPanel doesn't self-refresh on an unrelated mutation — a
  pre-existing, universal characteristic of the shared component, not new here), showed every
  audit entry with real diffs (`linkGroupId` transitions, the create entry).

**Order #1010** (second order, same customer) — created to test linking:
- **Link**: typed `1010` into #1009's Link box → resolved via the board-query endpoint, POSTed,
  `#1010` appeared in #1009's Linked-orders panel. Navigating to #1010 directly (fresh page load)
  showed the reciprocal `#1009` — confirms both the link and **remount-per-id** (no state leaked
  between the two order ids across navigation).
- **Unlink**: clicked Unlink on #1010 → both #1010 and #1009 (separately reloaded) correctly show
  "Not linked to any other orders."
- **Void**: uploaded an attachment first, then voided with reason "T14 smoke test: voiding scratch
  order on purpose". Verified via a full-page DOM sweep: **zero** non-disabled/non-read-only
  inputs and **zero** enabled buttons anywhere in `<main>`; Void button itself now disabled,
  title "Already voided"; red banner read exactly `"Voided — T14 smoke test: voiding scratch order
  on purpose"` (the real reason, since the viewing user held `admin.view`). **Attachments stayed
  readable** — the uploaded file was still listed — while its Delete button and the upload input
  were disabled. History (after reload) showed the `delete` entry with the same reason string.

**Permission gating (§5.16)**, a second user (`t14restricted`, role holding only `orders.view`) in
a separate tab: on live order #1009, the full-page sweep again found **zero** enabled controls and
**zero** editable fields; Void button title "Requires void_order"; Process section rendered
"Requires processes.view." instead of attempting a fetch; rider-add Combobox disabled with title
"Requires parts.view"; customer name/standing-notes correctly absent (fetch skipped, not attempted
and failed); Notes/PO text remained **readable** (read-only, not hidden); History showed "History
unavailable (you may not have permission to view it)."; Attachments list still worked (`orders.view`
suffices for reads). On voided order #1010, the same restricted user saw the fallback copy
`"Voided — see History for the reason"` (no `admin.view`) and the attachment stayed listed.

**A test-environment lesson worth flagging for whoever runs the next task's smoke test:**
`computer.left_click` was unreliable here too (Task 13's own note held), and — new — **React's
synthetic `onFocus`/`onBlur` only fire from a manually-dispatched `focusin`/`focusout` event, not
from `focus`/`blur`** (even with `bubbles:true` forced, and even though a real `.focus()`/`.blur()`
DOM method call works *when the pane happens to have `document.hasFocus()`*, which is inconsistent
in this headless/background-pane environment). `focusin`/`focusout` worked reliably regardless of
document focus state and is what every onBlur-save test above ultimately used. Separately: **two
browser tabs on this session share one cookie jar** — logging into the second tab as the
restricted user silently logged the first tab's admin session out too; discovered when a
"disabled" button turned out to genuinely be disabled because the acting session had changed
underneath the test, not a code bug. Re-authenticating per tab before each block of test resolved
it.

All fixtures (2 orders + full children, 2 parts + revision/step, 1 customer, 1 container type, 1
step code, 1 restricted role + user + its session) were hard-deleted from the dev DB by exact id
afterward; a final sweep confirms zero rows matching any `T14` key remain, and the two pre-existing
unrelated orders (`ZZTEST`/`ZZFIX2`, from an earlier, out-of-scope session) are untouched.

## Gates

`npx tsc --noEmit`, `npx eslint src tests`, `npm test` (872/872, 72 files — no new tests; task
explicitly has no UI unit harness), `npm run build` — all green, run a final time after the
smoke-test-driven fix (the `voidAction` try/catch split) and after removing temporary debug
logging added mid-investigation.

## Self-review against the task's checklist

- **Every section present**: Overview, Lines, Process, Containers, Serials, Charges, Loads, Notes,
  Attachments, Documents, History — all rendered and exercised live, in the contract's order.
- **Grids hold only user edits composed with server state**: `src/lib/bulk-grid.ts`'s `compose()`
  is the one place server rows + edits + additions + removals are merged, called fresh at every
  render from Containers/Charges/Loads/Serials; Lines' qty/weight uses an analogous touched-only
  map. Verified live that an unrelated section's mutation (e.g. saving Notes) never disturbed
  another section's in-progress, unsaved grid edits (nothing forces a cross-section reset except
  each grid's own successful Save).
- **§5.16 throughout**: verified exhaustively with a fully-restricted live user — see above.
- **§5.13 throughout**: `saveOrder()` (Overview/Notes) rolls back via `load()` before setting the
  error; `voidAction` now does the same two-step split; the non-optimistic actions (void/link/
  unlink/add/remove/every bulk PUT) never mutate shared state before the request settles, so there
  is nothing to roll back on their failure paths.
- **Voided fully read-only incl. attachments canEdit**: verified live, zero exceptions across every
  input/select/textarea/button in `<main>`; `AttachmentsSection`'s `canEdit = orders.edit &&
  !voided` (the brief's exact formula).
- **No server imports**: `grep -rn "@/server\|prisma/generated"` across every new file returns
  nothing.
- **Remount per id**: `key={id}` on the exported page component (customers/parts precedent);
  verified live navigating #1009 → #1010 → #1009, each showing correct fresh data with no leakage.

## Concerns / carried forward

- `AttachmentsSection`'s disabled-tooltip is a fixed `"Requires {area}.edit"` regardless of *why*
  `canEdit` is false — on a voided order where the viewer actually holds `orders.edit`, the tooltip
  is technically misleading (they're blocked by voided status, not the permission it names). This
  is a pre-existing property of the shared Task 11 component, not something this task's `canEdit`
  formula (given verbatim by the brief) can change without widening scope into that shared
  component's own logic; noted rather than fixed.
- The "Reset to computed" button on the add-rider weight field (reusing `computeLineWeight`'s
  override affordance) was not individually clicked during the smoke test — the underlying function
  and pattern are Task 13's own, already exhaustively tested there; only the new wiring around it
  was exercised (auto-fill on pick, override via typing).
- No new automated tests were written, per the task's own "no UI unit harness" instruction; the
  quality gates are tsc/eslint/build/existing-872-suite, all green.

## Commit

`feat: order hub page` on branch `phase-3-orders` (no attribution trailer, per project convention).

---

## Fix round 1

Coordinator review: one Important finding plus two minors. All addressed below.

### Important — concurrent same-array writes silently orphaned in-progress edits

**The bug.** `replaceContainers`/`replaceSerials`/`replaceCharges` are delete-then-recreate — every
row gets a fresh id on every save, by anyone. `useBulkGrid`'s `edits` map keys by server row id.
If actor B saved a change to the same array, and any OTHER mutation anywhere on the page (not
necessarily to this grid) then refreshed `order`, `compose()`'s `edits.get(r.id)` lookup would find
no match for any of THIS user's edited-but-unsaved row ids — the edit simply never reattached to
anything, and vanished with no trace. Loads is immune (`applyLoads` matches existing rows by array
position and updates them in place, so a Load's id survives a save) — confirmed by reading
`order-loads.ts` again; `LoadsSection.tsx` now has a comment explaining why it doesn't wire up the
fix.

**The fix** (`erp/src/lib/bulk-grid.ts`): `useBulkGrid` now tracks the last set of live row ids it
saw (`lastLiveIds`, `useState`) and a standing warning (`orphanWarning`, `useState`). A new
`detectOrphans`, called from inside `compose()` (the only place the hook ever sees a fresh
`serverRows`), compares the incoming row ids against the remembered set **by content, never by
reference**. When they differ **and** `edits` is non-empty, it clears exactly the edit entries
whose id no longer matches any current row and sets the warning — never reattaching a stale edit's
values to a *different* row by array position (that would be the 2C-3 masked-edit bug in reverse).
`added` (keyed by client id, cannot orphan) and `removedIds` (a removal intent against an
already-gone row is moot, not lost data) are untouched, per the review's own scoping.

This uses react.dev's own documented "adjust state when a prop changes" technique — comparing a
value against a remembered previous one and conditionally calling `setState` **during render**
(never inside an effect) — which is exactly why `lastLiveIds`/`orphanWarning` are `useState`, not
`useRef`: the docs are explicit that the remembered value must be state, since a ref written during
render is invisible to React's own bookkeeping and is the specific thing StrictMode's deliberate
double-render exists to catch. React discards the render where the mismatch is first detected and
immediately reruns the component with the newly-cleared `edits` and the newly-set `orphanWarning`,
so the only render that ever commits already shows fresh server truth **and** the warning together
— never a frame with the about-to-vanish edit and no warning yet, and never a silent disappearance.

`ContainersSection.tsx`, `ChargesSection.tsx`, and `SerialsSection.tsx`'s `LineSerialsEditor` each
now render `{grid.orphanWarning && <p className="... bg-amber-50 ...">{grid.orphanWarning}</p>}`
directly under their heading, in the same amber styling as every other warning/notice on the page.
`reset()` (called after a successful Save) now also clears `orphanWarning` — a fresh, successful
save of the user's own edits supersedes the stale notice.

**Verified live** with two tabs, same admin session (fixtures: customer `T14ORPHAN`, part
`T14OLEAD1`, container type `T14O Tote`, one order with one container row, count 3):
1. Tab A: changed the container's count to `99`, left it unsaved.
2. Tab B (same order): changed the same container's count to `7`, clicked **Save containers** —
   confirmed via `GET` the row got a brand-new id (`...w6l2...` vs the original `...c390...`).
3. Tab A: confirmed the field still showed the stale `99` (no refetch had happened yet in that
   tab). Then saved an unrelated field — **Notes** — which is exactly the "any other mutation"
   case the review named.
4. Tab A, immediately after: the Containers section showed **"This list changed on the server
   while you were editing — your unsaved changes here were set aside; please re-check."** and the
   count field showed **`7`** (Tab B's fresh value) — not `99`, and not blank. Confirmed via `GET`
   that Notes itself persisted correctly (the unrelated mutation used to trigger this wasn't a
   no-op).
5. Edited the container again in Tab A and saved — the warning banner disappeared (`reset()`
   clearing it), confirming it doesn't linger past its usefulness.

### Minors taken

- **`LinesSection.tsx`: "Reset to computed" button now gated** (`disabled={editGate.disabled ||
  !partsGate.allowed}`, `title={addTitle}`) — previously had neither, unlike every sibling control
  in the add-rider form. Verified live: the button now carries real `disabled`/`title` attributes
  (empty title as the fully-permitted admin, confirming the wiring is live rather than a no-op).
- **`LinesSection.tsx`: normalized `!editGate.allowed` → `editGate.disabled`** on the two
  per-line qty/weight inputs (the only two spots still using the negated form; every other control
  in the file already used `editGate.disabled`). Purely a spelling consistency fix — both forms
  were always equal in value (`Gate.disabled` is `!allowed` by construction in
  `src/lib/permission-ui.ts`), so no behavior change.

Left alone per the coordinator's explicit instruction: the Documents placeholder wording (came from
the dispatch itself); decimal-precision client-side checks and the `parts.view`-gated
serialization warning (ledgered for the final whole-branch review).

### Gates

`npx tsc --noEmit`, `npx eslint src tests`, `npm test` (872/872, 72 files — no new tests needed;
this fix is to existing UI-only logic with no server-side surface), `npm run build` — all green,
run twice (once right after the code changes, once more after the two-tab smoke test confirmed
nothing further needed adjusting). All fix-round fixtures (1 customer, 1 part + revision/step, 1
container type, 1 order + its container/line/load, matching audit rows) hard-deleted from the dev
DB by exact id afterward; a final sweep confirms zero rows matching any `T14` key remain.

### Files touched this round

- `erp/src/lib/bulk-grid.ts` — `lastLiveIds`/`orphanWarning` state, `detectOrphans`, `compose()`
  now calls it, `reset()` clears `orphanWarning` too.
- `erp/src/app/orders/[id]/ContainersSection.tsx`, `ChargesSection.tsx`, `SerialsSection.tsx` —
  render `grid.orphanWarning` as an amber banner.
- `erp/src/app/orders/[id]/LoadsSection.tsx` — comment only, explaining why it doesn't wire up
  `orphanWarning` (immune — `applyLoads` updates in place).
- `erp/src/app/orders/[id]/LinesSection.tsx` — the two minors.
