import type { Invoice } from "@/lib/domain";
import type { StatusTone } from "@/lib/domain/enums";
import { formatMoney } from "@/lib/utils";
import { ageInvoices, agingBucket, daysPastDue, netDaysByCustomer, type Bucket } from "./ar";
import { sameMonth } from "./dashboard";
import { cell, type ReportDef } from "./report-types";

const DAY_MS = 86_400_000;

const BUCKET_LABEL: Record<Bucket, string> = {
  current: "Current", d1_30: "1–30 days", d31_60: "31–60 days", d61_90: "61–90 days", d90_plus: "90+ days",
};
const BUCKET_TONE: Record<Bucket, StatusTone> = {
  current: "neutral", d1_30: "warn", d31_60: "warn", d61_90: "danger", d90_plus: "danger",
};

function dueDateIso(inv: Invoice, netDays: number): string {
  const ref = inv.invoicedDate ?? inv.shippedDate;
  return new Date(new Date(ref).getTime() + netDays * DAY_MS).toISOString();
}

export const arAging: ReportDef = {
  key: "ar-aging",
  title: "A/R Aging",
  empty: "No open invoices.",
  build(data, asOf) {
    const nd = netDaysByCustomer(data.customers);
    const buckets = ageInvoices(data.invoices, nd, asOf);
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const rows = data.invoices
      .filter((i) => i.status === "sent")
      .sort((a, b) => (a.invoicedDate ?? a.shippedDate).localeCompare(b.invoicedDate ?? b.shippedDate))
      .map((i) => {
        const bucket = agingBucket(i, nd[i.customerId] ?? 30, asOf);
        return [
          cell.mono(i.number ?? "—"),
          cell.text(nameById.get(i.customerId) ?? "—"),
          cell.money(i.amountCents),
          cell.date(i.invoicedDate ?? i.shippedDate),
          cell.pill(BUCKET_LABEL[bucket], BUCKET_TONE[bucket]),
        ];
      });
    return {
      kpis: [
        { label: "Current", value: formatMoney(buckets.current) },
        { label: "1–30 days", value: formatMoney(buckets.d1_30) },
        { label: "31–60 days", value: formatMoney(buckets.d31_60) },
        { label: "61–90 days", value: formatMoney(buckets.d61_90), tone: buckets.d61_90 > 0 ? "danger" : undefined },
        { label: "90+ days", value: formatMoney(buckets.d90_plus), tone: buckets.d90_plus > 0 ? "danger" : undefined },
      ],
      table: { columns: ["INVOICE", "CUSTOMER", "AMOUNT", "INVOICED", "BUCKET"], rows },
    };
  },
};

export const customerStatements: ReportDef = {
  key: "customer-statements",
  title: "Customer Statements",
  empty: "No customers with open items.",
  build(data) {
    const rows = data.customers
      .map((c) => {
        const sent = data.invoices.filter((i) => i.customerId === c.id && i.status === "sent");
        const unbilled = data.invoices.filter((i) => i.customerId === c.id && i.status === "to_bill");
        return {
          name: c.name,
          terms: c.terms,
          openCount: sent.length,
          balance: sent.reduce((s, i) => s + i.amountCents, 0),
          unbilled: unbilled.reduce((s, i) => s + i.amountCents, 0),
        };
      })
      .filter((r) => r.openCount > 0 || r.unbilled > 0)
      .sort((a, b) => b.balance - a.balance || b.unbilled - a.unbilled || a.name.localeCompare(b.name));
    return {
      kpis: [
        { label: "Open balance", value: formatMoney(rows.reduce((s, r) => s + r.balance, 0)) },
        { label: "Unbilled", value: formatMoney(rows.reduce((s, r) => s + r.unbilled, 0)) },
        { label: "Customers", value: String(rows.length) },
      ],
      table: {
        columns: ["CUSTOMER", "OPEN INVOICES", "BALANCE", "UNBILLED", "TERMS"],
        rows: rows.map((r) => [
          cell.text(r.name), cell.mono(String(r.openCount)), cell.money(r.balance), cell.money(r.unbilled), cell.text(r.terms),
        ]),
      },
    };
  },
};

export const cashReceipts: ReportDef = {
  key: "cash-receipts",
  title: "Cash Receipts",
  empty: "No payments recorded.",
  build(data, asOf) {
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const paid = data.invoices.filter((i): i is Invoice & { paidDate: string } => i.status === "paid" && i.paidDate != null);
    const rows = [...paid].sort((a, b) => b.paidDate.localeCompare(a.paidDate));
    const mtd = paid.filter((i) => sameMonth(i.paidDate, asOf)).reduce((s, i) => s + i.amountCents, 0);
    return {
      kpis: [
        { label: "Receipts MTD", value: formatMoney(mtd) },
        { label: "Receipts", value: String(paid.length) },
      ],
      table: {
        columns: ["INVOICE", "CUSTOMER", "AMOUNT", "PAID"],
        rows: rows.map((i) => [
          cell.mono(i.number ?? "—"), cell.text(nameById.get(i.customerId) ?? "—"), cell.money(i.amountCents), cell.date(i.paidDate),
        ]),
      },
    };
  },
};

export const pastDueDetail: ReportDef = {
  key: "past-due-detail",
  title: "Past-Due Detail",
  empty: "Nothing past due.",
  build(data, asOf) {
    const nd = netDaysByCustomer(data.customers);
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const rows = data.invoices
      .filter((i) => i.status === "sent")
      .map((i) => ({ inv: i, netDays: nd[i.customerId] ?? 30, days: daysPastDue(i, nd[i.customerId] ?? 30, asOf) }))
      .filter((r) => r.days > 0)
      .sort((a, b) => b.days - a.days);
    const total = rows.reduce((s, r) => s + r.inv.amountCents, 0);
    return {
      kpis: [
        { label: "Past due", value: formatMoney(total), tone: total > 0 ? "danger" : undefined },
        { label: "Invoices", value: String(rows.length) },
        { label: "Oldest", value: rows.length ? `${rows[0].days}d` : "—" },
      ],
      table: {
        columns: ["INVOICE", "CUSTOMER", "AMOUNT", "DUE", "DAYS PAST DUE"],
        rows: rows.map(({ inv, netDays, days }) => [
          cell.mono(inv.number ?? "—"),
          cell.text(nameById.get(inv.customerId) ?? "—"),
          cell.money(inv.amountCents),
          cell.date(dueDateIso(inv, netDays)),
          cell.mono(`${days}d`),
        ]),
      },
    };
  },
};
