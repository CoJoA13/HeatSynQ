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

// The keyed variant (#149): array state keyed by row id + field — the customers page's address/
// contact rows, whose cells previously registered only the blur no-op guard (onFocusField(null))
// and so had NO mid-typing protection when applyDetail's setAddresses/setContacts landed a fresh
// server array over them. One focused slot still serves both variants: the DOM has one focused
// element, so a cell registration and a scalar registration displace each other.
describe("makeEditGuard — the keyed variant (mergeRows)", () => {
  type Row = { id: string; name: string; street: string };
  const rows = (over: Partial<Record<"r1" | "r2", Partial<Row>>> = {}): Row[] => [
    { id: "r1", name: "n1", street: "s1", ...over.r1 },
    { id: "r2", name: "n2", street: "s2", ...over.r2 },
  ];

  it("no focused cell: an incoming array lands wholesale", () => {
    const g = makeEditGuard();
    const incoming = rows();
    expect(g.mergeRows(rows(), incoming)).toBe(incoming);
  });

  it("a focused-and-dirty cell keeps its local value; sibling fields, rows, and additions refresh", () => {
    const g = makeEditGuard();
    g.onFocusCell("r1", "name")(ev("n1")); // the box showed "n1" on entry
    const cur = rows({ r1: { name: "n1-typed" } }); // typed since focus
    const incoming = [...rows({ r1: { name: "SERVER", street: "S1" }, r2: { name: "N2" } }),
      { id: "r3", name: "n3", street: "s3" }];
    expect(g.mergeRows(cur, incoming)).toEqual([
      { id: "r1", name: "n1-typed", street: "S1" }, // the cell under the cursor survives; its row refreshes
      { id: "r2", name: "N2", street: "s2" },
      { id: "r3", name: "n3", street: "s3" },
    ]);
  });

  it("matched by row id, not index: a reordered payload still preserves the right cell", () => {
    const g = makeEditGuard();
    g.onFocusCell("r1", "name")(ev("n1"));
    const cur = rows({ r1: { name: "n1-typed" } });
    const incoming = [
      { id: "r2", name: "N2", street: "S2" },
      { id: "r1", name: "SERVER", street: "S1" },
    ];
    expect(g.mergeRows(cur, incoming)).toEqual([
      { id: "r2", name: "N2", street: "S2" },
      { id: "r1", name: "n1-typed", street: "S1" },
    ]);
  });

  it("a focused-but-untouched cell takes the server value and re-snapshots the no-op guard", () => {
    const g = makeEditGuard();
    g.onFocusCell("r1", "name")(ev("n1"));
    const incoming = rows({ r1: { name: "SERVER" } });
    expect(g.mergeRows(rows(), incoming)).toBe(incoming);
    // Blurring without typing stays a no-op against what the box now shows.
    const commit = vi.fn();
    g.onBlurSave(ev("SERVER"), commit);
    expect(commit).not.toHaveBeenCalled();
  });

  it("the focused row disappearing from the payload: the payload lands as-is", () => {
    const g = makeEditGuard();
    g.onFocusCell("r1", "name")(ev("n1"));
    const cur = rows({ r1: { name: "n1-typed" } });
    const incoming = [{ id: "r2", name: "N2", street: "S2" }]; // r1 deleted server-side
    expect(g.mergeRows(cur, incoming)).toBe(incoming);
  });

  it("a disappeared row RELEASES the slot: a same-id row re-entering later merges clean", () => {
    const g = makeEditGuard();
    g.onFocusCell("r1", "name")(ev("n1"));
    // r1 vanishes (soft-deleted, or hidden by a show-inactive toggle's refetch): lands as-is,
    // and once this payload applies the cell's input unmounts with no React blur — only
    // guard-REGISTERED focus/blur replaces the slot (checkboxes, selects, and buttons never
    // touch it), so the guard must release the registration itself.
    const afterDelete = [{ id: "r2", name: "N2", street: "S2" }];
    expect(g.mergeRows(rows({ r1: { name: "n1-typed" } }), afterDelete)).toBe(afterDelete);
    // The same id re-enters the payload (reactivation / includeInactive refetch — supported
    // flows, not a hard recreate): merges clean…
    const reappeared = [{ id: "r1", name: "BACK", street: "S1" }, ...afterDelete];
    expect(g.mergeRows(afterDelete, reappeared)).toBe(reappeared);
    // …and STAYS clean on the next refresh. Without the release, r1.name ("BACK") compared
    // against the stale at-focus snapshot ("n1") reads as dirty-since-focus and blocks server
    // truth on every merge indefinitely.
    const fresh = [{ id: "r1", name: "NEWER", street: "S1" }, ...afterDelete];
    expect(g.mergeRows(reappeared, fresh)).toBe(fresh);
  });

  it("the focused row missing locally: the payload lands as-is (nothing to preserve)", () => {
    const g = makeEditGuard();
    g.onFocusCell("r9", "name")(ev("x"));
    const incoming = rows();
    expect(g.mergeRows(rows(), incoming)).toBe(incoming);
  });

  it("blur releases the cell slot: commits the change, then arrays land wholesale", () => {
    const g = makeEditGuard();
    g.onFocusCell("r1", "name")(ev("n1"));
    const commit = vi.fn();
    g.onBlurSave(ev("n1-typed"), commit);
    expect(commit).toHaveBeenCalledWith("n1-typed", "n1");
    const cur = rows({ r1: { name: "n1-typed" } });
    const incoming = rows({ r1: { name: "SERVER" } });
    expect(g.mergeRows(cur, incoming)).toBe(incoming);
  });

  it("one slot: focusing a second cell releases the first", () => {
    const g = makeEditGuard();
    g.onFocusCell("r1", "name")(ev("n1"));
    g.onFocusCell("r2", "street")(ev("s2"));
    const cur = rows({ r1: { name: "n1-typed" }, r2: { street: "s2-typed" } });
    const incoming = rows({ r1: { name: "N1" }, r2: { street: "S2" } });
    expect(g.mergeRows(cur, incoming)).toEqual(rows({ r1: { name: "N1" }, r2: { street: "s2-typed" } }));
  });

  it("one slot across variants: a cell registration displaces a scalar one, and vice versa", () => {
    const g = makeEditGuard();
    // Scalar focused+dirty: rows are not intercepted…
    g.onFocusField("notes")(ev("a"));
    const incomingRows = rows();
    expect(g.mergeRows(rows({ r1: { name: "n1-typed" } }), incomingRows)).toBe(incomingRows);
    // …and the scalar registration still protects the detail object.
    const merged = g.merge({ notes: "ab" }, { notes: "server" });
    expect(merged).toEqual({ notes: "ab" });
    // Cell focused+dirty: the detail object is not intercepted…
    g.onFocusCell("r1", "name")(ev("n1"));
    const incomingDetail = { notes: "server2" };
    expect(g.merge({ notes: "typed" }, incomingDetail)).toBe(incomingDetail);
    // …and the scalar registration is gone: a cell edit survives its own array merge only.
    expect(g.mergeRows(rows({ r1: { name: "n1-typed" } }), rows({ r1: { name: "N1" } })))
      .toEqual(rows({ r1: { name: "n1-typed", street: "s1" } }));
  });

  it("the string lens applies to cells: a numeric cell held as a number reads as displayed", () => {
    const g = makeEditGuard();
    type NumRow = { id: string; qty: number | string };
    g.onFocusCell("r1", "qty")(ev("5"));
    const cur: NumRow[] = [{ id: "r1", qty: 5 }];
    const incoming: NumRow[] = [{ id: "r1", qty: 7 }];
    expect(g.mergeRows(cur, incoming)).toBe(incoming); // untouched: server truth lands
    const commit = vi.fn();
    g.onBlurSave(ev("7"), commit); // re-snapshotted to what the box now shows
    expect(commit).not.toHaveBeenCalled();
  });

  it("a focused field absent from the incoming row: the payload lands as-is", () => {
    const g = makeEditGuard();
    g.onFocusCell("r1", "ghost")(ev("x"));
    const incoming = rows();
    expect(g.mergeRows(rows(), incoming)).toBe(incoming);
  });
});
