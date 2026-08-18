// Pure constants only — no server-only imports. Safe to import from client components.
export const JOURNAL_SIDES = ["SALES", "CASH"] as const;
export type JournalSide = (typeof JOURNAL_SIDES)[number];
export const CLOSE_STATUSES = ["CLOSED", "REOPENED"] as const;
export type CloseStatus = (typeof CLOSE_STATUSES)[number];
export const POSTING_SOURCE_TYPES = ["INVOICE", "CREDIT", "PAYMENT", "DISCOUNT", "WRITE_OFF"] as const;
export type PostingSourceType = (typeof POSTING_SOURCE_TYPES)[number];
export const GL_EXPORT_COLUMNS = ["Date", "Account", "Debit", "Credit", "Memo"] as const;
// The readiness gap discriminant (#90) — the server's `readinessGaps` (gl-mapping.ts) emits it and
// the close screen's local mirror types against it, so the two cannot drift (Close.tsx may import
// from src/lib, never src/server).
export type ReadinessGapKind = "step-code" | "surcharge" | "payment-type" | "plant-default" | "invoice";
// The close/readiness year window, shared by every `?year=` / body parse site (#90). The floor
// exists for two reasons, both real: `Number(null)` and `Number("")` are `0`, which passes
// `Number.isInteger` — so an ABSENT year would silently become year 0 — and `Date.UTC` maps years
// 0-99 into 1900-1999, so a two-digit typo would silently close a 1900s period while the row is
// stored under the typed year. The ceiling closes the mirror-image hole: a five-digit year formats
// to "10000-07-31", which every strict yyyy-mm-dd parse downstream rejects — before #90 that 400
// happened only by luck and blamed the wrong field ("As-of date").
export const MIN_CLOSE_YEAR = 2000;
export const MAX_CLOSE_YEAR = 9999;
