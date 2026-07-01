import { ListCard, MonoId, StatusPill } from "@/components/patterns";
import { quoteStatusMeta } from "@/lib/domain/enums";
import { quoteTotalCents } from "@/lib/logic/pricing";
import { formatMoney, formatDate } from "@/lib/utils";
import type { Quote, Customer } from "@/lib/domain";

export function QuotesList({ quotes, customers, onSelect }: {
  quotes: Quote[]; customers: Customer[]; onSelect?: (id: string) => void;
}) {
  const custById = new Map(customers.map((c) => [c.id, c]));
  return (
    <ListCard
      headers={["QUOTE", "CUSTOMER", "DATE", "PARTS", "TOTAL", "STATUS"]}
      onRowClick={onSelect ? (i) => onSelect(quotes[i].id) : undefined}
      rows={quotes.map((q) => {
        const meta = quoteStatusMeta[q.status];
        const label = q.rev > 0 ? `${q.number} · rev ${q.rev}` : q.number;
        return [
          <MonoId key="q">{label}</MonoId>,
          custById.get(q.customerId)?.name ?? "—",
          <span key="d" className="text-text-muted">{formatDate(q.date)}</span>,
          <span key="p" className="font-mono">{q.parts.length}</span>,
          <span key="t" className="font-mono">{formatMoney(quoteTotalCents(q))}</span>,
          <StatusPill key="s" tone={meta.tone}>{meta.label}</StatusPill>,
        ];
      })}
    />
  );
}
