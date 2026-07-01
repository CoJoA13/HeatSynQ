"use client";
import { useRouter } from "next/navigation";
import { useWorkOrders, useCustomers } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { OrdersList } from "@/components/orders/orders-list";

export default function OrdersPage() {
  const router = useRouter();
  const orders = useWorkOrders();
  const customers = useCustomers();
  return (
    <div>
      <PageHeader
        title="Orders"
        subtitle="Work orders in production, on hold, ready to ship and shipped."
      />
      {orders.isLoading ? <SkeletonRows />
        : orders.isError ? <ErrorPanel message="Failed to load orders." onRetry={() => orders.refetch()} />
        : !orders.data || orders.data.length === 0 ? <EmptyState title="No orders" />
        : <OrdersList orders={orders.data} customers={customers.data ?? []} onSelect={(id) => router.push(`/orders/${id}`)} />}
    </div>
  );
}
