### Task 11: `invoices.ts` — candidates and creation

> **Carried in from Task 9 (2026-08-07). Two seams the pricing engine deliberately left for you.**
>
> 1. **Every CHARGE line arrives with a null GL account.** `ChargeInput` carries no `GlRef`, while
>    freight, cert and tax all do — so `priceOrder` cannot attach one, and it was implemented that
>    way deliberately (exactly as the brief specified; no amount is affected). `BillingConfig`
>    already holds `otherChargeGlAccountId` for precisely this. **Assign it here** when you build
>    the invoice line, or a whole class of charge lines posts to no account and the GL export is
>    silently incomplete. Do not "fix" it by widening `ChargeInput` in `pricing.ts` — that module
>    is pure by contract and takes no dependency on `billing-config.ts`.
> 2. **`SurchargeRow.glAccountName` is `string | null` upstream but `string` in the engine's
>    output type.** There is a `?? ""` at this seam. Task 9's review ruled `string` is the correct
>    target — `InvoiceLine.glAccountName` is `String @default("")`, NOT NULL — so `?? ""` is a
>    correct normalization rather than a workaround, and because the types genuinely do not unify
>    it is a compile error and cannot be silently skipped. Just do it deliberately.
> 3. **Never hand the engine a line whose net shipped total is zero.** `priceOrder` bills
>    `max(extended, minimumCharge) + setupCharge`, so a zero-quantity line returns the **full
>    minimum plus setup** — pinned in `tests/pricing.test.ts` as $600 + $75 = $675 at
>    `shippedQty: 0`. That is the spec's stated formula and is deliberate, not a bug. But it means
>    a fully-returned or zero-net line reaching the engine bills $675 for no work. Task 9's report
>    asserts you only feed lines with a non-zero net shipped total — **make that explicit and test
>    it**, because nothing downstream of the engine catches it.

**Files:**
- Create: `src/server/invoices.ts`
- Test: `tests/invoices.test.ts`

**Interfaces:**
- Consumes: `priceOrder` + its input types (Task 9), `shippedTotals` (`ship-ledger.ts:31`), `claimOrder` (`order-locks.ts:63`), `getBillingConfig` (Task 3), `listSurcharges` / `listCustomerSurcharges` (Task 6), `listPartPrices` (Task 4), `isDuplicateClientRequestId` (**exported from `src/server/orders.ts`** — reuse it, do not re-derive the P2002 sniff), `assertRefExists`, `auditedCreate`, `withDbErrors`.
- Produces:
```ts
// src/server/invoices.ts
export type InvoiceLineDetail = { /* every InvoiceLine column, Decimals as numbers */ };
export type InvoiceDetail = {
  id: string; kind: InvoiceKindValue; status: InvoiceStatusValue;
  orderId: string; orderNumber: number; documentNumber: string;   // prefix + orderNumber, or the credit number
  sourceInvoiceId: string | null; creditNumber: number | null;
  customerId: string; customerCode: string; customerName: string;
  invoiceDate: string; poNumber: string; termsName: string;
  billTo: string; shipTo: string; materialName: string; processNames: string;
  taxRate: number | null;
  subtotal: number; surchargeTotal: number; chargeTotal: number;
  certTotal: number; freightTotal: number; taxTotal: number; total: number;
  finalizedAt: string | null; deletedAt: string | null;
  lines: InvoiceLineDetail[];
};
export type InvoiceCandidate = {
  orderId: string; orderNumber: number; customerCode: string; customerName: string;
  poNumber: string; lastShipDate: string | null;
};
export type InvoiceCreateResult = { invoice: InvoiceDetail; warnings: string[]; deduped: boolean };
export async function listInvoiceCandidates(filter: { customerId?: string; from?: string; to?: string }): Promise<InvoiceCandidate[]>;
export async function readInvoiceDetail(db: Db, id: string): Promise<InvoiceDetail>;
export async function getInvoice(id: string): Promise<InvoiceDetail>;
export async function createInvoice(input: unknown): Promise<InvoiceCreateResult>;
export async function invoiceWarnings(detail: InvoiceDetail): Promise<string[]>;
```

