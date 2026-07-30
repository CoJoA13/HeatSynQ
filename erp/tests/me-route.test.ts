import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { hashPassword } from "@/server/password";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as me } from "@/app/api/auth/me/route";

describe("/api/auth/me", () => {
  beforeEach(async () => await truncateAll());

  it("returns effective permissions (role + GRANT − DENY)", async () => {
    const role = await prisma.role.create({
      data: { name: "Office", permissions: { create: [{ permission: "orders.view" }, { permission: "orders.edit" }] } },
    });
    const user = await prisma.user.create({
      data: {
        username: "jane", displayName: "Jane", passwordHash: await hashPassword("secret1"), roleId: role.id,
        overrides: { create: [
          { permission: "reports.view", mode: "GRANT" },
          { permission: "orders.edit", mode: "DENY" },
        ] },
      },
    });
    const loginRes = await login(new Request("http://t/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "jane", password: "secret1" }),
    }), { params: Promise.resolve({}) });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0];
    const res = await me(new Request("http://t/api/auth/me", { headers: { cookie } }), { params: Promise.resolve({}) });
    const body = await res.json();
    expect(body.id).toBe(user.id);
    expect(body.permissions.sort()).toEqual(["orders.view", "reports.view"]);
  });

  it("401s without a session", async () => {
    const res = await me(new Request("http://t/api/auth/me"), { params: Promise.resolve({}) });
    expect(res.status).toBe(401); // (one-arg handler calls are a type error now that ctx is required)
  });
});
