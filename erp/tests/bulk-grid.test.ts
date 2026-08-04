import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendRows, computeOrphanChurn } from "@/lib/bulk-grid";

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

// Fix-wave R4 finding 7: the hub's per-line serial grid expanded a range by calling `addRow` once
// per serial, and `addRow` appends with `setAdded((cur) => [...cur, row])` — a fresh copy of the
// whole array per row. A legal `EC{1-10000}` (serial-range.ts's own MAX_EXPANSION) therefore did
// ~50 million element copies across 10,000 separate state updates, on the main thread, in one
// keystroke's handler: the grid locked up rather than filling in. `appendRows` is the same append
// done ONCE for the whole batch, and is what `addRows` (and, for a single row, `addRow`) is built
// from — extracted as a pure reducer for the usual reason (vitest is `environment: "node"`; this
// codebase has no component-test harness).
describe("appendRows", () => {
  const row = (serial: string) => ({ serial, description: "" });

  it("appends every row in one pass, in order, after whatever was already there", () => {
    const existing = appendRows([], [row("A1")]);
    const result = appendRows(existing, [row("B1"), row("B2")]);

    expect(result.map((r) => r.serial)).toEqual(["A1", "B1", "B2"]);
    expect(new Set(result.map((r) => r.clientId)).size).toBe(3); // one client id each, all distinct
  });

  it("never mutates the array it was handed", () => {
    const existing = appendRows([], [row("A1")]);
    const before = [...existing];
    appendRows(existing, [row("B1")]);
    expect(existing).toEqual(before);
  });

  it("appending nothing is a no-op that still returns a new array", () => {
    const existing = appendRows([], [row("A1")]);
    const result = appendRows(existing, []);
    expect(result).toEqual(existing);
    expect(result).not.toBe(existing);
  });

  // The finding's own case: the largest expansion `expandSerialRange` will ever hand over, added
  // in a SINGLE call rather than 10,000 successive whole-array copies.
  it("takes a full 10,000-serial range expansion in one call", () => {
    const expanded = Array.from({ length: 10_000 }, (_, i) => row(`EC${String(i + 1).padStart(5, "0")}`));
    const result = appendRows([], expanded);

    expect(result).toHaveLength(10_000);
    expect(result[0].serial).toBe("EC00001");
    expect(result[9_999].serial).toBe("EC10000");
    expect(new Set(result.map((r) => r.clientId)).size).toBe(10_000);
  });
});

// The call-site half of the same finding: a bulk expansion has to reach the grid through the bulk
// API. Checked at the source, because the alternative — a per-row loop — is behaviourally
// identical and only differs in cost, so no assertion on the resulting rows could ever tell them
// apart. (The partial-unique-sweep precedent: some invariants are only visible in the text.)
describe("serial-range expansion call sites", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("the hub's serial grid expands a range through addRows, never a per-serial addRow", () => {
    const src = read("src/app/orders/[id]/SerialsSection.tsx");
    const addRange = /function addRange\(\)[\s\S]*?\n  \}/.exec(src);
    expect(addRange, "addRange() not found — update this sweep alongside the rename").not.toBeNull();
    expect(addRange![0]).toContain("addRows(");
    expect(addRange![0]).not.toMatch(/\baddRow\(/);
  });

  // The entry page's sibling expansion was already a single update (one `onChange` with the whole
  // expanded batch spread in) — pinned here so the two stay consistent, since this is exactly the
  // habit that produced the hub's version.
  it("the entry page's line card expands a range in a single onChange, not one per serial", () => {
    const src = read("src/app/orders/new/OrderLineCard.tsx");
    const addRange = /function addRange\(\)[\s\S]*?\n  \}/.exec(src);
    expect(addRange, "addRange() not found — update this sweep alongside the rename").not.toBeNull();
    expect((addRange![0].match(/onChange\(/g) ?? [])).toHaveLength(1);
  });
});
