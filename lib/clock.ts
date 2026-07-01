/**
 * The demo's canonical "now" — a frozen instant so date-derived views (the
 * Schedule week window) are deterministic and independent of the machine's
 * wall clock. The mock data layer's `NOW` re-points at this constant so there
 * is a single source of truth for "the present" across data + UI.
 */
export const DEMO_NOW = "2026-06-30T12:00:00.000Z";

export function nowIso(): string {
  return DEMO_NOW;
}
