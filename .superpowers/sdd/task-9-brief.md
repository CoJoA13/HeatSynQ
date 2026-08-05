### Task 9: Shipment children — replace grids, add and remove orders

**Files:**
- Modify: `src/server/shippers.ts`
- Test: `tests/shipper-children.test.ts`

**Interfaces:**
- Consumes: Task 8's `ShipperDetail`.
- Produces:
```ts
export async function updateShipper(id: string, input: unknown): Promise<ShipperDetail>;      // header only
export async function addOrderToShipper(id: string, orderId: string): Promise<ShipperDetail>;
export async function removeOrderFromShipper(id: string, shipperOrderId: string): Promise<ShipperDetail>;
export async function replaceShipperLines(id: string, shipperOrderId: string, input: unknown): Promise<ShipperDetail>;
export async function replaceShipperContainers(id: string, shipperOrderId: string, input: unknown): Promise<ShipperDetail>;
export async function replaceShipperSerials(id: string, shipperOrderId: string, input: unknown): Promise<ShipperDetail>;
export async function listShippers(filter: ShipperFilter): Promise<ShipperRow[]>;
export async function exportShippers(filter: ShipperFilter): Promise<Buffer>;
export async function shipmentsForOrder(orderId: string): Promise<ShipperRow[]>;
export type ShipperFilter = { customerId?: string; from?: string; to?: string; includeVoided?: boolean; search?: string };
export type ShipperRow = {
  id: string; shipperNumber: number; bolNumber: number | null; customerCode: string; customerName: string;
  shipDate: string; orderCount: number; orderLabels: string[]; carrierName: string | null;
  totalQty: number; totalWeight: number; freightAmount: number | null; deletedAt: string | null;
};
```

- [ ] **Step 1: Write the failing tests** in `tests/shipper-children.test.ts`:

```ts
it("adds another order of the same customer and gives it its own sequence", async () => {
  const { shipper, orderB } = await shipmentPlusSpareOrder();
  const after = await addOrderToShipper(shipper.id, orderB.id);
  expect(after.orders).toHaveLength(2);
  expect(after.orders[1].sequence).toBe(1);          // orderB's FIRST shipment
  expect(after.orders[1].position).toBe(2);          // second ticket on this shipment
});

it("refuses an order belonging to a different customer", async () => {
  const { shipper, foreignOrder } = await shipmentPlusForeignOrder();
  await expect(addOrderToShipper(shipper.id, foreignOrder.id))
    .rejects.toThrow(/same customer/i);
});

it("refuses the same order twice on one shipment", async () => {
  const { shipper, orderA } = await oneOrderShipment();
  await expect(addOrderToShipper(shipper.id, orderA.id)).rejects.toThrow(/already on this shipment/i);
});

it("recomputes status when an order is removed", async () => {
  const { shipper, orderA, shipperOrderA } = await completeShipmentOf(orderA);
  expect((await getOrder(orderA.id)).status).toBe("SHIPPED");
  await removeOrderFromShipper(shipper.id, shipperOrderA.id);
  expect((await getOrder(orderA.id)).status).toBe("OPEN");
});

it("closes positions after a removal", async () => {
  const { shipper, second } = await threeOrderShipment();
  const after = await removeOrderFromShipper(shipper.id, second.id);
  expect(after.orders.map((o) => o.position)).toEqual([1, 2]);
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Every mutator: `withDbErrors` → Serializable `$transaction` → resolve the shipper (404 on missing **or voided** — a voided shipment is read-only, the P3 voided-order shape) → `claimOrdersInOrder(tx, everyAffectedOrderId)` → `auditedUpdate("shipper", id, …)` → writes → `recomputeOrderStatus`. `addOrderToShipper` allocates the new `ShipperOrder.sequence` via `nextShipmentSequence` and appends `position`; `removeOrderFromShipper` closes position gaps (the steps precedent). Position renumbering uses the **two-phase negative-park** pattern against `@@unique([shipperId, position])`, exactly as `order-loads.ts` does.
- [ ] **Step 4: Implement `listShippers`/`exportShippers`/`shipmentsForOrder`** — `use-latest`-friendly (pure data), `includeVoided` default off, search over packing-list number, BOL number, order number and customer code.
- [ ] **Step 5: Refuse removing an order whose ticket has printed** (spec §5.5, added 2026-08-04 by Task 2's review). `ShipperOrder` has no `deletedAt`, so removal hard-deletes the row and frees its `sequence` — and a later shipment of that order would then be handed a number already printed on a customer's ticket. Refuse when a `StoredDocument` exists with `kind: "SHIPPER"` and this shipment's id and either this order's id or `orderId: null` (the whole-set print covers every order on it). The message names the document and says to void the shipment instead. Tests:

```ts
it("refuses to remove an order whose ticket has printed, and allows it before", async () => {
  const { shipper, second } = await twoOrderShipment();
  await expect(removeOrderFromShipper(shipper.id, second.id)).resolves.toBeTruthy();  // nothing printed
  const { shipper: s2, second: sec2 } = await twoOrderShipment();
  await prisma.$transaction((tx) =>
    storeDocument(tx, { kind: "SHIPPER", shipperId: s2.id, orderId: sec2.orderId }, Buffer.from("%PDF-1.4 t")));
  await expect(removeOrderFromShipper(s2.id, sec2.id)).rejects.toThrow(/already printed|void the shipment/i);
});

