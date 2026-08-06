# Task 14 report — RECONSTRUCTED STAND-IN (2026-08-05)

> **This file was NOT written by Task 14's implementer.** The task landed as `e54684c` and was
> pushed, but the machine move was called before the implementer's report was committed; no
> report file exists anywhere in git history. This stand-in was assembled by the session
> controller from the only two records that survive: the commit message of `e54684c` and the
> progress ledger entries written at handoff time (`.superpowers/sdd/progress.md` lines 106–110).
> **Treat every claim below as unverified implementer assertion, not reviewed evidence.** Claims
> that cannot be checked from the diff (browser verification in particular) have no other
> corroboration.

## Status as recorded at handoff

- Landed as `e54684c feat(ui): shipment page with per-order ticket panels`, pushed,
  **deliberately never reviewed** — the machine move was called first.
- Ledger claims: 1279 tests, gates clean, browser-verified end to end (two-order shipment, both
  orders flipped to Shipped, void locked every control — checked `disabled` AND `readOnly`, not
  just `.disabled`).

## What the commit says it delivered

Shipment detail page (spec §11): header (customer, ship-to, ship date, carrier, route, comments,
freight block), one panel per order on the shipment with its lines/containers/serials grids on
`useBulkGrid`, Add order/Remove order, void with reason, stored-documents list, and
`HistoryPanel`. Print actions render disabled pending Tasks 18–19.

Also adds `GET /api/shippers/[id]/documents` — `listDocumentsForShipper` (Task 3) had no HTTP
caller before this page needed one.

Files (from `git show --stat e54684c`):
- `erp/src/app/api/shippers/[id]/documents/route.ts` (+21)
- `erp/src/app/shipping/[id]/ShipmentDetail.tsx` (+641)
- `erp/src/app/shipping/[id]/ShipmentOrderPanel.tsx` (+483)
- `erp/src/app/shipping/[id]/page.tsx` (+18)
- `erp/tests/shipper-routes.test.ts` (+34)

## Known open items the implementer itself raised (via the ledger)

1. **`GET /api/shippers/[id]/documents` is a route NOT in spec §9's table.** The implementer's
   rationale: Task 3 built `listDocumentsForShipper`, Task 11 built the ORDERS equivalent
   (`GET /api/orders/[id]/documents`), nothing ever exposed the shipment one, and the page needs
   it for its stored-documents list. Flagged for adjudication, not waved through.
2. **Plan hole (Task 14b, now in the plan):** no shipment creation flow exists anywhere in the
   20-task plan; the implementer refused to invent it unilaterally. Not a defect of this diff —
   recorded so the reviewer knows the create path is intentionally absent from this page.

---

# Task 14 — FIX ROUND 1 (2026-08-05)

Fixing **only** review Important #1 ("prefilled to the remainder" not implemented for the
partially-shipped case). Minors #2–#5 are deferred by instruction and were not touched.
Direction taken: implement the requirement, not seek ratification.

## What changed and why

The finding's real blocker was an input, not a rendering choice: shipped-to-date for a line **not
yet on this shipment** was knowable nowhere on the page. `ShipperOrderDetail.lines[]` only carries
the lines already on the shipment, and the add-line picker's candidates come from the order's own
catalog (`GET /api/orders/[id]`), which carries ordered qty/weight and nothing about shipping.

