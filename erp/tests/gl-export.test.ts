import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { exportClose, readinessForExport } from "@/server/gl-export";
import { closePeriod, reopenPeriod } from "@/server/close-periods";
import { unlockInvoice } from "@/server/invoices";
import { parseDateOnly } from "@/lib/business-days";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

beforeEach(truncateAll);

// -------------------------------------------------------------------------------------------
// Task 6 (P5C §4.3): the per-event GL-export delta. Factories build finalized invoices with a
// real revenue line, posted payments, and discount/write-off applications directly (the
// close-periods.test.ts pattern) so the journal inputs are exact. `seedGlDefaults` sets the
// BillingConfig GL account defaults so the readiness gate passes.
// -------------------------------------------------------------------------------------------

let seq = 0;
type Gl = { arId: string; revId: string; cashId: string; discountId: string; writeOffId: string; taxId: string; stepCodeId: string };

async function seedGlDefaults(): Promise<Gl> {
  const mk = (name: string) => prisma.glAccount.create({ data: { name } });
  const ar = await mk("1200-AR");
  const rev = await mk("4010-REV");
  const cash = await mk("1000-CASH");
  const discount = await mk("4900-DISC");
  const writeOff = await mk("6000-WO");
  const tax = await mk("2200-TAX");
  const step = await prisma.processStepCode.create({
    data: { code: "HT", name: "Heat Treat", glAccountId: rev.id },
  });
  await prisma.billingConfig.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      arGlAccountId: ar.id, discountGlAccountId: discount.id,
      writeOffGlAccountId: writeOff.id, salesTaxGlAccountId: tax.id,
    },
    update: {
      arGlAccountId: ar.id, discountGlAccountId: discount.id,
      writeOffGlAccountId: writeOff.id, salesTaxGlAccountId: tax.id,
    },
  });
  return {
    arId: ar.id, revId: rev.id, cashId: cash.id, discountId: discount.id,
    writeOffId: writeOff.id, taxId: tax.id, stepCodeId: step.id,
  };
}

type InvoiceRef = { invoiceId: string; customerId: string };

/** A finalized INVOICE with one OPERATION revenue line (glAccountId = revenue) summing to `total`,
 *  optionally with tax. Its schedule invoicedTotal and aging both move by `total`. */
async function makeFinalizedInvoiceDated(
  gl: Gl, dateStr: string, total: number, opts: { taxTotal?: number } = {},
): Promise<InvoiceRef> {
  seq += 1;
  const taxTotal = opts.taxTotal ?? 0;
  const revenue = total - taxTotal;
  const customer = await prisma.customer.create({ data: { code: `GLX${seq}`, name: `GL Customer ${seq}` } });
  const order = await prisma.order.create({
    data: {
      orderNumber: 760000 + seq, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly(dateStr), requestDate: parseDateOnly(dateStr),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
      invoiceDate: parseDateOnly(dateStr), dueDate: parseDateOnly(dateStr),
      total, taxTotal, subtotal: revenue, finalizedAt: parseDateOnly(dateStr),
      lines: {
        create: [
          {
            position: 1, kind: "OPERATION", processStepCodeId: gl.stepCodeId,
            glAccountId: gl.revId, glAccountName: "4010-REV", description: "Heat Treat", amount: revenue,
          },
          ...(taxTotal !== 0
            ? [{
                position: 2, kind: "TAX" as const, glAccountId: gl.taxId,
                glAccountName: "2200-TAX", description: "Sales tax", amount: taxTotal,
              }]
            : []),
        ],
      },
    },
  });
  return { invoiceId: invoice.id, customerId: customer.id };
}

/** A POSTED-batch payment (its own cash GL event), applied to `inv` so the schedule reconciles. */
async function payInvoiceDated(gl: Gl, inv: InvoiceRef, dateStr: string, amount: number): Promise<void> {
  seq += 1;
  const paymentType = await prisma.paymentType.create({
    data: { name: `PT-${seq}`, glAccountId: gl.cashId },
  });
  const batch = await prisma.receiptBatch.create({
    data: { batchNumber: 860000 + seq, depositDate: parseDateOnly(dateStr), status: "POSTED" },
  });
  const payment = await prisma.payment.create({
    data: {
      batchId: batch.id, customerId: inv.customerId, paymentTypeId: paymentType.id,
      amount, receivedDate: parseDateOnly(dateStr),
    },
  });
  await prisma.application.create({
    data: {
      invoiceId: inv.invoiceId, amount, type: "PAYMENT", paymentId: payment.id,
      appliedDate: parseDateOnly(dateStr),
    },
  });
}

