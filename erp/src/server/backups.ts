// The Backups service (Phase 8C §6). Owns every filesystem and child-process interaction; the
// path/name rules live in the pure backup-paths.ts leaf, and the types in the client-safe
// lib/backup-constants.ts.
//
// THE LOAD-BEARING IDEA (§6.4): `lastSuccessAt` is DERIVED from the newest integrity-passing
// archive, not stored. The archive IS the evidence of success. That is what lets the status file
// be a single un-merged overwrite — a shell script cannot reasonably read-merge JSON to preserve a
// previous success across a failed run, and any scheme that needed it would be fragile in exactly
// the failure case it exists to report.
import { readdir, stat, readFile, rename, unlink, writeFile, access } from "node:fs/promises";
import { constants as FS, createReadStream, createWriteStream } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  type ArchiveInfo, type BackupHealth, type BackupStatusFile, type BackupsView,
  archiveSourceOf, isArchiveName,
} from "@/lib/backup-constants";
import { archivePath, resolveBackupDir, statusPath, manualArchiveName, tempNameFor } from "./backup-paths";
import { getSetting } from "./settings";
import { HttpError } from "./errors";
import { auditBackupRun } from "./audit";
import { assertNotPracticeDatabase } from "./practice-mode";

const execFileAsync = promisify(execFile);

export type HealthInputs = {
  /** Newest INTEGRITY-PASSING archive's mtime, or null if there is none. */
  newestSuccessAt: Date | null;
  /** null means missing OR unparseable OR wrong-shaped — all three read red (§6.2). */
  status: BackupStatusFile | null;
  staleHours: number;
  now: Date;
  /** Non-null when the folder could not even be read. */
  folderError: string | null;
};

/** PURE — the whole green rule in one table-testable function. Exported for the tests, which drive
 *  it directly rather than through the filesystem. */
export function evaluateHealth(i: HealthInputs): BackupHealth {
  const common = {
    lastSuccessAt: i.newestSuccessAt?.toISOString() ?? null,
    lastRunAt: i.status?.lastRunAt ?? null,
    lastRunOk: i.status ? i.status.ok : null,
    staleHours: i.staleHours,
  };

  // Order matters only for which message the operator sees — every branch below is RED.
  if (i.folderError) {
    return { ...common, state: "unknown", reason: `The backup folder could not be read: ${i.folderError}` };
  }
  if (!i.status) {
    return {
      ...common, state: "unknown",
      reason: "No readable backup status file was found in the backup folder. A missing status " +
              "reads as overdue — the nightly backup container may never have started.",
    };
  }
  if (!i.status.ok) {
    return {
      ...common, state: "failed",
      reason: `The last backup run failed${i.status.error ? `: ${i.status.error}` : "."}`,
    };
  }
  if (!i.newestSuccessAt) {
    return { ...common, state: "stale", reason: "No backup archive has been written yet." };
  }
  const ageHours = (i.now.getTime() - i.newestSuccessAt.getTime()) / 3600_000;
  if (ageHours > i.staleHours) {
    return {
      ...common, state: "stale",
      reason: `The newest backup is ${Math.floor(ageHours)} hours old, past the ${i.staleHours}-hour threshold.`,
    };
  }
  return { ...common, state: "ok", reason: `Last successful backup ${Math.floor(ageHours)} hours ago.` };
}

/** `gzip -t`, spawned via argv. Returns false rather than throwing — a corrupt archive is a
 *  reportable fact about that file, not a failure of the listing. */
async function integrityOk(fullPath: string): Promise<boolean> {
  try {
    await execFileAsync("gzip", ["-t", fullPath]);
    return true;
  } catch {
    return false;
  }
}

/**
 * How many `gzip -t` decompressions may run at once (#118). `listArchives` used one unbounded
 * `Promise.all`, so opening the Backups page with a month of nightlies plus on-demand copies
 * launched dozens of full decompressions simultaneously, contending for disk and CPU on the
 * PRODUCTION host — the one machine that must stay responsive. Four keeps the page quick on a
 * spinning disk without ever becoming the reason an order save is slow.
 */
export const INTEGRITY_CONCURRENCY = 4;

