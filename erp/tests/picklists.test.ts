import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { createReference, deleteReference, updateReference } from "@/server/reference";
import { createStepCode } from "@/server/process-step-codes";
import { GET } from "@/app/api/picklists/[kind]/route";
import { signInWith } from "./helpers/auth";

const ctx = (kind: string) => ({ params: Promise.resolve({ kind }) });

describe("pick-list route", () => {
  beforeEach(async () => await truncateAll());

  it("401s without a session", async () => {
    const res = await GET(new Request("http://x/api/picklists/material"), ctx("material"));
    expect(res.status).toBe(401);
  });

  it("serves a kind to a user holding NO area permissions", async () => {
    // The whole point: a user with customers.edit but not admin.view must still see Terms.
    // Nothing to grant means nothing to forget.
    await createReference("material", { name: "4140" });
    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/material", { headers: { cookie } }),
                          ctx("material"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: expect.any(String), name: "4140", active: true }]);
  });

  it("serves process step codes without leaking their GL account", async () => {
    const gl = await createReference("glAccount", { name: "4010" });
    await createStepCode({ code: "HT-01", name: "Austenitize", glAccountId: gl.id });
    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/processStepCode", { headers: { cookie } }),
                          ctx("processStepCode"));
    const [row] = await res.json();
    expect(row).toEqual({ id: expect.any(String), name: expect.stringContaining("HT-01"), active: true });
    expect(row).not.toHaveProperty("glAccountId");
  });

  // Phase 6 (spec §5.15): quote entry reads ending statements with a session, like every other
  // entry pick-list. The generic delegate branch serves it — id/name/active only, never `text`
  // or `isDefault` (the quote service resolves the default row itself, server-side).
  it("serves ending statements to any signed-in user", async () => {
    await createReference("endingStatement", { name: "Standard", text: "Valid 30 days.", isDefault: true });
    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/endingStatement", { headers: { cookie } }),
                          ctx("endingStatement"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: expect.any(String), name: "Standard", active: true }]);
  });

  it("404s glAccount — it stays admin-only", async () => {
    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/glAccount", { headers: { cookie } }),
                          ctx("glAccount"));
    expect(res.status).toBe(404);
  });

  it("404s an unknown kind", async () => {
    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/nope", { headers: { cookie } }), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("excludes soft-deleted rows and, by default, inactive ones", async () => {
    const live = await createReference("carrier", { name: "UPS" });
    const dead = await createReference("carrier", { name: "Gone" });
    await deleteReference("carrier", dead.id);
    const off = await createReference("carrier", { name: "Retired" });
    await updateReference("carrier", off.id, { active: false });

    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/carrier", { headers: { cookie } }), ctx("carrier"));
    expect((await res.json()).map((r: { id: string }) => r.id)).toEqual([live.id]);

    // includeInactive=1 brings back the inactive row but never the deleted one — an assigned
    // inactive value must still render, which is the inactive-vs-deleted distinction.
    const res2 = await GET(new Request("http://x/api/picklists/carrier?includeInactive=1", { headers: { cookie } }),
                           ctx("carrier"));
    const ids = (await res2.json()).map((r: { id: string }) => r.id);
    expect(ids).toContain(off.id);
    expect(ids).not.toContain(dead.id);
  });
});
