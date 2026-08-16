import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { evaluateHealth, listArchives, backupHealth } from "@/server/backups";
import { BACKUP_STATUS_FILENAME } from "@/lib/backup-constants";
import { truncateAll } from "./helpers/db";

// `NOW` is a FIXED instant for the pure evaluateHealth cases. The filesystem describes below use
// hoursAgo() only to stamp mtimes, and judge against the real clock — so keep NOW recent enough
// that a stamped file is not accidentally outside the 36h window.
const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

const base = { newestSuccessAt: hoursAgo(4), status: { lastRunAt: hoursAgo(4).toISOString(), ok: true, source: "nightly" as const, error: null }, staleHours: 36, now: NOW, folderError: null };

describe("evaluateHealth — the owner's green rule (§6.4)", () => {
  it("is GREEN only when a recent success AND a clean last run AND a readable status coincide", () => {
    expect(evaluateHealth(base).state).toBe("ok");
  });

  it("is RED the moment the last run failed, even with a success still inside the window", () => {
    const h = evaluateHealth({
      ...base,
      newestSuccessAt: hoursAgo(25),                                     // still inside 36h
      status: { lastRunAt: hoursAgo(1).toISOString(), ok: false, source: "nightly", error: "pg_dump error" },
    });
    expect(h.state).toBe("failed");
    expect(h.reason).toMatch(/failed/i);
  });

  it("is RED when the newest success has aged past the threshold", () => {
    expect(evaluateHealth({ ...base, newestSuccessAt: hoursAgo(40) }).state).toBe("stale");
  });

  it("is RED when no archive has ever been written", () => {
    const h = evaluateHealth({ ...base, newestSuccessAt: null });
    expect(h.state).toBe("stale");
    expect(h.reason).toMatch(/no backup archive/i);
  });

  it("is RED when the status file is missing — absence is failure, never green (§6.2)", () => {
    const h = evaluateHealth({ ...base, status: null });
    expect(h.state).toBe("unknown");
    expect(h.reason).toMatch(/status file/i);
  });

  it("is RED when the folder itself could not be read", () => {
    const h = evaluateHealth({ ...base, folderError: "ENOENT" });
    expect(h.state).toBe("unknown");
    expect(h.reason).toMatch(/folder/i);
  });

  it("counts a MANUAL success — a backup that exists, exists (§6.4)", () => {
    const h = evaluateHealth({
      ...base,
      newestSuccessAt: hoursAgo(2),
      status: { lastRunAt: hoursAgo(2).toISOString(), ok: true, source: "manual", error: null },
    });
    expect(h.state).toBe("ok");
  });

  it("treats the boundary as inclusive-fresh: exactly staleHours old is still ok", () => {
    expect(evaluateHealth({ ...base, newestSuccessAt: hoursAgo(36) }).state).toBe("ok");
    expect(evaluateHealth({ ...base, newestSuccessAt: hoursAgo(36.01) }).state).toBe("stale");
  });

  it("always reports the derived lastSuccessAt and the threshold it judged against", () => {
    const h = evaluateHealth(base);
    expect(h.lastSuccessAt).toBe(hoursAgo(4).toISOString());
    expect(h.staleHours).toBe(36);
    expect(h.lastRunOk).toBe(true);
  });
});

