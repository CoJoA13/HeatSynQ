import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { resetPracticeData, resetPracticeDataUnguarded } from "@/server/practice-reset";
import { POST } from "@/app/api/practice/reset/route";
import { orderEntryReadiness } from "@/server/order-entry-readiness";
import { verifyPassword } from "@/server/password";
import { signInWith } from "./helpers/auth";

const noParams = { params: Promise.resolve({}) };
const postReq = (cookie: string) =>
  new Request("http://t/api/practice/reset", {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}",
  });

describe("practice reset (Phase 8B §5.3)", () => {
  beforeEach(truncateAll);

  it("the guarded entry REFUSES (403) when the DB is not erp_practice — the load-bearing guard", async () => {
    // vitest connects to erp_test, so current_database() !== 'erp_practice'.
    await expect(resetPracticeData()).rejects.toMatchObject({ status: 403 });
  });

  it("the unguarded reset restores singletons BEFORE demo rows and leaves a gate-passing, loginable install", async () => {
    await resetPracticeDataUnguarded();

    // Singletons restored.
    expect((await prisma.billingConfig.findFirst({ where: { id: "singleton" } }))?.id).toBe("singleton");
    expect((await prisma.setupState.findFirst({ where: { id: "singleton" } }))?.id).toBe("singleton");
    expect(await prisma.documentTemplate.count()).toBeGreaterThan(0);

    // The demo slice passes the order-entry gate and is loginable.
    expect((await orderEntryReadiness()).ready).toBe(true);
    const admin = await prisma.user.findFirst({ where: { username: "admin", deletedAt: null } });
    expect(admin).not.toBeNull();
    expect(await verifyPassword(admin!.passwordHash, "admin")).toBe(true);
    expect(await prisma.order.count()).toBeGreaterThan(0);
  });

  // #233 item 1: both refusals are 403 — `mustCan` fires first, then the practice-database gate —
  // so a bare status assertion cannot tell them apart, and the permission test below passed
  // whether or not `mustCan` was still there (erp_test is never erp_practice, so the db gate
  // would have answered anyway). Assert the MESSAGE, the only thing that distinguishes them.
  it("the route is refused on a non-practice database, naming the practice copy", async () => {
    const cookie = await signInWith(["admin.view", "admin.edit"], "reset-admin");
    const res = await POST(postReq(cookie), noParams);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Reset is only available on the practice copy.");
  });

  it("the route is refused without admin.edit, by the PERMISSION check not the db gate", async () => {
    const cookie = await signInWith(["admin.view"], "reset-viewer");
    const res = await POST(postReq(cookie), noParams);
    expect(res.status).toBe(403);
    // The permission wording, NOT "Reset is only available on the practice copy." — delete the
    // `mustCan` and this reddens, which the old status-only assertion could not do.
    expect((await res.json()).error).toBe("You do not have permission for that");
  });
});
