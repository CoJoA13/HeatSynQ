import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder, replaceCharges, type OrderDetail } from "@/server/orders";
import { createShipper } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { createSurcharge, setCustomerSurcharge } from "@/server/surcharges";
import { setSetting } from "@/server/settings";
import { setBillingConfig } from "@/server/billing-config";
import {
  createInvoice, listInvoiceCandidates, getInvoice,
  updateInvoice, replaceInvoiceLines, recalculateInvoice, discardInvoice,
  finalizeInvoice, unlockInvoice, createCredit,
  type InvoiceDetail, type InvoiceLineDetail,
} from "@/server/invoices";
import type { Customer, Part } from "../prisma/generated/prisma/client";
import type { CertScopeValue } from "@/lib/cert-constants";
import { addDays, formatDateOnly, todayDateOnly } from "@/lib/business-days";

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

  // Fix wave 1, Fix 1: the writer's Serializable isolation exists specifically to pair with
  // `assertRefExists` on every registered FK it assigns (CLAUDE.md's FK-writer pattern) — closing
  // the staleness window between `loadInvoiceDeps`' outside-tx reads and this transaction's own
  // commit. A GL account is the easiest FK to exercise: the priced fixture's operation line posts
  // to `glAccount`, and soft-deleting it out from under the create must refuse, not silently post
  // an OPERATION line to a dead account.
  it("refuses to create an invoice whose GL account was soft-deleted before creation (assertRefExists)", async () => {
    const { order, glAccount } = await pricedShippedOrder();
    await prisma.glAccount.update({ where: { id: glAccount!.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => createInvoice({ orderId: order.id })))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/that gl account does not exist/i) });
    expect(await prisma.invoice.count()).toBe(0);
  });

  // Fix wave 1, Fix 2: a CHARGE line carries a blank `partNumber`, so the old
  // `${partNumber} — ${description} needs a price` template rendered a dangling "·  — Rush" with
  // nothing before the dash. The fix uses the line's own label (its description) in that slot.
  it("formats a CHARGE needsPrice warning off its own label, not a blank part number", async () => {
    const { order } = await pricedShippedOrder();
    await asSystem(() => replaceCharges(order.id, [{ description: "Rush" }])); // no amount -> needsPrice
    const { warnings } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(warnings).toContain("Line 3 · Rush — needs a price");
  });

  // Fix wave 1, Fix 4: `renderAddress` (default-address pick, name fallback, blank-line drop) had
  // no direct coverage. Exercised here through `createInvoice`'s billTo/shipTo, the only way it is
  // reachable — the function itself is a private helper.
  it("renders billTo/shipTo — default address pick, name fallback, and blank-line drop", async () => {
    const { order, customer } = await pricedShippedOrder();
    // BILL_TO: two rows: the alphabetically-first one is NOT the default, so picking it correctly
    // requires honoring `isDefault` rather than the `listAddresses` name ordering. The default
    // row's own name is blank (-> customer name fallback) and its zip is blank (-> blank-line drop
    // inside the city/state/zip line, no trailing gap).
    await prisma.customerAddress.create({
      data: { customerId: customer.id, kind: "BILL_TO", name: "AAA Not Default",
        street: "1 Alt St", city: "Alt City", state: "OH", zip: "44444" },
    });
    await prisma.customerAddress.create({
      data: { customerId: customer.id, kind: "BILL_TO", name: "",
        street: "100 Main St", city: "Springfield", state: "OH", zip: "", isDefault: true },
    });
    // SHIP_TO: one row with no street/city/state/zip at all -> only the name line prints.
    await prisma.customerAddress.create({
      data: { customerId: customer.id, kind: "SHIP_TO", name: "Dock 4", isDefault: true },
    });

    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.billTo).toBe(`${customer.name}\n100 Main St\nSpringfield, OH`);
    expect(invoice.shipTo).toBe("Dock 4");
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

// -------------------------------------------------------------------------------------------
// Task 12: draft edits, recalculate, discard. These extend the create surface above, so they
// reuse `pricedShippedOrder` and add four invoicing-specific helpers.
// -------------------------------------------------------------------------------------------

/** A priced, shipped order with a DRAFT invoice already created against it. `priced: false` skips
 *  the price row, so every operation line lands `needsPrice` (finalize refuses it); `glAccount`
 *  passes through to the step code's GL account (`null` -> a step code with no GL account). */
async function draftFixture(opts: { qty?: number; priced?: boolean; glAccount?: string | null } = {}) {
  if (opts.priced === false) {
    const fixture = await shippedOrder({ qty: opts.qty ?? 144 });
    const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
    return { ...fixture, stepCode: null, glAccount: null, invoice };
  }
  const fixture = await pricedShippedOrder({
    qty: opts.qty ?? 144, unitPrice: "6.5100", minimumCharge: "600.00",
    ...(opts.glAccount !== undefined ? { glAccount: opts.glAccount } : {}),
  });
  const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
  return { ...fixture, invoice };
}

/** The same, then flipped to FINALIZED directly (Task 13 builds `finalizeInvoice`). */
async function finalizedFixture() {
  const fixture = await draftFixture();
  await prisma.invoice.update({
    where: { id: fixture.invoice.id }, data: { status: "FINALIZED", finalizedAt: new Date() },
  });
  return { ...fixture, invoice: await asSystem(() => getInvoice(fixture.invoice.id)) };
}

/** Ships `addQty` more of the order's single line — additive over the ledger (spec: over-ship
 *  warns, never blocks), so the recalculated invoice sees a higher shipped total. */
async function shipMore(order: OrderDetail, addQty: number): Promise<void> {
  await asSystem(() => createShipper({
    customerId: order.customerId, shipDate: "2026-08-05",
    orders: [{
      orderId: order.id,
      lines: [{ orderLineId: order.lines[0].id, qty: addQty, weight: addQty, lineComplete: false }],
      containers: [], serials: [],
    }],
  }, { canOverrideCreditHold: false }));
}

/** Maps a stored line back to a `replaceInvoiceLines` payload item. `key`/`parentKey` carry the
 *  grouping across the whole-array replace (positions are reassigned, ids are reminted). */
function toLineInput(l: InvoiceLineDetail) {
  return {
    key: l.id, parentKey: l.parentLineId, kind: l.kind,
    orderLineId: l.orderLineId, processStepCodeId: l.processStepCodeId,
    surchargeId: l.surchargeId, orderChargeId: l.orderChargeId, glAccountId: l.glAccountId,
    partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
    description: l.description, glAccountName: l.glAccountName,
    qty: l.qty, weight: l.weight, eachWeight: l.eachWeight,
    pricePer: l.pricePer, unitPrice: l.unitPrice,
    setupCharge: l.setupCharge, minimumCharge: l.minimumCharge,
    breakThreshold: l.breakThreshold, minimumApplied: l.minimumApplied,
    rate: l.rate, priceSource: l.priceSource, needsPrice: l.needsPrice,
    amount: l.amount,
  };
}

describe("updateInvoice", () => {
  it("refuses every draft edit on a finalized invoice, naming the state", async () => {
    const { invoice } = await finalizedFixture();
    await expect(asSystem(() => updateInvoice(invoice.id, { poNumber: "X" })))
      .rejects.toThrow(/finalized/i);
    await expect(asSystem(() => replaceInvoiceLines(invoice.id, [])))
      .rejects.toThrow(/finalized/i);
    await expect(asSystem(() => recalculateInvoice(invoice.id))).rejects.toThrow(/finalized/i);
    await expect(asSystem(() => discardInvoice(invoice.id, "wrong one"))).rejects.toThrow(/finalized/i);
  });

  it("edits header fields on a draft and audits the before/after diff", async () => {
    const { invoice } = await draftFixture();
    const updated = await asSystem(() => updateInvoice(invoice.id, {
      poNumber: "PO-99", termsName: "Net 30", invoiceDate: "2026-08-10",
    }));
    expect(updated.poNumber).toBe("PO-99");
    expect(updated.termsName).toBe("Net 30");
    expect(updated.invoiceDate).toBe("2026-08-10");
    expect((await asSystem(() => getInvoice(invoice.id))).poNumber).toBe("PO-99");

    const entry = await prisma.auditLog.findFirst({
      where: { entity: "invoice", entityId: invoice.id, action: "update" } });
    expect((entry!.before as Record<string, unknown>).poNumber).toBe("");
    expect((entry!.after as Record<string, unknown>).poNumber).toBe("PO-99");
  });
});

describe("replaceInvoiceLines", () => {
  it("recomputes the totals after a line edit", async () => {
    const { invoice } = await draftFixture();
    const edited = await asSystem(() => replaceInvoiceLines(invoice.id,
      invoice.lines.map((l) => (l.kind === "OPERATION" ? { ...toLineInput(l), amount: "100.00" } : toLineInput(l)))));
    expect(edited.subtotal).toBe(100);
    expect(edited.total).toBe(100);
  });

  it("refuses a replaced line that references a soft-deleted GL account (assertRefExists)", async () => {
    const { invoice, glAccount } = await draftFixture();
    await prisma.glAccount.update({ where: { id: glAccount!.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map(toLineInput))))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/that gl account does not exist/i) });
  });
});

