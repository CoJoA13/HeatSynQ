// Pure constants only — no server-only imports. Safe to import from client components.
export const APPLICATION_TYPES = ["PAYMENT", "DISCOUNT", "WRITE_OFF", "CREDIT"] as const;
export type ApplicationTypeValue = (typeof APPLICATION_TYPES)[number];
export const APPLICATION_TYPE_LABELS: Record<ApplicationTypeValue, string> = {
  PAYMENT: "Payment", DISCOUNT: "Discount", WRITE_OFF: "Write-off", CREDIT: "Credit applied",
};
export const RECEIPT_BATCH_STATUSES = ["OPEN", "POSTED"] as const;
export type ReceiptBatchStatusValue = (typeof RECEIPT_BATCH_STATUSES)[number];
export const AGING_BUCKETS = ["CURRENT", "D1_30", "D31_60", "D61_90", "D90_PLUS"] as const;
export type AgingBucketValue = (typeof AGING_BUCKETS)[number];
export const AGING_BUCKET_LABELS: Record<AgingBucketValue, string> = {
  CURRENT: "Current", D1_30: "1–30", D31_60: "31–60", D61_90: "61–90", D90_PLUS: "90+",
};
