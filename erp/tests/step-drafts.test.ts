import { describe, expect, it } from "vitest";
import { buildStepDrafts } from "@/lib/step-drafts";

// The draft-building half of ProcessStepsSection, extracted so it can be tested at all: the
// vitest environment is "node" with no DOM, so the component itself is out of reach — the
// next-sort.ts / permission-ui.ts precedent (UI logic worth asserting lives in src/lib).

const code = (id: string, ...fieldIds: string[]) => ({ id, fields: fieldIds.map((f) => ({ id: f })) });

describe("buildStepDrafts", () => {
  it("seeds an empty entry for every field def the step's code carries", () => {
    const { drafts } = buildStepDrafts(
      [{ id: "s1", codeId: "c1", instruction: "Soak 2h", values: [] }],
      [code("c1", "f1", "f2")],
    );
    expect(drafts.get("s1")).toEqual({
      instruction: "Soak 2h",
      values: new Map([["f1", ""], ["f2", ""]]),
    });
  });

  it("overwrites the seeds with the values the server actually returned", () => {
    const { drafts } = buildStepDrafts(
      [{ id: "s1", codeId: "c1", instruction: "", values: [{ fieldDefId: "f2", value: "1550" }] }],
      [code("c1", "f1", "f2")],
    );
    expect(drafts.get("s1")?.values).toEqual(new Map([["f1", ""], ["f2", "1550"]]));
  });

  // The regression this was extracted for (Codex, PR #22): the effect used to bail out entirely
  // unless the step-code-fields fetch had succeeded, so a failure there left every step without a
  // draft — the instruction textarea rendered "" over persisted text and swallowed typing, while
  // remove/reorder stayed live. The field inputs can't render without the defs, but nothing about
  // the instruction or the already-persisted values depends on that fetch.
  it("still drafts a step whose code is missing from the options (failed fetch)", () => {
    const { drafts, originals } = buildStepDrafts(
      [{ id: "s1", codeId: "c1", instruction: "Quench in oil", values: [{ fieldDefId: "f1", value: "true" }] }],
      [],
    );
    expect(drafts.get("s1")).toEqual({
      instruction: "Quench in oil",
      values: new Map([["f1", "true"]]),
    });
    expect(originals.get("s1")?.instruction).toBe("Quench in oil");
  });

  it("drafts every step, keyed by step id", () => {
    const { drafts } = buildStepDrafts(
      [
        { id: "s1", codeId: "c1", instruction: "one", values: [] },
        { id: "s2", codeId: "c2", instruction: "two", values: [] },
      ],
      [code("c1", "f1"), code("c2")],
    );
    expect([...drafts.keys()]).toEqual(["s1", "s2"]);
    expect(drafts.get("s2")?.values.size).toBe(0);
  });

  it("gives originals its own value map, so later draft edits never mutate the snapshot", () => {
    const { drafts, originals } = buildStepDrafts(
      [{ id: "s1", codeId: "c1", instruction: "", values: [{ fieldDefId: "f1", value: "1550" }] }],
      [code("c1", "f1")],
    );
    drafts.get("s1")?.values.set("f1", "1600");
    expect(originals.get("s1")?.values.get("f1")).toBe("1550");
  });

  it("returns empty maps for a revision with no steps", () => {
    const { drafts, originals } = buildStepDrafts([], [code("c1", "f1")]);
    expect(drafts.size).toBe(0);
    expect(originals.size).toBe(0);
  });
});
