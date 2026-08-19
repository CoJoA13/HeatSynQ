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
    g.noteMerged(incoming); // the paired companion (round 2) — the transition lives here now
    // The guard snapshotted what the box now shows: blurring without typing is still a no-op —
    // a later blur must not "save" a change the user never typed.
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
    // Untouched since focus (String(5) === "5"): server truth lands; the paired companion
    // snapshots "7" so the box's new text blurs to a no-op.
    expect(g.merge(cur, incoming)).toBe(incoming);
    g.noteMerged(incoming);
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
    expect(g.mergeRows("rows", rows(), incoming)).toBe(incoming);
  });

  it("a focused-and-dirty cell keeps its local value; sibling fields, rows, and additions refresh", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r1", "name")(ev("n1")); // the box showed "n1" on entry
    const cur = rows({ r1: { name: "n1-typed" } }); // typed since focus
    const incoming = [...rows({ r1: { name: "SERVER", street: "S1" }, r2: { name: "N2" } }),
      { id: "r3", name: "n3", street: "s3" }];
    expect(g.mergeRows("rows", cur, incoming)).toEqual([
      { id: "r1", name: "n1-typed", street: "S1" }, // the cell under the cursor survives; its row refreshes
      { id: "r2", name: "N2", street: "s2" },
      { id: "r3", name: "n3", street: "s3" },
    ]);
  });

  it("matched by row id, not index: a reordered payload still preserves the right cell", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r1", "name")(ev("n1"));
    const cur = rows({ r1: { name: "n1-typed" } });
    const incoming = [
      { id: "r2", name: "N2", street: "S2" },
      { id: "r1", name: "SERVER", street: "S1" },
    ];
    expect(g.mergeRows("rows", cur, incoming)).toEqual([
      { id: "r2", name: "N2", street: "S2" },
      { id: "r1", name: "n1-typed", street: "S1" },
    ]);
  });

  it("a focused-but-untouched cell takes the server value and re-snapshots the no-op guard", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r1", "name")(ev("n1"));
    const incoming = rows({ r1: { name: "SERVER" } });
    expect(g.mergeRows("rows", rows(), incoming)).toBe(incoming);
    g.noteMergedRows("rows", incoming); // the paired companion (round 2)
    // Blurring without typing stays a no-op against what the box now shows.
    const commit = vi.fn();
    g.onBlurSave(ev("SERVER"), commit);
    expect(commit).not.toHaveBeenCalled();
  });

  it("the focused row disappearing from the payload: the payload lands as-is", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r1", "name")(ev("n1"));
    const cur = rows({ r1: { name: "n1-typed" } });
    const incoming = [{ id: "r2", name: "N2", street: "S2" }]; // r1 deleted server-side
    expect(g.mergeRows("rows", cur, incoming)).toBe(incoming);
  });

  it("a disappeared row RELEASES the slot: a same-id row re-entering later merges clean", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r1", "name")(ev("n1"));
    // r1 vanishes (soft-deleted, or hidden by a show-inactive toggle's refetch): lands as-is,
    // and once this payload applies the cell's input unmounts with no React blur — only
    // guard-REGISTERED focus/blur replaces the slot (checkboxes, selects, and buttons never
    // touch it), so the guard must release the registration itself.
    const afterDelete = [{ id: "r2", name: "N2", street: "S2" }];
    expect(g.mergeRows("rows", rows({ r1: { name: "n1-typed" } }), afterDelete)).toBe(afterDelete);
    g.noteMergedRows("rows", afterDelete); // round 2: the paired companion performs the release
    // The same id re-enters the payload (reactivation / includeInactive refetch — supported
    // flows, not a hard recreate): merges clean…
    const reappeared = [{ id: "r1", name: "BACK", street: "S1" }, ...afterDelete];
    expect(g.mergeRows("rows", afterDelete, reappeared)).toBe(reappeared);
    // …and STAYS clean on the next refresh. Without the release, r1.name ("BACK") compared
    // against the stale at-focus snapshot ("n1") reads as dirty-since-focus and blocks server
    // truth on every merge indefinitely.
    const fresh = [{ id: "r1", name: "NEWER", street: "S1" }, ...afterDelete];
    expect(g.mergeRows("rows", reappeared, fresh)).toBe(fresh);
  });

  it("the focused row missing locally: the payload lands as-is (nothing to preserve)", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r9", "name")(ev("x"));
    const incoming = rows();
    expect(g.mergeRows("rows", rows(), incoming)).toBe(incoming);
  });

  it("blur releases the cell slot: commits the change, then arrays land wholesale", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r1", "name")(ev("n1"));
    const commit = vi.fn();
    g.onBlurSave(ev("n1-typed"), commit);
    expect(commit).toHaveBeenCalledWith("n1-typed", "n1");
    const cur = rows({ r1: { name: "n1-typed" } });
    const incoming = rows({ r1: { name: "SERVER" } });
    expect(g.mergeRows("rows", cur, incoming)).toBe(incoming);
  });

  it("one slot: focusing a second cell releases the first", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r1", "name")(ev("n1"));
    g.onFocusCell("rows", "r2", "street")(ev("s2"));
    const cur = rows({ r1: { name: "n1-typed" }, r2: { street: "s2-typed" } });
    const incoming = rows({ r1: { name: "N1" }, r2: { street: "S2" } });
    expect(g.mergeRows("rows", cur, incoming)).toEqual(rows({ r1: { name: "N1" }, r2: { street: "s2-typed" } }));
  });

  it("one slot across variants: a cell registration displaces a scalar one, and vice versa", () => {
    const g = makeEditGuard();
    // Scalar focused+dirty: rows are not intercepted…
    g.onFocusField("notes")(ev("a"));
    const incomingRows = rows();
    expect(g.mergeRows("rows", rows({ r1: { name: "n1-typed" } }), incomingRows)).toBe(incomingRows);
    // …and the scalar registration still protects the detail object.
    const merged = g.merge({ notes: "ab" }, { notes: "server" });
    expect(merged).toEqual({ notes: "ab" });
    // Cell focused+dirty: the detail object is not intercepted…
    g.onFocusCell("rows", "r1", "name")(ev("n1"));
    const incomingDetail = { notes: "server2" };
    expect(g.merge({ notes: "typed" }, incomingDetail)).toBe(incomingDetail);
    // …and the scalar registration is gone: a cell edit survives its own array merge only.
    expect(g.mergeRows("rows", rows({ r1: { name: "n1-typed" } }), rows({ r1: { name: "N1" } })))
      .toEqual(rows({ r1: { name: "n1-typed", street: "s1" } }));
  });

  it("the string lens applies to cells: a numeric cell held as a number reads as displayed", () => {
    const g = makeEditGuard();
    type NumRow = { id: string; qty: number | string };
    g.onFocusCell("rows", "r1", "qty")(ev("5"));
    const cur: NumRow[] = [{ id: "r1", qty: 5 }];
    const incoming: NumRow[] = [{ id: "r1", qty: 7 }];
    expect(g.mergeRows("rows", cur, incoming)).toBe(incoming); // untouched: server truth lands
    g.noteMergedRows("rows", incoming); // paired companion snapshots what the box now shows
    const commit = vi.fn();
    g.onBlurSave(ev("7"), commit);
    expect(commit).not.toHaveBeenCalled();
  });

  it("a focused field absent from the incoming row: the payload lands as-is", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r1", "ghost")(ev("x"));
    const incoming = rows();
    expect(g.mergeRows("rows", rows(), incoming)).toBe(incoming);
  });
});

