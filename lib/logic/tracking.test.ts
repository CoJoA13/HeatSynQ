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
  it("moves a pending step to in_process with stamps", () => {
    const s = trackInStep([step({ n: 1, op: "Carburize", track: "track_in_out" })], 1, op, AT);
    expect(s[0].state).toBe("in_process");
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
    expect(stepActions(step({ n: 1, op: "Receive & verify", track: "track_in" }))).toEqual([{ label: "Track In", action: "out" }]);
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
