import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendRows, composeRows, computeOrphanChurn, mergeEdit, patchAdded } from "@/lib/bulk-grid";

// Pure module (no DOM/React state involved), unlike the rest of bulk-grid.ts's hook — extracted
// specifically so the id-churn matrix is unit-testable without a component-test harness (this
// codebase has none; vitest runs `environment: "node"` throughout). Fix-wave R2 finding 5: the
// hook's own `detectOrphans` used to early-return whenever `edits` was empty, so a stale
// `removedIds` entry survived an id-churn refresh untouched — the row it meant to remove
// reappeared (nothing in `compose`'s filter matched the old id anymore) with no warning posted,
// exactly the "masked edit" bug `edits` itself was already protected against. `computeOrphanChurn`
// is the pure decision at the center of that fix: given the live id set, the previous one, and
// what's currently pending, what (if anything) got orphaned by the churn.

describe("computeOrphanChurn", () => {
  it("reports unchanged when the live id set is the same content, even as a different Set instance", () => {
    const result = computeOrphanChurn({
      liveIds: new Set(["a", "b"]),
      priorLiveIds: new Set(["b", "a"]), // same members, different order/instance
      editKeys: ["a"],
      removedIds: new Set(["b"]),
    });
    expect(result).toEqual({ kind: "unchanged" });
  });

  it("reports first-seen on the very first call (priorLiveIds null), regardless of what's pending", () => {
    const result = computeOrphanChurn({
      liveIds: new Set(["a", "b"]),
      priorLiveIds: null,
      editKeys: ["a"],
      removedIds: new Set(["z"]), // would be "orphaned" against liveIds, but there's nothing to compare yet
    });
    expect(result).toEqual({ kind: "first-seen" });
  });

  it("churn with only an edit orphaned: removedIds untouched, edit key reported", () => {
    const result = computeOrphanChurn({
      liveIds: new Set(["a-new", "b"]), // "a" was replaced by "a-new" (delete+recreate churn)
      priorLiveIds: new Set(["a", "b"]),
      editKeys: ["a"],
      removedIds: new Set(),
    });
    expect(result).toEqual({ kind: "churned", orphanedEditKeys: ["a"], orphanedRemovedIds: [] });
  });

  // The regression this finding fixes: previously the hook's own early return (`edits.size ===
  // 0`) meant this exact shape — nothing being EDITED, but something marked for REMOVAL — was
  // never even inspected, so the vanished removedIds entry silently survived forever and the row
  // it meant to remove reappeared with no warning.
  it("churn with only a removedIds entry orphaned: edits untouched, removed id reported (the finding's own regression shape)", () => {
    const result = computeOrphanChurn({
      liveIds: new Set(["b-new"]), // the row marked for removal ("b") churned to a new id
      priorLiveIds: new Set(["b"]),
      editKeys: [], // no edits pending at all
      removedIds: new Set(["b"]),
    });
    expect(result).toEqual({ kind: "churned", orphanedEditKeys: [], orphanedRemovedIds: ["b"] });
  });

  it("churn with both an edit and a removal orphaned at once", () => {
    const result = computeOrphanChurn({
      liveIds: new Set(["c"]),
      priorLiveIds: new Set(["a", "b"]),
      editKeys: ["a"],
      removedIds: new Set(["b"]),
    });
    expect(result.kind).toBe("churned");
    if (result.kind === "churned") {
      expect(result.orphanedEditKeys).toEqual(["a"]);
      expect(result.orphanedRemovedIds).toEqual(["b"]);
    }
  });

  it("churn that orphans neither: an unrelated row appeared/vanished, edits/removedIds still all live", () => {
    const result = computeOrphanChurn({
      liveIds: new Set(["a", "b", "c"]), // "c" is new, but "a"/"b" (the ones pending) survive untouched
      priorLiveIds: new Set(["a", "b"]),
      editKeys: ["a"],
      removedIds: new Set(["b"]),
    });
    expect(result).toEqual({ kind: "churned", orphanedEditKeys: [], orphanedRemovedIds: [] });
  });

  it("empty edits AND empty removedIds still reports churned (not unchanged) when the live set actually changed", () => {
    const result = computeOrphanChurn({
      liveIds: new Set(["a", "b", "c"]),
      priorLiveIds: new Set(["a", "b"]),
      editKeys: [],
      removedIds: new Set(),
    });
    expect(result).toEqual({ kind: "churned", orphanedEditKeys: [], orphanedRemovedIds: [] });
  });
});

