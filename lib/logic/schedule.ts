import type { WorkOrder, ScheduleBlock, OrderStatus, ActivityEntry, Equipment } from "@/lib/domain";
import { activeStep } from "./tracking";
import { isLate } from "./dashboard";
import { activityEntry } from "./order";

const DAY_MS = 86_400_000;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export type WeekDay = { iso: string; label: string; weekdayShort: string };

export function weekDayLabel(dayIso: string): string {
  const d = new Date(dayIso);
  return `${WEEKDAY_SHORT[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

export function weekDays(asOf: string): WeekDay[] {
  const d = new Date(asOf);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = new Date(midnight).getUTCDay();     // 0=Sun..6=Sat
  const deltaToMonday = (dow + 6) % 7;            // Mon→0 … Sun→6 (Monday on or before)
  const monday = midnight - deltaToMonday * DAY_MS;
  return Array.from({ length: 5 }, (_, i) => {
    const iso = new Date(monday + i * DAY_MS).toISOString();
    return { iso, label: weekDayLabel(iso), weekdayShort: weekDayLabel(iso).split(" ")[0] };
  });
}

export function unscheduledOrders(orders: WorkOrder[], blocks: ScheduleBlock[]): WorkOrder[] {
  const plannedWo = new Set(blocks.filter((b) => b.state === "planned").map((b) => b.workOrderId));
  return orders
    .filter((o) => o.status === "received" && !plannedWo.has(o.id))
    .sort((a, b) => a.due.localeCompare(b.due));
}

export type ScheduleCell = {
  blockId: string;
  equipmentId: string;
  day: string;
  workOrderId: string;
  workOrderNumber: string;
  customerId: string;
  op: string | null;
  status: OrderStatus;
  progressPct: number;
  late: boolean;
  actionable: boolean;
};

export function scheduleCells(blocks: ScheduleBlock[], orders: WorkOrder[], asOf: string): ScheduleCell[] {
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const weekIsos = new Set(weekDays(asOf).map((w) => w.iso));
  const cells: ScheduleCell[] = [];
  for (const b of blocks) {
    if (b.state !== "planned") continue;
    if (!weekIsos.has(b.day)) continue;
    const order = orderById.get(b.workOrderId);
    if (!order || order.status === "shipped") continue;
    const step = activeStep(order.steps);
    cells.push({
      blockId: b.id, equipmentId: b.equipmentId, day: b.day,
      workOrderId: order.id, workOrderNumber: order.number, customerId: order.customerId,
      op: step?.op ?? null, status: order.status, progressPct: order.progressPct,
      late: isLate(order, asOf), actionable: order.status === "scheduled" || order.status === "received",
    });
  }
  return cells.sort((a, b) => a.workOrderNumber.localeCompare(b.workOrderNumber));
}

export function scheduleSummary(
  cells: ScheduleCell[], unscheduled: WorkOrder[],
): { scheduled: number; unscheduled: number; late: number } {
  return { scheduled: cells.length, unscheduled: unscheduled.length, late: cells.filter((c) => c.late).length };
}

export type AssignPatch = {
  workOrder: { status: OrderStatus; activity: ActivityEntry[] };
  block: { workOrderId: string; equipmentId: string; day: string; state: "planned" };
};
export function assignPatch(order: WorkOrder, equipment: Pick<Equipment, "id" | "name">, day: string, actor: string, at: string): AssignPatch {
  const message = `Scheduled — ${equipment.name} · ${weekDayLabel(day)}`;
  return {
    workOrder: { status: "scheduled", activity: [...order.activity, activityEntry(actor, message, at)] },
    block: { workOrderId: order.id, equipmentId: equipment.id, day, state: "planned" },
  };
}

export type UnschedulePatch = {
  block: { state: "cancelled" };
  workOrder: { status: OrderStatus; activity: ActivityEntry[] };
};
export function unschedulePatch(order: WorkOrder, actor: string, at: string): UnschedulePatch {
  return {
    block: { state: "cancelled" },
    workOrder: { status: "received", activity: [...order.activity, activityEntry(actor, "Unscheduled — returned to Received", at)] },
  };
}

export function movePatch(equipmentId: string, day: string): { equipmentId: string; day: string } {
  return { equipmentId, day };
}
