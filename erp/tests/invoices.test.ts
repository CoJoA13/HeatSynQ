import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
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
  finalizeInvoice, unlockInvoice, createCredit, invoiceWarnings,
  type InvoiceDetail, type InvoiceLineDetail,
} from "@/server/invoices";
import { applyPayment, voidApplication } from "@/server/applications";
import type { Customer, Part } from "../prisma/generated/prisma/client";
import type { CertScopeValue } from "@/lib/cert-constants";
import { addDays, formatDateOnly, parseDateOnly, todayDateOnly } from "@/lib/business-days";

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
  await seedOrderGatePrereqs();
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
  // #96. `buildPricingInput` skips a zero-net line BEFORE the quote/part fork (seam #3), while the
  // lead-line header read resolves `orderLines[0]`'s quote link unconditionally. So the identical
  // corrupt link threw on a zero-net LEAD line and was silently skipped on a zero-net RIDER. The
  // asymmetry was the finding; throwing is the safe direction on corrupt state, so both now throw.
  it("throws on a corrupt quote link on a ZERO-NET rider, as it already did on the lead (#96)", async () => {
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

    // A quote line that quotes partA, linked onto the partB order line — the part-mismatch
    // corruption §5.14 makes unreachable through the services, written here directly.
    const user = await prisma.user.create({
      data: { username: "q96-user", passwordHash: "x", displayName: "Q96" } });
    const quote = await prisma.quote.create({
      data: {
        quoteNumber: 960001, customerId: customer.id, quotedById: user.id,
        quoteDate: parseDateOnly("2026-08-01"), effectiveDate: parseDateOnly("2026-08-01"),
        expiryDate: parseDateOnly("2026-08-31"),
        lines: { create: [{ position: 1, partId: partA.id }] },
      },
      include: { lines: true },
    });
    await prisma.orderLine.update({
      where: { id: order.lines[1].id }, data: { quoteLineId: quote.lines[0].id } });

    // The rider ships ZERO but is marked complete, so the order reaches SHIPPED with a zero-net
    // line — the exact state the skip fires on.
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

    // Before the fix this created a perfectly ordinary invoice, silently ignoring the corruption.
    await expect(asSystem(() => createInvoice({ orderId: order.id })))
      .rejects.toThrow(/quotes a different part/i);
  });

  // #60. `listPartPrices` read through the top-level `prisma` singleton while being called from
  // INSIDE the Serializable invoice transaction, per order line and again for the lead line's
  // process names. A second-connection read sits outside that transaction's snapshot AND its
  // read-set, so a concurrent price edit was invisible to SSI — no 40001, no retry — and the several
  // per-line calls could tear across a mid-flight change. Pinning it the deterministic way: a row
  // written inside the caller's transaction is visible to the pricing read only if that read really
  // is on the caller's transaction. Before the fix this priced "Needs price" off a stale connection.
  it("prices from the CALLER's transaction, not a second connection (#60)", async () => {
    const fixture = await shippedOrder({ qty: 100 });
    const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Sales" } });
    const code = await prisma.processStepCode.create({
      data: { code: "AUST-60", name: "Austemper", glAccountId: gl.id } });

    const invoice = await prisma.$transaction(async (tx) => {
      await tx.partPrice.create({
        data: {
          partId: fixture.part.id, processStepCodeId: code.id, position: 1,
          unitPrice: "2.0000", pricePer: "EACH",
        },
      });
      const created = await asSystem(() => createInvoice({ orderId: fixture.order.id }, tx));
      return created.invoice;
    });

    const op = invoice.lines.find((l) => l.kind === "OPERATION")!;
    expect(op.needsPrice).toBe(false);
    expect(op.amount).toBe(200); // 100 × $2.00, from the uncommitted row
    expect(op.glAccountName).toBe("4010");
    // The lead-line header read takes the same transaction, so it names the same operation.
    expect(invoice.processNames).toBe("Austemper");
  });

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

/** Applies a real PAYMENT against a finalized invoice and returns the created application's id, so a
 *  test can then void it. Receipt-batch / payment-type / payment scaffolding is the
 *  applications.test.ts shape. */
