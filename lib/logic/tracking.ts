import type { AreaId } from "@/lib/domain/enums";

/** Map a process-step op name to its shop area. Order matters: rack before wash. */
export function areaForOp(op: string): AreaId {
  const s = op.toLowerCase();
  if (/receiv/.test(s)) return "received";
  if (/rack/.test(s)) return "rack";
  if (/wash/.test(s)) return "wash";
  if (/inspect/.test(s)) return "final_inspect";
  if (/cert|ship/.test(s)) return "available_to_ship";
  return "in_process";
}