/** A finalized INVOICE carrying a SINGLE non-OPERATION revenue line (CHARGE or FREIGHT) whose
 *  snapshot `glAccountId` may be null — the exact shape the two-lens review found: the export drops a
 *  null-GL non-TAX line from the credit side while still debiting A/R the full `total`. `glAccountId`
 *  null models "the freight/other-charge plant default is unset"; set it to model the configured case. */
async function makeFinalizedKindLine(
  dateStr: string, kind: "CHARGE" | "FREIGHT", amount: number, glAccountId: string | null,
): Promise<InvoiceRef> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `GLK${seq}`, name: `GL K ${seq}` } });
  const order = await prisma.order.create({
    data: {
      orderNumber: 770000 + seq, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly(dateStr), requestDate: parseDateOnly(dateStr),
    },
  });
  const totalsField = kind === "CHARGE" ? { chargeTotal: amount } : { freightTotal: amount };
  const invoice = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
      invoiceDate: parseDateOnly(dateStr), dueDate: parseDateOnly(dateStr),
      total: amount, ...totalsField, finalizedAt: parseDateOnly(dateStr),
      lines: {
        create: [{
          position: 1, kind, glAccountId, glAccountName: glAccountId ? "acct" : "",
          description: kind === "CHARGE" ? "Extra charge" : "Freight", amount,
        }],
      },
    },
  });
  return { invoiceId: invoice.id, customerId: customer.id };
}

/** Like `makeFinalizedInvoiceDated`, but lets `invoiceDate` and `finalizedAt` diverge across a month
 *  boundary — the shape ruling 8 exists for: paper dated in one month, locked in the next. Recognition
 *  scoping is by `finalizedAt` everywhere (gl-export.ts, close-periods.ts), never `invoiceDate`. */
async function makeFinalizedInvoiceWithDates(
  gl: Gl, invoiceDateStr: string, finalizedAtStr: string, total: number,
): Promise<InvoiceRef> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `GLW${seq}`, name: `GL Divergent ${seq}` } });
  const order = await prisma.order.create({
    data: {
      orderNumber: 780000 + seq, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly(invoiceDateStr), requestDate: parseDateOnly(invoiceDateStr),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
      invoiceDate: parseDateOnly(invoiceDateStr), dueDate: parseDateOnly(invoiceDateStr),
      total, subtotal: total, finalizedAt: parseDateOnly(finalizedAtStr),
      lines: {
        create: [{
          position: 1, kind: "OPERATION", processStepCodeId: gl.stepCodeId,
          glAccountId: gl.revId, glAccountName: "4010-REV", description: "Heat Treat", amount: total,
        }],
      },
    },
  });
  return { invoiceId: invoice.id, customerId: customer.id };
}

/** A finalized CREDIT memo with one revenue line — mirrors `makeFinalizedInvoiceDated`'s shape but
 *  `kind: "CREDIT"`, its own `creditNumber` (`Invoice.creditNumber` is plain @unique, sweep-exempt —
 *  CLAUDE.md), and its money sign flipped (`createCredit`'s own convention: a CREDIT's `total`/line
 *  `amount` are stored negative). `gl-export.ts` and `close-periods.ts` both `Math.abs()` the total
 *  before use, so the sign itself is cosmetic here — it is kept negative only to match production. */
async function makeFinalizedCreditDated(gl: Gl, dateStr: string, total: number): Promise<InvoiceRef> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `GLR${seq}`, name: `GL Credit ${seq}` } });
  const order = await prisma.order.create({
    data: {
      orderNumber: 790000 + seq, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly(dateStr), requestDate: parseDateOnly(dateStr),
    },
  });
  const credit = await prisma.invoice.create({
    data: {
      kind: "CREDIT", status: "FINALIZED", orderId: order.id, customerId: customer.id,
      creditNumber: 900000 + seq,
      invoiceDate: parseDateOnly(dateStr), total: -total, subtotal: -total, finalizedAt: parseDateOnly(dateStr),
      lines: {
        create: [{
          position: 1, kind: "OPERATION", processStepCodeId: gl.stepCodeId,
          glAccountId: gl.revId, glAccountName: "4010-REV", description: "Heat Treat", amount: -total,
        }],
      },
    },
  });
  return { invoiceId: credit.id, customerId: customer.id };
}

