import { describe, it, expect } from "vitest";
import { parseSetpoint, parseDurationMinutes, equipmentForStep } from "./shop-floor";

describe("parseSetpoint", () => {
  it("returns the first Fahrenheit setpoint", () => {
    expect(parseSetpoint(["1700°F", "8.0 hr", "0.90% C", "Oil quench"])).toBe("1700°F");
    expect(parseSetpoint(["350°F", "2.0 hr"])).toBe("350°F");
  });
  it("returns null when no temperature is present", () => {
    expect(parseSetpoint([])).toBeNull();
    expect(parseSetpoint(["Oil quench", "Furnace cool"])).toBeNull();
  });
});

describe("parseDurationMinutes", () => {
  it("parses hours to minutes", () => {
    expect(parseDurationMinutes(["1700°F", "8.0 hr"])).toBe(480);
    expect(parseDurationMinutes(["400°F", "2.0 hr"])).toBe(120);
  });
  it("parses minutes", () => {
    expect(parseDurationMinutes(["90 min"])).toBe(90);
  });
  it("returns null when no duration is present", () => {
    expect(parseDurationMinutes(["975°F", "Gas quench"])).toBeNull();
    expect(parseDurationMinutes([])).toBeNull();
  });
});

describe("equipmentForStep", () => {
  it("matches an exact roster name (case-insensitive)", () => {
    expect(equipmentForStep({ equip: "Batch IQ #3", op: "Carburize" })).toBe("eq-iq-3");
    expect(equipmentForStep({ equip: "Pit Furnace #1", op: "Nitride" })).toBe("eq-pit-1");
    expect(equipmentForStep({ equip: "wash station", op: "Wash & rack" })).toBe("eq-wash-1");
    expect(equipmentForStep({ equip: "Inspection", op: "Final inspect" })).toBe("eq-inspect-1");
  });

  it("falls back to a kind default via keyword when the name is not in the roster", () => {
    expect(equipmentForStep({ equip: "Temper Oven #4", op: "Temper" })).toBe("eq-temper-1");
    expect(equipmentForStep({ equip: "Vacuum #1", op: "Vacuum harden" })).toBe("eq-vac-1");
    expect(equipmentForStep({ equip: "Continuous Belt #2", op: "Carbonitride" })).toBe("eq-belt-1");
  });

  it("falls back to eq-iq-1 for unmapped stations", () => {
    expect(equipmentForStep({ equip: "Receiving", op: "Receive & verify" })).toBe("eq-iq-1");
    expect(equipmentForStep({ equip: "Shipping", op: "Certify & ship" })).toBe("eq-iq-1");
  });
});