/**
 * `Promise.all(items.map(fn))` with a ceiling on how many run at once. Results stay in INPUT order,
 * so callers can zip them back against `items` — the whole reason this returns an array rather than
 * streaming. Pure and exported for the tests, which drive it directly with a counter rather than
 * trying to observe `gzip` concurrency through the filesystem.
 */
export async function mapLimited<T, R>(
  items: T[], limit: number, fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * How long a verified result may be reused for an UNCHANGED file (#118). `backupHealth` fully
 * decompressed the newest archive on every `/health` poll — and the shell banner polls that from
 * every page — so the busiest endpoint in the app was also the most expensive.
 *
 * The two bounds do different jobs, and both are needed:
 *   - the KEY carries size and mtime, so a file that CHANGED is never served a stale verdict;
 *   - the TTL bounds how long an unchanged file may go un-reverified, so silent bit rot on failing
 *     storage is still caught. A cache keyed on metadata alone would answer "intact" forever for a
 *     file quietly rotting underneath it — which would defeat the one thing `gzip -t` is here for.
 * Fifteen minutes makes the banner's 5-minute poll free two times in three while still noticing rot
 * within a quarter of an hour, which is ample for a nightly backup monitor.
 */
export const INTEGRITY_CACHE_TTL_MS = 15 * 60_000;

/** Bounded so a long-lived process cannot grow this without limit; archives are pruned at 30 days,
 *  so the live set is tens of entries and this ceiling is never reached in practice. */
const INTEGRITY_CACHE_MAX = 500;

const integrityCache = new Map<string, { ok: boolean; at: number }>();

/** Exported for the tests — the cache is process-global, so a suite that asserts on verification
 *  counts has to be able to start from a known state. */
export function clearIntegrityCache(): void {
  integrityCache.clear();
  integrityInFlight.clear();
}

/**
 * Verifications currently RUNNING, keyed identically to the settled cache (Codex, PR #131).
 *
 * The cache alone only coalesces work that has already FINISHED, so N overlapping checks of the same
 * archive each started their own `gzip -t` — and the newest archive is exactly the file every
 * `/health` poll looks at, so that was the most repeated cost in the app. Sharing the in-flight
 * promise makes concurrent callers wait on ONE decompression instead of starting N.
 */
const integrityInFlight = new Map<string, Promise<boolean>>();

/**
 * A MODULE-LEVEL ceiling on concurrent `gzip -t` processes (Codex, PR #131).
 *
 * `mapLimited` bounds one traversal, which is not the same thing: `backupsView` runs `backupHealth`
 * and `listArchives` concurrently, so each got its own budget — and every additional page load or
 * banner poll multiplied it again. The production-wide spike this exists to prevent needs a bound
 * that is shared across ALL callers, so it lives here rather than in any one array walk.
 */
let integritySlotsFree = INTEGRITY_CONCURRENCY;
const integrityWaiters: (() => void)[] = [];

async function withIntegritySlot<T>(run: () => Promise<T>): Promise<T> {
  if (integritySlotsFree === 0) await new Promise<void>((r) => integrityWaiters.push(r));
  else integritySlotsFree -= 1;
  try {
    return await run();
  } finally {
    // Hand the slot straight to the next waiter rather than returning it to the pool and racing —
    // the count only rises when nobody is queued.
    const next = integrityWaiters.shift();
    if (next) next();
    else integritySlotsFree += 1;
  }
}

/**
 * `integrityOk` memoized on (path, size, mtime) for `INTEGRITY_CACHE_TTL_MS`, coalesced while in
 * flight, and run under the module-level concurrency ceiling. `verify` is a PARAMETER rather than a
 * module lookup for the same reason `runBackupNow` takes `dumpBin` that way (§6.4): it lets a test
 * count real invocations, and observe their concurrency, without stubbing a child process.
 */
export async function verifyArchive(
  fullPath: string, size: number, mtimeMs: number,
  verify: (p: string) => Promise<boolean> = integrityOk,
  now: number = Date.now(),
): Promise<boolean> {
  const key = `${fullPath}|${size}|${mtimeMs}`;
  const hit = integrityCache.get(key);
  if (hit && now - hit.at < INTEGRITY_CACHE_TTL_MS) return hit.ok;
  const running = integrityInFlight.get(key);
  if (running) return running;

  const pending = withIntegritySlot(() => verify(fullPath))
    .then((ok) => {
      if (integrityCache.size >= INTEGRITY_CACHE_MAX) integrityCache.clear();
      integrityCache.set(key, { ok, at: now });
      return ok;
    })
    .finally(() => { integrityInFlight.delete(key); });
  integrityInFlight.set(key, pending);
  return pending;
}

export async function listArchives(dir: string = resolveBackupDir()): Promise<ArchiveInfo[]> {
  const entries = await readdir(dir);
  const names = entries.filter(isArchiveName);
  // Bounded fan-out + the metadata cache (#118): an unbounded `Promise.all` here launched one full
  // decompression per archive at once, on the production host, every time the page was opened.
  const infos = await mapLimited(names, INTEGRITY_CONCURRENCY, async (name) => {
    const full = archivePath(dir, name);
    const s = await stat(full);
    // A directory that happens to be named like an archive is not an archive.
    if (!s.isFile()) return null;
    return {
      name,
      source: archiveSourceOf(name)!,
      sizeBytes: s.size,
      modifiedAt: s.mtime.toISOString(),
      integrityOk: await verifyArchive(full, s.size, s.mtimeMs),
    } satisfies ArchiveInfo;
  });
  return infos
    .filter((a): a is ArchiveInfo => a !== null)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function parseStatus(raw: string): BackupStatusFile | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "object" || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.lastRunAt !== "string" || Number.isNaN(Date.parse(o.lastRunAt))) return null;
    if (typeof o.ok !== "boolean") return null;
    if (o.source !== "nightly" && o.source !== "manual") return null;
    // A number/object/array/boolean `error` is a malformed status document, not a legitimately
    // absent one — reject the whole file rather than silently coercing it to null, which would let
    // `evaluateHealth` report GREEN over a corrupt status document whenever `ok:true` happens to
    // also be set (Codex review, PR #117). Genuinely absent (`undefined`) and explicit `null` are
    // the only ways to say "no error", matching what both writers actually emit.
    if (o.error !== undefined && o.error !== null && typeof o.error !== "string") return null;
    const error = typeof o.error === "string" ? o.error : null;
    return { lastRunAt: o.lastRunAt, ok: o.ok, source: o.source, error };
  } catch {
    return null;   // unparseable reads exactly like missing: red
  }
}

