import type {
  WorkOrder, Quote, Invoice, Certification, RoleKey, QuoteStatus,
} from "@/lib/domain";
import type { StatusTone } from "@/lib/domain/enums";
import { quoteTotalCents } from "./pricing";
import { agingBucket } from "./ar";
import { formatMoney } from "@/lib/utils";

const OPEN_QUOTE_STATUSES: QuoteStatus[] = ["draft", "sent", "approve"];

// --- orders ---
export function openOrders(orders: WorkOrder[]): WorkOrder[] {
  return orders.filter((o) => o.status !== "shipped");
}
export function isLate(order: WorkOrder, asOf: string): boolean {
  return order.status !== "shipped" && new Date(order.due).getTime() < new Date(asOf).getTime();
}
export function lateOrders(orders: WorkOrder[], asOf: string): WorkOrder[] {
  return orders.filter((o) => isLate(o, asOf));
}
export function onSchedulePct(orders: WorkOrder[], asOf: string): number {
  const open = openOrders(orders);
  if (open.length === 0) return 100;
  const onTime = open.length - lateOrders(orders, asOf).length;
  return Math.round((onTime / open.length) * 1000) / 10;
}

// --- quotes ---
export function openQuotes(quotes: Quote[]): Quote[] {
  return quotes.filter((q) => OPEN_QUOTE_STATUSES.includes(q.status));
}
export function awaitingApprovalCount(quotes: Quote[]): number {
  return quotes.filter((q) => q.status === "approve").length;
}
export function openQuoteValueCents(quotes: Quote[]): number {
  return openQuotes(quotes).reduce((sum, q) => sum + quoteTotalCents(q), 0);
}
export function wonQuotesCount(quotes: Quote[]): number {
  return quotes.filter((q) => q.status === "won").length;
}

// --- certs ---
export function certsAwaitingRelease(certs: Certification[]): number {
  return certs.filter((c) => c.status === "pending").length;
}

// --- finance ---
export function openArCents(invoices: Invoice[]): number {
  return invoices.filter((i) => i.status === "sent").reduce((s, i) => s + i.amountCents, 0);
}
export function pastDueCents(invoices: Invoice[], asOf: string): number {
  return invoices
    .filter((i) => i.status === "sent" && agingBucket(i, asOf) !== "current")
    .reduce((s, i) => s + i.amountCents, 0);
}
export function toBillCount(invoices: Invoice[]): number {
  return invoices.filter((i) => i.status === "to_bill").length;
}
export function toBillCents(invoices: Invoice[]): number {
  return invoices.filter((i) => i.status === "to_bill").reduce((s, i) => s + i.amountCents, 0);
}
function sameMonth(iso: string, asOf: string): boolean {
  const a = new Date(iso), b = new Date(asOf);
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}
export function invoicedMtdCents(invoices: Invoice[], asOf: string): number {
  return invoices
    .filter((i) => i.invoicedDate != null && sameMonth(i.invoicedDate, asOf))
    .reduce((s, i) => s + i.amountCents, 0);
}

// --- assembly ---
export type KpiDescriptor = { label: string; value: string; sub?: string; tone?: StatusTone };
export type DashboardData = {
  orders: WorkOrder[]; quotes: Quote[]; invoices: Invoice[]; certifications: Certification[];
};

export function dashboardKpis(role: RoleKey, data: DashboardData, asOf: string): KpiDescriptor[] {
  const { orders, quotes, invoices, certifications } = data;
  if (role === "sales") {
    return [
      { label: "Open Quotes", value: String(openQuotes(quotes).length) },
      { label: "Awaiting Approval", value: String(awaitingApprovalCount(quotes)), tone: "warn" },
      { label: "Open Quote Value", value: formatMoney(openQuoteValueCents(quotes)) },
      { label: "Won Quotes", value: String(wonQuotesCount(quotes)) },
    ];
  }
  if (role === "office") {
    return [
      { label: "Open A/R", value: formatMoney(openArCents(invoices)) },
      { label: "Past Due", value: formatMoney(pastDueCents(invoices, asOf)), tone: "danger" },
      { label: "To-bill", value: String(toBillCount(invoices)), sub: formatMoney(toBillCents(invoices)) },
      { label: "Invoiced MTD", value: formatMoney(invoicedMtdCents(invoices, asOf)) },
    ];
  }
  // manager (default)
  const late = lateOrders(orders, asOf).length;
  return [
    { label: "Open Orders", value: String(openOrders(orders).length), sub: `${late} late` },
    { label: "Late Orders", value: String(late), tone: "danger" },
    { label: "On-Time %", value: String(onSchedulePct(orders, asOf)), sub: "of open orders" },
    { label: "Certs Awaiting Release", value: String(certsAwaitingRelease(certifications)), sub: "blocking ship" },
    { label: "Open A/R", value: formatMoney(openArCents(invoices)) },
    { label: "Invoiced MTD", value: formatMoney(invoicedMtdCents(invoices, asOf)) },
  ];
}

export function navBadgeCounts(
  quotes: Quote[], orders: WorkOrder[], certs: Certification[],
): Record<string, number> {
  return {
    quotes: openQuotes(quotes).length,
    orders: openOrders(orders).length,
    certifications: certsAwaitingRelease(certs),
  };
}
