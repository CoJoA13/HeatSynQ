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
