"use client";
import * as React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/lib/ui/tabs";
import { ListCard, MonoId, StatusPill } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { invoiceStatusMeta } from "@/lib/domain/enums";
import { formatMoney, formatDate } from "@/lib/utils";
import type { Invoice, Customer, WorkOrder, InvoiceStatus } from "@/lib/domain";

export function InvoicingView({
  invoices,
  customers,
  orders,
  busy,
  onBill,
  onPay,
}: {
  invoices: Invoice[];
  customers: Customer[];
  orders: WorkOrder[];
  busy: boolean;
  onBill: (inv: Invoice) => void;
  onPay: (inv: Invoice) => void;
}) {
  const custById = new Map(customers.map((c) => [c.id, c]));
  const woById = new Map(orders.map((o) => [o.id, o]));
  const by = (s: InvoiceStatus) => invoices.filter((i) => i.status === s);
  const toBill = by("to_bill");
  const sent = by("sent");
  const paid = by("paid");

  function rows(
    list: Invoice[],
    action: (inv: Invoice) => React.ReactNode,
  ): React.ReactNode[][] {
    return list.map((i) => [
      <MonoId key="n">{i.number ?? "—"}</MonoId>,
      custById.get(i.customerId)?.name ?? "—",
      <MonoId key="w">{woById.get(i.workOrderId)?.number ?? "—"}</MonoId>,
      <span key="a" className="font-mono">
        {formatMoney(i.amountCents)}
      </span>,
      <StatusPill key="s" tone={invoiceStatusMeta[i.status].tone}>
        {invoiceStatusMeta[i.status].label}
      </StatusPill>,
      action(i),
    ]);
  }

  const headers = ["INVOICE", "CUSTOMER", "WORK ORDER", "AMOUNT", "STATUS", ""];

  return (
    <Tabs defaultValue="to_bill">
      <TabsList>
        <TabsTrigger value="to_bill">To-bill ({toBill.length})</TabsTrigger>
        <TabsTrigger value="sent">Sent ({sent.length})</TabsTrigger>
        <TabsTrigger value="paid">Paid ({paid.length})</TabsTrigger>
      </TabsList>
      <TabsContent value="to_bill">
        <ListCard
          headers={headers}
          rows={rows(toBill, (i) => (
            <Button
              key="b"
              size="sm"
              disabled={busy}
              onClick={() => onBill(i)}
            >
              Bill
            </Button>
          ))}
        />
      </TabsContent>
      <TabsContent value="sent">
        <ListCard
          headers={headers}
          rows={rows(sent, (i) => (
            <Button
              key="p"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onPay(i)}
            >
              Record payment
            </Button>
          ))}
        />
      </TabsContent>
      <TabsContent value="paid">
        <ListCard
          headers={[...headers.slice(0, 5), "PAID"]}
          rows={paid.map((i) => [
            <MonoId key="n">{i.number ?? "—"}</MonoId>,
            custById.get(i.customerId)?.name ?? "—",
            <MonoId key="w">{woById.get(i.workOrderId)?.number ?? "—"}</MonoId>,
            <span key="a" className="font-mono">
              {formatMoney(i.amountCents)}
            </span>,
            <StatusPill key="s" tone={invoiceStatusMeta[i.status].tone}>
              {invoiceStatusMeta[i.status].label}
            </StatusPill>,
            <span key="pd" className="font-mono text-text-muted">
              {i.paidDate ? formatDate(i.paidDate) : "—"}
            </span>,
          ])}
        />
      </TabsContent>
    </Tabs>
  );
}
