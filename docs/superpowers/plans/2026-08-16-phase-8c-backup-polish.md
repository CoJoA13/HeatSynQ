# Phase 8C — Backup Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the app an in-app Backups page — archive list, resolved folder, "Back up now", and a red
staleness indicator that treats absence as failure — bridged to the nightly backup container through a
shared folder, with restore staying a documented terminal command.

**Architecture:** Four new units, leaf-first. A client-safe constants module holds the types and archive-name
regexes; a **pure, fs-free** `backup-paths.ts` leaf owns path resolution/validation and name building; a
`backups.ts` service does the fs and process work (list, health, run); a `SetupBanner`-cloned shell bar and an
admin page render it. The two writers — the nightly `sh` script and the app — never share a filename, so no
cross-process lock is needed, and `lastSuccessAt` is **derived from the newest integrity-passing archive**
rather than stored, which is what lets the status file be a single un-merged overwrite.

**Tech Stack:** Next 16 (App Router) · React 19 · Prisma 7 / PostgreSQL 18 · zod · Vitest 3 · Playwright ·
Node `node:child_process` (`execFile`, argv only) + `node:zlib` + `node:fs/promises` · Alpine
`postgresql18-client`.

## Global Constraints

Copied verbatim from the binding documents. **Every task's requirements implicitly include this section.**

