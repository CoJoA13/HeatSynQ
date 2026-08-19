import { describe, it, expect, vi } from "vitest";
import type { FocusEvent } from "react";
import { makeEditGuard } from "@/lib/use-edit-guard";

// #149 (Group H2 Task 1). The leaf had NO suite of its own — the scalar guard shipped in the
// fix-wave notes-clobber trio and was pinned only by its consumers' behavior in E2E. This file
// pins the scalar contract FIRST (so the keyed variant provably changes none of it), then the
// row-scoped keyed variant (customers' address/contact rows), then the Codex-round refinements:
// collection scoping (round 1), the dispatch-time transition (round 2), and the captured-session
// fixpoint (round 3) — under which every apply is expressed as `applyPayload`/`applyRows`
// (capture + note + pure updater in one call) or the low-level `capturePayload`. Pure leaf, no
// DB, fully synchronous — the `use-latest.test.ts` shape; the guard's inputs are focus/blur
// events, faked below the way the pages' inputs would deliver them.

/** A focus/blur event carrying only what the guard reads: the target's current value. */
const ev = (value: string) => ({ target: { value } }) as unknown as FocusEvent<HTMLInputElement>;

describe("makeEditGuard — the scalar guard (pinned pre-#149 behavior)", () => {
  it("no focused field: an incoming detail lands wholesale", () => {
    const g = makeEditGuard();
    const cur = { notes: "local", po: "p0" };
    const incoming = { notes: "server", po: "p1" };
    expect(g.applyPayload(incoming)(cur)).toBe(incoming);
  });

  it("cur === null (first load): incoming lands wholesale even while a field is focused", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("typing"));
    const incoming = { notes: "server" };
    expect(g.applyPayload(incoming)(null)).toBe(incoming);
  });

  it("a focused-and-dirty field survives the apply; every sibling refreshes", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a")); // the box showed "a" on entry
    const cur = { notes: "ab", po: "p0" }; // the user typed since focus
    const incoming = { notes: "server", po: "p1" };
    expect(g.applyPayload(incoming)(cur)).toEqual({ notes: "ab", po: "p1" });
  });

  it("a focused-but-untouched field takes the server value and the session learns it", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const cur = { notes: "a", po: "p0" }; // untouched since focus
    const incoming = { notes: "server", po: "p1" };
    expect(g.applyPayload(incoming)(cur)).toBe(incoming);
    // The session snapshotted what the box now shows (at dispatch, inside applyPayload):
    // blurring without typing is still a no-op — a later blur must not "save" a change the
    // user never typed.
    const commit = vi.fn();
    g.onBlurSave(ev("server"), commit);
    expect(commit).not.toHaveBeenCalled();
  });

  it("a blurred field takes the incoming value — the session ends on blur", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const commit = vi.fn();
    g.onBlurSave(ev("ab"), commit); // genuine change: commits and ends the session
    expect(commit).toHaveBeenCalledWith("ab", "a");
    const cur = { notes: "ab", po: "p0" };
    const incoming = { notes: "server", po: "p1" };
    expect(g.applyPayload(incoming)(cur)).toBe(incoming);
  });

  it("one session: focusing a second field releases the first (the DOM's single-focus model)", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    g.onFocusField("po")(ev("p0")); // focus moved; only `po` is under the cursor now
    const cur = { notes: "ab", po: "p0-typed" }; // both differ from server; only po is dirty-since-focus
    const incoming = { notes: "server", po: "p-server" };
    expect(g.applyPayload(incoming)(cur)).toEqual({ notes: "server", po: "p0-typed" });
  });

  it("onFocusField(null): blur no-op guard only — the apply is not intercepted", () => {
    const g = makeEditGuard();
    g.onFocusField(null)(ev("cell"));
    const cur = { notes: "local" };
    const incoming = { notes: "server" };
    expect(g.applyPayload(incoming)(cur)).toBe(incoming); // no key registered: wholesale
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
    // Untouched since focus (String(5) === "5"): server truth lands, the session snapshots "7"
    // so the box's new text blurs to a no-op.
    expect(g.applyPayload(incoming)(cur)).toBe(incoming);
    const commit = vi.fn();
    g.onBlurSave(ev("7"), commit);
    expect(commit).not.toHaveBeenCalled();
  });

  it("a focused key absent from the incoming payload: incoming lands wholesale", () => {
    const g = makeEditGuard();
    g.onFocusField("ghost")(ev("a"));
    const cur = { notes: "local" } as Record<string, string>;
    const incoming = { notes: "server" } as Record<string, string>;
    expect(g.applyPayload(incoming)(cur)).toBe(incoming);
  });
});