// Fix-wave R4 finding 7: the hub's per-line serial grid expanded a range by calling `addRow` once
// per serial, and `addRow` appends with `setAdded((cur) => [...cur, row])` — a fresh copy of the
// whole array per row. A legal `EC{1-10000}` (serial-range.ts's own MAX_EXPANSION) therefore did
// ~50 million element copies across 10,000 separate state updates, on the main thread, in one
// keystroke's handler: the grid locked up rather than filling in. `appendRows` is the same append
// done ONCE for the whole batch, and is what `addRows` (and, for a single row, `addRow`) is built
// from — extracted as a pure reducer for the usual reason (vitest is `environment: "node"`; this
// codebase has no component-test harness).
describe("appendRows", () => {
  const row = (serial: string) => ({ serial, description: "" });

  it("appends every row in one pass, in order, after whatever was already there", () => {
    const existing = appendRows([], [row("A1")]);
    const result = appendRows(existing, [row("B1"), row("B2")]);

    expect(result.map((r) => r.serial)).toEqual(["A1", "B1", "B2"]);
    expect(new Set(result.map((r) => r.clientId)).size).toBe(3); // one client id each, all distinct
  });

  it("never mutates the array it was handed", () => {
    const existing = appendRows([], [row("A1")]);
    const before = [...existing];
    appendRows(existing, [row("B1")]);
    expect(existing).toEqual(before);
  });

  it("appending nothing is a no-op that still returns a new array", () => {
    const existing = appendRows([], [row("A1")]);
    const result = appendRows(existing, []);
    expect(result).toEqual(existing);
    expect(result).not.toBe(existing);
  });

  // The finding's own case: the largest expansion `expandSerialRange` will ever hand over, added
  // in a SINGLE call rather than 10,000 successive whole-array copies.
  it("takes a full 10,000-serial range expansion in one call", () => {
    const expanded = Array.from({ length: 10_000 }, (_, i) => row(`EC${String(i + 1).padStart(5, "0")}`));
    const result = appendRows([], expanded);

    expect(result).toHaveLength(10_000);
    expect(result[0].serial).toBe("EC00001");
    expect(result[9_999].serial).toBe("EC10000");
    expect(new Set(result.map((r) => r.clientId)).size).toBe(10_000);
  });
});

