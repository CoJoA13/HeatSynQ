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
