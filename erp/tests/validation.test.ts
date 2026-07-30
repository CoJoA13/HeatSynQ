import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { hashPassword } from "@/server/password";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as createUserHandler } from "@/app/api/admin/users/route";
import { POST as createRoleHandler } from "@/app/api/admin/roles/route";

const TEST_CTX = { params: Promise.resolve({}) };

function jsonReq(url: string, body: unknown, cookie?: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

describe("validation error responses", () => {
  let cookie: string;

  beforeEach(async () => {
    await truncateAll();

    // Create a role with manage_users and admin.edit permissions
    const role = await prisma.role.create({
      data: {
        name: "Admin",
        permissions: {
          create: [
            { permission: "action.manage_users" },
            { permission: "admin.edit" },
          ],
        },
      },
    });

    // Create an admin user with that role
    await prisma.user.create({
      data: {
        username: "admin",
        displayName: "Admin User",
        passwordHash: await hashPassword("adminpass123"),
        roleId: role.id,
      },
    });

    // Log in to get session cookie
    const loginRes = await login(
      jsonReq("http://t/api/auth/login", { username: "admin", password: "adminpass123" }),
      TEST_CTX
    );
    const setCookie = loginRes.headers.get("set-cookie") || "";
    cookie = setCookie.split(";")[0];
  });

  it("returns 400 with field-anchored error for invalid user password", async () => {
    const res = await createUserHandler(
      jsonReq(
        "http://t/api/admin/users",
        { username: "newuser", displayName: "New User", password: "short" },
        cookie
      ),
      TEST_CTX
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/password/i);
  });

  it("returns 400 with field-anchored error for missing role name", async () => {
    const res = await createRoleHandler(
      jsonReq("http://t/api/admin/roles", {}, cookie),
      TEST_CTX
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/name/i);
  });
});
