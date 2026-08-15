import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { HttpError } from "@/server/errors";
import { createOrder, getOrder, type OrderDetail } from "@/server/orders";
import { createShipper } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { createSurcharge, setSurchargeStepCodes } from "@/server/surcharges";
import {
  createInvoice, getInvoice, discardInvoice, finalizeInvoice, unlockInvoice,
  recalculateInvoice, createCredit, replaceInvoiceLines, readInvoicePdfData,
  type InvoiceDetail, type InvoiceLineDetail,
} from "@/server/invoices";
import { buildInvoiceDefinition } from "@/server/pdf/invoice";
import type { Customer, Part, ProcessStepCode, User } from "../prisma/generated/prisma/client";
import { addDays, todayDateOnly } from "@/lib/business-days";

// ============================================================================================
// Phase 6 Task 6 — tier-1 substitution at invoice assembly (spec §5.3, rulings 4 + 8) and the
// frozen `sourceQuoteNumber`. Quote fixtures are raw prisma (the quote-links.test.ts rule): the
// assembly under test must not depend on the quote service to construct its data. The quote's
// window brackets TODAY because `createOrder` defaults `receivedDate` to today and Task 5's
// auto-link judges against it — the fixture asserts the link actually took, so no test below can
// silently pass against an unlinked (part-priced) line.
// ============================================================================================

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** Every `text` string anywhere in a document definition, flattened — copied from
 *  tests/invoice-pdf.test.ts (content pins live on the DEFINITION, never on rendered bytes). */
function allText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  if (typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) allText(value, out);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Fixtures — order/shipping helpers copied in shape from tests/invoices.test.ts (copying across
// test files is this repo's convention); quote fixtures raw.
// -------------------------------------------------------------------------------------------

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `QP${customerSeq}`, name: `Quote Customer ${customerSeq}` } });
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

function oneOrderInput(order: OrderDetail) {
  return {
    customerId: order.customerId,
    shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: [{
        orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight,
        lineComplete: true,
      }],
      containers: [] as { orderContainerId: string; count: number }[],
      serials: [] as { orderSerialId: string; printOnShipper?: boolean }[],
    }],
  };
}

/** One live QuotePrice row's spec. Money fields are Decimal strings as the column takes them. */
type QuoteRowSpec = {
  unitPrice?: string | null; minimumCharge?: string | null; setupCharge?: string | null;
  pricePer?: "EACH" | "LB" | "PER_100" | "PER_1000" | "LOT";
  position?: number;
  breaks?: { threshold: string; price: string; deleted?: boolean }[];
  deleted?: boolean; // a soft-deleted row — its (live) breaks must never surface
  glName?: string | null;
  stepName?: string;
};

let quoteStepSeq = 0;
async function addQuoteRow(quoteLineId: string, spec: QuoteRowSpec): Promise<ProcessStepCode> {
  quoteStepSeq += 1;
  const gl = spec.glName === null ? null : await prisma.glAccount.create({
    // Distinct default per row — GlAccount.name is unique ("4020", "4021", ...).
    data: { name: spec.glName ?? String(4019 + quoteStepSeq), description: "Quoted sales" },
  });
  const code = await prisma.processStepCode.create({
    data: { code: `Q-OP-${quoteStepSeq}`, name: spec.stepName ?? `Quoted Op ${quoteStepSeq}`, glAccountId: gl?.id ?? null },
  });
  await prisma.quotePrice.create({
    data: {
      quoteLineId, processStepCodeId: code.id, position: spec.position ?? quoteStepSeq,
      unitPrice: spec.unitPrice === null ? null : (spec.unitPrice ?? "6.5100"),
      minimumCharge: spec.minimumCharge ?? null,
      setupCharge: spec.setupCharge ?? null,
      pricePer: spec.pricePer ?? "EACH",
      deletedAt: spec.deleted ? new Date() : null,
      breaks: {
        create: (spec.breaks ?? []).map((b) => ({
          threshold: b.threshold, price: b.price, deletedAt: b.deleted ? new Date() : null,
        })),
      },
    },
  });
  return code;
}

