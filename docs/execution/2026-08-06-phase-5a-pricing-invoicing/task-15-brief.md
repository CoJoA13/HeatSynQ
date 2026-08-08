### Task 15: The reversing shipment

> **Carried in from Task 13's review (2026-08-07). Write `REOPENED` DIRECTLY; do NOT pass
> `released` to `recomputeOrderStatus`.** Task 13 added a `released` third arg to
> `recomputeOrderStatus` (`ship-ledger.ts`) that forces a recompute past the invoice-owned skip —
> it exists **solely so unlock can return an order to its ship-derived value**, and a grep-verified
> invariant is that unlock (`invoices.ts`) is its only caller. A reversing shipment against an order
> with a finalized invoice must set `Order.status = REOPENED` **directly** (spec §5.2), NOT by
> calling `recomputeOrderStatus(..., released)` — passing `released` from a shipment path is exactly
> the hole the skip exists to close (it would let a shipment-side recompute drop an invoice-owned
> status). Keep `recomputeOrderStatus`'s two-arg form on every shipment path, as all eight existing
> `shippers.ts` sites already do.

**Files:**
- Modify: `src/server/shippers.ts`, `prisma/schema.prisma` (already done in Task 2 — `reversesShipperId`), `src/server/ship-ledger.ts` (over-ship warning against the net total)
- Create: `src/app/api/shippers/[id]/reverse/route.ts`
- Test: `tests/shipper-reverse.test.ts`

**Interfaces:**
- Consumes: `claimOrdersInOrder`, `recomputeOrderStatus`, `finalizedInvoicesFor` (Task 10), `shippedTotals`.
- Produces: `reverseShipper(id: string, input: unknown): Promise<ShipperCreateResult>`.

- [ ] **Step 1: Write the failing tests:**

```ts
it("creates a negative shipment that nets the ledger down", async () => {
  const { order, shipper } = await shippedFixture({ qty: 100 });
  const { shipper: reversal } = await reverseShipper(shipper.id, { reason: "wrong parts loaded" });
  expect(reversal.orders[0].lines[0].qty).toBe(-100);
  const totals = await shippedTotals(prisma, [order.lines[0].id]);
  expect(totals.get(order.lines[0].id)!.qty).toBe(0);
});

it("sets REOPENED when the order has a finalized invoice, and leaves the status derived otherwise", async () => {
  const { order: a, shipper: sa } = await invoicedFixture();
  await reverseShipper(sa.id, { reason: "returned" });
  expect((await getOrder(a.id)).status).toBe("REOPENED");

  const { order: b, shipper: sb } = await shippedFixture();      // never invoiced
  await reverseShipper(sb.id, { reason: "returned" });
  expect((await getOrder(b.id)).status).toBe("OPEN");            // derived, ledger back to zero
});

it("refuses to drive a line below zero", async () => {
  const { shipper } = await shippedFixture({ qty: 100 });
  await reverseShipper(shipper.id, { reason: "first" });
  await expect(reverseShipper(shipper.id, { reason: "second" }))
    .rejects.toThrow(/below zero/i);
});

it("requires a reason and the void_shipper action", async () => {
  const { shipper } = await shippedFixture();
  await expect(reverseShipper(shipper.id, { reason: "  " })).rejects.toThrow(/reason/i);
  // route-level: 403 without action.void_shipper
});

it("keeps its own packing-list number and never reuses the original's", async () => {
  const { shipper } = await shippedFixture();
  const { shipper: reversal } = await reverseShipper(shipper.id, { reason: "returned" });
  expect(reversal.shipperNumber).not.toBe(shipper.shipperNumber);
  expect(reversal.orders[0].sequence).toBe(shipper.orders[0].sequence + 1);
});

it("raises no over-ship warning for a reversal", async () => {
  const { shipper } = await shippedFixture({ qty: 100 });
  const { warnings } = await reverseShipper(shipper.id, { reason: "returned" });
  expect(warnings.join(" ")).not.toMatch(/exceeds the remaining/i);
});
```

- [ ] **Step 2: Run to verify failure**, then implement `reverseShipper`. It is `saveNewShipper` with four differences, and it **reuses that function's claim and recompute machinery rather than growing a second path**:
  - every line's `qty` and `weight` are the **negation** of the original shipment's, and `lineComplete` is `false`;
  - `reversesShipperId` is set, `shipDate` defaults to the original's;
  - a reason is required and trimmed in the service, and lands in the audit entry (`voidShipper`'s shape);
  - after the write, for every affected order that `finalizedInvoicesFor` names, write `REOPENED` through `auditedUpdate("order", …)`; for the rest, `recomputeOrderStatus` decides as usual.
- [ ] **Step 3: Relax the schema's non-negative guards** for reversal lines only — the zod `SHIP_LINE` schema keeps `min(0)` for ordinary saves, and the reversal builds its rows internally rather than through that schema. **Add a test that a normal `createShipper` still refuses a negative qty**, so relaxing it here cannot leak.
- [ ] **Step 4: The over-ship warning** (`shippers.ts`, inside `saveNewShipper`'s warning loop) already compares against `priorShipped`; confirm a negative line can never trip it and add the assertion above.
- [ ] **Step 5: The route** `POST /api/shippers/[id]/reverse` — `mustDo(requireUser(), "void_shipper")`, body `{ reason, shipDate? }`, returns `shipperResponse(...)`.
- [ ] **Step 6: Run the tests, then gates + commit** — `feat: reversing shipments — negative quantities, REOPENED, one claim path`

---

