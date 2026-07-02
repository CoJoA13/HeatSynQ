import { describe, it, expect } from "vitest";
import {
  EQUIPMENT_AVAILABILITY, equipmentAvailabilityMeta,
  EQUIPMENT_STATES, equipmentStateMeta,
  MAINTENANCE_TYPES, maintenanceTypeMeta,
} from "@/lib/domain/enums";
import { equipmentSchema, maintenanceSchema } from "@/lib/domain";

const base = { id: "x", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", version: 0 };

describe("equipment availability vocab", () => {
  it("has the three availability values with metas", () => {
    expect([...EQUIPMENT_AVAILABILITY]).toEqual(["available", "down", "maintenance"]);
    expect(equipmentAvailabilityMeta.down).toEqual({ label: "Down", tone: "danger" });
    expect(equipmentAvailabilityMeta.maintenance).toEqual({ label: "Maintenance", tone: "warn" });
    expect(equipmentAvailabilityMeta.available.tone).toBe("neutral");
  });
  it("extends display states with down and maintenance", () => {
    expect([...EQUIPMENT_STATES]).toEqual(["running", "idle", "on_hold", "down", "maintenance"]);
    expect(equipmentStateMeta.down).toEqual({ label: "Down", tone: "danger" });
    expect(equipmentStateMeta.maintenance).toEqual({ label: "Maintenance", tone: "warn" });
  });
  it("has maintenance types with labels", () => {
    expect([...MAINTENANCE_TYPES]).toEqual(["tus", "sat"]);
    expect(maintenanceTypeMeta.tus.label).toBe("TUS");
    expect(maintenanceTypeMeta.sat.label).toBe("SAT");
  });
});

describe("equipmentSchema", () => {
  it("parses a valid unit and rejects a bad availability", () => {
    const ok = { ...base, id: "eq-iq-1", name: "Batch IQ #1", kind: "batch_iq", availability: "available", note: null };
    expect(() => equipmentSchema.parse(ok)).not.toThrow();
    expect(() => equipmentSchema.parse({ ...ok, availability: "broken" })).toThrow();
    expect(() => equipmentSchema.parse({ ...ok, kind: "smelter" })).toThrow();
  });
  it("accepts a note string when down", () => {
    const down = { ...base, id: "eq-temper-2", name: "Temper Oven #2", kind: "temper", availability: "down", note: "Control board fault" };
    expect(equipmentSchema.parse(down).note).toBe("Control board fault");
  });
});

describe("maintenanceSchema", () => {
  const ok = {
    ...base, id: "mnt-iq-1-tus", equipmentId: "eq-iq-1", type: "tus",
    specificationId: "spec-ams2750", intervalDays: 90,
    lastDoneAt: "2026-05-17T00:00:00.000Z", nextDueAt: "2026-08-15T00:00:00.000Z",
  };
  it("parses a valid row", () => { expect(() => maintenanceSchema.parse(ok)).not.toThrow(); });
  it("rejects a bad type and a non-positive interval", () => {
    expect(() => maintenanceSchema.parse({ ...ok, type: "oil_change" })).toThrow();
    expect(() => maintenanceSchema.parse({ ...ok, intervalDays: 0 })).toThrow();
    expect(() => maintenanceSchema.parse({ ...ok, intervalDays: 1.5 })).toThrow();
  });
});
