// Pure constants only — no server-only imports. Safe to import from client components.
export const JOURNAL_SIDES = ["SALES", "CASH"] as const;
export type JournalSide = (typeof JOURNAL_SIDES)[number];
export const CLOSE_STATUSES = ["CLOSED", "REOPENED"] as const;
export type CloseStatus = (typeof CLOSE_STATUSES)[number];
export const POSTING_SOURCE_TYPES = ["INVOICE", "CREDIT", "PAYMENT", "DISCOUNT", "WRITE_OFF"] as const;
export type PostingSourceType = (typeof POSTING_SOURCE_TYPES)[number];
export const GL_EXPORT_COLUMNS = ["Date", "Account", "Debit", "Credit", "Memo"] as const;
