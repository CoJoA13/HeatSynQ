#!/bin/sh
# Test double for pg_dump (Phase 8C §6.4). vitest MUST NOT shell out to a host pg_dump: CI runs
# ubuntu-latest, whose bundled pg_dump is an older major than the postgres:18 server, and pg_dump
# hard-refuses a newer server. This double lets the tests exercise the REAL machinery — argv spawn,
# temp-then-verify, the fail-loud empty check, gzip, integrity check, naming, status write.
#
#   FAKE_DUMP_MODE=ok     (default) emit a plausible dump on stdout
#   FAKE_DUMP_MODE=fail   exit non-zero, having written nothing
#   FAKE_DUMP_MODE=empty  exit ZERO but emit nothing — the silent-corruption case
#   FAKE_DUMP_MODE=hang   emit output, then block indefinitely — a stalled/wedged pg_dump (review
#                         round 2, findings #1/#2). If FAKE_PID_FILE is set, writes its own pid
#                         there first (a plain `echo`, the very first thing this process does, no
#                         further fork) so a test can later prove that pid is truly gone rather
#                         than merely that a promise settled. `exec`s into `sleep` — which keeps
#                         the SAME pid (exec preserves it) and dies immediately on SIGTERM (its
#                         default disposition) — instead of leaving `sleep` as a separate forked
#                         child, which some shells could orphan out from under a killed parent.
case "${FAKE_DUMP_MODE:-ok}" in
  fail)  echo "pg_dump: error: connection failed" >&2; exit 1 ;;
  empty) exit 0 ;;
  hang)  [ -n "$FAKE_PID_FILE" ] && echo $$ > "$FAKE_PID_FILE"
         echo "-- fake dump of $1"
         exec sleep 3600 ;;
  *)     echo "-- fake dump of $1"; echo "CREATE TABLE t (id int);" ;;
esac