- **Binding spec:** `docs/superpowers/specs/2026-08-14-phase-8-reports-parallel-run-design.md` §6 (8C) and
  **§6.4** (the owner's kickoff rulings, 2026-08-16). §6.4 wins over any older prose in §6.1–§6.3.
- **`manage_backups` is APPROVED** (spec §12 item 6). Do **not** re-raise it with the owner. Older "flagged
  for owner sign-off" prose has been corrected in §6.2/§8; §12 is the authority.
- **Backup folder:** env **`BACKUP_DIR`**, container path **`/backups`**, host `./backups`. `app` and `backup`
  get it; **`app-practice` gets neither the env nor the mount.**
- **`backup_stale_hours`:** typed `int(1, 8760)`, **default 36**, group `"System"`.
- **Cadence + retention unchanged:** nightly `sleep 86400`; `find /backups -name 'erp_*.sql.gz' -mtime +30
  -delete`. On-demand archives obey the **same** 30-day prune.
- **Green rule (all three required):** newest integrity-passing archive within `backup_stale_hours` **AND**
  the last recorded run did not fail **AND** the status file is present and parseable. Everything else is red.
- **Handlers stay thin:** `handle(async (req) => ...)`, first line `mustDo(requireUser(), "manage_backups")`,
  then parse, then delegate. Business rules live in `src/server/*.ts`. React components hold no business logic.
- **Client components must not import from `src/server/**`** — shared types/constants go in `src/lib/`
  (`permission-constants.ts` is the precedent). `tests/permissions-sweep.test.ts` enforces this.
- **`HttpError(status, message)`** for expected failures; anything else escaping a handler is a bug.
- **Route handler tests must pass ctx:** `handler(request, { params: Promise.resolve({}) })`.
- **`pg_dump` is spawned via argv, never a shell string.** No `exec`, no shell interpolation, ever.
- **Never an empty archive** (the Phase 1 review lesson): dump to a temp file, verify exit status **and**
  non-zero size, only then gzip and rename into place.
- **`runBackupNow` takes an injectable dump command** (a plain parameter, default `"pg_dump"` — **not** a new
  env var). CI's `ubuntu-latest` `pg_dump` is an older major than the `postgres:18` server and hard-refuses a
  newer server, so vitest must never shell out to the host binary.
- **Production-only:** every backup route and the page are refused/hidden in practice mode, via
  `practice-mode.ts` (the single source of practice-vs-production). Do not read `PRACTICE_MODE` directly.
- **Tests share one database** and call `truncateAll()` in `beforeEach`; `fileParallelism: false`. Don't
  parallelize. Never `vi.spyOn` a Prisma model delegate — save/restore the property instead.
- **No migration in 8C** (spec §9) — `backup_stale_hours` lives in the typed registry.
- **Commits:** conventional, **no attribution trailer on individual commits** (attribution goes in the PR body).
- **Execution record:** `docs/execution/2026-08-16-phase-8c-backup-polish/` — created and **committed on Task 1**,
  not at the end.
- **Run `npm run test:e2e` on any UI/flow-touching change.** It needs the dev server and the **DEV** db (`erp`).
  Run it in the **background** — it takes ~10 minutes, near the tooling's per-command ceiling.
- **Gates that must stay green:** `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`,
  `npm run test:e2e`. **A gate row is written after watching the run end, or it says PENDING.**

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/backup-constants.ts` | **NEW, client-safe.** Types (`ArchiveInfo`, `BackupHealth`, `BackupsView`), archive-name regexes + `isArchiveName`, `DEFAULT_STALE_HOURS`, `BACKUP_STATUS_FILENAME`. The page and banner import from here, never from `src/server/**` |
| `src/server/backup-paths.ts` | **NEW, pure leaf** — imports only `node:path`, `errors.ts`, and the lib constants. No fs, no db, no permissions. Resolves/validates `BACKUP_DIR`; builds nightly/manual archive + temp names; the *only* way to join a filename onto the folder |
| `src/server/backups.ts` | **NEW service.** `evaluateHealth` (exported **pure** function), `listArchives`, `backupHealth`, `runBackupNow`. Owns all fs and `execFile` work |
| `src/server/audit.ts` | **MODIFY** — add `auditBackupRun`, the `auditSettingChange` sanctioned-exception shape. Keeps `audit.ts` the sole `prisma.auditLog.create` caller |
| `src/server/practice-mode.ts` | **MODIFY** — add `assertNotPracticeDatabase`, the mirror of `assertPracticeDatabase` (un-memoized, in-request) |
| `src/lib/permission-constants.ts` | **MODIFY** — add `manage_backups` to `SPECIAL_ACTIONS`. The roles UI renders from this constant, so no roles-page edit is needed |
| `src/server/settings.ts` | **MODIFY** — add `backup_stale_hours` to the registry |
| `src/app/api/admin/backups/route.ts` | **NEW** — `GET` the full view (folder + health + archives) |
| `src/app/api/admin/backups/run/route.ts` | **NEW** — `POST` "Back up now" |
| `src/app/api/admin/backups/health/route.ts` | **NEW** — `GET` the cheap health-only read the shell bar polls |
| `src/app/admin/backups/page.tsx` | **NEW** — the client page |
| `src/components/BackupBanner.tsx` | **NEW** — the shell warning bar, a `SetupBanner` clone |
| `src/app/layout.tsx` | **MODIFY** — mount `<BackupBanner />` beside `<SetupBanner />` |
| `src/components/Shell.tsx` | **MODIFY** — add the Backups nav entry under Admin |
| `Dockerfile` | **MODIFY** — `apk add --no-cache postgresql18-client` in the run stage |
| `docker-compose.yml` | **MODIFY** — `BACKUP_DIR` + `./backups` mount on `app`; `BACKUP_DIR` on `backup`; **nothing** on `app-practice` |
| `scripts/backup.sh` | **MODIFY** — honor `BACKUP_DIR`, write the status file, prune orphaned `.tmp` files |
| `.env.example` | **MODIFY** — document `BACKUP_DIR` |
| `e2e/flows/backups.mjs` + `e2e/run.mjs` | **NEW / MODIFY** — the `backups` flow |
| `erp/README.md`, `docs/HANDOFF.md`, `CLAUDE.md` | **MODIFY** — restore runbook + the standing-architecture lines |

---

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

### Task 2: `manage_backups` action and the `backup_stale_hours` setting

**Files:**
- Modify: `erp/src/lib/permission-constants.ts:9-14`
- Modify: `erp/src/server/settings.ts` (the `SETTINGS` registry, "System" group)
- Modify: `erp/tests/permissions.test.ts` (add the new action's assertions)
- Create: `erp/tests/backup-settings.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_STALE_HOURS` from Task 1.
- Produces: the `"manage_backups"` member of `SpecialAction`; the `backup_stale_hours` `SettingKey`.

- [ ] **Step 1: Write the failing test**

Create `erp/tests/backup-settings.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { getSetting, setSetting } from "@/server/settings";
import { SPECIAL_ACTIONS } from "@/lib/permission-constants";
import { DEFAULT_STALE_HOURS } from "@/lib/backup-constants";
import { runWithContext } from "@/server/context";

// setSetting audits, so it needs an actor in context. This is the repo's established idiom —
// copied verbatim from tests/order-entry-readiness.test.ts, which declares it the same way.
// There is NO tests/helpers/actor.ts; do not create one.
const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

describe("backup_stale_hours", () => {
  beforeEach(async () => { await truncateAll(); });

  it("defaults to the owner-settled 36 hours", async () => {
    expect(await getSetting("backup_stale_hours")).toBe(DEFAULT_STALE_HOURS);
  });

  it("accepts a sane override", async () => {
    await asSystem(async () => { await setSetting("backup_stale_hours", 24); });
    expect(await getSetting("backup_stale_hours")).toBe(24);
  });

  it("refuses zero, negatives, non-integers and absurd values", async () => {
    await asSystem(async () => {
      await expect(setSetting("backup_stale_hours", 0)).rejects.toThrow();
      await expect(setSetting("backup_stale_hours", -1)).rejects.toThrow();
      await expect(setSetting("backup_stale_hours", 1.5)).rejects.toThrow();
      await expect(setSetting("backup_stale_hours", 8761)).rejects.toThrow();
    });
  });
});

describe("manage_backups", () => {
  it("is a named special action", () => {
    expect(SPECIAL_ACTIONS).toContain("manage_backups");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd erp && npx vitest run tests/backup-settings.test.ts`
Expected: FAIL — `backup_stale_hours` is not a `SettingKey` (a tsc error surfaced by vitest), and
`SPECIAL_ACTIONS` does not contain `manage_backups`.

- [ ] **Step 3: Add the special action**

In `erp/src/lib/permission-constants.ts`, extend the array (the roles page renders from this constant,
so the UI needs no edit):

```ts
export const SPECIAL_ACTIONS = [
  "void_shipper", "unlock_invoice", "void_order", "change_prices",
  "edit_cert_results_after_print", "apply_payments", "run_qbo_export",
  "close_ar_period", "edit_templates", "manage_users", "override_credit_hold",
  "write_off",
  // Phase 8C §6.2/§12 item 6 (owner-approved at design approval — do NOT re-raise): gates the
  // Backups page, "Back up now", and the staleness reads. A dump is a full copy of every
  // customer's record, which is why it is a named dangerous action rather than part of `admin`.
  "manage_backups",
] as const;
```

- [ ] **Step 4: Add the setting**

In `erp/src/server/settings.ts`, inside `SETTINGS`, beside `session_timeout_minutes` in the "System"
group:

```ts
  // Phase 8C §6.4: the ONLY backup setting. The folder, cadence and retention are deploy config —
  // the nightly container cannot honor a live change, and a setting the writer ignores is a
  // half-working feature. This one the app CAN honor, because the app is what evaluates staleness.
  // Default 36 = a full 12h of slack past the 24h cadence: one late run never cries wolf, two
  // consecutive misses always do. Capped at a year, floored at 1 (a zero-hour window is
  // permanently red and therefore meaningless).
  backup_stale_hours: {
    schema: int(1, 8760), default: DEFAULT_STALE_HOURS, label: "Backup staleness threshold (hours)", group: "System",
  },
```

Add the import at the top of `settings.ts`:

```ts
import { DEFAULT_STALE_HOURS } from "@/lib/backup-constants";
```

- [ ] **Step 5: Extend the permission test**

`erp/tests/permissions.test.ts` already has a local, DB-free helper at the top of the file:

```ts
function user(rolePerms: string[], overrides: { permission: string; mode: "GRANT" | "DENY" }[] = []): PermUser
```

Use it — do **not** invent a `userWithPermissions`. Add this case:

```ts
  it("manage_backups is denied by default and granted by an explicit action grant", () => {
    expect(canDo(user([]), "manage_backups")).toBe(false);
    expect(canDo(user(["action.manage_backups"]), "manage_backups")).toBe(true);
    // A DENY override must beat the grant, like every other dangerous action.
    expect(canDo(
      user(["action.manage_backups"], [{ permission: "action.manage_backups", mode: "DENY" }]),
      "manage_backups",
    )).toBe(false);
  });
```

Then scan the rest of the file (and `tests/permissions-sweep.test.ts`) for any case that enumerates
`SPECIAL_ACTIONS` or asserts a **count** of permissions — `ALL_PERMISSIONS` grows by one — and update
it. Run the whole of both files, not just your new case.

- [ ] **Step 6: Run the tests**

Run: `cd erp && npx vitest run tests/backup-settings.test.ts tests/permissions.test.ts tests/permissions-sweep.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the fast gates**

Run: `cd erp && npx tsc --noEmit && npx eslint src tests`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add erp/src erp/tests
git commit -m "feat(backups): add the manage_backups action and backup_stale_hours setting"
```

---

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

const NOW = new Date("2026-08-16T12:00:00Z");
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
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "hsq-backups-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("reads RED for a folder that does not exist", async () => {
    const h = await backupHealth(path.join(dir, "missing"));
    expect(h.state).toBe("unknown");
  });

  it("ignores a CORRUPT newest archive and derives success from the newest INTACT one", async () => {
    // The corrupt file is newer; a naive "newest mtime" would call this fresh. Integrity decides.
    await writeFile(path.join(dir, "erp_2026-08-14_020000.sql.gz"), gzipSync(Buffer.from("-- good\n")));
    await writeFile(path.join(dir, "erp_2026-08-16_020000.sql.gz"), Buffer.from("corrupt"));
    await writeFile(path.join(dir, BACKUP_STATUS_FILENAME), JSON.stringify(
      { lastRunAt: new Date().toISOString(), ok: true, source: "nightly", error: null }));
    const h = await backupHealth(dir);
    expect(h.lastSuccessAt).not.toBeNull();
    // The intact archive is the one whose mtime is reported.
    expect(new Date(h.lastSuccessAt!).getTime())
      .toBeLessThan(new Date().getTime());
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

### Task 4: `runBackupNow` — the fail-loud on-demand dump

**Files:**
- Modify: `erp/src/server/backups.ts` (append the write side)
- Modify: `erp/src/server/audit.ts` (add `auditBackupRun`)
- Create: `erp/tests/backup-run.test.ts`
- Create: `erp/tests/fixtures/fake-pg-dump.sh` (the injected dump command)

**Interfaces:**
- Consumes: Task 3's `listArchives`/`readStatus`; Task 1's name builders; `assertNotPracticeDatabase`.
- Produces:
  - `runBackupNow(opts?: { dumpBin?: string; dumpArgs?: string[]; dir?: string }): Promise<ArchiveInfo>`
  - `auditBackupRun(archive: string, ok: boolean, error: string | null): Promise<void>`

- [ ] **Step 1: Create the fake dump command**

Create `erp/tests/fixtures/fake-pg-dump.sh` (make it executable — `chmod +x`):

```sh
#!/bin/sh
# Test double for pg_dump (Phase 8C §6.4). vitest MUST NOT shell out to a host pg_dump: CI runs
# ubuntu-latest, whose bundled pg_dump is an older major than the postgres:18 server, and pg_dump
# hard-refuses a newer server. This double lets the tests exercise the REAL machinery — argv spawn,
# temp-then-verify, the fail-loud empty check, gzip, integrity check, naming, status write.
#
#   FAKE_DUMP_MODE=ok     (default) emit a plausible dump on stdout
#   FAKE_DUMP_MODE=fail   exit non-zero, having written nothing
#   FAKE_DUMP_MODE=empty  exit ZERO but emit nothing — the silent-corruption case
case "${FAKE_DUMP_MODE:-ok}" in
  fail)  echo "pg_dump: error: connection failed" >&2; exit 1 ;;
  empty) exit 0 ;;
  *)     echo "-- fake dump of $1"; echo "CREATE TABLE t (id int);" ;;
esac
```

- [ ] **Step 2: Write the failing test**

Create `erp/tests/backup-run.test.ts`:

```ts
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
    const info = await run();
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
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `cd erp && npx vitest run tests/backup-run.test.ts`
Expected: FAIL — `runBackupNow` is not exported.

- [ ] **Step 4: Add `auditBackupRun` to `audit.ts`**

Directly below `auditSettingChange` in `erp/src/server/audit.ts`:

```ts
/** Phase 8C §6.4. A dump is a full copy of every customer's record and `manage_backups` is a named
 *  dangerous action, so "who dumped production, and when" is an audit question — but a backup has
 *  no entity ROW to hang an auditedCreate on. This is the auditSettingChange sanctioned-exception
 *  shape: a direct write, kept HERE so audit.ts stays the sole prisma.auditLog.create caller (the
 *  permissions sweep asserts exactly that). A FAILED attempt is audited too — an attempted dump is
 *  still an access event. */
export async function auditBackupRun(archive: string, ok: boolean, error: string | null): Promise<void> {
  const actor = currentActor();
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      actorName: actor.name,
      entity: "backup",
      entityId: archive,
      action: "create",
      after: redact({ archive, ok, error }),
    },
  });
}
```

- [ ] **Step 5: Append the write side to `src/server/backups.ts`**

Add these imports to the existing import block:

```ts
import { open, rename, unlink, writeFile, access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { HttpError } from "./errors";
import { auditBackupRun } from "./audit";
import { assertNotPracticeDatabase } from "./practice-mode";
import { manualArchiveName, tempNameFor } from "./backup-paths";
```

Then append:

```ts
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
      child.on("error", reject);
      child.on("close", (code) => {
        out.end();
        out.on("finish", () => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `exit ${code}`))));
        out.on("error", reject);
      });
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
```

> **Note for the implementer:** `open` and `FS` may end up unused once you finish — drop any unused
> import rather than leaving it for eslint to flag.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd erp && chmod +x tests/fixtures/fake-pg-dump.sh && npx vitest run tests/backup-run.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the sweeps and the fast gates**

Run: `cd erp && npx vitest run tests/permissions-sweep.test.ts && npx tsc --noEmit && npx eslint src tests`
Expected: all clean. The sweep must still report `audit.ts` as the sole `prisma.auditLog.create` caller.

- [ ] **Step 8: Commit**

```bash
git add erp/src erp/tests
git commit -m "feat(backups): add the fail-loud on-demand pg_dump"
```

---

### Task 5: The API routes

**Files:**
- Create: `erp/src/app/api/admin/backups/route.ts`
- Create: `erp/src/app/api/admin/backups/run/route.ts`
- Create: `erp/src/app/api/admin/backups/health/route.ts`
- Create: `erp/tests/backups-routes.test.ts`

**Interfaces:**
- Consumes: `backupsView`, `backupHealth`, `runBackupNow` (Tasks 3–4); `manage_backups` (Task 2).
- Produces: `GET /api/admin/backups` → `BackupsView`; `POST /api/admin/backups/run` → `{ archive: ArchiveInfo }`;
  `GET /api/admin/backups/health` → `BackupHealth`.

- [ ] **Step 1: Write the failing test**

Create `erp/tests/backups-routes.test.ts`:

```ts
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
```

> **Note:** `signInWith` creates a role named `Role-<username>` and a user, so two calls in one test
> need distinct usernames — pass a second argument when a test signs in twice.

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd erp && npx vitest run tests/backups-routes.test.ts`
Expected: FAIL — the route modules do not exist.

