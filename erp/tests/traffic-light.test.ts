import { describe, expect, it } from "vitest";
import { parseDateOnly } from "@/lib/business-days";
import { computeLight, LIGHT_LABELS, TRAFFIC_LIGHTS } from "@/lib/traffic-light";

// Pure module, no DB: the board's traffic light (spec §6), evaluated most-urgent-first against
// the request date. Every anchor below is a real, verified calendar day — 2026-08-03 is a
// Monday, so the +1..+6 offsets used here cross a weekend and prove the function counts
// CALENDAR days, not business days (the request date has already had business-day math applied
// to it when it was derived; the light just measures how far away it is).
const TODAY = parseDateOnly("2026-08-03");
const on = (s: string, may = 5, will = 3) => computeLight(parseDateOnly(s), TODAY, may, will);

describe("computeLight boundaries (may-miss 5, will-miss 3)", () => {
  // Boundary 1: did_miss / will_miss. "Strictly past" — the request date arriving TODAY has not
  // been missed yet, however urgent it is.
  it("did_miss the day before today; will_miss (not did_miss) on today itself", () => {
    expect(on("2026-08-02")).toBe("did_miss");
    expect(on("2026-08-03")).toBe("will_miss");
  });

  it("did_miss for anything further in the past", () => {
    expect(on("2026-07-20")).toBe("did_miss");
    expect(on("2025-01-01")).toBe("did_miss");
  });

  // Boundary 2: will_miss / may_miss. The window is inclusive of its own edge.
  it("will_miss at exactly will-miss days away; may_miss one day later", () => {
    expect(on("2026-08-06")).toBe("will_miss"); // +3, the edge
    expect(on("2026-08-07")).toBe("may_miss"); // +4, first day past it
  });

  // Boundary 3: may_miss / on_target, likewise inclusive.
  it("may_miss at exactly may-miss days away; on_target one day later", () => {
    expect(on("2026-08-08")).toBe("may_miss"); // +5, the edge
    expect(on("2026-08-09")).toBe("on_target"); // +6, clear
  });

  it("on_target far in the future", () => {
    expect(on("2026-12-25")).toBe("on_target");
  });

  // The whole point of "most-urgent-first": +1..+3 sit inside BOTH windows (3 ≤ 5), and the
  // urgent one has to win. An if-chain written may-miss-first would call these may_miss.
  it("resolves overlapping windows most-urgent-first: will-miss 3 sits inside may-miss 5", () => {
    expect(on("2026-08-04")).toBe("will_miss"); // +1
    expect(on("2026-08-05")).toBe("will_miss"); // +2
    expect(on("2026-08-06")).toBe("will_miss"); // +3
  });

  // Same guarantee under a misconfigured pair (will-miss WIDER than may-miss): the ordering is
  // structural, so the urgent classification still wins rather than the settings' relative size
  // silently deciding it. Recorded so a future settings edit can't quietly invert the board.
  it("keeps most-urgent-first even when will-miss is configured wider than may-miss", () => {
    expect(on("2026-08-07", 2, 5)).toBe("will_miss"); // +4: inside will (5), outside may (2)
  });

  it("collapses to did_miss / will_miss / on_target when both windows are zero", () => {
    expect(on("2026-08-02", 0, 0)).toBe("did_miss");
    expect(on("2026-08-03", 0, 0)).toBe("will_miss"); // due today, zero grace
    expect(on("2026-08-04", 0, 0)).toBe("on_target");
  });
});

describe("computeLight day granularity", () => {
  // Both arguments are UTC-midnight Dates by contract (@db.Date semantics, business-days.ts).
  // These two dates are exactly one calendar day apart in UTC but straddle the US DST change
  // (2026-11-01), where naive local-time day math would compute 1.04 days and could round the
  // classification onto the wrong side of a boundary.
  it("counts whole UTC days across a local DST transition", () => {
    const today = parseDateOnly("2026-11-01");
    expect(computeLight(parseDateOnly("2026-11-02"), today, 5, 1)).toBe("will_miss"); // +1
    expect(computeLight(parseDateOnly("2026-11-07"), today, 5, 1)).toBe("on_target"); // +6
    expect(computeLight(parseDateOnly("2026-10-31"), today, 5, 1)).toBe("did_miss"); // -1
  });
});

describe("traffic light vocabulary", () => {
  it("labels every light, most-urgent-first, for the board and the Excel export", () => {
    expect(TRAFFIC_LIGHTS).toEqual(["did_miss", "will_miss", "may_miss", "on_target"]);
    expect(TRAFFIC_LIGHTS.map((l) => LIGHT_LABELS[l]))
      .toEqual(["Did miss", "Will miss", "May miss", "On target"]);
  });
});