let paySeq = 0;
async function applyAPayment(customerId: string, invoiceId: string, amount: number): Promise<string> {
  paySeq += 1;
  const batch = await prisma.receiptBatch.create({
    data: { batchNumber: 710000 + paySeq, depositDate: parseDateOnly("2026-08-08") },
  });
  const paymentType = await prisma.paymentType.create({ data: { name: `PT-inv-${paySeq}` } });
  const payment = await prisma.payment.create({
    data: {
      batchId: batch.id, customerId, paymentTypeId: paymentType.id,
      amount, receivedDate: parseDateOnly("2026-08-08"),
    },
  });
  await asSystem(() => applyPayment({ paymentId: payment.id, lines: [{ invoiceId, type: "PAYMENT", amount }] }));
  const app = await prisma.application.findFirstOrThrow({ where: { invoiceId, deletedAt: null } });
  return app.id;
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

// -------------------------------------------------------------------------------------------
// The manual-line seam — issues #61 / #62 / #64, one defect surface with three faces. Owner
// rulings 2026-08-17: the override WINS silently (no revert control — remove-and-recalculate is
// the undo, pinned below), and a manual charge's GL account is defaulted SERVER-SIDE (no operator
// picker). Every case here failed before the fix; each is RED-verified.
// -------------------------------------------------------------------------------------------

/** A manual override of a stored line, the shape `InvoiceDetail.tsx`'s `patchRow` produces: editing
 *  an amount stamps `priceSource=MANUAL` and clears `needsPrice` so recalculate keeps it. */
function overrideAmount(l: InvoiceLineDetail, amount: string) {
  return { ...toLineInput(l), amount, priceSource: "MANUAL" as const, needsPrice: false };
}

describe("recalculateInvoice — the manual-line seam", () => {
  it("suppresses the regenerated twin of an overridden operation, in place (#61)", async () => {
    const { invoice } = await draftFixture({ qty: 144 }); // 144 × 6.51 = 937.44
    expect(invoice.lines.find((l) => l.kind === "OPERATION")!.amount).toBe(937.44);
    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "OPERATION" ? overrideAmount(l, "100.00") : toLineInput(l)))));

    const after = await asSystem(() => recalculateInvoice(invoice.id));
    // Before the fix this billed BOTH the regenerated $937.44 and the preserved $100.
    const ops = after.lines.filter((l) => l.kind === "OPERATION");
    expect(ops).toHaveLength(1);
    expect(ops[0].amount).toBe(100);
    expect(ops[0].priceSource).toBe("MANUAL");
    expect(after.subtotal).toBe(100);
    expect(after.total).toBe(100);
    // Substituted IN PLACE, not appended: it keeps its slot under the regenerated PART line rather
    // than becoming the standalone trailing line the issue describes.
    expect(ops[0].parentLineId).toBe(after.lines.find((l) => l.kind === "PART")!.id);
    // The whole set is exactly what a derived recalculate produces — the override occupies the
    // operation's own slot rather than adding a trailing line.
    expect(after.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION"]);
    expect(after.lines.map((l) => l.position)).toEqual([1, 2]);
  });

  // Review round 1 — a step-EXACT identity was not enough. Both cases below double-billed exactly
  // as the original #61 did: the derived line regenerated under a step code the override does not
  // name, so the pairing missed and the override rode along beside it.
  it("suppresses the derived operation when the override PREDATES the part price (#61)", async () => {
    // The invoice is raised before the part is priced, so the engine emits the tier-3 "needs price"
    // OPERATION with NO step code at all. The operator types a price to get the paper out. THEN the
    // shop sets the part price up properly — and the regenerated line now carries a step code.
    const fixture = await shippedOrder({ qty: 144 });
    const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
    const op = invoice.lines.find((l) => l.kind === "OPERATION")!;
    expect(op.needsPrice).toBe(true);
    expect(op.processStepCodeId).toBeNull(); // the tier-3 line this pairing has to cope with
    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "OPERATION" ? overrideAmount(l, "100.00") : toLineInput(l)))));

    const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Sales" } });
    const code = await prisma.processStepCode.create({
      data: { code: "AUST-61a", name: "Austemper", glAccountId: gl.id } });
    await asSystem(() => addPartPrice(fixture.part.id, {
      processStepCodeId: code.id, position: 1, unitPrice: "6.5100", minimumCharge: "600.00",
      pricePer: "EACH",
    }));

    const after = await asSystem(() => recalculateInvoice(invoice.id));
    const ops = after.lines.filter((l) => l.kind === "OPERATION");
    expect(ops).toHaveLength(1); // not the typed $100 PLUS a regenerated $937.44
    expect(ops[0].amount).toBe(100);
    expect(after.total).toBe(100);
  });

  it("suppresses the derived operation when the part's STEP CODE is replaced under an override (#61)", async () => {
    const { invoice, part } = await draftFixture({ qty: 144 });
    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "OPERATION" ? overrideAmount(l, "100.00") : toLineInput(l)))));

    // The priced operation is retired and re-added under a different step code — an ordinary
    // process-vocabulary correction, which must not resurrect the line the operator overrode.
    await prisma.partPrice.updateMany({ where: { partId: part.id }, data: { deletedAt: new Date() } });
    const gl = await prisma.glAccount.create({ data: { name: "4011", description: "Sales" } });
    const code = await prisma.processStepCode.create({
      data: { code: "AUST-61b", name: "Austemper II", glAccountId: gl.id } });
    await asSystem(() => addPartPrice(part.id, {
      processStepCodeId: code.id, position: 1, unitPrice: "6.5100", minimumCharge: "600.00",
      pricePer: "EACH",
    }));

    const after = await asSystem(() => recalculateInvoice(invoice.id));
    const ops = after.lines.filter((l) => l.kind === "OPERATION");
    expect(ops).toHaveLength(1);
    expect(ops[0].amount).toBe(100);
    expect(after.total).toBe(100);
  });

  /** An order line priced under TWO operations, the first overridden to $40. Returns both, so a test
   *  can then disturb one and assert the other survives. */
  async function twoOperationsOneOverridden() {
    const gl = await prisma.glAccount.create({ data: { name: "4012", description: "Sales" } });
    const fixture = await shippedOrder({ qty: 100 });
    const codes = [];
    for (const [i, spec] of [["A", "Op A"], ["B", "Op B"]].entries()) {
      const code = await prisma.processStepCode.create({
        data: { code: `TWO-${spec[0]}`, name: spec[1], glAccountId: gl.id } });
      await asSystem(() => addPartPrice(fixture.part.id, {
        processStepCodeId: code.id, position: i + 1, unitPrice: "1.0000", pricePer: "EACH" }));
      codes.push(code);
    }
    const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
    const ops = invoice.lines.filter((l) => l.kind === "OPERATION");
    expect(ops).toHaveLength(2);
    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.id === ops[0].id ? overrideAmount(l, "40.00") : toLineInput(l)))));
    return { ...fixture, invoice, codes, gl };
  }

  it("keeps a SECOND priced operation billed when only the first is overridden (#61's limit)", async () => {
    // Suppression is per-operation: overriding one of two priced operations must not drop the
    // other's revenue. NOTE this exercises the step-EXACT path — the fallback below is separate.
    const { invoice } = await twoOperationsOneOverridden();
    const after = await asSystem(() => recalculateInvoice(invoice.id));
    expect(after.lines.filter((l) => l.kind === "OPERATION")).toHaveLength(2);
    expect(after.subtotal).toBe(140); // the $40 override + the untouched $100 operation
  });

  // Review round 2: the order-line fallback must not become the mirror of the bug it fixed. With a
  // SIBLING operation on the same order line, re-homing the override onto it would erase that
  // sibling's revenue from customer paper — a double bill traded for an under-bill.
  it("never re-homes an override onto a PRE-EXISTING sibling operation (#61)", async () => {
    const { invoice, part, codes } = await twoOperationsOneOverridden();
    // The overridden operation stops being priced — its part-price row is retired. Operation B is
    // untouched and was ALREADY on the invoice as its own derived line.
    await prisma.partPrice.updateMany({
      where: { partId: part.id, processStepCodeId: codes[0].id }, data: { deletedAt: new Date() } });

    const after = await asSystem(() => recalculateInvoice(invoice.id));
    const ops = after.lines.filter((l) => l.kind === "OPERATION");
    // B keeps its own line at its own price; the stale override rides as an addition, visible to the
    // operator, rather than silently swallowing B.
    expect(ops.map((l) => l.amount).sort((a, b) => a - b)).toEqual([40, 100]);
    expect(after.subtotal).toBe(140);
    // ...and the $100 is genuinely B's REGENERATED line, not the override wearing B's amount — the
    // one alternative shape those two numbers alone cannot rule out.
    const hundred = ops.find((l) => l.amount === 100)!;
    expect(hundred.priceSource).toBe("PART_PRICE");
    expect(hundred.processStepCodeId).toBe(codes[1].id);
    expect(ops.find((l) => l.amount === 40)!.priceSource).toBe("MANUAL");
  });

  it("warns that a typed price with no step code stands in for the whole part (review round 3)", async () => {
    // The ruling's own limit, surfaced rather than guessed at: a tier-3 override covers every priced
    // operation on its order line, INCLUDING work priced afterwards, and the stored state cannot
    // tell that work apart from what the price was typed for. So it says so.
    const fixture = await shippedOrder({ qty: 144 });
    const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "OPERATION" ? overrideAmount(l, "100.00") : toLineInput(l)))));

    const warnings = await asSystem(async () => invoiceWarnings(await getInvoice(invoice.id)));
    expect(warnings.join(" ")).toMatch(/standing in for every priced operation/i);

    // A typed price that DOES name its step code is an ordinary override of that one operation, and
    // must not draw the warning.
    const { invoice: priced } = await draftFixture({ qty: 144 });
    await asSystem(() => replaceInvoiceLines(priced.id, priced.lines.map((l) =>
      (l.kind === "OPERATION" ? overrideAmount(l, "100.00") : toLineInput(l)))));
    const none = await asSystem(async () => invoiceWarnings(await getInvoice(priced.id)));
    expect(none.join(" ")).not.toMatch(/standing in for/i);
  });

  it("recomputes tax on a lines SAVE, not only on recalculate (#64)", async () => {
    // Review round 1: Save lines and Recalculate are independent buttons — nothing makes an operator
    // recalculate after typing a charge, and finalize freezes whatever is there. So the save seam
    // has to re-derive tax too, or a taxable charge goes out on paper under-taxed.
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    const otherGl = await prisma.glAccount.create({ data: { name: "4400", description: "Other charges" } });
    await asSystem(() => setBillingConfig({
      salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000", otherChargeGlAccountId: otherGl.id }));
    const { order } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.taxTotal).toBe(4);

    const saved = await asSystem(() => replaceInvoiceLines(invoice.id, [
      ...invoice.lines.map(toLineInput),
      { kind: "CHARGE" as const, description: "Expedite", amount: "50.00", priceSource: "MANUAL" as const },
    ]));
    expect(saved.taxTotal).toBe(6); // 4% of (100 + 50), without anyone pressing Recalculate
    expect(saved.total).toBe(156);
  });

  it("re-derives a partial CREDIT's tax proportionally on a lines save (#64 reaches credits)", async () => {
    // Review round 2 named this as an untested extension: `createCredit` copies both `taxRate` and
    // the negated lines, so editing a credit down to a partial amount now re-derives its tax instead
    // of keeping the full copied figure. That is what an operator wants, and the arithmetic is
    // sign-symmetric — but it was neither tested nor written down, so it is both now.
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    await asSystem(() => setBillingConfig({ salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000" }));
    const { order } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    await asSystem(() => finalizeInvoice(invoice.id));

    const credit = await asSystem(() => createCredit(invoice.id));
    expect(credit.taxTotal).toBe(-4); // the full invoice's tax, negated and copied

    // Credit only half the work.
    const halved = await asSystem(() => replaceInvoiceLines(credit.id, credit.lines.map((l) =>
      (l.kind === "OPERATION" ? overrideAmount(l, "-50.00") : toLineInput(l)))));
    expect(halved.subtotal).toBe(-50);
    expect(halved.taxTotal).toBe(-2); // 4% of -50, not the copied -4
    expect(halved.total).toBe(-52);
  });

  it("leaves a manually overridden TAX line alone on a lines SAVE too (#64)", async () => {
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    await asSystem(() => setBillingConfig({ salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000" }));
    const { order } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));

    const saved = await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "TAX" ? overrideAmount(l, "9.99") : toLineInput(l)))));
    expect(saved.taxTotal).toBe(9.99);
  });

  it("restores the computed operation once the override row is removed (#61's undo path)", async () => {
    const { invoice } = await draftFixture({ qty: 144 });
    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "OPERATION" ? overrideAmount(l, "100.00") : toLineInput(l)))));
    const overridden = await asSystem(() => recalculateInvoice(invoice.id));
    expect(overridden.total).toBe(100);

    // The ruling took this instead of a per-line "revert to computed" control, so it is a contract:
    // drop the override row, save, recalculate, and the computed line comes back.
    await asSystem(() => replaceInvoiceLines(invoice.id,
      overridden.lines.filter((l) => l.kind !== "OPERATION").map(toLineInput)));
    const restored = await asSystem(() => recalculateInvoice(invoice.id));
    const ops = restored.lines.filter((l) => l.kind === "OPERATION");
    expect(ops).toHaveLength(1);
    expect(ops[0].amount).toBe(937.44);
    expect(ops[0].priceSource).toBe("PART_PRICE");
  });

  it("recomputes tax over a preserved manual charge (#64)", async () => {
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    const otherGl = await prisma.glAccount.create({ data: { name: "4400", description: "Other charges" } });
    await asSystem(() => setBillingConfig({
      salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000", otherChargeGlAccountId: otherGl.id }));
    const { order } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.taxTotal).toBe(4); // 4% of the $100 operation

    await asSystem(() => replaceInvoiceLines(invoice.id, [
      ...invoice.lines.map(toLineInput),
      { kind: "CHARGE" as const, description: "Expedite", amount: "50.00", priceSource: "MANUAL" as const },
    ]));
    const after = await asSystem(() => recalculateInvoice(invoice.id));
    // A CHARGE is in the tax base (pricing.ts §5), so tax is 4% of $150 — before the fix the engine
    // priced tax over the order-derived lines only, leaving the $50 charge untaxed at $4.
    expect(after.chargeTotal).toBe(50);
    expect(after.taxTotal).toBe(6);
    expect(after.total).toBe(156);
  });

  it("recomputes tax over an OVERRIDDEN operation, not the computed one (#61 + #64)", async () => {
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    await asSystem(() => setBillingConfig({ salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000" }));
    const { order } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.taxTotal).toBe(4);

    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "OPERATION" ? overrideAmount(l, "50.00") : toLineInput(l)))));
    const after = await asSystem(() => recalculateInvoice(invoice.id));
    expect(after.subtotal).toBe(50);
    expect(after.taxTotal).toBe(2); // 4% of the override, not of the $100 the engine recomputed
    expect(after.total).toBe(52);
  });

  it("leaves a MANUALLY overridden tax line alone (the override wins, uniformly)", async () => {
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    await asSystem(() => setBillingConfig({ salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000" }));
    const { order } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));

    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "TAX" ? overrideAmount(l, "9.99") : toLineInput(l)))));
    const after = await asSystem(() => recalculateInvoice(invoice.id));
    const tax = after.lines.filter((l) => l.kind === "TAX");
    expect(tax).toHaveLength(1); // never the derived line PLUS the override
    expect(tax[0].amount).toBe(9.99);
    expect(after.taxTotal).toBe(9.99);
  });

  it("defaults a manually added charge to the configured other-charge account (#62)", async () => {
    const otherGl = await prisma.glAccount.create({ data: { name: "4400", description: "Other charges" } });
    await asSystem(() => setBillingConfig({ otherChargeGlAccountId: otherGl.id }));
    const { invoice } = await draftFixture();

    const saved = await asSystem(() => replaceInvoiceLines(invoice.id, [
      ...invoice.lines.map(toLineInput),
      { kind: "CHARGE" as const, description: "Expedite", amount: "50.00", priceSource: "MANUAL" as const },
    ]));
    // The grid renders the GL cell read-only and sends it blank, so the SERVER has to assign it —
    // the same account `mapComputedLines` gives an engine-generated charge (seam #1).
    const charge = saved.lines.find((l) => l.description === "Expedite")!;
    expect(charge.glAccountId).toBe(otherGl.id);
    expect(charge.glAccountName).toBe("4400");

    const after = await asSystem(() => recalculateInvoice(invoice.id));
    expect(after.lines.find((l) => l.description === "Expedite")!.glAccountId).toBe(otherGl.id);
  });

  it("warns about ANY account-bearing line with no GL account, not only operations (#62)", async () => {
    // No other-charge account is configured, so the server default cannot fill one in. The line must
    // then be WARNED about rather than slipping silently into 5C's export (#89 is the same hole,
    // one step later, on the readiness side).
    const { invoice } = await draftFixture();
    await asSystem(() => replaceInvoiceLines(invoice.id, [
      ...invoice.lines.map(toLineInput),
      { kind: "CHARGE" as const, description: "Expedite", amount: "50.00", priceSource: "MANUAL" as const },
    ]));
    const warnings = await asSystem(async () => invoiceWarnings(await getInvoice(invoice.id)));
    expect(warnings.join(" ")).toMatch(/Expedite.*no GL account/i);
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

  // Task 9 (§5.3): the discard A/R guard is DEFENSE-IN-DEPTH and UNREACHABLE by construction. A
  // draft can never carry real A/R activity through the services — `applyPayment`/`applyCredit`
  // require FINALIZED invoices/credits, so no application row that references a DRAFT can be created
  // through the service layer. To prove the guard is WIRED we raw-insert an `Application` naming a
  // DRAFT credit's id: the FK only needs an `Invoice` row and `Application_source_check` does not
  // check finalized status, so the DB accepts it — and `discardInvoice` must then refuse.
  it("refuses to discard a draft that has an application against it (defense-in-depth — unreachable via the services)", async () => {
    const fx = await finalizedFixture(); // a live FINALIZED invoice for the application's non-null invoiceId FK
    const draftCredit = await prisma.invoice.create({
      data: {
        orderId: fx.order.id, customerId: fx.order.customerId, kind: "CREDIT", status: "DRAFT",
        creditNumber: 9200, invoiceDate: parseDateOnly("2026-08-08"),
      },
    });
    await prisma.application.create({
      data: {
        invoiceId: fx.invoice.id, creditInvoiceId: draftCredit.id, amount: "25.00", type: "CREDIT",
        appliedDate: parseDateOnly("2026-08-08"),
      },
    });

    await expect(asSystem(() => discardInvoice(draftCredit.id, "raised in error")))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/payments or credits applied/i) });
    // Refused, not discarded.
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: draftCredit.id } })).deletedAt).toBeNull();
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

  // #63. The line editor lets an operator remove every row, and `replaceInvoiceLines` accepts an
  // empty array. Finalize's only block was `needsPrice`, which a `.find` over zero lines passes
  // VACUOUSLY — so an emptied invoice finalized into a $0 INVOICED order, which then drops out of
  // `listInvoiceCandidates` and can never be billed again. Owner ruling 2026-08-17: block the EMPTY
  // LINE SET, not a zero total (a warranty/rework invoice legitimately goes out at $0), and block at
  // FINALIZE so a draft may still be emptied mid-rebuild.
  it("refuses to finalize an invoice with no lines at all (#63)", async () => {
    const { order, invoice } = await draftFixture();
    await asSystem(() => replaceInvoiceLines(invoice.id, [])); // still allowed — the draft is mid-edit
    await expect(asSystem(() => finalizeInvoice(invoice.id)))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/no lines/i) });
    // Refused, not half-applied: the invoice is still an editable draft and the order has NOT been
    // stranded at INVOICED.
    expect((await getInvoice(invoice.id)).status).toBe("DRAFT");
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
    // And the way out is the ordinary one — recalculate rebuilds the derived lines, then it bills.
    const rebuilt = await asSystem(() => recalculateInvoice(invoice.id));
    expect(rebuilt.lines.length).toBeGreaterThan(0);
    expect((await asSystem(() => finalizeInvoice(invoice.id))).status).toBe("FINALIZED");
  });

  it("finalizes a legitimately $0 invoice that still carries its lines (#63's other half)", async () => {
    // The ruling's point: zero DOLLARS is real paper — a no-charge rework still lists what was done.
    // Only zero LINES is the integrity hole.
    const { order, invoice } = await draftFixture();
    await asSystem(() => replaceInvoiceLines(invoice.id,
      invoice.lines.map((l) => (l.kind === "OPERATION" ? overrideAmount(l, "0.00") : toLineInput(l)))));
    const done = await asSystem(() => finalizeInvoice(invoice.id));
    expect(done.status).toBe("FINALIZED");
    expect(done.total).toBe(0);
    expect((await getOrder(order.id)).status).toBe("INVOICED");
  });

  // #79. `termsName` always snapshotted the label; the NUMBERS behind it are frozen here too, beside
  // `dueDate` and for the same reason — an invoice is frozen paper (§5.4). Without this write the
  // frozen columns would be null and every newly finalized invoice would silently offer no
  // early-pay discount at all, which is the opposite of the bug being fixed.
  it("freezes the issued early-pay terms at finalize, and gives a CREDIT none (#79)", async () => {
    const terms = await prisma.terms.create({
      data: { name: "2/10 Net 30", netDays: 30, discountPercent: "2.00", discountDays: 10 } });
    const { order, invoice } = await draftFixture();
    await prisma.customer.update({ where: { id: order.customerId }, data: { termsId: terms.id } });

    await asSystem(() => finalizeInvoice(invoice.id));
    const frozen = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(frozen.termsDiscountPercent?.toNumber()).toBe(2);
    expect(frozen.termsDiscountDays).toBe(10);

    // Moving the customer off those terms afterwards must not touch what the invoice froze.
    const plain = await prisma.terms.create({ data: { name: "Net 30", netDays: 30 } });
    await prisma.customer.update({ where: { id: order.customerId }, data: { termsId: plain.id } });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.termsDiscountPercent?.toNumber()).toBe(2);
    expect(after.termsDiscountDays).toBe(10);

    // A CREDIT offers no early-pay discount, exactly as it gets no due date.
    const credit = await asSystem(() => createCredit(invoice.id));
    await asSystem(() => finalizeInvoice(credit.id));
    const frozenCredit = await prisma.invoice.findUniqueOrThrow({ where: { id: credit.id } });
    expect(frozenCredit.termsDiscountPercent).toBeNull();
    expect(frozenCredit.termsDiscountDays).toBeNull();
    expect(frozenCredit.dueDate).toBeNull();
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

  // #59. `finalizeInvoiceInTx` branches on `kind` — only an INVOICE owns the order's status (§5.2) —
  // but `unlockInvoice` did not, so unlocking a CREDIT passed the order in the `released` set and
  // recomputed it to a ship-derived status. The source INVOICE stayed FINALIZED, still owning
  // INVOICED, while the order silently fell back to SHIPPED.
  it("unlocking a CREDIT leaves the order's invoice-owned status alone (#59)", async () => {
    const { order, invoice } = await draftFixture();
    await asSystem(() => finalizeInvoice(invoice.id));
    expect((await getOrder(order.id)).status).toBe("INVOICED");

    const credit = await asSystem(() => createCredit(invoice.id));
    await asSystem(() => finalizeInvoice(credit.id));
    expect((await getOrder(order.id)).status).toBe("INVOICED"); // finalizing a credit never wrote it

    await asSystem(() => unlockInvoice(credit.id, "credited the wrong amount"));
    expect((await getInvoice(credit.id)).status).toBe("DRAFT");
    // Before the fix: SHIPPED, while the source invoice was still FINALIZED.
    expect((await getOrder(order.id)).status).toBe("INVOICED");
    // ...and no order-status audit entry was written by the credit unlock at all.
    const ord = await prisma.auditLog.findFirst({
      where: { entity: "order", entityId: order.id, action: "update" }, orderBy: { at: "desc" } });
    expect((ord!.after as Record<string, unknown>).status).toBe("INVOICED");
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

  // Task 9 (§5.3): a FINALIZED invoice with a live payment applied cannot be unlocked — unlocking
  // would leave editable paper that money has already been applied to. Void the application first.
  it("refuses to unlock once a payment has been applied, then re-permits once the application is voided", async () => {
    const fx = await finalizedFixture();
    const applicationId = await applyAPayment(fx.order.customerId, fx.invoice.id, 100);

    await expect(asSystem(() => unlockInvoice(fx.invoice.id, "correct a line")))
      .rejects.toMatchObject({
        status: 400,
        message: `Invoice #${fx.order.orderNumber} has payments applied — void them before unlocking`,
      });
    // Refused, not half-applied: still FINALIZED.
    expect((await getInvoice(fx.invoice.id)).status).toBe("FINALIZED");

    // Voiding the application drops the A/R activity; the unlock is now permitted and audited.
    await asSystem(() => voidApplication(applicationId, "keyed to the wrong invoice"));
    const unlocked = await asSystem(() => unlockInvoice(fx.invoice.id, "customer disputed a line"));
    expect(unlocked.status).toBe("DRAFT");
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "invoice", entityId: fx.invoice.id, action: "update" }, orderBy: { at: "desc" } });
    expect(entry!.reason).toBe("customer disputed a line");
    expect((entry!.before as Record<string, unknown>).status).toBe("FINALIZED");
    expect((entry!.after as Record<string, unknown>).status).toBe("DRAFT");
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
