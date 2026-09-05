import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  breakDraftStarted, dropBreakDrafts, patchBreakDraft, priceKeysOf, retainBreakDrafts,
  EMPTY_BREAK_DRAFT, type BreakDrafts,
} from "@/lib/break-drafts";

// The un-added quantity-break drafts behind QuoteDetail, extracted so they can be tested at all:
// the vitest environment is "node" with no DOM, so the component itself is out of reach — the
// step-drafts.ts / field-drafts.ts precedent. (ProcessStepsSection's own `dropDrafts`, the shape
// this clones, stayed inline and consequently has no unit test anywhere.)
//
// The defect these exist for is #278: a started break draft whose price row was then removed kept
// `breakDraftStarted` true forever, arming the navigation guard from a page with no control able
// to clear it — the Add-break inputs that could blank it were unmounted with the row. Every
// assertion below is written so that deleting the prune it names turns it RED; the composed
// "the defect itself" cases at the bottom of each describe are the ones that do that most directly.

const started = { threshold: "100", price: "9.50" };
const blank = { threshold: "", price: "" };
const drafts = (o: Record<string, { threshold: string; price: string }>): BreakDrafts => o;

describe("breakDraftStarted", () => {
  it("is armed by a draft holding either field", () => {
    expect(breakDraftStarted(drafts({ p1: started }))).toBe(true);
    expect(breakDraftStarted(drafts({ p1: { threshold: "100", price: "" } }))).toBe(true);
    expect(breakDraftStarted(drafts({ p1: { threshold: "", price: "9.50" } }))).toBe(true);
  });

  it("is empty-content, NOT key-count — a cleared input leaves a blank entry behind", () => {
    // Mutation-proof: rewritten as `Object.keys(drafts).length > 0` this reds, and the page would
    // report unsaved changes for every price row whose Add-break inputs had ever been touched.
    expect(breakDraftStarted(drafts({ p1: blank, p2: blank }))).toBe(false);
    expect(breakDraftStarted(drafts({}))).toBe(false);
  });

  it("treats a whitespace-only draft as unstarted", () => {
    expect(breakDraftStarted(drafts({ p1: { threshold: "   ", price: "\t" } }))).toBe(false);
  });
});

describe("dropBreakDrafts", () => {
  it("removes exactly the named keys and leaves every sibling untouched", () => {
    const cur = drafts({ p1: started, p2: { threshold: "5", price: "1" }, p3: blank });
    const next = dropBreakDrafts(cur, ["p1", "p3"]);
    expect(Object.keys(next).sort()).toEqual(["p2"]);
    expect(next.p2).toEqual({ threshold: "5", price: "1" });
  });

  it("drops a whole line's worth of keys in one call", () => {
    const cur = drafts({ a1: started, a2: started, b1: started });
    expect(Object.keys(dropBreakDrafts(cur, ["a1", "a2"]))).toEqual(["b1"]);
  });

  it("hands back the SAME object when no named key is present, so React bails out", () => {
    // Mutation-proof: delete the `!priceKeys.some(...)` bailout and this reds — every removal of an
    // unrelated row would mint a new record and re-render.
    const cur = drafts({ p1: started });
    expect(dropBreakDrafts(cur, ["gone"])).toBe(cur);
    expect(dropBreakDrafts(cur, [])).toBe(cur);
  });

  it('"all" empties the record, and is a no-op on an already-empty one', () => {
    const cur = drafts({ p1: started, p2: blank });
    expect(dropBreakDrafts(cur, "all")).toEqual({});
    const empty = drafts({});
    expect(dropBreakDrafts(empty, "all")).toBe(empty);
  });

  it("never mutates the record it was handed", () => {
    const cur = drafts({ p1: started, p2: started });
    dropBreakDrafts(cur, ["p1"]);
    dropBreakDrafts(cur, "all");
    expect(Object.keys(cur).sort()).toEqual(["p1", "p2"]);
  });

  it("THE DEFECT: a started draft stops arming the guard once its price row is dropped", () => {
    // #278 in one line. Mutation-proof: remove the `setBreakDrafts(... dropBreakDrafts ...)` call
    // from removePrice/removeLine and the page is left exactly as this asserts it must not be —
    // started, with no live row and no input able to blank it.
    const cur = drafts({ p1: started });
    expect(breakDraftStarted(cur)).toBe(true);
    expect(breakDraftStarted(dropBreakDrafts(cur, ["p1"]))).toBe(false);
  });
});

