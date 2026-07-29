import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { hashPassword } from "@/server/password";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";

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
    const res = await login(jsonReq("http://t/api/auth/login", { username: "admin", password: "secret1" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("erp_session=");
  });

  it("rejects bad credentials with a generic message", async () => {
    const res = await login(jsonReq("http://t/api/auth/login", { username: "admin", password: "nope" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid username or password");
  });

  it("logout clears the cookie", async () => {
    const loginRes = await login(jsonReq("http://t/api/auth/login", { username: "admin", password: "secret1" }));
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0];
    const res = await logout(jsonReq("http://t/api/auth/logout", {}, cookie));
    expect(res.headers.get("set-cookie")).toContain("erp_session=;");
  });
});