**Seam chosen: the shipment's own GET.** `readShipperDetail` (`erp/src/server/shippers.ts`) already
made exactly one `shippedTotals(db, orderLineIds)` call (Task 7's §5.1 derivation). That call's id
set is now widened from "the lines on this shipment" to "every line of every order on this
shipment", and the result is returned as a new `ShipperOrderDetail.orderLineShippedToDate[]` beside
`lines[]`. Same derivation, same single query, wider id set — no new endpoint, no second
`shippedTotals` call, and no change to `ship-ledger.ts` itself.

Rejected alternative: widening `OrderDetail.lines` in `orders.ts` (the catalog's source). It would
have put a ship-ledger read inside every order mutator's `readDetail` (Phase 3 blast radius), and
the per-order catalogs on this page are only refetched when the shipment's order-ID *set* changes —
so the figure could go stale after a line save. The shipper GET is refetched by `applyMutation` on
every mutation, so it cannot.

Why "all live shipments, this one included": that is §5.1's definition and matches
`ShipperLineDetail.shippedToDateQty`'s existing semantics (`shippers.ts` doc comment, and
`overshipWarnings` depends on it). For a *candidate* line — not on this shipment by definition —
the sum is exactly "what other shipments already took", which is what the remainder must subtract.

Client side (`ShipmentOrderPanel.tsx`, lines grid):
- new `prefill()` builds an added row as `shipRemainder(ordered, shippedToDate)` for both qty and
  weight; used by **both** `addPicked` and `addAllRemaining` (the second was the easier one to miss).
- the shipped-to-date column now renders a real number for a not-yet-saved row instead of `—`.
- the picker's option text names the figure the row will be prefilled with:
  `P-12 — ordered 10, remaining 6`.
- `shipRemainder` is a new pure client-safe module (`erp/src/lib/ship-remainder.ts`), not inline
  arithmetic, so the float case has a test: `25 − 12.1` is `12.899999999999999` in binary floating
  point and that string must never appear in an operator's input box. It floors at zero so an
  already-over-shipped line cannot prefill a negative the server's `min(0)` would reject.

**The §5.7 path is untouched.** Nothing was made a cap: the fields stay editable, the server still
accepts a larger figure, `overshipWarnings` is unchanged, and the post-save warning remains the
authority. This is a default only.

## Sibling-group enumeration (lines / containers / serials)

The rule's whole group is the three grids in `ShipmentOrderPanel.tsx`. Each is accounted for:

1. **Lines — CHANGED.** The ship ledger is defined per order line and only per order line (design
   §5.1, `shippedTotals(db, orderLineIds)`). This is where `ordered − shipped` exists at all.
2. **Containers — deliberately NOT changed, and it is not an oversight.** `ShipperContainer` records
   how many bins travelled on this shipment; there is no container ledger, aggregate, or
   "shipped-to-date" anywhere in the schema, the spec, or `ship-ledger.ts`, so `ordered − shipped`
   has no second operand to compute. A container row is not consumed across shipments the way a
   line's quantity is, so the order container's own `count` already *is* its remainder — the
   existing prefill was correct, not merely unfixed. Recorded as a `SIBLING-SPLIT NOTE` comment
   above the grid so the next reader does not have to re-derive it.
3. **Serials — deliberately NOT changed**, less ambiguously still: a serial has no quantity at all.
   Its only prefilled field is the `printOnShipper` boolean. Set-membership is its entire
   "remainder", and the `usedIds` filter every grid shares already handles that. Also recorded as a
   `SIBLING-SPLIT NOTE`.

The other shape shared across the three grids — the `patch/remove/addPicked/addAllRemaining/save`
skeleton and the disabled/title/aria patterns — was not modified, so nothing else needed mirroring.

## Files

- `erp/src/server/shippers.ts` — `OrderLineShippedToDate` type, `ShipperOrderDetail.orderLineShippedToDate`,
  `DETAIL_INCLUDE` nested `order.lines` select, `toDetail` dense mapping, widened `readShipperDetail` id set.
- `erp/src/lib/ship-remainder.ts` — NEW; `shipRemainder(ordered, shippedToDate)`.
- `erp/src/app/shipping/[id]/ShipmentDetail.tsx` — `OrderLineShipped` type mirror + field on `ShipperOrder`.
- `erp/src/app/shipping/[id]/ShipmentOrderPanel.tsx` — the lines-grid fix + the two sibling notes.
- `erp/tests/shippers.test.ts` — 2 new cases + `twoLineOrder`/`shipmentOf` fixtures.
- `erp/tests/ship-remainder.test.ts` — NEW; 5 cases.

No route change was needed: `shipperResponse` (`src/app/api/shippers/response.ts`) forwards the whole
`ShipperDetail`, so `GET /api/shippers/[id]` and every mutating shipment route carry the new field
automatically. No schema/migration change.

## Covering tests

`erp/tests/shippers.test.ts` → `describe("getShipper")`:
- *"carries shipped-to-date for EVERY line of each order, not only the lines on this shipment"* — a
  two-line order, a prior shipment taking 4/10lbs of line A and 3/5lbs of line B, then a second
  shipment carrying line A only. Asserts the ledger has an entry for **both** lines (line B is the
  candidate), that line A sums across both live shipments (6 / 15), and that line B reports the
  other shipment's 3 / 5.
- *"excludes voided shipments from that per-order-line ledger"* — same fixture, then
  `voidShipper(prior)`. Line A drops to 2 / 5; line B reports a real `0 / 0` (a present entry, not a
  missing key — the grid must render the number, and `expect(ledger.get(...)).toMatchObject(...)`
  fails on `undefined`).

`erp/tests/ship-remainder.test.ts` — full ordered when nothing shipped; `ordered − shipped` when
partial; zero when shipped in full; floored at zero (never a negative prefill) when over-shipped;
rounded to the 2dp the weight column stores (`25 − 12.1 → 12.9`).

## Commands run

### RED — before implementing

```
$ npx vitest run tests/ship-remainder.test.ts tests/shippers.test.ts
 FAIL  tests/ship-remainder.test.ts  [ failed to resolve import "@/lib/ship-remainder" ]
 FAIL  tests/shippers.test.ts > getShipper > carries shipped-to-date for EVERY line of each order,
       not only the lines on this shipment
TypeError: Cannot read properties of undefined (reading 'map')
 ❯ tests/shippers.test.ts:461:54
   461|     const ledger = new Map(so.orderLineShippedToDate.map((e) => [e.ord…
 FAIL  tests/shippers.test.ts > getShipper > excludes voided shipments from that per-order-line ledger
TypeError: Cannot read properties of undefined (reading 'map')
 ❯ tests/shippers.test.ts:483:54

 Test Files  2 failed (2)
      Tests  2 failed | 20 passed (22)
```

### GREEN — after implementing

```
$ npx vitest run tests/ship-remainder.test.ts tests/shippers.test.ts
 ✓ tests/shippers.test.ts (22 tests) 1160ms
 ✓ tests/ship-remainder.test.ts (5 tests) 2ms
 Test Files  2 passed (2)
      Tests  27 passed (27)
```

### Gates (all four, from `erp/`)

```
$ npx tsc --noEmit
(no output)

$ npx eslint src tests
(no output)

$ npm test
 Test Files  93 passed (93)
      Tests  1286 passed (1286)
   Duration  104.90s

$ npm run build
… ○ /shipping   ƒ /shipping/[id]   ƒ Proxy (Middleware)
(build completed; full route table printed)
```

1286 = the ledger's claimed 1279 + 7 new (5 `ship-remainder`, 2 `getShipper`). No pre-existing test
needed editing — the new field is additive and nothing asserted the detail shape with `toEqual`.

## Commit

- `efde514  fix(ui): prefill ship-now to the remainder on the shipment page`

## Notes for the reviewer / controller

- **Not browser-verified.** `npm run dev` was not driven for this round; the fix is covered by the
  service and lib tests above and by `tsc`/`build`. The original Step 6 browser claim remains the
  unverifiable ⚠️ the review already flagged.
- **Git identity.** This working tree has no `user.name`/`user.email` configured (the identity lived
  on the old machine); the commit was made with `git -c user.name=cojoa13 -c user.email=cjones1308@pm.me`
  to match the branch's existing author exactly, rather than writing repo config unasked. Whoever
  commits next will hit the same prompt — worth setting locally.
- **Uncommitted files left alone.** `.superpowers/sdd/progress.md` and
  `docs/superpowers/specs/2026-08-04-phase-4-certs-shipping-design.md` were modified by the
  controller during this session; they were deliberately left unstaged and are not in `efde514`.
- **Whole-branch review note:** `ShipperOrderDetail` grew a field. The design doc's §11/§4.2 shape
  descriptions do not enumerate DTO fields, so nothing there contradicts it, but it is worth a line
  in the same §9/§11 sweep that has to record `GET /api/shippers/[id]/documents` (Adjudication A).
