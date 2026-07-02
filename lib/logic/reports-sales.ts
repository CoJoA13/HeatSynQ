import type { Invoice, Quote, WorkOrder } from "@/lib/domain";
import type { InvoiceStatus } from "@/lib/domain/enums";
import { formatMoney } from "@/lib/utils";
import { openOrders, openQuotes, sameMonth } from "./dashboard";
import { customerBalanceCents } from "./ar";
import { quoteTotalCents } from "./pricing";
import { cell, ratioPct, type ReportCell, type ReportDef } from "./report-types";

const quotesValue = (qs: Quote[]) => qs.reduce((s, q) => s + quoteTotalCents(q), 0);
const ordersValue = (os: WorkOrder[]) => os.reduce((s, o) => s + o.orderValueCents, 0);
const invoicesValue = (is: Invoice[]) => is.reduce((s, i) => s + i.amountCents, 0);

export const salesByCustomer: ReportDef = {
  key: "sales-by-customer",
  title: "Sales by Customer",
  empty: "No customer activity to report.",
  build(data) {
    const open = openOrders(data.orders);
    const rows = data.customers
      .map((c) => ({
        name: c.name,
        invoiced: invoicesValue(data.invoices.filter((i) => i.customerId === c.id && i.status !== "to_bill")),
        openValue: ordersValue(open.filter((o) => o.customerId === c.id)),
        openAr: customerBalanceCents(data.invoices, c.id),
        hasInvoice: data.invoices.some((i) => i.customerId === c.id),
      }))
      .filter((r) => r.hasInvoice || r.openValue > 0)
      .sort((a, b) => b.invoiced - a.invoiced || b.openValue - a.openValue || a.name.localeCompare(b.name));
    return {
      kpis: [
        { label: "Invoiced", value: formatMoney(rows.reduce((s, r) => s + r.invoiced, 0)) },
        { label: "Open order value", value: formatMoney(rows.reduce((s, r) => s + r.openValue, 0)) },
        { label: "Customers", value: String(rows.length) },
      ],
      table: {
        columns: ["CUSTOMER", "INVOICED", "OPEN ORDER VALUE", "OPEN A/R"],
        rows: rows.map((r) => [cell.text(r.name), cell.money(r.invoiced), cell.money(r.openValue), cell.money(r.openAr)]),
      },
    };
  },
};

export const salesByProcess: ReportDef = {
  key: "sales-by-process",
  title: "Sales by Process",
  empty: "No booked process lines to report.",
  build(data) {
    const byProcess = new Map<string, { booked: number; orders: Set<string> }>();
    for (const o of data.orders) {
      for (const line of o.pricing) {
        const entry = byProcess.get(line.process) ?? { booked: 0, orders: new Set<string>() };
        entry.booked += line.amountCents;
        entry.orders.add(o.id);
        byProcess.set(line.process, entry);
      }
    }
    const rows = [...byProcess.entries()]
      .map(([process, e]) => ({ process, booked: e.booked, orders: e.orders.size }))
      .sort((a, b) => b.booked - a.booked || a.process.localeCompare(b.process));
    return {
      kpis: [
        { label: "Booked", value: formatMoney(rows.reduce((s, r) => s + r.booked, 0)) },
        { label: "Processes", value: String(rows.length) },
      ],
      table: {
        columns: ["PROCESS", "BOOKED", "ORDERS"],
        rows: rows.map((r) => [cell.text(r.process), cell.money(r.booked), cell.mono(String(r.orders))]),
      },
    };
  },
};

export const salesSummary: ReportDef = {
  key: "sales-summary",
  title: "Sales Summary",
  empty: "Nothing to report.",
  build(data) {
    const openQ = openQuotes(data.quotes);
    const wonQ = data.quotes.filter((q) => q.status === "won");
    const lostQ = data.quotes.filter((q) => q.status === "lost");
    const openO = openOrders(data.orders);
    const shippedO = data.orders.filter((o) => o.status === "shipped");
    const inv = (status: InvoiceStatus) => data.invoices.filter((i) => i.status === status);
    const row = (doc: string, status: string, count: number, value: number): ReportCell[] =>
      [cell.text(doc), cell.text(status), cell.mono(String(count)), cell.money(value)];
    return {
      kpis: [
        { label: "Quoted (open)", value: formatMoney(quotesValue(openQ)) },
        { label: "Won", value: formatMoney(quotesValue(wonQ)) },
        { label: "Booked (open)", value: formatMoney(ordersValue(openO)) },
        { label: "Invoiced", value: formatMoney(invoicesValue(inv("sent")) + invoicesValue(inv("paid"))) },
        { label: "Collected", value: formatMoney(invoicesValue(inv("paid"))) },
      ],
      table: {
        columns: ["DOCUMENT", "STATUS", "COUNT", "VALUE"],
        rows: [
          row("Quotes", "Open", openQ.length, quotesValue(openQ)),
          row("Quotes", "Won", wonQ.length, quotesValue(wonQ)),
          row("Quotes", "Lost", lostQ.length, quotesValue(lostQ)),
          row("Work orders", "Open", openO.length, ordersValue(openO)),
          row("Work orders", "Shipped", shippedO.length, ordersValue(shippedO)),
          row("Invoices", "To bill", inv("to_bill").length, invoicesValue(inv("to_bill"))),
          row("Invoices", "Sent", inv("sent").length, invoicesValue(inv("sent"))),
          row("Invoices", "Paid", inv("paid").length, invoicesValue(inv("paid"))),
        ],
      },
    };
  },
};

export const bookingsVsShipments: ReportDef = {
  key: "bookings-vs-shipments",
  title: "Bookings vs. Shipments",
  empty: "No bookings or shipments this month.",
  build(data, asOf) {
    const booked = new Map<string, number>();
    const shipped = new Map<string, number>();
    for (const o of data.orders) {
      if (sameMonth(o.orderedDate, asOf)) booked.set(o.customerId, (booked.get(o.customerId) ?? 0) + o.orderValueCents);
    }
    for (const i of data.invoices) {
      if (sameMonth(i.shippedDate, asOf)) shipped.set(i.customerId, (shipped.get(i.customerId) ?? 0) + i.amountCents);
    }
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const rows = [...new Set([...booked.keys(), ...shipped.keys()])]
      .map((id) => ({ name: nameById.get(id) ?? "—", booked: booked.get(id) ?? 0, shipped: shipped.get(id) ?? 0 }))
      .sort((a, b) => b.booked - a.booked || a.name.localeCompare(b.name));
    const bookedTotal = rows.reduce((s, r) => s + r.booked, 0);
    const shippedTotal = rows.reduce((s, r) => s + r.shipped, 0);
    return {
      kpis: [
        { label: "Booked MTD", value: formatMoney(bookedTotal) },
        { label: "Shipped MTD", value: formatMoney(shippedTotal) },
        { label: "Book-to-ship", value: ratioPct(shippedTotal, bookedTotal) },
      ],
      table: {
        columns: ["CUSTOMER", "BOOKED", "SHIPPED"],
        rows: rows.map((r) => [cell.text(r.name), cell.money(r.booked), cell.money(r.shipped)]),
      },
    };
  },
};
