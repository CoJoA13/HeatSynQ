import type { JournalSide, PostingSourceType, ReadinessGapKind } from "@/lib/gl-constants";

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

// Amounts are SIGNED, exactly as stored on the invoice row (#216): an INVOICE normally positive,
// a CREDIT stored negative by `createCredit`, and a mixed-sign line set passed through as-is —
// `salesJournal` places each amount by its own sign, never by `kind`.
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

/** Sales side (§5): DR A/R = CR revenue + tax, driven by SIGNED amounts exactly as stored (#216).
 *  A positive amount lands on its natural side (DR for A/R, CR for revenue/tax); a negative lands
 *  on the OPPOSITE side with its magnitude, so every emitted line carries non-negative columns —
 *  the CSV and register render single-signed cells. The stored money sign IS the direction:
 *  `createCredit` writes a CREDIT's total/lines negative, so a credit memo reverses itself (CR A/R,
 *  DR revenue) with no kind-based flip, and `kind` survives only as the posting `sourceType`.
 *  What the signed arithmetic buys over the old magnitudes-plus-kind: a MIXED-sign document — a
 *  finalized invoice carrying a negative adjustment line is reachable end-to-end, the amount field
 *  has no minimum — posts that line as a contra DEBIT instead of inflating the credit column, so
 *  the batch balances instead of 500ing on the Σdebit backstop under a clean readiness list.
 *  All lines carry this event's invoice id and isReversal:false (a new posting). */
