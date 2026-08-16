import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { seedDemoSlice, seedPracticeDemo } from "../prisma/demo-seed";
import { orderEntryReadiness } from "@/server/order-entry-readiness";
import { verifyPassword } from "@/server/password";
import { ALL_PERMISSIONS } from "@/server/permissions";

// The demo seed writes through the ambient `DATABASE_URL` singleton (erp_test in this process), so
// `seedDemoSlice()` — the un-guarded internal orchestration — is exercised directly here. The
// guarded entry (`seedPracticeDemo`) can only run its happy path on `erp_practice`, so in CI its
// REFUSAL is the test (the §5.3 db-identity guard-split).
describe("demo-seed", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("seeds a login-capable, gate-passing representative slice through the services", async () => {
    await seedDemoSlice();

    // A login-capable admin: Role -> ALL_PERMISSIONS -> a user whose hash verifies "admin".
    const admin = await prisma.user.findFirst({
      where: { username: "admin" },
      include: { role: { include: { permissions: true } } },
    });
    expect(admin).not.toBeNull();
    expect(admin!.role).not.toBeNull();
    expect(await verifyPassword(admin!.passwordHash, "admin")).toBe(true);
    expect(admin!.role!.permissions.length).toBe(ALL_PERMISSIONS.length);

    // Company identity + chart of accounts + arGlAccountId all set -> the order-entry gate passes
    // with no exemption.
    const readiness = await orderEntryReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.gaps).toEqual([]);
    expect(await prisma.glAccount.count({ where: { deletedAt: null } })).toBeGreaterThan(0);
    const billing = await prisma.billingConfig.findFirst({ where: { id: "singleton" } });
    expect(billing?.arGlAccountId).not.toBeNull();

    // Orders spanning every headline state (assert the SHAPE, not brittle counts).
    const statuses = new Set<string>(
      (await prisma.order.findMany({ where: { deletedAt: null }, select: { status: true } })).map((o) => o.status),
    );
    for (const state of ["OPEN", "PARTIAL_SHIPPED", "SHIPPED", "INVOICED"]) {
      expect(statuses.has(state)).toBe(true);
    }

    // At least one FINALIZED invoice, and one POSTED payment batch with a live payment.
    expect(await prisma.invoice.count({ where: { status: "FINALIZED" } })).toBeGreaterThanOrEqual(1);
    expect(await prisma.receiptBatch.count({ where: { status: "POSTED", deletedAt: null } })).toBeGreaterThanOrEqual(1);
    expect(await prisma.payment.count({ where: { deletedAt: null } })).toBeGreaterThanOrEqual(1);

    // A parent/division customer pair (the division points at the parent).
    const parent = await prisma.customer.findFirst({ where: { code: "AERO", deletedAt: null } });
    const division = await prisma.customer.findFirst({ where: { code: "AERO-MW", deletedAt: null } });
    expect(parent).not.toBeNull();
    expect(division?.parentId).toBe(parent!.id);

    // Built through the services, so `allocateNumber` bumped the counters rather than a pre-written
    // `*_number_next` seed: the first order is #1000 (the counter's default seed).
    const firstOrder = await prisma.order.findFirst({ where: { deletedAt: null }, orderBy: { orderNumber: "asc" } });
    expect(firstOrder?.orderNumber).toBe(1000);

    // Representative depth reached the leaves: pricing rows (with a break), recipes, specs, inspections.
    expect(await prisma.partPriceBreak.count({ where: { deletedAt: null } })).toBeGreaterThan(0);
    expect(await prisma.partInspection.count({ where: { deletedAt: null } })).toBeGreaterThan(0);
    expect(await prisma.partProcessStep.count()).toBeGreaterThan(0);
  });

  it("guarded entry refuses outside the practice database (the §5.3 RED guard)", async () => {
    // current_database() is 'erp_test' in this process, never 'erp_practice', so assertPracticeDatabase
    // throws a 403 before seedDemoSlice runs.
    await expect(seedPracticeDemo()).rejects.toMatchObject({ status: 403 });
    // Nothing was written — the guard fires first.
    expect(await prisma.order.count()).toBe(0);
  });
});
