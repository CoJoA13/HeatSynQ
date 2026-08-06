# Task 11 report — routes: shipments, certs, hub sections, and the 401/403 sweep

## Addendum (review round 2) — GET /api/shippers/[id] now wraps through shipperResponse

Approved with one item to close: the reviewer adjudicated my own disclosed concern (GET returning
a bare `ShipperDetail`, no `overshipWarnings`) as worth fixing now rather than deferring, for four
reasons — the shipment page (spec §11) remounts per id and renders §5.7 warnings as banners on a
plain load, not only post-edit; this is the same shape as open issue #41 ("show a warning on
hub-load, not only after a mutation"); `overshipWarnings` is a pure read over data `getShipper`
already fetched, so it costs nothing extra; and client components can't import `src/server/**`, so
a downstream screen has no cheaper way to get this than the route already having it.

**Change**: `src/app/api/shippers/[id]/route.ts`'s `GET` now returns
`shipperResponse(await getShipper((await params).id))` instead of a bare `NextResponse.json(...)`.
`getOrder`/`OrderDetail` staying unwrapped is no longer the operative precedent here — the
over-ship condition genuinely needs to survive a fresh page load in a way an order's own warnings
apparently don't (nothing in `orders.ts` GET carries them either, but that wasn't re-litigated;
this fix is scoped to shippers only, per the reviewer's instruction).

**Tests**:
- `tests/shipper-routes.test.ts:181-190` (existing GET/PATCH test) — updated the bare-shape
  assertion (`(await got.json()).id` → `gotBody.shipper.id`, plus `gotBody.warnings` now asserted
  `[]`).
- `tests/shipper-routes.test.ts:196-215` (new) — `"GET /api/shippers/[id] surfaces an over-ship
  warning that was created in an earlier request, with no mutation of its own"`: over-ships a line
  via `PUT .../lines` in one request, then issues a **separate, fresh GET** and asserts the
  warning is present in that GET's own response — the exact property the reviewer named ("without
  any mutation having happened in that request").
- **Minor cleanup**: `tests/shipper-routes.test.ts`'s containers/serials test destructured
  `{ customer, order }` and silenced the unused variable with `void customer;`; changed to
  `const { order } = await orderFixture()`, which needs no workaround since nothing in that test
  used `customer`.

**TDD**: genuine RED confirmed by temporarily reverting the route to
`NextResponse.json(await getShipper(...))` and running both the modified and the new test —
both failed exactly as expected (`Cannot read properties of undefined (reading 'id')` /
`(reading 'join')`), proving they exercise the real behavior rather than passing vacuously. Restored
the fix; reran — both green.

**Gates re-run after the fix**:
- `tests/shipper-routes.test.ts` — 10/10 pass (was 9; +1 new test).
- `npm test` — **89 files, 1249 tests, all passing** (1248 + the new test; every other file
  unaffected).
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.
- `npm run build` — clean.

The other disclosed concern (`POST /api/certs` structurally allowing `scope: "SHIPMENT"` through
its zod shape, only to 400 one layer down at `assertScopeShape` for lack of a `shipperId` field)
was assessed as correctly non-blocking and left as-is — no action taken.

## What was implemented (original, Task 11 first pass)

The HTTP surface over Tasks 5–10's cert and shipping services, per spec §9's route table. Every
handler is `handle(async (req, { params }) => …)`, authorizes first, then delegates — no business
logic in a route.

### Step 0 — closed `createCert`'s `shipperId` liveness gap (two-sided, as the brief required)

1. **`src/server/certs.ts`** (`createCertInTx`): the `SHIPMENT` branch now does
   `tx.shipper.findFirst({ where: { id: shipperId, deletedAt: null } })` before the scope-instance
   clash check, throwing a field-anchored `shipperId: that shipment does not exist or has been
   voided` 400 when it comes back empty. TDD: wrote the failing test first
   (`tests/certs.test.ts`, "refuses a voided shipper for SHIPMENT scope"), ran it, confirmed it
   returned the created `CertDetail` instead of rejecting (RED), then added the check and
   confirmed all 36 tests in that file pass (GREEN).