describe("recalculateInvoice", () => {
  it("recalculates from the order and preserves manual lines", async () => {
    const { order, invoice } = await draftFixture({ qty: 144 });
    await asSystem(() => replaceInvoiceLines(invoice.id, [
      ...invoice.lines.map(toLineInput),
      { kind: "CHARGE", description: "Hand-typed", amount: "25.00", priceSource: "MANUAL" },
    ]));
    await shipMore(order, 6); // ship 6 more of the line -> 150 net
    const after = await asSystem(() => recalculateInvoice(invoice.id));
    expect(after.lines.find((l) => l.kind === "PART")!.qty).toBe(150);
    expect(after.lines.some((l) => l.description === "Hand-typed")).toBe(true);
    // Manual line rides at the end, after the regenerated derived lines.
    expect(after.lines[after.lines.length - 1].description).toBe("Hand-typed");
  });

  it("produces the same derived lines as a fresh create for the same order (no drift)", async () => {
    const { order, invoice } = await draftFixture({ qty: 144 });
    await asSystem(() => replaceInvoiceLines(invoice.id, [
      ...invoice.lines.map(toLineInput),
      { kind: "CHARGE", description: "Manual note", amount: "25.00", priceSource: "MANUAL" },
    ]));
    await shipMore(order, 6);
    const recalced = await asSystem(() => recalculateInvoice(invoice.id));

    // Baseline: discard and re-create, i.e. exactly what a fresh createInvoice yields for this
    // order in its current state. Recalculate's derived lines must equal it, or the two pricing
    // paths have drifted.
    await asSystem(() => discardInvoice(invoice.id, "rebaseline for comparison"));
    const { invoice: fresh } = await asSystem(() => createInvoice({ orderId: order.id }));

    const derived = (inv: InvoiceDetail) =>
      inv.lines.filter((l) => l.priceSource !== "MANUAL")
        .map((l) => ({ kind: l.kind, qty: l.qty, amount: l.amount, description: l.description, gl: l.glAccountName }));
    expect(derived(recalced)).toEqual(derived(fresh));
    expect(recalced.subtotal).toBe(fresh.subtotal);
  });

  // Whole-branch review Fix 1 (CRITICAL, money-inverting): a credit's lines are copied from its
  // finalized source with the sign FLIPPED (§5.6) — there is no order pricing that should ever
  // replace them. Without the guard, recalculate re-derives from the order at ordinary POSITIVE
  // prices via the same shared `buildPricingInput`/`priceOrder`/mapper path an invoice uses, and
  // silently overwrites the credit's negated lines/total with a positive re-price — a "Credit"
  // that finalizes and prints as money owed TO the shop rather than a reduction.
  it("refuses to recalculate a credit — its negated lines/total are unchanged", async () => {
    const { invoice } = await finalizedFixture(); // default op amount = 144 × 6.51 = 937.44
    const credit = await asSystem(() => createCredit(invoice.id));
    expect(credit.subtotal).toBe(-937.44);
    expect(credit.total).toBe(-937.44);

    await expect(asSystem(() => recalculateInvoice(credit.id)))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/credit cannot be recalculated/i) });

    const after = await asSystem(() => getInvoice(credit.id));
    expect(after.kind).toBe("CREDIT");
    expect(after.subtotal).toBe(-937.44);
    expect(after.total).toBe(-937.44);
    expect(after.lines).toEqual(credit.lines);
  });
});

