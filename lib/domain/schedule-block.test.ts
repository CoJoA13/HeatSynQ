import { describe, it, expect } from "vitest";
import { scheduleBlockSchema, SCHEDULE_BLOCK_STATES } from "@/lib/domain";
import { canTransitionOrder } from "@/lib/logic/order";
import { can } from "@/lib/auth/permissions";

describe("ScheduleBlock schema", () => {
  it("parses a valid planned block", () => {
    const b = scheduleBlockSchema.parse({
      id: "sb-1", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", version: 0,
      workOrderId: "wo-48230", equipmentId: "eq-iq-2", day: "2026-07-01T00:00:00.000Z", state: "planned",
    });
    expect(b.state).toBe("planned");
  });
  it("rejects an unknown state", () => {
    expect(() => scheduleBlockSchema.parse({
      id: "sb-1", createdAt: "x", updatedAt: "x", version: 0,
      workOrderId: "wo-1", equipmentId: "eq-iq-1", day: "d", state: "bogus",
    })).toThrow();
  });
  it("exposes the two states", () => {
    expect(SCHEDULE_BLOCK_STATES).toEqual(["planned", "cancelled"]);
  });
});

describe("scheduled → received transition (unassign revert)", () => {
  it("allows scheduled → received", () => {
    expect(canTransitionOrder("scheduled", "received")).toBe(true);
  });
  it("keeps existing scheduled edges", () => {
    expect(canTransitionOrder("scheduled", "in_process")).toBe(true);
    expect(canTransitionOrder("scheduled", "on_hold")).toBe(true);
  });
});

describe("schedule_loads permission", () => {
  it("is granted to manager and office, not sales", () => {
    expect(can("manager", "schedule_loads")).toBe(true);
    expect(can("office", "schedule_loads")).toBe(true);
    expect(can("sales", "schedule_loads")).toBe(false);
  });
});
