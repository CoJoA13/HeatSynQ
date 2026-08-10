import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { withDbErrors } from "./db-errors";
import { HttpError } from "./errors";
import { auditedCreate } from "./audit";
import { allocateNumber } from "./settings";
import { currentActor } from "./context";
import { getBillingConfig } from "./billing-config";
import {
  salesJournal, cashJournal, reverseLines, readinessGaps,
  type JournalLine, type ReadinessGap, type ReadinessInput,
} from "./gl-mapping";
import { formatDateOnly } from "../lib/business-days";
import { GL_EXPORT_COLUMNS, type PostingSourceType } from "../lib/gl-constants";
import { renderPdf } from "./pdf/render";
import { buildPostingRegister, type PostingRegisterData } from "./pdf/posting-register";

// -------------------------------------------------------------------------------------------
// Task 6 (P5C §4.3): the per-event GL-export DELTA engine. A close's export is not a full dump
// of the period — it is the DIFFERENCE between the events that should be posted for the period
// end `E` and what has already been posted (`GlPosting`, glDate <= E). Each event maps to a
// self-balancing set of journal lines keyed on the 2-part `${sourceType}:${sourceId}` (an
// invoice/credit id, a payment id, an application id — never a position or display field, so a
// correction reverses ONE event without disturbing another). Both the live side (event dates) and
// the prior side (glDate) are bounded STRICTLY to the period's OWN month `[monthStart, monthEnd]` —
// NOT cumulatively `<= E`. The period lock guarantees a closed month's events can't change, so a
// month-bounded delta is exact; and it is the ONLY bound that survives exporting months out of
// order — a cumulative `<= E` would let a later month's export vacuum an earlier month's events
// under the later glDate, after which the earlier month's export re-posts them (double-booked).
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
// The posting-register PDF (Task 7, `pdf/posting-register.ts`) is rendered from the SAME emitted
// `lines` the CSV and the postings come from, and stored alongside the CSV on the same batch row —
// `renderPdf` is async and does no DB I/O, so building it before `tx.glExportBatch.create` stays
// safely inside the Serializable transaction.
// -------------------------------------------------------------------------------------------

