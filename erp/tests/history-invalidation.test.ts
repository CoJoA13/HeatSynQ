import { describe, it, expect } from "vitest";
import { subscribeHistoryInvalidations, invalidateHistory } from "@/components/HistoryPanel";

// #14 item 1 — the module-level listener-Set invalidation idiom (the SetupBanner/BackupBanner
// shape), pinned the way tests/setup-banner.test.tsx pins its subscribe/invalidate contract:
// this repo has no DOM test environment, so the exported contract is the tested path and the
// component's own effect subscribes through the same export.
describe("history invalidation (#14 item 1)", () => {
  it("notifies every subscriber per invalidation, until unsubscribed", () => {
    let a = 0;
    let b = 0;
    const unsubA = subscribeHistoryInvalidations(() => { a += 1; });
    const unsubB = subscribeHistoryInvalidations(() => { b += 1; });

    invalidateHistory();
    expect(a).toBe(1);
    expect(b).toBe(1);

    unsubA();
    invalidateHistory();
    expect(a).toBe(1);
    expect(b).toBe(2);

    unsubB();
    invalidateHistory();
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it("an invalidation with no subscribers is a no-op, and a double-unsubscribe is harmless", () => {
    const unsub = subscribeHistoryInvalidations(() => {});
    unsub();
    unsub();
    expect(() => invalidateHistory()).not.toThrow();
  });
});