- [ ] **Step 3: Write the three routes**

`erp/src/app/api/admin/backups/route.ts`:

```ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustDo } from "@/server/permissions";
import { backupsView } from "@/server/backups";

export const GET = handle(async () => {
  mustDo(requireUser(), "manage_backups");
  return NextResponse.json(await backupsView());
});
```

`erp/src/app/api/admin/backups/health/route.ts`:

```ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustDo } from "@/server/permissions";
import { backupHealth } from "@/server/backups";

// The cheap read the shell warning bar polls: no directory listing, and at most a couple of
// integrity checks (backupHealth stops at the newest INTACT archive).
export const GET = handle(async () => {
  mustDo(requireUser(), "manage_backups");
  return NextResponse.json(await backupHealth());
});
```

`erp/src/app/api/admin/backups/run/route.ts`:

```ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustDo } from "@/server/permissions";
import { runBackupNow } from "@/server/backups";

// runBackupNow re-checks the database identity itself (§6.3) — the practice copy is refused there,
// not here, so no caller can reach a dump by finding another route into the service.
export const POST = handle(async () => {
  mustDo(requireUser(), "manage_backups");
  return NextResponse.json({ archive: await runBackupNow() });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd erp && npx vitest run tests/backups-routes.test.ts tests/permissions-sweep.test.ts`
