"use client";
import { use } from "react";
import { useCan } from "@/lib/auth/provider";
import {
  useEquipment, useEquipmentUnit, useWorkOrders, useCustomers, useMaintenance, useSpecifications,
  useSetEquipmentAvailability, useCompleteMaintenance,
} from "@/lib/query/hooks";
import { SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { EquipmentDetail } from "@/components/shop-floor/equipment-detail";
import { equipmentLoads } from "@/lib/logic/shop-floor";
import { maintenanceForEquipment } from "@/lib/logic/maintenance";
import { openOrders } from "@/lib/logic/dashboard";
import { DEMO_NOW } from "@/lib/clock";

export default function EquipmentDetailPage({ params }: { params: Promise<{ equipmentId: string }> }) {
  const { equipmentId } = use(params);
  const canMaintain = useCan("maintain_equipment");
  const unit = useEquipmentUnit(equipmentId);
  const equipment = useEquipment();
  const orders = useWorkOrders();
  const customers = useCustomers();
  const maintenance = useMaintenance();
  const specs = useSpecifications();
  const setAvailability = useSetEquipmentAvailability();
  const complete = useCompleteMaintenance();

  if (unit.isLoading) return <SkeletonRows />;
  if (unit.isError) return <ErrorPanel message="Failed to load equipment." onRetry={() => unit.refetch()} />;
  if (!unit.data) return <EmptyState title="Equipment not found" />;

  if (equipment.isLoading || orders.isLoading || customers.isLoading || maintenance.isLoading || specs.isLoading) return <SkeletonRows />;
  if (equipment.isError || orders.isError || customers.isError || maintenance.isError || specs.isError)
    return <ErrorPanel message="Failed to load equipment context." onRetry={() => { equipment.refetch(); orders.refetch(); customers.refetch(); maintenance.refetch(); specs.refetch(); }} />;

  // Project with the FULL roster (single-unit projection would mis-route heuristic matches), then pick this unit.
  const loads = equipmentLoads(openOrders(orders.data ?? []), equipment.data ?? [], DEMO_NOW);
  const entry = loads.find((l) => l.equipmentId === equipmentId) ?? { equipmentId, state: unit.data.availability === "available" ? "idle" as const : unit.data.availability, load: null, queued: 0 };
  const customerName = entry.load ? ((customers.data ?? []).find((c) => c.id === entry.load!.customerId)?.name ?? null) : null;
  const specCodeById = new Map((specs.data ?? []).map((s) => [s.id, s.code]));
  const busy = setAvailability.isPending || complete.isPending;

  return (
    <EquipmentDetail
      equipment={unit.data}
      entry={entry}
      customerName={customerName}
      tasks={maintenanceForEquipment(maintenance.data ?? [], equipmentId)}
      specCodeById={specCodeById}
      asOf={DEMO_NOW}
      canMaintain={canMaintain}
      busy={busy}
      onSetAvailability={(availability, note) => {
        if (unit.data) setAvailability.mutate({ equipment: unit.data, availability, note });
      }}
      onComplete={(task) => complete.mutate({ task, at: DEMO_NOW })}
    />
  );
}