export async function readStatus(dir: string): Promise<BackupStatusFile | null> {
  try {
    return parseStatus(await readFile(statusPath(dir), "utf8"));
  } catch {
    return null;
  }
}

/** The newest archive that actually passes `gzip -t`. Walks newest-first and stops at the first
 *  intact one, so the common case costs a single integrity check — this is what the shell bar's
 *  cheap endpoint calls, rather than verifying the whole folder. */
async function newestIntactAt(dir: string): Promise<Date | null> {
  const entries = (await readdir(dir)).filter(isArchiveName);
  // `stat` only — cheap, and no decompression happens until the sorted walk below.
  const stamped = await mapLimited(entries, INTEGRITY_CONCURRENCY, async (name) => {
    const full = archivePath(dir, name);
    const s = await stat(full);
    return s.isFile() ? { full, size: s.size, mtimeMs: s.mtimeMs, mtime: s.mtime } : null;
  });
  const sorted = stamped
    .filter((e): e is { full: string; size: number; mtimeMs: number; mtime: Date } => e !== null)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  for (const e of sorted) {
    // Cached (#118): the shell banner polls this from every page, and re-decompressing an archive
    // that has not changed since the last poll was the single most repeated cost in the app.
    if (await verifyArchive(e.full, e.size, e.mtimeMs)) return e.mtime;
  }
  return null;
}

