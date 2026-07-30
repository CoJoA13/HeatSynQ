import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

describe("middleware (coarse auth gate)", () => {
  it("redirects to /login when the erp_session cookie is absent", () => {
    const req = new NextRequest("http://t/");
    const res = middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toMatch(/\/login$/);
  });

  it("passes through when the erp_session cookie is present", () => {
    const req = new NextRequest("http://t/", { headers: { cookie: "erp_session=abc" } });
    const res = middleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("passes through /login without a cookie (no redirect loop)", () => {
    const req = new NextRequest("http://t/login");
    const res = middleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });
});
