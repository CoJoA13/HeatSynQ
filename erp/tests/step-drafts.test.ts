import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyPendingRekey, buildStepOriginals, dropStepEdits, editsAfterSave, isStepDirty, pendingChanges,
  remapStepEdits, shownInstruction, shownValue, stagePendingRekey, type StepEdits,
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

// #288: the mutation response carries the cut's mapping a full round trip before the reload
// renumbers the rows, because `refreshAfter` only sets `selected` and the detail is fetched by an
// effect. Re-keying on arrival left the overlay and the rendered rows disagreeing about every
// step's name for that whole window — drafts vanished from their inputs, a keystroke landed under a
// pre-cut id nothing could reach again, and the section read dirty on a page nobody had touched.
// The mapping is staged instead, and applied in the same commit that installs the new rows.
describe("stagePendingRekey", () => {
  it("stages nothing when no cut happened", () => {
    // The everyday amend-in-place path. Mutation-proof: drop the empty-map guard and a no-cut
    // mutation stages a mapping that would later re-key the overlay to nothing.
    expect(stagePendingRekey(null, 3, {})).toBeNull();
    const held = { toRevision: 2, map: { a: "a2" } };
    expect(stagePendingRekey(held, 2, {})).toBe(held);
  });

  it("records the mapping against the revision it produced", () => {
    expect(stagePendingRekey(null, 2, { a: "a2" })).toEqual({ toRevision: 2, map: { a: "a2" } });
  });

  it("COMPOSES across two cuts, so a draft two cuts behind still resolves", () => {
    // Mutation-proof: replace the composition with a plain merge and `a` still points at `a2`,
    // a revision that no longer exists — the draft would be re-keyed onto nothing.
    const first = stagePendingRekey(null, 2, { a: "a2" });
    const second = stagePendingRekey(first, 3, { a2: "a3" });
    expect(second).toEqual({ toRevision: 3, map: { a: "a3", a2: "a3" } });
  });
});

describe("applyPendingRekey", () => {
  const edits = (ids: string[]) => new Map(ids.map((id) => [id, { values: new Map() } as StepEdits]));

  it("THE DEFECT: nothing is re-keyed until the rows it belongs to land", () => {
    // The window itself. Mutation-proof: make the mutators re-key on arrival again (or drop the
    // revision check here) and the overlay moves to `a2` while the rows still render `a` — every
    // draft invisible, and any keystroke stranded under `a`.
    const cur = edits(["a"]);
    const pending = { toRevision: 2, map: { a: "a2" } };
    const early = applyPendingRekey(cur, pending, 1);
    expect([...early.edits.keys()], "a rev-1 landing must not consume a rev-2 mapping").toEqual(["a"]);
    expect(early.pending, "and must leave it staged for when rev 2 does land").toBe(pending);
  });

  it("applies exactly once, at its own revision, and clears the stage", () => {
    // Clearing matters: a stage left set would re-key a second time on the next load, moving every
    // draft onto ids that mean nothing. Mutation-proof: return the pending unchanged and this reds.
    const applied = applyPendingRekey(edits(["a", "b"]), { toRevision: 2, map: { a: "a2" } }, 2);
    expect([...applied.edits.keys()].sort()).toEqual(["a2", "b"]);
    expect(applied.pending).toBeNull();
  });

  it("a detour to an older revision and back still lands the mapping", () => {
    // The staged mapping WAITS rather than being discarded — the picker can move away and come
    // back, and the drafts must survive the round trip.
    const cur = edits(["a"]);
    const pending = { toRevision: 3, map: { a: "a3" } };
    const detour = applyPendingRekey(cur, pending, 1);
    const back = applyPendingRekey(detour.edits, detour.pending, 3);
    expect([...back.edits.keys()]).toEqual(["a3"]);
    expect(back.pending).toBeNull();
  });

  it("is a no-op when nothing is staged", () => {
    const cur = edits(["a"]);
    const res = applyPendingRekey(cur, null, 2);
    expect(res.edits).toBe(cur);
    expect(res.pending).toBeNull();
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

  it("removeStepAction drops EAGERLY and only stages the re-key (#283 + #288)", () => {
    // Eager is load-bearing: the overlay is still in the rendered rows' key space at that moment,
    // so `stepId` names exactly the entry to remove. Deferring the drop would leave a draft alive
    // on a row the server has already destroyed — the guard-nobody-can-clear shape of #283.
    const body = fn("removeStepAction");
    expect(body).toMatch(/dropDrafts\(\[stepId\]\)/);
    expect(body).toMatch(/stageRekey\(res\)/);
  });

  it("every mutator STAGES its mapping — none re-keys the overlay on arrival (#288)", () => {
    // Named individually rather than counted: a count passes when one is deleted and another added.
    // The PR #22 carry is preserved — the mapping is still applied, just at the landing.
    for (const name of ["saveStep", "addStepAction", "removeStepAction", "move"]) {
      expect(fn(name), `${name} must stage its mapping`).toMatch(/stageRekey\(res\)/);
      expect(fn(name), `${name} must not re-key the overlay on arrival`).not.toMatch(/remapStepEdits\(/);
    }
  });

  it("loadDetail applies the staged mapping in the same commit that installs the rows", () => {
    // The pairing IS the fix. Mutation-proof: move the apply out of loadDetail and the overlay and
    // the rows change key space at different moments again, which is #288.
    const load = /const loadDetail = useCallback\([\s\S]*?\n  \}, \[/.exec(src);
    expect(load, "loadDetail not found — update this sweep alongside the rename").not.toBeNull();
    expect(load![0]).toMatch(/applyPendingRekey\(cur, pendingRekey\.current, data\.revisionNumber\)/);
    expect(load![0]).toMatch(/setDetail\(data\)/);
  });

  it("loadTemplateAction still drops every draft — the recipe it replaces orphans them all", () => {
    expect(fn("loadTemplateAction")).toMatch(/dropDrafts\("all"\)/);
  });
});