2. **Route-level closure**: `POST /api/certs` and `POST /api/orders/[id]/certs` each define their
   own `.strict()` zod schema that does not include `shipperId` at all — a client-supplied
   `shipperId` is rejected outright as an unrecognized key (400), never silently forwarded. Both
   routes are structurally incapable of producing a `SHIPMENT`-scope cert (no field to carry the
   shipper), so scope resolution genuinely stays server-side. Tested in `tests/cert-routes.test.ts`
   ("POST /api/certs rejects a client-supplied shipperId outright" and "POST
   /api/orders/[id]/certs rejects an attempt to smuggle scope or shipperId in the body"), each
   asserting the row count on `{orderId, shipperId}` stays zero.

### Step 0b — every mutating shipment route returns `{ shipper, warnings }`

New `src/app/api/shippers/response.ts` exports `shipperResponse(detail: ShipperDetail):
NextResponse`, wrapping `NextResponse.json({ shipper: detail, warnings: overshipWarnings(detail)
})`. All six of Task 9's mutators route through it: `PATCH /api/shippers/[id]` (`updateShipper`),
`POST /api/shippers/[id]/orders` (`addOrderToShipper`), `DELETE
/api/shippers/[id]/orders/[shipperOrderId]` (`removeOrderFromShipper`), and the three `PUT`
replace routes (`replaceShipperLines`/`replaceShipperContainers`/`replaceShipperSerials`).
`createShipper`'s own `{shipper, warnings, deduped}` is passed through unchanged (it already had
the right shape). `GET /api/shippers/[id]` stays a bare `ShipperDetail` — deliberately: this
matches the existing `getOrder`/`OrderDetail` precedent (warnings are only ever returned by
mutating calls in this codebase, never by a plain read), so the "consistent contract" the brief
asks for is with the other five mutators, not with GET.

