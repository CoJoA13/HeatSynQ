import { describe, it, expect, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

// The per-entry area filter (Task 6, spec §4.1) — the invoice register and A/R aging are homed under
// /reports but LIVE in the invoicing / receivables areas, so `GET /api/reports` gates each on its own
// `<area>.view`, not on `reports.view`. A `reports.view`-only user reaches the index but must NOT see
// an entry whose source area it lacks. This is the behavioral filter test Task 0 could not write
// (REPORTS was empty then); Task 6 adds the first cross-area entries, so it is written here now.
describe("GET /api/reports — per-entry area filter (Task 6 cross-area homing)", () => {
  it("hides the invoice register and A/R aging from a reports.view user without the source area", async () => {
    const cookie = await signInWith(["reports.view"], "reports-noarea");
    const res = await reportsIndexRoute(getReq("http://t/api/reports", cookie), withParams());
    expect(res.status).toBe(200);
    const keys = ((await res.json()) as { key: string }[]).map((r) => r.key);
    // same-area report entries stay visible for a reports.view holder...
    expect(keys).toContain("backlog");
    // ...but the homed cross-area entries are gated on THEIR area, which this user lacks.
    expect(keys).not.toContain("invoice-register");
    expect(keys).not.toContain("aging");
  });

  it("shows both homed entries — at their real routes — to a user who also holds the source areas", async () => {
    const cookie = await signInWith(
      ["reports.view", "invoicing.view", "receivables.view"], "reports-witharea");
    const res = await reportsIndexRoute(getReq("http://t/api/reports", cookie), withParams());
    expect(res.status).toBe(200);
    const entries = (await res.json()) as { key: string; href: string; area: string }[];
    expect(entries.find((e) => e.key === "invoice-register"))
      .toMatchObject({ href: "/invoicing", area: "invoicing" });
    expect(entries.find((e) => e.key === "aging"))
      .toMatchObject({ href: "/receivables/aging", area: "receivables" });

    // Light assertion: each homed href resolves to a real App Router page (the pages are
    // already tested elsewhere; this only pins that the registry links somewhere real).
    for (const href of ["/invoicing", "/receivables/aging"]) {
      expect(existsSync(join(process.cwd(), "src", "app", href, "page.tsx"))).toBe(true);
    }
  });
});
