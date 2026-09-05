import { describe, it, expect } from "vitest";
import { changedFields, summarizeChange, detailJson } from "@/lib/audit-diff";

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

// ---------------------------------------------------------------------------
// summarizeChange / detailJson — the READABILITY half of the diff line.
//
// #170 stopped a relation array from widening the page (break-all + a capped, scrolling box) but
// left the CONTENT as minified JSON, so "what changed in process steps" reads as
// `[{"id":"cmtn80x450078sf9526xsy397","code":{...}}]`. These two pure helpers let the panel lead
// with a human line and keep the bytes behind a disclosure — #170's contract is that the
// rendering is CONSTRAINED, never truncated, so every byte must still be reachable.
describe("summarizeChange", () => {
  it("renders scalars inline, exactly as before, and asks for no disclosure", () => {
    expect(summarizeChange("OPEN", "SHIPPED")).toEqual({ inline: '"OPEN" → "SHIPPED"', expandable: false });
    expect(summarizeChange(1, 2)).toEqual({ inline: "1 → 2", expandable: false });
    expect(summarizeChange(true, false)).toEqual({ inline: "true → false", expandable: false });
    expect(summarizeChange(null, "x")).toEqual({ inline: 'null → "x"', expandable: false });
  });

  it("renders an ABSENT side as an em dash rather than nothing at all", () => {
    // JSON.stringify(undefined) is undefined, which React renders as empty — so a key present on
    // only one side used to read `name:  → "x"`, an invisible half no reader can interpret.
    expect(summarizeChange(undefined, "x").inline).toBe('— → "x"');
    expect(summarizeChange("x", undefined).inline).toBe('"x" → —');
  });

  it("counts array items instead of dumping them, and reports a size change", () => {
    expect(summarizeChange([1, 2], [1, 2, 3])).toEqual({ inline: "2 items → 3 items", expandable: true });
    expect(summarizeChange([], [1])).toEqual({ inline: "empty → 1 item", expandable: true });
    expect(summarizeChange([1], [])).toEqual({ inline: "1 item → empty", expandable: true });
  });

  it("says CONTENTS changed when an array's length did not move", () => {
    // The count alone would read "5 items → 5 items", which looks like nothing happened —
    // the exact case that sent a reader into the raw JSON.
    expect(summarizeChange([{ a: 1 }], [{ a: 2 }]))
      .toEqual({ inline: "1 item, contents changed", expandable: true });
  });

  it("summarizes an object by its own label when it carries one", () => {
    // audit-diff's raw-FK suppression exists so a relation reads once and readably
    // (`material: {…"Ductile iron"…}`); leading with that label is the readable form of it.
    expect(summarizeChange({ id: "a", name: "Ductile iron" }, { id: "b", name: "A2 Tool Steel" }).inline)
      .toBe('"Ductile iron" → "A2 Tool Steel"');
    expect(summarizeChange({ id: "a", code: "HT-100" }, { id: "b", code: "HT-600" }).inline)
      .toBe('"HT-100" → "HT-600"');
  });

  it("does not render an equal label as a misleading no-op", () => {
    // Codex P2 on #272: step-code NAMES are not unique, the FK is editable, and changedFields
    // suppresses the raw FK in favour of the readable relation — so a genuine change between two
    // records sharing a name collapsed to `"Heat Treat" → "Heat Treat"`, which reads as nothing
    // happening while hiding the only distinguishing value. Same failure the equal-length array
    // case above is worded around.
    expect(summarizeChange({ id: "a", name: "Heat Treat" }, { id: "b", name: "Heat Treat" }))
      .toEqual({ inline: '"Heat Treat", contents changed', expandable: true });
  });

  it("prefers a UNIQUE code over a shared name when the names match", () => {
    // When the snapshot carries `code` (partPrice.processStepCode does), it distinguishes what
    // `name` cannot — so say the thing that actually changed rather than "contents changed".
    expect(summarizeChange(
      { id: "a", name: "Heat Treat", code: "HT-100" },
      { id: "b", name: "Heat Treat", code: "HT-600" },
    )).toEqual({ inline: '"HT-100" → "HT-600"', expandable: true });
  });

  it("says null when a labeled relation is assigned or cleared", () => {
    // Codex P2 on #272: `SNAPSHOT_INCLUDE.part` carries `material` and changedFields suppresses the
    // accompanying `materialId`, so this line is the whole story — and `… → "Ductile iron"` hides
    // whether the relation was previously ABSENT or merely unlabeled. Null keeps scalarText's word.
    expect(summarizeChange(null, { id: "a", name: "Ductile iron" }).inline).toBe('null → "Ductile iron"');
    expect(summarizeChange({ id: "a", name: "Ductile iron" }, null).inline).toBe('"Ductile iron" → null');
    expect(summarizeChange(undefined, { id: "a", name: "Ductile iron" }).inline).toBe('— → "Ductile iron"');
  });

  it("keeps the ellipsis for a side that is present but carries no label", () => {
    // Not the same thing as absent, and must not read as if it were.
    expect(summarizeChange({ qty: 1 }, { id: "a", name: "Ductile iron" }).inline).toBe('… → "Ductile iron"');
  });

  it("falls back to a field count for an object with no label", () => {
    expect(summarizeChange({ a: 1 }, { a: 1, b: 2 })).toEqual({ inline: "1 field → 2 fields", expandable: true });
  });

  it("recognizes the other human identifiers relations actually carry", () => {
    // Codex P2 on #272: LABEL_KEYS knew name/code, but SNAPSHOT_INCLUDE relations are also
    // identified by displayName (quotedBy), orderNumber and partNumber — so they fell through to
    // the field count and read `1 field → 1 field`, a no-op for a change that did happen.
    expect(summarizeChange({ displayName: "Dana Clark" }, { displayName: "Rosa Moreno" }).inline)
      .toBe('"Dana Clark" → "Rosa Moreno"');
    expect(summarizeChange({ orderNumber: 1004 }, { orderNumber: 1005 }).inline).toBe('"1004" → "1005"');
    expect(summarizeChange({ partNumber: "TD-77" }, { partNumber: "TD-90" }).inline).toBe('"TD-77" → "TD-90"');
  });

  it("never reports an equal field count as though nothing changed", () => {
    // The safety net behind the enumeration above: an identifier nobody has added to LABEL_KEYS
    // still must not render `1 field → 1 field` for a genuine change. changedFields only reaches
    // here because the value DIFFERS, so an equal count means the contents moved.
    expect(summarizeChange({ mysteryRef: "A" }, { mysteryRef: "B" }))
      .toEqual({ inline: "1 field, contents changed", expandable: true });
    expect(summarizeChange({ a: 1, b: 2 }, { a: 9, b: 8 }))
      .toEqual({ inline: "2 fields, contents changed", expandable: true });
  });

  it("is expandable for every non-scalar, so the bytes stay reachable (#170's contract)", () => {
    expect(summarizeChange({ name: "a" }, { name: "b" }).expandable).toBe(true);
    expect(summarizeChange([1], [2]).expandable).toBe(true);
  });
});

describe("detailJson", () => {
  it("pretty-prints both sides so the disclosure is readable, not minified", () => {
    const out = detailJson({ a: 1 }, { a: 2 });
    expect(out).toContain('"a": 1');
    expect(out).toContain('"a": 2');
    expect(out.split("\n").length).toBeGreaterThan(2); // indented, not one line
  });

  it("labels which side is which", () => {
    const out = detailJson({ a: 1 }, { a: 2 });
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("renders an absent side as an em dash rather than the literal 'undefined'", () => {
    expect(detailJson(undefined, { a: 1 })).toContain("before: —");
  });
});
