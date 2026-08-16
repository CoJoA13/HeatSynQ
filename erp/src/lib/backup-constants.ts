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
