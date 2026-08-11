// ============================================================================================
// The quote-link eligibility leaf (Phase 6 Task 5 — spec §5.2, rulings 5–7). A dependency-free
// LEAF, the order-locks.ts / invoice-guards.ts precedent: created BEFORE the `orders.ts ↔
// quotes.ts` cycle can exist rather than after it crashes at module-evaluation time. orders.ts
// needs "which quote line prices this customer + part as of this received date" INSIDE its own
// save transaction; the /api/quotes/eligible route and Task 9's part-page indicator need the
// same answer bare. The rule therefore lives here, stated ONCE, and this module imports nothing
// but Prisma types and the pure date lib — no quotes.ts, no orders.ts, no invoices.ts — so it
// stays importable from anywhere without dragging a permission or service graph behind it.
//
// THE RULE (spec §5.2 — one rule, used everywhere): the quote is OPEN and live; the quote line
// is live and carries a part (`partId` set — a free-text line is never eligible, ruling 1); the
// quote's customer IS the order's customer; and the order's received date sits inside the
// window INCLUSIVE ON BOTH ENDS: `effectiveDate ≤ receivedDate ≤ expiryDate` (ruling 6 — a
// quote expiring today still prices an order received today). Eligibility is judged AT LINK
// TIME against the received date; nothing here re-judges a link already stored.
//
// It throws nothing and checks no permission. `judgeQuoteLine` returns a verdict with the
// failing clause NAMED; the `HttpError` each caller raises stays at the call site, where the
// line label and the status code live (the invoice-guards contract).
//
// CONCURRENCY CONTRACT (the §5.14 SSI pairing — Task 4's review, Important #1): when the order
// save calls into this module it MUST do so on its own transaction's client, never the bare
// `prisma` (the #60 lesson) — that in-transaction read of the QuoteLine/Quote rows is the
// order-side HALF of the guard that keeps a quote edit from dropping or re-pointing a line an
// order is concurrently linking to. quotes.ts's `updateQuote`/`deleteQuote` read the OrderLine
// predicate ("no order line references this quote line") Serializable; the order save reads the
// quote line here, Serializable, and writes `OrderLine.quoteLineId` — two rw-antidependency
// edges, a cycle, and SSI aborts one side. Read on the bare client (or at a lower isolation)
// there is only ONE edge and SSI catches nothing. See createOrder's doc comment (orders.ts) and
// the dangerous-direction test in tests/quote-links.test.ts.
// ============================================================================================
import type { Prisma } from "../../prisma/generated/prisma/client";
import { formatDateOnly } from "../lib/business-days";

type Db = Prisma.TransactionClient;

/** What the entry UI (and the order save's validation/audit) needs of an eligible line: the
 *  quote's identity + window for display, the line id for the link itself. Dates are
 *  "yyyy-mm-dd" strings — the house wire shape for @db.Date columns. */
export type QuoteLinkCandidate = {
  quoteLineId: string;
  quoteId: string;
  quoteNumber: number;
  effectiveDate: string;
  expiryDate: string;
};

/** The three facts eligibility is judged against — the ORDER's side of the rule. `receivedDate`
 *  is a date-only Date (UTC midnight, the parseDateOnly convention), matching the @db.Date
 *  columns it is compared to. */
export type QuoteLinkArgs = { customerId: string; partId: string; receivedDate: Date };

const CANDIDATE_SELECT = {
  id: true,
  quote: { select: { id: true, quoteNumber: true, effectiveDate: true, expiryDate: true } },
} satisfies Prisma.QuoteLineSelect;

type CandidateRow = Prisma.QuoteLineGetPayload<{ select: typeof CANDIDATE_SELECT }>;

const toCandidate = (row: CandidateRow): QuoteLinkCandidate => ({
  quoteLineId: row.id,
  quoteId: row.quote.id,
  quoteNumber: row.quote.quoteNumber,
  effectiveDate: formatDateOnly(row.quote.effectiveDate),
  expiryDate: formatDateOnly(row.quote.expiryDate),
});

