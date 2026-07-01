"use client";
import { useRouter } from "next/navigation";
import { useWorkOrders, useCustomers } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel } from "@/components/patterns";
import { ShopFloorGrid } from "@/components/shop-floor/shop-floor-grid";
import { openOrders } from "@/lib/logic/dashboard";

export default function ShopFloorPage() {
  const router = useRouter();
  const orders = useWorkOrders();
  const customers = useCustomers();

  if (orders.isLoading || customers.isLoading) return <SkeletonRows />;
  if (orders.isError) return <ErrorPanel message="Failed to load orders." onRetry={() => orders.refetch()} />;
  if (customers.isError) return <ErrorPanel message="Failed to load customers." onRetry={() => customers.refetch()} />;

  const now = new Date().toISOString();
  return (
    <div>
      <PageHeader title="Shop Floor" subtitle="Live furnace & oven status — derived from orders in process." />
      <ShopFloorGrid
        orders={openOrders(orders.data ?? [])}
        customers={customers.data ?? []}
        asOf={now}
        onSelect={(id) => router.push(`/orders/${id}`)}
      />
    </div>
  );
}
