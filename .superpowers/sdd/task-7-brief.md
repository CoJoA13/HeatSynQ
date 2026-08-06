### Task 7: `ship-ledger.ts` — shipped totals, status derivation, shipment sequence, sorted claims

**Files:**
- Create: `src/server/ship-ledger.ts`
- Modify: `src/server/orders.ts` (add `claimOrdersInOrder` beside `claimOrder`; call `recomputeOrderStatus` from `addLine`/`updateLine`/`removeLine`)
- Test: `tests/ship-ledger.test.ts`

**Interfaces:**
- Consumes: Task 2's `ShipperLine`/`ShipperOrder`.
- Produces:
```ts
// src/server/order-locks.ts — a NEW leaf module (see the extraction note below)
/** Moved here from orders.ts, unchanged. */
export async function claimOrder(tx: Db, orderId: string): Promise<Order | null>;
/** Claims every order row FOR UPDATE in ASCENDING ID ORDER. Sorting is what stops two
 *  multi-order saves over {A,B} and {B,A} deadlocking — never claim in caller order. */
export async function claimOrdersInOrder(tx: Db, orderIds: string[]): Promise<Order[]>;

// src/server/ship-ledger.ts
export type ShippedTotal = { qty: number; weight: number };
/** Sum of LIVE shipper lines per order line. A voided shipment contributes nothing. */
export async function shippedTotals(db: Db, orderLineIds: string[]): Promise<Map<string, ShippedTotal>>;
/** OPEN | PARTIAL_SHIPPED | SHIPPED per §5.2. Quantities never influence it. Voided orders untouched. */
export async function recomputeOrderStatus(tx: Prisma.TransactionClient, orderIds: string[]): Promise<void>;
/** max(sequence) + 1 over ALL ShipperOrders for this order, INCLUDING voided shipments. */
export async function nextShipmentSequence(tx: Prisma.TransactionClient, orderId: string): Promise<number>;
```

**Fixtures note — this task runs BEFORE `createShipper` and `voidShipper` exist (Tasks 8 and 10).**
Its fixtures write `Shipper`/`ShipperOrder`/`ShipperLine` rows directly with `prisma.*.create`, and
"void" means `prisma.shipper.update({ data: { deletedAt: new Date() } })`. Do not import from
`shippers.ts` here — the ledger is deliberately independent of the service that will call it.

- [ ] **Step 1: Write the failing tests** in `tests/ship-ledger.test.ts`:

```ts
it("excludes voided shipments from shipped-to-date", async () => {
  const { orderLine, shipperA } = await twoShipmentsOf(300, 200);   // rows written directly
  expect((await shippedTotals(prisma, [orderLine.id])).get(orderLine.id)!.qty).toBe(500);
  await prisma.shipper.update({ where: { id: shipperA.id }, data: { deletedAt: new Date() } });
  expect((await shippedTotals(prisma, [orderLine.id])).get(orderLine.id)!.qty).toBe(200);
});

it("derives status from ship-line-complete, never from quantity", async () => {
  const { order, line } = await oneLineOrder({ qty: 1000 });
  await shipLine(line, { qty: 1000, lineComplete: false });   // full quantity, NOT complete
  expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
  await shipLine(line, { qty: 1, lineComplete: true });       // one piece, complete
  expect((await getOrder(order.id)).status).toBe("SHIPPED");
});

it("returns a SHIPPED order to PARTIAL_SHIPPED when a rider line is added", async () => {
  const { order, line } = await oneLineOrder({});
  await shipLine(line, { qty: 10, lineComplete: true });
  expect((await getOrder(order.id)).status).toBe("SHIPPED");
  await addLine(order.id, { partId: (await makeRider(order)).id, qty: 5, weight: "10.00" });
  expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
});

it("never reissues a shipment sequence after a void", async () => {
  const { order } = await savedOrder();
  await makeShipment(order, 1);
  const second = await makeShipment(order, 2);
  await prisma.shipper.update({ where: { id: second.id }, data: { deletedAt: new Date() } });
  const next = await prisma.$transaction((tx) => nextShipmentSequence(tx, order.id));
  expect(next).toBe(3);        // NOT 2 — the voided shipment's number is already on paper
});

it("claims orders in ascending id order regardless of caller order", async () => {
  const [a, b, c] = (await Promise.all([savedOrder(), savedOrder(), savedOrder()]))
    .map((r) => r.order.id).sort();
  const seen: string[] = [];
  await prisma.$transaction(async (tx) => {
    // Wrap $queryRaw by plain property save/restore — NEVER vi.spyOn a Prisma delegate
    // (Global Constraints: mockRestore does not restore it on this client).
    const original = tx.$queryRaw.bind(tx);
    (tx as { $queryRaw: unknown }).$queryRaw = ((...args: Parameters<typeof original>) => {
      const sql = String(args[0]);
      if (sql.includes("FOR UPDATE")) seen.push(...[a, b, c].filter((id) => args.flat().includes(id)));
      return original(...args);
    }) as typeof original;
    await claimOrdersInOrder(tx, [c, a, b]);
  });
  expect(seen).toEqual([a, b, c]);
});
```

