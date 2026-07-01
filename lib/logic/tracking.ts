import type { AreaId } from "@/lib/domain/enums";
import type { OrderStep } from "@/lib/domain";

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

type Op = { id: string; initials: string };

export function trackInStep(steps: OrderStep[], n: number, op: Op, at: string): OrderStep[] {
  return steps.map((s) =>
    s.n === n && s.state === "pending"
      ? { ...s, state: "in_process", trackedInAt: at, operatorId: op.id, operatorInitials: op.initials }
      : s,
  );
}

export function trackOutStep(steps: OrderStep[], n: number, op: Op, at: string, inspectResult?: "pass" | "fail"): OrderStep[] {
  return steps.map((s) => {
    if (s.n !== n || s.state === "done" || s.track === "none") return s;
    const state = inspectResult === "fail" ? "in_process" : "done";
    return { ...s, state, trackedOutAt: at, operatorId: op.id, operatorInitials: op.initials, inspectResult: inspectResult ?? s.inspectResult };
  });
}

export type StepAction = { label: string; action: "in" | "out"; inspectResult?: "pass" | "fail" };

export function stepActions(step: OrderStep): StepAction[] {
  if (step.state === "done" || step.track === "none") return [];
  if (step.track === "inspect") {
    return [{ label: "Pass", action: "out", inspectResult: "pass" }, { label: "Fail", action: "out", inspectResult: "fail" }];
  }
  if (step.track === "track_in_out") {
    return step.state === "in_process" ? [{ label: "Track Out", action: "out" }] : [{ label: "Track In", action: "in" }];
  }
  if (step.track === "track_in") return [{ label: "Track In", action: "out" }];
  return [{ label: "Track Out", action: "out" }]; // track_out
}

export function activeStep(steps: OrderStep[]): OrderStep | null {
  return steps.find((s) => s.track !== "none" && s.state !== "done") ?? null;
}
