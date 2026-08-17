import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { buildStatement, printStatement, runStatements, printStatementsPerDivision } from "@/server/statements";
import { getDocument } from "@/server/documents";
import { parseDateOnly, formatDateOnly, addDays } from "@/lib/business-days";
import type { Customer } from "../prisma/generated/prisma/client";

// Task 12 (P5B §8): assemble an open-item customer statement, render it, archive it as a
// STATEMENT document, and run statements for everyone with a balance. `buildStatement` composes
// its `openItems`/`aging`/`financeCharge` off the SAME point-in-time discipline `aging.ts` uses
// (§6) — a customer with a finalized invoice partly paid, an open credit, and (opt-in) a
// finance-charge assessment on the non-exempt past-due balance. `printStatement` follows the 5A
// print bracket and archives byte-for-byte; `runStatements` prints one per customer with a
// nonzero net balance.

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

beforeEach(truncateAll);

let seq = 0;
const ASOF = "2026-08-08";
const back = (n: number) => formatDateOnly(addDays(parseDateOnly(ASOF), -n));

async function makeCustomer(opts: { financeChargeRate?: string } = {}): Promise<Customer> {
  seq += 1;
  return prisma.customer.create({
    data: {
      code: `STC${seq}`, name: `Statement Customer ${seq}`,
      ...(opts.financeChargeRate !== undefined ? { financeChargeRate: opts.financeChargeRate } : {}),
    },
  });
}

async function finalizedInvoice(
  customerId: string, opts: { total: number; dueDate: string; financeChargeExempt?: boolean },
): Promise<{ id: string; orderNumber: number }> {
  seq += 1;
  const orderNumber = 700000 + seq;
  const order = await prisma.order.create({
    data: {
      orderNumber, customerId, status: "SHIPPED",
      receivedDate: parseDateOnly(back(70)), requestDate: parseDateOnly(back(70)),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId,
      invoiceDate: parseDateOnly(back(70)), dueDate: parseDateOnly(opts.dueDate),
      total: opts.total, finalizedAt: parseDateOnly(back(70)),
      financeChargeExempt: opts.financeChargeExempt ?? false,
    },
  });
  return { id: invoice.id, orderNumber };
}

async function finalizedCredit(customerId: string, opts: { total: number }): Promise<{ id: string; creditNumber: number }> {
  seq += 1;
  const orderNumber = 750000 + seq;
  const order = await prisma.order.create({
    data: {
      orderNumber, customerId, status: "SHIPPED",
      receivedDate: parseDateOnly(back(20)), requestDate: parseDateOnly(back(20)),
    },
  });
  const credit = await prisma.invoice.create({
    data: {
      kind: "CREDIT", status: "FINALIZED", orderId: order.id, customerId,
      invoiceDate: parseDateOnly(back(20)), total: opts.total,
      finalizedAt: parseDateOnly(back(20)), creditNumber: 900000 + seq,
    },
  });
  return { id: credit.id, creditNumber: credit.creditNumber! };
}

async function payInvoice(invoiceId: string, amount: number): Promise<void> {
  seq += 1;
  // A PAYMENT application must name a payment source (Application_source_check, tightened
  // 20260809120000), so attach a real receipt for the invoice's own customer.
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { customerId: true } });
  const batch = await prisma.receiptBatch.create({ data: { batchNumber: 970000 + seq, depositDate: parseDateOnly(back(10)) } });
  const paymentType = await prisma.paymentType.create({ data: { name: `STPT-${seq}` } });
  const payment = await prisma.payment.create({
    data: {
      batchId: batch.id, customerId: invoice.customerId, paymentTypeId: paymentType.id,
      amount, receivedDate: parseDateOnly(back(10)),
    },
  });
  await prisma.application.create({
    data: { invoiceId, amount, type: "PAYMENT", paymentId: payment.id, appliedDate: parseDateOnly(back(10)) },
  });
}

/** A payment carrying UNAPPLIED (on-account) cash: the amount lands, but nothing is applied to an
 *  invoice, so its full amount sits on account. `reference` is the check #. */
