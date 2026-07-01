import { EQUIPMENT, type EquipmentId, type EquipmentState } from "@/lib/domain/enums";
import { isLate } from "@/lib/logic/dashboard";
import type { WorkOrder, OrderStep } from "@/lib/domain";

/** Parse the first Fahrenheit setpoint from step params (e.g. "1700°F"). Whitespace-stripped. */
export function parseSetpoint(params: string[]): string | null {
  for (const p of params) {
    const m = p.match(/\d+(?:\.\d+)?\s*°?\s*F\b/i);
    if (m) return m[0].replace(/\s+/g, "");
  }
  return null;
}

/** Parse the first duration param (hr/h/min/m) to whole minutes; null when none. */
export function parseDurationMinutes(params: string[]): number | null {
  for (const p of params) {
    const m = p.match(/(\d+(?:\.\d+)?)\s*(hours|hour|hrs|hr|h|minutes|mins|min|m)\b/i);
    if (m) {
      const n = parseFloat(m[1]);
      const unit = m[2].toLowerCase();
      const isHour = unit === "h" || unit.startsWith("hr") || unit.startsWith("hour");
      return Math.round(isHour ? n * 60 : n);
    }
  }
  return null;
}

/** Resolve a step's free-text equip label to a roster equipment id. */
export function equipmentForStep(step: { equip: string; op: string }): EquipmentId {
  const raw = step.equip.trim().toLowerCase();
  const exact = EQUIPMENT.find((e) => e.name.toLowerCase() === raw);
  if (exact) return exact.id;
  const s = `${step.equip} ${step.op}`.toLowerCase();
  if (/vacuum/.test(s)) return "eq-vac-1";
  if (/belt|continuous|carbonitr/.test(s)) return "eq-belt-1";
  if (/\bpit\b|nitrid/.test(s)) return "eq-pit-1";
  if (/wash/.test(s)) return "eq-wash-1";
  if (/inspect|lab/.test(s)) return "eq-inspect-1";
  if (/temper/.test(s)) return "eq-temper-1";
  if (/iq|batch|carbur|harden|anneal/.test(s)) return "eq-iq-1";
  return "eq-iq-1";
}

export type EquipmentLoad = {
  equipmentId: EquipmentId;
  state: EquipmentState;
  load: {
    workOrderId: string;
    workOrderNumber: string;
    customerId: string;
    op: string;
    progressPct: number;
    operatorInitials: string | null;
    setpoint: string | null;
    estFinishIso: string | null;
    late: boolean;
    trackedInAt: string | null;
  } | null;
  queued: number;
};

type Candidate = { order: WorkOrder; step: OrderStep };

function byTrackedInThenNumber(a: Candidate, b: Candidate): number {
  const ta = a.step.trackedInAt, tb = b.step.trackedInAt;
  if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
  if (ta && !tb) return -1;
  if (!ta && tb) return 1;
  return a.order.number < b.order.number ? -1 : a.order.number > b.order.number ? 1 : 0;
}

/** Project open work orders onto the equipment roster. One entry per unit, in roster order. */
export function equipmentLoads(orders: WorkOrder[], asOf: string): EquipmentLoad[] {
  const byEquip = new Map<EquipmentId, Candidate[]>(EQUIPMENT.map((e) => [e.id, []]));
  for (const order of orders) {
    for (const s of order.steps) {
      if (s.state !== "in_process") continue;
      byEquip.get(equipmentForStep(s))!.push({ order, step: s });
    }
  }
  return EQUIPMENT.map((e): EquipmentLoad => {
    const cands = byEquip.get(e.id)!;
    if (cands.length === 0) return { equipmentId: e.id, state: "idle", load: null, queued: 0 };
    const cur = [...cands].sort(byTrackedInThenNumber)[0];
    const state: EquipmentState = cur.order.status === "on_hold" ? "on_hold" : "running";
    const mins = parseDurationMinutes(cur.step.params);
    const estFinishIso = state === "running" && cur.step.trackedInAt && mins != null
      ? new Date(new Date(cur.step.trackedInAt).getTime() + mins * 60_000).toISOString()
      : null;
    return {
      equipmentId: e.id, state, queued: cands.length - 1,
      load: {
        workOrderId: cur.order.id, workOrderNumber: cur.order.number, customerId: cur.order.customerId,
        op: cur.step.op, progressPct: cur.order.progressPct, operatorInitials: cur.step.operatorInitials,
        setpoint: parseSetpoint(cur.step.params), estFinishIso,
        late: isLate(cur.order, asOf), trackedInAt: cur.step.trackedInAt,
      },
    };
  });
}

export function shopFloorSummary(loads: EquipmentLoad[]): { running: number; idle: number; onHold: number; late: number } {
  return {
    running: loads.filter((l) => l.state === "running").length,
    idle: loads.filter((l) => l.state === "idle").length,
    onHold: loads.filter((l) => l.state === "on_hold").length,
    late: loads.filter((l) => l.load?.late).length,
  };
}
