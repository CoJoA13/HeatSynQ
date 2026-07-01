import { describe, it, expect } from "vitest";
import { createMockRepositories } from "./repositories";

describe("scheduleBlocks repo", () => {
  it("creates a block with server-assigned base fields", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const created = await repos.scheduleBlocks.create({
      workOrderId: "wo-48231", equipmentId: "eq-iq-1", day: "2026-06-29T00:00:00.000Z", state: "planned",
    });
    expect(created.id).toBeTruthy();
    expect(created.version).toBe(0);
    expect(created.state).toBe("planned");
  });

  it("enforces optimistic concurrency on update", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const b = await repos.scheduleBlocks.create({
      workOrderId: "wo-48231", equipmentId: "eq-iq-1", day: "2026-06-29T00:00:00.000Z", state: "planned",
    });
    await expect(repos.scheduleBlocks.update(b.id, { state: "cancelled" }, b.version + 5)).rejects.toThrow();
    const ok = await repos.scheduleBlocks.update(b.id, { state: "cancelled" }, b.version);
    expect(ok.state).toBe("cancelled");
    expect(ok.version).toBe(b.version + 1);
  });
});
