import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { withDbErrors } from "./db-errors";
import { HttpError } from "./errors";
import { auditedCreate } from "./audit";
import { allocateNumber } from "./settings";
import { getBillingConfig } from "./billing-config";
import {
  salesJournal, cashJournal, reverseLines, readinessGaps,
  type JournalLine, type ReadinessGap, type ReadinessInput,
} from "./gl-mapping";
import { formatDateOnly } from "../lib/business-days";
import { GL_EXPORT_COLUMNS, type PostingSourceType } from "../lib/gl-constants";

// -------------------------------------------------------------------------------------------
// Task 6 (P5C §4.3): the per-event GL-export DELTA engine. A close's export is not a full dump
// of the period — it is the DIFFERENCE between the events that should be posted for the period
// end `E` and what has already been posted (`GlPosting`, glDate <= E). Each event maps to a
// self-balancing set of journal lines keyed on the 2-part `${sourceType}:${sourceId}` (an
// invoice/credit id, a payment id, an application id — never a position or display field, so a
// correction reverses ONE event without disturbing another). Both the live side and the prior
// side are bounded by glDate <= E, so re-exporting an earlier month after a later one has closed
// never disturbs the later month's postings.
//
//   NEW      = a live in-scope event with no live prior posting   -> post   (isReversal:false)
//   REVERSED = a net-posted event no longer live-in-scope         -> reverse (isReversal:true)
//   UNCHANGED (live AND already posted) -> nothing, which is what makes a re-run an empty no-op.
//
// A finalized invoice / posted payment / live application is IMMUTABLE while it stays in scope
// (an amount change requires unlock/void, which drops it OUT of scope and back in as a reversal +
// a fresh post), so an event that is in BOTH maps genuinely needs no change — the delta is exact.
//
// The batch and its postings are written under a Serializable `$transaction`, wrapped in
// `withDbErrors`, through `auditedCreate` (the 5A/5B print-bracket shape). Money is integer cents.
// The register PDF is a placeholder here (`new Uint8Array()`) — Task 7 renders the real
// posting-register and replaces it; this task only stores the CSV file.
// -------------------------------------------------------------------------------------------

const cents = (n: number): number => Math.round(n * 100);

export type ExportedPosting = {
  sourceType: string; sourceId: string; glAccountId: string | null;
  debit: number; credit: number; side: string; isReversal: boolean;
};

export type ExportedBatch = {
  batchId: string;
  exportNumber: number;
  periodEnd: string;
  postings: ExportedPosting[];
  file: Buffer;
};

type Tx = Prisma.TransactionClient;

/**
 * Emit the delta batch for a CLOSED period (§4.3). Refuses a reopened period (it must be re-closed
 * first) and refuses on any readiness gap (§7). Allocates the export number under the tx, writes the
 * `GlExportBatch` + one `GlPosting` per emitted line through `auditedCreate`, and renders the CSV.
 */
