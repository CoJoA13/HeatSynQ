// Pure client-safe module shared by the /quotes list page and the /quotes/[id] detail page:
// local mirrors of src/server/quotes.ts's read models (NOT imported from src/server/** —
// CLAUDE.md "Constraints that will bite you": a client component pulling from there drags
// node:async_hooks and Prisma into the browser bundle), the detail page's form state, and the
// ONE place the PATCH payload is built.
//
// THE ROUND-TRIP CONTRACT (task-08-brief.md item 4). `updateQuote` (Task 4) is a diff-and-write:
// a kept row whose payload values equal the stored ones gets NO write, so a save payload built
// correctly from an unchanged load is a server-side no-op. Two rules make that true, both
// encoded in `lineFormsFrom`/`linesPayload` below and nowhere else:
//
//  - `eachWeight` RIDES ALONG on free-text lines. The tests' `linesPayloadFrom` (Task 4's
//    documented round-trip shape) OMITS it — its known Minor 2 — and a client copying it as-is
//    sends `eachWeight: undefined` → stored as null, silently blanking a free-text line's weight
//    on every save. This module carries the loaded value back.
//  - A part-linked line's free-text columns (and eachWeight) are sent BLANK, exactly as
//    `linesPayloadFrom` does. The detail read resolves those fields FROM THE PART for a linked
//    line, so echoing them back would write the part's live identity into the line's dormant
//    text columns; blank-as-sent is Task 4 deviation 5's documented round-trip shape (for a line
//    that was never free-text, the stored columns are already ""/null, so blank IS the no-op).
//
// The header is diffed CLIENT-side (`headerPatch`): `updateQuote` patches every header key the
// payload carries even when the value is unchanged (only the line tree is diff-and-write), so an
// unchanged field is simply not sent, and a fully unchanged form sends no request at all (the
// PATCH route 400s an empty body by design). `customerId` is never sent — immutable (spec §4.1),
// and echoing it back only mints a no-op audit entry (Task 4 review, Minor 3).
import type { PricePerValue } from "@/lib/part-constants";
import type { QuoteStatusValue } from "@/lib/quote-constants";

// ---------------------------------------------------------------------------------------------
// Read-model mirrors (src/server/quotes.ts: QuoteBreakRow/QuotePriceRow/QuoteLineDetail/
// QuoteDetail/QuoteRow/QuoteWorklist/QuoteCloseResult/LinkedOpenOrder).
// ---------------------------------------------------------------------------------------------

export type LinkedOrderRef = { id: string; orderNumber: number };

export type QuoteBreakData = { id: string; threshold: number; price: number };
export type QuotePriceData = {
  id: string; processStepCodeId: string; stepCode: string; stepName: string; position: number;
  setupCharge: number | null; unitPrice: number | null; minimumCharge: number | null;
  pricePer: PricePerValue; notes: string; breaks: QuoteBreakData[];
};
export type QuoteLineData = {
  id: string; position: number; partId: string | null;
  /** Resolved live-or-text (quotes.ts): a linked line reads these FROM THE PART; a free-text
   *  line reads its own columns. One field set either way. */
  partNumber: string; partName: string; partDescription: string; material: string;
  eachWeight: number | null;
  quotedQty: number | null; quotedUnlimited: boolean;
  linkedOrderCount: number; linkedOrders: LinkedOrderRef[];
  prices: QuotePriceData[];
};
export type QuoteDetailData = {
  id: string; quoteNumber: number; status: QuoteStatusValue; expired: boolean;
  customerId: string; customerCode: string; customerName: string;
  contactId: string | null; contactName: string;
  quoteDate: string; effectiveDate: string; expiryDate: string; followUpDate: string | null;
  rfqNumber: string; quotedById: string; quotedByName: string;
  endingStatementId: string | null; endingStatementName: string; endingStatementText: string;
  closeReason: string; closedAt: string | null; closedByName: string;
  notes: string; internalNotes: string; deletedAt: string | null;
  lines: QuoteLineData[];
};
export type QuoteCloseResultData = { quote: QuoteDetailData; linkedOpenOrders: LinkedOrderRef[] };

