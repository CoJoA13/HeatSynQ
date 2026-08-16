import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { getSetting, setSetting } from "@/server/settings";
import { SPECIAL_ACTIONS } from "@/lib/permission-constants";
import { DEFAULT_STALE_HOURS } from "@/lib/backup-constants";
import { runWithContext } from "@/server/context";

// setSetting audits, so it needs an actor in context. This is the repo's established idiom —
// copied verbatim from tests/order-entry-readiness.test.ts, which declares it the same way.
// There is NO tests/helpers/actor.ts; do not create one.
const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

describe("backup_stale_hours", () => {
  beforeEach(async () => { await truncateAll(); });

  it("defaults to the owner-settled 36 hours", async () => {
    expect(await getSetting("backup_stale_hours")).toBe(DEFAULT_STALE_HOURS);
  });

  it("accepts a sane override", async () => {
    await asSystem(async () => { await setSetting("backup_stale_hours", 24); });
    expect(await getSetting("backup_stale_hours")).toBe(24);
  });

  it("refuses zero, negatives, non-integers and absurd values", async () => {
    await asSystem(async () => {
      await expect(setSetting("backup_stale_hours", 0)).rejects.toThrow();
      await expect(setSetting("backup_stale_hours", -1)).rejects.toThrow();
      await expect(setSetting("backup_stale_hours", 1.5)).rejects.toThrow();
      await expect(setSetting("backup_stale_hours", 8761)).rejects.toThrow();
    });
  });
});

describe("manage_backups", () => {
  it("is a named special action", () => {
    expect(SPECIAL_ACTIONS).toContain("manage_backups");
  });
});
