import { prisma } from "./db";
import { hashPassword } from "@/server/password";
import { POST as login } from "@/app/api/auth/login/route";

/**
 * Creates a role carrying exactly `permissions`, a user holding it, and returns that
 * user's session cookie. Used by every route test that needs an authenticated request.
 */
export async function signInWith(permissions: string[], username = "root"): Promise<string> {
  const role = await prisma.role.create({
    data: {
      name: `Role-${username}`,
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
  });
  await prisma.user.create({
    data: {
      username, displayName: username,
      passwordHash: await hashPassword("secret1"), roleId: role.id,
    },
  });
  const res = await login(new Request("http://t/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "secret1" }),
  }), { params: Promise.resolve({}) });
  return res.headers.get("set-cookie")!.split(";")[0];
}