describe("discardInvoice", () => {
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
});

// -------------------------------------------------------------------------------------------
// Task 13: finalize, unlock, and the INVOICED/REOPENED status ownership. Finalize and unlock both
// route through the SAME order-claim-then-invoice-lock helper Task 12's `claimLiveInvoice` uses, so
// they serialize against every order/shipment mutator whose Task 10 guard reads the finalized-invoice
// state under its own order claim (§5.7).
// -------------------------------------------------------------------------------------------

describe("finalizeInvoice", () => {
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

  it("audits the finalize with the status before and after, on both the invoice and the order", async () => {
    const { order, invoice } = await draftFixture();
    await asSystem(() => finalizeInvoice(invoice.id));
    const inv = await prisma.auditLog.findFirst({
      where: { entity: "invoice", entityId: invoice.id, action: "update" }, orderBy: { at: "desc" } });
    expect((inv!.before as Record<string, unknown>).status).toBe("DRAFT");
    expect((inv!.after as Record<string, unknown>).status).toBe("FINALIZED");
    const ord = await prisma.auditLog.findFirst({
      where: { entity: "order", entityId: order.id, action: "update" }, orderBy: { at: "desc" } });
    expect((ord!.before as Record<string, unknown>).status).toBe("SHIPPED");
    expect((ord!.after as Record<string, unknown>).status).toBe("INVOICED");
  });

  it("finalizing twice is a 400, never a second write", async () => {
    const { invoice } = await draftFixture();
    const first = await asSystem(() => finalizeInvoice(invoice.id));
    await expect(asSystem(() => finalizeInvoice(invoice.id))).rejects.toThrow(/already finalized/i);
    // Never a second write: the finalize stamp is unchanged and there is exactly one FINALIZED entry.
    expect((await asSystem(() => getInvoice(invoice.id))).finalizedAt).toBe(first.finalizedAt);
    const finalizes = (await prisma.auditLog.findMany({
      where: { entity: "invoice", entityId: invoice.id, action: "update" } }))
      .filter((e) => (e.after as Record<string, unknown>).status === "FINALIZED");
    expect(finalizes).toHaveLength(1);
  });

  it("finalizes with a step code that has no GL account (5C's export refuses, not this)", async () => {
    const { invoice } = await draftFixture({ glAccount: null });
    await expect(asSystem(() => finalizeInvoice(invoice.id))).resolves.toBeTruthy();
  });

  it("freezes the current lines — finalize re-prices nothing", async () => {
    const { invoice } = await draftFixture();
    // Hand-edit the operation line down to $1, then finalize: a finalize that re-ran pricing would
    // restore the $937.44 the part price computes. It must NOT — finalize locks what is there.
    const edited = await asSystem(() => replaceInvoiceLines(invoice.id,
      invoice.lines.map((l) => (l.kind === "OPERATION" ? { ...toLineInput(l), amount: "1.00" } : toLineInput(l)))));
    expect(edited.total).toBe(1);
    const done = await asSystem(() => finalizeInvoice(invoice.id));
    expect(done.total).toBe(1);
    expect(done.lines.find((l) => l.kind === "OPERATION")!.amount).toBe(1);
  });

  // Note #1 (folded in from Task 10): finalize must `claimOrder` before it reads or writes invoice
  // state. Discriminating shape copied from `createInvoice`'s own concurrency test: the competing
  // caller runs at Read Committed (via a manually-opened tx) so ONLY `claimOrder`'s row lock — not
  // SSI — can order the two. The holder claims the order row and, while holding it, voids the order,
  // then commits. WITH the claim, finalize blocks on the order row, then reads the freshly-voided
  // state and refuses. WITHOUT it (RED), finalize reads the order through an unlocked snapshot (still
  // live), sails past the guard, and finalizes a voided order — resolving instead of rejecting.
  it("reads the order under the claim: a void by an order-lock holder makes finalize refuse (row-lock discipline)", async () => {
    const { order, invoice } = await draftFixture();

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      await tx.order.update({ where: { id: order.id }, data: { deletedAt: new Date() } });
      hasClaimed();
      await release;
    }, { timeout: 20000 });

    await claimed;
    const finalizeCall = asSystem(() =>
      prisma.$transaction((tx) => finalizeInvoice(invoice.id, tx)));

    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      finalizeCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT); // blocked on the holder's order-row claim

    mayRelease();
    await holder;

    await expect(finalizeCall).rejects.toThrow(/voided/i);
  });

  // Task 3/§4.3: finalizing an INVOICE stamps `dueDate = invoiceDate + terms.netDays`. `netDays` is
  // `Int @default(30)` on `Terms` now — never null — so the null case is a customer with NO terms
  // assigned at all (`Customer.termsId` null), not a null `netDays`.
  it("sets dueDate = invoiceDate + terms.netDays for a customer on Net 30 terms", async () => {
    const { order, customer } = await pricedShippedOrder();
    const terms = await prisma.terms.create({ data: { name: "Net 30", netDays: 30 } });
    await prisma.customer.update({ where: { id: customer.id }, data: { termsId: terms.id } });
    const { invoice } = await asSystem(() =>
      createInvoice({ orderId: order.id, invoiceDate: "2026-08-01" }));
    const done = await asSystem(() => finalizeInvoice(invoice.id));
    expect(done.dueDate).toBe("2026-08-31");
  });

  it("leaves dueDate null when the customer has no terms assigned", async () => {
    const { order } = await pricedShippedOrder(); // makeCustomer never sets termsId
    const { invoice } = await asSystem(() =>
      createInvoice({ orderId: order.id, invoiceDate: "2026-08-01" }));
    const done = await asSystem(() => finalizeInvoice(invoice.id));
    expect(done.dueDate).toBeNull();
  });
});

