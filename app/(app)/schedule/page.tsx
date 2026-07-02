"use client";
import { useAuth, useCan } from "@/lib/auth/provider";
import {
  useWorkOrders, useCustomers, useScheduleBlocks, useEquipment,
  useAssignSchedule, useMoveSchedule, useUnschedule,
} from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel } from "@/components/patterns";
import { ScheduleBoard } from "@/components/schedule/schedule-board";
import { DEMO_NOW } from "@/lib/clock";

export default function SchedulePage() {
  const { operator } = useAuth();
  const canSchedule = useCan("schedule_loads");
  const orders = useWorkOrders();
  const customers = useCustomers();
  const blocks = useScheduleBlocks();
  const equipment = useEquipment();
  const assign = useAssignSchedule();
  const move = useMoveSchedule();
  const unschedule = useUnschedule();

  if (orders.isLoading || customers.isLoading || blocks.isLoading || equipment.isLoading || !operator) return <SkeletonRows />;
  if (orders.isError) return <ErrorPanel message="Failed to load orders." onRetry={() => orders.refetch()} />;
  if (customers.isError) return <ErrorPanel message="Failed to load customers." onRetry={() => customers.refetch()} />;
  if (blocks.isError) return <ErrorPanel message="Failed to load schedule." onRetry={() => blocks.refetch()} />;
  if (equipment.isError) return <ErrorPanel message="Failed to load equipment." onRetry={() => equipment.refetch()} />;

  const asOf = DEMO_NOW;
  const busy = assign.isPending || move.isPending || unschedule.isPending;
  const orderList = orders.data ?? [];
  const blockList = blocks.data ?? [];
  const blockById = new Map(blockList.map((b) => [b.id, b]));

  return (
    <div>
      <PageHeader title="Schedule" subtitle="Weekly equipment load — assign orders to a furnace and day." />
      <ScheduleBoard
        orders={orderList}
        customers={customers.data ?? []}
        blocks={blockList}
        equipment={equipment.data ?? []}
        asOf={asOf}
        canSchedule={canSchedule}
        busy={busy}
        onAssign={(order, equip, day) => assign.mutate({ order, equipment: equip, day, operator, at: asOf })}
        onMove={(cell, equipmentId, day) => {
          const b = blockById.get(cell.blockId);
          if (b) move.mutate({ block: b, equipmentId, day });
        }}
        onUnassign={(cell) => {
          const b = blockById.get(cell.blockId);
          const order = orderList.find((o) => o.id === cell.workOrderId);
          if (b && order) unschedule.mutate({ order, block: b, operator, at: asOf });
        }}
      />
    </div>
  );
}
