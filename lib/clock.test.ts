import { describe, it, expect } from "vitest";
import { DEMO_NOW, nowIso } from "./clock";
import { NOW } from "./data/mock/store";

describe("demo clock", () => {
  it("DEMO_NOW is the frozen demo instant", () => {
    expect(DEMO_NOW).toBe("2026-06-30T12:00:00.000Z");
    expect(nowIso()).toBe(DEMO_NOW);
  });
  it("mock store NOW is the single source (equals DEMO_NOW)", () => {
    expect(NOW).toBe(DEMO_NOW);
  });
});