export type QuoteRowData = {
  id: string; quoteNumber: number;
  customerId: string; customerCode: string; customerName: string;
  status: QuoteStatusValue; expired: boolean;
  quoteDate: string; effectiveDate: string; expiryDate: string; followUpDate: string | null;
  rfqNumber: string; quotedByName: string; lineCount: number;
};
export type QuoteWorklistData = {
  followUpDue: { count: number; rows: QuoteRowData[] };
  expired: { count: number; rows: QuoteRowData[] };
};

// ---------------------------------------------------------------------------------------------
// Form state. Every numeric field is held as the STRING the bound input shows (the parts/[id]
// PricingSection precedent — the server's decimalField schemas accept a decimal string as-is);
// `key` is the React list key (the row's own id for loaded rows, a minted client key for added
// ones) and never crosses the wire.
// ---------------------------------------------------------------------------------------------

export type BreakForm = { id?: string; key: string; threshold: string; price: string };
export type PriceForm = {
  id?: string; key: string;
  processStepCodeId: string;
  /** Display fallback for the step select when the pick-list is unavailable (the R3
   *  synthesized-option rule) — loaded rows carry their live code/name from the detail. */
  stepCode: string; stepName: string;
  setupCharge: string; unitPrice: string; minimumCharge: string;
  pricePer: PricePerValue; notes: string;
  breaks: BreakForm[];
};
export type LineForm = {
  id?: string; key: string;
  partId: string | null;
  partNumberText: string; partNameText: string; partDescriptionText: string; materialText: string;
  eachWeight: string;
  quotedQty: string; quotedUnlimited: boolean;
  prices: PriceForm[];
  /** Display-only (the §5.14 linked-line indicator + proactive disable) — never sent. */
  linkedOrders: LinkedOrderRef[];
};
export type HeaderForm = {
  contactId: string; // "" = none
  quoteDate: string; effectiveDate: string; expiryDate: string;
  followUpDate: string; // "" = none
  rfqNumber: string;
  quotedById: string;
  endingStatementId: string; // "" = none
  notes: string; internalNotes: string;
};

const numStr = (n: number | null): string => (n === null ? "" : String(n));

export function headerFormFrom(d: QuoteDetailData): HeaderForm {
  return {
    contactId: d.contactId ?? "",
    quoteDate: d.quoteDate, effectiveDate: d.effectiveDate, expiryDate: d.expiryDate,
    followUpDate: d.followUpDate ?? "",
    rfqNumber: d.rfqNumber,
    quotedById: d.quotedById,
    endingStatementId: d.endingStatementId ?? "",
    notes: d.notes, internalNotes: d.internalNotes,
  };
}

export function lineFormsFrom(d: QuoteDetailData): LineForm[] {
  return d.lines.map((l) => ({
    id: l.id, key: l.id,
    partId: l.partId,
    // The blank-when-linked rule — see the module comment. A free-text line's fields are its own
    // stored columns (the detail read guarantees it), so they round-trip verbatim.
    partNumberText: l.partId !== null ? "" : l.partNumber,
    partNameText: l.partId !== null ? "" : l.partName,
    partDescriptionText: l.partId !== null ? "" : l.partDescription,
    materialText: l.partId !== null ? "" : l.material,
    eachWeight: l.partId !== null ? "" : numStr(l.eachWeight),
    quotedQty: numStr(l.quotedQty),
    quotedUnlimited: l.quotedUnlimited,
    prices: l.prices.map((p) => ({
      id: p.id, key: p.id,
      processStepCodeId: p.processStepCodeId, stepCode: p.stepCode, stepName: p.stepName,
      setupCharge: numStr(p.setupCharge), unitPrice: numStr(p.unitPrice),
      minimumCharge: numStr(p.minimumCharge),
      pricePer: p.pricePer, notes: p.notes,
      breaks: p.breaks.map((b) => ({
        id: b.id, key: b.id, threshold: String(b.threshold), price: String(b.price),
      })),
    })),
    linkedOrders: l.linkedOrders,
  }));
}

/** Only the header keys whose form value differs from the loaded baseline — see the module
 *  comment on why the header is client-diffed. ""-vs-null translation happens here, once. */