async function onAccountPayment(customerId: string, opts: { amount: number; reference?: string }): Promise<void> {
  seq += 1;
  const batch = await prisma.receiptBatch.create({ data: { batchNumber: 980000 + seq, depositDate: parseDateOnly(back(10)) } });
  const paymentType = await prisma.paymentType.create({ data: { name: `STOA-${seq}` } });
  await prisma.payment.create({
    data: {
      batchId: batch.id, customerId, paymentTypeId: paymentType.id,
      amount: opts.amount, reference: opts.reference ?? "", receivedDate: parseDateOnly(back(10)),
    },
  });
}

/** The brief's own fixture: a 1000 invoice partly paid down to 400 open, 40 days past due
 *  (d31_60), plus an open 200 credit. */
async function fixture() {
  const customer = await makeCustomer();
  const invoice = await finalizedInvoice(customer.id, { total: 1000, dueDate: back(40) });
  await payInvoice(invoice.id, 600);
  const credit = await finalizedCredit(customer.id, { total: -200 });
  return { customer, invoice, credit };
}

// -------------------------------------------------------------------------------------------
// Step 1/3: open-item assembly.
// -------------------------------------------------------------------------------------------

describe("buildStatement — open-item assembly", () => {
  it("returns the open invoice, the open credit as a negative, the aging summary, and no finance charge when not assessed", async () => {
    const { customer, credit } = await fixture();
    const data = await buildStatement(customer.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: false });

    expect(data.asOf).toBe(ASOF);
    expect(data.customer.code).toBe(customer.code);

    expect(data.openItems).toHaveLength(2);
    const invoiceItem = data.openItems.find((i) => i.kind === "INVOICE")!;
    expect(invoiceItem.open).toBe(400);
    expect(invoiceItem.original).toBe(1000);
    expect(invoiceItem.dueDate).toBe(back(40));

    const creditItem = data.openItems.find((i) => i.kind === "CREDIT")!;
    expect(creditItem.open).toBe(-200);
    expect(creditItem.original).toBe(-200);
    expect(creditItem.dueDate).toBeNull();
    expect(creditItem.documentNumber).toBe(String(credit.creditNumber));

    expect(data.aging.d31_60).toBe(400);
    expect(data.aging.unapplied).toBe(200);
    expect(data.aging.net).toBe(200);
    expect(data.totalDue).toBe(200);
    expect(data.financeCharge).toBeNull();
  });

  it("shows an on-account payment as a NEGATIVE open item, and the open-item lines reconcile with totalDue", async () => {
    // A $1000 invoice partly paid down to $400 open, plus a $300 payment that sits fully on account
    // (spec §8: "on-account as negatives"). Before Fix #6 the statement printed only the $400 line
    // yet reported Total Due $100 — the document did not reconcile.
    const customer = await makeCustomer();
    const invoice = await finalizedInvoice(customer.id, { total: 1000, dueDate: back(40) });
    await payInvoice(invoice.id, 600); // 400 open
    await onAccountPayment(customer.id, { amount: 300, reference: "CHK-4711" });

    const data = await buildStatement(customer.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: false });

    const invoiceItem = data.openItems.find((i) => i.kind === "INVOICE")!;
    expect(invoiceItem.open).toBe(400);

    const onAccountItem = data.openItems.find((i) => i.kind === "PAYMENT")!;
    expect(onAccountItem.open).toBe(-300);
    expect(onAccountItem.original).toBe(300);
    expect(onAccountItem.documentNumber).toBe("CHK-4711"); // the check reference
    expect(onAccountItem.date).toBe(back(10)); // receivedDate
    expect(onAccountItem.dueDate).toBeNull();

    // The whole point of Fix #6: the open-item lines now SUM to Total Due, off the same on-account
    // basis bucketAging folds into aging.unapplied.
    const sumOpen = data.openItems.reduce((s, i) => s + i.open, 0);
    expect(sumOpen).toBe(data.totalDue);
    expect(data.totalDue).toBe(100); // 400 open − 300 on account
    expect(data.aging.unapplied).toBe(300);
  });

  it("404s a customer that does not exist", async () => {
    await expect(buildStatement("nope", { asOf: ASOF, combineFamily: false, assessFinanceCharges: false }))
      .rejects.toMatchObject({ status: 404 });
  });
});

