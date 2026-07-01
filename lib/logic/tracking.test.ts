import { describe, it, expect } from "vitest";
import { areaForOp, trackInStep, trackOutStep, stepActions, activeStep } from "./tracking";
import type { OrderStep } from "@/lib/domain";

describe("areaForOp", () => {
  it("maps receiving, racking, wash, inspect, and ship ops", () => {
    expect(areaForOp("Receive & verify")).toBe("received");
    expect(areaForOp("Wash & rack")).toBe("rack");       // rack wins over wash
    expect(areaForOp("Final wash")).toBe("wash");
    expect(areaForOp("Final inspect")).toBe("final_inspect");
    expect(areaForOp("Certify & ship")).toBe("available_to_ship");
  });
  it("maps thermal ops to in_process (default)", () => {
    ["Carburize", "Temper", "Nitride", "Vacuum harden", "Anneal", "Carbonitride"].forEach((op) =>
      expect(areaForOp(op)).toBe("in_process"),
    );
  });
});

function step(partial: Partial<OrderStep> & Pick<OrderStep, "n" | "op" | "track">): OrderStep {
  return {
    equip: "", instr: "", params: [], areaId: "in_process", state: "pending",
    operatorId: null, operatorInitials: null, trackedInAt: null, trackedOutAt: null, inspectResult: null,
    ...partial,
  };
}
const op = { id: "op-dana", initials: "DM" };
const AT = "2026-07-01T00:00:00.000Z";

describe("trackInStep", () => {
  it("moves a pending track_in_out step to in_process with stamps", () => {
    const s = trackInStep([step({ n: 1, op: "Carburize", track: "track_in_out" })], 1, op, AT);
    expect(s[0].state).toBe("in_process");
    expect(s[0].trackedInAt).toBe(AT);
    expect(s[0].operatorInitials).toBe("DM");
  });
  it("moves a pending track_in step directly to done (single-scan completion)", () => {
    const s = trackInStep([step({ n: 1, op: "Receive & verify", track: "track_in" })], 1, op, AT);
    expect(s[0].state).toBe("done");
    expect(s[0].trackedInAt).toBe(AT);
    expect(s[0].operatorInitials).toBe("DM");
  });
  it("is a no-op on a non-pending step", () => {
    const s = trackInStep([step({ n: 1, op: "Carburize", track: "track_in_out", state: "done" })], 1, op, AT);
    expect(s[0].state).toBe("done");
  });
});

describe("trackOutStep", () => {
  it("completes an in_process step", () => {
    const s = trackOutStep([step({ n: 1, op: "Carburize", track: "track_in_out", state: "in_process" })], 1, op, AT);
    expect(s[0].state).toBe("done");
    expect(s[0].trackedOutAt).toBe(AT);
  });
  it("completes a single-scan (pending) step directly", () => {
    const s = trackOutStep([step({ n: 1, op: "Certify & ship", track: "track_out" })], 1, op, AT);
    expect(s[0].state).toBe("done");
  });
  it("records an inspect pass as done", () => {
    const s = trackOutStep([step({ n: 1, op: "Final inspect", track: "inspect" })], 1, op, AT, "pass");
    expect(s[0].state).toBe("done");
    expect(s[0].inspectResult).toBe("pass");
  });
  it("records an inspect fail without completing the step", () => {
    const s = trackOutStep([step({ n: 1, op: "Final inspect", track: "inspect" })], 1, op, AT, "fail");
    expect(s[0].state).toBe("in_process");
    expect(s[0].inspectResult).toBe("fail");
  });
});

describe("stepActions", () => {
  it("offers Track In then Track Out for a track_in_out step", () => {
    expect(stepActions(step({ n: 1, op: "Carburize", track: "track_in_out" }))).toEqual([{ label: "Track In", action: "in" }]);
    expect(stepActions(step({ n: 1, op: "Carburize", track: "track_in_out", state: "in_process" }))).toEqual([{ label: "Track Out", action: "out" }]);
  });
  it("offers a single scan for track_in and track_out", () => {
    expect(stepActions(step({ n: 1, op: "Receive & verify", track: "track_in" }))).toEqual([{ label: "Track In", action: "in" }]);
    expect(stepActions(step({ n: 1, op: "Certify & ship", track: "track_out" }))).toEqual([{ label: "Track Out", action: "out" }]);
  });
  it("offers Pass/Fail for an inspect step", () => {
    expect(stepActions(step({ n: 1, op: "Final inspect", track: "inspect" }))).toEqual([
      { label: "Pass", action: "out", inspectResult: "pass" },
      { label: "Fail", action: "out", inspectResult: "fail" },
    ]);
  });
  it("offers nothing for done or none steps", () => {
    expect(stepActions(step({ n: 1, op: "Carburize", track: "track_in_out", state: "done" }))).toEqual([]);
    expect(stepActions(step({ n: 1, op: "Hold", track: "none" }))).toEqual([]);
  });
});

