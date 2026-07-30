import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/health/route";

describe("health endpoint", () => {
  it("reports ok and database connectivity", async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, db: true });
  });
});
