#!/bin/sh
# Nightly pg_dump; keeps 30 days of compressed backups.
set -e
STAMP=$(date +%Y-%m-%d_%H%M)
pg_dump "$DATABASE_URL" | gzip > "/backups/erp_${STAMP}.sql.gz"
find /backups -name 'erp_*.sql.gz' -mtime +30 -delete
echo "backup complete: erp_${STAMP}.sql.gz"
