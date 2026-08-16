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

  it("the route is refused on a non-practice database", async () => {
    const cookie = await signInWith(["admin.view", "admin.edit"], "reset-admin");
    expect((await POST(postReq(cookie), noParams)).status).toBe(403);
  });

  it("the route is refused without admin.edit", async () => {
    const cookie = await signInWith(["admin.view"], "reset-viewer");
    expect((await POST(postReq(cookie), noParams)).status).toBe(403);
  });
});