async function periodFor(year: number, month: number): Promise<{ id: string }> {
  return prisma.closePeriod.findFirstOrThrow({ where: { year, month }, select: { id: true } });
}

describe("gl-export delta", () => {
  it("first export posts a balanced batch; a re-run is an empty no-op", async () => {
    const gl = await seedGlDefaults();
    await makeFinalizedInvoiceDated(gl, "2026-07-05", 100);
    await asSystem(() => closePeriod(2026, 7));
    const period = await periodFor(2026, 7);

    const first = await asSystem(() => exportClose(period.id));
    const debit = first.postings.reduce((s, p) => s + p.debit, 0);
    const credit = first.postings.reduce((s, p) => s + p.credit, 0);
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100)); // balances
    expect(first.postings.length).toBeGreaterThan(0);
    expect(first.postings.every((p) => !p.isReversal)).toBe(true);

    const second = await asSystem(() => exportClose(period.id));
    expect(second.postings.length).toBe(0); // idempotent no-op
  });

  it("stores a non-empty posting-register PDF with a stable page marker (Task 7)", async () => {
    const gl = await seedGlDefaults();
    await makeFinalizedInvoiceDated(gl, "2026-07-05", 100);
    await asSystem(() => closePeriod(2026, 7));
    const period = await periodFor(2026, 7);

    const { batchId } = await asSystem(() => exportClose(period.id));
    const row = await prisma.glExportBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(row.register.byteLength).toBeGreaterThan(1000); // a real PDF, not the placeholder
    expect(row.registerContentType).toBe("application/pdf");
    // pdfmake output is not byte-deterministic across renders (CLAUDE.md) — pin an uncompressed
    // page-count marker in the raw bytes instead of comparing two fresh renders (bol.test.ts's rule).
    expect(Buffer.from(row.register).toString("latin1")).toContain("/Count 1");
  });

  it("posts the payment cash event balanced alongside the sale", async () => {
    const gl = await seedGlDefaults();
    const inv = await makeFinalizedInvoiceDated(gl, "2026-07-05", 100);
    await payInvoiceDated(gl, inv, "2026-07-20", 40);
    await asSystem(() => closePeriod(2026, 7));
    const period = await periodFor(2026, 7);

    const out = await asSystem(() => exportClose(period.id));
    const debit = out.postings.reduce((s, p) => s + p.debit, 0);
    const credit = out.postings.reduce((s, p) => s + p.credit, 0);
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100));
    // Two events: INVOICE (sale) + PAYMENT (cash) — both present.
    expect(out.postings.some((p) => p.sourceType === "INVOICE")).toBe(true);
    expect(out.postings.some((p) => p.sourceType === "PAYMENT")).toBe(true);
  });

  it("a reopen -> unlock -> re-close -> re-export emits a balanced reversing delta", async () => {
    const gl = await seedGlDefaults();
    const inv = await makeFinalizedInvoiceDated(gl, "2026-07-05", 100);
    await asSystem(() => closePeriod(2026, 7));
    const period = await periodFor(2026, 7);
    await asSystem(() => exportClose(period.id));

    await asSystem(() => reopenPeriod(period.id, "correcting"));
    await asSystem(() => unlockInvoice(inv.invoiceId, "wrong amount")); // -> DRAFT, out of scope
    await asSystem(() => closePeriod(2026, 7));

    const delta = await asSystem(() => exportClose(period.id));
    expect(delta.postings.length).toBeGreaterThan(0);
    expect(delta.postings.every((p) => p.isReversal)).toBe(true);
    const net = delta.postings.reduce((s, p) => s + (p.debit - p.credit), 0);
    expect(Math.round(net * 100)).toBe(0); // a balanced reversal

    // A further re-export with nothing changed is empty again (the reversal itself is now prior).
    const again = await asSystem(() => exportClose(period.id));
    expect(again.postings.length).toBe(0);
  });

  it("a reopen -> re-finalize WITHIN the month with a changed account emits reverse-then-repost, not a no-op", async () => {
    // The membership-only-delta defect: a reopen + edit + re-finalize that keeps the invoice IN the
    // recognition month keeps its id (event key) AND its finalizedAt in-scope, so the event is present
    // in BOTH the current journal and the prior net. Checking `.has(key)` alone would emit nothing and
    // leave QBO holding the stale entry. Modelled here by re-mapping the revenue to a DIFFERENT account
    // at the SAME total (so the close still reconciles) — the journal content changes, the key does not.
    const gl = await seedGlDefaults();
    const inv = await makeFinalizedInvoiceDated(gl, "2026-07-05", 100);
    await asSystem(() => closePeriod(2026, 7));
    const period = await periodFor(2026, 7);
    await asSystem(() => exportClose(period.id)); // batch 1: A/R 100 dr / 4010-REV 100 cr

    const rev2 = await prisma.glAccount.create({ data: { name: "4020-REV-2" } });
    await asSystem(() => reopenPeriod(period.id, "re-mapping the revenue account"));
    await prisma.invoiceLine.updateMany({
      where: { invoiceId: inv.invoiceId, kind: "OPERATION" },
      data: { glAccountId: rev2.id, glAccountName: "4020-REV-2" },
    });
    await asSystem(() => closePeriod(2026, 7)); // total unchanged -> reconciles

    const delta = await asSystem(() => exportClose(period.id));
    expect(delta.postings.length).toBeGreaterThan(0); // NOT the empty no-op the old membership check gave
    const byAccount = (id: string) => delta.postings.filter((p) => p.glAccountId === id);
    // Old revenue account (4010): its original credit is reversed -> now an isReversal DEBIT.
    expect(byAccount(gl.revId).some((p) => p.isReversal && p.debit > 0)).toBe(true);
    // New revenue account (4020): a fresh, non-reversal CREDIT.
    expect(byAccount(rev2.id).some((p) => !p.isReversal && p.credit > 0)).toBe(true);
    // A/R nets to zero across the delta (100 reversed + 100 re-posted) and the whole batch balances.
    const arNet = byAccount(gl.arId).reduce((s, p) => s + (p.debit - p.credit), 0);
    expect(Math.round(arNet * 100)).toBe(0);
    const net = delta.postings.reduce((s, p) => s + (p.debit - p.credit), 0);
    expect(Math.round(net * 100)).toBe(0);

    // A further re-export with nothing changed is empty again (the reverse+repost is now the prior net).
    const again = await asSystem(() => exportClose(period.id));
    expect(again.postings.length).toBe(0);
  });

  it("re-exporting an earlier month after a later one closed leaves the later month untouched", async () => {
    const gl = await seedGlDefaults();
    const julyInv = await makeFinalizedInvoiceDated(gl, "2026-07-05", 100);
    await asSystem(() => closePeriod(2026, 7));
    const july = await periodFor(2026, 7);
    await asSystem(() => exportClose(july.id));

    await makeFinalizedInvoiceDated(gl, "2026-08-05", 30);
    await asSystem(() => closePeriod(2026, 8));
    const august = await periodFor(2026, 8);
    const augOut = await asSystem(() => exportClose(august.id));
    const augPostingIds = augOut.postings.map((p) => p.sourceId).sort();

    // Correct July: reopen, unlock its invoice (-> DRAFT), re-close, re-export.
    await asSystem(() => reopenPeriod(july.id, "correcting July"));
    await asSystem(() => unlockInvoice(julyInv.invoiceId, "mis-keyed"));
    await asSystem(() => closePeriod(2026, 7));
    const julyDelta = await asSystem(() => exportClose(july.id));

    // Every July re-export posting is dated within July — the delta window is [Jul 1, Jul 31], never
    // August (the strictly-per-period bound, not a cumulative glDate<=E).
    expect(julyDelta.postings.length).toBeGreaterThan(0);
    const julyEnd = Date.UTC(2026, 6, 31);
    const julyRows = await prisma.glPosting.findMany({
      where: { batch: { exportNumber: julyDelta.exportNumber } }, select: { glDate: true },
    });
    expect(julyRows.every((r) => r.glDate.getTime() <= julyEnd)).toBe(true);

    // August's stored postings are byte-for-byte untouched — same source ids, none reversed.
    const augRowsNow = await prisma.glPosting.findMany({
      where: { batch: { exportNumber: augOut.exportNumber } },
      select: { sourceId: true, isReversal: true },
    });
    expect(augRowsNow.map((r) => r.sourceId).sort()).toEqual(augPostingIds);
    expect(augRowsNow.every((r) => !r.isReversal)).toBe(true);
    // And the August invoice's own posting was NOT reversed by the July re-export.
    const augReExport = await asSystem(() => exportClose(august.id));
    expect(augReExport.postings.length).toBe(0);
  });

  it("exporting a later month FIRST does not vacuum or double-post an earlier month's events", async () => {
    // The out-of-order cross-period defect: with a cumulative glDate<=E scope, exporting August first
    // would post July's events (dated <= Aug 31) under August's glDate; then July's own export would
    // see them absent from its prior (glDate<=Jul 31) and post them AGAIN. The strictly-per-period
    // window [monthStart, monthEnd] closes both halves.
    const gl = await seedGlDefaults();
    const julyInv = await makeFinalizedInvoiceDated(gl, "2026-07-05", 100);
    const augInv = await makeFinalizedInvoiceDated(gl, "2026-08-05", 30);
    await asSystem(() => closePeriod(2026, 7));
    await asSystem(() => closePeriod(2026, 8));
    const july = await periodFor(2026, 7);
    const august = await periodFor(2026, 8);

    // Export AUGUST first — its batch must contain ONLY August's event, never July's (the vacuum).
    const augOut = await asSystem(() => exportClose(august.id));
    expect(augOut.postings.some((p) => p.sourceId === augInv.invoiceId)).toBe(true);
    expect(augOut.postings.some((p) => p.sourceId === julyInv.invoiceId)).toBe(false);
    const augSourceIds = augOut.postings.map((p) => p.sourceId).sort();

    // Then export July — it posts July's event, none reversed.
    const julyOut = await asSystem(() => exportClose(july.id));
    const julyForJuly = julyOut.postings.filter((p) => p.sourceId === julyInv.invoiceId);
    expect(julyForJuly.length).toBeGreaterThan(0);
    expect(julyForJuly.every((p) => !p.isReversal)).toBe(true);

    // July's event lives in EXACTLY ONE persisted batch (July's) — never double-posted into August's.
    const julyPostingBatches = await prisma.glPosting.findMany({
      where: { sourceId: julyInv.invoiceId }, select: { batchId: true },
    });
    expect(new Set(julyPostingBatches.map((r) => r.batchId)).size).toBe(1);

    // August's stored batch is untouched — same source ids, none reversed.
    const augRowsNow = await prisma.glPosting.findMany({
      where: { batch: { exportNumber: augOut.exportNumber } },
      select: { sourceId: true, isReversal: true },
    });
    expect(augRowsNow.map((r) => r.sourceId).sort()).toEqual(augSourceIds);
    expect(augRowsNow.every((r) => !r.isReversal)).toBe(true);
  });

  it("scopes a finalized invoice by finalizedAt, not invoiceDate, across a month boundary (ruling 8)", async () => {
    // Fix round 2 coverage gap: every OTHER factory in this file sets finalizedAt == invoiceDate, so
    // the export's finalizedAt-scoping was never independently proven — a regression back to
    // invoiceDate scoping would slip through untested. This invoice is DATED the last day of July but
    // not FINALIZED until August 1st; it must post in August's export and be absent from July's. This
    // assertion pair FAILS if buildCurrentJournal/resolveReadiness scoped by invoiceDate instead.
    const gl = await seedGlDefaults();
    const inv = await makeFinalizedInvoiceWithDates(gl, "2026-07-31", "2026-08-01", 100);
    await asSystem(() => closePeriod(2026, 7));
    await asSystem(() => closePeriod(2026, 8));
    const july = await periodFor(2026, 7);
    const august = await periodFor(2026, 8);

    const julyOut = await asSystem(() => exportClose(july.id));
    expect(julyOut.postings.some((p) => p.sourceId === inv.invoiceId)).toBe(false);

    const augOut = await asSystem(() => exportClose(august.id));
    expect(augOut.postings.some((p) => p.sourceId === inv.invoiceId)).toBe(true);
  });
});

