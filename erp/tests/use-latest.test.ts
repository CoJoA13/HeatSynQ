import { describe, it, expect } from "vitest";
import { makeLatestGate, makeMutationGate } from "@/lib/use-latest";

describe("makeLatestGate", () => {
  it("only the newest ticket is current", () => {
    const g = makeLatestGate();
    const a = g.next(); const b = g.next();
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
  });
  it("a later ticket invalidates all earlier ones at issue time, not resolve time", () => {
    const g = makeLatestGate();
    const a = g.next();
    expect(g.isCurrent(a)).toBe(true);
    g.next();
    expect(g.isCurrent(a)).toBe(false);
  });
});

// Fix-wave R4 finding 6. `makeLatestGate` is the wrong instrument for MUTATIONS: it keeps only the
// newest issued ticket, so of two overlapping saves it throws away the first one's result even
// when that result is the only one that ever arrives — fine for a fetch-into-state (a newer fetch
// is always about to answer the same question) but wrong for a save, whose response is the only
// report of a write that really happened. What a mutation needs is monotonicity against what has
// already been APPLIED, not against what has been issued.
describe("makeMutationGate", () => {
  it("applies in-order completions, every one of them", () => {
    const g = makeMutationGate();
    const a = g.next();
    expect(g.accept(a)).toBe(true);
    const b = g.next();
    expect(g.accept(b)).toBe(true);
  });

  it("an earlier request that finishes first still applies — then the later one applies over it", () => {
    const g = makeMutationGate();
    const a = g.next(); const b = g.next();
    // a was issued first and also finished first: nothing newer has landed, so it is the truth.
    expect(g.accept(a)).toBe(true);
    expect(g.accept(b)).toBe(true);
  });

  // The finding's own shape: two overlapping whole-order mutations, the NEWER one answering first
  // (a bulk replace that returns fast) and the older, slower one answering after. Applying the
  // straggler would put the page back to a state the server has already moved past — and the
  // sections' own bulk-grid overlays would then be composed against rows that no longer exist.
  it("ignores a completion older than the newest one already applied", () => {
    const g = makeMutationGate();
    const older = g.next(); const newer = g.next();
    expect(g.accept(newer)).toBe(true);
    expect(g.accept(older)).toBe(false);
  });

  it("ignores a re-application of the same ticket", () => {
    const g = makeMutationGate();
    const t = g.next();
    expect(g.accept(t)).toBe(true);
    expect(g.accept(t)).toBe(false);
  });

  it("keeps ignoring stragglers after several rounds, not just the first", () => {
    const g = makeMutationGate();
    const t1 = g.next(); const t2 = g.next(); const t3 = g.next();
    expect(g.accept(t3)).toBe(true);
    expect(g.accept(t2)).toBe(false);
    expect(g.accept(t1)).toBe(false);
    const t4 = g.next();
    expect(g.accept(t4)).toBe(true);
  });
});