/**
 * A SHIPPED order whose one line auto-linked (Task 5) to quote #1006's line for its part.
 * The part carries its OWN tier-2 price row (a different step code, $9.99 EACH, GL 4010) unless
 * `partRow: false` — present precisely so its ABSENCE from the invoice can be asserted (ruling 4's
 * wholesale rule: when the link is taken the part's rows are not even fetched).
 */
async function quotedShippedOrder(opts: {
  quoteRows?: QuoteRowSpec[]; partRow?: boolean; qty?: number; weight?: string;
} = {}) {
  const customer = await makeCustomer();
  const part = await makePart(customer.id);
  await giveSteps(part.id);

  let partStepCode: ProcessStepCode | null = null;
  if (opts.partRow !== false) {
    const partGl = await prisma.glAccount.create({ data: { name: "4010", description: "Part sales" } });
    const code = await prisma.processStepCode.create({
      data: { code: "PART-OP", name: "Part-priced Op", glAccountId: partGl.id },
    });
    partStepCode = code;
    await asSystem(() => addPartPrice(part.id, {
      processStepCodeId: code.id, position: 1, unitPrice: "9.9900", pricePer: "EACH",
    }));
  }

  const user: User = await prisma.user.create({
    data: { username: "qp-user", passwordHash: "x", displayName: "QP User" },
  });
  const today = todayDateOnly();
  const quote = await prisma.quote.create({
    data: {
      quoteNumber: 1006, customerId: customer.id, quotedById: user.id,
      quoteDate: today, effectiveDate: addDays(today, -5), expiryDate: addDays(today, 30),
      lines: { create: [{ position: 1, partId: part.id }] },
    },
    include: { lines: true },
  });
  const quoteLine = quote.lines[0];

  const rows = opts.quoteRows ?? [{}];
  const quoteStepCodes: ProcessStepCode[] = [];
  for (const spec of rows) quoteStepCodes.push(await addQuoteRow(quoteLine.id, spec));

  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    lines: [{ partId: part.id, qty: opts.qty ?? 144, weight: opts.weight ?? "3024.00" }],
  }));
  // The fixture's own guard: without the auto-link every assertion below tests nothing.
  if (order.lines[0].quoteLineId !== quoteLine.id) {
    throw new Error("fixture: the Task 5 auto-link did not take");
  }
  await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });

  return {
    order: await getOrder(order.id), customer, part, quote, quoteLine, quoteStepCodes, partStepCode,
  };
}

const opLines = (invoice: InvoiceDetail): InvoiceLineDetail[] =>
  invoice.lines.filter((l) => l.kind === "OPERATION");

beforeEach(async () => {
  await truncateAll();
  await seedOrderGatePrereqs();
  customerSeq = 0;
  partSeq = 0;
  quoteStepSeq = 0;
});

// -------------------------------------------------------------------------------------------
// Wholesale substitution (ruling 4).
// -------------------------------------------------------------------------------------------

