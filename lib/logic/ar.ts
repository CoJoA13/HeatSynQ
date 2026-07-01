import type { Invoice } from "@/lib/domain";

export type Bucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";

const DAY = 86_400_000;

export function parseNetDays(terms: string, fallback = 30): number {
  const m = /(\d+)/.exec(terms);
  return m ? parseInt(m[1], 10) : fallback;
}

export function netDaysByCustomer(customers: { id: string; terms: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of customers) out[c.id] = parseNetDays(c.terms);
  return out;
}

/** End-of-day (23:59:59.999 UTC) of an ISO date; NaN if unparseable. */
export function endOfDayUtcMs(iso: string): number {
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return NaN;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999);
}

function dueMs(invoice: Invoice, netDays: number): number {
  const ref = invoice.invoicedDate ?? invoice.shippedDate;
  const t = new Date(ref).getTime();
  return Number.isNaN(t) ? NaN : t + netDays * DAY;
}

export function daysPastDue(invoice: Invoice, netDays: number, asOf: string): number {
  const due = dueMs(invoice, netDays);
  if (Number.isNaN(due)) return 0; // NaN-date guard: never treat as past due
  const diff = endOfDayUtcMs(asOf) - due;
  return diff <= 0 ? 0 : Math.floor(diff / DAY);
}

export function agingBucket(invoice: Invoice, netDays: number, asOf: string): Bucket {
  const d = daysPastDue(invoice, netDays, asOf);
  if (d <= 0) return "current";
  if (d <= 30) return "d1_30";
  if (d <= 60) return "d31_60";
  if (d <= 90) return "d61_90";
  return "d90_plus";
}

export function ageInvoices(
  invoices: Invoice[], netDaysByCustomerId: Record<string, number>, asOf: string,
): Record<Bucket, number> {
  const totals: Record<Bucket, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  for (const inv of invoices) {
    if (inv.status !== "sent") continue;
    const nd = netDaysByCustomerId[inv.customerId] ?? 30;
    totals[agingBucket(inv, nd, asOf)] += inv.amountCents;
  }
  return totals;
}

export function customerBalanceCents(invoices: Invoice[], customerId: string): number {
  return invoices.filter((i) => i.customerId === customerId && i.status === "sent")
    .reduce((s, i) => s + i.amountCents, 0);
}

export function customerAging(
  invoices: Invoice[], customerId: string, netDays: number, asOf: string,
): { balanceCents: number; currentCents: number; pastDueCents: number; oldestDaysPastDue: number } {
  const sent = invoices.filter((i) => i.customerId === customerId && i.status === "sent");
  let currentCents = 0, pastDueCents = 0, oldestDaysPastDue = 0;
  for (const inv of sent) {
    const d = daysPastDue(inv, netDays, asOf);
    if (d <= 0) currentCents += inv.amountCents;
    else { pastDueCents += inv.amountCents; oldestDaysPastDue = Math.max(oldestDaysPastDue, d); }
  }
  return { balanceCents: currentCents + pastDueCents, currentCents, pastDueCents, oldestDaysPastDue };
}