// The keyed variant (#149): array state keyed by row id + field — the customers page's address/
// contact rows, whose cells previously registered only the blur no-op guard (onFocusField(null))
// and so had NO mid-typing protection when applyDetail's setAddresses/setContacts landed a fresh
// server array over them. One focus session still serves both variants: the DOM has one focused
// element, so a cell registration and a scalar registration displace each other.
describe("makeEditGuard — the keyed variant (applyRows)", () => {
  type Row = { id: string; name: string; street: string };
  const rows = (over: Partial<Record<"r1" | "r2", Partial<Row>>> = {}): Row[] => [
    { id: "r1", name: "n1", street: "s1", ...over.r1 },
    { id: "r2", name: "n2", street: "s2", ...over.r2 },
  ];

  it("no focused cell: an incoming array lands wholesale", () => {
    const g = makeEditGuard();
    const incoming = rows();
    expect(g.applyRows("rows", incoming)(rows())).toBe(incoming);
  });

  it("a focused-and-dirty cell keeps its local value; sibling fields, rows, and additions refresh", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r1", "name")(ev("n1")); // the box showed "n1" on entry
    const cur = rows({ r1: { name: "n1-typed" } }); // typed since focus
    const incoming = [...rows({ r1: { name: "SERVER", street: "S1" }, r2: { name: "N2" } }),
      { id: "r3", name: "n3", street: "s3" }];
    expect(g.applyRows("rows", incoming)(cur)).toEqual([
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
    expect(g.applyRows("rows", incoming)(cur)).toEqual([
      { id: "r2", name: "N2", street: "S2" },
      { id: "r1", name: "n1-typed", street: "S1" },
    ]);
  });

  it("a focused-but-untouched cell takes the server value and the session learns it", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r1", "name")(ev("n1"));
    const incoming = rows({ r1: { name: "SERVER" } });
    expect(g.applyRows("rows", incoming)(rows())).toBe(incoming);
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
    expect(g.applyRows("rows", incoming)(cur)).toBe(incoming);
  });

  it("a disappeared row RELEASES the session: a same-id row re-entering later merges clean", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r1", "name")(ev("n1"));
    // r1 vanishes (soft-deleted, or hidden by a show-inactive toggle's refetch): the payload
    // lands as-is, and applyRows releases the session AT DISPATCH — once the payload applies
    // the cell's input unmounts with no React blur, and only guard-registered focus/blur would
    // otherwise replace the session (checkboxes, selects, and buttons never touch it).
    const afterDelete = [{ id: "r2", name: "N2", street: "S2" }];
    expect(g.applyRows("rows", afterDelete)(rows({ r1: { name: "n1-typed" } }))).toBe(afterDelete);
    // The same id re-enters the payload (reactivation / includeInactive refetch — supported
    // flows, not a hard recreate): merges clean…
    const reappeared = [{ id: "r1", name: "BACK", street: "S1" }, ...afterDelete];
    expect(g.applyRows("rows", reappeared)(afterDelete)).toBe(reappeared);
    // …and STAYS clean on the next refresh. Without the release, r1.name ("BACK") compared
    // against the dead session's snapshots reads as dirty-since-focus and blocks server truth
    // on every apply indefinitely.
    const fresh = [{ id: "r1", name: "NEWER", street: "S1" }, ...afterDelete];
    expect(g.applyRows("rows", fresh)(reappeared)).toBe(fresh);
  });

  it("the focused row missing locally: the payload lands as-is (nothing to preserve)", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r9", "name")(ev("x"));
    const incoming = rows();
    expect(g.applyRows("rows", incoming)(rows())).toBe(incoming);
  });

  it("blur ends the cell session: commits the change, then arrays land wholesale", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r1", "name")(ev("n1"));
    const commit = vi.fn();
    g.onBlurSave(ev("n1-typed"), commit);
    expect(commit).toHaveBeenCalledWith("n1-typed", "n1");
    const cur = rows({ r1: { name: "n1-typed" } });
    const incoming = rows({ r1: { name: "SERVER" } });
    expect(g.applyRows("rows", incoming)(cur)).toBe(incoming);
  });

  it("one session: focusing a second cell releases the first", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r1", "name")(ev("n1"));
    g.onFocusCell("rows", "r2", "street")(ev("s2"));
    const cur = rows({ r1: { name: "n1-typed" }, r2: { street: "s2-typed" } });
    const incoming = rows({ r1: { name: "N1" }, r2: { street: "S2" } });
    expect(g.applyRows("rows", incoming)(cur)).toEqual(rows({ r1: { name: "N1" }, r2: { street: "s2-typed" } }));
  });

  it("one session across variants: a cell registration displaces a scalar one, and vice versa", () => {
    const g = makeEditGuard();
    // Scalar focused+dirty: rows are not intercepted…
    g.onFocusField("notes")(ev("a"));
    const incomingRows = rows();
    expect(g.applyRows("rows", incomingRows)(rows({ r1: { name: "n1-typed" } }))).toBe(incomingRows);
    // …and the scalar registration still protects the detail object.
    expect(g.applyPayload({ notes: "server" })({ notes: "ab" })).toEqual({ notes: "ab" });
    // Cell focused+dirty: the detail object is not intercepted…
    g.onFocusCell("rows", "r1", "name")(ev("n1"));
    const incomingDetail = { notes: "server2" };
    expect(g.applyPayload(incomingDetail)({ notes: "typed" })).toBe(incomingDetail);
    // …and the scalar registration is gone: a cell edit survives its own array apply only.
    expect(g.applyRows("rows", rows({ r1: { name: "N1" } }))(rows({ r1: { name: "n1-typed" } })))
      .toEqual(rows({ r1: { name: "n1-typed", street: "s1" } }));
  });

  it("the string lens applies to cells: a numeric cell held as a number reads as displayed", () => {
    const g = makeEditGuard();
    type NumRow = { id: string; qty: number | string };
    g.onFocusCell("rows", "r1", "qty")(ev("5"));
    const cur: NumRow[] = [{ id: "r1", qty: 5 }];
    const incoming: NumRow[] = [{ id: "r1", qty: 7 }];
    expect(g.applyRows("rows", incoming)(cur)).toBe(incoming); // untouched: server truth lands
    const commit = vi.fn();
    g.onBlurSave(ev("7"), commit); // the session snapshotted what the box now shows
    expect(commit).not.toHaveBeenCalled();
  });

  it("a focused field absent from the incoming row: the payload lands as-is", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r1", "ghost")(ev("x"));
    const incoming = rows();
    expect(g.applyRows("rows", incoming)(rows())).toBe(incoming);
  });
});

