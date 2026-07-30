import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { hashPassword } from "@/server/password";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as auditGet } from "@/app/api/admin/audit/route";
import { auditedUpdate } from "@/server/audit";

async function adminCookie(): Promise<string> {
  const role = await prisma.role.create({
    data: { name: "Admin", permissions: { create: [{ permission: "admin.view" }, { permission: "admin.edit" }] } },
  });
  await prisma.user.create({
    data: { username: "root", displayName: "Root", passwordHash: await hashPassword("secret1"), roleId: role.id },
  });
  const res = await login(new Request("http://t/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "root", password: "secret1" }),
  }), { params: Promise.resolve({}) });
  return res.headers.get("set-cookie")!.split(";")[0];
}

function get(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

describe("audit route", () => {
  beforeEach(async () => await truncateAll());

  it("requires login", async () => {
    const res = await auditGet(get("http://t/api/admin/audit"), { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it("returns entries filtered by entity/entityId", async () => {
    const cookie = await adminCookie();
    const u = await prisma.user.create({ data: { username: "j", passwordHash: "x", displayName: "J" } });
    await auditedUpdate("user", u.id, () =>
      prisma.user.update({ where: { id: u.id }, data: { displayName: "K" } }));
    const res = await auditGet(get(`http://t/api/admin/audit?entity=user&entityId=${u.id}`, cookie),
      { params: Promise.resolve({}) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].action).toBe("update");
  });

  it("rejects invalid 'from' date with 400", async () => {
    const cookie = await adminCookie();
    const res = await auditGet(get("http://t/api/admin/audit?from=notadate", cookie),
      { params: Promise.resolve({}) });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/from/i);
  });

  it("accepts valid date range params and returns array", async () => {
    const cookie = await adminCookie();
    const res = await auditGet(get("http://t/api/admin/audit?from=2020-01-01&to=2030-01-01", cookie),
      { params: Promise.resolve({}) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });
});
