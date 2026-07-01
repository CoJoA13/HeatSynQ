import { describe, it, expect } from "vitest";
import { toneClasses, type StatusTone } from "@/lib/domain/enums";

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
