import { quoteStatusMeta } from "@/lib/domain/enums";
import { formatMoney } from "@/lib/utils";
import { awaitingApprovalCount, openQuoteValueCents, openQuotes, sameMonth } from "./dashboard";
import { quoteTotalCents } from "./pricing";
import { ageDays, cell, ratioPct, type ReportDef } from "./report-types";

export const quotesDashboard: ReportDef = {
  key: "quotes-dashboard",
  title: "Quotes Dashboard",
  empty: "No open quotes.",
  build(data) {
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const open = [...openQuotes(data.quotes)].sort((a, b) => b.date.localeCompare(a.date) || a.number.localeCompare(b.number));
    return {
      kpis: [
        { label: "Open quotes", value: String(open.length) },
        { label: "Open value", value: formatMoney(openQuoteValueCents(data.quotes)) },
        { label: "Awaiting approval", value: String(awaitingApprovalCount(data.quotes)), tone: "warn" },
      ],
      table: {
        columns: ["QUOTE", "CUSTOMER", "DATE", "VALID UNTIL", "VALUE", "STATUS"],
        rows: open.map((q) => {
          const meta = quoteStatusMeta[q.status];
          return [
            cell.mono(q.number),
            cell.text(nameById.get(q.customerId) ?? "—"),
            cell.date(q.date),
            cell.date(q.validUntil),
            cell.money(quoteTotalCents(q)),
            cell.pill(meta.label, meta.tone),
          ];
        }),
      },
    };
  },
};

export const winLoss: ReportDef = {
  key: "win-loss",
  title: "Win / Loss",
  empty: "No decided quotes yet.",
  build(data) {
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const decided = data.quotes
      .filter((q) => q.status === "won" || q.status === "lost")
      .sort((a, b) => b.date.localeCompare(a.date) || a.number.localeCompare(b.number));
    const won = decided.filter((q) => q.status === "won");
    return {
      kpis: [
        { label: "Won", value: String(won.length) },
        { label: "Lost", value: String(decided.length - won.length) },
        { label: "Win rate", value: ratioPct(won.length, decided.length) },
        { label: "Won value", value: formatMoney(won.reduce((s, q) => s + quoteTotalCents(q), 0)) },
      ],
      table: {
        columns: ["QUOTE", "CUSTOMER", "DATE", "VALUE", "STATUS"],
        rows: decided.map((q) => {
          const meta = quoteStatusMeta[q.status];
          return [
            cell.mono(q.number),
            cell.text(nameById.get(q.customerId) ?? "—"),
            cell.date(q.date),
            cell.money(quoteTotalCents(q)),
            cell.pill(meta.label, meta.tone),
          ];
        }),
      },
    };
  },
};

export const quoteAging: ReportDef = {
  key: "quote-aging",
  title: "Quote Aging",
  empty: "No open quotes.",
  build(data, asOf) {
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const open = openQuotes(data.quotes)
      .map((q) => ({ q, age: ageDays(q.date, asOf) }))
      .sort((a, b) => b.age - a.age || a.q.number.localeCompare(b.q.number));
    const avg = open.length ? Math.round(open.reduce((s, r) => s + r.age, 0) / open.length) : 0;
    return {
      kpis: [
        { label: "Open", value: String(open.length) },
        { label: "Avg age", value: open.length ? `${avg}d` : "—" },
        { label: "Oldest", value: open.length ? `${open[0].age}d` : "—" },
      ],
      table: {
        columns: ["QUOTE", "CUSTOMER", "STATUS", "DATE", "AGE", "VALUE"],
        rows: open.map(({ q, age }) => {
          const meta = quoteStatusMeta[q.status];
          return [
            cell.mono(q.number),
            cell.text(nameById.get(q.customerId) ?? "—"),
            cell.pill(meta.label, meta.tone),
            cell.date(q.date),
            cell.mono(`${age}d`),
            cell.money(quoteTotalCents(q)),
          ];
        }),
      },
    };
  },
};

export const quotedVsWon: ReportDef = {
  key: "quoted-vs-won",
  title: "Quoted vs. Won",
  empty: "No quotes issued this month.",
  build(data, asOf) {
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const byCustomer = new Map<string, { quoted: number; won: number }>();
    for (const q of data.quotes) {
      if (!sameMonth(q.date, asOf)) continue;
      const e = byCustomer.get(q.customerId) ?? { quoted: 0, won: 0 };
      const total = quoteTotalCents(q);
      e.quoted += total;
      if (q.status === "won") e.won += total;
      byCustomer.set(q.customerId, e);
    }
    const rows = [...byCustomer.entries()]
      .map(([id, e]) => ({ name: nameById.get(id) ?? "—", ...e }))
      .filter((r) => r.quoted > 0 || r.won > 0)
      .sort((a, b) => b.quoted - a.quoted || a.name.localeCompare(b.name));
    const quoted = rows.reduce((s, r) => s + r.quoted, 0);
    const won = rows.reduce((s, r) => s + r.won, 0);
    return {
      kpis: [
        { label: "Quoted MTD", value: formatMoney(quoted) },
        { label: "Won MTD", value: formatMoney(won) },
        { label: "Conversion", value: ratioPct(won, quoted) },
      ],
      table: {
        columns: ["CUSTOMER", "QUOTED", "WON"],
        rows: rows.map((r) => [cell.text(r.name), cell.money(r.quoted), cell.money(r.won)]),
      },
    };
  },
};