export function headerPatch(cur: HeaderForm, base: HeaderForm): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (cur.contactId !== base.contactId) patch.contactId = cur.contactId || null;
  if (cur.quoteDate !== base.quoteDate) patch.quoteDate = cur.quoteDate;
  if (cur.effectiveDate !== base.effectiveDate) patch.effectiveDate = cur.effectiveDate;
  if (cur.expiryDate !== base.expiryDate) patch.expiryDate = cur.expiryDate;
  if (cur.followUpDate !== base.followUpDate) patch.followUpDate = cur.followUpDate || null;
  if (cur.rfqNumber !== base.rfqNumber) patch.rfqNumber = cur.rfqNumber;
  if (cur.quotedById !== base.quotedById) patch.quotedById = cur.quotedById;
  if (cur.endingStatementId !== base.endingStatementId) {
    patch.endingStatementId = cur.endingStatementId || null;
  }
  if (cur.notes !== base.notes) patch.notes = cur.notes;
  if (cur.internalNotes !== base.internalNotes) patch.internalNotes = cur.internalNotes;
  return patch;
}

/** One line's wire shape, shared verbatim by the payload builder and the changed-lines compare
 *  (`quotedQty` stays the raw string here — the compare must never throw on mid-edit text; the
 *  payload builder converts and validates it on top). */
function lineShape(l: LineForm) {
  const linked = l.partId !== null;
  return {
    ...(l.id !== undefined ? { id: l.id } : {}),
    partId: l.partId,
    partNumberText: linked ? "" : l.partNumberText,
    partNameText: linked ? "" : l.partNameText,
    partDescriptionText: linked ? "" : l.partDescriptionText,
    materialText: linked ? "" : l.materialText,
    // The eachWeight carry — the whole point of this module (Task 4 review, Minor 2).
    eachWeight: linked || l.eachWeight.trim() === "" ? null : l.eachWeight,
    quotedQty: l.quotedQty,
    quotedUnlimited: l.quotedUnlimited,
    prices: l.prices.map((p) => ({
      ...(p.id !== undefined ? { id: p.id } : {}),
      processStepCodeId: p.processStepCodeId,
      setupCharge: p.setupCharge.trim() === "" ? null : p.setupCharge,
      unitPrice: p.unitPrice.trim() === "" ? null : p.unitPrice,
      minimumCharge: p.minimumCharge.trim() === "" ? null : p.minimumCharge,
      pricePer: p.pricePer,
      notes: p.notes,
      breaks: p.breaks.map((b) => ({
        ...(b.id !== undefined ? { id: b.id } : {}),
        threshold: b.threshold, price: b.price,
      })),
    })),
  };
}

/** "Did the user change the line tree at all?" — compared over the exact wire shape, so an edit
 *  the payload would not send (typing into a free-text column of a line that then got a part
 *  picked) never counts as a change, and add/remove/reorder always does. */
export function linesComparable(lines: LineForm[]): string {
  return JSON.stringify(lines.map(lineShape));
}

export type LinesPayload =
  | { ok: true; lines: Record<string, unknown>[] }
  | { ok: false; error: string };

/** The `lines` array for PATCH /api/quotes/[id] — Task 4's array-replace: rows with an id are
 *  updated in place, rows without are created, live rows missing are soft-deleted. Client-side
 *  checks cover only what would otherwise produce an unhelpful zod message (the InvoiceLinesGrid
 *  qty precedent); every business rule stays server-side and surfaces verbatim (§5.13). */
export function linesPayload(lines: LineForm[]): LinesPayload {
  const out: Record<string, unknown>[] = [];
  for (const [i, l] of lines.entries()) {
    const label = `Line ${i + 1}`;
    if (l.partId === null && l.partNumberText.trim() === "") {
      return { ok: false, error: `${label}: pick a part or enter a free-text part number.` };
    }
    let quotedQty: number | null = null;
    if (l.quotedQty.trim() !== "") {
      quotedQty = Number(l.quotedQty);
      if (!Number.isInteger(quotedQty) || quotedQty < 1) {
        return { ok: false, error: `${label}: quoted quantity must be a whole number of at least 1.` };
      }
    }
    for (const p of l.prices) {
      for (const b of p.breaks) {
        if (b.threshold.trim() === "" || b.price.trim() === "") {
          return {
            ok: false,
            error: `${label}: a price break needs both a threshold and a price — delete the break instead of blanking it.`,
          };
        }
      }
    }
    out.push({ ...lineShape(l), quotedQty });
  }
  return { ok: true, lines: out };
}
