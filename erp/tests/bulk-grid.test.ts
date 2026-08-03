import { describe, expect, it } from "vitest";
import { computeOrphanChurn } from "@/lib/bulk-grid";

// Pure module (no DOM/React state involved), unlike the rest of bulk-grid.ts's hook — extracted
// specifically so the id-churn matrix is unit-testable without a component-test harness (this
// codebase has none; vitest runs `environment: "node"` throughout). Fix-wave R2 finding 5: the
// hook's own `detectOrphans` used to early-return whenever `edits` was empty, so a stale
// `removedIds` entry survived an id-churn refresh untouched — the row it meant to remove
// reappeared (nothing in `compose`'s filter matched the old id anymore) with no warning posted,
// exactly the "masked edit" bug `edits` itself was already protected against. `computeOrphanChurn`
// is the pure decision at the center of that fix: given the live id set, the previous one, and
// what's currently pending, what (if anything) got orphaned by the churn.

describe("computeOrphanChurn", () => {
  it("reports unchanged when the live id set is the same content, even as a different Set instance", () => {
    const result = computeOrphanChurn({
      liveIds: new Set(["a", "b"]),
      priorLiveIds: new Set(["b", "a"]), // same members, different order/instance
      editKeys: ["a"],
      removedIds: new Set(["b"]),
    });
    expect(result).toEqual({ kind: "unchanged" });
  });

  it("reports first-seen on the very first call (priorLiveIds null), regardless of what's pending", () => {
    const result = computeOrphanChurn({
      liveIds: new Set(["a", "b"]),
      priorLiveIds: null,
      editKeys: ["a"],
      removedIds: new Set(["z"]), // would be "orphaned" against liveIds, but there's nothing to compare yet
    });
    expect(result).toEqual({ kind: "first-seen" });
  });

  it("churn with only an edit orphaned: removedIds untouched, edit key reported", () => {
    const result = computeOrphanChurn({
      liveIds: new Set(["a-new", "b"]), // "a" was replaced by "a-new" (delete+recreate churn)
      priorLiveIds: new Set(["a", "b"]),
      editKeys: ["a"],
      removedIds: new Set(),
    });
    expect(result).toEqual({ kind: "churned", orphanedEditKeys: ["a"], orphanedRemovedIds: [] });
  });

  // The regression this finding fixes: previously the hook's own early return (`edits.size ===
  // 0`) meant this exact shape — nothing being EDITED, but something marked for REMOVAL — was
  // never even inspected, so the vanished removedIds entry silently survived forever and the row
  // it meant to remove reappeared with no warning.
  it("churn with only a removedIds entry orphaned: edits untouched, removed id reported (the finding's own regression shape)", () => {
    const result = computeOrphanChurn({
      liveIds: new Set(["b-new"]), // the row marked for removal ("b") churned to a new id
      priorLiveIds: new Set(["b"]),
      editKeys: [], // no edits pending at all
      removedIds: new Set(["b"]),
    });
    expect(result).toEqual({ kind: "churned", orphanedEditKeys: [], orphanedRemovedIds: ["b"] });
  });

  it("churn with both an edit and a removal orphaned at once", () => {
    const result = computeOrphanChurn({
      liveIds: new Set(["c"]),
      priorLiveIds: new Set(["a", "b"]),
      editKeys: ["a"],
      removedIds: new Set(["b"]),
    });
    expect(result.kind).toBe("churned");
    if (result.kind === "churned") {
      expect(result.orphanedEditKeys).toEqual(["a"]);
      expect(result.orphanedRemovedIds).toEqual(["b"]);
    }
  });

  it("churn that orphans neither: an unrelated row appeared/vanished, edits/removedIds still all live", () => {
    const result = computeOrphanChurn({
      liveIds: new Set(["a", "b", "c"]), // "c" is new, but "a"/"b" (the ones pending) survive untouched
      priorLiveIds: new Set(["a", "b"]),
      editKeys: ["a"],
      removedIds: new Set(["b"]),
    });
    expect(result).toEqual({ kind: "churned", orphanedEditKeys: [], orphanedRemovedIds: [] });
  });

  it("empty edits AND empty removedIds still reports churned (not unchanged) when the live set actually changed", () => {
    const result = computeOrphanChurn({
      liveIds: new Set(["a", "b", "c"]),
      priorLiveIds: new Set(["a", "b"]),
      editKeys: [],
      removedIds: new Set(),
    });
    expect(result).toEqual({ kind: "churned", orphanedEditKeys: [], orphanedRemovedIds: [] });
  });
});
