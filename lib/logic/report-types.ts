import type { Quote, WorkOrder, Invoice, Customer, Equipment } from "@/lib/domain";
import type { StatusTone } from "@/lib/domain/enums";
import type { KpiDescriptor } from "@/lib/logic/dashboard";

export const REPORT_KEYS = [
  "sales-by-customer", "sales-by-process", "sales-summary", "bookings-vs-shipments",
  "ar-aging", "customer-statements", "cash-receipts", "past-due-detail",
  "equipment-utilization", "on-time-delivery", "reject-report", "work-in-process",
  "quotes-dashboard", "win-loss", "quote-aging", "quoted-vs-won",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export type ReportCell =
  | { kind: "text"; value: string }
  | { kind: "mono"; value: string }
  | { kind: "date"; iso: string }
  | { kind: "money"; cents: number }
  | { kind: "pct"; value: string }
  | { kind: "pill"; label: string; tone: StatusTone }
  | { kind: "progress"; pct: number };

export const cell = {
  text: (value: string): ReportCell => ({ kind: "text", value }),
  mono: (value: string): ReportCell => ({ kind: "mono", value }),
  date: (iso: string): ReportCell => ({ kind: "date", iso }),
  money: (cents: number): ReportCell => ({ kind: "money", cents }),
  pct: (value: string): ReportCell => ({ kind: "pct", value }),
  pill: (label: string, tone: StatusTone): ReportCell => ({ kind: "pill", label, tone }),
  progress: (pct: number): ReportCell => ({ kind: "progress", pct }),
};

export type ReportTable = { columns: string[]; rows: ReportCell[][] };
export type ReportResult = { kpis: KpiDescriptor[]; table: ReportTable };
export type ReportData = {
  quotes: Quote[];
  orders: WorkOrder[];
  invoices: Invoice[];
  customers: Customer[];
  equipment: Equipment[];
};
export type ReportDef = {
  key: ReportKey;
  title: string;
  /** Honest-framing subtitle shown under the report title (only where the canon name promises more than the data holds). */
  framing?: string;
  /** EmptyState title when the table has no rows. */
  empty: string;
  build: (data: ReportData, asOf: string) => ReportResult;
};

const DAY_MS = 86_400_000;

function floorDayUtcMs(iso: string): number {
  const d = new Date(iso);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Whole UTC days from dateIso's calendar day to asOf's calendar day (same day → 0; future → 0). */
export function ageDays(dateIso: string, asOf: string): number {
  const diff = floorDayUtcMs(asOf) - floorDayUtcMs(dateIso);
  return diff <= 0 ? 0 : Math.floor(diff / DAY_MS);
}

/** num/den as a one-decimal percent string; "—" when den is 0. */
export function ratioPct(num: number, den: number): string {
  if (den === 0) return "—";
  return `${Math.round((num / den) * 1000) / 10}%`;
}
