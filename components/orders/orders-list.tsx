import { ListCard, MonoId, StatusPill } from "@/components/patterns";
import { orderStatusMeta } from "@/lib/domain/enums";
import { formatMoney, formatDate } from "@/lib/utils";
import type { WorkOrder, Customer } from "@/lib/domain";

export function OrdersList({ orders, customers, onSelect }: {
  orders: WorkOrder[]; customers: Customer[]; onSelect?: (id: string) => void;
}) {
  const custById = new Map(customers.map((c) => [c.id, c]));
  return (
    <ListCard
      headers={["WORK ORDER", "CUSTOMER", "PROCESS", "DUE", "VALUE", "STATUS"]}
      onRowClick={onSelect ? (i) => onSelect(orders[i].id) : undefined}
      rows={orders.map((o) => {
        const meta = orderStatusMeta[o.status];
        return [
          <MonoId key="w">{o.number}</MonoId>,
          custById.get(o.customerId)?.name ?? "—",
          o.processSummary,
          <span key="d" className="text-text-muted">{formatDate(o.due)}</span>,
          <span key="v" className="font-mono">{formatMoney(o.orderValueCents)}</span>,
          <StatusPill key="s" tone={meta.tone}>{meta.label}</StatusPill>,
        ];
      })}
    />
  );
}