- [ ] **Step 1: Write the fixture helpers.** Copy `asSystem`, `makeCustomer`, `makePart`, `giveSteps`, `savedOrder` and `oneOrderInput` from `tests/shippers.test.ts:1-143` into `tests/invoices.test.ts` (copying rather than importing across test files is this repo's existing convention), then add these six. **Tasks 12–15 and 19 all reuse them** — put them in a shared `tests/helpers/invoicing.ts` if a second file needs them, but they start here:

```ts
/** An order shipped to line-complete on every line → status SHIPPED. No pricing. */
async function shippedOrder(opts: { qty?: number } = {}) {
  const { order, part, customer } = await savedOrder({ qty: opts.qty ?? 144, weight: "3024.00" });
  const input = oneOrderInput(order);
  input.orders[0].lines[0].lineComplete = true;
  const { shipper } = await createShipper(input, { canOverrideCreditHold: false });
  return { order: await getOrder(order.id), part, customer, shipper };
}

/** Shipped, but nothing marked complete → status PARTIAL_SHIPPED. */
async function partiallyShippedOrder() {
  const { order, part, customer } = await savedOrder({ qty: 144, weight: "3024.00" });
  const input = oneOrderInput(order);
  input.orders[0].lines[0].qty = 10;
  const { shipper } = await createShipper(input, { canOverrideCreditHold: false });
  return { order: await getOrder(order.id), part, customer, shipper };
}

/** `shippedOrder`, plus one PartPrice row on its part and a GL account behind the step code. */
async function pricedShippedOrder(opts: {
  qty?: number; unitPrice?: string; minimumCharge?: string; setupCharge?: string;
  pricePer?: string; glAccount?: string | null;
} = {}) {
  const fixture = await shippedOrder({ qty: opts.qty });
  const gl = opts.glAccount === null ? null
    : await prisma.glAccount.create({ data: { name: opts.glAccount ?? "4010", description: "Sales" } });
  const code = await prisma.processStepCode.create({
    data: { code: "AUST", name: "Austemper", glAccountId: gl?.id ?? null } });
  await asSystem(() => addPartPrice(fixture.part.id, {
    processStepCodeId: code.id, position: 1,
    unitPrice: opts.unitPrice ?? "6.5100",
    minimumCharge: opts.minimumCharge ?? "600.00",
    ...(opts.setupCharge ? { setupCharge: opts.setupCharge } : {}),
    pricePer: opts.pricePer ?? "EACH",
  }));
  return { ...fixture, stepCode: code, glAccount: gl };
}

/** A DRAFT invoice over a priced, shipped order. `priced: false` skips the price row so every
 *  line comes back needing a price; `glAccount: null` leaves the step code without an account. */
async function draftFixture(opts: {
  qty?: number; priced?: boolean; glAccount?: string | null;
} = {}) {
  const fixture = opts.priced === false
    ? await shippedOrder({ qty: opts.qty })
    : await pricedShippedOrder({ qty: opts.qty, glAccount: opts.glAccount });
  const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
  return { ...fixture, invoice };
}

/** A FINALIZED invoice. */
async function finalizedFixture(opts: { qty?: number } = {}) {
  const fixture = await draftFixture({ qty: opts.qty });
  const invoice = await asSystem(() => finalizeInvoice(fixture.invoice.id));
  return { ...fixture, invoice };
}

/** One saved line back into the shape `replaceInvoiceLines` accepts — every editable field, so a
 *  round trip through it changes nothing by itself. */
function toLineInput(l: InvoiceLineDetail) {
  return {
    kind: l.kind, parentPosition: l.parentLineId === null ? null : undefined,
    orderLineId: l.orderLineId, processStepCodeId: l.processStepCodeId,
    surchargeId: l.surchargeId, orderChargeId: l.orderChargeId, glAccountId: l.glAccountId,
    partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
    description: l.description, glAccountName: l.glAccountName,
    qty: l.qty, weight: l.weight === null ? null : String(l.weight),
    eachWeight: l.eachWeight === null ? null : String(l.eachWeight),
    pricePer: l.pricePer,
    unitPrice: l.unitPrice === null ? null : String(l.unitPrice),
    setupCharge: l.setupCharge === null ? null : String(l.setupCharge),
    minimumCharge: l.minimumCharge === null ? null : String(l.minimumCharge),
    breakThreshold: l.breakThreshold === null ? null : String(l.breakThreshold),
    minimumApplied: l.minimumApplied, rate: l.rate === null ? null : String(l.rate),
    priceSource: l.priceSource, needsPrice: l.needsPrice, amount: String(l.amount),
  };
}

/** Ships `extra` more of the order's first line on a second shipment. */
async function shipMore(order: OrderDetail, extra: number) {
  const input = oneOrderInput(order);
  input.orders[0].lines[0].qty = extra;
  input.orders[0].lines[0].weight = 0;
  input.orders[0].lines[0].lineComplete = true;
  return createShipper(input, { canOverrideCreditHold: false });
}
```

  Tasks 15 and 19 use two more names for readability: **`shippedFixture` is `shippedOrder`** (same helper, the shipping-side name), and **`invoicedFixture` is `finalizedFixture`**. Use one name each; do not write two helpers that do the same thing.

  Then the tests themselves:

```ts
it("lists only orders at SHIPPED with no live invoice", async () => {
  const { order } = await shippedOrder();                       // line-complete, status SHIPPED
  expect((await listInvoiceCandidates({})).map((c) => c.orderNumber)).toEqual([order.orderNumber]);
  await asSystem(() => createInvoice({ orderId: order.id }));
  expect(await listInvoiceCandidates({})).toEqual([]);
});

it("excludes a partially shipped order and a voided one", async () => {
  const { order } = await partiallyShippedOrder();
  expect(await listInvoiceCandidates({})).toEqual([]);
  const { order: voided } = await shippedOrder();
  await prisma.order.update({ where: { id: voided.id }, data: { deletedAt: new Date() } });
  expect(await listInvoiceCandidates({})).toEqual([]);
});

it("snapshots shipped quantities, part identity and the resolved price", async () => {
  const { order } = await pricedShippedOrder({ qty: 144, unitPrice: "6.5100", minimumCharge: "600.00" });
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  const part = invoice.lines.find((l) => l.kind === "PART")!;
  const op = invoice.lines.find((l) => l.kind === "OPERATION")!;
  expect(part.qty).toBe(144);
  expect(op.amount).toBe(937.44);
  expect(op.unitPrice).toBe(6.51);
  expect(op.minimumCharge).toBe(600);
  expect(op.priceSource).toBe("PART_PRICE");
  expect(op.glAccountName).toBe("4010");
  expect(invoice.total).toBe(937.44);
});

it("numbers an invoice by its order and carries the prefix", async () => {
  await setSetting("invoice_number_prefix", "7");
  const { order } = await pricedShippedOrder();
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  expect(invoice.documentNumber).toBe(`7 - ${order.orderNumber}`);
  expect(invoice.creditNumber).toBeNull();
});

it("refuses a second live invoice for one order", async () => {
  const { order } = await pricedShippedOrder();
  await asSystem(() => createInvoice({ orderId: order.id }));
  await expect(asSystem(() => createInvoice({ orderId: order.id })))
    .rejects.toThrow(/already has an invoice/i);
});

it("allows a new invoice after the first draft is discarded", async () => {
  const { order } = await pricedShippedOrder();
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  await prisma.invoice.update({ where: { id: invoice.id }, data: { deletedAt: new Date() } });
  const second = await asSystem(() => createInvoice({ orderId: order.id }));
  expect(second.invoice.id).not.toBe(invoice.id);
});

it("returns the first invoice for a repeated clientRequestId", async () => {
  const { order } = await pricedShippedOrder();
  const input = { orderId: order.id, clientRequestId: "nonce-1" };
  const a = await asSystem(() => createInvoice(input));
  const b = await asSystem(() => createInvoice(input));
  expect(b.deduped).toBe(true);
  expect(b.invoice.id).toBe(a.invoice.id);
  expect(await prisma.invoice.count()).toBe(1);
});

it("warns, never blocks, on a line with no price", async () => {
  const { order } = await shippedOrder();                        // no PartPrice rows at all
  const { invoice, warnings } = await asSystem(() => createInvoice({ orderId: order.id }));
  expect(invoice.lines.some((l) => l.needsPrice)).toBe(true);
  expect(warnings.join(" ")).toMatch(/needs a price/i);
});

it("bills freight, an extra charge, the cert charge and tax, each with its own GL account", async () => {
  const freightGl = await prisma.glAccount.create({ data: { name: "4300", description: "Freight" } });
  const otherGl = await prisma.glAccount.create({ data: { name: "4400", description: "Other charges" } });
  const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
  const certCode = await prisma.processStepCode.create({
    data: { code: "CERT", name: "Certification", glAccountId: otherGl.id } });
  await asSystem(() => setBillingConfig({
    freightGlAccountId: freightGl.id, otherChargeGlAccountId: otherGl.id,
    salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000",
    certChargeStepCodeId: certCode.id, certChargeDefault: "25.00", billForCertDefault: true,
  }));

  const { order, part, shipper } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
  await prisma.part.update({ where: { id: part.id }, data: { billForCert: true } });
  await prisma.order.update({ where: { id: order.id }, data: { certRequired: true } });
  await prisma.shipper.update({
    where: { id: shipper.id }, data: { billFreight: true, freightAmount: "150.00" } });
  await asSystem(() => replaceCharges(order.id, [{ description: "Rush", amount: "10.00" }]));

  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  const byKind = new Map(invoice.lines.map((l) => [l.kind, l]));
  expect(byKind.get("FREIGHT")!.amount).toBe(150);
  expect(byKind.get("FREIGHT")!.glAccountName).toBe("4300");
  expect(byKind.get("CHARGE")!.amount).toBe(10);
  expect(byKind.get("CHARGE")!.glAccountName).toBe("4400");
  expect(byKind.get("CERT")!.amount).toBe(25);
  expect(byKind.get("CERT")!.glAccountName).toBe("4400");
  // 4% of (100 operations + 10 charge + 25 cert) — freight excluded (ruling 8).
  expect(byKind.get("TAX")!.amount).toBe(5.4);
  expect(byKind.get("TAX")!.glAccountName).toBe("2200");
  expect(invoice.total).toBe(290.4);   // 100 + 10 + 25 + 150 + 5.40
});

it("prints no tax line for a customer who is not taxable", async () => {
  const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
  await asSystem(() => setBillingConfig({ salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000" }));
  const { order, customer } = await pricedShippedOrder();
  await prisma.customer.update({ where: { id: customer.id }, data: { taxable: false } });
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  expect(invoice.lines.some((l) => l.kind === "TAX")).toBe(false);
  expect(invoice.taxTotal).toBe(0);
});

it("prefers the customer's own tax rate over the plant rate", async () => {
  await asSystem(() => setBillingConfig({ salesTaxRate: "0.040000" }));
  const { order, customer } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
  await prisma.customer.update({ where: { id: customer.id }, data: { salesTaxRate: "0.100000" } });
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  expect(invoice.taxTotal).toBe(10);
  expect(invoice.taxRate).toBe(0.1);          // snapshotted on the header
});

it("suppresses the certification charge for a customer flagged for it", async () => {
  const certCode = await prisma.processStepCode.create({ data: { code: "CERT", name: "Certification" } });
  await asSystem(() => setBillingConfig({
    certChargeStepCodeId: certCode.id, certChargeDefault: "25.00", billForCertDefault: true }));
  const { order, customer } = await pricedShippedOrder();
  await prisma.order.update({ where: { id: order.id }, data: { certRequired: true } });
  await prisma.customer.update({ where: { id: customer.id }, data: { certChargeSuppressed: true } });
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  expect(invoice.lines.some((l) => l.kind === "CERT")).toBe(false);
});

it("audits the create with the lines in the snapshot", async () => {
  const { order } = await pricedShippedOrder();
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  const entry = await prisma.auditLog.findFirst({ where: { entity: "invoice", entityId: invoice.id } });
  expect(entry!.action).toBe("create");
  expect(JSON.stringify(entry!.after)).toContain("937.44");
});
```

  Plus **the discriminating concurrency test**, copied in shape from `tests/certs.test.ts:110-177` — including its leading comment, which explains why the competing caller must be pinned to Read Committed:

```ts
it("blocks a concurrent create under Read Committed until the holder commits, then refuses (row-lock discipline)", async () => {
  const { order } = await pricedShippedOrder();
  // Holder: default isolation, claims the Order row, commits an invoice while still holding it.
  // Competitor: createInvoice called against a MANUALLY OPENED default-isolation tx, so SSI is
  // out of the picture and claimOrder's row lock is the only thing that can serialize the two.
  // Verified by deleting the claim and watching this go red.
  // …the certs.test.ts body, with cert.create swapped for invoice.create and the expected
  //   refusal /already has an invoice/i…
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/invoices.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Write the read side of `src/server/invoices.ts`** — `DETAIL_INCLUDE` + `toInvoiceDetail` + `readInvoiceDetail(db, id)` + `getInvoice`, on `readShipperDetail`'s exact shape (`shippers.ts:230-347`). Two differences that matter:
  - **Read the snapshot unconditionally** (§5.4). Unlike `toDetail`'s `l.orderLine?.part.partNumber ?? l.partNumber`, an invoice line reads `l.partNumber` full stop. Put the reason in a comment: an invoice is frozen paper, and ruling 24's refinement says a frozen document reads its snapshot, never live-join-first.
  - `documentNumber` is computed: `kind === "CREDIT" ? String(creditNumber) : prefix === "" ? String(orderNumber) : \`${prefix} - ${orderNumber}\``.
  - Never filter `deletedAt` on the read — a discarded draft stays readable, the `readDetail` precedent for a voided order.

- [ ] **Step 4: Write `listInvoiceCandidates`** — `prisma.order.findMany({ where: { deletedAt: null, status: "SHIPPED", invoices: { none: { kind: "INVOICE", deletedAt: null } } }, … })`, plus the customer and ship-date-range filters, ordered by order number. `lastShipDate` is the max `shipDate` across the order's live shipments.

- [ ] **Step 5: Write `createInvoice`.** The bracket, in order — this is `saveNewShipper` (`shippers.ts:349-630`) with the shipment parts removed:

```
CREATE = z.object({ orderId: z.string().min(1), clientRequestId: z.string().min(1).max(200).optional(),
                    invoiceDate: z.string().optional() }).strict()

read the billing config, the active surcharges and today's date OUTSIDE the transaction
withDbErrors({ entity: "Invoice" }) → prisma.$transaction(Serializable):
  order = claimOrder(tx, orderId)                       // 404 missing, 400 voided
  refuse unless order.status === "SHIPPED"              // "Only a fully shipped order can be invoiced"
  refuse if a live INVOICE already exists for it        // findFirst, NEVER findUnique
  read the customer (code, name, terms, taxable, salesTaxRate, certChargeSuppressed,
                     surchargeOptOut, surchargeRules) and the bill-to / ship-to addresses
  shipped = shippedTotals(tx, order.lines.map(l => l.id))
  build the PricingInput: one OrderLineInput per line with a non-zero net shipped total,
     its part's live PartPrice rows (with their live breaks and each row's step code's GL),
     the surcharges after per-customer opt-out/override, the live OrderCharges,
     freight = sum of billFreight amounts across live shipments (+ the config's freight GL),
     cert    = the §6 resolution (order.certRequired && lead part billForCert ?? config default),
     tax     = customer.taxable ? { rate: customer.salesTaxRate ?? config.salesTaxRate } : null
  computed = priceOrder(input)                          // the pure engine — all the math
  auditedCreate("invoice", payload, () => tx.invoice.create({ data: { …header, lines: { create: … } } }))
     — write PART lines first, then patch each OPERATION line's parentLineId in a second pass,
       since a self-relation cannot be satisfied in one nested create
  return readInvoiceDetail(tx, invoice.id)
```

  Idempotent replay sits **outside** the transaction and inside `withDbErrors`, exactly as `createShipper` does it (`shippers.ts:645-665`): catch, `isDuplicateClientRequestId(err)`, re-read by `clientRequestId`, and **recompute the warnings** for the replay (#50's lesson — the lost-response retry is precisely when the operator never saw them).

- [ ] **Step 6: Write `invoiceWarnings(detail)`** — pure over the detail: one entry per `needsPrice` line naming it (`"Line 1 · A16-21591-000 — Austemper needs a price"`), plus one per line whose step code has no GL account (advisory in 5A; 5C's export refuses). Wire it into an `invoiceResponse` helper in Task 16, the `src/app/api/shippers/response.ts` precedent, so **every** mutating route returns the same `{ invoice, warnings }` shape and no route can silently drop them.

- [ ] **Step 7: Run the tests** — `npx vitest run tests/invoices.test.ts`. Expected: PASS.
- [ ] **Step 8: Verify the concurrency test discriminates** — delete `claimOrder` from `createInvoice`, re-run that one test, confirm it goes **RED**, restore, confirm GREEN. Paste both transcripts into the task report. A passing race test with the guard removed is not evidence.
- [ ] **Step 9: Gates + commit** — `feat: create invoices from shipped orders, snapshotting prices and quantities`

---

