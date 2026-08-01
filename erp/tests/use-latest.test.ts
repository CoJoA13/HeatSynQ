import { describe, it, expect } from "vitest";
import { makeLatestGate } from "@/lib/use-latest";

describe("makeLatestGate", () => {
  it("only the newest ticket is current", () => {
    const g = makeLatestGate();
    const a = g.next(); const b = g.next();
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
  });
  it("a later ticket invalidates all earlier ones at issue time, not resolve time", () => {
    const g = makeLatestGate();
    const a = g.next();
    expect(g.isCurrent(a)).toBe(true);
    g.next();
    expect(g.isCurrent(a)).toBe(false);
  });
});