Expected: PASS. The sweep's "every admin route gates on a permission" case must accept `mustDo`.

- [ ] **Step 5: Run the fast gates**

Run: `cd erp && npx tsc --noEmit && npx eslint src tests`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add erp/src erp/tests
git commit -m "feat(backups): add the manage_backups-gated backup routes"
```

---

### Task 6: The Backups admin page

**Files:**
- Create: `erp/src/app/admin/backups/page.tsx`
- Modify: `erp/src/components/Shell.tsx` (nav entry)
- *(No component test here — the page is a thin render over one endpoint and is covered by the Task 9
  E2E flow. The component test that IS worth writing lands in Task 7, where `tests/practice-banner.test.tsx`
  gives a direct precedent for the banner's conditional-render logic.)*

**Interfaces:**
- Consumes: `GET /api/admin/backups`, `POST /api/admin/backups/run`; types from `@/lib/backup-constants`.
- Produces: the page at `/admin/backups`.

- [ ] **Step 1: Read two existing admin pages first**

Run: `cd erp && sed -n '1,80p' src/app/admin/templates/page.tsx && sed -n '1,60p' src/app/admin/settings/page.tsx`

Match their conventions exactly: `"use client"`, the `api`/`ApiError` helper from `@/lib/fetcher`, the
`gateDo` helper from `@/lib/permission-ui` for disabled-with-reason controls, table classes, and the
error-banner pattern. **§5.13: roll back to server truth FIRST, then report the error — never run a
reload that clears the banner after setting it.**

- [ ] **Step 2: Write the page**

```tsx
"use client";
// The Backups page (Phase 8C §6.2). Gated on `manage_backups`, production-only (the routes refuse
// the practice copy). Everything it shows comes from one guarded endpoint; it holds no business
// logic — the green rule lives in evaluateHealth (backups.ts), which is where it is tested.
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { gateDo } from "@/lib/permission-ui";
import type { ArchiveInfo, BackupsView } from "@/lib/backup-constants";

