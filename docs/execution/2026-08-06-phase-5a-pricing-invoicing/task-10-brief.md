### Task 10: `invoice-guards.ts` + the new order and shipment invariants

**Files:**
- Create: `src/server/invoice-guards.ts`
- Modify: `src/server/orders.ts` (`replaceCharges`, `voidOrder`), `src/server/shippers.ts` (`voidShipper`, `replaceShipperLines`, `addOrderToShipper`)
- Test: `tests/invoice-guards.test.ts`

**Interfaces:**
- Consumes: `HttpError`, Prisma's `TransactionClient`. **Nothing from `invoices.ts`** — that is the whole point of this module.
- Produces:
```ts
// src/server/invoice-guards.ts — a LEAF. orders.ts, shippers.ts and invoices.ts all import it;
// it imports none of them.
export type FinalizedInvoice = { id: string; orderId: string; orderNumber: number };
export async function finalizedInvoiceFor(tx: Prisma.TransactionClient, orderId: string): Promise<FinalizedInvoice | null>;
export async function finalizedInvoicesFor(tx: Prisma.TransactionClient, orderIds: string[]): Promise<FinalizedInvoice[]>;
export function invoiceBlockMessage(inv: FinalizedInvoice, action: string): string;
```

> **Why a leaf, before the cycle exists.** `orders.ts` and `shippers.ts` need to ask "does this order have a finalized invoice?", and `invoices.ts` needs to import both of them. Importing `invoices.ts` back would be the exact edge that crashed Phase 4 at module-evaluation time two tasks after it was added (lesson 3). `order-locks.ts` and `errors.ts` are the precedents; this is the third.

