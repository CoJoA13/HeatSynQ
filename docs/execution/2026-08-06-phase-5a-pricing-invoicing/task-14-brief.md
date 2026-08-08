### Task 14: Credits

**Files:**
- Modify: `src/server/invoices.ts`
- Test: `tests/invoices.test.ts` (appended)

**Interfaces:**
- Consumes: `allocateNumber("credit_number_next", tx)`.
- Produces: `createCredit(invoiceId: string): Promise<InvoiceDetail>`.

- [ ] **Step 1: Write the failing tests:**

```ts
it("derives a credit from a finalized invoice with the sign flipped", async () => {
  const { invoice } = await finalizedFixture({ total: 937.44 });
  const credit = await asSystem(() => createCredit(invoice.id));
  expect(credit.kind).toBe("CREDIT");
  expect(credit.status).toBe("DRAFT");
  expect(credit.sourceInvoiceId).toBe(invoice.id);
  expect(credit.creditNumber).toBe(1000);
  expect(credit.documentNumber).toBe("1000");
  expect(credit.total).toBe(-937.44);
  expect(credit.lines.find((l) => l.kind === "OPERATION")!.amount).toBe(-937.44);
});

it("refuses a credit against a draft", async () => {
  const { invoice } = await draftFixture();
  await expect(asSystem(() => createCredit(invoice.id))).rejects.toThrow(/finalized/i);
});

it("allows a second credit against the same invoice, with its own number", async () => {
  const { invoice } = await finalizedFixture();
  const a = await asSystem(() => createCredit(invoice.id));
  const b = await asSystem(() => createCredit(invoice.id));
  expect(b.creditNumber).toBe(a.creditNumber! + 1);
});

it("can be reduced to a partial amount and finalized without touching the order status", async () => {
  const { order, invoice } = await finalizedFixture();
  const credit = await asSystem(() => createCredit(invoice.id));
  const reduced = await asSystem(() => replaceInvoiceLines(credit.id,
    credit.lines.map((l) => (l.kind === "OPERATION" ? { ...toLineInput(l), amount: "-100.00" } : toLineInput(l)))));
  expect(reduced.total).toBe(-100);
  await asSystem(() => finalizeInvoice(credit.id));
  expect((await getOrder(order.id)).status).toBe("INVOICED");   // unchanged by the credit
});

it("never frees a credit number when the draft is discarded", async () => {
  const { invoice } = await finalizedFixture();
  const credit = await asSystem(() => createCredit(invoice.id));
  await asSystem(() => discardInvoice(credit.id, "raised in error"));
  const next = await asSystem(() => createCredit(invoice.id));
  expect(next.creditNumber).toBe(credit.creditNumber! + 1);
});
```

- [ ] **Step 2: Run to verify failure**, then implement `createCredit`: claim the order, then the **source invoice** row, then re-read; refuse unless the source is a live `FINALIZED` `INVOICE`; `allocateNumber("credit_number_next", tx)` inside the claim; copy every header snapshot and every line with `amount` negated (and `qty`/`weight` left as they are — the paper says what was billed, the money says which way it goes); `auditedCreate`. Finalizing a `CREDIT` writes **no** order status (Task 13's finalize branches on `kind`).
- [ ] **Step 3: Run the tests, then gates + commit** — `feat: credits derived from finalized invoices`

---

