import { describe, it, expect } from "vitest";
import { parseSetpoint, parseDurationMinutes } from "./shop-floor";

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