If the single-statement `ORDER BY … FOR UPDATE` form makes per-id observation awkward, assert the
ordering directly instead: export the sort as `sortedClaimIds(ids: string[]): string[]` from
`orders.ts` and unit-test that, plus one integration test proving two concurrent
`claimOrdersInOrder` calls over `{A,B}` and `{B,A}` both complete rather than deadlocking. **The
concurrent test is the one that matters — do not skip it in favour of the unit test alone.**

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3a: Extract the claims into `src/server/order-locks.ts` FIRST — added 2026-08-04 after Task 5's review.** Task 5 created a genuine bidirectional module cycle: `certs.ts` imports `claimOrder` from `orders.ts`, and `orders.ts` imports `resolveCertSettings`/`createCert` from `certs.ts`. It is safe today only because every crossing export is a hoisted `function` declaration, and this task and Task 8 are both about to widen it (`shippers.ts` needs `claimOrdersInOrder` **and** `createCert`, and `orders.ts` needs `shipmentBlockers` back from `shippers.ts` for §5.5). This codebase already has the precedent and the reasoning: Phase 2A extracted `HttpError` into a zero-import `src/server/errors.ts` specifically to break a `settings → http → sessions → settings` cycle, and `tests/errors.test.ts` asserts that file imports nothing.

  Move `claimOrder` verbatim from `orders.ts` into a new leaf `src/server/order-locks.ts` (importing only `db` and Prisma types — nothing from another service), re-point every existing caller (`orders.ts`, `certs.ts`, `attachments.ts`, `order-loads.ts`, `traveler.ts`), and confirm the cycle is gone. **A moved function with no behaviour change needs no new tests** — the existing suites covering each caller are the proof, and they must stay green untouched.

- [ ] **Step 3b: Implement `claimOrdersInOrder`** in `src/server/order-locks.ts` beside it — `[...new Set(orderIds)].sort()`, then one `SELECT "id" FROM "Order" WHERE "id" = ANY($1) ORDER BY "id" FOR UPDATE`, then `findMany`. A single ordered statement is both the sort and the claim.
- [ ] **Step 4: Implement `ship-ledger.ts`** exactly per §5.1/§5.2/§5.3. `recomputeOrderStatus` skips orders with `deletedAt !== null` (voidedness is orthogonal to status) and never writes `INVOICED` or `REOPENED`. `nextShipmentSequence` runs `_max` over `shipperOrder` for the order with **no live filter** — a voided shipment's sequence is already on a customer's paperwork.
- [ ] **Step 5: Hook the order line mutators** — `addLine`, `updateLine` and `removeLine` in `orders.ts` call `recomputeOrderStatus(tx, [orderId])` at the end of their existing transactions.
- [ ] **Step 6: Run the tests** — PASS.
- [ ] **Step 7: Gates + commit** — `feat(shipping): ship ledger, status derivation, shipment sequence, sorted claims`

---