const cents = (n: number): number => Math.round(n * 100);

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "July 2026" — the posting register's own header label; `period.month` is 1-based. */
function periodLabelOf(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

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

/** The delta window: the period's OWN month, `[monthStart, monthEnd]` inclusive for the @db.Date
 *  payment/application/glDate scopes; `nextStart` is the EXCLUSIVE upper bound `[monthStart, nextStart)`
 *  the finalized-invoice scope needs (owner ruling 8 — invoices count by `finalizedAt`, a `DateTime`
 *  with a time-of-day, so a same-day timestamp is only in-month under a half-open interval). Both the
 *  live event dates and the prior glDate are bounded to this month — never cumulatively `<= E` — so an
 *  out-of-order export can neither vacuum an earlier month's events nor double-post them (see header). */
type MonthBounds = { monthStart: Date; monthEnd: Date; nextStart: Date };

/** month is 1-based: `Date.UTC(year, month-1, 1)` is the 1st, `Date.UTC(year, month, 0)` the last day,
 *  `Date.UTC(year, month, 1)` the 1st of the NEXT month. */
function monthBoundsOf(year: number, month: number): MonthBounds {
  return {
    monthStart: new Date(Date.UTC(year, month - 1, 1)),
    monthEnd: new Date(Date.UTC(year, month, 0)),
    nextStart: new Date(Date.UTC(year, month, 1)),
  };
}

/** `periodEnd` is the last day of its month at UTC midnight (a @db.Date round-trip); the readiness
 *  routes hand it in directly, so recover the 1st of the SAME month (and the 1st of the next) for the
 *  delta window. */
function monthBoundsFromEnd(periodEnd: Date): MonthBounds {
  return {
    monthStart: new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), 1)),
    monthEnd: periodEnd,
    nextStart: new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() + 1, 1)),
  };
}

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
    // last day, and Date.UTC(year, month-1, 1) is the 1st — the same reading close-periods.ts
    // monthBounds and every A/R @db.Date round-trip use. The delta scopes to this window, not `<= E`.
    const bounds = monthBoundsOf(period.year, period.month);
    const periodEnd = bounds.monthEnd;

    const gaps = await resolveReadiness(tx, bounds);
    if (gaps.length > 0) {
      throw new HttpError(409,
        `Cannot export — ${gaps.length} GL account gap(s) must be resolved first (see the readiness list)`);
    }

    // Both maps keyed on the IDENTICAL 2-part `${sourceType}:${sourceId}`. `buildPriorNet` drops
    // net-zero groups (already-reversed events), so `.has(key)` == "has a live prior posting".
    const currentByKey = await buildCurrentJournal(tx, bounds);
    const priorByKey = await buildPriorNet(tx, bounds);

    const lines: JournalLine[] = [];
    for (const [key, cur] of currentByKey) {
      if (!priorByKey.has(key)) lines.push(...cur); // new event -> post
    }
    for (const [key, prior] of priorByKey) {
      if (!currentByKey.has(key)) lines.push(...reverseLines(prior)); // net-posted, no longer live -> reverse
    }

    // Balance backstop (§7): a batch that does not net to zero must NEVER persist, even if a readiness
    // case is ever missed. Sum debit and credit over the emitted lines in integer cents and refuse on
    // any difference — every event's line set is self-balancing, so the whole batch must be too.
    const debitCents = lines.reduce((s, l) => s + cents(l.debit), 0);
    const creditCents = lines.reduce((s, l) => s + cents(l.credit), 0);
    if (debitCents !== creditCents) {
      throw new HttpError(500,
        `GL export batch is unbalanced (debit ${debitCents} != credit ${creditCents} cents) — refusing to persist`);
    }

    const exportNumber = await allocateNumber("gl_export_batch_number_next", tx);
    const fileName = `gl-${period.year}-${String(period.month).padStart(2, "0")}.csv`;
    const periodEndStr = formatDateOnly(periodEnd);
    // SUMMARY journal (ruling 9): the exported FILE and the register are one line per (account, side),
    // the per-event `lines` collapsed and summed. The per-event `GlPosting` rows below stay UN-summarized
    // (the ERP-side detail + delta driver). Aggregation preserves Σdebit=Σcredit, so the backstop above
    // still guarantees the summary balances.
    const summaryLines = aggregateLines(lines);
    const file = renderCsv(summaryLines, periodEndStr);
    // The posting register renders from the SAME aggregated summary the CSV does (§4.3/§4.4) — two
    // sub-registers, SALES then CASH, in the first-occurrence order aggregation preserves.
    // `renderPdf` is async and does no DB I/O, so building the buffer before `glExportBatch.create`
    // stays safely inside the Serializable tx (task brief, `pdf/render.ts`'s own contract).
    const registerData: PostingRegisterData = {
      periodLabel: periodLabelOf(period.year, period.month),
      periodEnd: periodEndStr,
      exportNumber,
      lines: summaryLines.map((l) => ({ side: l.side, glAccountName: l.glAccountName, debit: l.debit, credit: l.credit, memo: l.memo })),
    };
    const register = new Uint8Array(await renderPdf(buildPostingRegister(registerData)));

    const batch = await auditedCreate(
      "glExportBatch",
      { exportNumber, closePeriodId, periodEnd, fileName, postingCount: lines.length },
      () => tx.glExportBatch.create({
        data: {
          exportNumber, closePeriodId, periodEnd, fileName,
          emittedById: currentActor().id, // mirror closePeriod's closedById (append-only provenance)
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
      periodEnd: periodEndStr,
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
 * SUMMARY aggregation (owner ruling 9): collapse the per-event journal `lines` into ONE line per
 * `(account, side)`, summing debit and credit in integer cents, for the EXPORTED FILE and the
 * posting register — so 30 invoices become one A/R line + one revenue line per account, not 60 rows.
 * The per-event `GlPosting` rows stay UN-aggregated (the ERP-side detail + the delta driver, §4.3);
 * only what the bookkeeper imports is summarized. Balance is preserved: this only re-groups the same
 * debits/credits, so Σdebit and Σcredit are unchanged. First-occurrence order is kept (Map insertion
 * order), so the SALES lines still precede the CASH lines the register's side filter relies on. The
 * account key is the live `glAccountId` when present, else the frozen `glAccountName` (a SetNull
 * reversal of a hard-deleted account). The representative `memo` (and the unused
 * `sourceType`/`sourceId`/`isReversal`) are the group's first line's — the file and register render
 * none of the latter three, and within one `(account, side)` the memo is uniform in practice
 * ("A/R" / "Revenue" / "Cash receipt" / …).
 */
function aggregateLines(lines: JournalLine[]): JournalLine[] {
  const byKey = new Map<string, JournalLine>();
  for (const l of lines) {
    const acct = l.glAccountId !== "" ? l.glAccountId : l.glAccountName;
    const key = `${l.side}|${acct}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.debit = (cents(prev.debit) + cents(l.debit)) / 100;
      prev.credit = (cents(prev.credit) + cents(l.credit)) / 100;
    } else {
      byKey.set(key, { ...l });
    }
  }
  return [...byKey.values()];
}

/**
 * The CURRENT in-scope journal, keyed by event (§4.3): finalized invoices/credits (by `finalizedAt`
 * in-month, ruling 8) → `salesJournal`; posted non-void payments (receivedDate in-month) → one PAYMENT
 * `cashJournal`; live DISCOUNT/WRITE_OFF applications (appliedDate in-month) → one `cashJournal` each.
 * Revenue comes from the
 * invoice's own line snapshots grouped by `glAccountId` (TAX lines excluded — the tax line's account
 * is the plant default, matching the readiness gate); A/R, tax, discount, write-off and cash accounts
 * come from the plant config / payment type. Amounts are magnitudes — the INVOICE/CREDIT `kind` and
 * the mapper's `reverse` flag decide the debit/credit direction, never the stored money sign.
 */
async function buildCurrentJournal(tx: Tx, bounds: MonthBounds): Promise<Map<string, JournalLine[]>> {
  const { monthStart, monthEnd, nextStart } = bounds;
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

  // Sales side — invoices and credits, scoped by `finalizedAt` (ruling 8), half-open `[start, next)`.
  const invoices = await tx.invoice.findMany({
    where: { status: "FINALIZED", deletedAt: null, finalizedAt: { gte: monthStart, lt: nextStart } },
    select: {
      id: true, kind: true, total: true, taxTotal: true,
      lines: { select: { kind: true, glAccountId: true, glAccountName: true, amount: true } },
    },
  });
  for (const inv of invoices) {
    // Group the non-TAX lines by their snapshot glAccountId; sum magnitudes.
    const byAccount = new Map<string, { glAccountName: string; amount: number }>();
    for (const l of inv.lines) {
      if (l.kind === "TAX") continue; // the tax credit comes from config below, not the TAX line
      if (l.glAccountId === null) {
        // A $0 header line (PART) posts nothing; ANY other null-GL line is a dropped credit that
        // `resolveReadiness` was supposed to refuse the whole export on. Never silently `continue`
        // past it (that credits nothing yet still debits A/R the full total = an unbalanced batch) —
        // fail LOUDLY so a future readiness escape surfaces here, not in the ledger.
        if (cents(l.amount.toNumber()) === 0) continue;
        throw new HttpError(500,
          "GL export: an in-scope invoice line has no GL account — readiness should have refused this export");
      }
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
      deletedAt: null, receivedDate: { gte: monthStart, lte: monthEnd },
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
    where: { deletedAt: null, appliedDate: { gte: monthStart, lte: monthEnd }, type: { in: ["DISCOUNT", "WRITE_OFF"] } },
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
 * The NET prior postings (§4.3): every `GlPosting` with glDate in THIS period's month, grouped by the SAME 2-part
 * `${sourceType}:${sourceId}`, then netted within a group by `(glAccountId, side, memo)` so an
 * original post and its later reversal cancel. A group whose lines ALL net to zero is dropped (it was
 * fully reversed), so a key's PRESENCE means "has a live prior posting" — the exact complement the
 * delta needs. The reconstructed `JournalLine[]` carries the row's `memo` and `glAccountName` so a
 * reversal reproduces the original line verbatim.
 */
async function buildPriorNet(tx: Tx, bounds: MonthBounds): Promise<Map<string, JournalLine[]>> {
  const rows = await tx.glPosting.findMany({
    where: { glDate: { gte: bounds.monthStart, lte: bounds.monthEnd } },
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
 * Assemble the `ReadinessInput` and name every account gap (§7), scoped to the SAME month window the
 * delta posts (`bounds`), so the panel can never read a different period than the close does.
 * `arGlAccountId`/discount/write-off/sales-tax/freight/other-charge come from the plant config;
 * `hasTax` is true iff any in-scope finalized invoice has `taxTotal != 0` (its A/R debit includes the
 * tax, so a missing tax account would unbalance the journal); `hasDiscount`/`hasWriteOff` reflect
 * whether any such application is in scope.
 *
 * The rest is the crux (the two-lens review found the original scan too narrow): the export DROPS from
 * the credit side EVERY non-TAX invoice line whose snapshot `glAccountId` is null, while still debiting
 * A/R the full total — so EVERY such nonzero line (any kind, not just step-code/surcharge) MUST become
 * a gap or the batch is short a credit. Each is attributed to its source: OPERATION -> its step code,
 * SURCHARGE -> its surcharge, CERT -> the config cert step code (its GL rides in from there, never on a
 * line FK), FREIGHT -> the freight plant default, CHARGE -> the other-charge plant default. A $0 header
 * line (PART) posts nothing, so it is not a gap.
 */
async function resolveReadiness(tx: Tx, bounds: MonthBounds): Promise<ReadinessGap[]> {
  const { monthStart, monthEnd, nextStart } = bounds;
  const config = await getBillingConfig(tx);
  // In scope by `finalizedAt` (ruling 8), half-open `[start, next)` — the SAME scope buildCurrentJournal posts.
  const inScopeInvoice = { status: "FINALIZED" as const, deletedAt: null, finalizedAt: { gte: monthStart, lt: nextStart } };

  const invoices = await tx.invoice.findMany({ where: inScopeInvoice, select: { taxTotal: true } });
  const hasTax = invoices.some((i) => cents(i.taxTotal.toNumber()) !== 0);

  const [discountCount, writeOffCount] = await Promise.all([
    tx.application.count({ where: { deletedAt: null, type: "DISCOUNT", appliedDate: { gte: monthStart, lte: monthEnd } } }),
    tx.application.count({ where: { deletedAt: null, type: "WRITE_OFF", appliedDate: { gte: monthStart, lte: monthEnd } } }),
  ]);

  // The cert charge's GL rides in from the config cert step code — it never lands on a line's
  // `processStepCodeId` (invoices.ts) — so resolve it once to attribute a null-GL CERT line.
  let certStep: { id: string; code: string } | null = null;
  if (config.certChargeStepCodeId) {
    const sc = await tx.processStepCode.findFirst({ where: { id: config.certChargeStepCodeId }, select: { id: true, code: true } });
    if (sc) certStep = sc;
  }

  // EVERY account-less non-TAX line the export would post a credit for (not just step-code/surcharge).
  const badLines = await tx.invoiceLine.findMany({
    where: { glAccountId: null, kind: { not: "TAX" }, invoice: inScopeInvoice },
    select: {
      kind: true, amount: true,
      processStepCodeId: true, processStepCode: { select: { code: true } },
      surchargeId: true, surcharge: { select: { name: true } },
    },
  });
  const stepCodesMissingGl = new Map<string, { id: string; code: string }>();
  const surchargesMissingGl = new Map<string, { id: string; name: string }>();
  let hasFreight = false, hasCharge = false, hasCert = false, hasUnattributedLine = false;
  for (const l of badLines) {
    if (cents(l.amount.toNumber()) === 0) continue; // $0 header (PART) — posts nothing
    if (l.processStepCodeId) {
      stepCodesMissingGl.set(l.processStepCodeId, { id: l.processStepCodeId, code: l.processStepCode?.code ?? "" });
    } else if (l.surchargeId) {
      surchargesMissingGl.set(l.surchargeId, { id: l.surchargeId, name: l.surcharge?.name ?? "" });
    } else if (l.kind === "CERT") {
      hasCert = true; // when the cert step code is unset, `readinessGaps` names the missing config
      if (certStep) stepCodesMissingGl.set(certStep.id, certStep); // else attribute to that step code
    } else if (l.kind === "FREIGHT") {
      hasFreight = true;
    } else if (l.kind === "CHARGE") {
      hasCharge = true;
    } else {
      hasUnattributedLine = true; // orphaned OPERATION (step code SetNull) — still MUST surface a gap
    }
  }

  // Payment types with no GL account among in-scope posted, non-void payments.
  const payments = await tx.payment.findMany({
    where: {
      deletedAt: null, receivedDate: { gte: monthStart, lte: monthEnd },
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
    freightGlAccountId: config.freightGlAccountId,
    otherChargeGlAccountId: config.otherChargeGlAccountId,
    certChargeStepCodeId: config.certChargeStepCodeId,
    hasDiscount: discountCount > 0,
    hasWriteOff: writeOffCount > 0,
    hasTax,
    hasFreight,
    hasCharge,
    hasCert,
    stepCodesMissingGl: [...stepCodesMissingGl.values()],
    surchargesMissingGl: [...surchargesMissingGl.values()],
    paymentTypesMissingGl: [...paymentTypesMissingGl.values()],
    hasUnattributedLine,
  };
  return readinessGaps(input);
}

/** The readiness gap list the UI's export panel and disabled-count read — the SAME month window
 *  `exportClose` refuses on, so the panel and the refusal can never disagree (§7). */
export async function readinessForExport(periodEnd: Date): Promise<ReadinessGap[]> {
  const bounds = monthBoundsFromEnd(periodEnd);
  return withDbErrors({ entity: "GL export readiness" }, () => prisma.$transaction(
    (tx) => resolveReadiness(tx, bounds),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

/** One CSV row per line handed in: date, account, debit, credit, memo. `exportClose` hands it the
 *  aggregated SUMMARY lines (one per account per side, ruling 9), not the per-event lines. */
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

/** The stored register bytes for the register route, plus a derived download filename
 *  (`gl-register-<YYYY>-<MM>.pdf`, from the batch's OWN `periodEnd` — the same year/month the CSV's
 *  `fileName` uses) so its `inline` disposition names itself, matching every other inline-PDF route
 *  (certs/invoices/statements/traveler all pass `inline; filename="..."`) — fix round 1, Task 7
 *  review. 404 if the batch is gone. */
export async function getExportBatchRegister(batchId: string): Promise<{ bytes: Buffer; fileName: string; contentType: string }> {
  const batch = await prisma.glExportBatch.findFirst({
    where: { id: batchId }, select: { register: true, registerContentType: true, periodEnd: true },
  });
  if (!batch) throw new HttpError(404, "Export batch not found");
  const fileName = `gl-register-${batch.periodEnd.getUTCFullYear()}-${String(batch.periodEnd.getUTCMonth() + 1).padStart(2, "0")}.pdf`;
  return { bytes: Buffer.from(batch.register), fileName, contentType: batch.registerContentType };
}
