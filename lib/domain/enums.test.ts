import { describe, it, expect } from "vitest";
import { toneClasses, type StatusTone, AREAS, areaMeta, ORDER_STEP_STATES, orderStepStateMeta } from "@/lib/domain/enums";

describe("toneClasses", () => {
  it("returns text+bg utility classes per tone", () => {
    const tones: StatusTone[] = ["success", "info", "warn", "danger", "neutral"];
    for (const t of tones) {
      const c = toneClasses(t);
      expect(c).toContain("text-status-" + t);
      expect(c).toContain("bg-status-" + t + "-tint");
    }
  });
});

describe("area + order-step-state metadata", () => {
  it("orders the areas received → shipped", () => {
    expect(AREAS).toEqual([
      "received", "rack", "in_process", "wash", "final_inspect", "available_to_ship", "shipped",
    ]);
  });
  it("has a label + tone for every area", () => {
    AREAS.forEach((a) => {
      expect(areaMeta[a].label.length).toBeGreaterThan(0);
      expect(["success", "info", "warn", "danger", "neutral"]).toContain(areaMeta[a].tone);
    });
  });
  it("has a label + tone for every order-step state", () => {
    ORDER_STEP_STATES.forEach((s) => {
      expect(orderStepStateMeta[s].label.length).toBeGreaterThan(0);
      expect(["success", "info", "warn", "danger", "neutral"]).toContain(orderStepStateMeta[s].tone);
    });
  });
});