export async function exportClose(closePeriodId: string): Promise<ExportedBatch> {
  return withDbErrors({ entity: "GL export" }, () => prisma.$transaction(async (tx) => {
    const period = await tx.closePeriod.findFirst({ where: { id: closePeriodId } });
    if (!period) throw new HttpError(404, "Close period not found");
    if (period.status !== "CLOSED") {
      throw new HttpError(409, "Reopened periods must be re-closed before export");
    }
    // period.month is 1-based; Date.UTC(year, month, 0) is day 0 of the NEXT month = this month's
    // last day (the same reading close-periods.ts monthBounds and every A/R @db.Date round-trip use).
    const periodEnd = new Date(Date.UTC(period.year, period.month, 0));

    const gaps = await resolveReadiness(tx, periodEnd);
    if (gaps.length > 0) {
      throw new HttpError(409,
        `Cannot export — ${gaps.length} GL account gap(s) must be resolved first (see the readiness list)`);
    }

    // Both maps keyed on the IDENTICAL 2-part `${sourceType}:${sourceId}`. `buildPriorNet` drops
    // net-zero groups (already-reversed events), so `.has(key)` == "has a live prior posting".
    const currentByKey = await buildCurrentJournal(tx, periodEnd);
    const priorByKey = await buildPriorNet(tx, periodEnd);

    const lines: JournalLine[] = [];
    for (const [key, cur] of currentByKey) {
      if (!priorByKey.has(key)) lines.push(...cur); // new event -> post
    }
    for (const [key, prior] of priorByKey) {
      if (!currentByKey.has(key)) lines.push(...reverseLines(prior)); // net-posted, no longer live -> reverse
    }

    const exportNumber = await allocateNumber("gl_export_batch_number_next", tx);
    const fileName = `gl-${period.year}-${String(period.month).padStart(2, "0")}.csv`;
    const file = renderCsv(lines, formatDateOnly(periodEnd));
    const register = new Uint8Array(); // Task 7 replaces this with the rendered posting-register PDF

    const batch = await auditedCreate(
      "glExportBatch",
      { exportNumber, closePeriodId, periodEnd, fileName, postingCount: lines.length },
      () => tx.glExportBatch.create({
        data: {
          exportNumber, closePeriodId, periodEnd, fileName,
          file: new Uint8Array(file), register,
          postings: {
            create: lines.map((l) => ({
              sourceType: l.sourceType, sourceId: l.sourceId, glDate: periodEnd,
              // Empty glAccountId only ever arises from a hard-deleted account (SetNull); real
              // events always carry a live id. Store null, never "", so the FK holds.
              glAccountId: l.glAccountId === "" ? null : l.glAccountId,
              glAccountName: l.glAccountName, memo: l.memo,
              debit: l.debit, credit: l.credit, side: l.side, isReversal: l.isReversal,
            })),
          },
        },
        select: {
          id: true, exportNumber: true,
          postings: {
            select: {
              sourceType: true, sourceId: true, glAccountId: true,
              debit: true, credit: true, side: true, isReversal: true,
            },
          },
        },
      }),
      { tx },
    );

    return {
      batchId: batch.id,
      exportNumber,
      periodEnd: formatDateOnly(periodEnd),
      postings: batch.postings.map((p) => ({
        sourceType: p.sourceType, sourceId: p.sourceId, glAccountId: p.glAccountId,
        debit: p.debit.toNumber(), credit: p.credit.toNumber(), side: p.side, isReversal: p.isReversal,
      })),
      file,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** The 2-part event key — an invoice/credit/payment/application id under its source type. */
function keyOf(sourceType: PostingSourceType | string, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

/** Keep only the non-zero lines of an event's balanced set (a $0 invoice has only a $0 A/R line;
 *  dropping it keeps the delta clean and the re-run a true no-op). */
function nonZero(lines: JournalLine[]): JournalLine[] {
  return lines.filter((l) => cents(l.debit) !== 0 || cents(l.credit) !== 0);
}

/**
 * The CURRENT in-scope journal, keyed by event (§4.3): finalized invoices/credits (invoiceDate <= E)
 * → `salesJournal`; posted non-void payments (receivedDate <= E) → one PAYMENT `cashJournal`; live
 * DISCOUNT/WRITE_OFF applications (appliedDate <= E) → one `cashJournal` each. Revenue comes from the
 * invoice's own line snapshots grouped by `glAccountId` (TAX lines excluded — the tax line's account
 * is the plant default, matching the readiness gate); A/R, tax, discount, write-off and cash accounts
 * come from the plant config / payment type. Amounts are magnitudes — the INVOICE/CREDIT `kind` and
 * the mapper's `reverse` flag decide the debit/credit direction, never the stored money sign.
 */
async function buildCurrentJournal(tx: Tx, periodEnd: Date): Promise<Map<string, JournalLine[]>> {
  const config = await getBillingConfig(tx);
  const out = new Map<string, JournalLine[]>();

  // Names for the config-provided accounts (readiness guarantees the referenced ones are set).
  const configIds = [config.arGlAccountId, config.salesTaxGlAccountId, config.discountGlAccountId, config.writeOffGlAccountId]
    .filter((id): id is string => id !== null);
  const accts = configIds.length
    ? await tx.glAccount.findMany({ where: { id: { in: configIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(accts.map((a) => [a.id, a.name]));
  const arName = config.arGlAccountId ? (nameById.get(config.arGlAccountId) ?? "") : "";

  // Sales side — invoices and credits.
  const invoices = await tx.invoice.findMany({
    where: { status: "FINALIZED", deletedAt: null, invoiceDate: { lte: periodEnd } },
    select: {
      id: true, kind: true, total: true, taxTotal: true,
      lines: { select: { kind: true, glAccountId: true, glAccountName: true, amount: true } },
    },
  });
  for (const inv of invoices) {
    // Group the non-TAX lines by their snapshot glAccountId; sum magnitudes.
    const byAccount = new Map<string, { glAccountName: string; amount: number }>();
    for (const l of inv.lines) {
      if (l.kind === "TAX" || l.glAccountId === null) continue;
      const prev = byAccount.get(l.glAccountId);
      const amt = Math.abs(l.amount.toNumber());
      if (prev) prev.amount += amt;
      else byAccount.set(l.glAccountId, { glAccountName: l.glAccountName, amount: amt });
    }
    const lines = salesJournal({
      kind: inv.kind,
      invoiceId: inv.id,
      total: Math.abs(inv.total.toNumber()),
      arGlAccountId: config.arGlAccountId ?? "",
      arGlAccountName: arName,
      taxTotal: Math.abs(inv.taxTotal.toNumber()),
      taxGlAccountId: config.salesTaxGlAccountId,
      taxGlAccountName: config.salesTaxGlAccountId ? (nameById.get(config.salesTaxGlAccountId) ?? "") : "",
      revenue: [...byAccount.entries()].map(([glAccountId, v]) => ({
        glAccountId, glAccountName: v.glAccountName, amount: v.amount,
      })),
    });
    const nz = nonZero(lines);
    if (nz.length) out.set(keyOf(inv.kind, inv.id), nz);
  }

  // Cash side — one PAYMENT event per posted, non-void payment.
  const payments = await tx.payment.findMany({
    where: {
      deletedAt: null, receivedDate: { lte: periodEnd },
      batch: { status: "POSTED", deletedAt: null },
    },
    select: {
      id: true, amount: true,
      paymentType: { select: { glAccountId: true, glAccount: { select: { name: true } } } },
    },
  });
  for (const p of payments) {
    const lines = cashJournal({
      kind: "PAYMENT",
      sourceId: p.id,
      amount: Math.abs(p.amount.toNumber()),
      debitGlAccountId: p.paymentType.glAccountId ?? "",
      debitGlAccountName: p.paymentType.glAccount?.name ?? "",
      arGlAccountId: config.arGlAccountId ?? "",
      arGlAccountName: arName,
    });
    const nz = nonZero(lines);
    if (nz.length) out.set(keyOf("PAYMENT", p.id), nz);
  }

  // Cash side — one event per live DISCOUNT / WRITE_OFF application.
  const apps = await tx.application.findMany({
    where: { deletedAt: null, appliedDate: { lte: periodEnd }, type: { in: ["DISCOUNT", "WRITE_OFF"] } },
    select: { id: true, amount: true, type: true },
  });
  for (const a of apps) {
    const isDiscount = a.type === "DISCOUNT";
    const debitGlAccountId = (isDiscount ? config.discountGlAccountId : config.writeOffGlAccountId) ?? "";
    const lines = cashJournal({
      kind: isDiscount ? "DISCOUNT" : "WRITE_OFF",
      sourceId: a.id,
      amount: Math.abs(a.amount.toNumber()),
      debitGlAccountId,
      debitGlAccountName: debitGlAccountId ? (nameById.get(debitGlAccountId) ?? "") : "",
      arGlAccountId: config.arGlAccountId ?? "",
      arGlAccountName: arName,
    });
    const nz = nonZero(lines);
    if (nz.length) out.set(keyOf(a.type, a.id), nz);
  }

  return out;
}

/**
 * The NET prior postings (§4.3): every `GlPosting` with glDate <= E, grouped by the SAME 2-part
 * `${sourceType}:${sourceId}`, then netted within a group by `(glAccountId, side, memo)` so an
 * original post and its later reversal cancel. A group whose lines ALL net to zero is dropped (it was
 * fully reversed), so a key's PRESENCE means "has a live prior posting" — the exact complement the
 * delta needs. The reconstructed `JournalLine[]` carries the row's `memo` and `glAccountName` so a
 * reversal reproduces the original line verbatim.
 */
async function buildPriorNet(tx: Tx, periodEnd: Date): Promise<Map<string, JournalLine[]>> {
  const rows = await tx.glPosting.findMany({
    where: { glDate: { lte: periodEnd } },
    select: {
      sourceType: true, sourceId: true, glAccountId: true, glAccountName: true,
      debit: true, credit: true, side: true, memo: true,
    },
  });

  type Agg = { glAccountId: string; glAccountName: string; side: string; memo: string; netCents: number };
  const groups = new Map<string, Map<string, Agg>>();
  for (const r of rows) {
    const gkey = keyOf(r.sourceType, r.sourceId);
    let sub = groups.get(gkey);
    if (!sub) { sub = new Map(); groups.set(gkey, sub); }
    const glId = r.glAccountId ?? "";
    const lkey = `${glId}|${r.side}|${r.memo}`;
    const agg = sub.get(lkey) ?? { glAccountId: glId, glAccountName: r.glAccountName, side: r.side, memo: r.memo, netCents: 0 };
    agg.netCents += cents(r.debit.toNumber()) - cents(r.credit.toNumber());
    sub.set(lkey, agg);
  }

  const out = new Map<string, JournalLine[]>();
  for (const [gkey, sub] of groups) {
    const [sourceType, sourceId] = splitKey(gkey);
    const lines: JournalLine[] = [];
    for (const agg of sub.values()) {
      if (agg.netCents === 0) continue; // this line was reversed out
      lines.push({
        side: agg.side as JournalLine["side"],
        glAccountId: agg.glAccountId,
        glAccountName: agg.glAccountName,
        debit: agg.netCents > 0 ? agg.netCents / 100 : 0,
        credit: agg.netCents < 0 ? -agg.netCents / 100 : 0,
        memo: agg.memo,
        sourceType: sourceType as JournalLine["sourceType"],
        sourceId,
        isReversal: false,
      });
    }
    if (lines.length) out.set(gkey, lines); // a fully-reversed group drops out
  }
  return out;
}

/** Split a `${sourceType}:${sourceId}` key. `sourceType` never contains a colon (it is one of the
 *  fixed enum values); the id is a cuid. Split on the FIRST colon so a colon in an id can't confuse it. */
function splitKey(k: string): [string, string] {
  const i = k.indexOf(":");
  return [k.slice(0, i), k.slice(i + 1)];
}

/**
 * Assemble the `ReadinessInput` and name every account gap (§7). `arGlAccountId`/discount/write-off/
 * sales-tax come from the plant config. `hasTax` is true iff any in-scope finalized invoice has
 * `taxTotal != 0` (its A/R debit already includes the tax, so a missing tax account would unbalance
 * the journal). `hasDiscount`/`hasWriteOff` reflect whether any such application is in scope. The
 * step-code / surcharge / payment-type lists are the account-less ones each in-scope event actually
 * resolves to — read off the SAME snapshots the export posts from (an in-scope invoice line whose
 * snapshot `glAccountId` is null, a payment whose type has no GL account).
 */
async function resolveReadiness(tx: Tx, periodEnd: Date): Promise<ReadinessGap[]> {
  const config = await getBillingConfig(tx);

  const invoices = await tx.invoice.findMany({
    where: { status: "FINALIZED", deletedAt: null, invoiceDate: { lte: periodEnd } },
    select: { taxTotal: true },
  });
  const hasTax = invoices.some((i) => cents(i.taxTotal.toNumber()) !== 0);

  const [discountCount, writeOffCount] = await Promise.all([
    tx.application.count({ where: { deletedAt: null, type: "DISCOUNT", appliedDate: { lte: periodEnd } } }),
    tx.application.count({ where: { deletedAt: null, type: "WRITE_OFF", appliedDate: { lte: periodEnd } } }),
  ]);

  // Account-less revenue lines on in-scope invoices, attributed to their step code / surcharge for
  // the fix link. A zero-amount line posts nothing (salesJournal skips it), so it is not a real gap.
  const badLines = await tx.invoiceLine.findMany({
    where: {
      glAccountId: null,
      invoice: { status: "FINALIZED", deletedAt: null, invoiceDate: { lte: periodEnd } },
      OR: [{ processStepCodeId: { not: null } }, { surchargeId: { not: null } }],
    },
    select: {
      amount: true,
      processStepCodeId: true, processStepCode: { select: { code: true } },
      surchargeId: true, surcharge: { select: { name: true } },
    },
  });
  const stepCodesMissingGl = new Map<string, { id: string; code: string }>();
  const surchargesMissingGl = new Map<string, { id: string; name: string }>();
  for (const l of badLines) {
    if (cents(l.amount.toNumber()) === 0) continue;
    if (l.processStepCodeId) {
      stepCodesMissingGl.set(l.processStepCodeId, { id: l.processStepCodeId, code: l.processStepCode?.code ?? "" });
    } else if (l.surchargeId) {
      surchargesMissingGl.set(l.surchargeId, { id: l.surchargeId, name: l.surcharge?.name ?? "" });
    }
  }

  // Payment types with no GL account among in-scope posted, non-void payments.
  const payments = await tx.payment.findMany({
    where: {
      deletedAt: null, receivedDate: { lte: periodEnd },
      batch: { status: "POSTED", deletedAt: null },
    },
    select: { paymentType: { select: { id: true, name: true, glAccountId: true } } },
  });
  const paymentTypesMissingGl = new Map<string, { id: string; name: string }>();
  for (const p of payments) {
    if (p.paymentType.glAccountId === null) {
      paymentTypesMissingGl.set(p.paymentType.id, { id: p.paymentType.id, name: p.paymentType.name });
    }
  }

  const input: ReadinessInput = {
    arGlAccountId: config.arGlAccountId,
    discountGlAccountId: config.discountGlAccountId,
    writeOffGlAccountId: config.writeOffGlAccountId,
    salesTaxGlAccountId: config.salesTaxGlAccountId,
    hasDiscount: discountCount > 0,
    hasWriteOff: writeOffCount > 0,
    hasTax,
    stepCodesMissingGl: [...stepCodesMissingGl.values()],
    surchargesMissingGl: [...surchargesMissingGl.values()],
    paymentTypesMissingGl: [...paymentTypesMissingGl.values()],
  };
  return readinessGaps(input);
}

/** The readiness gap list the UI's export panel and disabled-count read — the SAME period end
 *  `exportClose` refuses on, so the panel and the refusal can never disagree (§7). */
export async function readinessForExport(periodEnd: Date): Promise<ReadinessGap[]> {
  return withDbErrors({ entity: "GL export readiness" }, () => prisma.$transaction(
    (tx) => resolveReadiness(tx, periodEnd),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

/** One CSV row per emitted line: date, account, debit, credit, memo. */
function renderCsv(lines: JournalLine[], dateStr: string): Buffer {
  const esc = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const money = (n: number): string => (cents(n) === 0 ? "" : n.toFixed(2));
  const rows = [GL_EXPORT_COLUMNS.join(",")];
  for (const l of lines) {
    rows.push([dateStr, esc(l.glAccountName), money(l.debit), money(l.credit), esc(l.memo)].join(","));
  }
  return Buffer.from(rows.join("\n") + "\n", "utf8");
}

/** The stored CSV bytes for the file route. 404 if the batch is gone. */
export async function getExportBatchFile(batchId: string): Promise<{ bytes: Buffer; fileName: string; contentType: string }> {
  const batch = await prisma.glExportBatch.findFirst({
    where: { id: batchId }, select: { file: true, fileName: true, fileContentType: true },
  });
  if (!batch) throw new HttpError(404, "Export batch not found");
  return { bytes: Buffer.from(batch.file), fileName: batch.fileName, contentType: batch.fileContentType };
}

/** The stored register bytes for the register route (Task 7 fills the register in). 404 if gone. */
export async function getExportBatchRegister(batchId: string): Promise<{ bytes: Buffer; contentType: string }> {
  const batch = await prisma.glExportBatch.findFirst({
    where: { id: batchId }, select: { register: true, registerContentType: true },
  });
  if (!batch) throw new HttpError(404, "Export batch not found");
  return { bytes: Buffer.from(batch.register), contentType: batch.registerContentType };
}
