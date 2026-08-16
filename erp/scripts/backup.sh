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
find "$DIR" -name 'erp_*.sql.gz' -mtime +30 -delete
# Codex re-review, PR #117 (finding #2): the restore runbook's pre-restore safety dump
# (`before-restore-<epoch>.sql.gz`, README.md's "Restoring" section) lands in this SAME folder but
# never matched the pattern above, so full production dumps piled up forever and the README's "copy
# it out if you want to keep it — everything in here is pruned at 30 days" claim was false for
# exactly the file holding a complete copy of the database. Same 30-day rule, same folder.
find "$DIR" -name 'before-restore-*.sql.gz' -mtime +30 -delete
# Orphaned temps from a crashed dump would otherwise accumulate forever.
find "$DIR" -name '.erp_*.sql.tmp' -mtime +1 -delete
write_status true ""
echo "backup complete: erp_${STAMP}.sql.gz"
