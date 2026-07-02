import type { ReportDef, ReportKey } from "./report-types";
import { salesByCustomer, salesByProcess, salesSummary, bookingsVsShipments } from "./reports-sales";
import { arAging, customerStatements, cashReceipts, pastDueDetail } from "./reports-ar";
import { equipmentUtilization, onTimeDelivery, rejectReport, workInProcess } from "./reports-production";
import { quotesDashboard, winLoss, quoteAging, quotedVsWon } from "./reports-quotes";

export type ReportGroup = { key: string; icon: string; title: string; reports: ReportKey[] };

/** Prototype canon: Visual Shop.dc.html lines 1095-1100 — groups, icons, titles, and item order. */
export const REPORT_GROUPS: ReportGroup[] = [
  { key: "sales", icon: "☷", title: "Sales", reports: ["sales-by-customer", "sales-by-process", "sales-summary", "bookings-vs-shipments"] },
  { key: "ar", icon: "$", title: "Accounts Receivable", reports: ["ar-aging", "customer-statements", "cash-receipts", "past-due-detail"] },
  { key: "production", icon: "◉", title: "Production & Tracking", reports: ["equipment-utilization", "on-time-delivery", "reject-report", "work-in-process"] },
  { key: "quotes", icon: "☷", title: "Quotes", reports: ["quotes-dashboard", "win-loss", "quote-aging", "quoted-vs-won"] },
];

export const REPORTS: Record<ReportKey, ReportDef> = {
  "sales-by-customer": salesByCustomer,
  "sales-by-process": salesByProcess,
  "sales-summary": salesSummary,
  "bookings-vs-shipments": bookingsVsShipments,
  "ar-aging": arAging,
  "customer-statements": customerStatements,
  "cash-receipts": cashReceipts,
  "past-due-detail": pastDueDetail,
  "equipment-utilization": equipmentUtilization,
  "on-time-delivery": onTimeDelivery,
  "reject-report": rejectReport,
  "work-in-process": workInProcess,
  "quotes-dashboard": quotesDashboard,
  "win-loss": winLoss,
  "quote-aging": quoteAging,
  "quoted-vs-won": quotedVsWon,
};

export function reportByKey(key: string): ReportDef | null {
  return (REPORTS as Record<string, ReportDef | undefined>)[key] ?? null;
}

export * from "./report-types";
