import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { getSetupState, setSetupState } from "@/server/setup-state";
import { runWithContext } from "@/server/context";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

describe("getSetupState / setSetupState (Phase 8B §7)", () => {
  beforeEach(truncateAll);

  it("returns both facts null on the seeded singleton", async () => {
    expect(await getSetupState()).toEqual({ numbersConfirmedAt: null, checklistDismissedAt: null });
  });

  it("returns EMPTY when the row is absent (the fallback branch)", async () => {
    await prisma.setupState.deleteMany({});
    expect(await getSetupState()).toEqual({ numbersConfirmedAt: null, checklistDismissedAt: null });
  });

  it("stamps a fact and writes exactly one audit update row", async () => {
    const when = new Date("2026-08-15T12:00:00.000Z");
    const result = await asSystem(() => setSetupState({ numbersConfirmedAt: when }));
    expect(result.numbersConfirmedAt?.toISOString()).toBe(when.toISOString());
    expect(result.checklistDismissedAt).toBeNull();

    expect((await getSetupState()).numbersConfirmedAt?.toISOString()).toBe(when.toISOString());

    const audits = await prisma.auditLog.findMany({ where: { entity: "setupState", entityId: "singleton" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("update");
  });

  it("updates in place on a second call (dismiss after confirm), staying one row", async () => {
    await asSystem(() => setSetupState({ numbersConfirmedAt: new Date() }));
    await asSystem(() => setSetupState({ checklistDismissedAt: new Date() }));
    const s = await getSetupState();
    expect(s.numbersConfirmedAt).not.toBeNull();
    expect(s.checklistDismissedAt).not.toBeNull();
    expect(await prisma.setupState.count()).toBe(1);
  });
});
