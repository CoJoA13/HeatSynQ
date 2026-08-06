### Task 14b: Shipment creation flow (`/shipping/new`) — ADDED 2026-08-05, a hole in this plan

**This task did not exist and should have.** Task 14's implementer found it and correctly refused to
invent it. The plan builds `createShipper` (Task 8), routes `POST /api/shippers` (Task 11), a
shipping list (Task 13) and a shipment **edit** page (Task 14) — but **no screen ever calls
`createShipper`.** Three consequences, all real:

- **The credit-hold gate — this phase's headline feature and the blocking half of owner ruling §3.7 —
  is unreachable from the UI.** It fires only in `createShipper`; the edit page never calls it. The
  banner Task 14 was asked to render therefore cannot appear in the running app.
- The idempotency nonce (`clientRequestId`) has no producer, so the double-submit protection Task 8
  built and tested is never exercised in practice.
- **Task 20's E2E flows assume the literal route `/shipping/new` exists** — `ship-partial-then-complete`,
  `multi-order-shipment` and `credit-hold-block-and-override` all start by creating a shipment. They
  cannot run until this lands.

**Files:** Create `src/app/shipping/new/page.tsx` and its entry component.

**Shape.** Unlike the edit page, this is a **single atomic nested POST** — `createShipper` takes the
whole graph (customer, ship-to, dates, carrier/freight, and per-order lines/containers/serials) in
one call, because the packing-list number, every order's shipment sequence and the SHIPMENT-scope
certs are all allocated inside one transaction. Do not model it as "create empty, then edit"; that
would burn a number on every abandoned draft and defeat the idempotency nonce. Order entry
(`src/app/orders/new/`) is the closest precedent for a build-then-submit-once screen — read it first.

- [ ] **Step 1:** Customer picker, then that customer's orders with unshipped lines; ship-to from the
  customer's saved addresses; ship date, carrier, route, comments, freight block.
- [ ] **Step 2:** Per selected order, the three grids prefilled to the remainder (`ordered − shipped`),
  reusing `useBulkGrid` and the same components Task 14 built — **sibling-split rule: a fix to a grid
  lands on every copy in the same commit.**
- [ ] **Step 3:** Mint `clientRequestId` when the form mounts and send it with the save, so a retry
  returns the first shipment rather than creating a second (Task 8's `deduped` path).
- [ ] **Step 4:** Render the credit-hold refusal naming the customer and linking to their record, and
  the override affordance for an actor holding `override_credit_hold` — with the reason required.
  **This is the first place that gate is reachable by a human; verify it in a browser, both refused
  and overridden.**
- [ ] **Step 5:** Render the §5.7 warnings returned by the save. Gates, commit, self-review, report.
