# Task 14b report — Shipment creation flow (`/shipping/new`)

**Status: DONE** · Branch `phase-4-certs-shipping` · BASE e8869dd
**Commits:** `a78c1a2` (server seam + tests), `2967163` (shared grids + create page + list entry point).
(An unrelated docs-only commit `de7d3d4` from the parallel lane interleaved between them — verified `--stat`: progress.md + spec only, no code.)

## What was built, per brief step

**Step 1 — Customer first, then everything downstream.**
`erp/src/app/shipping/new/page.tsx` (thin shell, the `/shipping` page precedent) and
`erp/src/app/shipping/new/NewShipment.tsx` (the whole screen). Customer picker (plain select over
`GET /api/customers`, which already carries `creditHold` and `shippingNotes`); picking a customer
fetches their live SHIP_TO addresses (`/api/customers/[id]/addresses`, kind-filtered — the edit
page's exact derivation) and their order candidates (`/api/orders?customerId=…&status=OPEN,PARTIAL_SHIPPED`,
minus already-selected — the edit page's add-order picker precedent), both `useLatest`-gated
against a fast customer switch. Switching customer resets orders/ship-to/override-reason. Header
carries the edit page's full field set: ship date (defaults today via `business-days`), carrier
(`/api/picklists/carrier`), route, comments, and the freight block (bill/amount/terms/class/
description/package count/pro no/SCAC). The shipping list (`ShippingList.tsx`) gained the **New
Shipment** button — the orders board's New Order precedent, §5.16 disabled-with-title.

**Step 2 — Grids prefilled to the remainder.** Adding an order fetches `GET /api/orders/[id]` once
and prefills all three grids: every line at `shipRemainder(ordered, shippedToDate)` (src/lib/ship-remainder.ts),
every container at its order count, every serial in with print-on-shipper on — defaults, never caps.
The add pickers offer removed rows back, "Add all remaining" included. See "Reuse vs rebuild" and
"Shipped-to-date seam" below.

**Step 3 — Idempotency nonce.** `clientRequestId` is minted when the form mounts
(`useState(() => crypto.randomUUID())`) and rides every save. The body is built ONCE and handed to
`submitWithConflictRetry` (src/lib/idempotent-save.ts) by reference — the orders/new R4-finding-5
shape — so the automatic 409 retry carries the same nonce. Verified over HTTP (below): a second
POST with the same nonce returned the same shipment id/number with `deduped: true`.

**Step 4 — Credit-hold gate.** Client-side, the moment a held customer is picked: a red banner
naming `CODE · Name` **with a link to `/customers/[id]`**. An actor holding `override_credit_hold`
gets the required-reason input ("kept in the audit history — printed nowhere"); saving with a blank
reason is refused client-side, and the trimmed reason is sent as `creditHoldReason` (the service
re-enforces both halves — shippers.ts:444-453). An actor WITHOUT it sees the refusal, a line naming
the missing action, **no reason field**, and a disabled Save whose `title` is
"`CODE · Name` is on credit hold — saving requires the override_credit_hold action" (§5.16, no
dead-end controls). The server's own 400 refusal string is rendered through `ErrorText`, which
turns its `see /customers/<id> to lift it` tail into a real link, so even a stale-client refusal
arrives named and linked.

**Step 5 — §5.7 warnings on the result.** A save that succeeds WITH warnings stops on a
"Packing List N saved." panel listing them, with a "Go to shipment" button (the orders/new
`savedOrder` precedent — visibly, never silently); zero warnings (and the `deduped` replay)
navigate straight to `/shipping/[id]`.

## The shipped-to-date seam (chosen and why)

**Chosen: widen `GET /api/orders/[id]` (`OrderDetail`) with `orderLineShippedToDate`** — the same
name and dense per-line shape `ShipperOrderDetail` carries on the shipper GET (Task 14 fix round
efde514), computed by ONE extra `shippedTotals` call in `readDetail` (src/server/orders.ts) — the
single §5.1 derivation, no second arithmetic. Reasoning:

- The create page already fetches each selected order's detail for its line/container/serial
  catalog — the ledger riding that same GET means the figure is exactly as fresh as the catalog it
  prices, refetched per order-add, with the server's own §5.7 warning remaining the save-time
  authority (the identical freshness contract the edit page has with its shipper GET).
- `GET /api/orders/[id]/shipments` was examined and rejected: it returns `ShipperRow[]` —
  per-shipment totals, not per-line — and its row shape is shared with the `/api/shippers` list,
  so widening it would deform a list DTO for one consumer.
- A brand-new route would sit outside spec §9's table and need adjudication; widening an existing
  payload follows the efde514 precedent exactly, so **no adjudication is requested — no new route
  was added and §9 is unchanged.** (Flagging for the reviewer anyway: `OrderDetail` is returned by
  every order mutation's tail, so every order mutation now pays one extra indexed
  `shipperLine.findMany`. Judged acceptable; called out as a concern below.)
- Type reuse: `orders.ts` imports `OrderLineShippedToDate` from `shippers.ts` **type-only** —
  erased at runtime, adding nothing to the documented `orders.ts ⇄ shippers.ts` cycle.

## Reuse vs rebuild (honest accounting)

- **Shared (extracted): the three grid VIEWS** — markup, add-picker (with its transient pick
  state), and the candidate prefill arithmetic — moved from `[id]/ShipmentOrderPanel.tsx` into
  **`erp/src/app/shipping/ShipmentGrids.tsx`** (`LinesGridView`/`ContainersGridView`/
  `SerialsGridView` + `prefillLineRow`/`prefillContainerRow`/`prefillSerialRow`). Both pages render
  these; a fix here is both pages' fix. The edit page passes its per-grid Save button through the
  `footer` slot; the create page passes none.
- **Kept per-page: persistence.** The edit page keeps `useBulkGrid` + the bulk-PUT `save()`
  functions in `ShipmentOrderPanel.tsx`, unchanged in behaviour (verified in-browser: an edit-page
  "Save lines" still PUTs and clears the over-ship warning).
- **Deviation, disclosed: the create page does NOT use `useBulkGrid`.** The brief's Step 2 says
  "reusing useBulkGrid"; the hook is an overlay-over-SERVER-rows model, and the create page has no
  server rows and a variable number of orders × 3 grids — hooks cannot be called in a loop, so
  per-child hook state would be unreachable by the single atomic POST without ref-collection
  plumbing. Rows are parent-owned plain state instead (the orders/new `OrderDraftState` model, the
  brief's own named precedent for this screen), with all rows `isNew` and the same string-valued
  `Fields` shapes the hook uses. The orphan-churn machinery the hook exists for has no server churn
  to detect here.
- **No draft autosave** — order drafts are a spec-authorized audit exception scoped to orders;
  this phase adds no new audit exceptions, and an abandoned create form allocates nothing.

## Sibling-group enumeration

The lines/containers/serials grid group now has **one rendering copy per grid**, consumed from two
places:

| Grid | Single view copy | Consumers |
|---|---|---|
| Lines | `shipping/ShipmentGrids.tsx` `LinesGridView` | `[id]/ShipmentOrderPanel.tsx` (`LinesGrid`: useBulkGrid + PUT), `new/NewShipment.tsx` (parent rows) |
| Containers | `ContainersGridView` | same two |
| Serials | `SerialsGridView` | same two |

Residual per-page siblings a future fix must land on together: the **save-time validation** of the
lines/containers payloads exists twice — edit page (`ShipmentOrderPanel` `save()`s) and create page
(`NewShipment` `validate()`), same messages by construction. The structural notes for why
containers/serials have no remainder arithmetic moved into the shared file with the grids.

## TDD evidence

RED (`a78c1a2`'s tests before the implementation):
```
$ npx vitest run tests/shippers.test.ts -t "prefill seam"
 Test Files  1 failed (1)
      Tests  2 failed | 22 skipped (24)   # TypeError: …orderLineShippedToDate is undefined
```
GREEN (after widening `OrderDetail`/`readDetail`):
```
$ npx vitest run tests/shippers.test.ts
 Test Files  1 passed (1) / Tests  24 passed (24)
$ npx vitest run tests/orders.test.ts tests/order-routes.test.ts tests/order-loads.test.ts tests/order-ship-invariants.test.ts
 Test Files  4 passed (4) / Tests  188 passed (188)
```
New tests (tests/shippers.test.ts, "getOrder shipped-to-date (the /shipping/new prefill seam)"):
dense ledger with a real 0/0 for a never-shipped line; sums every live shipment; voided shipments
excluded. The UI itself has no component-test harness in this codebase (vitest is node-env); the
browser verification below is the UI's evidence, per the brief.

## Gates (all run from `erp/`, after the last code change; only docs commits followed)

```
npm test            → Test Files 93 passed (93) / Tests 1288 passed (1288)
npx tsc --noEmit    → clean
npx eslint src tests→ clean
npm run build       → ✓, route table shows ○ /shipping/new
```

## Browser account (dev server, dev DB `erp`, Playwright-driven real Chromium)

Fixtures (all distinctly named, created via the app's own APIs; part steps via SQL in the tests'
fixture shape): customer `T14BHOLD · Task 14b Credit Hold Fixture` (creditHold=true) + SHIP_TO
address; part `T14B-P1` with a process step; order `#1001 · PO T14B-PO-1` (10 pcs / 25 lbs); role
"T14b Shipping Clerk (no override)" with shipping.view/create/edit + orders.view + customers.view
but **not** `override_credit_hold`; user `t14bclerk`.

**Refused (as t14bclerk):** `/shipping/new` → picked the held customer → red banner
"T14BHOLD · Task 14b Credit Hold Fixture is on credit hold — *see their record*" (link verified to
`/customers/cmsgx3j1s…`), plus "Saving a shipment for them requires the override_credit_hold
action." **No reason field rendered.** Save button asserted via DOM:
`{disabled: true, title: "T14BHOLD · Task 14b Credit Hold Fixture is on credit hold — saving
requires the override_credit_hold action"}`. Screenshot: `.superpowers/sdd/evidence/t14b-credit-hold-refused.png`.

**Overridden (as admin, who holds the action):** same customer → banner now carries the required
reason input. Added order #1001 — lines grid prefilled 10/25 with shipped-to-date "0 / 0 lbs";
containers/serials empty with honest empty-states; add-order picker correctly said "No unshipped
orders" once selected. Set 4/10, picked the ship-to, clicked Save with a **blank reason** → "A
reason is required to override the credit hold." Filled the reason → saved, navigated to
`/shipping/cmsgx8vyu…` ("Packing List 1000"). Audit verified over the API: the shipper's create
entry contains `creditHoldOverrideReason` with the typed reason.

**Remainder + warnings (second shipment):** `/shipping/new` again, same order — prefill asserted
via DOM: `{prefillQty: "6", prefillWeight: "15", shippedCell: "4 / 10 lbs", orderedCell: "10 / 25 lbs"}`
(screenshot `t14b-remainder-prefill.png`). Overrode to 7/20 → save succeeded and STOPPED on the
warnings panel: "Packing List 1001 saved. / Order #1001 line 1 (T14B-P1): shipping 7 / 20 lbs
exceeds the remaining 6 / 15 lbs on this line" (screenshot `t14b-warnings-panel.png`), then "Go to
shipment" navigated to the edit page — where the refactored shared grids rendered with their Save
buttons and the same warning; editing the line back to 6/15 and clicking "Save lines" PUT
successfully and cleared the warning (ledger read 10/25 after).

**Idempotency over HTTP:** two identical POSTs with `clientRequestId: "t14b-nonce-verify-1"` →
first `{id: cmsgxbm4v…, shipperNumber: 1002, deduped: false}`, second the SAME id/number with
`deduped: true`.

**Cleanup:** the whole fixture graph (3 shipments, order, part+process rows, customer+address,
clerk user+role+sessions, and every related AuditLog row) hard-deleted from the dev DB in one
transaction; verified zero rows remain (`Shipper` count 0, no `cmsgx…`/T14b audit rows). The dev
`shipper_number_next` counter advanced 1000→1003; left alone (numbers are never reused by design).

## Concerns

1. **`readDetail` cost:** every order mutation's returned detail now runs one extra
   `shipperLine.findMany` over the order's line ids. Indexed and small, and it buys one-derivation
   freshness, but it is a per-mutation cost the reviewer should consciously accept.
2. **The create page's grid inputs gate on `shipping.create`** (the page's own save permission) —
   the edit page's gate is `shipping.edit`. Deliberate: a viewer who cannot create has every
   control disabled with the title naming `shipping.create`.
3. **Serials prefill = ALL order serials** (print-on-shipper on). "Remainder" for a set-membership
   row would ideally exclude serials shipped on earlier live shipments, but that fact is not in
   any client-readable payload today (the edit page has the same limitation, noted in its own
   sibling-split comment). Operator removes rows; over-inclusion is visible, never silent.
4. **`useBulkGrid` not used on the create page** — disclosed deviation from the brief's Step 2
   wording, argued above; the brief's own escape hatch ("build the create-page variant honestly
   and say so") is what this leans on, with the sibling markup genuinely shared instead.
5. Browser evidence PNGs live in `.superpowers/sdd/evidence/` (untracked, like the lane-B
   screenshots at the repo root); not committed — say the word if they should be.