// Codex round 1 on PR #154 (P1): the clear-on-absence release is right WITHIN a collection but
// was destructive ACROSS collections. The customers page merges addresses THEN contacts through
// ONE guard session (applyDetail), and a focused contact's rowId is by definition absent from
// the ADDRESSES array — that absence is not a deletion, yet the unscoped release treated it as
// one and dropped the registration before the contacts apply could protect the cell (the exact
// #149 defect back again); in the other direction a protected address lost its registration to
// the contacts apply, so the next payload clobbered it AND blur fired a spurious commit. The
// cell identity therefore includes its COLLECTION, and an apply acts on the session —
// protecting OR releasing — only for its own collection.
describe("makeEditGuard — cross-collection scoping (Codex PR #154 round 1)", () => {
  type Row = { id: string; name: string; street: string };
  const rows = (over: Partial<Record<"r1" | "r2", Partial<Row>>> = {}): Row[] => [
    { id: "r1", name: "n1", street: "s1", ...over.r1 },
    { id: "r2", name: "n2", street: "s2", ...over.r2 },
  ];
  type ContactRow = { id: string; name: string; phone: string };

  it("a dirty contact cell survives an addresses-then-contacts double apply", () => {
    const g = makeEditGuard();
    g.onFocusCell("contacts", "c1", "name")(ev("Bob"));
    // applyDetail's order: addresses first. c1 is absent from the ADDRESSES array by definition
    // — not a deletion; the session must pass through untouched.
    const addressesIncoming = rows();
    expect(g.applyRows("addresses", addressesIncoming)(rows())).toBe(addressesIncoming);
    // Then contacts: the registration is intact, so the dirty cell is still protected.
    const contactsCur: ContactRow[] = [{ id: "c1", name: "Bobby", phone: "p1" }];
    const contactsIncoming: ContactRow[] = [{ id: "c1", name: "SERVER", phone: "P1" }];
    expect(g.applyRows("contacts", contactsIncoming)(contactsCur))
      .toEqual([{ id: "c1", name: "Bobby", phone: "P1" }]);
  });

  it("an unrelated collection's apply leaves the registration — and the blur no-op — intact", () => {
    const g = makeEditGuard();
    g.onFocusCell("addresses", "r1", "name")(ev("n1"));
    // A CONTACTS apply runs while an address cell is focused: r1 absent there by definition.
    const contactsIncoming: ContactRow[] = [{ id: "c1", name: "C", phone: "p" }];
    expect(g.applyRows("contacts", contactsIncoming)([])).toBe(contactsIncoming);
    // The registration still protects the now-dirty address cell on ITS collection's apply…
    expect(g.applyRows("addresses", rows({ r1: { name: "SRV" } }))(rows({ r1: { name: "n1-typed" } })))
      .toEqual(rows({ r1: { name: "n1-typed" } }));
    // …and the session's snapshots survived too: blurring an UNTOUCHED cell after an unrelated
    // apply stays a no-op — a cleared session would compare "n1" against "" and fire a spurious
    // commit for a change the user never typed.
    const g2 = makeEditGuard();
    g2.onFocusCell("addresses", "r1", "name")(ev("n1"));
    g2.applyRows("contacts", [{ id: "c1", name: "C", phone: "p" }] as ContactRow[])([]);
    const commit = vi.fn();
    g2.onBlurSave(ev("n1"), commit);
    expect(commit).not.toHaveBeenCalled();
  });

  it("the within-collection release still holds: a genuine deletion in the OWN collection releases", () => {
    const g = makeEditGuard();
    g.onFocusCell("addresses", "r1", "name")(ev("n1"));
    const afterDelete = [{ id: "r2", name: "N2", street: "S2" }];
    expect(g.applyRows("addresses", afterDelete)(rows({ r1: { name: "n1-typed" } }))).toBe(afterDelete);
    // Released at dispatch: a same-id row re-entering merges clean and stays clean.
    const reappeared = [{ id: "r1", name: "BACK", street: "S1" }, ...afterDelete];
    expect(g.applyRows("addresses", reappeared)(afterDelete)).toBe(reappeared);
    const fresh = [{ id: "r1", name: "NEWER", street: "S1" }, ...afterDelete];
    expect(g.applyRows("addresses", fresh)(reappeared)).toBe(fresh);
  });
});

