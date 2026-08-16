### Task 3: Health evaluation and archive listing

**Files:**
- Create: `erp/src/server/backups.ts` (read side only — Task 4 adds the write side)
- Modify: `erp/src/server/practice-mode.ts` (add `assertNotPracticeDatabase`)
- Create: `erp/tests/backup-health.test.ts`

**Interfaces:**
- Consumes: Task 1's `resolveBackupDir`/`statusPath`/`archivePath`/`isArchiveName`/`archiveSourceOf`;
  Task 2's `backup_stale_hours`.
- Produces:
  - `evaluateHealth(i: HealthInputs): BackupHealth` — **pure**, exported for table-driven tests
  - `type HealthInputs = { newestSuccessAt: Date | null; status: BackupStatusFile | null; staleHours: number; now: Date; folderError: string | null }`
  - `listArchives(dir?: string): Promise<ArchiveInfo[]>`
  - `backupHealth(dir?: string): Promise<BackupHealth>`
  - `backupsView(): Promise<BackupsView>`
  - `assertNotPracticeDatabase(db?): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `erp/tests/backup-health.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd erp && npx vitest run tests/backup-health.test.ts`
Expected: FAIL — `Cannot find module '@/server/backups'`.

- [ ] **Step 3: Add `assertNotPracticeDatabase` to `practice-mode.ts`**

Append to `erp/src/server/practice-mode.ts`, directly below `assertPracticeDatabase`:

```ts
// The mirror of assertPracticeDatabase, for the actions that are PRODUCTION-only (Phase 8C §6.3):
// the Backups page, its reads, and "Back up now". A trainer's manual backup must never pollute
// production's archive list or staleness signal, and the practice copy's data is disposable (the
// reset re-seeds it), so it carries no backup responsibility at all. Un-memoized and on the
// caller's client for the same reason its twin is: a mis-set flag must never reach the action.
// Belt AND braces — compose also denies app-practice both BACKUP_DIR and the ./backups mount.
export async function assertNotPracticeDatabase(db: Db = prisma): Promise<void> {
  const name = await currentDatabase(db);
  if (name === PRACTICE_DB_NAME) {
    throw new HttpError(
      403,
      "Backups are managed on the production copy only — the practice database is not backed up.",
    );
  }
}
```

- [ ] **Step 4: Write the read side of `src/server/backups.ts`**

```ts
// The Backups service (Phase 8C §6). Owns every filesystem and child-process interaction; the
// path/name rules live in the pure backup-paths.ts leaf, and the types in the client-safe
// lib/backup-constants.ts.
//
// THE LOAD-BEARING IDEA (§6.4): `lastSuccessAt` is DERIVED from the newest integrity-passing
// archive, not stored. The archive IS the evidence of success. That is what lets the status file
// be a single un-merged overwrite — a shell script cannot reasonably read-merge JSON to preserve a
// previous success across a failed run, and any scheme that needed it would be fragile in exactly
// the failure case it exists to report.
import { readdir, stat, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type ArchiveInfo, type BackupHealth, type BackupStatusFile, type BackupsView,
  archiveSourceOf, isArchiveName,
} from "@/lib/backup-constants";
import { archivePath, resolveBackupDir, statusPath } from "./backup-paths";
import { getSetting } from "./settings";

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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd erp && npx vitest run tests/backup-health.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the fast gates**

Run: `cd erp && npx tsc --noEmit && npx eslint src tests`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add erp/src erp/tests
git commit -m "feat(backups): evaluate staleness and list archives with integrity"
```

---