describe("tier-1 substitution — wholesale (ruling 4)", () => {
  it("prices a linked line from the quote's rows only — QUOTE source, frozen number, GL from the quote row's step code, part rows absent", async () => {
    const f = await quotedShippedOrder();
    const { invoice, warnings } = await asSystem(() => createInvoice({ orderId: f.order.id }));

    const ops = opLines(invoice);
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op.processStepCodeId).toBe(f.quoteStepCodes[0].id);
    expect(op.description).toBe("Quoted Op 1");
    expect(op.priceSource).toBe("QUOTE");
    expect(op.sourceQuoteNumber).toBe(1006);
    expect(op.glAccountName).toBe("4020"); // resolved from the QUOTE row's step code, listPartPrices-style
    expect(op.amount).toBe(937.44);        // 144 × 6.51 — the quote's price, not the part's 9.99

    // Ruling 4, RED-verified: the part's own row must not appear in ANY form — not as a line, not
    // as a merged price, not as an amount.
    expect(invoice.lines.some((l) => l.processStepCodeId === f.partStepCode!.id)).toBe(false);
    expect(invoice.lines.some((l) => l.amount === 1438.56)).toBe(false); // 144 × 9.99
    expect(invoice.total).toBe(937.44);
    expect(warnings).toEqual([]);

    // The lead-price path (invoice header "Process:") substitutes too — the quote's step names,
    // never the part's.
    expect(invoice.processNames).toBe("Quoted Op 1");
  });

  it("reads live rows through live parents in position order — a deleted row's still-live breaks never surface, a live row's deleted break is ignored", async () => {
    const f = await quotedShippedOrder({
      quoteRows: [
        // Live row, position 2 — created FIRST so position (not insertion) must order the lines.
        { position: 2, stepName: "Second Op", unitPrice: "1.0000" },
        // Live row, position 1, with a soft-deleted break that would change the price if read.
        { position: 1, stepName: "First Op", unitPrice: "6.5100",
          breaks: [{ threshold: "1.00", price: "0.0100", deleted: true }] },
        // Soft-deleted row with a LIVE break — the Task 4 dangling-grandchildren shape: the break
        // is live, its parent is not, so nothing here may ever read it.
        { position: 3, stepName: "Dead Op", unitPrice: "99.0000", deleted: true,
          breaks: [{ threshold: "1.00", price: "0.0001" }] },
      ],
    });
    const { invoice } = await asSystem(() => createInvoice({ orderId: f.order.id }));

    const ops = opLines(invoice);
    expect(ops.map((l) => l.description)).toEqual(["First Op", "Second Op"]);
    expect(ops[0].unitPrice).toBe(6.51);      // the deleted break did NOT price this row
    expect(ops[0].breakThreshold).toBeNull();
    expect(ops[0].amount).toBe(937.44);
    expect(ops[1].amount).toBe(144);
    expect(invoice.lines.some((l) => l.description === "Dead Op")).toBe(false);
    expect(invoice.total).toBe(1081.44);
  });

  it("a linked line whose quote line has ZERO live rows invoices as needs-price — never the part fallback (ruling 4)", async () => {
    const f = await quotedShippedOrder({
      // One row exists but is soft-deleted: zero LIVE rows, while the part still carries its
      // own perfectly good $9.99 row — the exact bait for a silent fallback.
      quoteRows: [{ deleted: true, unitPrice: "5.0000" }],
    });
    const { invoice, warnings } = await asSystem(() => createInvoice({ orderId: f.order.id }));

    const ops = opLines(invoice);
    expect(ops).toHaveLength(1);
    expect(ops[0].needsPrice).toBe(true);
    expect(ops[0].amount).toBe(0);
    expect(ops[0].processStepCodeId).toBeNull();
    // The part's rows were not fetched, not merged, not fallen back to.
    expect(invoice.lines.some((l) => l.processStepCodeId === f.partStepCode!.id)).toBe(false);
    expect(invoice.lines.some((l) => l.amount === 1438.56)).toBe(false);
    expect(invoice.total).toBe(0);
    expect(warnings.join(" ")).toMatch(/needs a price/i);
  });
});

// -------------------------------------------------------------------------------------------
// The engine's semantics over quote rows, unchanged.
// -------------------------------------------------------------------------------------------