it("treats a whole-set ticket print as covering every order on the shipment", async () => {
  const { shipper, second } = await twoOrderShipment();
  await prisma.$transaction((tx) =>
    storeDocument(tx, { kind: "SHIPPER", shipperId: shipper.id, orderId: null }, Buffer.from("%PDF-1.4 t")));
  await expect(removeOrderFromShipper(shipper.id, second.id)).rejects.toThrow(/already printed/i);
});
```

- [ ] **Step 5a: Lock the claim *call site* with composition tests** (carried from Task 8's review). Timing cannot discriminate ABBA deadlock at this layer — the sorted claim is a single `SELECT … ORDER BY "id" FOR UPDATE` with `LockRows` above `Sort`, so it holds A while blocking on B exactly as an unsorted version would, and there is no between-statements window a test can hold open. What *is* deterministically testable is that each mutator claims through `claimOrdersInOrder` with the full id set. Use the house-legal module mock (`vi.mock("@/server/order-locks", …)` — a module boundary, **not** a `vi.spyOn` on a Prisma delegate, which is banned) and assert **the first lock call** is `claimOrdersInOrder` carrying every affected order id. Note `certs.ts` also calls `claimOrder`, so assert on the first call rather than "`claimOrder` is never called". Cover `createShipper` plus each mutator this task adds.
- [ ] **Step 5b: Assert `SNAPSHOT_INCLUDE.shipper`'s content, not just its shape** (carried from Task 8's review). `auditedCreate` writes a hand-built payload and never consults `SNAPSHOT_INCLUDE`, so this task's `updateShipper`/`voidShipper` are its **first real consumer**. Assert the snapshot names the customer by **code** and the carrier and ship-to by **name** — raw cuids in a history diff are the unreadable-history shape issue #24 exists to prevent.
- [ ] **Step 6: Assert `ShipperOrder`'s two remaining uniques as behaviour** (Task 2's review left them unexercised): `@@unique([shipperId, orderId])` rejects the same order twice on one shipment (already covered by the service check — assert the constraint too, so a service refactor cannot silently lose it), and `@@unique([shipperId, position])` survives the two-phase negative-park renumber under a removal.
- [ ] **Step 7: Run the tests** — PASS, plus a `replaceShipperLines` test asserting the over-ship warning appears and the save still succeeds.
- [ ] **Step 8: Gates + commit** — `feat(shipping): shipment children, add/remove order, listing and export`

---