// #279: `dirty` was `edits.size > 0 || added.length > 0 || removedIds.size > 0` under a docstring
// promising "anything a Save button would actually send that DIFFERS from server state as loaded".
// It measured overlay cardinality instead, so editing a cell and typing the original value back
// left the row in `edits` and the grid reporting dirty — which since #272 means the "Unsaved
// changes" badge, a discard prompt on every navigation, and every gate that REFUSES over a dirty
// editor (invoice finalize/recalculate/print, shipment ticket/BOL, the order hub's traveler print)
// firing over nothing. That is precisely the prompt `unsaved-guard.ts` says people learn to click
// through.
//
// `mergeEdit` is the pure decision behind the fix, and the fix is a PRUNE rather than a narrowed
// predicate: leaving the no-op entry in place would keep it winning at compose time, invisible and
// unclearable (Save is disabled, and Save is the only caller of `reset`), re-arming with no user
// action the moment another actor touched that row — `detectOrphans` returns early while the id
// set is unchanged. Removing the entry makes "nothing to send" and "nothing overlaid" one state.
describe("mergeEdit", () => {
  const base = { qty: "5", weight: "100.5", note: "" };

  it("keeps a field that genuinely differs", () => {
    expect(mergeEdit(undefined, { qty: "6" }, base)).toEqual({ qty: "6" });
  });

  it("THE DEFECT: typing a value back to the server's leaves the row UNEDITED, not merely un-dirty", () => {
    // Mutation-proof: delete the equality prune in `mergeEdit` and this reds. Returning `undefined`
    // rather than `{}` is what lets `updateExisting` delete the map entry — an empty-object entry
    // would still make `edits.size > 0`, so `dirty` would stay true and nothing would be fixed.
    expect(mergeEdit({ qty: "6" }, { qty: "5" }, base)).toBeUndefined();
  });

  it("drops only the reverted field and keeps the rest of the overlay", () => {
    expect(mergeEdit({ qty: "6", weight: "7" }, { qty: "5" }, base)).toEqual({ weight: "7" });
  });

  it("re-checks the WHOLE overlay, not just the incoming patch's keys", () => {
    // The invoice grid stamps `priceSource`/`needsPrice` alongside every amount edit, so a field
    // left from an earlier keystroke can be the one that just became equal. Mutation-proof: compare
    // only `Object.keys(patch)` and this reds.
    expect(mergeEdit({ qty: "5", weight: "9" }, { weight: "100.5" }, base)).toBeUndefined();
  });

  it("compares strings EXACTLY — no trim, no numeric coercion", () => {
    // Composed values are the strings the PUT carries. "5.00" over a server "5" is a real payload
    // difference, and callers differ on trimming (SerialsSection trims `serial` at save but sends
    // `description` untrimmed), so normalising here would report a genuine difference clean.
    expect(mergeEdit(undefined, { qty: "5.00" }, base)).toEqual({ qty: "5.00" });
    expect(mergeEdit(undefined, { qty: " 5" }, base)).toEqual({ qty: " 5" });
    expect(mergeEdit(undefined, { note: " " }, base)).toEqual({ note: " " });
  });

  it("clearing a field the server also holds empty is not an edit", () => {
    expect(mergeEdit(undefined, { note: "" }, base)).toBeUndefined();
  });

  it("never mutates the overlay it was handed", () => {
    const current = { qty: "6" };
    mergeEdit(current, { qty: "5" }, base);
    expect(current).toEqual({ qty: "6" });
  });
});

// The call-site half of the same finding: a bulk expansion has to reach the grid through the bulk
// API. Checked at the source, because the alternative — a per-row loop — is behaviourally
// identical and only differs in cost, so no assertion on the resulting rows could ever tell them
// apart. (The partial-unique-sweep precedent: some invariants are only visible in the text.)
describe("serial-range expansion call sites", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("the hub's serial grid expands a range through addRows, never a per-serial addRow", () => {
    const src = read("src/app/orders/[id]/SerialsSection.tsx");
    const addRange = /function addRange\(\)[\s\S]*?\n  \}/.exec(src);
    expect(addRange, "addRange() not found — update this sweep alongside the rename").not.toBeNull();
    expect(addRange![0]).toContain("addRows(");
    expect(addRange![0]).not.toMatch(/\baddRow\(/);
  });

  // The entry page's sibling expansion was already a single update (one `onChange` with the whole
  // expanded batch spread in) — pinned here so the two stay consistent, since this is exactly the
  // habit that produced the hub's version.
  it("the entry page's line card expands a range in a single onChange, not one per serial", () => {
    const src = read("src/app/orders/new/OrderLineCard.tsx");
    const addRange = /function addRange\(\)[\s\S]*?\n  \}/.exec(src);
    expect(addRange, "addRange() not found — update this sweep alongside the rename").not.toBeNull();
    expect((addRange![0].match(/onChange\(/g) ?? [])).toHaveLength(1);
  });
});