describe("tier-1 substitution — engine semantics over quote rows", () => {
  it("breaks, minimum-as-floor and setup-on-top apply to quote rows through the real engine", async () => {
    const f = await quotedShippedOrder({
      quoteRows: [{
        unitPrice: "6.5100", minimumCharge: "1000.00", setupCharge: "75.00",
        breaks: [{ threshold: "100.00", price: "6.0000" }],
      }],
    });
    const { invoice } = await asSystem(() => createInvoice({ orderId: f.order.id }));
    const op = opLines(invoice)[0];
    expect(op.unitPrice).toBe(6);          // the 100-threshold break resolved the price (qty 144)
    expect(op.breakThreshold).toBe(100);
    expect(op.minimumApplied).toBe(true);  // 144 × 6.00 = 864, floored to 1000
    expect(op.amount).toBe(1075);          // + 75 setup ON TOP (ruling 13)
    expect(op.priceSource).toBe("QUOTE");
    expect(op.sourceQuoteNumber).toBe(1006);
  });

  it("surcharges scope by step code over quote-priced operations exactly as over part-priced ones", async () => {
    const f = await quotedShippedOrder({ qty: 100, quoteRows: [{ unitPrice: "1.0000" }] });
    const inGl = await prisma.glAccount.create({ data: { name: "4500", description: "Surcharge" } });
    const inc = await asSystem(() => createSurcharge({
      name: "IncSur", kind: "PERCENT", rate: "0.050000", position: 1, glAccountId: inGl.id,
      scope: "INCLUDE",
    }));
    await asSystem(() => setSurchargeStepCodes(inc.id, [f.quoteStepCodes[0].id]));
    const exc = await asSystem(() => createSurcharge({
      name: "ExcSur", kind: "PERCENT", rate: "0.050000", position: 2,
      scope: "EXCLUDE",
    }));
    await asSystem(() => setSurchargeStepCodes(exc.id, [f.quoteStepCodes[0].id]));
    const { invoice } = await asSystem(() => createInvoice({ orderId: f.order.id }));

    const surcharges = invoice.lines.filter((l) => l.kind === "SURCHARGE");
    expect(surcharges.map((s) => s.description)).toEqual(["IncSur"]); // EXCLUDE listing the only op bills nothing
    expect(surcharges[0].amount).toBe(5); // 5% of the $100 quote-priced operation
    expect(invoice.surchargeTotal).toBe(5);
  });
});

// -------------------------------------------------------------------------------------------
// Live until finalize (ruling 8), the frozen column, and the copies.
// -------------------------------------------------------------------------------------------

describe("tier-1 substitution — live until finalize (ruling 8) and the frozen source", () => {
  it("quote edits price the NEXT invoice; a finalized invoice is frozen; unlock + recalculate re-resolves current rows", async () => {
    const f = await quotedShippedOrder();
    const price = await prisma.quotePrice.findFirstOrThrow({ where: { quoteLineId: f.quoteLine.id } });

    const first = await asSystem(() => createInvoice({ orderId: f.order.id }));
    expect(opLines(first.invoice)[0].amount).toBe(937.44); // 144 × 6.51
    await asSystem(() => discardInvoice(first.invoice.id, "re-quote"));

    await prisma.quotePrice.update({ where: { id: price.id }, data: { unitPrice: "7.0000" } });
    const second = await asSystem(() => createInvoice({ orderId: f.order.id }));
    expect(opLines(second.invoice)[0].amount).toBe(1008); // 144 × 7.00 — live until finalize

    await asSystem(() => finalizeInvoice(second.invoice.id));
    await prisma.quotePrice.update({ where: { id: price.id }, data: { unitPrice: "8.0000" } });
    const frozen = await getInvoice(second.invoice.id);
    expect(opLines(frozen)[0].amount).toBe(1008); // finalized paper does not move

    await asSystem(() => unlockInvoice(second.invoice.id, "renegotiated"));
    const recalced = await asSystem(() => recalculateInvoice(second.invoice.id));
    const op = opLines(recalced)[0];
    expect(op.amount).toBe(1152); // 144 × 8.00 — the link honored, CURRENT quote rows (ruling 8)
    expect(op.priceSource).toBe("QUOTE");
    expect(op.sourceQuoteNumber).toBe(1006);
  });

  it("the frozen sourceQuoteNumber survives quote deletion — the invoice line and PDF read the line's own column", async () => {
    const f = await quotedShippedOrder();
    const { invoice } = await asSystem(() => createInvoice({ orderId: f.order.id }));
    await asSystem(() => finalizeInvoice(invoice.id));

    // Fabricate the legal sequence: the order line is unlinked (an order-side edit), which lifts
    // the §5.14 block, then the quote and its line are deleted. The finalized invoice's display
    // must not notice — it reads its own frozen column, never a live join.
    await prisma.orderLine.update({ where: { id: f.order.lines[0].id }, data: { quoteLineId: null } });
    await prisma.quoteLine.update({ where: { id: f.quoteLine.id }, data: { deletedAt: new Date() } });
    await prisma.quote.update({ where: { id: f.quote.id }, data: { deletedAt: new Date() } });

    const detail = await getInvoice(invoice.id);
    const op = opLines(detail)[0];
    expect(op.priceSource).toBe("QUOTE");
    expect(op.sourceQuoteNumber).toBe(1006);

    const data = await readInvoicePdfData(prisma, invoice.id);
    expect(data.priceRows[0].sourceQuoteNumber).toBe(1006);
    expect(allText(buildInvoiceDefinition(data)).join("\n")).toContain("Quote #1006");
  });

  it("createCredit's line copy carries sourceQuoteNumber with the money sign flipped", async () => {
    const f = await quotedShippedOrder();
    const { invoice } = await asSystem(() => createInvoice({ orderId: f.order.id }));
    await asSystem(() => finalizeInvoice(invoice.id));
    const credit = await asSystem(() => createCredit(invoice.id));

    const op = opLines(credit)[0];
    expect(op.priceSource).toBe("QUOTE");
    expect(op.sourceQuoteNumber).toBe(1006);
    expect(op.amount).toBe(-937.44);
  });

  it("replaceInvoiceLines round-trips the frozen sourceQuoteNumber (the UI grid's save path)", async () => {
    const f = await quotedShippedOrder();
    const { invoice } = await asSystem(() => createInvoice({ orderId: f.order.id }));
    const payload = invoice.lines.map((l) => ({
      key: l.id, parentKey: l.parentLineId,
      kind: l.kind, orderLineId: l.orderLineId, processStepCodeId: l.processStepCodeId,
      surchargeId: l.surchargeId, orderChargeId: l.orderChargeId, glAccountId: l.glAccountId,
      partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
      description: l.description, glAccountName: l.glAccountName,
      qty: l.qty, weight: l.weight, eachWeight: l.eachWeight,
      pricePer: l.pricePer, unitPrice: l.unitPrice, setupCharge: l.setupCharge,
      minimumCharge: l.minimumCharge, breakThreshold: l.breakThreshold, minimumApplied: l.minimumApplied,
      rate: l.rate, priceSource: l.priceSource, sourceQuoteNumber: l.sourceQuoteNumber,
      needsPrice: l.needsPrice, amount: l.amount,
    }));
    const saved = await asSystem(() => replaceInvoiceLines(invoice.id, payload));
    const op = opLines(saved)[0];
    expect(op.priceSource).toBe("QUOTE");
    expect(op.sourceQuoteNumber).toBe(1006);
  });
});