// -------------------------------------------------------------------------------------------
// Step 5/6: finance charge assessed.
// -------------------------------------------------------------------------------------------

describe("buildStatement — finance charge assessed", () => {
  it("assesses the plant rate on the non-exempt past-due balance", async () => {
    await prisma.billingConfig.update({ where: { id: "singleton" }, data: { financeChargeRate: "1.5" } });
    const { customer } = await fixture();

    const data = await buildStatement(customer.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: true });
    expect(data.financeCharge).toBe(6.00); // round(400 * 1.5%)
  });

  it("prefers the customer's own override rate over the plant default", async () => {
    await prisma.billingConfig.update({ where: { id: "singleton" }, data: { financeChargeRate: "1.5" } });
    const customer = await makeCustomer({ financeChargeRate: "2.0" });
    const invoice = await finalizedInvoice(customer.id, { total: 1000, dueDate: back(40) });
    await payInvoice(invoice.id, 600);

    const data = await buildStatement(customer.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: true });
    expect(data.financeCharge).toBe(8.00); // round(400 * 2%)
  });

  it("excludes an exempt invoice from the finance-charge base", async () => {
    await prisma.billingConfig.update({ where: { id: "singleton" }, data: { financeChargeRate: "1.5" } });
    const customer = await makeCustomer();
    const invoice = await finalizedInvoice(customer.id, { total: 1000, dueDate: back(40), financeChargeExempt: true });
    await payInvoice(invoice.id, 600);

    const data = await buildStatement(customer.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: true });
    expect(data.financeCharge).toBeNull();
  });

  it("is null when nothing is past due, even when assessed", async () => {
    await prisma.billingConfig.update({ where: { id: "singleton" }, data: { financeChargeRate: "1.5" } });
    const customer = await makeCustomer();
    await finalizedInvoice(customer.id, { total: 500, dueDate: formatDateOnly(addDays(parseDateOnly(ASOF), 10)) });

    const data = await buildStatement(customer.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: true });
    expect(data.financeCharge).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------
// Family roll-up.
// -------------------------------------------------------------------------------------------

describe("buildStatement — family roll-up", () => {
  it("combines a parent and its live children into one statement when combineFamily is true", async () => {
    const parent = await makeCustomer();
    const child = await prisma.customer.create({ data: { code: `${parent.code}-B`, name: "Division B", parentId: parent.id } });
    await finalizedInvoice(parent.id, { total: 100, dueDate: back(5) });
    await finalizedInvoice(child.id, { total: 200, dueDate: back(5) });

    const combined = await buildStatement(parent.id, { asOf: ASOF, combineFamily: true, assessFinanceCharges: false });
    expect(combined.openItems).toHaveLength(2);
    expect(combined.totalDue).toBe(300);

    const parentOnly = await buildStatement(parent.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: false });
    expect(parentOnly.openItems).toHaveLength(1);
    expect(parentOnly.totalDue).toBe(100);
  });
});

