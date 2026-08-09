// Pure constants only — no server-only imports. Safe to import from client components.
export const APPLICATION_TYPES = ["PAYMENT", "DISCOUNT", "WRITE_OFF", "CREDIT"] as const;
export type ApplicationTypeValue = (typeof APPLICATION_TYPES)[number];
export const APPLICATION_TYPE_LABELS: Record<ApplicationTypeValue, string> = {
  PAYMENT: "Payment", DISCOUNT: "Discount", WRITE_OFF: "Write-off", CREDIT: "Credit applied",
};
export const RECEIPT_BATCH_STATUSES = ["OPEN", "POSTED"] as const;
export type ReceiptBatchStatusValue = (typeof RECEIPT_BATCH_STATUSES)[number];
export const RECEIPT_BATCH_STATUS_LABELS: Record<ReceiptBatchStatusValue, string> = {
  OPEN: "Open", POSTED: "Posted",
};
export const AGING_BUCKETS = ["CURRENT", "D1_30", "D31_60", "D61_90", "D90_PLUS"] as const;
export type AgingBucketValue = (typeof AGING_BUCKETS)[number];
export const AGING_BUCKET_LABELS: Record<AgingBucketValue, string> = {
  CURRENT: "Current", D1_30: "1–30", D31_60: "31–60", D61_90: "61–90", D90_PLUS: "90+",
};

// The seven money columns of an aging row (the five buckets + Unapplied + Net). Kept here — a pure,
// client-safe constant — so the aging screen and its Excel export apply the SAME "hide all-zero
// rows" rule off one definition and can never drift.
export const AGING_MONEY_FIELDS = ["current", "d1_30", "d31_60", "d61_90", "d90_plus", "unapplied", "net"] as const;
export type AgingMoneyField = (typeof AGING_MONEY_FIELDS)[number];

/** True when every money column on an aging row is zero. `agingReport` can return such a row for a
 *  customer whose only A/R history postdates a past `asOf` (its customer-set query isn't itself
 *  date-filtered); it is hidden on screen and must be dropped from the export too, so the workbook
 *  matches exactly what the screen shows. */
export function isAgingRowAllZero(row: Record<AgingMoneyField, number>): boolean {
  return AGING_MONEY_FIELDS.every((k) => row[k] === 0);
}
