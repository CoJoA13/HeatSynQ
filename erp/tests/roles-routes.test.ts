import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { DELETE as del } from "@/app/api/admin/roles/[id]/route";
import { createRole, listRoles } from "@/server/roles";

// #8 — the route half of "destructive-ish actions require a reason" (spec §9). The SERVICE half has
// required a reason since 2026-08-01 (`roles.ts:54-70`, commit 47d6d0a) and is pinned by
// `tests/roles.test.ts`; what was never pinned is the ROUTE's body read, which hand-rolled
// `(await req.json().catch(() => ({}))) as { reason?: unknown }` and therefore threw a raw
// TypeError off `body.reason` for a JSON body of literal `null` — escaping handle()'s error mapping
// as a 500 instead of the service's own field-anchored 400. Identical shape and identical fix to
// /api/customers/[id] (customer-routes.test.ts:58-77) and /api/parts/[id]: `reasonFromBody`.

const withId = (id: string) => ({ params: Promise.resolve({ id }) });

describe("admin role routes", () => {
  beforeEach(truncateAll);

  it("DELETE with a JSON null body is 400, not 500; a valid reason still deletes", async () => {
    const cookie = await signInWith(["admin.view", "admin.delete"], "role-del-null");
    const { id } = await createRole("Doomed");

    const nullBody = await del(new Request(`http://t/api/admin/roles/${id}`, {
      method: "DELETE", headers: { cookie, "content-type": "application/json" }, body: "null",
    }), withId(id));
    expect(nullBody.status).toBe(400);
    expect((await nullBody.json()).error).toMatch(/reason/i);

    const ok = await del(new Request(`http://t/api/admin/roles/${id}`, {
      method: "DELETE", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ reason: "merged into Shop Floor" }),
    }), withId(id));
    expect(ok.status).toBe(200);

    expect((await listRoles()).map((r) => r.name)).not.toContain("Doomed");
    // The reason reaches the audit entry — the whole point of collecting it (§9's "who, when, why").
    const entry = await prisma.auditLog.findFirst({ where: { entity: "role", entityId: id, action: "delete" } });
    expect(entry!.reason).toBe("merged into Shop Floor");
  });

  // The `catch(() => null)` in `reasonFromBody`'s caller must keep answering the service's 400 for a
  // body-less DELETE rather than failing on the JSON parse — pinned so the swap to `reasonFromBody`
  // (which takes `null`, not `{}`, as its no-body sentinel) cannot silently regress it.
  it("DELETE with no body at all is the service's missing-reason 400", async () => {
    const cookie = await signInWith(["admin.view", "admin.delete"], "role-del-nobody");
    const { id } = await createRole("Doomed");

    const res = await del(new Request(`http://t/api/admin/roles/${id}`, {
      method: "DELETE", headers: { cookie },
    }), withId(id));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/reason/i);
    expect((await listRoles()).map((r) => r.name)).toContain("Doomed");
  });

  it("DELETE with a whitespace-only reason is refused — the service trims", async () => {
    const cookie = await signInWith(["admin.view", "admin.delete"], "role-del-blank");
    const { id } = await createRole("Doomed");

    const res = await del(new Request(`http://t/api/admin/roles/${id}`, {
      method: "DELETE", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ reason: "   " }),
    }), withId(id));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/reason/i);
    expect((await listRoles()).map((r) => r.name)).toContain("Doomed");
  });

  it("401s without a session and 403s a caller without admin.delete", async () => {
    const { id } = await createRole("Doomed");
    expect((await del(new Request(`http://t/api/admin/roles/${id}`, { method: "DELETE" }), withId(id))).status).toBe(401);

    const viewOnly = await signInWith(["admin.view"], "role-del-403");
    const res = await del(new Request(`http://t/api/admin/roles/${id}`, {
      method: "DELETE", headers: { cookie: viewOnly, "content-type": "application/json" },
      body: JSON.stringify({ reason: "not allowed" }),
    }), withId(id));
    expect(res.status).toBe(403);
    expect((await listRoles()).map((r) => r.name)).toContain("Doomed");
  });
});
