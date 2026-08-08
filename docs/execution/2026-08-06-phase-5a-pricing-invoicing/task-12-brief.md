### Task 12: `invoices.ts` — draft edits, recalculate, discard

**Files:**
- Modify: `src/server/invoices.ts`
- Test: `tests/invoices.test.ts` (appended)

**Interfaces:**
- Produces:
```ts
export async function updateInvoice(id: string, input: unknown): Promise<InvoiceDetail>;   // header only
export async function replaceInvoiceLines(id: string, input: unknown): Promise<InvoiceDetail>;
export async function recalculateInvoice(id: string): Promise<InvoiceDetail>;
export async function discardInvoice(id: string, reason: string): Promise<void>;
```

- [ ] **Step 1: Write the failing tests:**

```ts
it("refuses every edit on a finalized invoice", async () => {
  const { invoice } = await finalizedFixture();
  await expect(asSystem(() => updateInvoice(invoice.id, { poNumber: "X" })))
    .rejects.toThrow(/finalized/i);
  await expect(asSystem(() => replaceInvoiceLines(invoice.id, [])))
    .rejects.toThrow(/finalized/i);
  await expect(asSystem(() => recalculateInvoice(invoice.id))).rejects.toThrow(/finalized/i);
});

it("recalculates from the order and preserves manual lines", async () => {
  const { order, invoice } = await draftFixture({ qty: 144 });
  await asSystem(() => replaceInvoiceLines(invoice.id, [
    ...invoice.lines.map(toLineInput),
    { kind: "CHARGE", description: "Hand-typed", amount: "25.00", priceSource: "MANUAL" },
  ]));
  await shipMore(order, 6);                                     // ship 6 more of the line
  const after = await asSystem(() => recalculateInvoice(invoice.id));
  expect(after.lines.find((l) => l.kind === "PART")!.qty).toBe(150);
  expect(after.lines.some((l) => l.description === "Hand-typed")).toBe(true);
});

it("discards a draft with a reason and frees the order to be invoiced again", async () => {
  const { order, invoice } = await draftFixture();
  await expect(asSystem(() => discardInvoice(invoice.id, "  "))).rejects.toThrow(/reason/i);
  await asSystem(() => discardInvoice(invoice.id, "keyed against the wrong order"));
  const entry = await prisma.auditLog.findFirst({
    where: { entity: "invoice", entityId: invoice.id, action: "delete" } });
  expect(entry!.reason).toBe("keyed against the wrong order");
  const again = await asSystem(() => createInvoice({ orderId: order.id }));
  expect(again.invoice.id).not.toBe(invoice.id);
});

it("refuses to discard a draft that has printed", async () => {
  const { invoice } = await draftFixture();
  await prisma.storedDocument.create({
    data: { kind: "INVOICE", invoiceId: invoice.id, fileData: new Uint8Array([1]) } });
  await expect(asSystem(() => discardInvoice(invoice.id, "mistake")))
    .rejects.toThrow(/has already printed/i);
});

it("recomputes the totals after a line edit", async () => {
  const { invoice } = await draftFixture();
  const edited = await asSystem(() => replaceInvoiceLines(invoice.id,
    invoice.lines.map((l) => (l.kind === "OPERATION" ? { ...toLineInput(l), amount: "100.00" } : toLineInput(l)))));
  expect(edited.subtotal).toBe(100);
  expect(edited.total).toBe(100);
});
```

- [ ] **Step 2: Run to verify failure**, then implement. Every mutator shares the bracket:
  `withDbErrors` → Serializable `$transaction` → `claimOrder(tx, invoice.orderId)` → **claim the invoice row** (`SELECT "id" FROM "Invoice" WHERE "id" = ${id} FOR UPDATE`) → re-read → refuse if `status === "FINALIZED"` or `deletedAt !== null` → `auditedUpdate` → writes on `tx`. Factor the first four steps into a private `claimLiveInvoice(tx, id)` returning the fresh row — `claimLiveShipper`'s shape (`shippers.ts:708-719`), with the same ordering comment.
- [ ] **Step 3: `replaceInvoiceLines`** is a whole-array replace (the `replaceCharges` / `replaceShipperLines` precedent): delete every line, recreate from the payload at positions 1..n, re-wire `parentLineId` in a second pass, recompute the six totals from the rounded line amounts, one `auditedUpdate` for the lot. A line's `kind` and money fields are what the payload carries; snapshots (`partNumber` etc.) come from the payload too, since a manual line has no order-side row to read them from.
- [ ] **Step 4: `recalculateInvoice`** re-runs Task 11's whole build against current state, then replaces only the derived lines — every line whose `priceSource` is not `MANUAL` — keeping manual ones at the end. `discardInvoice` requires a trimmed reason **in the service** (§5.17), refuses when any `StoredDocument` names the invoice, and `auditedSoftDelete`s.
- [ ] **Step 5: Run the tests, then gates + commit** — `feat: invoice draft editing, recalculation and discard`

---