describe("unlockInvoice", () => {
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

  it("refuses to unlock an invoice that is not finalized", async () => {
    const { invoice } = await draftFixture();
    await expect(asSystem(() => unlockInvoice(invoice.id, "nothing to do"))).rejects.toThrow(/not finalized/i);
  });

  // Note #2 (folded in from Task 12): unlock MUST return the invoice to DRAFT, or every Task 12
  // mutator keeps refusing it and "unlock" does nothing. Prove all four edit paths work again after.
  it("returns the invoice to DRAFT — every draft edit works again", async () => {
    const { invoice } = await draftFixture();
    await asSystem(() => finalizeInvoice(invoice.id));
    // Finalized: the four refuse.
    await expect(asSystem(() => updateInvoice(invoice.id, { poNumber: "X" }))).rejects.toThrow(/finalized/i);
    await asSystem(() => unlockInvoice(invoice.id, "reopen to correct"));
    // DRAFT again: the four succeed.
    await expect(asSystem(() => updateInvoice(invoice.id, { poNumber: "PO-7" }))).resolves.toBeTruthy();
    const currentLines = (await asSystem(() => getInvoice(invoice.id))).lines.map(toLineInput);
    await expect(asSystem(() => replaceInvoiceLines(invoice.id, currentLines))).resolves.toBeTruthy();
    await expect(asSystem(() => recalculateInvoice(invoice.id))).resolves.toBeTruthy();
    await expect(asSystem(() => discardInvoice(invoice.id, "done"))).resolves.toBeUndefined();
  });
});