describe("gl-export summary file (ruling 9) and provenance (change D)", () => {
  /** A quote-aware-free splitter — the fixture account names/memos never carry a comma or quote (the
   *  e2e harness's own `parseCsvLine` verifies the same against `renderCsv`'s `esc()`). */
  function parseCsv(text: string): string[][] {
    const lines = text.split("\n").filter((l) => l.length > 0);
    return lines.slice(1).map((l) => l.split(","));
  }

  it("aggregates the exported CSV to one line per account per side — two invoices → one A/R line", async () => {
    const gl = await seedGlDefaults();
    await makeFinalizedInvoiceDated(gl, "2026-07-05", 100);
    await makeFinalizedInvoiceDated(gl, "2026-07-20", 50);
    await asSystem(() => closePeriod(2026, 7));
    const period = await periodFor(2026, 7);

    const out = await asSystem(() => exportClose(period.id));

    // The FILE (what the bookkeeper imports) is SUMMARIZED: exactly one A/R row and one revenue row,
    // NOT one row per invoice. Columns: Date,Account,Debit,Credit,Memo.
    const rows = parseCsv(out.file.toString("utf8"));
    const arRows = rows.filter((r) => r[1] === "1200-AR");
    const revRows = rows.filter((r) => r[1] === "4010-REV");
    expect(arRows.length).toBe(1); // both invoices' A/R collapsed into one line
    expect(revRows.length).toBe(1); // both invoices' revenue collapsed into one line
    expect(arRows[0][2]).toBe("150.00"); // summed debit
    expect(revRows[0][3]).toBe("150.00"); // summed credit
    // The summarized file still balances.
    const debit = rows.reduce((s, r) => s + (r[2] ? Math.round(Number(r[2]) * 100) : 0), 0);
    const credit = rows.reduce((s, r) => s + (r[3] ? Math.round(Number(r[3]) * 100) : 0), 0);
    expect(debit).toBe(credit);

    // The per-event GlPosting DETAIL stays UN-aggregated: 2 A/R + 2 revenue = 4 postings.
    expect(await prisma.glPosting.count({ where: { batchId: out.batchId } })).toBe(4);
  });

  it("aggregates an invoice and a same-month credit onto ONE A/R summary line carrying BOTH a debit and a credit column (current sum-without-netting behavior — pinned, not endorsed; netting is an open owner/bookkeeper decision)", async () => {
    const gl = await seedGlDefaults();
    await makeFinalizedInvoiceDated(gl, "2026-07-05", 100);
    await makeFinalizedCreditDated(gl, "2026-07-20", 40);
    await asSystem(() => closePeriod(2026, 7));
    const period = await periodFor(2026, 7);

    const out = await asSystem(() => exportClose(period.id));
    const rows = parseCsv(out.file.toString("utf8"));
    const arRows = rows.filter((r) => r[1] === "1200-AR");
    const revRows = rows.filter((r) => r[1] === "4010-REV");

    // Still ONE line per account per side (the invoice's A/R debit and the credit's A/R credit
    // collapse onto the SAME "1200-AR" row) — but that one row now carries a NONZERO figure in BOTH
    // the debit and credit columns, the gross amounts, not a single net column.
    expect(arRows.length).toBe(1);
    expect(arRows[0][2]).toBe("100.00"); // gross debit, from the INVOICE
    expect(arRows[0][3]).toBe("40.00");  // gross credit, from the CREDIT memo
    expect(revRows.length).toBe(1);
    expect(revRows[0][2]).toBe("40.00");  // the credit memo debits revenue (reversed sales entry)
    expect(revRows[0][3]).toBe("100.00"); // the invoice credits revenue

    // The batch still balances overall even though neither summary line nets to a single column.
    const debit = rows.reduce((s, r) => s + (r[2] ? Math.round(Number(r[2]) * 100) : 0), 0);
    const credit = rows.reduce((s, r) => s + (r[3] ? Math.round(Number(r[3]) * 100) : 0), 0);
    expect(debit).toBe(credit);
  });

  it("stamps GlExportBatch.emittedById with the acting user (change D)", async () => {
    seq += 1;
    const gl = await seedGlDefaults();
    await makeFinalizedInvoiceDated(gl, "2026-07-05", 100);
    await asSystem(() => closePeriod(2026, 7));
    const period = await periodFor(2026, 7);

    const user = await prisma.user.create({
      data: { username: `gl-emit-${seq}`, passwordHash: "x", displayName: "Emitter" },
    });
    const out = await runWithContext(
      { actor: { id: user.id, name: "Emitter" }, user: null },
      () => exportClose(period.id),
    );
    const batch = await prisma.glExportBatch.findUniqueOrThrow({ where: { id: out.batchId } });
    expect(batch.emittedById).toBe(user.id);
  });
});

