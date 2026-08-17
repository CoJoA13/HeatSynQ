import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, utimes, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  evaluateHealth, listArchives, backupHealth,
  mapLimited, verifyArchive, clearIntegrityCache,
  INTEGRITY_CONCURRENCY, INTEGRITY_CACHE_TTL_MS, INTEGRITY_TIMEOUT_MS, integrityOk,
} from "@/server/backups";
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

  // Codex review, PR #117 (finding #6): a number/object/array/boolean `error` was silently coerced
  // to null rather than rejected, so a status file with a malformed `error` but valid `ok:true` and
  // a recent archive read GREEN — reporting health over a corrupt status document, the opposite of
  // every other malformed field's strict red treatment.
  it("reads RED when the status file's error field is present but not a string or null", async () => {
    await writeFile(path.join(dir, "erp_2026-08-16_020000.sql.gz"), gzipSync(Buffer.from("-- ok\n")));
    await writeFile(path.join(dir, BACKUP_STATUS_FILENAME), JSON.stringify({
      lastRunAt: new Date().toISOString(), ok: true, source: "nightly", error: 42,
    }));
    expect((await backupHealth(dir)).state).toBe("unknown");
  });
});

/**
 * Issue #118 — the integrity checks were unbounded and uncached.
 *
 * `listArchives` ran `gzip -t` over EVERY archive in one `Promise.all`, so opening the Backups page
 * with a month of nightlies launched dozens of full decompressions at once on the production host.
 * Separately `backupHealth` re-decompressed the newest archive on every `/health` poll — and the
 * shell banner polls that from every page.
 *
 * Both halves are fixed with seams that can be driven directly, rather than trying to observe
 * `gzip` concurrency through the filesystem: `mapLimited` takes a counter, `verifyArchive` takes its
 * verifier and its clock as parameters (the `runBackupNow({ dumpBin })` precedent, §6.4).
 */
describe("mapLimited — the concurrency ceiling (#118)", () => {
  it("never exceeds the limit, and still returns results in INPUT order", async () => {
    let live = 0;
    let peak = 0;
    const items = Array.from({ length: 25 }, (_, i) => i);

    const out = await mapLimited(items, 4, async (n) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return n * 2;
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);              // it really did run them concurrently
    expect(out).toEqual(items.map((n) => n * 2)); // input order, not completion order
  });

  it("handles an empty list and a limit larger than the work", async () => {
    expect(await mapLimited([], 4, async () => 1)).toEqual([]);
    expect(await mapLimited([1, 2], 99, async (n) => n + 1)).toEqual([2, 3]);
  });

  // Bite-proof: an UNBOUNDED map over the same work would peak at the item count, so the assertion
  // above is measuring the ceiling rather than an artifact of the timing.
  it("an unbounded Promise.all over the same work peaks at every item — what this replaces", async () => {
    let live = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 25 }, async () => {
      live += 1; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
    }));
    expect(peak).toBe(25);
  });
});