describe("activeStep", () => {
  it("returns the first non-done trackable step", () => {
    const steps = [
      step({ n: 1, op: "Receive & verify", track: "track_in", state: "done" }),
      step({ n: 2, op: "Carburize", track: "track_in_out", state: "in_process" }),
      step({ n: 3, op: "Temper", track: "track_in_out" }),
    ];
    expect(activeStep(steps)?.n).toBe(2);
  });
  it("skips none steps and returns null when all trackable are done", () => {
    const steps = [
      step({ n: 1, op: "Carburize", track: "track_in_out", state: "done" }),
      step({ n: 2, op: "Note", track: "none" }),
    ];
    expect(activeStep(steps)).toBeNull();
  });
});

import { rollUpOrderStatus, orderProgressPct, boardAreaForOrder } from "./tracking";
import type { WorkOrder } from "@/lib/domain";

const trackable = (state: OrderStep["state"], n: number, op = "Carburize", track: OrderStep["track"] = "track_in_out") =>
  step({ n, op, track, state, areaId: areaForOpArea(op) });
function areaForOpArea(op: string) { return areaForOp(op); }

describe("rollUpOrderStatus", () => {
  it("moves received → in_process on the first scan", () => {
    const steps = [trackable("in_process", 1), trackable("pending", 2)];
    expect(rollUpOrderStatus(steps, "received")).toBe("in_process");
  });
  it("moves to ready_to_ship when all trackable steps are done", () => {
    const steps = [trackable("done", 1), trackable("done", 2)];
    expect(rollUpOrderStatus(steps, "in_process")).toBe("ready_to_ship");
  });
  it("ignores none steps in the all-done check", () => {
    const steps = [trackable("done", 1), step({ n: 2, op: "Note", track: "none" })];
    expect(rollUpOrderStatus(steps, "in_process")).toBe("ready_to_ship");
  });
  it("never overrides on_hold or shipped", () => {
    const steps = [trackable("done", 1)];
    expect(rollUpOrderStatus(steps, "on_hold")).toBe("on_hold");
    expect(rollUpOrderStatus(steps, "shipped")).toBe("shipped");
  });
  it("stays received when nothing has started", () => {
    expect(rollUpOrderStatus([trackable("pending", 1)], "received")).toBe("received");
  });
});

describe("orderProgressPct", () => {
  it("counts done trackable steps only", () => {
    const steps = [trackable("done", 1), trackable("in_process", 2), step({ n: 3, op: "Note", track: "none" })];
    expect(orderProgressPct(steps)).toBe(50); // 1 of 2 trackable
  });
  it("is 0 with no trackable steps", () => {
    expect(orderProgressPct([step({ n: 1, op: "Note", track: "none" })])).toBe(0);
  });
});

describe("boardAreaForOrder", () => {
  const base = { status: "in_process" } as WorkOrder;
  it("places a shipped order in the shipped column", () => {
    expect(boardAreaForOrder({ ...base, status: "shipped", steps: [] } as WorkOrder)).toBe("shipped");
  });
  it("places an all-done order in available_to_ship", () => {
    expect(boardAreaForOrder({ ...base, steps: [trackable("done", 1, "Carburize")] } as WorkOrder)).toBe("available_to_ship");
  });
  it("places an active order in its active step's area", () => {
    const steps = [trackable("done", 1, "Receive & verify", "track_in"), trackable("in_process", 2, "Carburize")];
    expect(boardAreaForOrder({ ...base, steps } as WorkOrder)).toBe("in_process");
  });
  it("places a not-started order in received", () => {
    expect(boardAreaForOrder({ ...base, status: "received", steps: [] } as WorkOrder)).toBe("received");
  });
});
