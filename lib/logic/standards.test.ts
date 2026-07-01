import { describe, it, expect } from "vitest";
import { standardSchema, type Standard } from "@/lib/domain";
import { isReviewDue } from "./standards";

const base = { id: "std-x", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", version: 0 };
const std = (over: Partial<Standard> = {}): Standard =>
  standardSchema.parse({
    ...base, code: "AS9100D", title: "Aerospace quality management system", category: "quality",
    reviewedAt: "2025-11-15T00:00:00.000Z", nextReviewAt: "2026-11-15T00:00:00.000Z", ...over,
  });

describe("standardSchema", () => {
  it("parses a valid standard", () => {
    expect(std().category).toBe("quality");
    expect(std({ category: "process" }).category).toBe("process");
  });
  it("rejects an unknown category", () => {
    expect(() => std({ category: "safety" as Standard["category"] })).toThrow();
  });
});

describe("isReviewDue", () => {
  const asOf = "2026-06-30T12:00:00.000Z"; // DEMO_NOW
  it("is false when nextReviewAt is after asOf", () => {
    expect(isReviewDue(std({ nextReviewAt: "2026-07-01T00:00:00.000Z" }), asOf)).toBe(false);
  });
  it("is true when nextReviewAt is before asOf", () => {
    expect(isReviewDue(std({ nextReviewAt: "2026-06-15T00:00:00.000Z" }), asOf)).toBe(true);
  });
  it("is true on the exact boundary (due at asOf counts as due)", () => {
    expect(isReviewDue(std({ nextReviewAt: asOf }), asOf)).toBe(true);
  });
});
