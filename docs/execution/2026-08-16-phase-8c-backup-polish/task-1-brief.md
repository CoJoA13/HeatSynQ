### Task 1: The pure leaf — constants and path safety

**Files:**
- Create: `erp/src/lib/backup-constants.ts`
- Create: `erp/src/server/backup-paths.ts`
- Create: `erp/tests/backup-paths.test.ts`
- Create: `docs/execution/2026-08-16-phase-8c-backup-polish/progress.md`

**Interfaces:**
- Consumes: nothing (this is the leaf).
- Produces:
  - `DEFAULT_STALE_HOURS: 36`, `BACKUP_STATUS_FILENAME: "backup-status.json"`
  - `isArchiveName(name: string): boolean`, `archiveSourceOf(name: string): BackupSource | null`
  - types `BackupSource`, `BackupHealthState`, `BackupHealth`, `ArchiveInfo`, `BackupsView`, `BackupStatusFile`
  - `resolveBackupDir(raw?: string): string`, `archivePath(dir: string, name: string): string`,
    `statusPath(dir: string): string`, `stampFor(d: Date): string`,
    `manualArchiveName(d: Date, suffix: string): string`, `tempNameFor(archive: string): string`

- [ ] **Step 1: Create the execution ledger and commit it immediately**

CLAUDE.md's rule: the record is committed on the **first** task, never at the end.

```bash
mkdir -p docs/execution/2026-08-16-phase-8c-backup-polish
```

Write `docs/execution/2026-08-16-phase-8c-backup-polish/progress.md`:

```markdown
# Phase 8C — Backup polish: progress ledger

Branch: `phase-8c-backup-polish`. Plan: `docs/superpowers/plans/2026-08-16-phase-8c-backup-polish.md`.
Binding spec: the Phase 8 design spec §6 + **§6.4** (owner kickoff rulings, 2026-08-16).

## Baseline gates on `main` (2026-08-16, before branching)
vitest 2898 / 171 files · tsc clean · eslint clean · build clean · E2E 22/22 · 37 migrations.

## Tasks
| # | Task | Implementer | Review | Notes |
|---|---|---|---|---|
| 1 | Pure leaf: constants + path safety | | | |
| 2 | `manage_backups` + `backup_stale_hours` | | | |
| 3 | Health evaluation + archive listing | | | |
| 4 | `runBackupNow` | | | |
| 5 | API routes | | | |
| 6 | Backups admin page | | | |
| 7 | Shell warning bar | | | |
| 8 | Deploy wiring (Dockerfile/compose/backup.sh) | | | |
| 9 | Restore runbook + E2E flow + docs | | | |
```

```bash
git add docs/execution/2026-08-16-phase-8c-backup-polish/
git commit -m "docs: open the Phase 8C execution ledger"
```

- [ ] **Step 2: Write the failing test**