describe("retainBreakDrafts", () => {
  it("drops a draft whose price key did not survive the new tree", () => {
    const cur = drafts({ "new-3": started, p1: started });
    expect(Object.keys(retainBreakDrafts(cur, ["p1"]))).toEqual(["p1"]);
  });

  it("KEEPS a draft whose price key is still live — an intersection, never a reset", () => {
    // Mutation-proof and the load-bearing direction: rewritten as a wholesale clear this reds, and
    // close/reopen/attach-part — all reachable with a draft typed, since `dirty` excludes break
    // drafts — would silently destroy typed work that exists in no payload and no other state.
    const cur = drafts({ p1: started, p2: started });
    const next = retainBreakDrafts(cur, ["p1", "p2", "p3"]);
    expect(next).toBe(cur);
    expect(next.p1).toEqual(started);
  });

  it("hands back the SAME object when every draft is live", () => {
    const cur = drafts({ p1: started });
    expect(retainBreakDrafts(cur, ["p1"])).toBe(cur);
    expect(retainBreakDrafts(drafts({}), [])).toEqual({});
  });

  it("accepts a Set as well as an array of live keys", () => {
    const cur = drafts({ p1: started, gone: started });
    expect(Object.keys(retainBreakDrafts(cur, new Set(["p1"])))).toEqual(["p1"]);
  });

  it("never mutates the record it was handed", () => {
    const cur = drafts({ p1: started, gone: started });
    retainBreakDrafts(cur, ["p1"]);
    expect(Object.keys(cur).sort()).toEqual(["gone", "p1"]);
  });

  it("THE DEFECT, save-adopt shape: a client-added row's draft stops arming the guard once the server re-keys it", () => {
    // A break typed on a price row added client-side sits under a minted `new-N` key; the save's
    // adopt re-keys every price to its server id, so nothing on screen can ever reach that draft
    // again. Same for a row the server re-mints because its step code changed. Neither passes
    // through removePrice or removeLine, which is why the removal-site drops alone do not close
    // #278 — mutation-proof: delete the retain call in `adopt` and this reds.
    const cur = drafts({ "new-3": started });
    expect(breakDraftStarted(cur)).toBe(true);
    expect(breakDraftStarted(retainBreakDrafts(cur, ["p9"]))).toBe(false);
  });
});

describe("priceKeysOf", () => {
  it("flattens every price key across every line", () => {
    expect(priceKeysOf([
      { prices: [{ key: "a1" }, { key: "a2" }] },
      { prices: [] },
      { prices: [{ key: "b1" }] },
    ])).toEqual(["a1", "a2", "b1"]);
  });

  it("is empty for an empty tree", () => {
    expect(priceKeysOf([])).toEqual([]);
  });
});

describe("patchBreakDraft", () => {
  it("seeds a blank draft for a key it has not seen", () => {
    expect(patchBreakDraft(drafts({}), "p1", "threshold", "100"))
      .toEqual({ p1: { threshold: "100", price: "" } });
  });

  it("merges onto the record it was PASSED, not a copy read elsewhere", () => {
    // Mutation-proof for the latent bug this replaced: the inline onChange merged onto the draft
    // read from the render closure, so two writes batched into one tick dropped a field. Chaining
    // both fields through the same record is what that shape cannot survive — ignore `cur` and
    // seed blank instead, and the threshold is lost here.
    const once = patchBreakDraft(drafts({}), "p1", "threshold", "100");
    const twice = patchBreakDraft(once, "p1", "price", "9.50");
    expect(twice.p1).toEqual({ threshold: "100", price: "9.50" });
  });

  it("leaves other rows' drafts alone and never mutates the record it was handed", () => {
    const cur = drafts({ p1: started, p2: blank });
    const next = patchBreakDraft(cur, "p2", "threshold", "7");
    expect(next.p1).toEqual(started);
    expect(cur.p2).toEqual(blank);
  });

  it("EMPTY_BREAK_DRAFT is the same blank the component's lookup falls back to", () => {
    expect(EMPTY_BREAK_DRAFT).toEqual({ threshold: "", price: "" });
    expect(breakDraftStarted(drafts({ p1: EMPTY_BREAK_DRAFT }))).toBe(false);
  });
});

// The call-site half. The pure functions above can be perfect and simply never called — which is
// precisely the state #278 filed — and no assertion on their return values could tell the two
// apart. Checked at the source, the `serial-range expansion call sites` precedent in
// bulk-grid.test.ts.
describe("QuoteDetail break-draft prune sites", () => {
  const src = readFileSync(join(process.cwd(), "src/app/quotes/[id]/QuoteDetail.tsx"), "utf8");
  const fn = (name: string) => {
    const m = new RegExp(`function ${name}\\([\\s\\S]*?\\n  \\}`).exec(src);
    expect(m, `${name}() not found — update this sweep alongside the rename`).not.toBeNull();
    return m![0];
  };

  it("removePrice drops the removed row's own draft", () => {
    expect(fn("removePrice")).toMatch(/dropBreakDrafts\(cur, \[priceKey\]\)/);
  });

  it("removeLine drops every price key on the line, not a single key", () => {
    const body = fn("removeLine");
    expect(body).toMatch(/dropBreakDrafts\(cur, priceKeysOf\(\[line\]\)\)/);
  });

  it("discardChanges clears them all — the control that must be able to clear the guard", () => {
    expect(fn("discardChanges")).toMatch(/dropBreakDrafts\(cur, "all"\)/);
  });

  it("adopt INTERSECTS against the tree it installed, and never clears wholesale", () => {
    // The direction matters more than the presence: `"all"` here would discard a live draft on
    // every close/reopen/attach-part, all of which adopt a detail carrying identical price ids.
    const adopt = /const adopt = useCallback\([\s\S]*?\n  \}, \[\]\);/.exec(src);
    expect(adopt, "adopt() not found — update this sweep alongside the rename").not.toBeNull();
    expect(adopt![0]).toMatch(/retainBreakDrafts\(cur, priceKeysOf\(next\)\)/);
    expect(adopt![0]).not.toMatch(/dropBreakDrafts/);
  });

  it("the Discard control is enabled by a started draft, and the Save badge is not", () => {
    // The asymmetry is deliberate (the SaveButton `alsoUnsaved` precedent) and easy to "tidy" into
    // agreement, in either direction: badging work Save cannot send reads as a broken control,
    // while a Discard that cannot be pressed is the #278 shape all over again.
    expect(src).toMatch(/disabled=\{!dirty && !breakDraftStarted\}/);
    expect(src).toMatch(/\{dirty && <span className="text-xs text-amber-700">Unsaved changes<\/span>\}/);
  });
});
