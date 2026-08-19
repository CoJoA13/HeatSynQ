import { describe, it, expect } from "vitest";
import { changedFields } from "@/lib/audit-diff";

// HistoryPanel's pure diff logic, extracted to a client-safe leaf (#14 item 2's render half —
// the Group D extract-and-test pattern). The suppression rule: when a raw `<x>Id` FK key changed
// AND its sibling relation key (`<x>`) changed in the same entry, the raw key is noise — the
// resolved relation says the same thing readably — so the diff reads once.
describe("changedFields (#14 item 2)", () => {
  it("returns [] when either side is missing (create/delete entries)", () => {
    expect(changedFields(null, { name: "x" })).toEqual([]);
    expect(changedFields({ name: "x" }, null)).toEqual([]);
    expect(changedFields(null, null)).toEqual([]);
  });

  it("reports changed keys and skips unchanged ones and updatedAt", () => {
    const before = { name: "a", qty: 1, updatedAt: "2026-01-01" };
    const after = { name: "b", qty: 1, updatedAt: "2026-01-02" };
    expect(changedFields(before, after)).toEqual(["name"]);
  });

  it("compares deep values (order-sensitive by design — snapshot capture orders collections)", () => {
    const before = { lines: [{ id: "1" }, { id: "2" }] };
    const after = { lines: [{ id: "2" }, { id: "1" }] };
    expect(changedFields(before, after)).toEqual(["lines"]);
  });

  it("suppresses a raw FK key when its sibling relation key changed too", () => {
    const before = { materialId: null, material: null };
    const after = { materialId: "cmsb1zabc", material: { id: "cmsb1zabc", name: "Ductile iron" } };
    expect(changedFields(before, after)).toEqual(["material"]);
  });

  it("keeps the raw FK key when no sibling relation key changed (frozen pre-include history)", () => {
    // Entries snapshotted before the SNAPSHOT_INCLUDE entry landed carry only the cuid —
    // accepted: snapshots are frozen, no backfill (#14 item 2).
    const before = { materialId: null };
    const after = { materialId: "cmsb1zabc" };
    expect(changedFields(before, after)).toEqual(["materialId"]);
  });

  it("keeps an Id-suffixed key whose sibling exists but did not change", () => {
    // A relation rename without a re-point would change `material` alone (shown), and a re-point
    // to an identically-shaped relation would change both (suppressed above) — but if only the
    // raw key differs while the sibling compares equal, the raw key is the only evidence and
    // must stay visible.
    const before = { materialId: "a", material: { name: "Same" } };
    const after = { materialId: "b", material: { name: "Same" } };
    expect(changedFields(before, after)).toEqual(["materialId"]);
  });

  it("leaves the literal key \"Id\" and short keys alone", () => {
    expect(changedFields({ Id: "a" }, { Id: "b" })).toEqual(["Id"]);
  });
});
