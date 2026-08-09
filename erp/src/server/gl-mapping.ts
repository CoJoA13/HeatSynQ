import type { JournalSide, PostingSourceType } from "@/lib/gl-constants";

export type JournalLine = {
  side: JournalSide;
  glAccountId: string;
  glAccountName: string;
  debit: number;
  credit: number;
  memo: string;
  sourceType: PostingSourceType;
  sourceId: string;
  isReversal: boolean;
};

export type SalesEvent = {
  kind: "INVOICE" | "CREDIT";
  invoiceId: string;
  total: number;
  arGlAccountId: string;
  arGlAccountName: string;
  taxTotal: number;
  taxGlAccountId: string | null;
  taxGlAccountName: string;
  revenue: { glAccountId: string; glAccountName: string; amount: number }[];
};

// ONE cash event = one payment, one discount application, or one write-off application. Each maps
// to a self-balancing pair (its debit + an A/R credit) keyed on that event's own id — so the
// per-event delta (§4.3) reverses one event without disturbing the others (never an aggregate A/R).
export type CashEvent = {
  kind: "PAYMENT" | "DISCOUNT" | "WRITE_OFF";
  sourceId: string; // the payment id / application id — a real cuid, never a display field
  amount: number;
  debitGlAccountId: string; // cash (PAYMENT) / discount / write-off account
  debitGlAccountName: string;
  arGlAccountId: string;
  arGlAccountName: string;
};

const c = (n: number) => Math.round(n * 100);

/** Sales side (§5): DR A/R = CR revenue + tax for an INVOICE; the mirror for a CREDIT. All lines
 *  carry this event's invoice id and isReversal:false (a new posting). */
export function salesJournal(ev: SalesEvent): JournalLine[] {
  const reverse = ev.kind === "CREDIT";
  const st: PostingSourceType = ev.kind;
  const dr = (id: string, name: string, amt: number, memo: string): JournalLine =>
    ({ side: "SALES", glAccountId: id, glAccountName: name, debit: amt, credit: 0, memo, sourceType: st, sourceId: ev.invoiceId, isReversal: false });
  const cr = (id: string, name: string, amt: number, memo: string): JournalLine =>
    ({ side: "SALES", glAccountId: id, glAccountName: name, debit: 0, credit: amt, memo, sourceType: st, sourceId: ev.invoiceId, isReversal: false });
  const lines: JournalLine[] = [];
  lines.push(reverse ? cr(ev.arGlAccountId, ev.arGlAccountName, ev.total, "A/R") : dr(ev.arGlAccountId, ev.arGlAccountName, ev.total, "A/R"));
  for (const r of ev.revenue) {
    if (c(r.amount) === 0) continue;
    lines.push(reverse ? dr(r.glAccountId, r.glAccountName, r.amount, "Revenue") : cr(r.glAccountId, r.glAccountName, r.amount, "Revenue"));
  }
  if (c(ev.taxTotal) !== 0 && ev.taxGlAccountId) {
    lines.push(reverse ? dr(ev.taxGlAccountId, ev.taxGlAccountName, ev.taxTotal, "Sales tax") : cr(ev.taxGlAccountId, ev.taxGlAccountName, ev.taxTotal, "Sales tax"));
  }
  return lines;
}

/** Cash side (§5): one event → DR its account + CR A/R, balanced, both keyed on the event id. */
export function cashJournal(ev: CashEvent): JournalLine[] {
  const memo = ev.kind === "PAYMENT" ? "Cash receipt" : ev.kind === "DISCOUNT" ? "Discount" : "Write-off";
  return [
    { side: "CASH", glAccountId: ev.debitGlAccountId, glAccountName: ev.debitGlAccountName, debit: ev.amount, credit: 0, memo, sourceType: ev.kind, sourceId: ev.sourceId, isReversal: false },
    { side: "CASH", glAccountId: ev.arGlAccountId, glAccountName: ev.arGlAccountName, debit: 0, credit: ev.amount, memo: "A/R", sourceType: ev.kind, sourceId: ev.sourceId, isReversal: false },
  ];
}

/** Reverse a set of previously-posted lines (swap debit/credit, mark isReversal). §4.3 corrections. */
export function reverseLines(lines: JournalLine[]): JournalLine[] {
  return lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit, isReversal: true }));
}

export type ReadinessGap = {
  kind: "step-code" | "surcharge" | "payment-type" | "plant-default";
  id: string | null;
  label: string;
  href: string;
};

export type ReadinessInput = {
  arGlAccountId: string | null;
  discountGlAccountId: string | null;
  writeOffGlAccountId: string | null;
  hasDiscount: boolean;
  hasWriteOff: boolean;
  stepCodesMissingGl: { id: string; code: string }[];
  surchargesMissingGl: { id: string; name: string }[];
  paymentTypesMissingGl: { id: string; name: string }[];
};

/** §7 refuse-to-export: name every account gap. Empty => the export may proceed. */
export function readinessGaps(input: ReadinessInput): ReadinessGap[] {
  const gaps: ReadinessGap[] = [];
  if (!input.arGlAccountId) gaps.push({ kind: "plant-default", id: null, label: "A/R control account is not set", href: "/admin/billing" });
  if (input.hasDiscount && !input.discountGlAccountId) gaps.push({ kind: "plant-default", id: null, label: "Discount account is not set", href: "/admin/billing" });
  if (input.hasWriteOff && !input.writeOffGlAccountId) gaps.push({ kind: "plant-default", id: null, label: "Write-off account is not set", href: "/admin/billing" });
  for (const s of input.stepCodesMissingGl) gaps.push({ kind: "step-code", id: s.id, label: `Process step code ${s.code} has no GL account`, href: `/admin/step-codes` });
  for (const u of input.surchargesMissingGl) gaps.push({ kind: "surcharge", id: u.id, label: `Surcharge ${u.name} has no GL account`, href: `/admin/surcharges` });
  for (const p of input.paymentTypesMissingGl) gaps.push({ kind: "payment-type", id: p.id, label: `Payment type ${p.name} has no GL account`, href: `/admin/reference` });
  return gaps;
}
