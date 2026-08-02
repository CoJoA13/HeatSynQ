import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { GET as list, POST as create } from "@/app/api/customers/route";
import { GET as detail, PUT as update, DELETE as remove } from "@/app/api/customers/[id]/route";
import { createCustomer } from "@/server/customers";

const noParams = { params: Promise.resolve({}) };
const withId = (id: string) => ({ params: Promise.resolve({ id }) });

describe("customer routes", () => {
  beforeEach(async () => await truncateAll());

  it("401s every verb without a session", async () => {
    expect((await list(new Request("http://t/api/customers"), noParams)).status).toBe(401);
    expect((await create(new Request("http://t/api/customers", { method: "POST", body: "{}" }), noParams)).status).toBe(401);
    expect((await detail(new Request("http://t/api/customers/x"), withId("x"))).status).toBe(401);
    expect((await update(new Request("http://t/api/customers/x", { method: "PUT", body: "{}" }), withId("x"))).status).toBe(401);
    expect((await remove(new Request("http://t/api/customers/x", { method: "DELETE" }), withId("x"))).status).toBe(401);
  });

  it("403s each verb the user lacks, while view still works", async () => {
    const cookie = await signInWith(["customers.view"]);
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });

    expect((await list(new Request("http://t/api/customers", { headers: { cookie } }), noParams)).status).toBe(200);
    expect((await detail(new Request(`http://t/api/customers/${id}`, { headers: { cookie } }), withId(id))).status).toBe(200);

    const post = await create(new Request("http://t/api/customers", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ code: "NEW", name: "New" }),
    }), noParams);
    expect(post.status).toBe(403);

    const put = await update(new Request(`http://t/api/customers/${id}`, {
      method: "PUT", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    }), withId(id));
    expect(put.status).toBe(403);

    const del = await remove(new Request(`http://t/api/customers/${id}`, {
      method: "DELETE", headers: { cookie },
    }), withId(id));
    expect(del.status).toBe(403);
  });

  // G2: `(await req.json().catch(() => ({}))) as { reason?: unknown }` threw a raw TypeError
  // reading `.reason` off a JSON body of `null`, escaping handle()'s error mapping as an
  // unhandled 500 instead of the service's own missing-reason 400. Identical shape to
  // /api/parts/[id]'s DELETE (parts-routes.test.ts).
  it("DELETE with a JSON null body is 400, not 500; a valid reason still deletes", async () => {
    const cookie = await signInWith(["customers.view", "customers.create", "customers.delete"], "del-null-1");
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });

    const nullBody = await remove(new Request(`http://t/api/customers/${id}`, {
      method: "DELETE", headers: { cookie, "content-type": "application/json" }, body: "null",
    }), withId(id));
    expect(nullBody.status).toBe(400);
    expect((await nullBody.json()).error).toMatch(/reason/i);

    const ok = await remove(new Request(`http://t/api/customers/${id}`, {
      method: "DELETE", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ reason: "test reason" }),
    }), withId(id));
    expect(ok.status).toBe(200);
  });

  it("round-trips a create through the route and honours search", async () => {
    const cookie = await signInWith(["customers.view", "customers.create"]);
    const res = await create(new Request("http://t/api/customers", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ code: "ACME", name: "Acme Foundry" }),
    }), noParams);
    expect(res.status).toBe(200);

    const found = await list(new Request("http://t/api/customers?search=acme", { headers: { cookie } }), noParams);
    expect((await found.json()).map((c: { code: string }) => c.code)).toEqual(["ACME"]);
  });

  it("surfaces a duplicate code as a readable 400", async () => {
    const cookie = await signInWith(["customers.view", "customers.create"]);
    await createCustomer({ code: "ACME", name: "Acme" });
    const res = await create(new Request("http://t/api/customers", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ code: "ACME", name: "Dup" }),
    }), noParams);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already exists/i);
  });
});