/**
 * Every ELIGIBLE quote line for this customer + part as of `receivedDate`, ordered by ruling 7:
 * latest `effectiveDate` first, tie broken by HIGHER `quoteNumber` (unique, so the ordering is
 * total — two live lines of one quote can never both match, the one-live-line-per-part-per-quote
 * service rule). `[0]` is the auto-link winner; the rest are the entry UI's re-pick choices.
 *
 * NOTE the WHERE here and the clause walk in `judgeQuoteLine` below are the SAME §5.2 rule in
 * two shapes — a set query cannot name which clause failed, a walk can. Edit them TOGETHER; the
 * boundary tests in quote-links.test.ts pin both paths at every edge.
 */
export async function eligibleQuoteLines(db: Db, args: QuoteLinkArgs): Promise<QuoteLinkCandidate[]> {
  const rows = await db.quoteLine.findMany({
    where: {
      deletedAt: null,
      partId: args.partId,
      quote: {
        deletedAt: null,
        status: "OPEN",
        customerId: args.customerId,
        effectiveDate: { lte: args.receivedDate },
        expiryDate: { gte: args.receivedDate },
      },
    },
    select: CANDIDATE_SELECT,
    orderBy: [{ quote: { effectiveDate: "desc" } }, { quote: { quoteNumber: "desc" } }],
  });
  return rows.map(toCandidate);
}

/** Ruling 7's silent resolution: the first of `eligibleQuoteLines`' ordering, or null when no
 *  quote covers the line (the line then falls to part prices — no link is a normal state). */
export async function resolveAutoLink(db: Db, args: QuoteLinkArgs): Promise<QuoteLinkCandidate | null> {
  return (await eligibleQuoteLines(db, args))[0] ?? null;
}

/** `judgeQuoteLine`'s verdict: `ok` with the candidate, or the failing clause as a sentence
 *  FRAGMENT (lower-case start, no terminal period) the caller prefixes with its own line label
 *  and wraps in its own HttpError — this module throws nothing. */
export type QuoteLinkJudgement =
  | { ok: true; candidate: QuoteLinkCandidate }
  | { ok: false; reason: string };

/**
 * Judges ONE named quote line — the explicit-pick path (spec §5.2: "the save payload can carry
 * an explicit `quoteLineId`, validated against the same eligibility rule") — walking the §5.2
 * clauses in a fixed order so the FIRST failing one is the one named: existence, quote liveness,
 * line liveness, status, customer, part identity, window. The happy path returns the same
 * candidate shape the auto-resolution produces, so callers store and audit one shape either way.
 */
export async function judgeQuoteLine(
  db: Db, quoteLineId: string, args: QuoteLinkArgs,
): Promise<QuoteLinkJudgement> {
  const row = await db.quoteLine.findFirst({
    where: { id: quoteLineId },
    select: {
      id: true, deletedAt: true, partId: true,
      quote: {
        select: {
          id: true, quoteNumber: true, status: true, deletedAt: true, customerId: true,
          effectiveDate: true, expiryDate: true,
        },
      },
    },
  });
  const no = (reason: string): QuoteLinkJudgement => ({ ok: false, reason });

  if (!row) return no("that quote line does not exist");
  const label = `Quote #${row.quote.quoteNumber}`;
  if (row.quote.deletedAt !== null) return no(`${label} has been deleted`);
  if (row.deletedAt !== null) return no(`${label} no longer carries that line`);
  if (row.quote.status !== "OPEN") return no(`${label} is closed`);
  if (row.quote.customerId !== args.customerId) return no(`${label} belongs to another customer`);
  if (row.partId === null) {
    return no(`${label}'s line is free-text — attach its part on the quote before linking`);
  }
  if (row.partId !== args.partId) return no(`${label}'s line quotes a different part`);
  const received = args.receivedDate.getTime();
  if (received < row.quote.effectiveDate.getTime() || received > row.quote.expiryDate.getTime()) {
    return no(
      `${label} is not in effect on ${formatDateOnly(args.receivedDate)} ` +
      `(effective ${formatDateOnly(row.quote.effectiveDate)} to ${formatDateOnly(row.quote.expiryDate)})`);
  }
  return {
    ok: true,
    candidate: {
      quoteLineId: row.id,
      quoteId: row.quote.id,
      quoteNumber: row.quote.quoteNumber,
      effectiveDate: formatDateOnly(row.quote.effectiveDate),
      expiryDate: formatDateOnly(row.quote.expiryDate),
    },
  };
}
