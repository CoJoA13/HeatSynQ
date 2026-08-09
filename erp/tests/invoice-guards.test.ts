import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, replaceCharges, voidOrder, type OrderDetail } from "@/server/orders";
import {
  createShipper, voidShipper, replaceShipperLines, addOrderToShipper, removeOrderFromShipper,
  updateShipper, type ShipperDetail,
} from "@/server/shippers";
import {
  finalizedInvoiceFor, finalizedInvoicesFor, invoiceBlockMessage, hasReceivableActivity,
} from "@/server/invoice-guards";
import type { Customer, Part } from "../prisma/generated/prisma/client";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

// ---------------------------------------------------------------------------------------------
// Fixtures — the shipper-void.test.ts shape, trimmed to what the guards need.
// ---------------------------------------------------------------------------------------------

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `C${customerSeq}`, name: `Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({
    data: { customerId, partNumber: `P-${partSeq}`, eachWeight: "1.0000" },
  });
}

async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `HT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

async function orderFor(customer: Customer): Promise<OrderDetail> {
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: 10, weight: "25.00" }],
  }));
  return order;
}

async function savedOrder(): Promise<{ order: OrderDetail; customer: Customer }> {
  const customer = await makeCustomer();
  return { order: await orderFor(customer), customer };
}

function orderInput(order: OrderDetail) {
  return {
    orderId: order.id,
    lines: [{
      orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight,
      lineComplete: true,
    }],
    containers: [] as { orderContainerId: string; count: number }[],
    serials: [] as { orderSerialId: string; printOnShipper?: boolean }[],
  };
}

function oneOrderInput(order: OrderDetail) {
  return { customerId: order.customerId, shipDate: "2026-08-04", orders: [orderInput(order)] };
}

function twoOrderInput(customerId: string, a: OrderDetail, b: OrderDetail) {
  return { customerId, shipDate: "2026-08-04", orders: [orderInput(a), orderInput(b)] };
}

async function shipmentFor(order: OrderDetail): Promise<ShipperDetail> {
  const { shipper } = await asSystem(() =>
    createShipper(oneOrderInput(order), { canOverrideCreditHold: false }));
  return shipper;
}

/** A FINALIZED INVOICE, written with the raw client on purpose: Task 11's `invoices.ts` does not
 *  exist yet, and this module must never depend on it. */
async function finalizedInvoice(orderId: string, customerId: string) {
  return prisma.invoice.create({
    data: {
      orderId, customerId, kind: "INVOICE", status: "FINALIZED",
      invoiceDate: new Date("2026-08-06"), finalizedAt: new Date(),
    },
  });
}

async function draftInvoice(orderId: string, customerId: string) {
  return prisma.invoice.create({
    data: { orderId, customerId, kind: "INVOICE", status: "DRAFT", invoiceDate: new Date("2026-08-06") },
  });
}

const lookup = (orderId: string) => prisma.$transaction((tx) => finalizedInvoiceFor(tx, orderId));

beforeEach(async () => {
  await truncateAll();
});

// ---------------------------------------------------------------------------------------------
// The reader itself
// ---------------------------------------------------------------------------------------------

describe("finalizedInvoiceFor", () => {
  it("finds a finalized invoice and ignores a draft or a discarded one", async () => {
    const { order, customer } = await savedOrder();
    expect(await lookup(order.id)).toBeNull();

    const draft = await draftInvoice(order.id, customer.id);
    expect(await lookup(order.id)).toBeNull();

    await prisma.invoice.update({ where: { id: draft.id }, data: { status: "FINALIZED" } });
    const found = await lookup(order.id);
    expect(found).toEqual({ id: draft.id, orderId: order.id, orderNumber: order.orderNumber });

    await prisma.invoice.update({ where: { id: draft.id }, data: { deletedAt: new Date() } });
    expect(await lookup(order.id)).toBeNull();
  });

  it("ignores a finalized CREDIT — a credit does not freeze its order", async () => {
    const { order, customer } = await savedOrder();
    await prisma.invoice.create({
      data: {
        orderId: order.id, customerId: customer.id, kind: "CREDIT", status: "FINALIZED",
        creditNumber: 1000, invoiceDate: new Date("2026-08-06"), finalizedAt: new Date(),
      },
    });
    expect(await lookup(order.id)).toBeNull();
  });

  it("scopes to the order asked about — another order's invoice is not this order's", async () => {
    const { order, customer } = await savedOrder();
    const other = await orderFor(customer);
    await finalizedInvoice(other.id, customer.id);
    expect(await lookup(order.id)).toBeNull();
    expect((await lookup(other.id))!.orderNumber).toBe(other.orderNumber);
  });
});

