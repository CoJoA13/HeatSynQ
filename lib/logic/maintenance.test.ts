import { describe, it, expect } from "vitest";
import { isMaintenanceDue, dueMaintenance, maintenanceForEquipment, completePatch } from "./maintenance";
import type { Maintenance } from "@/lib/domain";

function task(p: Partial<Maintenance> & Pick<Maintenance, "id" | "nextDueAt">): Maintenance {
  return {
    createdAt: "", updatedAt: "", version: 0, equipmentId: "eq-iq-1", type: "tus",
    specificationId: "spec-ams2750", intervalDays: 90, lastDoneAt: "2026-03-01T00:00:00.000Z", ...p,
  };
}

describe("isMaintenanceDue", () => {
  const t = task({ id: "m1", nextDueAt: "2026-06-30T00:00:00.000Z" });
  it("is due before and exactly on the boundary instant", () => {
    expect(isMaintenanceDue(t, "2026-06-30T00:00:00.000Z")).toBe(true);  // boundary counts
    expect(isMaintenanceDue(t, "2026-06-30T12:00:00.000Z")).toBe(true);
    expect(isMaintenanceDue(t, "2026-07-01T00:00:00.000Z")).toBe(true);
  });
  it("is not due when nextDueAt is in the future", () => {
    expect(isMaintenanceDue(t, "2026-06-29T23:59:59.000Z")).toBe(false);
  });
});

describe("dueMaintenance", () => {
  it("filters to due rows sorted by nextDueAt ascending", () => {
    const a = task({ id: "a", nextDueAt: "2026-06-25T00:00:00.000Z" });
    const b = task({ id: "b", nextDueAt: "2026-06-30T00:00:00.000Z" });
    const c = task({ id: "c", nextDueAt: "2026-08-01T00:00:00.000Z" });
    expect(dueMaintenance([c, b, a], "2026-06-30T12:00:00.000Z").map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("maintenanceForEquipment", () => {
  it("filters by equipment and sorts by nextDueAt", () => {
    const a = task({ id: "a", equipmentId: "eq-vac-1", nextDueAt: "2026-08-25T00:00:00.000Z" });
    const b = task({ id: "b", equipmentId: "eq-vac-1", nextDueAt: "2026-06-30T00:00:00.000Z" });
    const other = task({ id: "x", equipmentId: "eq-iq-1", nextDueAt: "2026-01-01T00:00:00.000Z" });
    expect(maintenanceForEquipment([a, other, b], "eq-vac-1").map((m) => m.id)).toEqual(["b", "a"]);
  });
});

describe("completePatch", () => {
  it("floors the completion instant to midnight-UTC and rolls nextDueAt forward by intervalDays", () => {
    const t = task({ id: "m", intervalDays: 30, nextDueAt: "2026-06-30T00:00:00.000Z" });
    expect(completePatch(t, "2026-06-30T12:00:00.000Z")).toEqual({
      lastDoneAt: "2026-06-30T00:00:00.000Z",
      nextDueAt: "2026-07-30T00:00:00.000Z",
    });
  });
  it("crosses month/year boundaries in UTC", () => {
    const t = task({ id: "m", intervalDays: 90, nextDueAt: "x" });
    expect(completePatch(t, "2026-12-15T08:30:00.000Z")).toEqual({
      lastDoneAt: "2026-12-15T00:00:00.000Z",
      nextDueAt: "2027-03-15T00:00:00.000Z",
    });
  });
});
