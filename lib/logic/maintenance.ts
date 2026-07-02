import type { Maintenance } from "@/lib/domain";

const DAY_MS = 86_400_000;

/** Survey is due on or before `asOf` — the boundary instant counts as due (Plan-7 isReviewDue semantics). */
export function isMaintenanceDue(task: Maintenance, asOf: string): boolean {
  return new Date(task.nextDueAt).getTime() <= new Date(asOf).getTime();
}

export function dueMaintenance(tasks: Maintenance[], asOf: string): Maintenance[] {
  return tasks.filter((t) => isMaintenanceDue(t, asOf)).sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt));
}

export function maintenanceForEquipment(tasks: Maintenance[], equipmentId: string): Maintenance[] {
  return tasks.filter((t) => t.equipmentId === equipmentId).sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt));
}

/** Mark-complete patch: completion day (midnight-UTC) becomes lastDoneAt; nextDueAt rolls forward by intervalDays. */
export function completePatch(task: Maintenance, atIso: string): { lastDoneAt: string; nextDueAt: string } {
  const d = new Date(atIso);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return {
    lastDoneAt: new Date(day).toISOString(),
    nextDueAt: new Date(day + task.intervalDays * DAY_MS).toISOString(),
  };
}
