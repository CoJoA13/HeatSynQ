import { describe, it, expect } from "vitest";
import {
  EQUIPMENT_KINDS, EQUIPMENT_STATES, EQUIPMENT_AVAILABILITY,
  equipmentKindMeta, equipmentStateMeta, equipmentAvailabilityMeta,
} from "@/lib/domain/enums";

describe("equipment vocab", () => {
  it("every kind has kind metadata", () => {
    for (const k of EQUIPMENT_KINDS) expect(equipmentKindMeta[k].label.length).toBeGreaterThan(0);
  });
  it("every display state has state metadata with a tone", () => {
    for (const s of EQUIPMENT_STATES) {
      expect(equipmentStateMeta[s].label.length).toBeGreaterThan(0);
      expect(equipmentStateMeta[s].tone).toBeTruthy();
    }
  });
  it("every availability has metadata with a tone", () => {
    for (const a of EQUIPMENT_AVAILABILITY) {
      expect(equipmentAvailabilityMeta[a].label.length).toBeGreaterThan(0);
      expect(equipmentAvailabilityMeta[a].tone).toBeTruthy();
    }
  });
});