// -------------------------------------------------------------------------------------------
// Task 14: credits. A credit is the correction for an already-FINALIZED invoice — it copies the
// source's header and lines with the MONEY sign flipped (quantities unchanged), carries its own
// `credit_number_next`, and has its own draft->finalized lifecycle. Finalizing a CREDIT writes no
// order status: INVOICED/REOPENED are invoice-owned, and a credit owns none of them.
// -------------------------------------------------------------------------------------------

/** -0 reads back from Postgres as +0, and `toBe` uses Object.is, so a zero line's negation must be
 *  compared as +0, not -0. Non-zero amounts negate as expected. */
const flipped = (n: number) => (n === 0 ? 0 : -n);

describe("createCredit", () => {
  it("derives a credit from a finalized invoice with the sign flipped", async () => {
    const { invoice } = await finalizedFixture(); // default op amount = 144 × 6.51 = 937.44
    const credit = await asSystem(() => createCredit(invoice.id));
    expect(credit.kind).toBe("CREDIT");
    expect(credit.status).toBe("DRAFT");
    expect(credit.sourceInvoiceId).toBe(invoice.id);
    expect(credit.creditNumber).toBe(1000);
    expect(credit.documentNumber).toBe("1000"); // the credit number, NOT the order/invoice number
    expect(credit.total).toBe(-937.44);
    expect(credit.subtotal).toBe(-937.44);

    const op = credit.lines.find((l) => l.kind === "OPERATION")!;
    const part = credit.lines.find((l) => l.kind === "PART")!;
    expect(op.amount).toBe(-937.44);        // money negates
    expect(part.qty).toBe(144);             // quantity does NOT negate — the paper says what was billed
    expect(op.parentLineId).toBe(part.id);  // the OPERATION still hangs off its PART line (parents rewired)
  });

  it("copies the header and reuses the invoice's exact lines, only the money flipped (no drift)", async () => {
    await setSetting("invoice_number_prefix", "7");
    const { invoice } = await finalizedFixture();
    const source = await asSystem(() => getInvoice(invoice.id));
    const credit = await asSystem(() => createCredit(invoice.id));

    // Header snapshots copied verbatim from the source. `invoiceDate` is the deliberate EXCEPTION —
    // a credit takes its own raise date (Task 3/§4.3), never the source's — and is not asserted
    // equal here for that reason (see the dedicated test below; it isn't asserted `not.toBe` here
    // either, since this fixture's source invoice is itself dated "today", same as the credit).
    expect(credit.orderId).toBe(source.orderId);
    expect(credit.customerId).toBe(source.customerId);
    expect(credit.poNumber).toBe(source.poNumber);
    expect(credit.termsName).toBe(source.termsName);
    expect(credit.billTo).toBe(source.billTo);
    expect(credit.shipTo).toBe(source.shipTo);
    expect(credit.materialName).toBe(source.materialName);
    expect(credit.processNames).toBe(source.processNames);
    expect(credit.taxRate).toBe(source.taxRate);

    // Lines are the invoice's lines, position-for-position, with amount negated and everything else
    // (kind, part identity, gl, qty, weight) untouched. This is the anti-drift guarantee.
    expect(credit.lines.length).toBe(source.lines.length);
    credit.lines.forEach((cl, i) => {
      const sl = source.lines[i];
      expect(cl.kind).toBe(sl.kind);
      expect(cl.description).toBe(sl.description);
      expect(cl.glAccountName).toBe(sl.glAccountName);
      expect(cl.qty).toBe(sl.qty);       // unchanged
      expect(cl.weight).toBe(sl.weight); // unchanged
      expect(cl.amount).toBe(flipped(sl.amount)); // money flipped
    });
  });

  it("stamps the credit's own creation date, not the source invoice's date (Task 3/§4.3)", async () => {
    const fixture = await pricedShippedOrder({ qty: 144, unitPrice: "6.5100", minimumCharge: "600.00" });
    const thirtyDaysAgo = formatDateOnly(addDays(todayDateOnly(), -30));
    const { invoice } = await asSystem(() =>
      createInvoice({ orderId: fixture.order.id, invoiceDate: thirtyDaysAgo }));
    await asSystem(() => finalizeInvoice(invoice.id));

    const credit = await asSystem(() => createCredit(invoice.id));
    expect(credit.invoiceDate).toBe(formatDateOnly(todayDateOnly()));
    expect(credit.invoiceDate).not.toBe(thirtyDaysAgo);

    // The audit `after` snapshot carries the credit's OWN date too, not the source's.
    const entry = await prisma.auditLog.findFirst({ where: { entity: "invoice", entityId: credit.id } });
    expect((entry!.after as Record<string, unknown>).invoiceDate).toBe(formatDateOnly(todayDateOnly()));
  });

  it("refuses a credit against a draft", async () => {
    const { invoice } = await draftFixture();
    await expect(asSystem(() => createCredit(invoice.id))).rejects.toThrow(/finalized/i);
  });

  it("refuses to credit a credit, naming it not an invoice", async () => {
    const { invoice } = await finalizedFixture();
    const credit = await asSystem(() => createCredit(invoice.id));
    await expect(asSystem(() => createCredit(credit.id))).rejects.toThrow(/not an invoice/i);
  });

  it("refuses a credit when the order has been voided", async () => {
    const { order, invoice } = await finalizedFixture();
    await prisma.order.update({ where: { id: order.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => createCredit(invoice.id))).rejects.toThrow(/voided/i);
  });

  it("allows a second credit against the same invoice, with its own number", async () => {
    const { invoice } = await finalizedFixture();
    const a = await asSystem(() => createCredit(invoice.id));
    const b = await asSystem(() => createCredit(invoice.id));
    expect(b.creditNumber).toBe(a.creditNumber! + 1);
  });

  it("keeps the source invoice live and finalized alongside its credit", async () => {
    const { order, invoice } = await finalizedFixture();
    await asSystem(() => createCredit(invoice.id));
    // The one-live-invoice-per-order partial index is scoped to kind='INVOICE', so a CREDIT never
    // collides with its source — both are live on the same order.
    const live = await prisma.invoice.count({ where: { orderId: order.id, deletedAt: null } });
    expect(live).toBe(2);
    expect((await getInvoice(invoice.id)).status).toBe("FINALIZED");
  });

  it("audits the create with the negated lines and total in the snapshot", async () => {
    const { invoice } = await finalizedFixture();
    const credit = await asSystem(() => createCredit(invoice.id));
    const entry = await prisma.auditLog.findFirst({ where: { entity: "invoice", entityId: credit.id } });
    expect(entry!.action).toBe("create");
    expect(JSON.stringify(entry!.after)).toContain("-937.44");
  });

  it("can be reduced to a partial amount and finalized without touching the order status", async () => {
    const { order, invoice } = await finalizedFixture();
    expect((await getOrder(order.id)).status).toBe("SHIPPED"); // precondition — untouched by finalizing the credit
    const credit = await asSystem(() => createCredit(invoice.id));
    const reduced = await asSystem(() => replaceInvoiceLines(credit.id,
      credit.lines.map((l) => (l.kind === "OPERATION" ? { ...toLineInput(l), amount: "-100.00" } : toLineInput(l)))));
    expect(reduced.total).toBe(-100);
    const finalized = await asSystem(() => finalizeInvoice(credit.id));
    expect((await getInvoice(credit.id)).status).toBe("FINALIZED");
    expect(finalized.dueDate).toBeNull(); // a CREDIT never gets a due date (Task 3/§4.3)
    expect((await getOrder(order.id)).status).toBe("SHIPPED"); // a credit finalize writes NO order status
  });

  it("finalizing a credit writes no order-status audit entry", async () => {
    const { order, invoice } = await finalizedFixture();
    const credit = await asSystem(() => createCredit(invoice.id));
    // The order already carries update entries from shipping — measure the DELTA around the credit
    // finalize, which must add none (an INVOICE finalize would add one setting the order INVOICED).
    const before = await prisma.auditLog.count({
      where: { entity: "order", entityId: order.id, action: "update" } });
    await asSystem(() => finalizeInvoice(credit.id));
    const after = await prisma.auditLog.count({
      where: { entity: "order", entityId: order.id, action: "update" } });
    expect(after).toBe(before); // finalizing the credit touched only the credit, never the order
  });

  it("never frees a credit number when the draft is discarded", async () => {
    const { invoice } = await finalizedFixture();
    const credit = await asSystem(() => createCredit(invoice.id));
    await asSystem(() => discardInvoice(credit.id, "raised in error"));
    const next = await asSystem(() => createCredit(invoice.id));
    expect(next.creditNumber).toBe(credit.creditNumber! + 1);
  });
});
