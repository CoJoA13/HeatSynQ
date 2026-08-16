import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { GET as getView } from "@/app/api/admin/backups/route";
import { GET as getHealth } from "@/app/api/admin/backups/health/route";
import { POST as postRun } from "@/app/api/admin/backups/run/route";

// The repo's real route-test idiom (tests/excel.test.ts is the model):
//   signInWith(permissions: string[], username?) -> a COOKIE STRING (not a user object)
//   the request carries it as `headers: { cookie }`
//   ctx is always passed — the Handler type requires it (Next's ParamCheck rejects optional ctx)
// There is NO tests/helpers/http.ts and no `requestAs`. Do not create them.
const ctx = { params: Promise.resolve({}) };
const req = (url: string, cookie?: string, init: RequestInit = {}) =>
  new Request(url, { ...init, headers: cookie ? { cookie } : {} });

describe("backup routes", () => {
  beforeEach(async () => { await truncateAll(); });

  it("401s an anonymous caller on every route", async () => {
    expect((await getView(req("http://t/api/admin/backups"), ctx)).status).toBe(401);
    expect((await getHealth(req("http://t/api/admin/backups/health"), ctx)).status).toBe(401);
    expect((await postRun(req("http://t/api/admin/backups/run", undefined, { method: "POST" }), ctx)).status).toBe(401);
  });

  it("403s a signed-in caller who lacks manage_backups, on every route", async () => {
    const cookie = await signInWith(["admin.view"]);
    expect((await getView(req("http://t/api/admin/backups", cookie), ctx)).status).toBe(403);
    expect((await getHealth(req("http://t/api/admin/backups/health", cookie), ctx)).status).toBe(403);
    expect((await postRun(req("http://t/api/admin/backups/run", cookie, { method: "POST" }), ctx)).status).toBe(403);
  });

  it("serves the folder, health and archive list to a holder of manage_backups", async () => {
    const cookie = await signInWith(["action.manage_backups"]);
    const res = await getView(req("http://t/api/admin/backups", cookie), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("folder");
    expect(body.health).toHaveProperty("state");
    expect(Array.isArray(body.archives)).toBe(true);
  });

  it("serves health alone on the cheap endpoint", async () => {
    const cookie = await signInWith(["action.manage_backups"]);
    const res = await getHealth(req("http://t/api/admin/backups/health", cookie), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("state");
    expect(body).toHaveProperty("staleHours");
    expect(body).not.toHaveProperty("archives");
  });

  it("reports a missing/unreadable folder as a clean red state, not a 500", async () => {
    const prev = process.env.BACKUP_DIR;
    process.env.BACKUP_DIR = "/nonexistent-backup-folder-for-tests";
    try {
      const cookie = await signInWith(["action.manage_backups"]);
      const res = await getHealth(req("http://t/api/admin/backups/health", cookie), ctx);
      expect(res.status).toBe(200);
      expect((await res.json()).state).toBe("unknown");
    } finally {
      if (prev === undefined) delete process.env.BACKUP_DIR; else process.env.BACKUP_DIR = prev;
    }
  });
});