export function salesJournal(ev: SalesEvent): JournalLine[] {
  const st: PostingSourceType = ev.kind;
  const line = (id: string, name: string, debit: number, credit: number, memo: string): JournalLine =>
    ({ side: "SALES", glAccountId: id, glAccountName: name, debit, credit, memo, sourceType: st, sourceId: ev.invoiceId, isReversal: false });
  // Signed placement: `dr` is the natural-debit slot, `cr` the natural-credit slot; a negative
  // amount takes the other side with |amt|.
  const dr = (id: string, name: string, amt: number, memo: string): JournalLine =>
    amt >= 0 ? line(id, name, amt, 0, memo) : line(id, name, 0, -amt, memo);
  const cr = (id: string, name: string, amt: number, memo: string): JournalLine =>
    amt >= 0 ? line(id, name, 0, amt, memo) : line(id, name, -amt, 0, memo);
  const lines: JournalLine[] = [];
  lines.push(dr(ev.arGlAccountId, ev.arGlAccountName, ev.total, "A/R"));
  for (const r of ev.revenue) {
    if (c(r.amount) === 0) continue;
    lines.push(cr(r.glAccountId, r.glAccountName, r.amount, "Revenue"));
  }
  if (c(ev.taxTotal) !== 0 && ev.taxGlAccountId) {
    lines.push(cr(ev.taxGlAccountId, ev.taxGlAccountName, ev.taxTotal, "Sales tax"));
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
  kind: ReadinessGapKind; // the shared client-safe union (gl-constants.ts) Close.tsx types against
  id: string | null;
  label: string;
  href: string;
};

export type ReadinessInput = {
  arGlAccountId: string | null;
  discountGlAccountId: string | null;
  writeOffGlAccountId: string | null;
  salesTaxGlAccountId: string | null;
  // Plant defaults the FREIGHT / CHARGE / CERT credit lines draw from (§4.5). A null-GL line of the
  // matching kind is dropped from the credit side just like a step-code/surcharge line, so each needs
  // its own gap or the batch unbalances. `certChargeStepCodeId` is the cert charge's source: when it
  // is set, a null-GL CERT line is attributed to that step code (via `stepCodesMissingGl`); when it is
  // unset, the gap is the missing config itself.
  freightGlAccountId: string | null;
  otherChargeGlAccountId: string | null;
  certChargeStepCodeId: string | null;
  hasDiscount: boolean;
  hasWriteOff: boolean;
  hasTax: boolean; // any in-scope invoice with taxTotal != 0 — its A/R debit already includes the tax
  hasFreight: boolean; // any in-scope FREIGHT line with a null GL and a nonzero amount
  hasCharge: boolean; // any in-scope CHARGE line with a null GL and a nonzero amount
  hasCert: boolean; // any in-scope CERT line with a null GL and a nonzero amount
  // #89: the invoices carrying a FROZEN null-GL line, of ANY kind (widened in review round 1). The
  // flags above and the maps below name the CONFIG to fix; this names the PAPER to fix, and the two
  // are independent — configuring a default does nothing to an invoice already finalized without
  // one, because `buildCurrentJournal` reads the line's snapshot, not the config (§5.4). Without
  // this the export read clean and then 500'd on the same line.
  invoicesMissingGl: { id: string; label: string }[];
  stepCodesMissingGl: { id: string; code: string }[];
  surchargesMissingGl: { id: string; name: string }[];
  paymentTypesMissingGl: { id: string; name: string }[];
  // Safety net: a dropped nonzero credit line that could not be attributed to any source above
  // (only reachable if an OPERATION line were orphaned from its step code). It still MUST surface a
  // gap so readiness — not the balance backstop alone — refuses the export.
  hasUnattributedLine: boolean;
};

/** §7 refuse-to-export: name every account gap. Empty => the export may proceed. */
export function readinessGaps(input: ReadinessInput): ReadinessGap[] {
  const gaps: ReadinessGap[] = [];
  if (!input.arGlAccountId) gaps.push({ kind: "plant-default", id: null, label: "A/R control account is not set", href: "/admin/billing" });
  if (input.hasDiscount && !input.discountGlAccountId) gaps.push({ kind: "plant-default", id: null, label: "Discount account is not set", href: "/admin/billing" });
  if (input.hasWriteOff && !input.writeOffGlAccountId) gaps.push({ kind: "plant-default", id: null, label: "Write-off account is not set", href: "/admin/billing" });
  // A taxable invoice's total (the A/R debit) already includes tax; without a tax account the tax
  // credit line is dropped and the journal would be unbalanced — refuse (§15), do not silently drop.
  if (input.hasTax && !input.salesTaxGlAccountId) gaps.push({ kind: "plant-default", id: null, label: "Sales tax account is not set", href: "/admin/billing" });
  // FREIGHT / CHARGE / CERT credit lines draw their GL from these plant defaults; a null-GL line of
  // the kind is a dropped credit exactly like the tax case above (§4.3 / §7).
  if (input.hasFreight && !input.freightGlAccountId) gaps.push({ kind: "plant-default", id: null, label: "Freight account is not set", href: "/admin/billing" });
  if (input.hasCharge && !input.otherChargeGlAccountId) gaps.push({ kind: "plant-default", id: null, label: "Other charge account is not set", href: "/admin/billing" });
  if (input.hasCert && !input.certChargeStepCodeId) gaps.push({ kind: "plant-default", id: null, label: "Certification step code is not set", href: "/admin/billing" });
  // #89: named UNCONDITIONALLY — the plant default above may well be set now, and the frozen line is
  // still account-less. The only fix is to re-raise that paper, so the gap says so.
  for (const i of input.invoicesMissingGl) gaps.push({ kind: "invoice", id: i.id, label: `Invoice ${i.label} has a line with no GL account — unlock and re-finalize it`, href: `/invoicing/${i.id}` });
  for (const s of input.stepCodesMissingGl) gaps.push({ kind: "step-code", id: s.id, label: `Process step code ${s.code} has no GL account`, href: "/admin/step-codes" });
  for (const u of input.surchargesMissingGl) gaps.push({ kind: "surcharge", id: u.id, label: `Surcharge ${u.name} has no GL account`, href: "/admin/surcharges" });
  for (const p of input.paymentTypesMissingGl) gaps.push({ kind: "payment-type", id: p.id, label: `Payment type ${p.name} has no GL account`, href: "/admin/reference" });
  if (input.hasUnattributedLine) gaps.push({ kind: "plant-default", id: null, label: "An invoice line has no GL account", href: "/admin/billing" });
  return gaps;
}
