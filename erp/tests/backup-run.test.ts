import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { runBackupNow, listArchives, readStatus } from "@/server/backups";
import { MANUAL_ARCHIVE_RE, BACKUP_STATUS_FILENAME } from "@/lib/backup-constants";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";

const FAKE = path.join(process.cwd(), "tests/fixtures/fake-pg-dump.sh");

// runBackupNow writes an audit row, so it needs an actor in context. The repo's established idiom
// (tests/order-entry-readiness.test.ts) — there is NO tests/helpers/actor.ts, do not create one.
const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

describe("runBackupNow", () => {
  let dir: string;
  beforeEach(async () => {
    await truncateAll();
    dir = await mkdtemp(path.join(tmpdir(), "hsq-backup-run-"));
    delete process.env.FAKE_DUMP_MODE;
  });
  afterEach(async () => {
    delete process.env.FAKE_DUMP_MODE;
    await rm(dir, { recursive: true, force: true });
  });

  const run = () => asSystem(() => runBackupNow({ dumpBin: FAKE, dir }));

  it("writes a collision-proof, gzip-valid archive and returns it", async () => {
    const info = await run();
    expect(info.name).toMatch(MANUAL_ARCHIVE_RE);
    expect(info.source).toBe("manual");
    expect(info.integrityOk).toBe(true);
    expect(info.sizeBytes).toBeGreaterThan(0);

    const body = gunzipSync(await readFile(path.join(dir, info.name))).toString("utf8");
    expect(body).toContain("CREATE TABLE t");
  });

  it("leaves NO temp file behind on success", async () => {
    const info = await run();
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect(entries).toContain(info.name);
  });

  it("never writes an archive when pg_dump fails — and records the failure", async () => {
    process.env.FAKE_DUMP_MODE = "fail";
    await expect(run()).rejects.toThrow();
    expect(await listArchives(dir)).toEqual([]);
    expect((await readdir(dir)).filter((e) => e.endsWith(".tmp"))).toEqual([]);
    const status = await readStatus(dir);
    expect(status?.ok).toBe(false);
    expect(status?.source).toBe("manual");
    expect(status?.error).toBeTruthy();
  });

  it("never writes an EMPTY archive even when pg_dump exits zero (the Phase 1 lesson)", async () => {
    process.env.FAKE_DUMP_MODE = "empty";
    await expect(run()).rejects.toThrow(/empty/i);
    expect(await listArchives(dir)).toEqual([]);
    expect((await readStatus(dir))?.ok).toBe(false);
  });

  it("records a clean status file on success", async () => {
    await run();
    const status = await readStatus(dir);
    expect(status).toMatchObject({ ok: true, source: "manual", error: null });
    expect(Date.parse(status!.lastRunAt)).not.toBeNaN();
    // Written atomically — no partial file, and no temp left over.
    expect((await readdir(dir))).toContain(BACKUP_STATUS_FILENAME);
  });

  it("audits who dumped production, naming the archive", async () => {
    const info = await run();
    const rows = await prisma.auditLog.findMany({ where: { entity: "backup" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe(info.name);
    expect(rows[0].action).toBe("create");
  });

  it("audits a FAILED run too — an attempted dump is still an access event", async () => {
    process.env.FAKE_DUMP_MODE = "fail";
    await expect(run()).rejects.toThrow();
    const rows = await prisma.auditLog.findMany({ where: { entity: "backup" } });
    expect(rows).toHaveLength(1);
    expect((rows[0].after as { ok: boolean }).ok).toBe(false);
  });

  it("two concurrent clicks never clobber each other", async () => {
    const [a, b] = await Promise.all([run(), run()]);
    const names = new Set([a.name, b.name]);
    const archives = await listArchives(dir);
    // Single-flight may collapse them to one run; if both ran, both archives are intact and distinct.
    expect(archives.every((x) => x.integrityOk)).toBe(true);
    expect(archives.length).toBe(names.size);
  });

  it("refuses a folder it cannot write to, without leaving debris", async () => {
    const missing = path.join(dir, "does-not-exist");
    await expect(asSystem(() => runBackupNow({ dumpBin: FAKE, dir: missing }))).rejects.toThrow();
  });

  it("does not let the nightly writer's names collide with a manual one", async () => {
    // A nightly archive with the same second-resolution stamp must not be overwritten.
    await writeFile(path.join(dir, "erp_2026-08-16_020000.sql.gz"), Buffer.from([0x1f, 0x8b]));
    const before = (await readdir(dir)).length;
    await run();
    expect((await readdir(dir)).length).toBe(before + 2); // + archive + status file
  });

  // Task 3's reviewer verified these two by hand but left them untested — added here because
  // runBackupNow's own integrity/listing assertions above give them a natural home alongside a
  // real filesystem fixture, rather than adding a second describe block to backup-health.test.ts.
  it("reports a zero-byte file named like an archive as integrityOk:false", async () => {
    await writeFile(path.join(dir, "erp_2026-08-16_020000.sql.gz"), Buffer.alloc(0));
    const list = await listArchives(dir);
    expect(list).toHaveLength(1);
    expect(list[0].integrityOk).toBe(false);
  });

  it("excludes a directory named like an archive from listArchives", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(dir, "erp_2026-08-16_020000.sql.gz"));
    expect(await listArchives(dir)).toEqual([]);
  });
});
