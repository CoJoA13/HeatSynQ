import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildStepOriginals, dropStepEdits, editsAfterSave, isStepDirty, pendingChanges, remapStepEdits,
  shownInstruction, shownValue, stepEditsAfterRemoval, type StepEdits,
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

describe("editsAfterSave", () => {
  it("drops an overlay whose every field was submitted unchanged", () => {
    const e = edits({ instruction: "sent", values: new Map([["f1", "1700"]]) });
    expect(editsAfterSave(e, { instruction: "sent", values: [{ fieldDefId: "f1", value: "1700" }] }))
      .toBeNull();
  });

  // The regression: the row stays editable during the PATCH, so anything typed after the request
  // left must survive the success handler. Clearing the whole overlay discarded it, and the
  // reload then painted the submitted value over the top.
  it("keeps an instruction typed after the request went out", () => {
    const e = edits({ instruction: "typed while saving", values: new Map() });
    expect(editsAfterSave(e, { instruction: "sent", values: [] }))
      .toEqual({ instruction: "typed while saving", values: new Map() });
  });

  it("keeps a field value typed after the request went out", () => {
    const e = edits({ values: new Map([["f1", "1800"]]) });
    expect(editsAfterSave(e, { values: [{ fieldDefId: "f1", value: "1700" }] }))
      .toEqual({ instruction: undefined, values: new Map([["f1", "1800"]]) });
  });

  it("clears only the fields that were submitted, keeping the rest", () => {
    const e = edits({ values: new Map([["f1", "1700"], ["f2", "later"]]) });
    expect(editsAfterSave(e, { values: [{ fieldDefId: "f1", value: "1700" }] }))
      .toEqual({ instruction: undefined, values: new Map([["f2", "later"]]) });
  });

  it("is a no-op when there was no overlay", () => {
    expect(editsAfterSave(undefined, { values: [] })).toBeNull();
  });
});

// #283: removing a step from a LOCKED revision cuts N+1 server-side, and `workingRevision` copies
// EVERY step — including the one about to be deleted — so the returned mapping carried
// `removedId -> copy`. The call site ran `remapDrafts` FIRST, moving the removed step's draft onto
// that copy (which the same transaction had deleted), and the following `dropDrafts([stepId])` then
// deleted a key holding nothing. The draft survived under a dead id, and the registration counts an
// edit key with no entry in `originals` as dirty — so the page stayed unsaved with nothing on
// screen able to clear it. The comment above the two calls asserted the opposite rationale.
//
// Both halves are fixed and both are pinned: the server no longer returns an entry pointing at the
// row it deleted (tests/part-process-steps.test.ts), and the ordering is no longer a call-site
// choice. Every fixture below carries a NON-EMPTY mapping on purpose — with `{}` the remap
// early-returns and the buggy order passes identically, which is the vacuous shape this repo
// refiles.
describe("dropStepEdits", () => {
  const edits = (ids: string[]) => new Map(ids.map((id) => [id, { values: new Map() } as StepEdits]));

  it("drops the named keys and keeps the rest", () => {
    expect([...dropStepEdits(edits(["a", "b", "c"]), ["b"]).keys()]).toEqual(["a", "c"]);
  });

  it("hands back the SAME map when nothing matches, so React bails out", () => {
    const cur = edits(["a"]);
    expect(dropStepEdits(cur, ["gone"])).toBe(cur);
    expect(dropStepEdits(cur, [])).toBe(cur);
  });

  it('"all" empties it, and is a no-op on an already-empty map', () => {
    expect(dropStepEdits(edits(["a", "b"]), "all").size).toBe(0);
    const empty = edits([]);
    expect(dropStepEdits(empty, "all")).toBe(empty);
  });
});