Create `erp/tests/backup-paths.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  resolveBackupDir, archivePath, statusPath, stampFor, manualArchiveName, tempNameFor,
} from "@/server/backup-paths";
import { isArchiveName, archiveSourceOf, DEFAULT_STALE_HOURS } from "@/lib/backup-constants";
import { HttpError } from "@/server/errors";

describe("backup archive names", () => {
  it("recognises the nightly and manual shapes, and nothing else", () => {
    expect(isArchiveName("erp_2026-08-16_020000.sql.gz")).toBe(true);
    expect(isArchiveName("erp_manual_2026-08-16_143012_a7f3b1c9.sql.gz")).toBe(true);
    // The status file, temp files, and anything else in the folder are NOT archives.
    expect(isArchiveName("backup-status.json")).toBe(false);
    expect(isArchiveName(".erp_2026-08-16_020000.sql.tmp")).toBe(false);
    expect(isArchiveName("erp_2026-08-16_020000.sql")).toBe(false);
    expect(isArchiveName("../../etc/passwd")).toBe(false);
    expect(isArchiveName("erp_2026-08-16_020000.sql.gz/../x")).toBe(false);
  });

  it("classifies the source from the name", () => {
    expect(archiveSourceOf("erp_2026-08-16_020000.sql.gz")).toBe("nightly");
    expect(archiveSourceOf("erp_manual_2026-08-16_143012_a7f3b1c9.sql.gz")).toBe("manual");
    expect(archiveSourceOf("nonsense")).toBe(null);
  });

  it("builds a manual name that is itself a valid archive name, and its temp partner", () => {
    const d = new Date(2026, 7, 16, 14, 30, 12); // local time, matching the sh script's `date`
    expect(stampFor(d)).toBe("2026-08-16_143012");
    const name = manualArchiveName(d, "a7f3b1c9");
    expect(name).toBe("erp_manual_2026-08-16_143012_a7f3b1c9.sql.gz");
    expect(isArchiveName(name)).toBe(true);
    // The temp partner is a dotfile so it never appears in a listing, and is NOT an archive name.
    expect(tempNameFor(name)).toBe(".erp_manual_2026-08-16_143012_a7f3b1c9.sql.tmp");
    expect(isArchiveName(tempNameFor(name))).toBe(false);
  });

  it("pads single-digit month/day/time components", () => {
    expect(stampFor(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02_030405");
  });

  it("exposes the owner-settled default staleness threshold", () => {
    expect(DEFAULT_STALE_HOURS).toBe(36);
  });
});

describe("resolveBackupDir", () => {
  it("defaults to /backups when BACKUP_DIR is unset", () => {
    expect(resolveBackupDir(undefined)).toBe("/backups");
  });

  it("resolves a relative dev path to an absolute one", () => {
    expect(resolveBackupDir("./backups")).toBe(`${process.cwd()}/backups`);
  });

  it("trims surrounding whitespace", () => {
    expect(resolveBackupDir("  /backups  ")).toBe("/backups");
  });

  it("refuses an empty value", () => {
    expect(() => resolveBackupDir("   ")).toThrow(HttpError);
  });

  it("refuses shell metacharacters even though the value is deploy-set", () => {
    for (const bad of ["/backups; rm -rf /", "/backups && x", "/back`ups`", "/back$ups", "/back|ups",
                       "/back>ups", "/back*ups", "/back'ups", '/back"ups', "/back\nups"]) {
      expect(() => resolveBackupDir(bad), bad).toThrow(HttpError);
    }
  });

  it("refuses .. segments in the RAW value (path.resolve would silently normalise them away)", () => {
    expect(() => resolveBackupDir("/backups/../etc")).toThrow(HttpError);
    expect(() => resolveBackupDir("../backups")).toThrow(HttpError);
  });
});

describe("archivePath", () => {
  it("joins a valid archive name onto the folder", () => {
    expect(archivePath("/backups", "erp_2026-08-16_020000.sql.gz"))
      .toBe("/backups/erp_2026-08-16_020000.sql.gz");
  });

  it("refuses any name that is not a valid archive name — the escape guard", () => {
    for (const bad of ["../../etc/passwd", "/etc/passwd", "erp_x.sql.gz", "backup-status.json", ""]) {
      expect(() => archivePath("/backups", bad), bad).toThrow(HttpError);
    }
  });

  it("puts the status file in the same folder", () => {
    expect(statusPath("/backups")).toBe("/backups/backup-status.json");
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `cd erp && npx vitest run tests/backup-paths.test.ts`
Expected: FAIL — `Cannot find module '@/lib/backup-constants'`.

- [ ] **Step 4: Write `src/lib/backup-constants.ts`**

```ts
// Client-safe backup constants and types (Phase 8C §6.4). The Backups page and the shell warning
// bar import from HERE, never from src/server/** — that import would drag node:async_hooks and
// Prisma into the browser bundle (the permission-constants.ts precedent, swept by
// tests/permissions-sweep.test.ts). Nothing in this file may import from src/server.

/** The owner-settled staleness threshold (§6.4): a full 12h of slack past the 24h cadence, so one
 *  late run never cries wolf but two consecutive misses always do. */
export const DEFAULT_STALE_HOURS = 36;

/** Written by BOTH writers (the nightly sh script and the app) as a single overwrite. It carries
 *  the LAST RUN only — `lastSuccessAt` is derived from the newest integrity-passing archive (§6.4),
 *  which is what removes any need for the sh script to read-merge JSON. */
export const BACKUP_STATUS_FILENAME = "backup-status.json";

/** Nightly, written by scripts/backup.sh:  erp_2026-08-16_020000.sql.gz */
export const NIGHTLY_ARCHIVE_RE = /^erp_\d{4}-\d{2}-\d{2}_\d{6}\.sql\.gz$/;
/** On-demand, written by the app. The random suffix is what makes a manual click and the nightly
 *  run collision-proof without a cross-process lock (§6.4) — the two writers can never produce the
 *  same path. Both shapes still start `erp_`, so the script's `-mtime +30` prune covers both. */
export const MANUAL_ARCHIVE_RE = /^erp_manual_\d{4}-\d{2}-\d{2}_\d{6}_[0-9a-f]{8}\.sql\.gz$/;

export type BackupSource = "nightly" | "manual";

export function archiveSourceOf(name: string): BackupSource | null {
  if (NIGHTLY_ARCHIVE_RE.test(name)) return "nightly";
  if (MANUAL_ARCHIVE_RE.test(name)) return "manual";
  return null;
}

export function isArchiveName(name: string): boolean {
  return archiveSourceOf(name) !== null;
}

/** `ok` is the only green state; every other state renders red (§6.2 "absence is failure"). */
export type BackupHealthState =
  | "ok"       // a recent integrity-passing archive AND a clean last run
  | "failed"   // the last recorded run failed — red immediately, regardless of an older success
  | "stale"    // no integrity-passing archive inside the window (or none at all)
  | "unknown"; // the status file is missing/unparseable, or the folder could not be read

export type BackupHealth = {
  state: BackupHealthState;
  /** Newest integrity-passing archive's mtime — DERIVED, never stored (§6.4). */
  lastSuccessAt: string | null;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  staleHours: number;
  /** A sentence the UI shows verbatim; always explains WHY, never just "red". */
  reason: string;
};

