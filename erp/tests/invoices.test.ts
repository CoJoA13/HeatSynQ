import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder, replaceCharges, type OrderDetail } from "@/server/orders";
import { createShipper } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { createSurcharge, setCustomerSurcharge } from "@/server/surcharges";
import { setSetting } from "@/server/settings";
import { setBillingConfig } from "@/server/billing-config";
import { createInvoice, listInvoiceCandidates } from "@/server/invoices";
import type { Customer, Part } from "../prisma/generated/prisma/client";
import type { CertScopeValue } from "@/lib/cert-constants";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

// -------------------------------------------------------------------------------------------
// Fixtures. `asSystem`, `makeCustomer`, `makePart`, `giveSteps`, `savedOrder` and `oneOrderInput`
// are copied from tests/shippers.test.ts:1-143 (copying across test files is this repo's
// convention). The invoicing-specific helpers below are the six task-11-brief.md Step 1 defines;
// the ones whose bodies call Task 12-15 exports (finalizeInvoice / replaceInvoiceLines) are added
// by those tasks, in a shared tests/helpers/invoicing.ts, when a second file first needs them.
// -------------------------------------------------------------------------------------------

let customerSeq = 0;
async function makeCustomer(opts: { creditHold?: boolean } = {}): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({
    data: { code: `C${customerSeq}`, name: `Customer ${customerSeq}`, creditHold: opts.creditHold ?? false },
  });
}

let partSeq = 0;
async function makePart(customerId: string, opts: {
  certRequired?: boolean | null; certScope?: CertScopeValue | null; serializationRequired?: boolean;
} = {}): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({
    data: {
      customerId, partNumber: `P-${partSeq}`, eachWeight: "1.0000",
      certRequired: opts.certRequired ?? null, certScope: opts.certScope ?? null,
      serializationRequired: opts.serializationRequired ?? false,
    },
  });
}