const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB`
  : n >= 1024 ? `${(n / 1024).toFixed(0)} KB`
  : `${n} B`;

const fmtWhen = (iso: string) => new Date(iso).toLocaleString();

export default function BackupsPage() {
  const [view, setView] = useState<BackupsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [perms, setPerms] = useState<string[] | undefined>(undefined);

  const load = useCallback(async () => {
    const v = await api<BackupsView>("/api/admin/backups");
    setView(v);
    return v;
  }, []);

  useEffect(() => {
    api<{ permissions: string[] }>("/api/auth/me").then((me) => setPerms(me.permissions)).catch(() => setPerms([]));
    load().catch((e) => setError(e instanceof ApiError ? e.message : "Could not read the backup folder."));
  }, [load]);

  const gate = gateDo(perms, "manage_backups");

  async function backUpNow() {
    setRunning(true);
    setError(null);
    try {
      await api<{ archive: ArchiveInfo }>("/api/admin/backups/run", { method: "POST" });
      await load();
    } catch (e) {
      // §5.13: refresh to server truth FIRST, then report — a reload after setError would wipe the
      // banner the operator needs to read.
      await load().catch(() => {});
      setError(e instanceof ApiError ? e.message : "The backup failed.");
    } finally {
      setRunning(false);
    }
  }

  const health = view?.health;
  const green = health?.state === "ok";

  return (
    <div className="p-6">
      <h1 className="mb-4 text-xl font-semibold">Backups</h1>

      {error && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}

      {health && (
        <div
          className={`mb-4 rounded border px-4 py-3 ${
            green ? "border-green-300 bg-green-50 text-green-900"
                  : "border-red-300 bg-red-50 text-red-900"}`}
        >
          <div className="font-semibold">
            {green ? "Backups are up to date" : "Backups need attention"}
          </div>
          <div className="text-sm">{health.reason}</div>
          <div className="mt-1 text-xs opacity-80">
            {health.lastSuccessAt
              ? `Last successful backup: ${fmtWhen(health.lastSuccessAt)}`
              : "No successful backup on record."}
            {" · "}Threshold: {health.staleHours} hours
          </div>
        </div>
      )}

      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={backUpNow}
          disabled={gate.disabled || running}
          title={gate.title}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {running ? "Backing up…" : "Back up now"}
        </button>
        <span className="text-sm text-gray-600">
          Backup folder: <code className="rounded bg-gray-100 px-1">{view?.folder ?? "…"}</code>
        </span>
      </div>

      <p className="mb-4 text-sm text-gray-600">
        Restoring is a deliberate terminal command, not a button — see the restore runbook in
        <code className="mx-1 rounded bg-gray-100 px-1">erp/README.md</code>.
      </p>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="py-1">Archive</th><th>Taken</th><th>Source</th><th>Size</th><th>Integrity</th>
          </tr>
        </thead>
        <tbody>
          {(view?.archives ?? []).map((a) => (
            <tr key={a.name} className="border-b">
              <td className="py-1 font-mono text-xs">{a.name}</td>
              <td>{fmtWhen(a.modifiedAt)}</td>
              <td>{a.source === "manual" ? "On demand" : "Nightly"}</td>
              <td>{fmtBytes(a.sizeBytes)}</td>
              <td className={a.integrityOk ? "text-green-700" : "text-red-700"}>
                {a.integrityOk ? "OK" : "CORRUPT"}
              </td>
            </tr>
          ))}
          {view && view.archives.length === 0 && (
            <tr><td colSpan={5} className="py-3 text-gray-600">No backup archives in this folder yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Add the nav entry**

In `erp/src/components/Shell.tsx`, find the Admin nav group and add an entry pointing at
`/admin/backups`, gated the way the group's siblings are gated. **Match the file's existing gating
idiom exactly** — read the neighbouring entries first; if they gate on a permission key, use
`action.manage_backups`.

- [ ] **Step 4: Verify in the browser**

```bash
cd erp && npm run dev
```

Then, with the preview tools: open `/admin/backups`, confirm the red indicator renders (no archives
exist on a dev machine yet), the folder path shows, and the console is clean. Click **Back up now**
and confirm an archive appears and the indicator flips green.

> Set `BACKUP_DIR=./backups` in `erp/.env` for the dev run, and `mkdir -p erp/backups` first — `/backups`
> does not exist on a dev host.

- [ ] **Step 5: Run the fast gates**

Run: `cd erp && npx tsc --noEmit && npx eslint src tests && npx vitest run tests/permissions-sweep.test.ts`
Expected: all clean — the sweep's "no client component imports from src/server" case is the one that
matters here.

- [ ] **Step 6: Commit**

```bash
git add erp/src
git commit -m "feat(backups): add the Backups admin page"
```

---

### Task 7: The shell warning bar

**Files:**
- Create: `erp/src/components/BackupBanner.tsx`
- Modify: `erp/src/app/layout.tsx`
- Create: `erp/tests/backup-banner.test.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/backups/health`.
- Produces: `<BackupBanner />`.

**Component test:** `erp/tests/practice-banner.test.tsx` is the precedent — read it first and match its
setup (render harness, fetch stubbing, and how it drives `usePathname`). The four cases that matter,
because each is a way the bar could silently fail to warn:

1. a red health payload renders the bar with its `reason` and a link to `/admin/backups`;
2. `state: "ok"` renders **nothing**;
3. a **403** (a caller without `manage_backups`) renders **nothing** and does not throw;
4. on `/login` it renders nothing and does not fetch.

- [ ] **Step 1: Read the precedent**

Run: `cd erp && cat src/components/SetupBanner.tsx`

This component is a deliberate clone of it. Keep its structure: mounted by the root layout **above**
`Shell` so it survives Shell's `/login` and me-null early returns; renders `null` on a 403 (a caller
without `manage_backups` sees nothing); clears and re-arms on `/login`.

- [ ] **Step 2: Write the banner**

```tsx
"use client";
// The backup staleness bar (Phase 8C §6.4). A red light on a page nobody opens is the same silent
// failure this feature exists to kill, so staleness surfaces on EVERY screen — but only for holders
// of `manage_backups`: the health route 403s for everyone else and this renders nothing, so the
// shop floor is never nagged about an admin concern. A direct SetupBanner clone.
//
// Unlike SetupBanner (whose readiness rollup runs an argon2 verify and so is fetched once per
// session), this endpoint is a cheap stat + one gzip -t, so it refetches on navigation — throttled,
// because a backup's state changes nightly, not per click.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/lib/fetcher";
import type { BackupHealth } from "@/lib/backup-constants";

const REFRESH_MS = 5 * 60 * 1000;

export function BackupBanner() {
  const [health, setHealth] = useState<BackupHealth | null>(null);
  const pathname = usePathname();
  const lastFetchedAt = useRef(0);

  useEffect(() => {
    if (pathname === "/login") {
      setHealth(null);
      lastFetchedAt.current = 0;   // re-arm for the next login
      return;
    }
    if (Date.now() - lastFetchedAt.current < REFRESH_MS) return;
    lastFetchedAt.current = Date.now();
    api<BackupHealth>("/api/admin/backups/health")
      .then(setHealth)
      .catch(() => {
        // 403 for a caller without manage_backups, or a transient failure: show nothing and allow
        // a retry on the next navigation.
        setHealth(null);
        lastFetchedAt.current = 0;
      });
  }, [pathname]);

  if (!health || health.state === "ok") return null;

  return (
    <div className="flex items-center justify-center gap-3 bg-red-700 px-4 py-1.5 text-sm text-white">
      <span>⚠ {health.reason}</span>
      <Link href="/admin/backups" className="font-semibold underline">Open Backups</Link>
    </div>
  );
}
```

- [ ] **Step 3: Mount it in the root layout**

In `erp/src/app/layout.tsx`, add the import and render it beside `<SetupBanner />`:

```tsx
import { BackupBanner } from "@/components/BackupBanner";
```

```tsx
        {isPractice && <PracticeBanner />}
        <SetupBanner />
        <BackupBanner />
        <Shell>{children}</Shell>
```

- [ ] **Step 4: Verify in the browser**

With `npm run dev` running and `erp/backups` empty, sign in as admin: the red bar must appear on an
ordinary page (e.g. `/customers`), link to `/admin/backups`, and disappear after a successful
"Back up now". Confirm it does **not** appear on `/login`.

- [ ] **Step 5: Run the fast gates**

Run: `cd erp && npx tsc --noEmit && npx eslint src tests && npx vitest run tests/permissions-sweep.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add erp/src
git commit -m "feat(backups): surface staleness in a manage_backups-only shell bar"
```

---

### Task 8: Deploy wiring — image, compose, and the nightly script

**Files:**
- Modify: `erp/Dockerfile`
- Modify: `erp/docker-compose.yml`
- Modify: `erp/scripts/backup.sh`
- Modify: `erp/.env.example`

**Interfaces:**
- Consumes: `BACKUP_DIR`, `BACKUP_STATUS_FILENAME` (Task 1).
- Produces: a `pg_dump`-capable app image; a status-file-writing nightly script.

- [ ] **Step 1: Add the postgres client to the app image**

In `erp/Dockerfile`, in the `run` stage, directly after `ENV NODE_ENV=production`:

```dockerfile
# Phase 8C §6.1: "Back up now" runs pg_dump inside the app container, so the run image needs the
# client tools. The MAJOR must match the db service's server — pg_dump hard-refuses a server newer
# than itself — so this stays version-locked to docker-compose.yml's `postgres:` image tag, the same
# rule the backup container already follows. pg_restore ships alongside it for the restore runbook.
RUN apk add --no-cache postgresql18-client
```

- [ ] **Step 2: Wire compose**

In `erp/docker-compose.yml`, `app` service — add the env and the mount:

```yaml
    environment:
      DATABASE_URL: postgresql://erp:erp_local_dev@db:5432/erp
      SESSION_SECRET: ${SESSION_SECRET:?set in .env}
      # Phase 8C §6.4: the SAME folder the backup container writes to, so the app can list archives
      # and write on-demand ones. A deploy value, deliberately not a runtime Setting — the nightly
      # container cannot honor a live change, and a setting the writer ignores is half a feature.
      BACKUP_DIR: /backups
    volumes:
      - ./backups:/backups
