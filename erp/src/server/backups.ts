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

export async function listArchives(dir: string = resolveBackupDir()): Promise<ArchiveInfo[]> {
  const entries = await readdir(dir);
  const names = entries.filter(isArchiveName);
  const infos = await Promise.all(names.map(async (name) => {
    const full = archivePath(dir, name);
    const s = await stat(full);
    // A directory that happens to be named like an archive is not an archive.
    if (!s.isFile()) return null;
    return {
      name,
      source: archiveSourceOf(name)!,
      sizeBytes: s.size,
      modifiedAt: s.mtime.toISOString(),
      integrityOk: await integrityOk(full),
    } satisfies ArchiveInfo;
  }));
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
    const error = o.error === null || typeof o.error === "string" ? o.error : null;
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
  const stamped = await Promise.all(entries.map(async (name) => {
    const full = archivePath(dir, name);
    const s = await stat(full);
    return s.isFile() ? { full, mtime: s.mtime } : null;
  }));
  const sorted = stamped
    .filter((e): e is { full: string; mtime: Date } => e !== null)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  for (const e of sorted) {
    if (await integrityOk(e.full)) return e.mtime;
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

export function runBackupNow(
  opts: { dumpBin?: string; dumpArgs?: string[]; dir?: string } = {},
): Promise<ArchiveInfo> {
  if (inFlight) return inFlight;
  inFlight = doBackup(opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function doBackup(
  opts: { dumpBin?: string; dumpArgs?: string[]; dir?: string },
): Promise<ArchiveInfo> {
  // Production-only (§6.3). Belt AND braces: compose denies app-practice the mount entirely.
  await assertNotPracticeDatabase();

  const dir = opts.dir ?? resolveBackupDir();
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl) throw new HttpError(500, "DATABASE_URL is not configured.");

  // `dumpBin` is a plain PARAMETER, not an env var (§6.4): vitest injects a fake so the suite never
  // depends on a host pg_dump, whose major on CI's ubuntu-latest is older than the postgres:18
  // server — and pg_dump hard-refuses a newer server.
  const bin = opts.dumpBin ?? "pg_dump";
  const args = opts.dumpArgs ?? [databaseUrl];

  try {
    await access(dir, FS.W_OK);
  } catch {
    throw new HttpError(500, `The backup folder is not writable: ${dir}`);
  }

  const name = manualArchiveName(new Date(), randomBytes(4).toString("hex"));
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

  // --- dump to the temp file, via ARGV. No string ever reaches a shell. ---
  let stderr = "";
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
      const maybeSettle = () => {
        if (settled || !closed || !finished) return;
        settled = true;
        if (closeCode === 0) resolve();
        else reject(new Error(stderr.trim() || `exit ${closeCode}`));
      };
      const settleError = (err: Error) => { if (!settled) { settled = true; reject(err); } };

      child.on("error", settleError);
      child.on("close", (code) => { closeCode = code; closed = true; maybeSettle(); });
      out.on("finish", () => { finished = true; maybeSettle(); });
      out.on("error", settleError);
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
  await writeStatus(dir, {
    lastRunAt: new Date().toISOString(), ok: true, source: "manual", error: null,
  });
  await auditBackupRun(name, true, null);

  return {
    name,
    source: "manual",
    sizeBytes: finalStat.size,
    modifiedAt: finalStat.mtime.toISOString(),
    integrityOk: true,
  };
}
