import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, prisma } from "./helpers/db";
import { hashPassword } from "@/server/password";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as createReferenceHandler } from "@/app/api/admin/reference/[kind]/route";

/**
 * Locks the exact, field-anchored zod messages spec §12 promises — not just "some 400 with
 * some text". These three cases are the ones a 2026-07-30 investigation found flattened to
 * the generic "Invalid input" under Next's bundler while vitest produced the specific text
 * below, because zod's locale registration (a `config(en())` side effect in its own entry
 * point) got tree-shaken out of the Next server bundle — see src/server/error-message.ts for
 * the fix and full explanation.
 *
 * This file alone does NOT prove the Next bundler is fixed: vitest never reproduced the bug
 * in the first place (that's exactly what let it ship). The task-11 report documents the real
 * HTTP calls, against both `next build`+`next start` and `next dev`, that do prove it.
 */
const TEST_CTX = { params: Promise.resolve({ kind: "material" }) };

function jsonReq(body: unknown, cookie?: string): Request {
  return new Request("http://t/api/admin/reference/material", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

describe("validation messages are specific and field-anchored", () => {
  let cookie: string;

  beforeEach(async () => {
    await truncateAll();
    const role = await prisma.role.create({
      data: { name: "Admin", permissions: { create: [{ permission: "admin.create" }] } },
    });
    await prisma.user.create({
      data: {
        username: "admin",
        displayName: "Admin User",
        passwordHash: await hashPassword("adminpass123"),
        roleId: role.id,
      },
    });
    const loginRes = await login(
      new Request("http://t/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "adminpass123" }),
      }),
      { params: Promise.resolve({}) },
    );
    cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
  });

  it("reports empty name with the specific too-small message, not 'Invalid input'", async () => {
    const res = await createReferenceHandler(jsonReq({ name: "" }, cookie), TEST_CTX);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("name: Too small: expected string to have >=1 characters");
  });

  it("reports a wrong-typed name with the specific type-mismatch message", async () => {
    const res = await createReferenceHandler(jsonReq({ name: 123 }, cookie), TEST_CTX);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("name: Invalid input: expected string, received number");
  });

  it("reports an unrecognized key by name, not a generic body error", async () => {
    const res = await createReferenceHandler(
      jsonReq({ name: "X", description: "leaked" }, cookie),
      TEST_CTX,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('body: Unrecognized key: "description"');
  });
});