async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `HT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

async function savedOrder(opts: {
  creditHold?: boolean; certRequired?: boolean; certScope?: CertScopeValue; serializationRequired?: boolean;
  qty?: number; weight?: string; poNumber?: string;
} = {}): Promise<{ order: OrderDetail; part: Part; customer: Customer }> {
  const customer = await makeCustomer({ creditHold: opts.creditHold });
  const part = await makePart(customer.id, {
    certRequired: opts.certRequired ?? null,
    certScope: opts.certRequired ? (opts.certScope ?? "LOAD") : (opts.certScope ?? null),
    serializationRequired: opts.serializationRequired,
  });
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    poNumber: opts.poNumber ?? "",
    lines: [{ partId: part.id, qty: opts.qty ?? 10, weight: opts.weight ?? "25.00" }],
  }));
  return { order, part, customer };
}

function oneOrderInput(order: OrderDetail) {
  return {
    customerId: order.customerId,
    shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: [{
        orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight,
        lineComplete: false,
      }],
      containers: [] as { orderContainerId: string; count: number }[],
      serials: [] as { orderSerialId: string; printOnShipper?: boolean }[],
    }],
  };
}

/** An order shipped to line-complete on every line -> status SHIPPED. No pricing. */
async function shippedOrder(opts: { qty?: number } = {}) {
  const { order, part, customer } = await savedOrder({ qty: opts.qty ?? 144, weight: "3024.00" });
  const input = oneOrderInput(order);
  input.orders[0].lines[0].lineComplete = true;
  const { shipper } = await createShipper(input, { canOverrideCreditHold: false });
  return { order: await getOrder(order.id), part, customer, shipper };
}

/** Shipped, but nothing marked complete -> status PARTIAL_SHIPPED. */
async function partiallyShippedOrder() {
  const { order, part, customer } = await savedOrder({ qty: 144, weight: "3024.00" });
  const input = oneOrderInput(order);
  input.orders[0].lines[0].qty = 10;
  const { shipper } = await createShipper(input, { canOverrideCreditHold: false });
  return { order: await getOrder(order.id), part, customer, shipper };
}

/** `shippedOrder`, plus one PartPrice row on its part and a GL account behind the step code.
 *  `minimumCharge: null` means NO minimum (distinct from omitting it, which defaults to 600). */
async function pricedShippedOrder(opts: {
  qty?: number; unitPrice?: string; minimumCharge?: string | null; setupCharge?: string;
  pricePer?: string; glAccount?: string | null;
} = {}) {
  const fixture = await shippedOrder({ qty: opts.qty });
  const gl = opts.glAccount === null ? null
    : await prisma.glAccount.create({ data: { name: opts.glAccount ?? "4010", description: "Sales" } });
  const code = await prisma.processStepCode.create({
    data: { code: "AUST", name: "Austemper", glAccountId: gl?.id ?? null } });
  const minimumCharge = opts.minimumCharge === undefined ? "600.00" : opts.minimumCharge;
  await asSystem(() => addPartPrice(fixture.part.id, {
    processStepCodeId: code.id, position: 1,
    unitPrice: opts.unitPrice ?? "6.5100",
    ...(minimumCharge !== null ? { minimumCharge } : {}),
    ...(opts.setupCharge ? { setupCharge: opts.setupCharge } : {}),
    pricePer: opts.pricePer ?? "EACH",
  }));
  return { ...fixture, stepCode: code, glAccount: gl };
}

beforeEach(async () => {
  await truncateAll();
});

describe("listInvoiceCandidates", () => {
  it("lists only orders at SHIPPED with no live invoice", async () => {
    const { order } = await shippedOrder();
    expect((await listInvoiceCandidates({})).map((c) => c.orderNumber)).toEqual([order.orderNumber]);
    await asSystem(() => createInvoice({ orderId: order.id }));
    expect(await listInvoiceCandidates({})).toEqual([]);
  });

  it("excludes a partially shipped order and a voided one", async () => {
    await partiallyShippedOrder();
    expect(await listInvoiceCandidates({})).toEqual([]);
    const { order: voided } = await shippedOrder();
    await prisma.order.update({ where: { id: voided.id }, data: { deletedAt: new Date() } });
    expect(await listInvoiceCandidates({})).toEqual([]);
  });
});

describe("createInvoice", () => {
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
    expect(op.parentLineId).toBe(part.id); // the OPERATION hangs off its PART line (second-pass patch)
    expect(invoice.total).toBe(937.44);
  });

  it("bills an active surcharge with its own GL account and rate (seam #2)", async () => {
    const surGl = await prisma.glAccount.create({ data: { name: "4500", description: "Energy surcharge" } });
    await asSystem(() => createSurcharge({
      name: "EnergySur", kind: "PERCENT", rate: "0.050000", position: 1, glAccountId: surGl.id, scope: "ALL",
    }));
    // 5% of a $100 operation -> $5, posting to the surcharge's own GL, snapshotting its rate.
    const { order } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    const surLine = invoice.lines.find((l) => l.kind === "SURCHARGE")!;
    expect(surLine.amount).toBe(5);
    expect(surLine.glAccountName).toBe("4500");
    expect(surLine.rate).toBe(0.05);
    expect(invoice.surchargeTotal).toBe(5);
  });

  it("suppresses a surcharge for a customer who has opted out of it", async () => {
    const { id: surchargeId } = await asSystem(() => createSurcharge({
      name: "EnergySur", kind: "PERCENT", rate: "0.050000", position: 1, scope: "ALL",
    }));
    const { order, customer } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    await asSystem(() => setCustomerSurcharge(customer.id, surchargeId, { optOut: true }));
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.lines.some((l) => l.kind === "SURCHARGE")).toBe(false);
    expect(invoice.surchargeTotal).toBe(0);
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
    const { order } = await shippedOrder();
    const { invoice, warnings } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.lines.some((l) => l.needsPrice)).toBe(true);
    expect(warnings.join(" ")).toMatch(/needs a price/i);
  });

  it("never bills a line whose net shipped total is zero", async () => {
    const customer = await makeCustomer();
    const partA = await makePart(customer.id);
    const partB = await makePart(customer.id);
    await giveSteps(partA.id);
    await giveSteps(partB.id);
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [
        { partId: partA.id, qty: 100, weight: "100.00" },
        { partId: partB.id, qty: 100, weight: "100.00" },
      ],
    }));
    const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Sales" } });
    const codeA = await prisma.processStepCode.create({ data: { code: "OPA", name: "OpA", glAccountId: gl.id } });
    const codeB = await prisma.processStepCode.create({ data: { code: "OPB", name: "OpB", glAccountId: gl.id } });
    // Line A: no minimum, so it bills its real $100 (100 × $1). Line B: a $600 minimum, so if a
    // zero-net line reached the engine it would bill the FULL $600 — making the total $700, not $100.
    await asSystem(() => addPartPrice(partA.id, {
      processStepCodeId: codeA.id, position: 1, unitPrice: "1.0000", pricePer: "EACH" }));
    await asSystem(() => addPartPrice(partB.id, {
      processStepCodeId: codeB.id, position: 1, unitPrice: "1.0000", minimumCharge: "600.00", pricePer: "EACH" }));
    // Line A ships in full and complete; line B ships zero but is also marked complete, so the
    // ORDER reaches SHIPPED while line B has a net shipped total of zero.
    await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-08-04",
      orders: [{
        orderId: order.id,
        lines: [
          { orderLineId: order.lines[0].id, qty: 100, weight: 100, lineComplete: true },
          { orderLineId: order.lines[1].id, qty: 0, weight: 0, lineComplete: true },
        ],
        containers: [], serials: [],
      }],
    }, { canOverrideCreditHold: false }));
    expect((await getOrder(order.id)).status).toBe("SHIPPED");

    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    // Line B contributed no lines at all, so the total is line A's $100 — never $100 + line B's $600.
    expect(invoice.lines.some((l) => l.orderLineId === order.lines[1].id)).toBe(false);
    expect(invoice.total).toBe(100);
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
    expect(invoice.total).toBe(290.4); // 100 + 10 + 25 + 150 + 5.40
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
    expect(invoice.taxRate).toBe(0.1); // snapshotted on the header
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

  // The discriminating concurrency test, copied in shape from tests/certs.test.ts:110-177 —
  // including the reasoning for why the competing caller must be pinned to Read Committed.
  //
  // Every uniqueness case above is SEQUENTIAL, which proves the business-rule 400 but never
  // exercises `claimOrder`'s row lock — nothing above ever has two transactions open on the same
  // order at once. With BOTH callers Serializable and both doing the same clash-check SELECT then
  // INSERT, Postgres's own SSI would detect the write-skew on that predicate ALONE and the row
  // lock would never have to do anything. Taking Serializable off the competing caller (call the
  // internal path directly against a manually-opened Read Committed tx) removes SSI from the
  // picture, so `claimOrder`'s row lock is the only thing that can serialize the two. Verified by
  // hand: RED with the claim removed, GREEN with it restored (see the task report for transcripts).
  it("blocks a concurrent create under Read Committed until the holder commits, then refuses (row-lock discipline)", async () => {
    const { order } = await pricedShippedOrder();

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    // Holder: default (Read Committed) isolation. Claims the Order row, commits a live INVOICE for
    // it while still holding the lock.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      hasClaimed();
      await release;
      await tx.invoice.create({
        data: { orderId: order.id, customerId: order.customerId, invoiceDate: new Date() },
      });
    }, { timeout: 20000 });

    await claimed;
    // Read Committed — createInvoice called against a manually-opened tx rather than through the
    // public no-`tx` API (which always forces Serializable).
    const createCall = asSystem(() =>
      prisma.$transaction((tx) => createInvoice({ orderId: order.id }, tx)));

    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      createCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);

    mayRelease();
    await holder;

    await expect(createCall).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/already has an invoice/i),
    });
    expect(await prisma.invoice.count({ where: { orderId: order.id, deletedAt: null } })).toBe(1);
  });
});