describe("finalizedInvoicesFor", () => {
  it("returns nothing for an empty id list without touching the database", async () => {
    expect(await prisma.$transaction((tx) => finalizedInvoicesFor(tx, []))).toEqual([]);
  });

  it("returns one row per invoiced order and skips the rest, drafts and credits included", async () => {
    const customer = await makeCustomer();
    const [a, b, c, d] = [
      await orderFor(customer), await orderFor(customer),
      await orderFor(customer), await orderFor(customer),
    ];
    // `c` is invoiced FIRST on purpose: its row is the older one, so an unordered query returns it
    // ahead of `a`'s and this test's expectation below only holds because of the explicit
    // `orderBy`. Without that, insertion order would satisfy it by accident.
    const invC = await finalizedInvoice(c.id, customer.id);
    const invA = await finalizedInvoice(a.id, customer.id);
    await draftInvoice(b.id, customer.id);                       // a draft freezes nothing
    await prisma.invoice.create({                                // nor does a credit
      data: {
        orderId: d.id, customerId: customer.id, kind: "CREDIT", status: "FINALIZED",
        creditNumber: 2000, invoiceDate: new Date("2026-08-06"), finalizedAt: new Date(),
      },
    });

    const found = await prisma.$transaction((tx) =>
      finalizedInvoicesFor(tx, [d.id, c.id, b.id, a.id]));
    // Ascending order number, whatever sequence the caller named the ids in — the message a
    // multi-order refusal builds off `found[0]` must not depend on scan order.
    expect(found).toEqual([
      { id: invA.id, orderId: a.id, orderNumber: a.orderNumber },
      { id: invC.id, orderId: c.id, orderNumber: c.orderNumber },
    ]);
  });
});

describe("hasReceivableActivity", () => {
  const receivable = (invoiceId: string) =>
    prisma.$transaction((tx) => hasReceivableActivity(tx, invoiceId));

  it("is false with no applications, true once one names the invoice, false again once it is voided", async () => {
    const { order, customer } = await savedOrder();
    const inv = await finalizedInvoice(order.id, customer.id);
    expect(await receivable(inv.id)).toBe(false);

    // A WRITE_OFF carries a null paymentId and null creditInvoiceId by the source-check — the
    // cheapest live row that satisfies the `invoiceId` arm without a Payment fixture.
    const app = await prisma.application.create({
      data: { invoiceId: inv.id, amount: "50.00", type: "WRITE_OFF", appliedDate: new Date("2026-08-08") },
    });
    expect(await receivable(inv.id)).toBe(true);

    await prisma.application.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    expect(await receivable(inv.id)).toBe(false); // a voided application drops out of both arms
  });

  it("is true for an applied credit — both the target invoice and the credit itself are active paper", async () => {
    const { order, customer } = await savedOrder();
    const inv = await finalizedInvoice(order.id, customer.id);
    const credit = await prisma.invoice.create({
      data: {
        orderId: order.id, customerId: customer.id, kind: "CREDIT", status: "FINALIZED",
        creditNumber: 9100, invoiceDate: new Date("2026-08-06"), finalizedAt: new Date(),
      },
    });
    // Applied TO `inv`, SOURCED FROM `credit` — one row touches both from opposite sides.
    await prisma.application.create({
      data: {
        invoiceId: inv.id, creditInvoiceId: credit.id, amount: "25.00", type: "CREDIT",
        appliedDate: new Date("2026-08-08"),
      },
    });
    expect(await receivable(inv.id)).toBe(true);    // invoiceId arm
    expect(await receivable(credit.id)).toBe(true); // creditInvoiceId arm — the credit is active paper
  });

  it("scopes to the invoice asked about — another invoice's application is not this one's", async () => {
    const { order, customer } = await savedOrder();
    const inv = await finalizedInvoice(order.id, customer.id);
    const other = await orderFor(customer);
    const otherInv = await finalizedInvoice(other.id, customer.id);
    await prisma.application.create({
      data: { invoiceId: otherInv.id, amount: "10.00", type: "WRITE_OFF", appliedDate: new Date("2026-08-08") },
    });
    expect(await receivable(inv.id)).toBe(false);
    expect(await receivable(otherInv.id)).toBe(true);
  });
});

