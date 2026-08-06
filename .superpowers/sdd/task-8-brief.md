### Task 8: `shippers.ts` — create, with sorted claims, credit hold and idempotency

**Files:**
- Create: `src/server/shippers.ts`
- Modify: `src/lib/permission-constants.ts` (+`override_credit_hold`)
- Test: `tests/shippers.test.ts`, `tests/permissions.test.ts`

**Interfaces:**
- Consumes: `claimOrdersInOrder`, `recomputeOrderStatus`, `nextShipmentSequence` (Task 7); `allocateNumber` (Task 1); `createCert` (Task 5).
- Produces:
```ts
export type ShipperLineDetail = {
  id: string; orderLineId: string; linePosition: number; partNumber: string; partName: string;
  orderedQty: number; orderedWeight: number; shippedToDateQty: number; shippedToDateWeight: number;
  qty: number; weight: number; lineComplete: boolean;
};
export type ShipperOrderDetail = {
  id: string; orderId: string; orderNumber: number; sequence: number; position: number;
  poNumber: string; customerJobNo: string; label: string;            // `${orderNumber}-${sequence}`
  lines: ShipperLineDetail[];
  containers: { id: string; orderContainerId: string; typeName: string; customerContainerId: string; count: number; position: number }[];
  serials: { id: string; orderSerialId: string; serial: string; description: string; printOnShipper: boolean }[];
};
export type ShipperDetail = {
  id: string; shipperNumber: number; bolNumber: number | null;
  customerId: string; customerCode: string; customerName: string;
  shipToAddressId: string | null; shipDate: string;
  carrierId: string | null; carrierName: string | null; route: string; comments: string;
  billFreight: boolean; freightAmount: number | null; freightTerms: FreightTermsValue;
  freightClass: string; freightDescription: string; packageCount: number | null;
  proNumber: string; scacCode: string; deletedAt: string | null;
  orders: ShipperOrderDetail[];
};
export type ShipperCreateResult = { shipper: ShipperDetail; warnings: string[]; deduped: boolean };

export async function createShipper(input: unknown, opts: { canOverrideCreditHold: boolean }): Promise<ShipperCreateResult>;
export async function getShipper(id: string): Promise<ShipperDetail>;
```
Input shape: `{ clientRequestId?, customerId, shipToAddressId?, shipDate, carrierId?, route?, comments?, billFreight?, freightAmount?, freightTerms?, freightClass?, freightDescription?, packageCount?, proNumber?, scacCode?, creditHoldReason?, orders: [{ orderId, lines: [{ orderLineId, qty, weight, lineComplete }], containers: [...], serials: [...] }] }`

- [ ] **Step 1: Add `override_credit_hold`** to `SPECIAL_ACTIONS` in `src/lib/permission-constants.ts` (eleventh entry) and extend `tests/permissions.test.ts`'s action-count assertion.
- [ ] **Step 2: Write the failing tests** in `tests/shippers.test.ts`:

```ts
it("blocks a customer on credit hold and names them", async () => {
  const { order, customer } = await savedOrder({ creditHold: true });
  await expect(createShipper(oneOrderInput(order), { canOverrideCreditHold: false }))
    .rejects.toThrow(new RegExp(`${customer.name}.*credit hold`, "i"));
});

it("allows the override with a reason and records it in the audit entry", async () => {
  const { order } = await savedOrder({ creditHold: true });
  const { shipper } = await createShipper(
    { ...oneOrderInput(order), creditHoldReason: "owner approved, cheque in hand" },
    { canOverrideCreditHold: true });
  const entry = await prisma.auditLog.findFirst({ where: { entity: "shipper", entityId: shipper.id } });
  expect(JSON.stringify(entry)).toContain("cheque in hand");
});

it("refuses the override with a blank reason", async () => {
  const { order } = await savedOrder({ creditHold: true });
  await expect(createShipper({ ...oneOrderInput(order), creditHoldReason: "  " },
    { canOverrideCreditHold: true })).rejects.toThrow(/reason/i);
});

it("returns the first shipment for a repeated clientRequestId", async () => {
  const { order } = await savedOrder();
  const input = { ...oneOrderInput(order), clientRequestId: "nonce-1" };
  const a = await createShipper(input, { canOverrideCreditHold: false });
  const b = await createShipper(input, { canOverrideCreditHold: false });
  expect(b.deduped).toBe(true);
  expect(b.shipper.id).toBe(a.shipper.id);
  expect(await prisma.shipper.count()).toBe(1);
});

it("warns without blocking on a missing cert and unserialised lines", async () => {
  const { order } = await savedOrder({ certRequired: true, serializationRequired: true });
  const { warnings } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
  expect(warnings.join(" ")).toMatch(/requires a certification/i);
  expect(warnings.join(" ")).toMatch(/no serial numbers/i);
});

it("refuses a shipment with no positive quantity", async () => {
  const { order } = await savedOrder();
  await expect(createShipper(zeroQtyInput(order), { canOverrideCreditHold: false }))
    .rejects.toThrow(/at least one line/i);
});
```