// Codex round 2 on PR #154 (P2, controller-broadened to the scalar half): the merges ran inside
// React functional setState updaters and MUTATED guard state there — updaters must be pure
// (Strict Mode double-invokes them; React defers them past the code following the setState).
// Round 2 moved the WRITES out into dispatch-time notes and made the untouched-vs-dirty
// decision a membership test on the session's grow-only SNAPSHOT SET, so the decision is
// identical whether an updater runs before other dispatches' notes, after them, once, or twice.
// (Round 3 folded the note INTO the apply — these tests express the same invariants through the
// captured-session API.)
describe("makeEditGuard — dispatch-time transition + the snapshot set (Codex PR #154 round 2)", () => {
  type Row = { id: string; name: string; street: string };
  const rows = (over: Partial<Record<"r1" | "r2", Partial<Row>>> = {}): Row[] => [
    { id: "r1", name: "n1", street: "s1", ...over.r1 },
    { id: "r2", name: "n2", street: "s2", ...over.r2 },
  ];

  it("the transition happens at dispatch: post-apply blur no-ops at the server value, commits typed text", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const incoming = { notes: "srv" };
    const updater = g.applyPayload(incoming); // capture + note, before any updater ran
    const noop = vi.fn();
    g.onBlurSave(ev("srv"), noop); // the note landed even though the updater never ran yet
    expect(noop).not.toHaveBeenCalled();
    void updater;
    // Typed text still commits, and the atFocus argument is the NEWEST snapshot (the last
    // server value the box was given) — the best rollback target for the int-field callers.
    const g2 = makeEditGuard();
    g2.onFocusField("notes")(ev("a"));
    g2.applyPayload({ notes: "srv" });
    const commit = vi.fn();
    g2.onBlurSave(ev("typed"), commit);
    expect(commit).toHaveBeenCalledWith("typed", "srv");
  });

  it("deferred updater: the note preceded it, and the untouched field still takes the refresh", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const incoming = { notes: "srv" };
    const updater = g.applyPayload(incoming); // note at dispatch…
    // …updater runs later with the PRE-refresh prev. The at-entry snapshot is still in the
    // session set, so the untouched field takes server truth — a single-value atFocus overwrite
    // would have judged it dirty here and preserved stale data.
    expect(updater({ notes: "a" })).toBe(incoming);
  });

  it("keyed deferred updater: the untouched-cell refresh lands too", () => {
    const g = makeEditGuard();
    g.onFocusCell("rows", "r1", "name")(ev("n1"));
    const incoming = rows({ r1: { name: "SRV" } });
    const updater = g.applyRows("rows", incoming);
    expect(updater(rows())).toBe(incoming);
    const noop = vi.fn();
    g.onBlurSave(ev("SRV"), noop);
    expect(noop).not.toHaveBeenCalled();
  });

  it("two deferred refreshes in a row: the untouched field tracks the newest server value", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const s1 = { notes: "s1" };
    const s2 = { notes: "s2" };
    // Both dispatches (and notes) happen before either updater runs (a batched double-apply):
    const u1 = g.applyPayload(s1);
    const u2 = g.applyPayload(s2);
    expect(u1({ notes: "a" })).toBe(s1);   // prev is the pre-refresh value
    expect(u2({ notes: "s1" })).toBe(s2);  // prev is refresh 1's applied value
    const noop = vi.fn();
    g.onBlurSave(ev("s2"), noop);
    expect(noop).not.toHaveBeenCalled();
  });

  it("dirty preserve survives every ordering and double-invocation, then blur commits", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const cur = { notes: "ab" }; // typed since focus
    const incoming = { notes: "srv" };
    const updater = g.applyPayload(incoming); // note first (deferred-updater ordering)
    expect(updater(cur)).toEqual({ notes: "ab" });
    expect(updater(cur)).toEqual({ notes: "ab" }); // double-invocation
    const commit = vi.fn();
    g.onBlurSave(ev("ab"), commit);
    expect(commit).toHaveBeenCalledWith("ab", "srv");
  });

  it("a dirty field reverted to the server's value blurs to a no-op (the improved edge)", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const incoming = { notes: "srv" };
    expect(g.applyPayload(incoming)({ notes: "ab" })).toEqual({ notes: "ab" }); // preserved
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
    expect(g.applyPayload(incoming)({ notes: "ab" })).toEqual({ notes: "ab" });
    // Type "ab", refresh applied, delete back to exactly "a": the pre-round-2 guard treated
    // this as a no-op (value === the at-entry snapshot), and the session SET preserves that —
    // an atFocus overwrite would have committed "a" here, a behavior change this design avoids.
    const noop = vi.fn();
    g.onBlurSave(ev("a"), noop);
    expect(noop).not.toHaveBeenCalled();
  });
});

