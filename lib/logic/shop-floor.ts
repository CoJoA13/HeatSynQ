import { EQUIPMENT, type EquipmentId } from "@/lib/domain/enums";

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