export async function backupHealth(dir: string = resolveBackupDir()): Promise<BackupHealth> {
  const staleHours = await getSetting("backup_stale_hours");
  let newestSuccessAt: Date | null = null;
  let status: BackupStatusFile | null = null;
  let folderError: string | null = null;
  try {
    newestSuccessAt = await newestIntactAt(dir);
    status = await readStatus(dir);
  } catch (err) {
    folderError = err instanceof Error ? err.message : String(err);
  }
  return evaluateHealth({ newestSuccessAt, status, staleHours, now: new Date(), folderError });
}

/** The full page payload. Deliberately separate from backupHealth(): the page verifies EVERY
 *  archive (the list shows per-file integrity), the banner verifies at most a few. */
export async function backupsView(): Promise<BackupsView> {
  const dir = resolveBackupDir();
  const [health, archives] = await Promise.all([
    backupHealth(dir),
    listArchives(dir).catch(() => [] as ArchiveInfo[]),
  ]);
  return { folder: dir, health, archives };
}

/** Written by the app; mirrors what scripts/backup.sh writes. Temp-then-rename so a reader can
 *  never observe a half-written file (both writers do this). */
async function writeStatus(dir: string, status: BackupStatusFile): Promise<void> {
  const final = statusPath(dir);
  const tmp = `${final}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  await rename(tmp, final);
}

/** Single-flight: a double-click must not run two dumps. The unique names already make a collision
 *  harmless, so this is about not doubling the load on the database, not about correctness. */
let inFlight: Promise<ArchiveInfo> | null = null;

/** Review round 2, finding #2. A stalled `pg_dump` (a wedged lock, a partition, a full pipe with
 *  nobody reading — see finding #1 below) settles neither the "close" nor the "finish" signal, so
 *  without a ceiling `inFlight` wedges the manual-backup button for the rest of the PROCESS's
 *  life: every later click just awaits the same dead promise forever. 30 minutes is deliberately
 *  generous — this deployment dumps its OWN database (a shop-floor ERP's own working set, not a
 *  data-warehouse workload) over a local/same-host connection, and a `pg_dump` of that finishes in
 *  seconds to low minutes even at a size meaningfully larger than today's actual data. The ceiling
 *  exists to catch a dump that is genuinely stuck, not to bound one that is merely large.
 *  Overridable via `opts.timeoutMs` so tests can exercise the stall path without a real 30-minute
 *  wait. */
const DEFAULT_DUMP_TIMEOUT_MS = 30 * 60_000;

/** Codex review, PR #117 (finding #7). `child.kill()` only SENDS SIGTERM — it does not wait for the
 *  process to actually exit. A process that dies quickly from SIGTERM (the overwhelmingly common
 *  case for `pg_dump`) closes well inside this window; it exists only to bound how long a process
 *  that ignores SIGTERM can hold the promise (and therefore `inFlight`) open before the escalation
 *  to SIGKILL below fires. Overridable via `opts.killGraceMs` for the same reason `timeoutMs` is. */
const DEFAULT_KILL_GRACE_MS = 5_000;

export function runBackupNow(
  opts: { dumpBin?: string; dumpArgs?: string[]; dir?: string; timeoutMs?: number; killGraceMs?: number } = {},
): Promise<ArchiveInfo> {
  if (inFlight) return inFlight;
  inFlight = doBackup(opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function doBackup(
  opts: { dumpBin?: string; dumpArgs?: string[]; dir?: string; timeoutMs?: number; killGraceMs?: number },
): Promise<ArchiveInfo> {
  // Production-only (§6.3). Belt AND braces: compose denies app-practice the mount entirely.
  // Deliberately BEFORE the name is minted and left un-audited: this is a refusal on the practice
  // copy, not an attempt on production, and there is no production backup folder to record it in.
  await assertNotPracticeDatabase();

  // The archive name is minted FIRST, before anything that can fail (#119). Every failure past this
  // point — including the two preflight refusals below, which used to throw before `fail()` even
  // existed — then has an entityId to be audited against. An attempted dump of production is an
  // access event and `manage_backups` is on spec §9's dangerous-action list, so "who tried, and
  // when" has to be answerable even for the attempts that never started. The name is a timestamp
  // plus random bytes with no side effects, so minting one that never gets used costs nothing.
  const name = manualArchiveName(new Date(), randomBytes(4).toString("hex"));

  // `resolveBackupDir()` can itself throw on a malformed deploy value — audited on its own, since
  // without a resolved folder there is nowhere to write a status file.
  let dir: string;
  try {
    dir = opts.dir ?? resolveBackupDir();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await auditBackupRun(name, false, message).catch(() => {});
    throw new HttpError(500, `Backup failed: ${message}`);
  }

  const tmpPath = path.join(dir, tempNameFor(name));
  const finalPath = archivePath(dir, name);

  const fail = async (message: string): Promise<never> => {
    await unlink(tmpPath).catch(() => {});
    await unlink(finalPath).catch(() => {});
    await writeStatus(dir, {
      lastRunAt: new Date().toISOString(), ok: false, source: "manual", error: message,
    }).catch(() => {});
    await auditBackupRun(name, false, message).catch(() => {});
    throw new HttpError(500, `Backup failed: ${message}`);
  };

  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl) await fail("DATABASE_URL is not configured.");

  // `dumpBin` is a plain PARAMETER, not an env var (§6.4): vitest injects a fake so the suite never
  // depends on a host pg_dump, whose major on CI's ubuntu-latest is older than the postgres:18
  // server — and pg_dump hard-refuses a newer server.
  const bin = opts.dumpBin ?? "pg_dump";
  const args = opts.dumpArgs ?? [databaseUrl];

  try {
    await access(dir, FS.W_OK);
  } catch {
    await fail(`The backup folder is not writable: ${dir}`);
  }

  // --- dump to the temp file, via ARGV. No string ever reaches a shell. ---
  let stderr = "";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DUMP_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  try {
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(tmpPath);
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.pipe(out);
      child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });

      // `child.stdout.pipe(out)` ends `out` itself once stdout hits EOF, which can happen before
      // OR after the process's own "close" event — so a "finish" listener registered ONLY inside
      // the "close" handler can be registered after "finish" has already fired, and the promise
      // hangs forever. Track both signals independently and settle once both have arrived,
      // regardless of which order they land in.
      let closeCode: number | null = null;
      let closed = false;
      let finished = false;
      let settled = false;

      // Codex review, PR #117 (finding #7). `child.kill()` alone only SENDS SIGTERM; it does not
      // prove the process is actually gone. Settling (and therefore releasing `inFlight`) the
      // instant SIGTERM is sent let a NEW dump start while the OLD `pg_dump` could still be running,
      // still holding its snapshot and its locks. This waits for the child's own "exit" event — the
      // proof the OS process has actually exited — before resolving, and escalates to SIGKILL after
      // `killGraceMs` so a process that ignores SIGTERM (or is merely slow to die) cannot hold the
      // promise open forever. A child with no pid (never spawned) or already exited resolves
      // immediately — nothing to wait for.
      //
      // Re-review, finding #1: this MUST be "exit", not "close". "close" additionally waits for
      // every stdio stream to close, which never happens if a GRANDCHILD process inherits our
      // child's stdout (e.g. `pg_dump -j` forking workers) — the reviewer measured "exit" firing at
      // 4ms in that shape while "close" never fires at all, wedging `inFlight` permanently with no
      // ceiling, since the escalation timer only SENDS SIGKILL, it does not itself settle anything.
      // "exit" needs only the process itself to have terminated, which is the actual claim this
      // promise makes.
      const killAndWait = (): Promise<void> => new Promise((done) => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
          done();
          return;
        }
        child.kill(); // SIGTERM — the default signal
        const escalateTimer = setTimeout(() => { child.kill("SIGKILL"); }, killGraceMs);
        child.once("exit", () => {
          clearTimeout(escalateTimer);
          done();
        });
      });

      // Review round 2, finding #1 (REQUIRED). On ANY error settle — the destination write
      // erroring (ENOSPC on a full backup folder is THE archetypal case this feature must
      // survive), the source `child.stdout` erroring, the child failing to spawn, or the stall
      // timeout below — the dump must actually be OVER, not merely reported as over.
      // `child.stdout.pipe(out)` only unpipes on a destination error; it never kills the SOURCE,
      // so without an explicit kill() here a write-stream error leaves `pg_dump` running
      // indefinitely, still holding its snapshot and its locks on every table (reviewer repro,
      // 2026-08-16: child still alive 600ms after the promise settled, killed only by hand — and
      // every retry click strands another one). `settled` flips to true BEFORE the async kill-and-
      // wait starts, so the outer "close" listener's `maybeSettle` below (which will ALSO fire once
      // the kill takes effect) is already a no-op by the time it runs — exactly-once settlement is
      // preserved even though this path now settles asynchronously instead of synchronously.
      const settleError = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void killAndWait().finally(() => reject(err));
      };

      // Same finding: `pipe()` attaches no `error` handler to its SOURCE, so an error emitted by
      // `child.stdout` itself (a broken pipe, an invalid fd) had no listener at all and became an
      // uncaught exception rather than a rejected promise.
      child.on("error", settleError);
      child.stdout.on("error", settleError);
      out.on("error", settleError);

      // Review round 2, finding #2. Bounds the whole dump step so a stalled `pg_dump` can't wedge
      // `inFlight` — and therefore the manual-backup button — for the rest of the process's life.
      const timer = setTimeout(() => {
        settleError(new Error(
          `pg_dump did not finish within ${Math.round(timeoutMs / 1000)}s; treating it as stalled`,
        ));
      }, timeoutMs);

      const maybeSettle = () => {
        if (settled || !closed || !finished) return;
        settled = true;
        clearTimeout(timer);
        if (closeCode === 0) resolve();
        else reject(new Error(stderr.trim() || `exit ${closeCode}`));
      };
      child.on("close", (code) => { closeCode = code; closed = true; maybeSettle(); });
      out.on("finish", () => { finished = true; maybeSettle(); });
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  // --- fail loud on an EMPTY dump: pg_dump can exit zero having written nothing, and an empty
  //     archive that looks like a backup is worse than no archive at all (the Phase 1 lesson). ---
  const tmpStat = await stat(tmpPath).catch(() => null);
  if (!tmpStat || tmpStat.size === 0) {
    return fail("pg_dump produced an empty dump; refusing to write an empty archive.");
  }

  // --- gzip into place, then verify the FINAL bytes before declaring success. ---
  try {
    await pipeline(createReadStream(tmpPath), createGzip(), createWriteStream(finalPath));
  } catch (err) {
    return fail(`could not compress the dump: ${err instanceof Error ? err.message : String(err)}`);
  }
  await unlink(tmpPath).catch(() => {});

  if (!(await integrityOk(finalPath))) {
    return fail("the written archive failed its gzip integrity check.");
  }

  const finalStat = await stat(finalPath);

  // Review round 2, finding #4. By this point `finalPath` is a real, complete, integrity-checked
  // archive — the backup already succeeded. Bookkeeping (the status file, the audit row) is
  // evidence ABOUT that success, not a precondition for it, so a failure writing either one must
  // not turn a good archive into a reported failure (contrast `fail()` above, where the write
  // failing IS the story). This mirrors the module's own load-bearing rule that the archive is
  // itself the evidence: `backupHealth`/`newestIntactAt` derive success from the newest
  // integrity-passing file on disk, not from this status write, so a swallowed failure here does
  // not make a bad run look good — the archive was already good. It also cannot make a genuinely
  // bad run look good, because `fail()`'s own status/audit writes are unconditional. The one
  // acknowledged tradeoff: if a STALE "ok: false" from an earlier failed run is still sitting in
  // the status file when THIS write also fails, `evaluateHealth` keeps reporting "failed" even
  // though a fresh good archive now exists — under-reporting health, never over-reporting it,
  // which is the same fail-toward-red bias §6.2 already applies everywhere else in this module.
  // Each write is independently best-effort (matching `fail()`'s own per-step `.catch`s) so one
  // failing doesn't stop the other from being attempted.
  await writeStatus(dir, {
    lastRunAt: new Date().toISOString(), ok: true, source: "manual", error: null,
  }).catch(() => {});
  await auditBackupRun(name, true, null).catch(() => {});

  return {
    name,
    source: "manual",
    sizeBytes: finalStat.size,
    modifiedAt: finalStat.mtime.toISOString(),
    integrityOk: true,
  };
}
