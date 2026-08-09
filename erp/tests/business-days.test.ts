import { describe, expect, it } from "vitest";
import { addBusinessDays, addDays, formatDateOnly, parseDateOnly, todayDateOnly } from "@/lib/business-days";

// Pure module, no DB: date-only parsing/formatting and Mon–Fri business-day math over
// UTC-midnight Dates (matches @db.Date column semantics). The anchor dates below are real,
// verified calendar days (2026-08-06 = Thursday, 2026-08-07 = Friday, 2026-08-03 = Monday).

describe("parseDateOnly", () => {
  it("parses a valid date to UTC midnight", () => {
    const d = parseDateOnly("2026-08-06");
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(7); // 0-indexed: August
    expect(d.getUTCDate()).toBe(6);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it("rejects 2025-02-29 — the leap-year rollover guard (2025 is not a leap year)", () => {
    expect(() => parseDateOnly("2025-02-29")).toThrow();
  });

  it("accepts the real leap day in an actual leap year, as a control on the guard above", () => {
    expect(formatDateOnly(parseDateOnly("2024-02-29"))).toBe("2024-02-29");
  });

  it("rejects an out-of-range month (2025-13-01)", () => {
    expect(() => parseDateOnly("2025-13-01")).toThrow();
  });

  it("rejects malformed input", () => {
    expect(() => parseDateOnly("not-a-date")).toThrow();
    expect(() => parseDateOnly("2025/06/15")).toThrow();
    expect(() => parseDateOnly("")).toThrow();
  });
});

describe("formatDateOnly", () => {
  it("round-trips through parseDateOnly, including single-digit month/day padding", () => {
    for (const s of ["2026-01-05", "2026-08-06", "2026-12-31"]) {
      expect(formatDateOnly(parseDateOnly(s))).toBe(s);
    }
  });
});

describe("todayDateOnly", () => {
  it("returns today's date at UTC midnight", () => {
    const now = new Date();
    const today = todayDateOnly();
    expect(today.getUTCFullYear()).toBe(now.getUTCFullYear());
    expect(today.getUTCMonth()).toBe(now.getUTCMonth());
    expect(today.getUTCDate()).toBe(now.getUTCDate());
    expect(today.getUTCHours()).toBe(0);
    expect(today.getUTCMinutes()).toBe(0);
    expect(today.getUTCSeconds()).toBe(0);
    expect(today.getUTCMilliseconds()).toBe(0);
  });
});

describe("addBusinessDays", () => {
  it("Thu + 5 business days = the following Thu", () => {
    const start = parseDateOnly("2026-08-06"); // Thursday
    expect(formatDateOnly(addBusinessDays(start, 5))).toBe("2026-08-13"); // following Thursday
  });

  it("Fri + 1 business day = Mon", () => {
    const start = parseDateOnly("2026-08-07"); // Friday
    expect(formatDateOnly(addBusinessDays(start, 1))).toBe("2026-08-10"); // Monday
  });

  it("Mon + 0 business days = Mon, unchanged", () => {
    const start = parseDateOnly("2026-08-03"); // Monday
    expect(formatDateOnly(addBusinessDays(start, 0))).toBe("2026-08-03");
  });

  it("skips a full weekend crossed mid-count, not just when landing on one", () => {
    // Wed 2026-08-05 + 3 business days: Thu, Fri, (skip Sat/Sun), Mon = 2026-08-10.
    const start = parseDateOnly("2026-08-05");
    expect(formatDateOnly(addBusinessDays(start, 3))).toBe("2026-08-10");
  });

  it("rejects a negative n", () => {
    expect(() => addBusinessDays(parseDateOnly("2026-08-03"), -1)).toThrow();
  });

  it("rejects a non-integer n", () => {
    expect(() => addBusinessDays(parseDateOnly("2026-08-03"), 1.5)).toThrow();
  });

  // Fix-wave finding 5: nothing capped `n` before this — a huge day offset (a bad
  // requestDaysOverride, or historical data predating the zod caps added alongside this fix)
  // iterates the day-at-a-time loop that many times, stalling the event loop rather than
  // rejecting cleanly. 3650 days (~10 years) is far beyond any legitimate request-date lead time.
  it("rejects n > 3650, naming the cap", () => {
    expect(() => addBusinessDays(parseDateOnly("2026-08-03"), 3651)).toThrow(/3650/);
  });

  it("allows exactly 3650 — the boundary, not just a big blowout", () => {
    expect(() => addBusinessDays(parseDateOnly("2026-08-03"), 3650)).not.toThrow();
  });
});

// Phase 5B Task 3: a due date is a calendar date — no weekend skip, unlike addBusinessDays above.
describe("addDays", () => {
  it("crosses a month boundary (2026-08-01 + 30 = 2026-08-31)", () => {
    const start = parseDateOnly("2026-08-01");
    expect(formatDateOnly(addDays(start, 30))).toBe("2026-08-31");
  });

  it("does not skip weekends — a Saturday landing stays a Saturday", () => {
    // 2026-08-06 is a Thursday; +2 lands on Saturday 2026-08-08, unlike addBusinessDays.
    const start = parseDateOnly("2026-08-06");
    expect(formatDateOnly(addDays(start, 2))).toBe("2026-08-08");
  });

  it("n = 0 returns the same date, unchanged", () => {
    const start = parseDateOnly("2026-08-03");
    expect(formatDateOnly(addDays(start, 0))).toBe("2026-08-03");
  });

  it("accepts a negative n (a back-dated offset)", () => {
    const start = parseDateOnly("2026-08-31");
    expect(formatDateOnly(addDays(start, -30))).toBe("2026-08-01");
  });

  it("rejects a non-integer n", () => {
    expect(() => addDays(parseDateOnly("2026-08-03"), 1.5)).toThrow();
  });
});
