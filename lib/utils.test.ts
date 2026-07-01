import { describe, it, expect } from "vitest";
import { formatMoney, formatDate, cn } from "@/lib/utils";

describe("utils", () => {
  it("formats cents to whole dollars", () => {
    expect(formatMoney(842000)).toBe("$8,420");
    expect(formatMoney(58400 * 100)).toBe("$58,400");
  });
  it("merges classes", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
  it("formats midnight-UTC ISO dates in UTC (no west-of-UTC day shift)", () => {
    // Must render the UTC calendar day regardless of the runtime time zone.
    expect(formatDate("2026-06-30T00:00:00.000Z")).toBe("Jun 30, 2026");
    expect(formatDate("2026-07-02T00:00:00.000Z")).toBe("Jul 2, 2026");
  });
});
