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
# Issue #132: retention's outcome ALSO goes in a shell-only sidecar, because the main status file
# cannot hold it — the app's manual "Back up now" overwrites $STATUS whole (no read-merge, by
# design), so a green manual run ERASED a standing retention failure and the light went green while
# old dumps kept accumulating. Nothing but this script ever writes the sidecar, and this script
# re-attempts retention every night, so the sidecar is always the nightly's own latest verdict.
RETENTION_STATUS="$DIR/retention-status.json"

write_status() {   # $1 = true|false, $2 = error message (may be empty)
  tmp="$STATUS.$$.tmp"
  # Sanitize before the emptiness check, not after: JSON strings can't carry a raw newline/CR/tab
  # (they must be escaped), so a dynamic message with one of those would otherwise write a status
  # file the app's parseStatus rejects as unparseable — which reads as "no readable status file"
  # (red) instead of the real failure reason. `printf '%s'` (not `echo`) avoids shell-dependent
  # backslash-escape interpretation in $2; the trailing `tr` folds newline/CR/tab to spaces so the
  # quoted value always stays on one line. Still lossy (quotes/backslashes are dropped, not
  # escaped) — acceptable for a one-line status summary, not acceptable if this ever needs to
  # round-trip an exact message.
  msg=$(printf '%s' "$2" | tr -d '"\\' | tr '\n\r\t' '   ')
  printf '{\n  "lastRunAt": "%s",\n  "ok": %s,\n  "source": "nightly",\n  "error": %s\n}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" \
    "$([ -n "$msg" ] && printf '"%s"' "$msg" || echo null)" > "$tmp"
  mv "$tmp" "$STATUS"
}

write_retention_status() {   # $1 = true|false, $2 = error message (may be empty)
  # Same sanitization and temp-then-rename as write_status, for the same reasons.
  tmp="$RETENTION_STATUS.$$.tmp"
  msg=$(printf '%s' "$2" | tr -d '"\\' | tr '\n\r\t' '   ')
  printf '{\n  "lastRunAt": "%s",\n  "ok": %s,\n  "error": %s\n}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" \
    "$([ -n "$msg" ] && printf '"%s"' "$msg" || echo null)" > "$tmp"
  mv "$tmp" "$RETENTION_STATUS"
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
if ! gzip < "$TMP" > "$DIR/erp_${STAMP}.sql.gz"; then
  rm -f "$TMP" "$DIR/erp_${STAMP}.sql.gz"
  write_status false "could not compress the dump"
  echo "backup FAILED: compress error" >&2
  exit 1
fi
rm -f "$TMP"
if ! gzip -t "$DIR/erp_${STAMP}.sql.gz"; then
  rm -f "$DIR/erp_${STAMP}.sql.gz"
  write_status false "the written archive failed its gzip integrity check"
  echo "backup FAILED: integrity check" >&2
  exit 1
fi
# Retention (a deploy value, not a setting). The pattern covers BOTH writers' archives — on-demand
# names also start `erp_` — which is the owner's one-retention-rule decision (§6.4).
#
# Issue #120: each prune is guarded and its failure RECORDED, never allowed to abort the script.
# These run AFTER the archive is written and verified, so under a bare `set -e` a failing `find` (a
# read-only folder, an NFS hiccup, a permission change on one old file) exited before
# `write_status true` — leaving the PREVIOUS run's `{"ok":true}` in place beside a fresh intact
# archive. The UI then read GREEN while retention was silently broken and old dumps accumulated
# toward a full disk; "retention broken" was not a state the light could express. It is now the
# ordinary red `ok:false` path, with a message that says the DUMP succeeded so nobody hunts a
# nonexistent dump problem.
RETENTION_ERR=""
prune() {   # $1 = name pattern, $2 = -mtime spec
  find "$DIR" -name "$1" -mtime "$2" -delete || RETENTION_ERR="${RETENTION_ERR}${RETENTION_ERR:+, }$1"
}
prune 'erp_*.sql.gz' +30
# Codex re-review, PR #117 (finding #2): the restore runbook's pre-restore safety dump
# (`before-restore-<epoch>.sql.gz`, README.md's "Restoring" section) lands in this SAME folder but
# never matched the pattern above, so full production dumps piled up forever and the README's "copy
# it out if you want to keep it — everything in here is pruned at 30 days" claim was false for
# exactly the file holding a complete copy of the database. Same 30-day rule, same folder.
prune 'before-restore-*.sql.gz' +30
# Orphaned temps from a crashed dump would otherwise accumulate forever.
prune '.erp_*.sql.tmp' +1

# The sidecar is written FIRST in both branches, deliberately: under `set -e` a failing sidecar
# write then aborts before the main status can go green, which fails toward red — the reverse order
# could leave a fresh green main status behind a run that exited non-zero. Main-status behavior and
# exit codes are otherwise exactly the #120 shape: the sidecar is additional evidence, not a
# replacement.
if [ -n "$RETENTION_ERR" ]; then
  # The archive is KEPT: a retention failure is no reason to throw away a good backup, which is
  # precisely why this reports rather than aborting earlier.
  write_retention_status false "retention cleanup failed for: $RETENTION_ERR"
  write_status false "the dump succeeded but retention cleanup failed for: $RETENTION_ERR"
  echo "backup wrote erp_${STAMP}.sql.gz but retention FAILED for: $RETENTION_ERR" >&2
  exit 1
fi
write_retention_status true ""
write_status true ""
echo "backup complete: erp_${STAMP}.sql.gz"
