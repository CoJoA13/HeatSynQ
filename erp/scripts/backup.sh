#!/bin/sh
# Nightly pg_dump; keeps 30 days of compressed backups.
# Dump to a temp file first and verify pg_dump's own exit status —
# piping straight into gzip would mask a failed dump as "complete".
set -e
STAMP=$(date +%Y-%m-%d_%H%M%S)
TMP="/backups/.erp_${STAMP}.sql.tmp"
if ! pg_dump "$DATABASE_URL" > "$TMP"; then
  rm -f "$TMP"
  echo "backup FAILED: pg_dump error" >&2
  exit 1
fi
gzip < "$TMP" > "/backups/erp_${STAMP}.sql.gz"
rm -f "$TMP"
find /backups -name 'erp_*.sql.gz' -mtime +30 -delete
echo "backup complete: erp_${STAMP}.sql.gz"
