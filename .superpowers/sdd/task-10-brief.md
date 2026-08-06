### Task 10: Void a shipment; the order edit invariants; the cert cascade

**Files:**
- Modify: `src/server/shippers.ts`, `src/server/orders.ts`
- Test: `tests/shipper-void.test.ts`, `tests/order-ship-invariants.test.ts`

**Interfaces:**
- Produces:
```ts
export async function voidShipper(id: string, reason: string): Promise<void>;
// orders.ts — used by updateLine/removeLine/voidOrder to refuse a contradiction of shipped fact
export async function shipmentBlockers(db: Db, orderId: string, orderLineId?: string): Promise<Blocker[]>;
```

- [ ] **Step 1: Write the failing tests** in `tests/shipper-void.test.ts`:

```ts
it("restores order status, keeps the number, and voids shipment-scoped certs", async () => {
  const { shipper, order, cert } = await completeShipmentWithShipmentCert();
  await voidShipper(shipper.id, "loaded onto the wrong truck");
  expect((await getOrder(order.id)).status).toBe("OPEN");
  expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).deletedAt).not.toBeNull();
  expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).shipperNumber)
    .toBe(shipper.shipperNumber);
});

it("keeps stored PDFs readable after a void", async () => {
  const { shipper } = await oneOrderShipment();
  const bytes = Buffer.from("%PDF-1.4 ticket");
  // storeDocument directly — printShippingTickets arrives in Task 18, and the refusal-to-reprint
  // assertion lives there with it. This task owns only the survival half.
  const doc = await prisma.$transaction((tx) =>
    storeDocument(tx, { kind: "SHIPPER", shipperId: shipper.id, orderId: null }, bytes));
  await voidShipper(shipper.id, "wrong truck");
  expect(Buffer.compare((await getDocument(doc.id)).fileData, bytes)).toBe(0);
});

it("requires a reason", async () => {
  const { shipper } = await oneOrderShipment();
  await expect(voidShipper(shipper.id, "\t ")).rejects.toThrow(/reason/i);
});
```

and in `tests/order-ship-invariants.test.ts`:

```ts
it("refuses removing a line that has shipments, naming the shipment", async () => {
  const { order, line, shipper } = await shipmentOfOneLine();
  await expect(removeLine(order.id, line.id))
    .rejects.toThrow(new RegExp(`Packing List ${shipper.shipperNumber}`));
});

it("refuses reducing a line below its shipped-to-date", async () => {
  const { order, line } = await shipmentOfOneLine({ ordered: 1000, shipped: 400 });
  await expect(updateLine(order.id, line.id, { qty: 300 })).rejects.toThrow(/400 already shipped/i);
  await expect(updateLine(order.id, line.id, { qty: 400 })).resolves.toBeTruthy();
});

it("refuses voiding an order with live shipments, and allows it after the shipment is voided", async () => {
  const { order, shipper } = await shipmentOfOneLine();
  await expect(voidOrder(order.id, "cancelled")).rejects.toThrow(/live shipment/i);
  await voidShipper(shipper.id, "cancelled too");
  await expect(voidOrder(order.id, "cancelled")).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `voidShipper`** — reason trimmed and required **in the service**; Serializable `$transaction`; `claimOrdersInOrder` over every order on the shipment; `auditedSoftDelete("shipper", …)`; `auditedSoftDelete("cert", …)` for every live cert with this `shipperId`, carrying the same reason; `recomputeOrderStatus`. Numbers and sequences are untouched.
- [ ] **Step 4: Implement `shipmentBlockers`** returning the shared `Blocker` shape (`entityLabel: "Shipment"`, `name: `Packing List ${shipperNumber}``, `href: /shipping/${id}`) so the refusals reuse the existing `BlockerPanel`, and wire it into `removeLine`, `updateLine` (qty/weight only, comparing against `shippedTotals`) and `voidOrder` — all **inside their existing claim-holding transactions**.
- [ ] **Step 5: Export the shared print guard** — `printTraveler` inlines its own voided check today. Extract it so Tasks 18–19 cannot forget it:

```ts
// src/server/documents.ts
export const VOIDED_PRINT = "This record is voided — no new documents can be produced for it";
/** Throws 400 VOIDED_PRINT when the owner is voided. Call inside the claim-holding transaction. */
export function assertPrintable(owner: { deletedAt: Date | null }): void;
```

Point `printTraveler` at it (its existing test must stay green), and unit-test it directly here. Tasks 18 and 19 call it for shipments and certs.
- [ ] **Step 6: Run the tests** — PASS.
- [ ] **Step 7: Gates + commit** — `feat(shipping): void with reason, cert cascade, and the order edit invariants`

---