```

`backup` service — add the env (the script now reads it):

```yaml
    environment:
      DATABASE_URL: postgresql://erp:erp_local_dev@db:5432/erp
      BACKUP_DIR: /backups
```

**`app-practice` gets NEITHER** — add this comment there so nobody "fixes" the asymmetry:

```yaml
      # Phase 8C §6.3: NO BACKUP_DIR and NO ./backups mount, deliberately. The practice copy's data
      # is disposable (the reset re-seeds it) so it has no backup responsibility, and a trainer's
      # "Back up now" must never pollute production's archive list or staleness signal. The routes
      # also refuse it via assertNotPracticeDatabase — this is the belt to that pair of braces.
```

> **SELinux (Fedora):** if the app or backup container hits `permission denied` on `./backups`,
> append `:z` to the bind mount — CLAUDE.md's environment note. Do not disable SELinux.

- [ ] **Step 3: Teach the nightly script the status file**

Rewrite `erp/scripts/backup.sh`:

```sh
#!/bin/sh
# Nightly pg_dump; keeps 30 days of compressed backups.
# Dump to a temp file first and verify pg_dump's own exit status —
# piping straight into gzip would mask a failed dump as "complete".
#
# Phase 8C §6.4: also writes a tiny status file the app reads for its staleness indicator. The file
# carries the LAST RUN only — the app derives `lastSuccessAt` from the newest integrity-passing
# archive, which is precisely what lets this be a single overwrite with no JSON read-merge. Written
# temp-then-rename so a reader never sees a half-written file.
set -e
DIR="${BACKUP_DIR:-/backups}"
STATUS="$DIR/backup-status.json"

write_status() {   # $1 = true|false, $2 = error message (may be empty)
  tmp="$STATUS.$$.tmp"
  printf '{\n  "lastRunAt": "%s",\n  "ok": %s,\n  "source": "nightly",\n  "error": %s\n}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" \
    "$([ -n "$2" ] && printf '"%s"' "$(echo "$2" | tr -d '"\\')" || echo null)" > "$tmp"
  mv "$tmp" "$STATUS"
}

STAMP=$(date +%Y-%m-%d_%H%M%S)
TMP="$DIR/.erp_${STAMP}.sql.tmp"
if ! pg_dump "$DATABASE_URL" > "$TMP"; then
  rm -f "$TMP"
  write_status false "pg_dump error"
  echo "backup FAILED: pg_dump error" >&2
  exit 1
fi
# Fail loud on an empty dump: pg_dump can exit zero having written nothing, and an empty archive
# that looks like a backup is worse than no archive at all.
if [ ! -s "$TMP" ]; then
  rm -f "$TMP"
  write_status false "pg_dump produced an empty dump"
  echo "backup FAILED: empty dump" >&2
  exit 1
fi
gzip < "$TMP" > "$DIR/erp_${STAMP}.sql.gz"
rm -f "$TMP"
if ! gzip -t "$DIR/erp_${STAMP}.sql.gz"; then
  rm -f "$DIR/erp_${STAMP}.sql.gz"
  write_status false "the written archive failed its gzip integrity check"
  echo "backup FAILED: integrity check" >&2
  exit 1
fi
# Retention (a deploy value, not a setting). The pattern covers BOTH writers' archives — on-demand
# names also start `erp_` — which is the owner's one-retention-rule decision (§6.4).
find "$DIR" -name 'erp_*.sql.gz' -mtime +30 -delete
# Orphaned temps from a crashed dump would otherwise accumulate forever.
find "$DIR" -name '.erp_*.sql.tmp' -mtime +1 -delete
write_status true ""
echo "backup complete: erp_${STAMP}.sql.gz"
```

- [ ] **Step 4: Document the env**

Append to `erp/.env.example`:

```bash

# Phase 8C: the folder the nightly backup container writes to and the app lists / backs up into.
# A DEPLOY value shared by both writers, not a runtime setting. In docker compose this is the
# container path /backups (host side: the ./backups bind-mount). For a LOCAL dev run, point it at a
# real folder you have created — /backups does not exist on a dev host:
#   mkdir -p backups
BACKUP_DIR="./backups"
```

- [ ] **Step 5: Prove the image actually gets pg_dump**

```bash
cd erp && docker build --target run -t heatsynq-8c-check . \
  && docker run --rm heatsynq-8c-check pg_dump --version \
  && docker run --rm heatsynq-8c-check pg_restore --version
```

Expected: both print **18.x**. If the tag `postgresql18-client` is not found, the base image's Alpine
release has moved — check `docker run --rm node:26-alpine cat /etc/alpine-release` and pick the
client package whose major still matches `docker-compose.yml`'s `postgres:` tag. **Do not** silently
drop to an older major: pg_dump refuses a newer server.

- [ ] **Step 6: Prove the nightly script end to end**

```bash
cd erp && mkdir -p /tmp/8c-backups && docker compose up -d --wait db
docker run --rm --network host \
  -e DATABASE_URL="postgresql://erp:erp_local_dev@127.0.0.1:5432/erp" \
  -e BACKUP_DIR=/backups -v /tmp/8c-backups:/backups \
  -v "$PWD/scripts/backup.sh:/backup.sh:ro" postgres:18 sh /backup.sh
ls -la /tmp/8c-backups && cat /tmp/8c-backups/backup-status.json
gzip -t /tmp/8c-backups/erp_*.sql.gz && echo "integrity OK"
```

Expected: one `erp_<stamp>.sql.gz`, one `backup-status.json` reading `"ok": true`, no `.tmp` left,
and the integrity check passing. Then prove the failure path writes `"ok": false`:

```bash
docker run --rm --network host \
  -e DATABASE_URL="postgresql://erp:wrong@127.0.0.1:5432/erp" \
  -e BACKUP_DIR=/backups -v /tmp/8c-backups:/backups \
  -v "$PWD/scripts/backup.sh:/backup.sh:ro" postgres:18 sh /backup.sh || true