// #281: `useBulkGrid` owns `key` and `isNew` on every composed row, but the composition used to
// spread the caller's fields LAST, so a `Fields` type declaring either one silently overwrote the
// identity. Exactly one caller did — the invoice grid's `LineFields` declared `key`, and
// `blankChargeRow` seeded it "" — so every locally-added charge row composed under `key: ""`. That
// matched no `clientId`, leaving a row that could not be typed into (`updateAdded("")` matches
// nothing), could not be removed (`removeAdded("")` filters nothing), rendered as a duplicate React
// key, and held `added.length > 0` forever — which through `useUnsavedPresent()` disabled invoice
// finalize, recalculate and print.
//
// The fix is two guards for one defect, covering different failure modes: `NoRowIdentity` stops the
// collision COMPILING (pinned in tests/bulk-grid.type-pin.ts, enforced by `npx tsc --noEmit`), and
// the identity now spreads LAST so it is un-shadowable at runtime whatever reaches the composition
// — plain JS, an `as` cast, or a future Fields widened through an index signature. The fixtures
// below cast a colliding shape in on purpose, which is the only way to exercise the runtime half
// now that typed code cannot express it.
// The added row's identity is `clientId`, and it is spread over in three places — `appendRows`,
// `addRow` and `updateAdded`. Same defect shape as #281's `key`: a row whose clientId is not its own
// can never be patched or removed, which is the same dead end by a different route.
describe("added-row identity (clientId)", () => {
  type Colliding = { clientId: string; note: string };

  it("appendRows: the generated id wins over a field of the same name", () => {
    // Mutation-proof: restore `{ clientId: crypto.randomUUID(), ...row }` and the row keeps the
    // caller's "STOLEN", which matches nothing in updateAdded/removeAdded.
    const [row] = appendRows<Colliding>([], [{ clientId: "STOLEN", note: "n" }]);
    expect(row.clientId).not.toBe("STOLEN");
    expect(row.clientId.length).toBeGreaterThan(0);
    expect(row.note).toBe("n");
  });

  it("patchAdded: a patch cannot steal the row's clientId", () => {
    // Mutation-proof: drop the trailing `clientId` re-stamp and this reds.
    const cur = [{ clientId: "c1", note: "a" }, { clientId: "c2", note: "b" }];
    const next = patchAdded(cur, "c1", { note: "typed", clientId: "STOLEN" } as Partial<Colliding>);
    expect(next[0]).toEqual({ clientId: "c1", note: "typed" });
    expect(next[1]).toBe(cur[1]);
  });

  it("patchAdded: a clientId matching nothing changes nothing", () => {
    const cur = [{ clientId: "c1", note: "a" }];
    expect(patchAdded(cur, "gone", { note: "x" })).toEqual(cur);
  });
});

