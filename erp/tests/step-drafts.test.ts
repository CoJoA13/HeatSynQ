import { describe, expect, it } from "vitest";
import {
  buildStepOriginals, isStepDirty, pendingChanges, shownInstruction, shownValue, type StepEdits,
} from "@/lib/step-drafts";

// The draft model behind ProcessStepsSection, extracted so it can be tested at all: the vitest
// environment is "node" with no DOM, so the component itself is out of reach — the next-sort.ts /
// permission-ui.ts precedent.

const code = (id: string, ...fieldIds: string[]) => ({ id, fields: fieldIds.map((f) => ({ id: f })) });
const edits = (e: Partial<StepEdits> = {}): StepEdits => ({ values: new Map(), ...e });

describe("buildStepOriginals", () => {
  it("seeds an empty entry for every field def the step's code carries", () => {
    const o = buildStepOriginals(
      [{ id: "s1", codeId: "c1", instruction: "Soak 2h", values: [] }],
      [code("c1", "f1", "f2")],
    );
    expect(o.get("s1")).toEqual({ instruction: "Soak 2h", values: new Map([["f1", ""], ["f2", ""]]) });
  });

  it("overwrites the seeds with the values the server actually returned", () => {
    const o = buildStepOriginals(
      [{ id: "s1", codeId: "c1", instruction: "", values: [{ fieldDefId: "f2", value: "1550" }] }],
      [code("c1", "f1", "f2")],
    );
    expect(o.get("s1")?.values).toEqual(new Map([["f1", ""], ["f2", "1550"]]));
  });

  // A failed step-code-fields fetch must not hide persisted work: the instruction and the values
  // the server already holds need none of the field definitions.
  it("still describes a step whose code is missing from the options", () => {
    const o = buildStepOriginals(
      [{ id: "s1", codeId: "c1", instruction: "Quench in oil", values: [{ fieldDefId: "f1", value: "true" }] }],
      [],
    );
    expect(o.get("s1")).toEqual({ instruction: "Quench in oil", values: new Map([["f1", "true"]]) });
  });

  it("returns an empty map for a revision with no steps", () => {
    expect(buildStepOriginals([], [code("c1", "f1")]).size).toBe(0);
  });
});

describe("composing server state with the user's own edits", () => {
  const original = { instruction: "on the server", values: new Map([["f1", "1550"], ["f2", ""]]) };

  it("shows the server's text and values when nothing has been typed", () => {
    expect(shownInstruction(original, undefined)).toBe("on the server");
    expect(shownValue(original, undefined, "f1")).toBe("1550");
    expect(isStepDirty(original, undefined)).toBe(false);
  });

  it("shows what the user typed, over the server's", () => {
    const e = edits({ instruction: "typed", values: new Map([["f1", "1700"]]) });
    expect(shownInstruction(original, e)).toBe("typed");
    expect(shownValue(original, e, "f1")).toBe("1700");
    expect(shownValue(original, e, "f2")).toBe(""); // untouched -> server's
  });

  // The regression this model exists for. An untouched field has no entry in the overlay, so a
  // refreshed server value simply shows through — there is no stale copy able to overwrite it,
  // and nothing for a Save to send back. Previously the whole draft was carried forward, so
  // another user's edit came back correct and was immediately masked by this user's clean copy,
  // shown as dirty, and revertible with one click of Save.
  it("adopts another user's change to an untouched field, without marking it dirty", () => {
    const refreshed = { instruction: "someone else edited this", values: new Map([["f1", "1600"]]) };
    const e = edits(); // this user typed nothing
    expect(shownInstruction(refreshed, e)).toBe("someone else edited this");
    expect(shownValue(refreshed, e, "f1")).toBe("1600");
    expect(isStepDirty(refreshed, e)).toBe(false);
    expect(pendingChanges(refreshed, e)).toEqual({ values: [] });
  });

  it("keeps this user's edit when the same field changed underneath, and flags it dirty", () => {
    const refreshed = { instruction: "someone else edited this", values: new Map([["f1", "1600"]]) };
    const e = edits({ instruction: "mine" });
    expect(shownInstruction(refreshed, e)).toBe("mine");
    expect(isStepDirty(refreshed, e)).toBe(true);
    expect(pendingChanges(refreshed, e).instruction).toBe("mine");
  });

  it("sends only what actually differs", () => {
    const e = edits({ instruction: "on the server", values: new Map([["f1", "1550"], ["f2", "x"]]) });
    // instruction and f1 were typed back to their original values — nothing to send for either.
    expect(pendingChanges(original, e)).toEqual({ values: [{ fieldDefId: "f2", value: "x" }] });
    expect(isStepDirty(original, e)).toBe(true);
  });

  it("treats typing everything back to the original as clean", () => {
    const e = edits({ instruction: "on the server", values: new Map([["f1", "1550"]]) });
    expect(isStepDirty(original, e)).toBe(false);
  });

  it("counts clearing a set value as a change", () => {
    const e = edits({ values: new Map([["f1", ""]]) });
    expect(pendingChanges(original, e)).toEqual({ values: [{ fieldDefId: "f1", value: "" }] });
    expect(isStepDirty(original, e)).toBe(true);
  });

  it("treats a step the server no longer describes as having nothing to send", () => {
    expect(pendingChanges(undefined, edits({ instruction: "" }))).toEqual({ values: [] });
  });
});