cat /tmp/8c-backups/backup-status.json
```

Expected: `"ok": false` with a non-null error, **and the previous good archive still present** — the
failure must not delete a working backup.

- [ ] **Step 7: Commit**

```bash
git add erp/Dockerfile erp/docker-compose.yml erp/scripts/backup.sh erp/.env.example
git commit -m "feat(backups): wire BACKUP_DIR through the image, compose and the nightly script"
```

---

### Task 9: Restore runbook, E2E flow, and the docs

**Files:**
- Create: `erp/e2e/flows/backups.mjs`
- Modify: `erp/e2e/run.mjs` (register the flow at the FLOWS tail)
- Modify: `erp/README.md` (the expanded restore runbook)
- Modify: `docs/HANDOFF.md` (§4 entry, §8 fresh-machine prerequisite, §9 next-track)
- Modify: `CLAUDE.md` (the standing-architecture paragraph)

**Interfaces:**
- Consumes: everything above.
- Produces: the `backups` E2E flow; the merged documentation state.

- [ ] **Step 1: Write the E2E flow**

Create `erp/e2e/flows/backups.mjs`. Read `e2e/flows/setup-checklist.mjs` and `e2e/flows/reports.mjs`
first and match their `run(page, shot, ctx)` signature and assertion style.

```js
// Flow: the Backups page (Phase 8C §6.2). Proves the red-when-empty indicator, the resolved folder,
// and — the headline control — that "Back up now" writes a real archive with a real pg_dump and
// flips the indicator green. The host's pg_dump is major-matched to the postgres:18 server
// (§6.4); vitest deliberately does NOT use it (CI's is older and pg_dump refuses a newer server),
// so this flow is the only place the real binary is exercised.
//
// Mutates only the backup folder, never shared DB fixtures — safe at the FLOWS tail.
import assert from "node:assert/strict";

export async function run(page, shot, ctx) {
  // --- 1. The page renders with the resolved folder and the archive table. ---
  await page.goto(`${ctx.baseURL}/admin/backups`);
  await page.getByRole("heading", { name: "Backups", exact: true }).waitFor({ state: "visible" });
  await page.getByText("Backup folder:", { exact: false }).waitFor({ state: "visible" });

  // --- 2. Back up now writes a real archive and the indicator turns green. ---
  const before = await page.locator("table tbody tr").count();
  await page.getByRole("button", { name: "Back up now" }).click();
  await page.getByText("Backups are up to date", { exact: false })
    .waitFor({ state: "visible", timeout: 60_000 });
  const after = await page.locator("table tbody tr").count();
  assert.ok(after > before || after >= 1, "an archive row appears after Back up now");
  await page.getByText("OK", { exact: true }).first().waitFor({ state: "visible" });
  await shot("backups-after-run");

  // --- 3. The staleness bar is gone once a fresh backup exists. ---
  await page.goto(`${ctx.baseURL}/customers`);
  assert.equal(
    await page.getByText("Open Backups", { exact: true }).count(), 0,
    "the shell staleness bar clears once a recent successful backup exists",
  );
}
```

Register it in `erp/e2e/run.mjs` at the tail of `FLOWS`:

```js
  { name: "backups", as: "admin", module: "./flows/backups.mjs" },
```

> **The harness needs `BACKUP_DIR` set for the dev server it spawns.** Check how `run.mjs` passes env
> to the dev server it starts and add `BACKUP_DIR` pointing at a folder the harness creates and
> **cleans up afterwards** (the harness's existing fixture-cleanup discipline — do not leave archives
> in `erp/backups` after the run).

- [ ] **Step 2: Write the restore runbook**

Replace the two-line `## Backups` section in `erp/README.md`:

````markdown
## Backups

The nightly `backup` container `pg_dump`s the production database into the shared backup folder and
keeps 30 days. The app mounts the **same** folder, so `/admin/backups` (which needs the
`manage_backups` action) lists the archives, shows the resolved folder, and can take an on-demand
backup. Both writers also maintain `backup-status.json`, which is what the staleness indicator reads.

- **Folder:** set by `BACKUP_DIR` (container `/backups`, host `./backups`). A deploy value shared by
  both writers — deliberately not a runtime setting, because the nightly container cannot honor a
  live change.
- **Staleness:** `backup_stale_hours` (Admin → Settings, default **36**). The indicator is green only
  when the newest integrity-passing archive is inside that window **and** the last recorded run did
  not fail **and** the status file is readable. **Anything else is red, including a missing status
  file** — if the backup container never started, that silence is the failure you need to see.
- **Practice copy:** has no backup folder, no Backups page, and its routes refuse. Its data is
  disposable; the reset re-seeds it.

### Restoring

Restore is a deliberate terminal command, never a button. **Read all four steps before starting.**

```bash
# 1. Pick the archive and verify it BEFORE you touch the live database.
ls -la erp/backups
gzip -t erp/backups/erp_2026-08-16_020000.sql.gz && echo "integrity OK"

# 2. Take a fresh dump of the CURRENT database first — restoring is destructive and this is your
#    only way back if the archive turns out to be the wrong one.
cd erp && docker compose exec -T db pg_dump -U erp -d erp | gzip > "before-restore-$(date +%s).sql.gz"

# 3. Stop the app so nothing writes mid-restore, then recreate the database empty.
docker compose --profile prod stop app
docker compose exec -T db psql -U erp -d postgres -c 'DROP DATABASE erp;'
docker compose exec -T db psql -U erp -d postgres -c 'CREATE DATABASE erp OWNER erp;'

# 4. Restore, then bring the app back (its start command runs `prisma migrate deploy`).
gunzip -c backups/erp_2026-08-16_020000.sql.gz | docker compose exec -T db psql -U erp -d erp
docker compose --profile prod start app
```

**Verify before you trust it:** sign in, open `/orders` and `/receivables`, and confirm the newest
order and the A/R total match what you expect from the archive's date. If the restore was wrong, the
step-2 dump is your way back.

**Keeping an archive longer than 30 days** — copy it out of the backup folder. Everything inside is
pruned at 30 days, on-demand archives included.
````

- [ ] **Step 3: Update `CLAUDE.md`**

