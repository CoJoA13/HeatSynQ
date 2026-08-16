import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { GET } from "@/app/api/orders/entry-readiness/route";
import { signInWith } from "./helpers/auth";

const noParams = { params: Promise.resolve({}) };
const getReq = (cookie: string) =>
  new Request("http://t/api/orders/entry-readiness", { headers: { cookie } });

describe("GET /api/orders/entry-readiness (Phase 8B §5.6)", () => {
  beforeEach(truncateAll);

  it("403 for a caller without orders.create", async () => {
    const cookie = await signInWith(["customers.view"], "no-create");
    const res = await GET(getReq(cookie), noParams);
    expect(res.status).toBe(403);
  });

  it("returns ready:false with gaps when setup is incomplete", async () => {
    const cookie = await signInWith(["orders.create"], "creator-a");
    const res = await GET(getReq(cookie), noParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.gaps.length).toBeGreaterThan(0);
  });

  it("returns ready:true with no gaps once company identity + chart of accounts are set", async () => {
    await seedOrderGatePrereqs();
    const cookie = await signInWith(["orders.create"], "creator-b");
    const res = await GET(getReq(cookie), noParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(true);
    expect(body.gaps).toEqual([]);
  });
});
