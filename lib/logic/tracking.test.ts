import { describe, it, expect } from "vitest";
import { areaForOp } from "./tracking";

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