// -------------------------------------------------------------------------------------------
// The corrupt-state invariants — bugs, not expected failures: plain Error, never an HttpError.
// §5.14 refuses deleting (or re-pointing) a linked quote line, and every stored link was judged
// at save time, so both states below are unreachable through the services. Pricing from the part
// instead would be the silent re-price §7.5 exists to prevent; a 500 is the honest answer.
// -------------------------------------------------------------------------------------------

describe("tier-1 substitution — corrupt-state invariants", () => {
  const plainError = async (run: () => Promise<unknown>): Promise<Error> => {
    const err = await run().then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(HttpError);
    return err!;
  };

  it("a link pointing at a quote line for a DIFFERENT part throws a plain Error", async () => {
    const f = await quotedShippedOrder();
    const otherPart = await makePart(f.customer.id);
    const otherLine = await prisma.quoteLine.create({
      data: { quoteId: f.quote.id, position: 2, partId: otherPart.id },
    });
    await prisma.orderLine.update({
      where: { id: f.order.lines[0].id }, data: { quoteLineId: otherLine.id },
    });

    const err = await plainError(() => asSystem(() => createInvoice({ orderId: f.order.id })));
    expect(err.message).toMatch(/different part/i);
    expect(await prisma.invoice.count()).toBe(0); // nothing was priced, nothing was written
  });

  it("a link pointing at a soft-deleted quote line throws a plain Error — never a silent re-price from part rows", async () => {
    const f = await quotedShippedOrder();
    await prisma.quoteLine.update({ where: { id: f.quoteLine.id }, data: { deletedAt: new Date() } });

    const err = await plainError(() => asSystem(() => createInvoice({ orderId: f.order.id })));
    expect(err.message).toMatch(/deleted or missing/i);
    expect(await prisma.invoice.count()).toBe(0);
  });
});
