import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKUP_STATUS_FILENAME } from "@/lib/backup-constants";

/**
 * Phase 8C Task 8 review, finding #1 — scripts/backup.sh's compress step was unguarded:
 *
 *   gzip < "$TMP" > "$DIR/erp_${STAMP}.sql.gz"
 *
 * ran with no `if ! ...; then` around it, so under `set -e` a failing `gzip` (the reviewer's
 * repro: a stub exiting non-zero with "No space left on device") aborted the script BEFORE
 * `write_status` ran at all — leaving the PREVIOUS night's `{"ok":true}` in the status file while
 * a truncated `.sql.gz` and an orphaned `.sql.tmp` were left behind. `evaluateHealth` then reads
 * green until `backup_stale_hours` elapses, inverting §6.2's "absence is failure" for precisely
 * the archetypal failure (a full disk).
 *
 * This drives the REAL scripts/backup.sh as a child process — not a paraphrase of its guard
 * structure — with PATH doctored so `pg_dump` resolves to the existing fake-pg-dump.sh test
 * double (tests/backup-run.test.ts's precedent: vitest must never shell out to a REAL pg_dump,
 * since CI's host major can be older than the postgres:18 server, which pg_dump hard-refuses) and
 * `gzip` resolves to a stub that always fails, reproducing the reviewer's repro exactly. The
 * control test at the end (no gzip override) exercises the real system `gzip`, the same way
 * backups.ts's own tests already rely on a real `gzip -t` rather than stubbing it.
 */

const SCRIPT = path.join(process.cwd(), "scripts/backup.sh");
const FAKE_PG_DUMP = path.join(process.cwd(), "tests/fixtures/fake-pg-dump.sh");

let dir: string;
let binDir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "backup-script-dir-"));
  binDir = mkdtempSync(path.join(tmpdir(), "backup-script-bin-"));
  // pg_dump -> the repo's existing fake, left in its default "ok" mode (a plausible non-empty
  // dump on stdout, exit 0) — this suite is only exercising the COMPRESS step, not the dump step.
  writeFileSync(path.join(binDir, "pg_dump"), readFileSync(FAKE_PG_DUMP));
  chmodSync(path.join(binDir, "pg_dump"), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

/** Installs a `gzip` on the doctored PATH that always fails without producing real output —
 *  the reviewer's ENOSPC repro, generalized to any compress-time failure. */
function installFailingGzip(): void {
  writeFileSync(
    path.join(binDir, "gzip"),
    '#!/bin/sh\necho "gzip: error: No space left on device" >&2\nexit 1\n',
  );
  chmodSync(path.join(binDir, "gzip"), 0o755);
}

function runScript(): ReturnType<typeof spawnSync> {
  return spawnSync("sh", [SCRIPT], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      BACKUP_DIR: dir,
      DATABASE_URL: "postgresql://fake/fake", // ignored by the fake pg_dump
    },
    encoding: "utf8",
  });
}

function statusOf(d: string): { ok: boolean; error: string | null } {
  return JSON.parse(readFileSync(path.join(d, BACKUP_STATUS_FILENAME), "utf8"));
}

describe("scripts/backup.sh — compress-step failure (Task 8 review finding #1)", () => {
  it("a failing gzip is caught: script exits non-zero, status flips to ok:false, no leftover .tmp or truncated .gz", () => {
    installFailingGzip();
    const result = runScript();
    expect(result.status).not.toBe(0);

    const status = statusOf(dir);
    expect(status.ok).toBe(false);
    expect(status.error).toBeTruthy();
    expect(status.error?.toLowerCase()).toContain("compress");

    const files = readdirSync(dir);
    expect(files.some((f) => f.endsWith(".sql.tmp"))).toBe(false); // the fix's `rm -f "$TMP" ...`
    expect(files.some((f) => f.endsWith(".sql.gz"))).toBe(false); // the fix's `rm -f ... "$DIR/erp_...gz"`
  });

  it("a pre-existing good archive survives a failed gzip run, byte-for-byte, and is the only archive left", () => {
    const goodArchive = "erp_2020-01-01_000000.sql.gz";
    writeFileSync(path.join(dir, goodArchive), "not a real gzip, just proving survival");
    installFailingGzip();

    const result = runScript();
    expect(result.status).not.toBe(0);
    expect(readFileSync(path.join(dir, goodArchive), "utf8")).toBe(
      "not a real gzip, just proving survival",
    );
    const archives = readdirSync(dir).filter((f) => f.endsWith(".sql.gz"));
    expect(archives).toEqual([goodArchive]); // the failed run's own truncated archive is gone
  });

  it("control: with a working gzip on PATH the same invocation still succeeds end to end", () => {
    // No gzip override — PATH falls through to the real system gzip, proving the guard itself
    // (not some PATH-doctoring artifact) is what makes the failure tests above fail closed.
    const result = runScript();
    expect(result.status).toBe(0);
    const status = statusOf(dir);
    expect(status.ok).toBe(true);
    expect(status.error).toBeNull();
    expect(readdirSync(dir).filter((f) => f.endsWith(".sql.gz"))).toHaveLength(1);
    expect(readdirSync(dir).some((f) => f.endsWith(".sql.tmp"))).toBe(false);
  });
});