// Codex round 1 on PR #154 (P1): the clear-on-absence release is right WITHIN a collection but
// was destructive ACROSS collections. The customers page merges addresses THEN contacts through
// ONE guard slot (applyDetail), and a focused contact's rowId is by definition absent from the
// ADDRESSES array — that absence is not a deletion, yet the unscoped release treated it as one
// and dropped the registration before the contacts merge could protect the cell (the exact #149
// defect back again); in the other direction a protected address lost its registration to the
// contacts merge, so the next payload clobbered it AND blur fired a spurious commit against the
// cleared slot's atFocus "". The cell identity therefore includes its COLLECTION, and mergeRows
// acts on the slot — protecting OR releasing — only for its own collection.
describe("makeEditGuard — cross-collection scoping (Codex PR #154 round 1)", () => {
  type Row = { id: string; name: string; street: string };
  const rows = (over: Partial<Record<"r1" | "r2", Partial<Row>>> = {}): Row[] => [
    { id: "r1", name: "n1", street: "s1", ...over.r1 },
    { id: "r2", name: "n2", street: "s2", ...over.r2 },
  ];
  type ContactRow = { id: string; name: string; phone: string };

  it("a dirty contact cell survives an addresses-then-contacts double merge", () => {
    const g = makeEditGuard();
    g.onFocusCell("contacts", "c1", "name")(ev("Bob"));
    // applyDetail's order: addresses first. c1 is absent from the ADDRESSES array by definition
    // — not a deletion; the slot must pass through untouched.
    const addressesIncoming = rows();
    expect(g.mergeRows("addresses", rows(), addressesIncoming)).toBe(addressesIncoming);
    // Then contacts: the registration is intact, so the dirty cell is still protected.
    const contactsCur: ContactRow[] = [{ id: "c1", name: "Bobby", phone: "p1" }];
    const contactsIncoming: ContactRow[] = [{ id: "c1", name: "SERVER", phone: "P1" }];
    expect(g.mergeRows("contacts", contactsCur, contactsIncoming))
      .toEqual([{ id: "c1", name: "Bobby", phone: "P1" }]);
  });

  it("an unrelated collection's merge leaves the registration — and the blur no-op — intact", () => {
    const g = makeEditGuard();
    g.onFocusCell("addresses", "r1", "name")(ev("n1"));
    // A CONTACTS merge runs while an address cell is focused: r1 absent there by definition.
    const contactsIncoming: ContactRow[] = [{ id: "c1", name: "C", phone: "p" }];
    expect(g.mergeRows("contacts", [], contactsIncoming)).toBe(contactsIncoming);
    // The registration still protects the now-dirty address cell on ITS collection's merge…
    expect(g.mergeRows("addresses", rows({ r1: { name: "n1-typed" } }), rows({ r1: { name: "SRV" } })))
      .toEqual(rows({ r1: { name: "n1-typed" } }));
    // …and the at-focus snapshot survived too: blurring an UNTOUCHED cell after an unrelated
    // merge stays a no-op — a cleared slot would compare "n1" against "" and fire a spurious
    // commit for a change the user never typed.
    const g2 = makeEditGuard();
    g2.onFocusCell("addresses", "r1", "name")(ev("n1"));
    g2.mergeRows("contacts", [], [{ id: "c1", name: "C", phone: "p" }] as ContactRow[]);
    const commit = vi.fn();
    g2.onBlurSave(ev("n1"), commit);
    expect(commit).not.toHaveBeenCalled();
  });

  it("the within-collection release still holds: a genuine deletion in the OWN collection clears the slot", () => {
    const g = makeEditGuard();
    g.onFocusCell("addresses", "r1", "name")(ev("n1"));
    const afterDelete = [{ id: "r2", name: "N2", street: "S2" }];
    expect(g.mergeRows("addresses", rows({ r1: { name: "n1-typed" } }), afterDelete)).toBe(afterDelete);
    g.noteMergedRows("addresses", afterDelete); // the companion owns the release (round 2)
    // Released: a same-id row re-entering merges clean and stays clean (the 9d58d2a contract).
    const reappeared = [{ id: "r1", name: "BACK", street: "S1" }, ...afterDelete];
    expect(g.mergeRows("addresses", afterDelete, reappeared)).toBe(reappeared);
    const fresh = [{ id: "r1", name: "NEWER", street: "S1" }, ...afterDelete];
    expect(g.mergeRows("addresses", reappeared, fresh)).toBe(fresh);
  });
});

