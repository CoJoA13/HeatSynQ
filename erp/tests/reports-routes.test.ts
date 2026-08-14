import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { GET as reportsIndexRoute } from "@/app/api/reports/route";

// Phase 8A Task 0 (spec §4.1) — the reports platform scaffold: the two range-scan indexes the
// reports need, and the /reports index API gated on `reports.view`. The report tasks (1–6) clone
// the shape documented in src/server/reports/README.md; this file pins the scaffold's two invariants.

const withParams = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

beforeEach(truncateAll);

// The migration 20260814115050_reports_indexes must have landed on erp_test — the Sales report
// range-scans Invoice by finalizedAt, the Payments-received report range-scans Payment by
// receivedDate. A missing index is a silent perf regression, not a test failure elsewhere, so it
// gets its own presence check (pg_indexes is authoritative; robust to Prisma's index naming).
describe("reports indexes (migration 20260814115050_reports_indexes)", () => {
  it("Invoice carries an index on finalizedAt", async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'Invoice' AND indexdef ILIKE '%finalizedAt%'`;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("Payment carries an index on receivedDate", async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'Payment' AND indexdef ILIKE '%receivedDate%'`;
    expect(rows.length).toBeGreaterThan(0);
  });
});

// The /reports index API — a read, so the only gate is `reports.view` (no create/edit/delete). It
// returns the report entries the actor may see (server-side per-entry area filtering, so Task 6's
// cross-area entries gate correctly), which the client index page renders.
describe("GET /api/reports", () => {
  it("401s without a session, 403s without reports.view, then returns the visible-report list with it", async () => {
    expect((await reportsIndexRoute(getReq("http://t/api/reports"), withParams())).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "reports-index-wrong");
    expect((await reportsIndexRoute(getReq("http://t/api/reports", wrong), withParams())).status).toBe(403);

    const viewer = await signInWith(["reports.view"], "reports-index-viewer");
    const res = await reportsIndexRoute(getReq("http://t/api/reports", viewer), withParams());
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
