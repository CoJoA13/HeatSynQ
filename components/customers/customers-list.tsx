import { ListCard, MonoId, StatusPill } from "@/components/patterns";
import { customerStatusMeta } from "@/lib/domain/enums";
import { customerBalanceCents } from "@/lib/logic/ar";
import { formatMoney } from "@/lib/utils";
import type { Customer, WorkOrder, Invoice } from "@/lib/domain";

export function CustomersList({
  customers,
  workOrders,
  invoices,
  onSelect,
}: {
  customers: Customer[];
  workOrders: WorkOrder[];
  invoices: Invoice[];
  onSelect?: (id: string) => void;
}) {
  return (
    <ListCard
      headers={["CUSTOMER", "#", "CITY", "TERMS", "OPEN ORDERS", "A/R BALANCE", "STATUS"]}
      onRowClick={onSelect ? (i) => onSelect(customers[i].id) : undefined}
      rows={customers.map((c) => {
        const meta = customerStatusMeta[c.status];
        const open = workOrders.filter((w) => w.customerId === c.id && w.status !== "shipped").length;
        const balance = customerBalanceCents(invoices, c.id);
        return [
          c.name,
          <MonoId key="num">{c.customerNumber}</MonoId>,
          c.city || "—",
          c.terms,
          <span key="open" className="font-mono">{open}</span>,
          <span key="bal" className="font-mono">{formatMoney(balance)}</span>,
          <StatusPill key="status" tone={meta.tone}>{meta.label}</StatusPill>,
        ];
      })}
    />
  );
}
