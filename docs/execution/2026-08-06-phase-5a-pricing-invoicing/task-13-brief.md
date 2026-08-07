### Task 13: `invoices.ts` — finalize, unlock, and status ownership

> **Carried in from Task 10 (2026-08-07). Finalize and unlock MUST `claimOrder` before they
> flip invoice state.** Task 10's invoice guards (`refuseIfInvoiced` across the order and shipment
> mutators) rest on the house rule that the guarded state is read under the claimed row — each of
> those mutators claims its order/shipper, then reads the finalized-invoice state fresh. For that
> to actually serialize, the *other* side — the transition that makes an invoice FINALIZED, and the
> unlock that clears it — must take the same order claim first. If finalize flips the invoice
> without claiming the order, a shipment edit and a finalize can interleave: the edit's
> `refuseIfInvoiced` reads "not yet finalized" while the finalize commits, and the edit changes
> what the invoice then bills. Claim the order(s) in `claimOrdersInOrder` order at the top of both
> finalize and unlock, before reading or writing invoice state. Task 10's source documents this
> dependency at the guard; do not treat it as optional.
>
> **Also carried in from Task 12 (2026-08-07): unlock MUST return status to `DRAFT`.** Only
> `DRAFT` and `FINALIZED` exist (`invoice-constants.ts`), and Task 12's `claimLiveInvoice` refuses
> edits on a FINALIZED invoice specifically (`invoices.ts` ~line 741) — so the entire editability
> of an unlocked invoice hinges on unlock setting the status back to `DRAFT`. If unlock leaves it
> `FINALIZED` (or invents a third state the guard doesn't know), every Task 12 mutator keeps
> refusing and "unlock" does nothing a user can act on. Test that after unlock, `updateInvoice` /
> `replaceInvoiceLines` / `recalculateInvoice` / `discardInvoice` all succeed again.

**Files:**
- Modify: `src/server/invoices.ts`, `src/server/ship-ledger.ts`
- Test: `tests/invoices.test.ts` (appended), `tests/ship-ledger.test.ts` (appended)

**Interfaces:**
- Produces: `finalizeInvoice(id: string): Promise<InvoiceDetail>`, `unlockInvoice(id: string, reason: string): Promise<InvoiceDetail>`; `recomputeOrderStatus` gains its invoice-owned-state skip.

- [ ] **Step 1: Write the failing tests:**

```ts
it("refuses to finalize while a line needs a price", async () => {
  const { invoice } = await draftFixture({ priced: false });
  await expect(asSystem(() => finalizeInvoice(invoice.id))).rejects.toThrow(/needs a price/i);
});

it("finalizes, stamps the finalizer, and sets the order INVOICED", async () => {
  const { order, invoice } = await draftFixture();
  const done = await asSystem(() => finalizeInvoice(invoice.id));
  expect(done.status).toBe("FINALIZED");
  expect(done.finalizedAt).not.toBeNull();
  expect((await getOrder(order.id)).status).toBe("INVOICED");
});

it("finalizing twice is a 400, never a second write", async () => {
  const { invoice } = await draftFixture();
  await asSystem(() => finalizeInvoice(invoice.id));
  await expect(asSystem(() => finalizeInvoice(invoice.id))).rejects.toThrow(/already finalized/i);
});

it("finalizes with a step code that has no GL account (5C's export refuses, not this)", async () => {
  const { invoice } = await draftFixture({ glAccount: null });
  await expect(asSystem(() => finalizeInvoice(invoice.id))).resolves.toBeTruthy();
});

it("unlocks with a reason, records it in the audit entry, and returns the order to SHIPPED", async () => {
  const { order, invoice } = await draftFixture();
  await asSystem(() => finalizeInvoice(invoice.id));
  await expect(asSystem(() => unlockInvoice(invoice.id, "  "))).rejects.toThrow(/reason/i);
  await asSystem(() => unlockInvoice(invoice.id, "wrong PO on the paper"));
  expect((await getInvoice(invoice.id)).status).toBe("DRAFT");
  expect((await getOrder(order.id)).status).toBe("SHIPPED");
  const entry = await prisma.auditLog.findFirst({
    where: { entity: "invoice", entityId: invoice.id, action: "update" }, orderBy: { at: "desc" } });
  expect(entry!.reason).toBe("wrong PO on the paper");
});

it("unlock stays available after the invoice has printed", async () => {
  const { invoice } = await draftFixture();
  await asSystem(() => finalizeInvoice(invoice.id));
  await prisma.storedDocument.create({
    data: { kind: "INVOICE", invoiceId: invoice.id, fileData: new Uint8Array([1]) } });
  await expect(asSystem(() => unlockInvoice(invoice.id, "customer disputed a line"))).resolves.toBeTruthy();
});
```

  and in `tests/ship-ledger.test.ts`:

```ts
it("leaves an INVOICED order alone", async () => {
  const { order } = await shippedOrder();
  await prisma.order.update({ where: { id: order.id }, data: { status: "INVOICED" } });
  await prisma.$transaction((tx) => recomputeOrderStatus(tx, [order.id]));
  expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("INVOICED");
});

it("leaves a REOPENED order alone", async () => { /* same, with REOPENED */ });
```

- [ ] **Step 2: Run to verify failure**, then implement.
- [ ] **Step 3: `recomputeOrderStatus` gains the skip** (`ship-ledger.ts:112`), beside its existing voided-order skip, with the reasoning in a comment:

```ts
// INVOICED and REOPENED are INVOICE-OWNED states (5A §5.2): finalize writes INVOICED, a reversing
// shipment writes REOPENED, unlock hands the order back to this function. Any shipment-side
// recompute that ran while an order sat in one of them would silently drop it back to SHIPPED —
// the same reason voided orders are skipped: this function derives one thing, and does not own
// the states another subsystem set.
const INVOICE_OWNED: OrderStatus[] = ["INVOICED", "REOPENED"];
// …then, inside the per-order loop:
if (INVOICE_OWNED.includes(order.status)) continue;
```

- [ ] **Step 4: `finalizeInvoice`** — the shared claim bracket, refuse when already `FINALIZED` (400 `"That invoice is already finalized"`), refuse when any line has `needsPrice` (400 naming the first offending line), then one `auditedUpdate` setting `status`, `finalizedAt`, `finalizedById` (from `currentActor()` — `src/server/context.ts`), then `tx.order.update` to `INVOICED` **through `auditedUpdate("order", …)`** so the status change is on the order's own history. **No GL check** — spec §15 puts that on the export.
- [ ] **Step 5: `unlockInvoice`** — `mustDo` is the route's; the **reason is required and trimmed in the service** (§5.17's shape, `voidShipper`'s precedent). One `auditedUpdate("invoice", id, …, { tx, reason })` clearing `status`/`finalizedAt`/`finalizedById`, then `recomputeOrderStatus(tx, [orderId])` — which now returns the order to its ship-derived value because the skip only fires while the order is still in an invoice-owned state, and the invoice is no longer finalized when it runs. **Order matters: clear the invoice first, recompute second.** Add a test asserting exactly that ordering, because the reverse silently leaves the order `INVOICED` forever.
- [ ] **Step 6: Run the tests, then gates + commit** — `feat: finalize and unlock an invoice; INVOICED and REOPENED become reachable`

---

