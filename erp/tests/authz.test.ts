import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { hashPassword } from "@/server/password";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as rolesGet } from "@/app/api/admin/roles/route";
import { PUT as settingsPut } from "@/app/api/admin/settings/route";
import { GET as usersGet } from "@/app/api/admin/users/route";

const TEST_CTX = { params: Promise.resolve({}) };

/** Logs in a user with no role and no overrides — i.e. no permissions at all. */
async function noPermissionsCookie(): Promise<string> {
  await prisma.user.create({
    data: { username: "nobody", displayName: "Nobody", passwordHash: await hashPassword("secret1") },
  });
  const res = await login(new Request("http://t/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "nobody", password: "secret1" }),
  }), TEST_CTX);
  return res.headers.get("set-cookie")!.split(";")[0];
}

describe("route-level authorization (403)", () => {
  beforeEach(async () => await truncateAll());

  it("GET /api/admin/roles 403s a logged-in user without admin.view", async () => {
    const cookie = await noPermissionsCookie();
    const res = await rolesGet(new Request("http://t/api/admin/roles", { headers: { cookie } }), TEST_CTX);
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error).toMatch(/permission/i);
  });

  it("PUT /api/admin/settings 403s a logged-in user without admin.edit", async () => {
    const cookie = await noPermissionsCookie();
    const res = await settingsPut(new Request("http://t/api/admin/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ key: "company_name", value: "Acme" }),
    }), TEST_CTX);
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error).toMatch(/permission/i);
  });

  it("GET /api/admin/users 403s a logged-in user without manage_users", async () => {
    const cookie = await noPermissionsCookie();
    const res = await usersGet(new Request("http://t/api/admin/users", { headers: { cookie } }), TEST_CTX);
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error).toMatch(/permission/i);
  });
});