describe("gl-export readiness", () => {
  it("refuses export when a taxable invoice is in scope but no sales-tax account is set", async () => {
    const gl = await seedGlDefaults();
    // Clear the sales-tax account; keep A/R set so the ONLY gap is the tax account.
    await prisma.billingConfig.update({
      where: { id: "singleton" }, data: { salesTaxGlAccountId: null },
    });
    await makeFinalizedInvoiceDated(gl, "2026-07-05", 108, { taxTotal: 8 });
    await asSystem(() => closePeriod(2026, 7));
    const period = await periodFor(2026, 7);

    const periodEnd = new Date(Date.UTC(2026, 7, 0));
    const gaps = await readinessForExport(periodEnd);
    expect(gaps.some((g) => /sales tax/i.test(g.label))).toBe(true);

    await expect(asSystem(() => exportClose(period.id))).rejects.toThrow(/gap|readiness|export/i);
  });

  it("refuses export when the A/R control account is not set", async () => {
    const gl = await seedGlDefaults();
    await prisma.billingConfig.update({ where: { id: "singleton" }, data: { arGlAccountId: null } });
    await makeFinalizedInvoiceDated(gl, "2026-07-05", 100);
    await asSystem(() => closePeriod(2026, 7));
    const period = await periodFor(2026, 7);

    const gaps = await readinessForExport(new Date(Date.UTC(2026, 7, 0)));
    expect(gaps.some((g) => /A\/R/i.test(g.label))).toBe(true);
    await expect(asSystem(() => exportClose(period.id))).rejects.toThrow();
  });

  it("is clean (no gaps) when every account an in-scope event resolves to is set", async () => {
    const gl = await seedGlDefaults();
    const inv = await makeFinalizedInvoiceDated(gl, "2026-07-05", 100);
    await payInvoiceDated(gl, inv, "2026-07-20", 40);
    await asSystem(() => closePeriod(2026, 7));
    const gaps = await readinessForExport(new Date(Date.UTC(2026, 7, 0)));
    expect(gaps).toEqual([]);
  });

  it("refuses export when an in-scope CHARGE line has no GL account (its credit would be dropped)", async () => {
    // seedGlDefaults leaves otherChargeGlAccountId null, so a $50 CHARGE with a null-GL snapshot is a
    // dropped credit while A/R is still debited the full $50 -> readiness MUST refuse (the Critical).
    await seedGlDefaults();
    await makeFinalizedKindLine("2026-07-06", "CHARGE", 50, null);
    await asSystem(() => closePeriod(2026, 7));
    const period = await periodFor(2026, 7);

    const gaps = await readinessForExport(new Date(Date.UTC(2026, 7, 0)));
    expect(gaps.some((g) => /charge/i.test(g.label))).toBe(true);
    await expect(asSystem(() => exportClose(period.id))).rejects.toThrow(/gap|readiness|export/i);
  });

  it("refuses export when an in-scope FREIGHT line has no GL account", async () => {
    await seedGlDefaults();
    await makeFinalizedKindLine("2026-07-06", "FREIGHT", 25, null);
    await asSystem(() => closePeriod(2026, 7));
    const period = await periodFor(2026, 7);

    const gaps = await readinessForExport(new Date(Date.UTC(2026, 7, 0)));
    expect(gaps.some((g) => /freight/i.test(g.label))).toBe(true);
    await expect(asSystem(() => exportClose(period.id))).rejects.toThrow();
  });

  it("posts a BALANCED batch once the freight and other-charge accounts are configured", async () => {
    await seedGlDefaults();
    const freightAcct = await prisma.glAccount.create({ data: { name: "5000-FRT" } });
    const chargeAcct = await prisma.glAccount.create({ data: { name: "5100-CHG" } });
    await prisma.billingConfig.update({
      where: { id: "singleton" },
      data: { freightGlAccountId: freightAcct.id, otherChargeGlAccountId: chargeAcct.id },
    });
    await makeFinalizedKindLine("2026-07-06", "CHARGE", 50, chargeAcct.id);
    await makeFinalizedKindLine("2026-07-07", "FREIGHT", 25, freightAcct.id);
    await asSystem(() => closePeriod(2026, 7));
    const period = await periodFor(2026, 7);

    expect(await readinessForExport(new Date(Date.UTC(2026, 7, 0)))).toEqual([]);
    const out = await asSystem(() => exportClose(period.id));
    expect(out.postings.length).toBeGreaterThan(0);
    const debit = out.postings.reduce((s, p) => s + p.debit, 0);
    const credit = out.postings.reduce((s, p) => s + p.credit, 0);
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100)); // the backstop's invariant holds
  });
});