// Codex round 2 on PR #154 (P2, controller-broadened to the scalar half): merge/mergeRows ran
// inside React functional setState updaters and MUTATED the slot there — updaters must be pure.
// Strict Mode double-invokes them with the same prev (call 1's in-merge re-snapshot made call 2
// judge an untouched field dirty and preserve stale data), and React can also DEFER an updater
// past the code following the setState (guaranteed for the 2nd/3rd dispatch in one handler —
// customers' applyDetail), so the transition cannot simply run "after the setState" either. The
// fix: merge/mergeRows are PURE (read-only), the transition lives in companion noteMerged/
// noteMergedRows calls made beside the setState, and the untouched-vs-dirty decision tests
// membership in a per-focus-session SNAPSHOT SET (the at-entry value plus every noted server
// value) — a grow-only structure, so the decision is identical whether an updater runs before
// the companion, after it, once, or twice.
describe("makeEditGuard — pure merges + the companion transition (Codex PR #154 round 2)", () => {
  type Row = { id: string; name: string; street: string };
  const rows = (over: Partial<Record<"r1" | "r2", Partial<Row>>> = {}): Row[] => [
    { id: "r1", name: "n1", street: "s1", ...over.r1 },
    { id: "r2", name: "n2", street: "s2", ...over.r2 },
  ];

  it("merge is pure: double-invocation returns identical results and never touches the slot", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const cur = { notes: "a", po: "p0" }; // untouched since focus
    const incoming = { notes: "srv", po: "p1" };
    // Strict Mode shape: the same updater body runs twice with the same prev.
    expect(g.merge(cur, incoming)).toBe(incoming);
    expect(g.merge(cur, incoming)).toBe(incoming); // call 2 must NOT judge "srv" dirty
    // And the slot was not transitioned by merge itself: without the companion, a blur at the
    // server value still reads as a change from the at-entry snapshot.
    const commit = vi.fn();
    g.onBlurSave(ev("srv"), commit);
    expect(commit).toHaveBeenCalledWith("srv", "a");
  });

  it("mergeRows is pure: double-invocation identical; no release happens inside the updater", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r1", "name")(ev("n1"));
    // Untouched cell, changed server value — twice with the same prev:
    const cur = rows();
    const incoming = rows({ r1: { name: "SRV" } });
    expect(g.mergeRows("rows", cur, incoming)).toBe(incoming);
    expect(g.mergeRows("rows", cur, incoming)).toBe(incoming);
    // A row-absent payload through the PURE merge must not release the registration — only the
    // companion may. The still-registered dirty cell stays protected afterwards.
    const absent = [{ id: "r2", name: "N2", street: "S2" }];
    expect(g.mergeRows("rows", rows({ r1: { name: "n1-typed" } }), absent)).toBe(absent);
    expect(g.mergeRows("rows", rows({ r1: { name: "n1-typed" } }), rows({ r1: { name: "S2" } })))
      .toEqual(rows({ r1: { name: "n1-typed" } }));
  });

  it("noteMerged owns the transition: post-note blur no-ops at the server value, commits typed text", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const incoming = { notes: "srv" };
    expect(g.merge({ notes: "a" }, incoming)).toBe(incoming);
    g.noteMerged(incoming);
    const noop = vi.fn();
    g.onBlurSave(ev("srv"), noop); // the box shows what the server sent — not a user change
    expect(noop).not.toHaveBeenCalled();
    // Typed text still commits, and the atFocus argument is the NEWEST snapshot (the last
    // server value the box was given) — the best rollback target for the int-field callers.
    const g2 = makeEditGuard();
    g2.onFocusField("notes")(ev("a"));
    g2.noteMerged({ notes: "srv" });
    const commit = vi.fn();
    g2.onBlurSave(ev("typed"), commit);
    expect(commit).toHaveBeenCalledWith("typed", "srv");
  });

  it("note-BEFORE-updater (a deferred updater) still lands the refresh on an untouched field", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const incoming = { notes: "srv" };
    // React deferred the updater past the companion call (the 2nd/3rd dispatch in a batch):
    g.noteMerged(incoming);
    // The updater then runs with the PRE-refresh prev. The at-entry snapshot is still in the
    // session set, so the untouched field takes server truth — an atFocus overwrite would have
    // judged it dirty here and preserved stale data.
    expect(g.merge({ notes: "a" }, incoming)).toBe(incoming);
  });

  it("keyed note-before-updater: the deferred untouched-cell refresh lands too", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r1", "name")(ev("n1"));
    const incoming = rows({ r1: { name: "SRV" } });
    g.noteMergedRows("rows", incoming);
    expect(g.mergeRows("rows", rows(), incoming)).toBe(incoming);
    const noop = vi.fn();
    g.onBlurSave(ev("SRV"), noop);
    expect(noop).not.toHaveBeenCalled();
  });

  it("two deferred refreshes in a row: the untouched field tracks the newest server value", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const s1 = { notes: "s1" };
    const s2 = { notes: "s2" };
    // Both companions ran before either updater (a batched double-apply):
    g.noteMerged(s1);
    g.noteMerged(s2);
    expect(g.merge({ notes: "a" }, s1)).toBe(s1);   // prev is the pre-refresh value
    expect(g.merge({ notes: "s1" }, s2)).toBe(s2);  // prev is refresh 1's applied value
    const noop = vi.fn();
    g.onBlurSave(ev("s2"), noop);
    expect(noop).not.toHaveBeenCalled();
  });

  it("dirty preserve survives every ordering and double-invocation, then blur commits", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const cur = { notes: "ab" }; // typed since focus
    const incoming = { notes: "srv" };
    g.noteMerged(incoming); // note first (deferred-updater ordering)
    expect(g.merge(cur, incoming)).toEqual({ notes: "ab" });
    expect(g.merge(cur, incoming)).toEqual({ notes: "ab" }); // double-invocation
    const commit = vi.fn();
    g.onBlurSave(ev("ab"), commit);
    expect(commit).toHaveBeenCalledWith("ab", "srv");
  });

  it("a dirty field reverted to the server's value blurs to a no-op (the improved edge)", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const incoming = { notes: "srv" };
    expect(g.merge({ notes: "ab" }, incoming)).toEqual({ notes: "ab" }); // preserved
    g.noteMerged(incoming);
    // The user then deletes their text and types exactly what the server holds: committing it
    // would be a redundant PATCH asserting a change nobody made.
    const noop = vi.fn();
    g.onBlurSave(ev("srv"), noop);
    expect(noop).not.toHaveBeenCalled();
  });

  it("a dirty field reverted to the AT-ENTRY value blurs to a no-op (the session set keeps it)", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const incoming = { notes: "srv" };
    expect(g.merge({ notes: "ab" }, incoming)).toEqual({ notes: "ab" });
    g.noteMerged(incoming);
    // Type "ab", refresh noted, delete back to exactly "a": the pre-round-2 guard treated this
    // as a no-op (value === the at-entry snapshot), and the session SET preserves that — an
    // atFocus overwrite would have committed "a" here, a behavior change this design avoids.
    const noop = vi.fn();
    g.onBlurSave(ev("a"), noop);
    expect(noop).not.toHaveBeenCalled();
  });

  it("noteMergedRows scopes by collection and owns the release-on-absence", () => {
    const g = makeEditGuard();
    g.onFocusCell("contacts", "c1", "name")(ev("Bob"));
    // A sibling collection's companion never touches the registration…
    g.noteMergedRows("addresses", [{ id: "a1", name: "N", street: "S" }]);
    expect(g.mergeRows("contacts",
      [{ id: "c1", name: "Bobby", phone: "p" }],
      [{ id: "c1", name: "SRV", phone: "P" }],
    )).toEqual([{ id: "c1", name: "Bobby", phone: "P" }]);
    // …while the OWN collection's companion releases on a genuine deletion:
    g.noteMergedRows("contacts", [{ id: "c2", name: "Other", phone: "q" }]);
    const incoming = [{ id: "c1", name: "SRV2", phone: "P2" }];
    expect(g.mergeRows("contacts", [{ id: "c1", name: "Bobby", phone: "p" }], incoming)).toBe(incoming);
  });
});