// #85. "Combined or per-division" (spec §3 ruling 10) is offered as a CHOICE on the statements
// screen, but unchecking "Combine family" sent exactly one request for the parent — which
// `buildStatement` correctly answered with the parent alone. The divisions were silently omitted:
// the advertised option produced strictly less than the combined one, rather than a statement each.
describe("printStatementsPerDivision — the per-division choice (#85)", () => {
  it("archives ONE statement per live family member, each scoped to its own activity", async () => {
    const parent = await makeCustomer();
    const a = await prisma.customer.create({ data: { code: `${parent.code}-A`, name: "Division A", parentId: parent.id } });
    const b = await prisma.customer.create({ data: { code: `${parent.code}-B`, name: "Division B", parentId: parent.id } });
    await finalizedInvoice(parent.id, { total: 100, dueDate: back(5) });
    await finalizedInvoice(a.id, { total: 200, dueDate: back(5) });
    await finalizedInvoice(b.id, { total: 300, dueDate: back(5) });

    const printed = await asSystem(() => printStatementsPerDivision(parent.id, {
      asOf: ASOF, combineFamily: false, assessFinanceCharges: false,
    }));

    // Before the fix this produced ONE document, for the parent only.
    expect(printed.map((p) => p.customerId).sort()).toEqual([parent.id, a.id, b.id].sort());

    // Each is a real archived STATEMENT owned by ITS member, scoped to that member's own activity.
    for (const entry of printed) {
      expect(entry.error).toBeNull();
      const stored = await getDocument(entry.documentId!);
      expect(stored.kind).toBe("STATEMENT");
      expect(stored.customerId).toBe(entry.customerId);
    }
    const totals = new Map(printed.map((p) => [p.customerId, p.totalDue]));
    expect(totals.get(parent.id)).toBe(100);
    expect(totals.get(a.id)).toBe(200);
    expect(totals.get(b.id)).toBe(300);
  });

  // Review round 4: each member is its own committed transaction, so one member failing must not
  // discard the members already archived. Throwing reported the whole run as failed, the screen
  // cleared its list, the committed documents became unreachable, and a retry duplicated them.
  it("returns PARTIAL results when one member fails, keeping the archived ones reachable", async () => {
    const parent = await makeCustomer();
    const good = await prisma.customer.create({
      data: { code: `${parent.code}-OK`, name: "Good Division", parentId: parent.id } });
    const bad = await prisma.customer.create({
      data: { code: `${parent.code}-BAD`, name: "Bad Division", parentId: parent.id } });
    await finalizedInvoice(parent.id, { total: 100, dueDate: back(5) });
    await finalizedInvoice(good.id, { total: 200, dueDate: back(5) });
    await finalizedInvoice(bad.id, { total: 300, dueDate: back(5) });

    // Break exactly ONE member's print, deterministically. Each member gets its own
    // `prisma.$transaction`, so failing the SECOND one fails exactly one member and leaves the
    // first already committed — which is the whole point of the finding. Plain property
    // save/restore (CLAUDE.md forbids `vi.spyOn` on a Prisma MODEL delegate because `mockRestore`
    // corrupts the shared singleton; this is the client's own method, restored in `finally`).
    const original = prisma.$transaction;
    let printed: Awaited<ReturnType<typeof printStatementsPerDivision>>;
    let call = 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prisma as any).$transaction = (...args: unknown[]) => {
        call += 1;
        if (call === 2) return Promise.reject(new Error("render failed for this member"));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (original as any).apply(prisma, args);
      };
      printed = await asSystem(() => printStatementsPerDivision(parent.id, {
        asOf: ASOF, combineFamily: false, assessFinanceCharges: false,
      }));
    } finally {
      prisma.$transaction = original;
    }

    // Every member is reported, and the ones that succeeded carry their document.
    // Every member is reported — the run does not vanish because one member failed.
    expect(printed).toHaveLength(3);
    const ok = printed.filter((r) => r.error === null);
    const failed = printed.filter((r) => r.error !== null);
    expect(ok).toHaveLength(2);
    expect(failed).toHaveLength(1);
    // The successes keep their documents (reachable, so a retry is not the only way back to them)…
    for (const r of ok) {
      expect(r.documentId).not.toBeNull();
      expect((await getDocument(r.documentId!)).customerId).toBe(r.customerId);
    }
    // …and the failure says which member and why, instead of the whole run reporting as failed.
    expect(failed[0].documentId).toBeNull();
    expect(failed[0].error).toMatch(/render failed/i);
    expect([parent.id, good.id, bad.id]).toContain(failed[0].customerId);
  });

  it("excludes a soft-deleted division, and a childless customer gets exactly its own", async () => {
    const parent = await makeCustomer();
    const live = await prisma.customer.create({ data: { code: `${parent.code}-L`, name: "Live", parentId: parent.id } });
    const gone = await prisma.customer.create({
      data: { code: `${parent.code}-X`, name: "Closed", parentId: parent.id, deletedAt: new Date() } });
    await finalizedInvoice(parent.id, { total: 100, dueDate: back(5) });
    await finalizedInvoice(live.id, { total: 200, dueDate: back(5) });
    await finalizedInvoice(gone.id, { total: 999, dueDate: back(5) });

    const family = await asSystem(() => printStatementsPerDivision(parent.id, {
      asOf: ASOF, combineFamily: false, assessFinanceCharges: false,
    }));
    expect(family.map((p) => p.customerId).sort()).toEqual([parent.id, live.id].sort());

    const alone = await makeCustomer();
    await finalizedInvoice(alone.id, { total: 50, dueDate: back(5) });
    const single = await asSystem(() => printStatementsPerDivision(alone.id, {
      asOf: ASOF, combineFamily: false, assessFinanceCharges: false,
    }));
    expect(single).toHaveLength(1);
    expect(single[0].customerId).toBe(alone.id);
  });
});