Add one curated paragraph after the Phase 8B paragraph in the Architecture section (and **displace**
nothing else — the file's rule is that new guidance replaces what it supersedes, and this supersedes
nothing):

```markdown
**Backups bridge the app and the nightly container through one shared folder (Phase 8C).** `BACKUP_DIR`
(container `/backups`, host `./backups`) is a **deploy value read by both writers**, never a runtime
`Setting` — the nightly container cannot honor a live change. `src/server/backup-paths.ts` is a **pure
leaf** (no fs, no db) and the ONLY way a filename becomes a path: `archivePath` refuses any name failing
the strict archive regex, which is what makes escaping the folder impossible — the deploy-set directory
cannot be "confined to a root" because it *is* the root. `pg_dump` is spawned **via argv, never a shell
string**, dumped to a temp file and checked for a non-zero size before it is gzipped into place (an empty
archive is never written). **`lastSuccessAt` is DERIVED from the newest integrity-passing archive, not
stored** — the archive is the evidence — which is what lets `backup-status.json` be a single un-merged
overwrite that `sh` can write. The two writers **never share a filename** (`erp_<stamp>` vs
`erp_manual_<stamp>_<rand>`), so no cross-process lock exists or is needed; both match the script's one
`-mtime +30` prune. The indicator is green ONLY on a recent integrity-passing archive **and** a clean last
run **and** a readable status file — **absence is failure**, so a missing status file reads red. Backups
are **production-only**: `assertNotPracticeDatabase` (the `assertPracticeDatabase` mirror in
`practice-mode.ts`) refuses the routes, and compose denies `app-practice` both the env and the mount. The
suite must **never shell out to a host `pg_dump`** — CI's major is older than the server and pg_dump
refuses a newer server, so `runBackupNow` takes an injectable dump command (a parameter, not an env var).
```

- [ ] **Step 4: Update `docs/HANDOFF.md`**

Three edits, matching each section's existing format:
1. **§4** — the 8C paragraph: what it shipped, its gates, and the fact that Phase 8 (and the roadmap's
   build phases) is complete. Replace the "8C is the sole remaining sub-phase" framing.
2. **§8** — add `postgresql` (the client, for `pg_dump`) to the Fedora fresh-machine tooling line, noting
   it is needed by the E2E `backups` flow and the restore runbook, and that the major must match the
   `postgres:` image tag.
3. **§9** — rewrite the kickoff for the next track. Phase 8 is done; the open items are the parallel-run
   acceptance month, **#115 (P1)**, and the backlog burn-down. Remove 8C's three "must not rediscover"
   bullets, which are now spent.

- [ ] **Step 5: Run the FULL gate chain**

```bash
cd erp
npm test
npx tsc --noEmit
npx eslint src tests
npm run build
```

Then E2E **in the background** (it takes ~10 minutes — a foreground run risks being killed at the
tooling ceiling, which leaves `ClosePeriod` debris that reds three flows on the next run):

```bash
npm run test:e2e
```

Record each result in the ledger **after watching the run end** — or write PENDING. Never guess a row.

- [ ] **Step 6: Commit**

```bash
git add erp/e2e erp/README.md docs/HANDOFF.md CLAUDE.md docs/execution
git commit -m "docs(backups): add the restore runbook, the E2E flow and the Phase 8C close-out"
```

---

## After the last task

1. **Whole-branch review** on the strongest model, five lenses: correctness · concurrency ·
   data-integrity · security (the dump path, the path validation, the `manage_backups` gate) ·
   spec-compliance against §6 + §6.4. One fix wave.
2. **Triage rule:** from review round 6 onward, findings are filed as issues **unless** they are
   correctness, concurrency, or data-integrity defects.
3. **PR** with attribution in the **body** (never in the individual commits).
4. **Re-run the full gate chain** before any merge claim, and write the final gate row from a watched
   run.

## Self-Review

**Spec coverage** — every §6 requirement maps to a task:

| Spec requirement | Task |
|---|---|
| §6.1 shared folder, deploy-set, displayed not editable | 1, 5, 6, 8 |
| §6.1 app image gains `pg_dump`/`pg_restore` | 8 |
| §6.1 argv spawn, fail-loud temp-then-check, no empty archive | 4 |
| §6.1 collision-proof naming | 1, 4 |
| §6.1 path validation | 1 |
| §6.1 `gzip -t` integrity on every written archive | 3, 4 |
| §6.1 status file the app reads; nightly stays a container; retention stays the script's prune | 3, 8 |
| §6.2 page: list, folder, back-up-now, staleness indicator | 6 |
| §6.2 `manage_backups` gate | 2, 5 |
| §6.2 missing/unparseable status = red; never-run = red | 3 |
| §6.3 restore = documented command, expanded runbook | 9 |
| §6.3 production-only; practice has no page/route/folder | 3, 5, 8 |
| §7 `backup_stale_hours` in the typed registry | 2 |
| §8 client/server boundary; practice flag never in a client component | 6, 7 |
| §9 no migration | — (none added) |
| §10 8C test list (fail-loud, integrity, staleness incl. missing-status, argv/path/naming, gate, practice) | 1, 3, 4, 5 |
| §10 E2E flow | 9 |
| §6.4 green rule, derived `lastSuccessAt`, manual retention, shell bar, audit, injectable dump | 1, 3, 4, 7, 8 |
| §11 docs updated in the same breath | 9 |

**Placeholder scan:** no TBD/TODO; every code step carries real code. Three steps deliberately say
"read the neighbouring file and copy its helper verbatim" (test helpers in Tasks 2/4/5, the Shell nav
idiom in Task 6, the E2E env plumbing in Task 9) — these are instructions to verify a real name
against the tree rather than invent one, which is the opposite of a placeholder.

**Type consistency:** `ArchiveInfo`, `BackupHealth`, `BackupHealthState`, `BackupsView`,
`BackupStatusFile`, `BackupSource` are defined once in Task 1 and used unchanged in Tasks 3–7.
`evaluateHealth`/`listArchives`/`backupHealth`/`backupsView`/`runBackupNow`/`readStatus` keep the same
names and signatures from their defining task onward. `resolveBackupDir`/`archivePath`/`statusPath`/
`stampFor`/`manualArchiveName`/`tempNameFor` are Task 1's and are not renamed later.

**Known risk, flagged not hidden:** Task 8 Step 5 pins `postgresql18-client` against Alpine 3.24.1. If
the `node:26-alpine` base moves and drops that package, the build fails loudly at that step, with the
fallback written into the step. It must never be resolved by dropping to an older client major.
