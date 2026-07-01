export type StatusTone = "success" | "info" | "warn" | "danger" | "neutral";

export function toneClasses(tone: StatusTone): string {
  return `text-status-${tone} bg-status-${tone}-tint`;
}
