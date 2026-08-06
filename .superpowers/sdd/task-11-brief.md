### Task 11: Routes — shipments, certs, hub sections, and the 401/403 sweep

**Files:**
- Create: `src/app/api/shippers/route.ts`, `src/app/api/shippers/export/route.ts`, `src/app/api/shippers/[id]/route.ts`, `src/app/api/shippers/[id]/orders/route.ts`, `src/app/api/shippers/[id]/orders/[shipperOrderId]/route.ts`, `src/app/api/shippers/[id]/orders/[shipperOrderId]/lines/route.ts`, `…/containers/route.ts`, `…/serials/route.ts`, `src/app/api/certs/route.ts`, `src/app/api/certs/export/route.ts`, `src/app/api/certs/[id]/route.ts`, `src/app/api/certs/[id]/results/route.ts`, `src/app/api/orders/[id]/certs/route.ts`, `src/app/api/orders/[id]/shipments/route.ts`
- Test: `tests/shipper-routes.test.ts`, `tests/cert-routes.test.ts`

**Interfaces:**
- Consumes: every service from Tasks 5–10.
- **The two print routes are NOT created here.** `/api/shippers/[id]/print` arrives with Task 18 and `/api/certs/[id]/print` with Task 19, each alongside the layout it streams — a route that 501s is a route nothing can test, and this project does not ship unreachable surface (the 2B finding where a delete route shipped with no caller).

- [ ] **Step 0: Close `createCert`'s `shipperId` liveness gap** (carried from Task 8's review). `createCert` has no `assertRefExists` on `shipperId` — correctly, since that helper is the reference-kind pattern and spec §7 omits shipper — but `Shipper` is soft-deletable, so a raw foreign key catches a nonexistent id and **not a voided one**. It is safe today only because the sole caller passes its own uncommitted row. This task adds the first route that could carry a client-supplied id, so close it both ways: the cert-create route must not accept `shipperId` from the client at all (scope is resolved server-side), **and** `createCertInTx`'s `SHIPMENT` branch gains `tx.shipper.findFirst({ where: { id, deletedAt: null } })` with a field-anchored 400. Test both.
- [ ] **Step 0b: Every mutating shipment route must return `overshipWarnings(detail)`** (carried from Task 9's review). Task 8's `createShipper` returns `{ shipper, warnings, deduped }`, but Task 9's six mutators return a bare `ShipperDetail` with warnings exposed only through a separate pure `overshipWarnings(detail)` export that **nothing obliges a caller to invoke**. A route written as `return NextResponse.json(await replaceShipperLines(...))` silently drops the spec §5.7 over-ship warning. Wrap every mutating shipment route's response in the same `{ shipper, warnings }` shape `createShipper` established, so the screen sees one consistent contract, and test that an over-shipping edit actually surfaces its warning through the route rather than only through the service.
- [ ] **Step 1: Write the failing route tests** — for **every** route: 401 unauthenticated, 403 without the gate, 200/201 with it. Specifically: `POST /api/shippers` needs `shipping.create`; the credit-hold override path passes `canOverrideCreditHold: canDo(user, "override_credit_hold")` and a session **without** it gets the refusal even when a reason is supplied; `DELETE /api/shippers/[id]` needs `mustDo("void_shipper")` and `reasonFromBody`; `PUT /api/certs/[id]/results` passes `{ afterPrint: canDo(user, "edit_cert_results_after_print") }`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Write the handlers** — authorize, parse, delegate; nothing else. Every handler is `handle(async (req, { params }) => …)`; every test passes ctx.
- [ ] **Step 4: Run the tests** — PASS.
- [ ] **Step 5: Extend `tests/permissions-sweep.test.ts`** — it already asserts every route calls `requireUser`; confirm the new routes are covered and that no service under `src/server/` writes `prisma.auditLog.create` directly.
- [ ] **Step 6: Gates + commit** — `feat(api): shipment and certification routes`

---

