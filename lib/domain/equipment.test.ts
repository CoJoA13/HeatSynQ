import { describe, it, expect } from "vitest";
import {
  EQUIPMENT, EQUIPMENT_KINDS, EQUIPMENT_STATES,
  equipmentKindMeta, equipmentStateMeta,
} from "@/lib/domain/enums";

describe("equipment config", () => {
  it("has a non-empty roster with unique ids and names", () => {
    expect(EQUIPMENT.length).toBeGreaterThan(0);
    const ids = EQUIPMENT.map((e) => e.id);
    const names = EQUIPMENT.map((e) => e.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every roster kind has kind metadata", () => {
    for (const e of EQUIPMENT) {
      expect(EQUIPMENT_KINDS).toContain(e.kind);
      expect(equipmentKindMeta[e.kind].label.length).toBeGreaterThan(0);
    }
  });

  it("every state has state metadata with a tone", () => {
    for (const s of EQUIPMENT_STATES) {
      expect(equipmentStateMeta[s].label.length).toBeGreaterThan(0);
      expect(equipmentStateMeta[s].tone).toBeTruthy();
    }
  });

  it("includes the furnace kinds the shop runs", () => {
    const kinds = new Set(EQUIPMENT.map((e) => e.kind));
    expect(kinds.has("batch_iq")).toBe(true);
    expect(kinds.has("temper")).toBe(true);
    expect(kinds.has("wash")).toBe(true);
    expect(kinds.has("inspect")).toBe(true);
  });
});
