import type { Invoice } from "@/lib/domain";

export type Bucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";

const DAY = 86_400_000;

// Foundation heuristic: an unpaid invoice counts as "current" for its first week, then
// ages into 1–30 / 31–60 / 61–90 / 90+ by invoice age. This resolves a contradiction in
// the plan (its impl said `days <= 0`, its test asserts a 6-day invoice is "current").
// Plan 3 replaces this with proper Net-terms, due-date-based past-due aging.
const CURRENT_WINDOW_DAYS = 7;

export function agingBucket(invoice: Invoice, asOf: string): Bucket {
  const ref = invoice.invoicedDate ?? invoice.shippedDate;
  const days = Math.floor((new Date(asOf).getTime() - new Date(ref).getTime()) / DAY);
  if (days < CURRENT_WINDOW_DAYS) return "current";
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90_plus";
}

export function ageInvoices(invoices: Invoice[], asOf: string): Record<Bucket, number> {
  const totals: Record<Bucket, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  for (const inv of invoices) {
    if (inv.status !== "sent") continue;
    totals[agingBucket(inv, asOf)] += inv.amountCents;
  }
  return totals;
}

export function customerBalanceCents(invoices: Invoice[], customerId: string): number {
  return invoices.filter((i) => i.customerId === customerId && i.status === "sent")
    .reduce((s, i) => s + i.amountCents, 0);
}