describe("listArchives", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "hsq-backups-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const writeArchive = async (name: string, body = "-- dump\n", when?: Date) => {
    await writeFile(path.join(dir, name), gzipSync(Buffer.from(body)));
    if (when) await utimes(path.join(dir, name), when, when);
  };

  it("lists both writers' archives, newest first, with size and integrity", async () => {
    await writeArchive("erp_2026-08-15_020000.sql.gz", "-- older\n", hoursAgo(30));
    await writeArchive("erp_manual_2026-08-16_143012_a7f3b1c9.sql.gz", "-- newer\n", hoursAgo(2));
    const list = await listArchives(dir);
    expect(list.map((a) => a.name)).toEqual([
      "erp_manual_2026-08-16_143012_a7f3b1c9.sql.gz",
      "erp_2026-08-15_020000.sql.gz",
    ]);
    expect(list[0].source).toBe("manual");
    expect(list[1].source).toBe("nightly");
    expect(list.every((a) => a.integrityOk)).toBe(true);
    expect(list.every((a) => a.sizeBytes > 0)).toBe(true);
  });

  it("ignores the status file, temp dotfiles, and anything that is not an archive", async () => {
    await writeArchive("erp_2026-08-16_020000.sql.gz");
    await writeFile(path.join(dir, BACKUP_STATUS_FILENAME), "{}");
    await writeFile(path.join(dir, ".erp_2026-08-16_030000.sql.tmp"), "half a dump");
    await writeFile(path.join(dir, "notes.txt"), "hello");
    await mkdir(path.join(dir, "subdir"));
    const list = await listArchives(dir);
    expect(list.map((a) => a.name)).toEqual(["erp_2026-08-16_020000.sql.gz"]);
  });

  it("marks a corrupt archive integrityOk:false rather than throwing", async () => {
    await writeFile(path.join(dir, "erp_2026-08-16_020000.sql.gz"), Buffer.from("not gzip at all"));
    const list = await listArchives(dir);
    expect(list).toHaveLength(1);
    expect(list[0].integrityOk).toBe(false);
  });

  it("returns an empty list for an empty folder", async () => {
    expect(await listArchives(dir)).toEqual([]);
  });
});

describe("backupHealth against a real folder", () => {
  let dir: string;
  // backupHealth reads `backup_stale_hours` from the DATABASE. The suite shares one database with
  // fileParallelism:false, so without this truncate a value left behind by an earlier test FILE
  // would silently change the threshold this file judges against.
  beforeEach(async () => {
    await truncateAll();
    dir = await mkdtemp(path.join(tmpdir(), "hsq-backups-"));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("reads RED for a folder that does not exist", async () => {
    const h = await backupHealth(path.join(dir, "missing"));
    expect(h.state).toBe("unknown");
  });

  it("ignores a CORRUPT newest archive and derives success from the newest INTACT one", async () => {
    // The corrupt file is NEWER; a naive "newest mtime" would call this fresh. Integrity decides.
    const good = path.join(dir, "erp_2026-08-14_020000.sql.gz");
    const corrupt = path.join(dir, "erp_2026-08-16_020000.sql.gz");
    await writeFile(good, gzipSync(Buffer.from("-- good\n")));
    await writeFile(corrupt, Buffer.from("corrupt"));
    // Pin the mtimes so "newer" is a fact of the test, not of write order.
    await utimes(good, hoursAgo(10), hoursAgo(10));
    await utimes(corrupt, hoursAgo(1), hoursAgo(1));
    await writeFile(path.join(dir, BACKUP_STATUS_FILENAME), JSON.stringify(
      { lastRunAt: new Date().toISOString(), ok: true, source: "nightly", error: null }));

    const h = await backupHealth(dir);
    // EXACTLY the good archive's mtime — not merely "some time in the past".
    expect(h.lastSuccessAt).toBe(hoursAgo(10).toISOString());
    expect(h.state).toBe("ok"); // 10h < the 36h default
  });

  it("reads RED when the status file is unparseable JSON", async () => {
    await writeFile(path.join(dir, "erp_2026-08-16_020000.sql.gz"), gzipSync(Buffer.from("-- ok\n")));
    await writeFile(path.join(dir, BACKUP_STATUS_FILENAME), "{ not json");
    expect((await backupHealth(dir)).state).toBe("unknown");
  });

  it("reads RED when the status file parses but has the wrong shape", async () => {
    await writeFile(path.join(dir, "erp_2026-08-16_020000.sql.gz"), gzipSync(Buffer.from("-- ok\n")));
    await writeFile(path.join(dir, BACKUP_STATUS_FILENAME), JSON.stringify({ hello: "world" }));
    expect((await backupHealth(dir)).state).toBe("unknown");
  });
});
