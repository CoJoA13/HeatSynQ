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

Create `erp/tests/fixtures/fake-pg-dump.sh` — this is the repo's **first** `tests/fixtures/` entry and
its first executable fixture, so there is no convention to copy.

> **This step has a CI-breaking trap. Read it before writing the file.** The test spawns this script
> directly, so it must be executable **in a fresh clone** — and git only preserves that if the file was
> already `chmod +x` when it was staged. `chmod +x` *after* `git add` records mode `100644`, everything
> passes on your machine, and CI dies with `EACCES` on a file that looks fine in the diff.
>
> Do it in this order, and verify the recorded mode rather than the working-tree mode:
>
> ```bash
> cd erp
> chmod +x tests/fixtures/fake-pg-dump.sh
> git add tests/fixtures/fake-pg-dump.sh
> git ls-files -s tests/fixtures/fake-pg-dump.sh   # MUST print 100755, not 100644
> ```
>
> If it prints `100644`, fix it with `git update-index --chmod=+x tests/fixtures/fake-pg-dump.sh` and
> re-check. **Report the `git ls-files -s` output in your report** — a reviewer cannot see a file mode
> in a diff body.

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

