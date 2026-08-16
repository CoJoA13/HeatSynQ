import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";

// T1 covers only the migration + schema: the SetupState singleton exists, the CHECK pins it to one
// row, and truncateAll restores it (the BillingConfig precedent). The service + audit wiring is T4.
describe("SetupState singleton (Phase 8B §7)", () => {
  beforeEach(truncateAll);

  it("has the by-construction singleton row after truncateAll, both facts unset", async () => {
    const row = await prisma.setupState.findFirst({ where: { id: "singleton" } });
    expect(row).not.toBeNull();
    expect(row?.id).toBe("singleton");
    expect(row?.numbersConfirmedAt).toBeNull();
    expect(row?.checklistDismissedAt).toBeNull();
  });

  it("keeps exactly one row across the truncate/re-seed", async () => {
    expect(await prisma.setupState.count()).toBe(1);
    const only = await prisma.setupState.findFirstOrThrow();
    expect(only.id).toBe("singleton");
  });

  it("rejects a second row with id !== 'singleton' (the SetupState_singleton_check CHECK)", async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "SetupState" ("id", "updatedAt") VALUES ('other', now())`,
    ).rejects.toThrow();
    // The illegal insert did not land; still exactly the singleton.
    expect(await prisma.setupState.count()).toBe(1);
  });
});
