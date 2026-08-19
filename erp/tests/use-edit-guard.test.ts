import { describe, it, expect, vi } from "vitest";
import type { FocusEvent } from "react";
import { makeEditGuard } from "@/lib/use-edit-guard";

// #149 (Group H2 Task 1). The leaf had NO suite of its own — the scalar guard shipped in the
// fix-wave notes-clobber trio and was pinned only by its consumers' behavior in E2E. This file
// pins the scalar contract FIRST (so the keyed variant provably changes none of it), then drives
// the row-scoped keyed variant for array state (customers' address/contact rows). Pure leaf, no
// DB, fully synchronous — the `use-latest.test.ts` shape; the guard's inputs are focus/blur
// events, faked below the way the pages' inputs would deliver them.

/** A focus/blur event carrying only what the guard reads: the target's current value. */
const ev = (value: string) => ({ target: { value } }) as unknown as FocusEvent<HTMLInputElement>;

describe("makeEditGuard — the scalar guard (pinned pre-#149 behavior)", () => {
  it("no focused field: an incoming detail lands wholesale", () => {
    const g = makeEditGuard();
    const cur = { notes: "local", po: "p0" };
    const incoming = { notes: "server", po: "p1" };
    expect(g.merge(cur, incoming)).toBe(incoming);
  });

  it("cur === null (first load): incoming lands wholesale even while a field is focused", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("typing"));
    const incoming = { notes: "server" };
    expect(g.merge(null, incoming)).toBe(incoming);
  });

  it("a focused-and-dirty field survives the merge; every sibling refreshes", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a")); // the box showed "a" on entry
    const cur = { notes: "ab", po: "p0" }; // the user typed since focus
    const incoming = { notes: "server", po: "p1" };
    expect(g.merge(cur, incoming)).toEqual({ notes: "ab", po: "p1" });
  });

  it("a focused-but-untouched field takes the server value and re-snapshots the no-op guard", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const cur = { notes: "a", po: "p0" }; // untouched since focus
    const incoming = { notes: "server", po: "p1" };
    expect(g.merge(cur, incoming)).toBe(incoming);
    // The guard re-snapshotted against what the box now shows: blurring without typing is still
    // a no-op — a later blur must not "save" a change the user never typed.
    const commit = vi.fn();
    g.onBlurSave(ev("server"), commit);
    expect(commit).not.toHaveBeenCalled();
  });

  it("a blurred field takes the incoming value — the slot is released on blur", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const commit = vi.fn();
    g.onBlurSave(ev("ab"), commit); // genuine change: commits and clears the slot
    expect(commit).toHaveBeenCalledWith("ab", "a");
    const cur = { notes: "ab", po: "p0" };
    const incoming = { notes: "server", po: "p1" };
    expect(g.merge(cur, incoming)).toBe(incoming);
  });

  it("one slot: focusing a second field releases the first (the DOM's single-focus model)", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    g.onFocusField("po")(ev("p0")); // focus moved; only `po` is under the cursor now
    const cur = { notes: "ab", po: "p0-typed" }; // both differ from server; only po is dirty-since-focus
    const incoming = { notes: "server", po: "p-server" };
    expect(g.merge(cur, incoming)).toEqual({ notes: "server", po: "p0-typed" });
  });

  it("onFocusField(null): blur no-op guard only — the merge is not intercepted", () => {
    const g = makeEditGuard();
    g.onFocusField(null)(ev("cell"));
    const cur = { notes: "local" };
    const incoming = { notes: "server" };
    expect(g.merge(cur, incoming)).toBe(incoming); // no key registered: wholesale
    const commit = vi.fn();
    g.onBlurSave(ev("cell"), commit); // unchanged: no-op
    expect(commit).not.toHaveBeenCalled();
  });

  it("onBlurSave: no-op when unchanged, commits (value, atFocus) when changed", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const noop = vi.fn();
    g.onBlurSave(ev("a"), noop);
    expect(noop).not.toHaveBeenCalled();
    g.onFocusField("notes")(ev("a"));
    const commit = vi.fn();
    g.onBlurSave(ev("b"), commit);
    expect(commit).toHaveBeenCalledWith("b", "a");
  });

  it("onBlurSave trim: mirrors a server-side .trim() so add-and-remove-a-space is a no-op", () => {
    const g = makeEditGuard();
    g.onFocusField("name")(ev("x"));
    const noop = vi.fn();
    g.onBlurSave(ev(" x "), noop, { trim: true });
    expect(noop).not.toHaveBeenCalled();
    g.onFocusField("name")(ev("x"));
    const commit = vi.fn();
    g.onBlurSave(ev(" y "), commit, { trim: true });
    expect(commit).toHaveBeenCalledWith("y", "x");
  });

  it("the string lens: a numeric field loaded as a number still reads as what the box showed", () => {
    const g = makeEditGuard();
    g.onFocusField("qty")(ev("5")); // the input rendered String(5)
    const cur = { qty: 5 as number | string };
    const incoming = { qty: 7 as number | string };
    // Untouched since focus (String(5) === "5"): server truth lands, guard re-snapshots to "7".
    expect(g.merge(cur, incoming)).toBe(incoming);
    const commit = vi.fn();
    g.onBlurSave(ev("7"), commit);
    expect(commit).not.toHaveBeenCalled();
  });

  it("a focused key absent from the incoming payload: incoming lands wholesale", () => {
    const g = makeEditGuard();
    g.onFocusField("ghost")(ev("a"));
    const cur = { notes: "local" } as Record<string, string>;
    const incoming = { notes: "server" } as Record<string, string>;
    expect(g.merge(cur, incoming)).toBe(incoming);
  });
});