// Codex round 3 on PR #154 (P2 — the fixpoint): merge/mergeRows still READ the live session
// from inside a deferrable updater while the note ran at dispatch — two consultations of
// mutable state at different times. Defer the updater across a focus change and the note lands
// on the OLD session while the merge consults the NEW one. The fixpoint: the focus session is
// an immutable-identity value object captured ONCE at dispatch; `applyPayload`/`applyRows`
// capture, note against that same captured session, and return a pure updater CLOSED OVER it —
// an updater can no longer express a live-session read, and mispairing is unrepresentable.
// `capturePayload` is the low-level pair for orders' composed travelerPrinted-ternary updater.
describe("makeEditGuard — captured sessions (Codex PR #154 round 3)", () => {
  it("a payload dispatched while A is dirty merges with A's CAPTURED session after focus moves to B", () => {
    const g = makeEditGuard();
    g.onFocusField("A")(ev("a"));
    // Dispatch: capture + note happen now; the updater is deferred.
    const updater = g.applyPayload({ A: "srv", B: "b2" });
    // The user focuses B before React runs the updater.
    g.onFocusField("B")(ev("b"));
    // The deferred updater consults the CAPTURED (A) session: A is dirty there, so A's typed
    // text survives — the live (B) session is not consulted at all. The round-2 live-read
    // implementation judged B untouched and landed the payload wholesale, clobbering A.
    expect(updater({ A: "a-typed", B: "b" })).toEqual({ A: "a-typed", B: "b2" });
  });

  it("an ENDED session (blurred before the deferred updater ran) still guards its field", () => {
    const g = makeEditGuard();
    g.onFocusField("A")(ev("a"));
    const updater = g.applyPayload({ A: "srv" });
    // The user blurs, committing their text; the session object ends (live slot goes idle) but
    // stays valid for the late reader.
    const commit = vi.fn();
    g.onBlurSave(ev("a-typed"), commit);
    expect(commit).toHaveBeenCalledWith("a-typed", "srv"); // atFocus advanced by the dispatch note
    // The older payload's deferred updater must NOT revert the just-committed text — under the
    // live-read implementation the cleared slot meant wholesale, un-typing the commit on screen.
    expect(updater({ A: "a-typed" })).toEqual({ A: "a-typed" });
  });

  it("keyed capture: a dirty cell survives its collection's deferred updater across a focus change", () => {
    const g = makeEditGuard();
    g.onFocusCell("addresses", "r1", "name")(ev("n1"));
    const updater = g.applyRows("addresses", [{ id: "r1", name: "SRV", street: "S1" }]);
    g.onFocusField("notes")(ev("x")); // focus moves before the updater runs
    expect(updater([{ id: "r1", name: "n1-typed", street: "s1" }]))
      .toEqual([{ id: "r1", name: "n1-typed", street: "S1" }]);
  });

  it("capturePayload (the orders shape): the composed updater merges with the captured session", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const fresh = { notes: "srv", travelerPrinted: false };
    const captured = g.capturePayload(fresh); // capture + note at dispatch
    // The composed updater derives `next` from prev (the monotonic boolean preserve) and merges
    // THAT — with the captured session, inside the updater.
    const prev = { notes: "a-typed", travelerPrinted: true };
    const next = { ...fresh, travelerPrinted: true };
    expect(captured.merge(prev, next)).toEqual({ notes: "a-typed", travelerPrinted: true });
    // And the note landed at dispatch: an untouched box blurring at the fresh value is a no-op.
    const g2 = makeEditGuard();
    g2.onFocusField("notes")(ev("a"));
    g2.capturePayload({ notes: "srv" });
    const noop = vi.fn();
    g2.onBlurSave(ev("srv"), noop);
    expect(noop).not.toHaveBeenCalled();
  });

  it("updaters are pure and re-runnable: double invocation with the same prev is identical", () => {
    const g = makeEditGuard();
    g.onFocusField("notes")(ev("a"));
    const incoming = { notes: "srv" };
    const updater = g.applyPayload(incoming);
    expect(updater({ notes: "a" })).toBe(incoming);
    expect(updater({ notes: "a" })).toBe(incoming);
    const g3 = makeEditGuard();
    g3.onFocusCell("rows", "r1", "name")(ev("n1"));
    const rowsIncoming = [{ id: "r1", name: "SRV", street: "s" }];
    const rowsUpdater = g3.applyRows("rows", rowsIncoming);
    expect(rowsUpdater([{ id: "r1", name: "n1", street: "s" }])).toBe(rowsIncoming);
    expect(rowsUpdater([{ id: "r1", name: "n1", street: "s" }])).toBe(rowsIncoming);
  });

  // THE DOCUMENTED RESIDUAL (the leaf header's boundary): a payload whose updater commits AFTER
  // a focus change repaints the newly-focused untouched box with the payload value, and the NEW
  // session never learns it (the note went — correctly — to the session that existed at
  // dispatch), so an immediate blur PATCHes a server-given value. Reaching it requires a
  // macrotask-scale deferral (default-priority updates flush in microtasks; a focus event is a
  // macrotask; nothing here uses startTransition) — unreachable in this codebase today — and it
  // equals the app's long-standing pre-adoption `focusedValue` behavior, which had this hole
  // unconditionally. Closing it would need an effect-time note of the DOM-rendered value, which
  // no pure guard API can observe. This test PINS the boundary as expected current behavior.
  it("boundary pin: a post-capture focus change leaves the new field's session unaware of the payload", () => {
    const g = makeEditGuard();
    g.onFocusField("A")(ev("a"));
    const updater = g.applyPayload({ A: "srv", B: "b2" });
    g.onFocusField("B")(ev("b"));
    // The captured (A) session judges A untouched: the payload lands wholesale, repainting B.
    expect(updater({ A: "a", B: "b" })).toEqual({ A: "srv", B: "b2" });
    // B's session holds only its at-entry snapshot, so blurring at the repainted value commits —
    // the residual PATCH of a server-given value. Expected; see the header.
    const commit = vi.fn();
    g.onBlurSave(ev("b2"), commit);
    expect(commit).toHaveBeenCalledWith("b2", "b");
  });
});