describe("remapStepEdits", () => {
  const edits = (ids: string[]) => new Map(ids.map((id) => [id, { values: new Map() } as StepEdits]));

  it("re-keys through the mapping and keeps an unmapped key under its own name", () => {
    // Keeping the unmapped key is the Codex PR #22 behaviour the remap exists for — a step the cut
    // did not touch must not lose its draft. Mutation-proof: drop the `?? stepId` fallback and the
    // "c" entry disappears.
    const next = remapStepEdits(edits(["a", "c"]), { a: "a2" });
    expect([...next.keys()].sort()).toEqual(["a2", "c"]);
  });

  it("an empty mapping is a no-op — the no-cut branch", () => {
    const cur = edits(["a"]);
    expect(remapStepEdits(cur, {})).toBe(cur);
  });
});

describe("stepEditsAfterRemoval", () => {
  const edits = (ids: string[]) => new Map(ids.map((id) => [id, { values: new Map() } as StepEdits]));

  it("THE DEFECT: the removed step's draft goes, even though the cut mapping names it", () => {
    // The #283 fixture exactly: a cut happened, and the mapping still carries the removed step.
    // Mutation-proof: swap the composition to `dropStepEdits(remapStepEdits(...), [removed])` and
    // "x2" survives — a draft keyed on a step that no longer exists on any revision, which is what
    // held the page unsaved forever.
    const next = stepEditsAfterRemoval(edits(["x", "y"]), { x: "x2", y: "y2" }, "x");
    expect([...next.keys()]).toEqual(["y2"]);
  });

  it("carries every OTHER step's draft across the cut", () => {
    const next = stepEditsAfterRemoval(edits(["x", "y", "z"]), { x: "x2", y: "y2", z: "z2" }, "x");
    expect([...next.keys()].sort()).toEqual(["y2", "z2"]);
  });

  it("still drops the removed step when no cut happened (empty mapping)", () => {
    // The everyday, unlocked-revision path. Nothing here exercises the remap, so a fix that only
    // reordered the two would still have to keep this green.
    expect([...stepEditsAfterRemoval(edits(["x", "y"]), {}, "x").keys()]).toEqual(["y"]);
  });

  it("drops the removed step even if the server still names it in the mapping", () => {
    // Belt: `removeStep` now prunes the entry pointing at the row it deleted, but the client must
    // not DEPEND on that — the drop happens first, so there is nothing left for the remap to move.
    const next = stepEditsAfterRemoval(edits(["x"]), { x: "dead-copy" }, "x");
    expect(next.size).toBe(0);
  });
});

// The call-site half — the pure functions can be perfect and simply never called, which is the
// state #283 filed. Checked at the source, the `QuoteDetail break-draft prune sites` precedent in
// tests/break-drafts.test.ts.
describe("ProcessStepsSection step-draft call sites", () => {
  const src = readFileSync(join(process.cwd(), "src/app/parts/[id]/ProcessStepsSection.tsx"), "utf8");
  const fn = (name: string) => {
    const m = new RegExp(`function ${name}\\([\\s\\S]*?\\n  \\}`).exec(src);
    expect(m, `${name}() not found — update this sweep alongside the rename`).not.toBeNull();
    return m![0];
  };

  it("removeStepAction drops and remaps in ONE call, never as two it could mis-order", () => {
    const body = fn("removeStepAction");
    expect(body).toMatch(/stepEditsAfterRemoval\(cur, res\.stepIdMap, stepId\)/);
    // The pair that produced #283 must not come back alongside it.
    expect(body).not.toMatch(/\bremapDrafts\(/);
    expect(body).not.toMatch(/\bdropDrafts\(/);
  });

  it("the mutators that only re-key still remap — the PR #22 carry is not dropped by this change", () => {
    // Named individually rather than counted: a count passes when one is deleted and another added.
    for (const name of ["saveStep", "addStepAction", "move"]) {
      expect(fn(name), `${name} must still carry drafts across a cut`).toMatch(/remapDrafts\(res\.stepIdMap\)/);
    }
  });

  it("loadTemplateAction still drops every draft — the recipe it replaces orphans them all", () => {
    expect(fn("loadTemplateAction")).toMatch(/dropDrafts\("all"\)/);
  });
});
