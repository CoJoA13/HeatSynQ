import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, prisma } from "./helpers/db";
import { PUT } from "@/app/api/admin/users/[id]/route";
import { createUser } from "@/server/users";
import { readAudit } from "@/server/audit";
import { signInWith } from "./helpers/auth";

// #237: PUT /api/admin/users/[id] used to run updateUser and setUserOverrides as two separate
// transactions, so a body carrying fields + a bad override committed (and audited) the field
// update, then 400'd on the overrides — a half-applied request whose caller got only the error.
// The route now applies both parts in ONE transaction: a refusal anywhere leaves NOTHING behind.

const putReq = (cookie: string, body: unknown) =>
  new Request("http://t/api/admin/users/x", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("PUT /api/admin/users/[id] atomicity (#237)", () => {
  beforeEach(truncateAll);

  it("a body carrying fields + an unknown override permission commits NOTHING", async () => {
    const cookie = await signInWith(["action.manage_users"], "mgr");
    const { id } = await createUser({ username: "jane", displayName: "Before", password: "pw123456" });

    const res = await PUT(putReq(cookie, {
      displayName: "After",
      overrides: [{ permission: "bogus.key", mode: "DENY" }],
    }), ctx(id));

    expect(res.status).toBe(400);
    const row = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(row.displayName).toBe("Before"); // the half-commit: this read "After" pre-fix
    expect(await prisma.userPermissionOverride.count({ where: { userId: id } })).toBe(0);
    // And no audit entry for a write that was refused whole.
    expect((await readAudit("user", id)).map((l) => l.action)).toEqual(["create"]);
  });

  it("403 for a caller without manage_users, and nothing commits", async () => {
    const cookie = await signInWith(["admin.view", "admin.edit"], "not-mgr"); // area perms are not the special action
    const { id } = await createUser({ username: "sam", displayName: "Same", password: "pw123456" });
    const res = await PUT(putReq(cookie, { displayName: "Changed" }), ctx(id));
    expect(res.status).toBe(403);
    const row = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(row.displayName).toBe("Same");
  });

  it("a body carrying BOTH fields and overrides lands as ONE audit entry showing both", async () => {
    const cookie = await signInWith(["action.manage_users"], "mgr2");
    const { id } = await createUser({ username: "bob", displayName: "B", password: "pw123456" });

    const res = await PUT(putReq(cookie, {
      displayName: "B2",
      overrides: [{ permission: "orders.view", mode: "GRANT" }],
    }), ctx(id));

    expect(res.status).toBe(200);
    const log = await readAudit("user", id);
    expect(log.map((l) => l.action)).toEqual(["update", "create"]); // one update, not two
    const entry = log[0];
    expect((entry.before as { displayName: string }).displayName).toBe("B");
    expect((entry.after as { displayName: string }).displayName).toBe("B2");
    const after = (entry.after as { overrides: { permission: string; mode: string }[] }).overrides;
    expect(after.map((o) => ({ permission: o.permission, mode: o.mode })))
      .toEqual([{ permission: "orders.view", mode: "GRANT" }]);
  });
});