- [ ] **Step 1: Write the failing tests** `tests/invoice-guards.test.ts`, using a raw `prisma.invoice.create` fixture (Task 11's service does not exist yet — that is deliberate, this module must not depend on it):

```ts
async function finalizedInvoice(orderId: string, customerId: string) {
  return prisma.invoice.create({
    data: { orderId, customerId, kind: "INVOICE", status: "FINALIZED",
            invoiceDate: new Date("2026-08-06"), finalizedAt: new Date() },
  });
}

it("finds a finalized invoice and ignores a draft or a discarded one", async () => {
  const { order, customer } = await savedOrder();
  expect(await prisma.$transaction((tx) => finalizedInvoiceFor(tx, order.id))).toBeNull();

  const draft = await prisma.invoice.create({
    data: { orderId: order.id, customerId: customer.id, kind: "INVOICE",
            status: "DRAFT", invoiceDate: new Date("2026-08-06") } });
  expect(await prisma.$transaction((tx) => finalizedInvoiceFor(tx, order.id))).toBeNull();

  await prisma.invoice.update({ where: { id: draft.id }, data: { status: "FINALIZED" } });
  const found = await prisma.$transaction((tx) => finalizedInvoiceFor(tx, order.id));
  expect(found!.orderNumber).toBe(order.orderNumber);

  await prisma.invoice.update({ where: { id: draft.id }, data: { deletedAt: new Date() } });
  expect(await prisma.$transaction((tx) => finalizedInvoiceFor(tx, order.id))).toBeNull();
});

it("ignores a finalized CREDIT — a credit does not freeze its order", async () => {
  const { order, customer } = await savedOrder();
  await prisma.invoice.create({
    data: { orderId: order.id, customerId: customer.id, kind: "CREDIT", status: "FINALIZED",
            creditNumber: 1000, invoiceDate: new Date("2026-08-06"), finalizedAt: new Date() } });
  expect(await prisma.$transaction((tx) => finalizedInvoiceFor(tx, order.id))).toBeNull();
});

it("freezes extra charges once an invoice is finalized, naming it", async () => {
  const { order, customer } = await savedOrder();
  await asSystem(() => replaceCharges(order.id, [{ description: "Rush", amount: "50.00" }]));  // fine
  await finalizedInvoice(order.id, customer.id);
  await expect(asSystem(() => replaceCharges(order.id, [{ description: "Rush", amount: "60.00" }])))
    .rejects.toThrow(new RegExp(`Invoice ${order.orderNumber}`));
});

it("refuses to void an order that has a finalized invoice", async () => {
  const { order, customer } = await savedOrder();
  await finalizedInvoice(order.id, customer.id);
  await expect(asSystem(() => voidOrder(order.id, "keyed twice")))
    .rejects.toThrow(new RegExp(`Invoice ${order.orderNumber}`));
});

it("refuses to void a shipment on an invoiced order", async () => {
  const { order, customer } = await savedOrder();
  const { shipper } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
  await finalizedInvoice(order.id, customer.id);
  await expect(voidShipper(shipper.id, "wrong truck"))
    .rejects.toThrow(new RegExp(`Invoice ${order.orderNumber}`));
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/invoice-guards.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/server/invoice-guards.ts`:**

```ts
// A LEAF, deliberately: orders.ts and shippers.ts must be able to ask "is this order invoiced?"
// without importing invoices.ts, which imports both of them. Phase 4 lesson 3 — a `const`
// consumed across a module cycle crashes at module-evaluation time, two tasks after the edge is
// added — and order-locks.ts is the precedent for pulling the shared question into a leaf BEFORE
// the cycle exists rather than after it bites.
import type { Prisma } from "../../prisma/generated/prisma/client";

export type FinalizedInvoice = { id: string; orderId: string; orderNumber: number };

/** The live, FINALIZED invoice for this order, if any. A DRAFT freezes nothing (it is still being
 *  assembled) and a CREDIT freezes nothing (it reverses an invoice, it is not one). Read on the
 *  caller's own `tx`, which is already holding that order's claim — the check and the write it
 *  guards must see the same state. */
export async function finalizedInvoiceFor(
  tx: Prisma.TransactionClient, orderId: string,
): Promise<FinalizedInvoice | null> {
  const row = await tx.invoice.findFirst({
    where: { orderId, kind: "INVOICE", status: "FINALIZED", deletedAt: null },
    select: { id: true, orderId: true, order: { select: { orderNumber: true } } },
  });
  return row === null ? null : { id: row.id, orderId: row.orderId, orderNumber: row.order.orderNumber };
}

/** The batched form, for a mutator spanning several orders (voidShipper, the reversing shipment).
 *  One query, not one per order — the `shippedTotals` shape. */
export async function finalizedInvoicesFor(
  tx: Prisma.TransactionClient, orderIds: string[],
): Promise<FinalizedInvoice[]> {
  if (orderIds.length === 0) return [];
  const rows = await tx.invoice.findMany({
    where: { orderId: { in: orderIds }, kind: "INVOICE", status: "FINALIZED", deletedAt: null },
    select: { id: true, orderId: true, order: { select: { orderNumber: true } } },
  });
  return rows.map((r) => ({ id: r.id, orderId: r.orderId, orderNumber: r.order.orderNumber }));
}

/** Names the blocker and links to it — §5.14's discoverability rule, the shape every shipment
 *  refusal in Phase 4 already uses ("Packing List 072826, linked to its page"). */
export function invoiceBlockMessage(inv: FinalizedInvoice, action: string): string {
  return `${action} — Invoice ${inv.orderNumber} is finalized; unlock it or raise a credit ` +
    `(see /invoicing/${inv.id})`;
}
```

- [ ] **Step 4: Wire the three invariants**, each inside the mutator's existing claimed transaction, **after** the claim and before any write:
  - `orders.ts` `replaceCharges` — spec §7.1's "then the invoice owns them":
    `const inv = await finalizedInvoiceFor(tx, orderId); if (inv) throw new HttpError(400, invoiceBlockMessage(inv, "Charges cannot be changed"));`
  - `orders.ts` `voidOrder` — same shape, `"This order cannot be voided"`.
  - `shippers.ts` `voidShipper` — batched over `orderIds` **after `claimLiveShipper`**, `"This shipment cannot be voided"`. Same guard in `replaceShipperLines` and `addOrderToShipper` (`"This shipment cannot be changed"`), since both change what was billed.

- [ ] **Step 5: Run the tests** — `npx vitest run tests/invoice-guards.test.ts tests/orders.test.ts tests/shippers.test.ts tests/shipper-void.test.ts`. Expected: PASS, and no existing test regresses (none of them finalize an invoice, so none is affected).
- [ ] **Step 6: Prove the leaf really is a leaf** — extend `tests/invoice-guards.test.ts` with the same import-shape assertion Task 9 used, asserting `src/server/invoice-guards.ts` imports nothing from `./orders`, `./shippers` or `./invoices`.
- [ ] **Step 7: Gates + commit** — `feat: invoice guards — charges freeze, order void and shipment edits refuse once invoiced`

---