// -------------------------------------------------------------------------------------------
// Step 7/8: print archives + reprint is byte-exact.
// -------------------------------------------------------------------------------------------

describe("printStatement — archive + reprint", () => {
  it("stores a STATEMENT document owned by the customer, and a reprint returns the identical stored bytes", async () => {
    const { customer } = await fixture();
    const printed = await asSystem(() =>
      printStatement(customer.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: false }));

    const stored = await getDocument(printed.documentId);
    expect(stored.kind).toBe("STATEMENT");
    expect(stored.customerId).toBe(customer.id);
    expect(stored.orderId).toBeNull();
    expect(Buffer.compare(stored.fileData, printed.pdf)).toBe(0); // STORED bytes — exact by design

    // A reprint is a byte-for-byte reissue of the STORED bytes, never a re-render.
    const reprint = await getDocument(printed.documentId);
    expect(Buffer.compare(reprint.fileData, printed.pdf)).toBe(0);
  });

  it("keeps no byte in the audit payload", async () => {
    const { customer } = await fixture();
    const printed = await asSystem(() =>
      printStatement(customer.id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: false }));
    const entry = await prisma.auditLog.findFirst({ where: { entity: "storedDocument", entityId: printed.documentId } });
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry!.after)).not.toContain("fileData");
    expect(JSON.stringify(entry!.after)).not.toContain("%PDF");
  });

  it("404s a customer that does not exist", async () => {
    await expect(asSystem(() =>
      printStatement("nope", { asOf: ASOF, combineFamily: false, assessFinanceCharges: false })))
      .rejects.toMatchObject({ status: 404 });
  });
});

// -------------------------------------------------------------------------------------------
// runStatements — everyone with a balance.
// -------------------------------------------------------------------------------------------

describe("runStatements", () => {
  it("prints a statement for every customer with a nonzero net balance, skipping a fully-settled one", async () => {
    const { customer: owing } = await fixture(); // net 200
    const settled = await makeCustomer();
    const settledInvoice = await finalizedInvoice(settled.id, { total: 500, dueDate: back(5) });
    await payInvoice(settledInvoice.id, 500); // fully paid — net 0

    const results = await asSystem(() => runStatements({ asOf: ASOF, assessFinanceCharges: false }));

    const owingResult = results.find((r) => r.customerId === owing.id);
    expect(owingResult).toBeDefined();
    expect(results.some((r) => r.customerId === settled.id)).toBe(false);

    const doc = await getDocument(owingResult!.documentId);
    expect(doc.kind).toBe("STATEMENT");
    expect(doc.customerId).toBe(owing.id);
  });

  it("returns nothing when no customer carries any A/R history", async () => {
    const results = await asSystem(() => runStatements({ asOf: ASOF, assessFinanceCharges: false }));
    expect(results).toEqual([]);
  });
});
