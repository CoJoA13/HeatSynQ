"use client";
import { useRouter } from "next/navigation";
import { useWorkOrders, useCustomers, useEquipment, useMaintenance } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel } from "@/components/patterns";
import { ShopFloorGrid } from "@/components/shop-floor/shop-floor-grid";
import { openOrders } from "@/lib/logic/dashboard";
import { DEMO_NOW } from "@/lib/clock";

export default function ShopFloorPage() {
  const router = useRouter();
  const orders = useWorkOrders();
  const customers = useCustomers();
  const equipment = useEquipment();
  const maintenance = useMaintenance();

  if (orders.isLoading || customers.isLoading || equipment.isLoading || maintenance.isLoading) return <SkeletonRows />;
  if (orders.isError) return <ErrorPanel message="Failed to load orders." onRetry={() => orders.refetch()} />;
  if (customers.isError) return <ErrorPanel message="Failed to load customers." onRetry={() => customers.refetch()} />;
  if (equipment.isError) return <ErrorPanel message="Failed to load equipment." onRetry={() => equipment.refetch()} />;
  if (maintenance.isError) return <ErrorPanel message="Failed to load maintenance." onRetry={() => maintenance.refetch()} />;

  return (
    <div>
      <PageHeader title="Shop Floor" subtitle="Live furnace & oven status — derived from orders in process." />
      <ShopFloorGrid
        orders={openOrders(orders.data ?? [])}
        customers={customers.data ?? []}
        equipment={equipment.data ?? []}
        maintenance={maintenance.data ?? []}
        asOf={DEMO_NOW}
        onSelect={(id) => router.push(`/shop-floor/${id}`)}
      />
    </div>
  );
}
