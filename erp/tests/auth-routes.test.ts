import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { hashPassword } from "@/server/password";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";

const TEST_CTX = { params: Promise.resolve({}) };

function jsonReq(url: string, body: unknown, cookie?: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

describe("auth routes", () => {
  beforeEach(async () => {
    await truncateAll();
    await prisma.user.create({
      data: { username: "admin", displayName: "Admin", passwordHash: await hashPassword("secret1") },
    });
  });

  it("logs in with correct credentials and sets the session cookie", async () => {
    const res = await login(jsonReq("http://t/api/auth/login", { username: "admin", password: "secret1" }), TEST_CTX);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("erp_session=");
  });

  it("rejects bad credentials with a generic message", async () => {
    const res = await login(jsonReq("http://t/api/auth/login", { username: "admin", password: "nope" }), TEST_CTX);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid username or password");
  });

  it("rejects an unknown username with a generic message", async () => {
    const res = await login(jsonReq("http://t/api/auth/login", { username: "nobody", password: "secret1" }), TEST_CTX);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid username or password");
  });

  it("rejects an inactive user with a generic message", async () => {
    await prisma.user.create({
      data: {
        username: "inactive",
        displayName: "Inactive User",
        passwordHash: await hashPassword("secret1"),
        active: false,
      },
    });
    const res = await login(jsonReq("http://t/api/auth/login", { username: "inactive", password: "secret1" }), TEST_CTX);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid username or password");
  });

  it("rejects a soft-deleted user with a generic message", async () => {
    await prisma.user.create({
      data: {
        username: "deleted",
        displayName: "Deleted User",
        passwordHash: await hashPassword("secret1"),
        deletedAt: new Date(),
      },
    });
    const res = await login(jsonReq("http://t/api/auth/login", { username: "deleted", password: "secret1" }), TEST_CTX);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid username or password");
  });

  it("rejects a malformed JSON body with a generic message", async () => {
    const req = new Request("http://t/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await login(req, TEST_CTX);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid username or password");
  });

  it("logout clears the cookie", async () => {
    const loginRes = await login(jsonReq("http://t/api/auth/login", { username: "admin", password: "secret1" }), TEST_CTX);
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0];
    const res = await logout(jsonReq("http://t/api/auth/logout", {}, cookie), TEST_CTX);
    expect(res.headers.get("set-cookie")).toContain("erp_session=;");
  });
});
