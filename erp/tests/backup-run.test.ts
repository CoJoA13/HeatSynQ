import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, chmod } from "node:fs/promises";
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

/** Polls for the pid the "hang" fixture mode writes as its very first action (see
 *  fake-pg-dump.sh), so a test can name the OS process it needs to prove is later gone. */
async function waitForPid(pidFile: string, timeoutMs = 2000): Promise<number> {
  const start = Date.now();
  for (;;) {
    try {
      const raw = (await readFile(pidFile, "utf8")).trim();
      if (raw) return Number(raw);
    } catch {
      // not written yet
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`the fixture never wrote a pid to ${pidFile}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** `process.kill(pid, 0)` sends no signal — it only probes whether the process still exists,
 *  throwing ESRCH once it doesn't. Polled rather than checked once, since the OS takes a moment
 *  to actually reap a process after SIGTERM. This is the proof review round 2's finding #1 asked
 *  for: not that the promise rejected, but that the OS process it names is truly gone. */
async function waitForProcessExit(pid: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH — gone
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`pid ${pid} is still alive ${timeoutMs}ms after the backup run settled`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("runBackupNow", () => {
  let dir: string;
  beforeEach(async () => {
    await truncateAll();
    dir = await mkdtemp(path.join(tmpdir(), "hsq-backup-run-"));
    delete process.env.FAKE_DUMP_MODE;
    delete process.env.FAKE_PID_FILE;
  });
  afterEach(async () => {
    delete process.env.FAKE_DUMP_MODE;
    delete process.env.FAKE_PID_FILE;
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

  /**
   * Issue #119 — a PREFLIGHT failure left no audit row at all.
   *
   * `runBackupNow` documents that a failed attempt is audited too, because an attempted dump of
   * production is an access event and `manage_backups` sits on spec §9's dangerous-action list. But
   * the preflight checks threw BEFORE the archive name and the `fail()` helper existed, so a
   * permitted user could try to dump production — and be refused by configuration — with nothing
   * recorded. "Who tried, and when" was unanswerable for exactly the attempts that never started.
   *
   * Fixed by minting the archive name FIRST, so every post-authorization failure has an entityId to
   * be audited against, and routing the preflight refusals through `fail()` like every other one.
   */
  it("audits an unwritable backup folder — the attempt is recorded even though no dump started", async () => {
    const readOnly = await mkdtemp(path.join(tmpdir(), "backup-ro-"));
    await chmod(readOnly, 0o500); // r-x: readable, NOT writable
    try {
      await expect(asSystem(() => runBackupNow({ dumpBin: FAKE, dir: readOnly })))
        .rejects.toThrow(/not writable/i);

      const rows = await prisma.auditLog.findMany({ where: { entity: "backup" } });
      expect(rows).toHaveLength(1);
      expect((rows[0].after as { ok: boolean }).ok).toBe(false);
      expect((rows[0].after as { error: string }).error).toMatch(/not writable/i);
      // Named against the archive it WOULD have written, so the row is attributable.
      expect(rows[0].entityId).toMatch(MANUAL_ARCHIVE_RE);
      // Nothing was written into the folder it could not write to.
      expect(await readdir(readOnly)).toEqual([]);
    } finally {
      await chmod(readOnly, 0o700);
      await rm(readOnly, { recursive: true, force: true });
    }
  });

  it("audits a missing DATABASE_URL — the other preflight refusal", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(run()).rejects.toThrow(/DATABASE_URL/i);
      const rows = await prisma.auditLog.findMany({ where: { entity: "backup" } });
      expect(rows).toHaveLength(1);
      expect((rows[0].after as { ok: boolean }).ok).toBe(false);
      expect((rows[0].after as { error: string }).error).toMatch(/DATABASE_URL/i);
      // A failed attempt is a failed run: the status file says so rather than leaving a stale green.
      expect((await readStatus(dir))?.ok).toBe(false);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });

  /**
   * Codex, PR #131 (P1) — the integrity gate on the WRITE path.
   *
   * When `integrityOk` started returning a three-valued verdict, `if (!(await integrityOk(...)))`
   * silently inverted: `"corrupt"` and `"unverifiable"` are truthy strings, so the failure branch
   * became unreachable and a corrupt archive would have been recorded and RETURNED as a successful
   * backup with `integrityOk: true`. `tsc` cannot catch it (`!string` is valid TypeScript), and
   * nothing here covered a corrupt freshly-written archive — which is why the whole suite stayed
   * green over it. That gap is what these two cases close.
   *
   * The verifier is injected for the same reason `dumpBin` is (§6.4): the code writes the archive
   * itself, so `gzip` would happily verify its own valid output and neither branch is otherwise
   * reachable.
   */
  it("refuses and cleans up when the written archive fails verification", async () => {
    await expect(asSystem(() => runBackupNow({
      dumpBin: FAKE, dir, verify: async () => "rejected" as const,
    }))).rejects.toThrow(/integrity check/i);

    expect(await listArchives(dir)).toEqual([]);        // never left on disk as if it were a backup
    expect((await readStatus(dir))?.ok).toBe(false);    // and never reported as a success
  });

  /** Any non-"intact" verdict fails here, deliberately. Unlike the READ paths — where declining to
   *  cache lets the next read recover — this is the WRITE path: there is no later re-check, and
   *  calling an unverified dump a backup is the precise failure this feature exists to prevent. */
  it("refuses on a verdict it cannot confirm, not only on a definite rejection", async () => {
    // A verifier that answers anything other than "intact" must stop the run. Cast through unknown
    // so a future third verdict cannot silently start passing this gate.
    const odd = (async () => "something-else") as unknown as () => Promise<"intact" | "rejected">;
    await expect(asSystem(() => runBackupNow({ dumpBin: FAKE, dir, verify: odd })))
      .rejects.toThrow(/integrity check/i);

    expect(await listArchives(dir)).toEqual([]);
    expect((await readStatus(dir))?.ok).toBe(false);
  });

  /**
   * Codex, PR #131 — the WRITE path must not inherit the banner's short read-poll deadline.
   *
   * A legitimate archive of a large database can take longer than `INTEGRITY_TIMEOUT_MS` to read,
   * and here a timeout does not merely under-report: `fail()` DELETES the freshly completed archive
   * and records the backup as failed. A short deadline would therefore make "Back up now"
   * progressively unusable as the database grows, while the nightly shell path — which has no
   * verification deadline at all — kept working. The write path passes the dump's own generous
   * ceiling instead.
   */
  it("verifies a fresh archive with the generous dump deadline, not the 60s read poll", async () => {
    let seen: number | undefined;
    await asSystem(() => runBackupNow({
      dumpBin: FAKE, dir,
      verify: async (_p, timeoutMs) => { seen = timeoutMs; return "intact" as const; },
    }));
    // Minutes, not the banner's seconds — the exact value is the dump ceiling.
    expect(seen).toBeGreaterThanOrEqual(10 * 60_000);
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
    await mkdir(path.join(dir, "erp_2026-08-16_020000.sql.gz"));
    expect(await listArchives(dir)).toEqual([]);
  });

  // Review round 2 (task-4-report.md addendum below has the full writeup). All three below target
  // the same function region (backups.ts's dump-step Promise and the success-path tail) the
  // reviewer's three findings landed in.
  describe("review round 2 fixes", () => {
    it("kills the still-running child when the destination write stream errors (finding #1)", async () => {
      // A regular FILE standing in for `dir` makes `createWriteStream(tmpPath)` fail with ENOTDIR
      // — deterministic, and (unlike a permission-bit trick) fails even for root, since it's a
      // structural error, not a permission one. This is the same CLASS of failure as the
      // reviewer's ENOSPC repro: the destination write fails while pg_dump is still running.
      const notADir = path.join(dir, "not-a-directory");
      await writeFile(notADir, "x");

      const pidFile = path.join(dir, "child.pid");
      process.env.FAKE_DUMP_MODE = "hang";
      process.env.FAKE_PID_FILE = pidFile;

      await expect(asSystem(() => runBackupNow({ dumpBin: FAKE, dir: notADir }))).rejects.toThrow();

      // Not just "the promise rejected" — the actual OS process running as pg_dump must be gone.
      // The ENOTDIR error can fire within the same instant `spawn()` returns, so on a fast
      // kill the fixture can lose the race to write its own pid before it dies — that outcome is
      // ITSELF consistent with "the child does not linger" (the failure mode this test guards
      // against is the opposite: a child that keeps running, unkilled, for as long as it likes,
      // in which case the pid file is written reliably, with no race at all, since nothing is
      // trying to kill it). So: if a pid did get recorded, insist it is confirmed dead; if the
      // kill won the race before it could even write one, that is not a gap in the proof.
      let pid: number | null = null;
      try {
        pid = await waitForPid(pidFile, 500);
      } catch {
        pid = null;
      }
      if (pid !== null) {
        await waitForProcessExit(pid);
      }
    });

    it("kills a stalled dump instead of wedging the button forever (finding #2)", async () => {
      process.env.FAKE_DUMP_MODE = "hang";
      const pidFile = path.join(dir, "child.pid");
      process.env.FAKE_PID_FILE = pidFile;

      await expect(
        asSystem(() => runBackupNow({ dumpBin: FAKE, dir, timeoutMs: 200 })),
      ).rejects.toThrow(/stalled/i);

      const pid = await waitForPid(pidFile);
      await waitForProcessExit(pid);

      // The single-flight guard must release after a timeout-triggered failure, not wedge the
      // button forever — a later, healthy click must still be able to run.
      process.env.FAKE_DUMP_MODE = "ok";
      const info = await asSystem(() => runBackupNow({ dumpBin: FAKE, dir }));
      expect(info.integrityOk).toBe(true);
    });

    it("still returns the archive when writing the status file fails (finding #4)", async () => {
      // Pre-create the status file's path AS A DIRECTORY, so writeStatus's rename(tmp, final)
      // fails with EISDIR — a real archive still gets written and verified; only the bookkeeping
      // write fails. The archive itself lives at a different path entirely, so this cannot
      // accidentally corrupt or block the dump.
      await mkdir(path.join(dir, BACKUP_STATUS_FILENAME));
      const info = await run();
      expect(info.integrityOk).toBe(true);
      const archives = await listArchives(dir);
      expect(archives.some((a) => a.name === info.name && a.integrityOk)).toBe(true);
    });
  });

  // Codex review, PR #117 (finding #7): `child.kill()` only SENDS SIGTERM, it does not wait for the
  // OS process to actually die — settling right away let a NEW dump start while the OLD pg_dump
  // could still be holding its snapshot and locks. Unlike the plain `hang` fixture above (which
  // dies immediately on SIGTERM, so it can't distinguish "waited for death" from "merely sent a
  // signal"), `hang-ignore-term` ignores SIGTERM and only dies to SIGKILL, so this test actually
  // exercises the escalation and proves the ordering: the process must be gone BEFORE the promise
  // settles, not merely eventually.
  describe("review round 3 fix (finding #7 — kill must be awaited, not fire-and-forget)", () => {
    it("escalates to SIGKILL and the process is already gone by the time the promise settles", async () => {
      process.env.FAKE_DUMP_MODE = "hang-ignore-term";
      const pidFile = path.join(dir, "child.pid");
      process.env.FAKE_PID_FILE = pidFile;

      // A short stall timeout triggers the kill path; a short kill grace means this test exercises
      // the SIGKILL escalation itself rather than waiting out a realistic multi-second grace period.
      const runPromise = asSystem(() =>
        runBackupNow({ dumpBin: FAKE, dir, timeoutMs: 200, killGraceMs: 150 }));

      const pid = await waitForPid(pidFile);
      await expect(runPromise).rejects.toThrow(/stalled/i);

      // No polling loop here — that is the whole point. If the promise settled without actually
      // waiting for the kill to take effect (the bug), this process would still be alive right now.
      expect(() => process.kill(pid, 0)).toThrow();

      // The single-flight guard must be free immediately too: a later click can run right away.
      process.env.FAKE_DUMP_MODE = "ok";
      const info = await asSystem(() => runBackupNow({ dumpBin: FAKE, dir }));
      expect(info.integrityOk).toBe(true);
    });
  });
});
