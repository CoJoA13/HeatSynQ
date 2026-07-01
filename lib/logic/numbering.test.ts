import { describe, it, expect } from "vitest";
import { formatNumber, Counter } from "@/lib/logic/numbering";

describe("numbering", () => {
  it("formats prefix + sequence", () => {
    expect(formatNumber("WO-", 48211)).toBe("WO-48211");
  });
  it("increments per prefix independently", () => {
    const c = new Counter({ "Q-": 2840, "WO-": 48210 });
    expect(c.next("Q-")).toBe("Q-2841");
    expect(c.next("WO-")).toBe("WO-48211");
    expect(c.next("Q-")).toBe("Q-2842");
  });
});