export type ArchiveInfo = {
  name: string;
  source: BackupSource;
  sizeBytes: number;
  modifiedAt: string;
  integrityOk: boolean;
};

export type BackupsView = { folder: string; health: BackupHealth; archives: ArchiveInfo[] };

/** The on-disk status file's shape. Deliberately tiny so `sh` can write it with a here-doc. */
export type BackupStatusFile = {
  lastRunAt: string;
  ok: boolean;
  source: BackupSource;
  error: string | null;
};

export function isHealthy(h: BackupHealth): boolean {
  return h.state === "ok";
}
```

- [ ] **Step 5: Write `src/server/backup-paths.ts`**

```ts
// The backup-path leaf (Phase 8C §6.4) — PURE: node:path, the errors.ts leaf, and the client-safe
// lib constants only. No fs, no database, no permissions, so it stays importable from anywhere
// (the order-locks.ts / invoice-guards.ts / practice-mode.ts precedent) and is testable without a
// filesystem.
//
// The threat model is worth stating, because it is NOT the obvious one. BACKUP_DIR is a deploy
// value, so "confine it to an allowed root" cannot mean much — the root IS the setting. The real
// protection is FILENAME-shaped: every path the app builds goes through archivePath(), whose name
// argument must match a strict archive regex (which forbids "/" and "..") before it is joined. A
// filename therefore can never escape the folder. The directory value itself is separately checked
// for shell metacharacters and ".." segments as defence in depth — even though pg_dump is spawned
// via argv and no string ever reaches a shell.
import path from "node:path";
import { HttpError } from "./errors";
import { BACKUP_STATUS_FILENAME, isArchiveName } from "@/lib/backup-constants";

/** The container path both writers agree on (§6.4). Host side is the `./backups` bind-mount. */
export const DEFAULT_BACKUP_DIR = "/backups";

// Anything a shell could interpret, plus NUL and newlines (which would corrupt the status file and
// any log line quoting the path).
const UNSAFE_CHARS = /[\0\n\r`$;&|<>*?()[\]{}'"\\]/;

export function resolveBackupDir(raw: string | undefined = process.env.BACKUP_DIR): string {
  const value = (raw ?? DEFAULT_BACKUP_DIR).trim();
  if (!value) {
    throw new HttpError(500, "The backup folder (BACKUP_DIR) is configured as an empty value.");
  }
  if (UNSAFE_CHARS.test(value)) {
    throw new HttpError(500, `The backup folder path contains unsafe characters: ${JSON.stringify(value)}`);
  }
  // Check the RAW value: path.resolve() would silently normalise "/backups/../etc" to "/etc", so a
  // post-resolve check can never see the traversal that was asked for.
  if (value.split(/[\\/]/).includes("..")) {
    throw new HttpError(500, `The backup folder path must not contain ".." segments: ${value}`);
  }
  // resolve() also lets a dev machine set BACKUP_DIR="./backups" and get an absolute path.
  return path.resolve(value);
}

/** The ONLY way to turn an archive name into a path. Rejects anything that is not a valid archive
 *  name, which is what makes escaping the folder impossible. */
export function archivePath(dir: string, name: string): string {
  if (!isArchiveName(name)) {
    throw new HttpError(400, `Not a backup archive name: ${JSON.stringify(name)}`);
  }
  const full = path.join(dir, name);
  // Belt and braces: the regex already forbids "/" and "..", so this can only fire if the regex is
  // ever loosened. Keep it — it is the assertion that documents the invariant.
  if (path.dirname(full) !== dir) {
    throw new HttpError(400, `Refusing a path outside the backup folder: ${JSON.stringify(name)}`);
  }
  return full;
}

export function statusPath(dir: string): string {
  return path.join(dir, BACKUP_STATUS_FILENAME);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** LOCAL time, matching scripts/backup.sh's `date +%Y-%m-%d_%H%M%S` — the two writers' names must
 *  sort together in the folder listing. */
export function stampFor(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** `suffix` is 8 lowercase hex chars from crypto.randomBytes(4) — see runBackupNow. */
export function manualArchiveName(d: Date, suffix: string): string {
  return `erp_manual_${stampFor(d)}_${suffix}.sql.gz`;
}

/** The temp partner: a DOTFILE (so it never shows in a listing) ending .sql.tmp, mirroring the sh
 *  script's own `.erp_${STAMP}.sql.tmp`. Never a valid archive name, so a half-written dump can
 *  never be listed or served as a backup. */
export function tempNameFor(archive: string): string {
  return `.${archive.replace(/\.sql\.gz$/, ".sql.tmp")}`;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd erp && npx vitest run tests/backup-paths.test.ts`
Expected: PASS, all cases.

- [ ] **Step 7: Run the fast gates**

Run: `cd erp && npx tsc --noEmit && npx eslint src tests`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add erp/src/lib/backup-constants.ts erp/src/server/backup-paths.ts erp/tests/backup-paths.test.ts
git commit -m "feat(backups): add the pure backup-path leaf and client-safe constants"
```

---

