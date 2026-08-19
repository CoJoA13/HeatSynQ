import { describe, it, expect } from "vitest";
import { makeLatestGate } from "@/lib/use-latest";
import { resolveFieldBlockerPanel } from "@/lib/field-blocker-panel";

type Blocker = { id: string; name: string };

// A manually-resolved deferred stands in for the blocker GET so the test controls exactly when
// the response lands relative to the selection-change bump — no timers, no races.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const fieldCtx = { defId: "def-1", label: "Hardness" };
const list: Blocker[] = [{ id: "part-1", name: "P/N 100 rev A" }];

describe("resolveFieldBlockerPanel", () => {
  it("a selection change mid-flight supersedes the fetch — the resolve lands as undefined (touch nothing)", async () => {
    const gate = makeLatestGate();
    const d = deferred<Blocker[]>();
    const p = resolveFieldBlockerPanel(gate, () => d.promise, fieldCtx);
    gate.next(); // the selection-change effect's bump, while the GET is still in flight
    d.resolve(list);
    await expect(p).resolves.toBeUndefined();
  });

  it("undisturbed, the resolved list comes back as the panel value", async () => {
    const gate = makeLatestGate();
    const d = deferred<Blocker[]>();
    const p = resolveFieldBlockerPanel(gate, () => d.promise, fieldCtx);
    d.resolve(list);
    await expect(p).resolves.toEqual({ defId: "def-1", label: "Hardness", list });
  });

  it("a stale rejection must not clear a current panel — bump-then-reject is undefined, not null", async () => {
    const gate = makeLatestGate();
    const d = deferred<Blocker[]>();
    const p = resolveFieldBlockerPanel(gate, () => d.promise, fieldCtx);
    gate.next();
    d.reject(new Error("network down"));
    await expect(p).resolves.toBeUndefined();
  });

  it("a rejection while still current clears the panel (null) — the save's own error text already explains the refusal", async () => {
    const gate = makeLatestGate();
    const d = deferred<Blocker[]>();
    const p = resolveFieldBlockerPanel(gate, () => d.promise, fieldCtx);
    d.reject(new Error("network down"));
    await expect(p).resolves.toBeNull();
  });
});