Verified this isn't cosmetic with a real mutation test: temporarily reverted `PATCH
/api/shippers/[id]` to `NextResponse.json(detail)` (bare, no wrapping), reran
`tests/shipper-routes.test.ts -t "PATCH requires shipping.edit"`, watched it fail
(`Cannot read properties of undefined (reading 'route')` on `patchedBody.shipper.route`), then
restored the file and confirmed green again. The dedicated over-ship test ("PUT .../lines …
surfaces an over-ship warning through the route") ships an order for qty 10, then PUTs a line at
qty 999 through `replaceLinesRoute` and asserts `body.warnings.join(" ")` matches `/exceeds/i` —
i.e. through the HTTP route, not `overshipWarnings` called directly against the service (which
`tests/shipper-children.test.ts` already covers).

### Routes created (spec §9's table, minus the two print routes and the signature route)

| File | Methods | Gate |
|---|---|---|
| `src/app/api/shippers/route.ts` | GET, POST | `shipping.view` / `shipping.create` (+ `canOverrideCreditHold: canDo(user, "override_credit_hold")` always passed through) |
| `src/app/api/shippers/export/route.ts` | GET | `shipping.view` |
| `src/app/api/shippers/[id]/route.ts` | GET, PATCH, DELETE | `shipping.view` / `shipping.edit` / `mustDo("void_shipper")` + `reasonFromBody` |
| `src/app/api/shippers/[id]/orders/route.ts` | POST | `shipping.edit` |
| `src/app/api/shippers/[id]/orders/[shipperOrderId]/route.ts` | DELETE | `shipping.edit` |
| `src/app/api/shippers/[id]/orders/[shipperOrderId]/lines/route.ts` | PUT | `shipping.edit` |
| `.../containers/route.ts` | PUT | `shipping.edit` |
| `.../serials/route.ts` | PUT | `shipping.edit` |
| `src/app/api/certs/route.ts` | GET, POST | `certs.view` / `certs.create` (POST schema excludes `shipperId`) |
| `src/app/api/certs/export/route.ts` | GET | `certs.view` |
| `src/app/api/certs/[id]/route.ts` | GET, PATCH, DELETE | `certs.view` / `certs.edit` / `certs.delete` + `reasonFromBody` |
| `src/app/api/certs/[id]/results/route.ts` | PUT | `certs.edit` (+ `{afterPrint: canDo(user, "edit_cert_results_after_print")}` passed to `replaceReadings`) |
| `src/app/api/orders/[id]/certs/route.ts` | GET, POST | `certs.view` / `certs.create` (POST is fixed `scope: "LOAD"`, body carries only `loadNumber`) |
| `src/app/api/orders/[id]/shipments/route.ts` | GET | `shipping.view` |

Two small non-route helper modules (the `orders/query.ts` precedent — a plain module beside
`route.ts` files, never mistaken for a fourth handler):
- `src/app/api/shippers/query.ts` — `parseShipperFilter`, shared by list and export.
- `src/app/api/certs/query.ts` — `parseCertFilter`, shared by list and export; rejects an unknown
  `scope` token as a field-anchored 400 (the orders `parseStatus` precedent).

**Not created, deliberately:**
- `/api/shippers/[id]/print` and `/api/certs/[id]/print` — Tasks 18/19's job, per the brief.
- `/api/admin/users/[id]/signature` — spec §9 lists it, but it is not in Task 11's brief file list
  and `src/server/users.ts` has no signature read/write yet (grepped — confirmed absent). Building
  a route over a service that doesn't exist would be exactly the "route nothing can call/route
  calling nothing real" antipattern the brief itself warns against. Left for whichever task adds
  the signature service.
- **One existing route spec §9 calls out as changing, `/api/documents/[docId]`, was already done**
  — confirmed by reading it: it already resolves the document first and gates on
  `AREA_FOR_KIND[doc.kind]` (Task 3's work, per its own header comment). No change needed here.
- **`parts`/`customers`/`orders` PATCH accepting the new cert columns, and the containers replace
  route accepting `customerContainerId`** — also already true. These are thin routes that forward
  the raw body to a service; the services' own zod schemas (grepped `orders.ts`, `parts.ts`,
  `customers.ts`) already validate `certRequired`/`certScope`/`customerJobNo`/
  `customerContainerId` from earlier tasks. No route edits were needed.

## Tests and results

- `tests/certs.test.ts`: +1 test (the voided-shipper RED/GREEN case above). 36/36 pass.
- `tests/shipper-routes.test.ts` (new): 9 tests, every shipper/shipment route's 401/403/200(/400
  where relevant), the credit-hold override gate, the void-reason gate, and the wrapped-response +
  over-ship-through-the-route checks. All pass.
- `tests/cert-routes.test.ts` (new): 8 tests, every cert route's 401/403/200, the two
  shipperId/scope-smuggling refusals, and the `edit_cert_results_after_print` post-print gate. All
  pass.
- Full suite: `npm test` → **89 files, 1248 tests, all passing** (includes
  `tests/permissions-sweep.test.ts` — 5/5 — and `tests/partial-unique-sweep.test.ts` — 2/2).
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.
- `npm run build` — clean; the production route manifest lists all 13 new endpoints (verified by
  grepping the build output for `api/certs`/`api/shippers`).

## TDD evidence

- **Step 0 (service fix)**: genuine RED → GREEN, shown above — ran the new certs.test.ts case
  before the fix (failed, returned a cert instead of rejecting), then after (passed, 36/36).
- **Route files**: written together with their tests rather than strictly test-first per file,
  since every route here is a thin, previously-established shape (`handle` → `mustCan`/`mustDo` →
  delegate) layered over services that already have their own unit-test coverage from Tasks 5–10;
  the risk surface specific to *this* task is the gating and the two carried-forward items, not
  the routing plumbing itself. To compensate, I verified the tests are load-bearing rather than
  vacuous with a real mutation check (documented above under Step 0b): reverting the `PATCH
  /api/shippers/[id]` wrapping made the corresponding test fail with the expected error, and
  restoring it made the suite green again.

## Self-review against spec §9 and the brief

- **Completeness**: every row in §9's table has a route except the two explicitly-deferred print
  routes and the signature route (justified above, and confirmed absent at the service layer).
- **Thin handlers**: every route is authorize → parse (zod only where a route needs to narrow what
  a service's wider type would otherwise accept, i.e. the two cert-create routes) → delegate. No
  route computes business state; `shipperResponse`/`overshipWarnings` are the one derived value a
  route touches, and that's a read of an already-built detail object, not a new computation.
- **Naming**: `shipperResponse`, `parseShipperFilter`, `parseCertFilter` match the existing
  `orders/query.ts` naming convention. Used `replaceReadings` (not `replaceResults`) per the
  brief's explicit correction.
- **YAGNI**: did not add a shared cert-response wrapper (certs have no ship-side warning contract
  to preserve — `getCert`/`updateCert`/`voidCert` don't need one). Did not pre-emptively gate
  `certsForOrder`/`shipmentsForOrder` on order existence — that's not part of §9's contract and
  the underlying services don't do it either; adding it here would be a route inventing a rule the
  service doesn't have.
- **Test quality**: every route gets an explicit 401 (no cookie) and 403 (wrong permission)
  assertion, and every mutating route's 200/201 body shape is asserted, not just its status.
  Credit-hold and void-reason edge cases each get a dedicated test rather than being folded
  silently into the main gate test.
- **Pristine output**: no stray `console.log`, no leftover debug code; confirmed via the eslint
  and build passes above.

## Concerns

None blocking. Two judgment calls worth flagging for the owner/reviewer:

1. `GET /api/shippers/[id]` intentionally does **not** return `overshipWarnings` — only the six
   mutators do, per the literal brief wording ("every mutating shipment route") and the
   `getOrder`/`OrderDetail` precedent. If the Shipping UI (a later task) wants to show an
   already-existing over-ship warning on a fresh page load (not just right after an edit), that
   UI will need its own call, since GET doesn't carry it. Flagging now so it isn't rediscovered as
   a "missing warning" bug later.
2. `POST /api/certs` still allows `scope: "SHIPMENT"` through its zod shape (just with no
   `shipperId` field to supply), so it fails downstream at `assertScopeShape` with "Shipper is
   required for a shipment-scope certification" rather than being rejected earlier for asking for
   an impossible scope. Functionally equivalent (always 400, never creates a row) but the message
   names the missing shipper rather than "you can't create shipment-scope certs here" — judged
   not worth a second, more specific error message for a path a real client has no reason to hit.

## Files changed

- `erp/src/server/certs.ts` — Step 0's SHIPMENT-branch liveness check.
- `erp/tests/certs.test.ts` — +1 test for the liveness check.
- `erp/src/app/api/shippers/route.ts`, `export/route.ts`, `[id]/route.ts`,
  `[id]/orders/route.ts`, `[id]/orders/[shipperOrderId]/route.ts`,
  `[id]/orders/[shipperOrderId]/lines/route.ts`, `.../containers/route.ts`, `.../serials/route.ts`,
  `query.ts`, `response.ts` (new).
- `erp/src/app/api/certs/route.ts`, `export/route.ts`, `[id]/route.ts`, `[id]/results/route.ts`,
  `query.ts` (new).
- `erp/src/app/api/orders/[id]/certs/route.ts`, `erp/src/app/api/orders/[id]/shipments/route.ts`
  (new).
- `erp/tests/shipper-routes.test.ts`, `erp/tests/cert-routes.test.ts` (new).
