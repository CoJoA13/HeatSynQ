import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { GET as me } from "@/app/api/auth/me/route";

describe("request context", () => {
  beforeEach(async () => await truncateAll());

  it("resolves the session exactly once per request", async () => {
    const cookie = await signInWith(["admin.view"]);
    // Not vi.spyOn: Prisma 6.19's client Proxy reports a bogus
    // `{ value: undefined }` own-property descriptor for model methods, so tinyspy's
    // spyOn(prisma.session, "update").mockRestore() writes that `undefined` back over the
    // live method, permanently breaking every later prisma.session.update call in the
    // suite. A manual wrap/restore of the bound method sidesteps the descriptor entirely.
    const originalUpdate = prisma.session.update.bind(prisma.session);
    const spy = vi.fn(originalUpdate);
    prisma.session.update = spy as unknown as typeof prisma.session.update;
    try {
      const res = await me(new Request("http://t/api/auth/me", { headers: { cookie } }),
                           { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
      // One sliding-expiry write, not two.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      prisma.session.update = originalUpdate;
    }
  });

  it("me returns effective permissions via the shared resolver", async () => {
    const cookie = await signInWith(["admin.view"]);
    const res = await me(new Request("http://t/api/auth/me", { headers: { cookie } }),
                         { params: Promise.resolve({}) });
    expect(await res.json()).toMatchObject({ username: "root", permissions: ["admin.view"] });
  });

  it("DENY override beats a role grant in the me payload", async () => {
    const cookie = await signInWith(["admin.view"]);
    const user = await prisma.user.findUniqueOrThrow({ where: { username: "root" } });
    await prisma.userPermissionOverride.create({
      data: { userId: user.id, permission: "admin.view", mode: "DENY" },
    });
    const res = await me(new Request("http://t/api/auth/me", { headers: { cookie } }),
                         { params: Promise.resolve({}) });
    expect((await res.json()).permissions).toEqual([]);
  });

  it("401s with no cookie", async () => {
    const res = await me(new Request("http://t/api/auth/me"), { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it("401s with an expired session cookie", async () => {
    const cookie = await signInWith(["admin.view"]);
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await me(new Request("http://t/api/auth/me", { headers: { cookie } }),
                         { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it("401s when the user was deactivated after signing in", async () => {
    const cookie = await signInWith(["admin.view"]);
    await prisma.user.updateMany({ data: { active: false } });
    const res = await me(new Request("http://t/api/auth/me", { headers: { cookie } }),
                         { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });
});