describe("invoiceBlockMessage", () => {
  it("names the action, the invoice and the page that unlocks it", () => {
    const msg = invoiceBlockMessage(
      { id: "inv1", orderId: "o1", orderNumber: 10432 }, "Charges cannot be changed");
    expect(msg).toContain("Charges cannot be changed");
    expect(msg).toContain("Invoice 10432");
    expect(msg).toContain("/invoicing/inv1");
  });
});

// ---------------------------------------------------------------------------------------------
// The invariants it feeds
// ---------------------------------------------------------------------------------------------

describe("order edits freeze once an invoice is finalized", () => {
  it("freezes extra charges once an invoice is finalized, naming it", async () => {
    const { order, customer } = await savedOrder();
    await asSystem(() => replaceCharges(order.id, [{ description: "Rush", amount: "50.00" }]));

    await finalizedInvoice(order.id, customer.id);
    await expect(asSystem(() => replaceCharges(order.id, [{ description: "Rush", amount: "60.00" }])))
      .rejects.toThrow(new RegExp(`Invoice ${order.orderNumber}`));

    // Refused, not half-applied: the charge the order already carried is untouched.
    const charges = await prisma.orderCharge.findMany({ where: { orderId: order.id } });
    expect(charges).toHaveLength(1);
    expect(charges[0].amount!.toString()).toBe("50");
  });

  it("does NOT freeze charges while the invoice is still a draft", async () => {
    const { order, customer } = await savedOrder();
    await draftInvoice(order.id, customer.id);
    const after = await asSystem(() =>
      replaceCharges(order.id, [{ description: "Rush", amount: "60.00" }]));
    expect(after.charges).toHaveLength(1);
  });

  it("refuses to void an order that has a finalized invoice", async () => {
    const { order, customer } = await savedOrder();
    await finalizedInvoice(order.id, customer.id);
    await expect(asSystem(() => voidOrder(order.id, "keyed twice")))
      .rejects.toThrow(new RegExp(`Invoice ${order.orderNumber}`));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).deletedAt).toBeNull();
  });

  // The invoice guard runs BEFORE `shipmentBlockers`. An invoiced order always has a shipment
  // (you bill what shipped), so checking shipments first would send the user to void the
  // shipment — which `voidShipper`'s own guard then refuses for the same reason. Naming the
  // invoice first is the only message that points at a fix that actually works.
  it("names the invoice, not the shipment, when the order has both", async () => {
    const { order, customer } = await savedOrder();
    await shipmentFor(order);
    await finalizedInvoice(order.id, customer.id);
    await expect(asSystem(() => voidOrder(order.id, "keyed twice")))
      .rejects.toThrow(new RegExp(`Invoice ${order.orderNumber}`));
  });
});