describe("verifyArchive — the metadata + TTL cache (#118)", () => {
  beforeEach(() => clearIntegrityCache());

  it("verifies once, then serves the cached verdict for an unchanged file", async () => {
    let calls = 0;
    const verify = async () => { calls += 1; return "intact" as const; };

    expect(await verifyArchive("/a.gz", 100, 1000, verify, 0)).toBe(true);
    expect(await verifyArchive("/a.gz", 100, 1000, verify, 1000)).toBe(true);
    expect(calls).toBe(1);
  });

  it("re-verifies when the file CHANGED — size or mtime moves the key", async () => {
    let calls = 0;
    const verify = async () => { calls += 1; return "intact" as const; };

    await verifyArchive("/a.gz", 100, 1000, verify, 0);
    await verifyArchive("/a.gz", 101, 1000, verify, 0); // grew
    await verifyArchive("/a.gz", 100, 2000, verify, 0); // rewritten
    expect(calls).toBe(3);
  });

  /** The reason the TTL exists at all: a cache keyed on metadata ALONE would answer "intact"
   *  forever for a file rotting quietly underneath it, defeating the one thing `gzip -t` is for. */
  it("re-verifies an unchanged file once the TTL lapses, so bit rot is still caught", async () => {
    let ok = true;
    let calls = 0;
    const verify = async () => { calls += 1; return ok ? ("intact" as const) : ("rejected" as const); };

    expect(await verifyArchive("/a.gz", 100, 1000, verify, 0)).toBe(true);
    ok = false; // the file rots on disk without its size or mtime changing
    expect(await verifyArchive("/a.gz", 100, 1000, verify, INTEGRITY_CACHE_TTL_MS - 1)).toBe(true);
    expect(calls).toBe(1);
    expect(await verifyArchive("/a.gz", 100, 1000, verify, INTEGRITY_CACHE_TTL_MS + 1)).toBe(false);
    expect(calls).toBe(2);
  });

  /**
   * REVERSED DELIBERATELY (Codex, PR #131, third pass). This used to assert that a failed verdict
   * was cached like any other. It is not, and cannot be: a non-zero `gzip` exit cannot be shown to
   * mean corruption rather than a transient I/O or access failure — the exit code cannot separate
   * them, an `access(R_OK)` probe afterwards cannot either (the transient may clear first, and the
   * probe never proves gzip read the whole file), and stderr wording is not stable across builds or
   * locales. Caching it would pin a possibly-healthy archive as CORRUPT for the full TTL, in the one
   * system whose job is telling the shop whether its backups are good.
   *
   * The cost accepted in exchange: a genuinely bad archive is re-verified on each read, bounded by
   * the shared ceiling and the per-child timeout.
   */
  it("never caches a REJECTED verdict — it cannot be shown to mean corruption", async () => {
    let calls = 0;
    const verify = async () => { calls += 1; return "rejected" as const; };
    expect(await verifyArchive("/bad.gz", 1, 1, verify, 0)).toBe(false);
    expect(await verifyArchive("/bad.gz", 1, 1, verify, 10)).toBe(false);
    expect(calls).toBe(2);   // re-checked, not inherited
  });

  /**
   * Codex, PR #131 — the ceiling has to be MODULE-LEVEL, not per traversal.
   *
   * `mapLimited` bounds one array walk, which is not the same thing: `backupsView` runs
   * `backupHealth` and `listArchives` concurrently so each got its own budget, and every extra page
   * load or banner poll multiplied it again. The production-wide spike this exists to prevent needs
   * a bound shared across ALL callers.
   */
  it("never exceeds the ceiling across INDEPENDENT concurrent callers", async () => {
    let live = 0;
    let peak = 0;
    const verify = async () => {
      live += 1; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 10));
      live -= 1;
      return "intact" as const;
    };

    // Three separate "requests", each verifying its own distinct files — the shape a page load
    // plus two banner polls produces. Per-traversal limiting would let this reach 3x the ceiling.
    await Promise.all([0, 1, 2].map((caller) =>
      mapLimited(Array.from({ length: 8 }, (_, i) => `/c${caller}-${i}.gz`), 4,
        (p) => verifyArchive(p, 1, 1, verify, 0))));

    expect(peak).toBeLessThanOrEqual(INTEGRITY_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  /**
   * Codex, PR #131 — the cache only coalesces work that has already FINISHED.
   *
   * N overlapping checks of the SAME archive each started their own `gzip -t`, and the newest
   * archive is exactly what every `/health` poll looks at — the most repeated cost in the app.
   */
  it("coalesces concurrent checks of the SAME archive into one verification", async () => {
    let calls = 0;
    const verify = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return "intact" as const;
    };

    const results = await Promise.all(
      Array.from({ length: 6 }, () => verifyArchive("/same.gz", 10, 10, verify, 0)));

    expect(results).toEqual([true, true, true, true, true, true]);
    expect(calls).toBe(1);
  });

  it("a failed in-flight verification is not left cached as pending", async () => {
    // The in-flight entry must clear on rejection too, or one transient failure would wedge that
    // archive's verdict for the life of the process.
    const boom = async () => { throw new Error("gzip exploded"); };
    await expect(verifyArchive("/boom.gz", 1, 1, boom, 0)).rejects.toThrow(/exploded/);

    let calls = 0;
    const ok = async () => { calls += 1; return "intact" as const; };
    expect(await verifyArchive("/boom.gz", 1, 1, ok, 0)).toBe(true);
    expect(calls).toBe(1); // re-attempted, not stuck on the dead promise
  });

  /**
   * Codex, PR #131 — an UNVERIFIABLE result must not be cached as corruption.
   *
   * `integrityOk` catches everything `gzip` can fail with, and a spawn/OS failure (EMFILE under
   * load, a transient storage error, a momentary permission problem) says NOTHING about the
   * archive. Caching that as `false` kept the health red and the table labelled CORRUPT for the
   * full TTL after the system had already recovered.
   */
  it("recovers on the very next read once the failure clears", async () => {
    let verdict: "intact" | "rejected" = "rejected";
    let calls = 0;
    const verify = async () => { calls += 1; return verdict; };

    // The attempt itself answers false — nothing may claim intact on evidence we do not have.
    expect(await verifyArchive("/flaky.gz", 5, 5, verify, 0)).toBe(false);
    expect(calls).toBe(1);

    // ...and the very next read re-checks rather than inheriting an unprovable verdict.
    verdict = "intact";
    expect(await verifyArchive("/flaky.gz", 5, 5, verify, 1)).toBe(true);
    expect(calls).toBe(2);
  });

  /**
   * Codex, PR #131 — a gzip that starts but cannot READ the file is not a corrupt archive.
   *
   * A permission or ACL change landing between our `stat` and gzip's `open` makes it exit non-zero
   * with a NUMERIC code, exactly like a format rejection — so the exit code alone cannot separate
   * them, and the first version of this fix (which only excluded spawn failures and signals) cached
   * a healthy file as CORRUPT for the full TTL, surviving the recovery.
   *
   * Driven through the REAL `gzip` against a real unreadable file, not a stubbed verifier: the
   * point is which branch the actual child process lands in.
   */
  it("reports an unreadable archive as unverifiable, not corrupt — and does not cache it", async () => {
    const own = await mkdtemp(path.join(tmpdir(), "backup-access-"));
    const good = path.join(own, "erp_2026-08-16_010101.sql.gz");
    await writeFile(good, gzipSync(Buffer.from("SELECT 1;")));
    await chmod(good, 0o000);                       // readable to nobody (root would bypass; see below)
    const stats = await stat(good);

    const first = await verifyArchive(good, stats.size, stats.mtimeMs, undefined, 0);
    await chmod(good, 0o600);                       // access recovers

    if (first === false) {
      // The expected path: unreadable ⇒ unverifiable ⇒ NOT cached, so recovery is immediate.
      expect(await verifyArchive(good, stats.size, stats.mtimeMs, undefined, 1)).toBe(true);
    } else {
      // Running as root (CI containers often do), chmod 000 does not actually deny reads, so gzip
      // succeeds and there is nothing to distinguish. Assert the honest thing rather than skipping.
      expect(first).toBe(true);
    }
    await rm(own, { recursive: true, force: true });
  });

  it("bounds each verifier so a wedged one cannot hold a shared slot forever", () => {
    // The ceiling made a hang process-wide rather than request-local, so the child must be bounded.
    // A timed-out child is killed and reported with a `signal`, which is classified unverifiable and
    // therefore never cached — the next read retries once the volume recovers.
    expect(INTEGRITY_TIMEOUT_MS).toBeGreaterThan(1_000);
    expect(INTEGRITY_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });

  /**
   * Codex, PR #131 — the timeout must SETTLE, not merely signal.
   *
   * `execFile`'s own `timeout` option only sends a signal; the promise stays pending until the
   * child actually exits. A `gzip` that ignores SIGTERM — or is stuck in an uninterruptible read on
   * a wedged mount, where even SIGKILL cannot move it — therefore held its shared slot forever, and
   * the module-wide ceiling turned that into a process-wide stall.
   *
   * Driven against a REAL child that traps SIGTERM and sleeps, because the whole claim is about
   * process behaviour: a stub resolving late would prove nothing. Short timeout so the test is fast.
   */
  it("settles a verifier that ignores SIGTERM, instead of waiting for it to exit", async () => {
    const bin = await mkdtemp(path.join(tmpdir(), "backup-stubborn-"));
    // Traps SIGTERM and keeps running — the shape the old `timeout` option could not bound.
    await writeFile(path.join(bin, "gzip"), "#!/bin/sh\ntrap '' TERM\nsleep 30\n");
    await chmod(path.join(bin, "gzip"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      const started = Date.now();
      const verdict = await integrityOk("/irrelevant.gz", 200);
      const elapsed = Date.now() - started;

      expect(verdict).toBe("rejected");     // never "intact" on evidence we do not have
      expect(elapsed).toBeLessThan(5_000);  // settled on the deadline, not on the child's 30s sleep
    } finally {
      process.env.PATH = savedPath;
      await rm(bin, { recursive: true, force: true });
    }
  }, 20_000);

  it("the shipped ceiling is a real bound", () => {
    expect(INTEGRITY_CONCURRENCY).toBeGreaterThan(0);
    expect(INTEGRITY_CONCURRENCY).toBeLessThan(16);
  });
});