- [ ] **Step 3: Run to verify failure.**
- [ ] **Step 4: Implement `createShipper`** — `withDbErrors` → Serializable `$transaction`:
  1. zod-parse the input (`decimalField(12, 2)` for weights/freight; `freightClass`/`proNumber`/`scacCode` `.max(30)` text).
  2. `claimOrdersInOrder(tx, input.orders.map(o => o.orderId))` — **sorted, always**.
  3. Validate: customer live and matching every order's customer; no voided orders; every `orderLineId` belongs to its order; at least one line with `qty > 0` across the whole shipment; `shipToAddressId` (when given) is a live `SHIP_TO` of that customer.
  4. Credit hold per §5.4 — refuse naming the customer with a link, or require and trim `creditHoldReason` when overriding.
  5. `allocateNumber("shipper_number_next", tx)`; per order `nextShipmentSequence(tx, orderId)`.
  6. `assertRefExists("carrier", carrierId, tx)` when set.
  7. `auditedCreate("shipper", payload, …, { tx })` with the whole graph; the override reason rides in the payload.
  8. `createCert({ orderId, scope: "SHIPMENT", shipperId }, tx)` for every order whose `certRequired` is true **and** whose `certScope` is `SHIPMENT` (§6.2).
  9. `recomputeOrderStatus(tx, orderIds)`.
  10. Collect `warnings[]` per §5.7 — missing cert, serialization-required with no serials selected, over-ship — each **naming the order and line**.

  `clientRequestId` collisions answer with the existing shipment (`deduped: true`) — reuse `orders.ts`'s `isDuplicateClientRequestId` discrimination, which reads the driver adapter's `constraint.fields` because `meta.target` is empty on this stack.
- [ ] **Step 5: Implement `getShipper`** with the full `ShipperDetail` projection, computing `shippedToDate*` per line via `shippedTotals` and `label` as `${orderNumber}-${sequence}`.
- [ ] **Step 6: Run the tests** — PASS.
- [ ] **Step 7: Add the concurrency tests** — two `createShipper` calls racing on one order get distinct packing-list numbers and distinct sequences; two multi-order saves over `{A,B}` and `{B,A}` driven concurrently both complete (no deadlock, no 500).
- [ ] **Step 8: Complete `SNAPSHOT_INCLUDE.shipper` (Task 2 review, spec §7).** Task 2 shipped `orders: { include: { order: { select: { orderNumber } } } }`, but spec §7 says the shipper snapshot pulls its orders "with order **and customer** selects" — without it a shipment's history diff renders `customerId`, `carrierId` and `shipToAddressId` as raw cuids, which is the unreadable-history shape issue #24 exists to prevent. Add the customer select (and the carrier/ship-to name selects on the shipper itself), then assert audit **content**: creating a shipment produces a snapshot naming the customer by code, not by cuid.
- [ ] **Step 9: Gates + commit** — `feat(shipping): create shipments with sorted claims, credit hold and idempotency`

---

