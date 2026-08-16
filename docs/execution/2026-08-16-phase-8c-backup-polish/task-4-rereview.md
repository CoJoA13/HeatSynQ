# Task 4 — scoped re-review of the fix round (4fab46b..1bb5fcb)

## Finding verdicts

**#1 (Important) child never killed / no `child.stdout` error listener — ADDRESSED.**
`erp/src/server/backups.ts:279-285` — `settleError` now sets `settled`, clears the timer, calls
`child.kill()`, then rejects. `erp/src/server/backups.ts:290-292` funnels all three error sources
(`child`, `child.stdout`, `out`) through it, so the previously-unhandled source-side error is now a
rejection instead of an uncaught exception. Verified the pre-fix RED is real rather than asserted: a
standalone repro of the pre-fix shape (ENOTDIR destination, no kill) had the fixture record its pid
0ms after the settle and keep running — `waitForProcessExit` would have failed.

**#2 (Minor) no dump timeout — ADDRESSED.**
`erp/src/server/backups.ts:203` (`DEFAULT_DUMP_TIMEOUT_MS = 30 * 60_000`), `:251` (`opts.timeoutMs`
override), `:296-300` (the `setTimeout` calling `settleError`). 30 min is a sane ceiling for a
same-host dump of this working set — it bounds a wedged dump, not a large one.

**#3 (Minor) success path guarded nothing — ADDRESSED.**
`erp/src/server/backups.ts:352-355` — both bookkeeping writes are `.catch(() => {})` and the real
`ArchiveInfo` is returned unconditionally. The claimed direction of the tradeoff is true of the
code: `evaluateHealth` tests `!i.status.ok` at `erp/src/server/backups.ts:62`, *before* any
archive-freshness branch, so a stale `ok:false` keeps health red despite a fresh good archive —
under-reporting, never over-reporting. And a genuinely failed run can never report success:
`fail()` still throws unconditionally at `erp/src/server/backups.ts:246`, regardless of whether its
own best-effort status/audit writes landed.

## Concurrency checks on the fix itself (the fix is the risk)

- **Exactly-once settlement holds.** `settled` is set as the first statement of both entry points
  (`erp/src/server/backups.ts:280-281`, `:303-304`), and it is the only gate. The post-kill `"close"`
  event (`:309`) re-enters `maybeSettle`, which returns early — no double-settle, no resolve-then-reject.
- **No TDZ on `clearTimeout(timer)`** (`erp/src/server/backups.ts:282`, `timer` declared at `:296`).
  Confirmed empirically rather than assumed: a probe spawning a nonexistent binary and opening a
  write stream under a non-directory shows both `child "error"` (ENOENT) and `out "error"` (ENOTDIR)
  emit *after* the synchronous executor body completes, so `timer` is always assigned by then. The
  timer callback trivially post-dates its own assignment.
- **Timer cleared on every settle path** — `:282` (error) and `:305` (success/non-zero exit). Those
  two functions are the only places `resolve`/`reject` are called, so no path leaves a live
  30-minute timer holding the event loop open.
- **`child.kill()` never runs on the success path.** `maybeSettle` (`:302-308`) does not kill, and it
  only resolves once `closed && finished` with `closeCode === 0` — i.e. the child has already exited.
  A slow-but-healthy dump is untouched until the 30-minute ceiling.

## New breakage introduced by the fix diff

None Critical or Important.

**Minor 1 — finding #1's test passes today via its no-assertion branch.**
`erp/tests/backup-run.test.ts:312-320`. The test measures 571ms in every run I made (3 runs, 15/15
green each, pristine output), which is the 500ms `waitForPid` budget plus overhead — i.e. the pid
file is never written here, so `waitForProcessExit` never executes and nothing about the child is
asserted. It is *not* vacuous as a regression guard (my standalone repro above shows the unfixed
shape always records the pid, so the unfixed code reliably reddens it), but today's GREEN is
absence-of-evidence rather than proof of death. Finding #2's test
(`erp/tests/backup-run.test.ts:332-333`) does assert the kill unconditionally and is the real proof.

**Minor 2 — `child.kill()` is SIGTERM only** (`erp/src/server/backups.ts:283`), with no SIGKILL
escalation. `pg_dump` honours SIGTERM, and the fixture `exec`s into `sleep` for exactly that reason
(`erp/tests/fixtures/fake-pg-dump.sh:19-21`), so this is fine in practice; a child that ignored
SIGTERM would still linger and the promise would already have rejected.

Checked for leaked fixture processes after the runs: none (`pgrep -f "sleep 3600"` → 0).

## Deferred (out of scope for this loop)

- `timeoutMs` is now part of `runBackupNow`'s public options. Grep shows no call site outside
  `erp/src/server/backups.ts` yet, so it is not HTTP-reachable in this branch — the route task must
  not forward request-controlled opts into it.
- `fail()`'s own status/audit writes (`erp/src/server/backups.ts:242-245`) remain best-effort
  `.catch(() => {})` — pre-existing, untouched by this diff.

## Overall verdict

All three findings are genuinely fixed with no new concurrency defect; approved.