describe("shipment edits freeze once an invoice is finalized", () => {
  it("refuses to void a shipment on an invoiced order", async () => {
    const { order, customer } = await savedOrder();
    const shipper = await shipmentFor(order);
    await finalizedInvoice(order.id, customer.id);
    await expect(asSystem(() => voidShipper(shipper.id, "wrong truck")))
      .rejects.toThrow(new RegExp(`Invoice ${order.orderNumber}`));
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).deletedAt).toBeNull();
  });

  it("refuses to replace a shipment's lines on an invoiced order", async () => {
    const { order, customer } = await savedOrder();
    const shipper = await shipmentFor(order);
    await finalizedInvoice(order.id, customer.id);
    await expect(asSystem(() => replaceShipperLines(shipper.id, shipper.orders[0].id, [
      { orderLineId: order.lines[0].id, qty: 3, weight: 7.5, lineComplete: true },
    ]))).rejects.toThrow(new RegExp(`Invoice ${order.orderNumber}`));
    const line = await prisma.shipperLine.findFirstOrThrow({
      where: { shipperOrder: { shipperId: shipper.id } },
    });
    expect(line.qty).toBe(order.lines[0].qty); // the original grid survived
  });

  // The guard is batched over EVERY order on the shipment, not just the one being edited — the
  // brief's own shape. A shipment is one document: what it says about order B is printed on the
  // same paper as order A's billed lines, and freight rides the shipment, not the line. Editing
  // any part of it once any order on it is invoiced is refused; unlock or reverse instead.
  it("refuses an edit to one order's lines when a DIFFERENT order on the shipment is invoiced", async () => {
    const customer = await makeCustomer();
    const orderA = await orderFor(customer);
    const orderB = await orderFor(customer);
    const { shipper } = await asSystem(() =>
      createShipper(twoOrderInput(customer.id, orderA, orderB), { canOverrideCreditHold: false }));
    await finalizedInvoice(orderA.id, customer.id);

    const soB = shipper.orders.find((o) => o.orderId === orderB.id)!;
    await expect(asSystem(() => replaceShipperLines(shipper.id, soB.id, [
      { orderLineId: orderB.lines[0].id, qty: 1, weight: 1, lineComplete: false },
    ]))).rejects.toThrow(new RegExp(`Invoice ${orderA.orderNumber}`));
  });

  it("refuses to add an order to a shipment that already carries an invoiced order", async () => {
    const customer = await makeCustomer();
    const orderA = await orderFor(customer);
    const orderB = await orderFor(customer);
    const shipper = await shipmentFor(orderA);
    await finalizedInvoice(orderA.id, customer.id);

    await expect(asSystem(() => addOrderToShipper(shipper.id, orderB.id)))
      .rejects.toThrow(new RegExp(`Invoice ${orderA.orderNumber}`));
    expect(await prisma.shipperOrder.count({ where: { shipperId: shipper.id } })).toBe(1);
  });

  it("refuses to add an INVOICED order onto a shipment that carries none", async () => {
    const customer = await makeCustomer();
    const orderA = await orderFor(customer);
    const orderB = await orderFor(customer);
    const shipper = await shipmentFor(orderA);
    await finalizedInvoice(orderB.id, customer.id); // the INCOMING order is the invoiced one

    await expect(asSystem(() => addOrderToShipper(shipper.id, orderB.id)))
      .rejects.toThrow(new RegExp(`Invoice ${orderB.orderNumber}`));
    expect(await prisma.shipperOrder.count({ where: { shipperId: shipper.id } })).toBe(1);
  });

  it("still allows shipment edits while the invoice is only a draft", async () => {
    const { order, customer } = await savedOrder();
    const shipper = await shipmentFor(order);
    await draftInvoice(order.id, customer.id);
    const after = await asSystem(() => replaceShipperLines(shipper.id, shipper.orders[0].id, [
      { orderLineId: order.lines[0].id, qty: 3, weight: 7.5, lineComplete: true },
    ]));
    expect(after.orders[0].lines[0].qty).toBe(3);
  });

  // ---------------------------------------------------------------------------------------------
  // Fix wave 1 (controller-approved scope extension of Task 10): `removeOrderFromShipper` and
  // `updateShipper` were the two review-flagged holes ruled real. `replaceShipperContainers` and
  // `replaceShipperSerials` were also flagged, ruled NOT to be guarded (neither touches a billed
  // quantity/weight — see the doc comments at their definitions in shippers.ts), so they get no
  // test here.
  // ---------------------------------------------------------------------------------------------

  it("refuses to remove an invoiced order from a multi-order shipment — the addOrderToShipper mirror", async () => {
    const customer = await makeCustomer();
    const orderA = await orderFor(customer);
    const orderB = await orderFor(customer);
    const { shipper } = await asSystem(() =>
      createShipper(twoOrderInput(customer.id, orderA, orderB), { canOverrideCreditHold: false }));
    await finalizedInvoice(orderA.id, customer.id);

    const soA = shipper.orders.find((o) => o.orderId === orderA.id)!;
    await expect(asSystem(() => removeOrderFromShipper(shipper.id, soA.id)))
      .rejects.toThrow(new RegExp(`Invoice ${orderA.orderNumber}`));
    // Refused, not half-applied: both orders (and their lines) are still on the shipment.
    expect(await prisma.shipperOrder.count({ where: { shipperId: shipper.id } })).toBe(2);
  });

  it("still allows removing a NON-invoiced order from a shipment that carries an invoiced one", async () => {
    // The guard is scoped to the TARGET order being removed, not the whole claimed set — removing
    // orderB (clean) must succeed even though orderA (staying on the shipment) is invoiced.
    const customer = await makeCustomer();
    const orderA = await orderFor(customer);
    const orderB = await orderFor(customer);
    const { shipper } = await asSystem(() =>
      createShipper(twoOrderInput(customer.id, orderA, orderB), { canOverrideCreditHold: false }));
    await finalizedInvoice(orderA.id, customer.id);

    const soB = shipper.orders.find((o) => o.orderId === orderB.id)!;
    const after = await asSystem(() => removeOrderFromShipper(shipper.id, soB.id));
    expect(after.orders.map((o) => o.orderId)).toEqual([orderA.id]);
  });

  it("refuses to change freight on an invoiced shipment", async () => {
    const { order, customer } = await savedOrder();
    const shipper = await shipmentFor(order);
    await finalizedInvoice(order.id, customer.id);

    await expect(asSystem(() => updateShipper(shipper.id, { billFreight: true, freightAmount: "125.00" })))
      .rejects.toThrow(new RegExp(`Invoice ${order.orderNumber}`));
    const row = await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } });
    expect(row.billFreight).toBe(false); // refused, not half-applied
    expect(row.freightAmount).toBeNull();
  });

  // The discriminating negative (without it, a guard that refuses EVERY updateShipper call would
  // pass the test above just as well): a patch that touches only a non-billed field must still
  // succeed on an invoiced shipment — over-blocking a comment edit is a real usability regression.
  it("still allows a non-billed field edit (comments) on an invoiced shipment", async () => {
    const { order, customer } = await savedOrder();
    const shipper = await shipmentFor(order);
    await finalizedInvoice(order.id, customer.id);

    const after = await asSystem(() => updateShipper(shipper.id, { comments: "carrier called ahead" }));
    expect(after.comments).toBe("carrier called ahead");
  });
});

// ---------------------------------------------------------------------------------------------
// Step 6: the leaf really is a leaf
// ---------------------------------------------------------------------------------------------

describe("invoice-guards — the module is a leaf", () => {
  it("imports nothing from orders, shippers or invoices", () => {
    const src = readFileSync(join(process.cwd(), "src/server/invoice-guards.ts"), "utf8");
    const imports = [...src.matchAll(/^import\s+(?:type\s+)?.*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const forbidden of ["./orders", "./shippers", "./invoices"]) {
      expect(imports).not.toContain(forbidden);
    }
    // Static `import … from "…"` is one way in; `require(…)` and dynamic `import(…)` are the
    // others, and either would reintroduce the cycle this module exists to prevent.
    expect(/\brequire\s*\(/.test(src)).toBe(false);
    expect(/\bimport\s*\(/.test(src)).toBe(false);
  });
});