describe("composeRows", () => {
  type Note = { note: string };
  // Only `key` is declared here. A fixture that also declared `isNew: string` would collapse
  // `ComposedRow<F>` to `never` (string vs boolean), so the `isNew` half is exercised through a
  // cast below instead — the collision it models is exactly what the type guard now forbids.
  type CollidingKey = { key: string; description: string };
  const empty = { edits: new Map(), added: [], removedIds: new Set<string>() };

  it("composes server rows through toFields, overlaid with their edits", () => {
    const rows = composeRows<{ id: string }, Note>({
      ...empty,
      serverRows: [{ id: "a" }, { id: "b" }],
      toFields: (r) => ({ note: r.id }),
      edits: new Map([["b", { note: "typed" }]]),
    });
    expect(rows.map((r) => [r.key, r.isNew, r.note])).toEqual([["a", false, "a"], ["b", false, "typed"]]);
  });

  it("skips removed rows and appends added ones after, in order", () => {
    const rows = composeRows<{ id: string }, Note>({
      ...empty,
      serverRows: [{ id: "a" }, { id: "b" }],
      toFields: (r) => ({ note: r.id }),
      removedIds: new Set(["a"]),
      added: [{ clientId: "c1", note: "x" }, { clientId: "c2", note: "y" }],
    });
    expect(rows.map((r) => r.key)).toEqual(["b", "c1", "c2"]);
    expect(rows.map((r) => r.isNew)).toEqual([false, true, true]);
  });

  it("THE DEFECT: an added row keeps its clientId even when the fields carry a key of their own", () => {
    // #281 in one line. Mutation-proof: restore `{ key: a.clientId, isNew: true, ...a }` and the
    // composed key becomes "" — the value that matched no clientId and stranded the invoice grid.
    // A fixture WITHOUT a `key` member cannot see this: it composes identically under either
    // order, which is exactly why the defect survived every behavioural assertion until now.
    const rows = composeRows<{ id: string }, CollidingKey>({
      ...empty,
      serverRows: [],
      toFields: () => ({ key: "", description: "" }),
      added: [{ clientId: "c1", key: "", description: "typed" }],
    });
    expect(rows[0].key).toBe("c1");
    expect(rows[0].isNew).toBe(true);
    expect(rows[0].description).toBe("typed");
  });

  it("an EXISTING row keeps its server id too — the same shadow, the other branch", () => {
    // Harmless today only by coincidence (the invoice grid's own `key` happened to equal the row
    // id). Nothing pinned that, so it is pinned here: restore identity-first and this reds.
    const rows = composeRows<{ id: string }, CollidingKey>({
      ...empty,
      serverRows: [{ id: "srv" }],
      toFields: () => ({ key: "WRONG", description: "d" }),
    });
    expect(rows[0].key).toBe("srv");
    expect(rows[0].isNew).toBe(false);
  });

  it("an EDIT cannot steal the identity either — the overlay spreads before it", () => {
    const rows = composeRows<{ id: string }, CollidingKey>({
      ...empty,
      serverRows: [{ id: "srv" }],
      toFields: () => ({ key: "", description: "d" }),
      edits: new Map([["srv", { key: "WRONG", description: "typed" }]]),
    });
    expect(rows[0].key).toBe("srv");
    expect(rows[0].description).toBe("typed");
  });

  it("`isNew` is un-shadowable too, though only a cast can express the collision", () => {
    // The type guard forbids a Fields declaring `isNew`, and `ComposedRow` cannot even represent
    // one (string vs boolean reduces the intersection to `never`) — so this reaches the runtime
    // through a cast, which is precisely the escape hatch the ordering exists to cover.
    const rows = composeRows<{ id: string }, Note>({
      ...empty,
      serverRows: [{ id: "srv" }],
      toFields: () => ({ note: "n", isNew: "WRONG" } as unknown as Note),
      added: [{ clientId: "c1", note: "n", isNew: "WRONG" } as unknown as { clientId: string } & Note],
    });
    expect(rows.map((r) => r.isNew)).toEqual([false, true]);
  });
});

// The #279 invariants that BEHAVIOUR cannot express, checked at the source — the `serial-range
// expansion call sites` precedent directly below, and the partial-unique-sweep reasoning it cites.
describe("useBulkGrid baseline call sites", () => {
  const SRC = fileURLToPath(new URL("../src", import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const consumers = walk(SRC)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith("bulk-grid.ts"))
    .map((f) => [f, readFileSync(f, "utf8")] as const)
    .filter(([, src]) => /\buseBulkGrid\s*\(/.test(src));

  it("finds the consumers at all — a walk that matches nothing would pass everything below", () => {
    expect(consumers.length).toBeGreaterThanOrEqual(7);
  });

  it("every consumer hands the hook its rows and reads the composed list back — never re-supplies them", () => {
    // The whole shape of the fix: `dirty` and the rendered rows must come from ONE baseline. A
    // consumer that passed its rows a second time (the old `grid.compose(rows, toFields)`) would
    // reintroduce exactly the drift #279 was — two supply sites for the same server array — and no
    // assertion on the returned rows could tell the two apart. Mutation-proof: restore a
    // `compose(` call at any call site and this reds.
    for (const [file, src] of consumers) {
      expect(src, `${file}: useBulkGrid must be called with (serverRows, toFields)`)
        .toMatch(/useBulkGrid\(\s*\w/);
      expect(src, `${file}: must not re-supply rows through a compose() call`)
        .not.toMatch(/\.compose\s*\(/);
    }
  });

  it("no consumer re-derives rows itself — composeRows is for tests, not a re-supply hatch", () => {
    // `composeRows` was extracted so the composition could be mutation-proven at all (the hook
    // cannot run under vitest). Exporting it also hands a consumer every input it would need to
    // compose against its OWN baseline, which is the two-baselines drift #279 removed — and the
    // sibling sweep above only looks for `.compose(`, so it would not see this shape.
    for (const [file, src] of consumers) {
      expect(src, `${file}: must not compose rows itself — read grid.rows`)
        .not.toMatch(/\bcomposeRows\s*\(/);
    }
  });
});