/**
 * Issue #120 — a failing retention `find` left the status GREEN.
 *
 * The three `find … -delete` calls run under `set -e`, AFTER the archive is written and verified
 * but BEFORE `write_status true`. So a cleanup failure (a read-only folder, an NFS hiccup, a
 * permission change on an old file) aborted the script with the PREVIOUS run's `{"ok":true}` still
 * in the status file and a fresh intact archive on disk — the UI reads green while retention is
 * silently broken and old dumps accumulate toward a full disk. "Retention broken" was not a state
 * the light could express.
 *
 * It now writes `ok:false` naming the pattern that failed. The dump itself SUCCEEDED, so the
 * message says so — "The last backup run failed: …" over a message about retention would otherwise
 * send someone hunting a dump problem that does not exist.
 */
describe("scripts/backup.sh — retention failure (#120)", () => {
  /** A `find` on the doctored PATH that fails only for `-delete` runs, leaving the archive-writing
   *  steps (which do not shell out to find) untouched. */
  function installFailingFind(): void {
    writeFileSync(
      path.join(binDir, "find"),
      '#!/bin/sh\necho "find: cannot delete: Read-only file system" >&2\nexit 1\n',
    );
    chmodSync(path.join(binDir, "find"), 0o755);
  }

  it("writes ok:false naming retention when a prune fails, instead of leaving the previous green", () => {
    // Seed the previous night's success — the exact state that made this invisible.
    writeFileSync(
      path.join(dir, BACKUP_STATUS_FILENAME),
      JSON.stringify({ lastRunAt: "2026-08-15T02:00:00Z", ok: true, source: "nightly", error: null }),
    );
    installFailingFind();

    const result = runScript();
    expect(result.status).not.toBe(0);

    const status = statusOf(dir);
    expect(status.ok).toBe(false);
    expect(status.error?.toLowerCase()).toContain("retention");
    // The dump is not what failed, and the message must not imply it did.
    expect(status.error?.toLowerCase()).toContain("dump succeeded");

    // ...and the archive it just wrote is KEPT — a retention failure is not a reason to throw away
    // a good backup, which is the whole point of reporting it rather than aborting earlier.
    expect(readdirSync(dir).filter((f) => f.endsWith(".sql.gz"))).toHaveLength(1);
  });

  it("control: with a working find the run still ends green", () => {
    const result = runScript();
    expect(result.status).toBe(0);
    expect(statusOf(dir).ok).toBe(true);
    expect(statusOf(dir).error).toBeNull();
  });
});

// P1 (whole-branch review, Minor) — the status filename is duplicated with nothing enforcing
// agreement: scripts/backup.sh hardcodes it (a shell file has no way to import a TS constant),
// BACKUP_STATUS_FILENAME is what both TS readers use, and this test file used to hardcode a THIRD
// copy in `statusOf` (now fixed to import the constant above). A silent rename on either side
// would make the app read "no status file" forever — the safe direction (red, never a false
// green), but a real drift bug this repo had no test to catch. This is that test.
describe("scripts/backup.sh — status filename drift guard (P1)", () => {
  it("backup.sh's hardcoded status filename literal matches BACKUP_STATUS_FILENAME", () => {
    const scriptText = readFileSync(SCRIPT, "utf8");
    expect(scriptText).toContain(`STATUS="$DIR/${BACKUP_STATUS_FILENAME}"`);
  });
});
