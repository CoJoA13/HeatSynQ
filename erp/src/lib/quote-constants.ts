// Pure constants only — no server-only imports. Safe to import from client components.
// QUOTE_STATUSES lists the same members Quote.status stores (a String column, not a Prisma
// enum — the ReceiptBatch.status shape); the service is the writer that keeps them in step.
export const QUOTE_STATUSES = ["OPEN", "CLOSED"] as const;
export type QuoteStatusValue = (typeof QUOTE_STATUSES)[number];
export const QUOTE_STATUS_LABELS: Record<QuoteStatusValue, string> = {
  OPEN: "Open",
  CLOSED: "Closed",
};

// "Expired" is DERIVED, never stored (spec ruling 3): an OPEN, live quote whose expiryDate has
// passed renders as Expired everywhere — no status flip, no job. The list's status filter offers
// it as a third, derived option beside the two stored statuses above.
export const QUOTE_EXPIRED_LABEL = "Expired";

// The two §5.4 worklist sections, keyed for the route/UI contract. A quote may appear in BOTH
// (overdue follow-up on an already-expired quote) — that is information, not a bug.
export const QUOTE_WORKLIST_SECTIONS = ["followUpDue", "expired"] as const;
export type QuoteWorklistSection = (typeof QUOTE_WORKLIST_SECTIONS)[number];
export const QUOTE_WORKLIST_LABELS: Record<QuoteWorklistSection, string> = {
  followUpDue: "Follow-up due",
  expired: "Expired",
};
