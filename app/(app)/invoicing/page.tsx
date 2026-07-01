"use client";
import {
  useInvoices,
  useCustomers,
  useWorkOrders,
  useBillInvoice,
  usePayInvoice,
} from "@/lib/query/hooks";
import {
  PageHeader,
  SkeletonRows,
  ErrorPanel,
  EmptyState,
} from "@/components/patterns";
import { InvoicingView } from "@/components/invoicing/invoicing-view";

export default function InvoicingPage() {
  const invoices = useInvoices();
  const customers = useCustomers();
  const orders = useWorkOrders();
  const bill = useBillInvoice();
  const pay = usePayInvoice();
  const now = () => new Date().toISOString();

  if (invoices.isLoading) return <SkeletonRows />;
  if (invoices.isError)
    return (
      <ErrorPanel
        message="Failed to load invoices."
        onRetry={() => invoices.refetch()}
      />
    );
  const data = invoices.data ?? [];

  return (
    <div>
      <PageHeader
        title="Invoicing"
        subtitle="Shipped work to bill, invoices sent, and payments recorded."
      />
      {data.length === 0 ? (
        <EmptyState title="No invoices" />
      ) : (
        <InvoicingView
          invoices={data}
          customers={customers.data ?? []}
          orders={orders.data ?? []}
          busy={bill.isPending || pay.isPending}
          onBill={(inv) => bill.mutate({ invoice: inv, at: now() })}
          onPay={(inv) => pay.mutate({ invoice: inv, at: now() })}
        />
      )}
    </div>
  );
}
