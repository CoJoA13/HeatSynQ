# Task 4 report — `runBackupNow`, the fail-loud on-demand dump

## What was implemented

Followed the brief's steps in order:

1. **`erp/tests/fixtures/fake-pg-dump.sh`** — created, `chmod +x`'d, `git add`'d, and mode-verified
   *before* writing any other code, per the brief's CI-breaking-trap warning. Content matches the
   brief verbatim (`ok` / `fail` / `empty` modes via `FAKE_DUMP_MODE`).
2. **`erp/tests/backup-run.test.ts`** — the brief's test body verbatim, plus two additional tests
   (see "Also worth adding" below), and one one-line fix for a lint warning (see Deviations).
3. **`auditBackupRun`** added to `erp/src/server/audit.ts`, directly below `auditSettingChange` —
   verbatim from the brief. Direct `prisma.auditLog.create` write, same sanctioned-exception shape
   as `auditSettingChange`, so `audit.ts` stays the sole caller (`tests/permissions-sweep.test.ts`
   asserts this).
4. **`runBackupNow` / `doBackup`** appended to `erp/src/server/backups.ts` — brief's shape verbatim
   (single-flight guard, `assertNotPracticeDatabase()` first, argv-only `spawn`, temp-then-verify,
   fail-loud-on-empty, gzip-then-integrity-check, atomic status write, audit on both success and
   failure) with one correctness fix inside the dump step (see Deviations). Imports were merged
   into single `node:fs/promises` / `node:fs` / `node:child_process` statements rather than two
   separate import lines per module (cleanliness only, no behavior change), and the brief's own
   flagged-unused `open`/`FS`-then-drop note resolved to keeping `FS` (used by `access(dir,
   FS.W_OK)`) and dropping `open` (never used).

## Deviations from the brief, and why

**1. Fixed a genuine hang in the brief's spawn/pipe example code.** The brief's `close`-handler
shape —

```ts
child.on("close", (code) => {
  out.end();
  out.on("finish", () => (code === 0 ? resolve() : reject(...)));
  out.on("error", reject);
});
```

— has a real race: `child.stdout.pipe(out)` already calls `out.end()` on its own the moment
`stdout` hits EOF (pipe's default `{ end: true }`), which can complete — and fire `out`'s
`"finish"` event — *before* the child's own `"close"` event fires. When that ordering happens, the
`"finish"` listener above is registered inside the `close` handler *after* `finish` already fired,
so it is silently missed and the wrapping promise never settles. I reproduced this directly (a
standalone Node script using the brief's exact logic against the real fixture script hung
indefinitely — `"close"` fired at ~4ms but `"finish"` never printed), and every test that exercised
`runBackupNow` timed out at 5000ms as a result before the fix.

The fix tracks both signals (`closed`/`finished`) independently with flags and settles once *both*
have arrived, regardless of order — listeners are attached before either event can fire, so neither
can be missed:

```ts
let closeCode: number | null = null;
let closed = false;
let finished = false;
let settled = false;
const maybeSettle = () => {
  if (settled || !closed || !finished) return;
  settled = true;
  if (closeCode === 0) resolve();
  else reject(new Error(stderr.trim() || `exit ${closeCode}`));
};
const settleError = (err: Error) => { if (!settled) { settled = true; reject(err); } };

child.on("error", settleError);
child.on("close", (code) => { closeCode = code; closed = true; maybeSettle(); });
out.on("finish", () => { finished = true; maybeSettle(); });
out.on("error", settleError);
```

This is a correctness fix to the exact code I was asked to write, not "unrelated code" in the
CLAUDE.md tsc-caveat sense — it is Step 5 of this same task, and without it every test in
`backup-run.test.ts` that actually spawns the fixture hangs and times out.

**2. Dropped an unused `const info =` in one brief-provided test.** The "records a clean status
file on success" test assigns `const info = await run();` but never reads `info` (only `status` is
asserted). ESLint's `@typescript-eslint/no-unused-vars` flagged this as a warning (exit code 0, but
not "all clean" per Step 7's stated expectation), so I changed it to `await run();`. No other change
to that test.

**3. "Also worth adding" — put the two Minor-gap tests in `tests/backup-run.test.ts`, not
`backup-health.test.ts`.** Chose `backup-run.test.ts` because it already has a live filesystem
fixture (a real temp `dir`) and imports `listArchives` for its own assertions, so the zero-byte-file
and directory-named-like-an-archive cases slot in as two more `it()`s against the same fixture with
no new imports or setup — `backup-health.test.ts`'s `describe("listArchives", …)` block would have
needed to duplicate that setup. Both new tests pass.

## Step 1 verification — `git ls-files -s`

Run immediately after `chmod +x` and `git add`, before writing any other file:

```
$ cd erp && chmod +x tests/fixtures/fake-pg-dump.sh && git add tests/fixtures/fake-pg-dump.sh && git ls-files -s tests/fixtures/fake-pg-dump.sh
100755 51db6f8e86708229a525a413c3bb6f7e7342d1f4 0	tests/fixtures/fake-pg-dump.sh
```

Re-verified immediately before the commit (same result):

```
$ git ls-files -s tests/fixtures/fake-pg-dump.sh
100755 51db6f8e86708229a525a413c3bb6f7e7342d1f4 0	tests/fixtures/fake-pg-dump.sh
```

And the commit itself recorded the correct mode:

```
$ git commit -m "feat(backups): add the fail-loud on-demand pg_dump"
[phase-8c-backup-polish 4fab46b] feat(backups): add the fail-loud on-demand pg_dump
 4 files changed, 301 insertions(+), 3 deletions(-)
 create mode 100644 erp/tests/backup-run.test.ts
 create mode 100755 erp/tests/fixtures/fake-pg-dump.sh
```

## Step 3 — confirmed the test failed first (before Step 4/5)

```
$ npx vitest run tests/backup-run.test.ts
...
 FAIL  tests/backup-run.test.ts > runBackupNow > ...
TypeError: (0 , runBackupNow) is not a function
...
 Test Files  1 failed (1)
      Tests  10 failed | 2 passed (12)
```

(The 2 passing were the two Minor-gap tests I added, which only exercise `listArchives` and don't
need `runBackupNow`.)

## Step 6/7 — final gate run (the exact command requested)

```
$ cd erp && npx vitest run tests/backup-run.test.ts tests/backup-health.test.ts tests/permissions-sweep.test.ts && npx tsc --noEmit && npx eslint src tests
```

Real output:

```
 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp

 ✓ tests/backup-run.test.ts (12 tests) 806ms
 ✓ tests/backup-health.test.ts (17 tests) 285ms
 ✓ tests/permissions-sweep.test.ts (6 tests) 16ms

 Test Files  3 passed (3)
      Tests  35 passed (35)
   Start at  01:36:35
   Duration  1.70s (transform 136ms, setup 13ms, collect 340ms, tests 1.11s, environment 0ms, prepare 68ms)
```

`npx tsc --noEmit` — no output (clean, exit 0).

`npx eslint src tests` — no output (clean, exit 0; the one `no-unused-vars` warning from Deviation 2
is gone after that fix).

`permissions-sweep.test.ts`'s "only src/server/audit.ts calls prisma.auditLog.create" case passed,
confirming `auditBackupRun`'s write landed in the right file.

I additionally ran the full `npm test` suite as an extra regression check, since this task edits
`audit.ts`, a module nearly every other service test depends on transitively. It completed clean:

```
 Test Files  175 passed (175)
      Tests  2946 passed (2946)
   Start at  01:37:43
   Duration  372.14s (...)
[exited with code 0]
```

## Commit

`4fab46b905562efe96bcb26dee3a068cfa4e6e26` — `feat(backups): add the fail-loud on-demand pg_dump`

## Reasoning: windows where a failure could leave a partial or misleading archive on disk

The design already closes the two windows called out explicitly in the brief (never an empty
archive; never a shell string), and the temp-dotfile naming (`tempNameFor`, a `.`-prefixed name that
`isArchiveName` never matches) means a leftover *temp* file can never be listed or mistaken for a
backup, even if cleanup fails. Three narrower windows remain, all rooted in the same cause: the
Node process itself being killed (not a *handled* error, an actual `kill -9`/OOM/host crash) between
two of `doBackup`'s awaits, which no in-process error handling can close.

1. **Between `pipeline(...)` finishing the gzip write to `finalPath` and the `integrityOk`
   check/`writeStatus`/`auditBackupRun` calls that follow it (lines ~281–295).** If the process dies
   in this window, `finalPath` is a real, complete, valid archive (the `pipeline` promise already
   resolved, meaning the writable stream's `finish` event fired and its fd was closed), but no
   status file or audit row was ever written for the run. This is *not* misleading to an operator:
   `backupHealth`/`newestIntactAt` derive success from the newest **integrity-passing archive on
   disk**, not from the status file (the file header's own stated "load-bearing idea"), so the next
   health check still reads green off this exact file. The only real gap is the audit trail: this
   one successful run would have no matching "who ran it" row, even though the archive itself is
   sitting there as evidence. Narrow window (a handful of `fs` syscalls), but a genuine one.

2. **Mid-`pipeline`, after `createWriteStream(finalPath)` has started writing but before it
   finishes.** A crash here leaves a **partially-written, corrupt file at the archive's real final
   name** (not a temp name — `pipeline` writes directly to `finalPath`, there is no gzip-then-rename
   step). This file *is* visible to `listArchives` (it matches `MANUAL_ARCHIVE_RE`), but is reported
   `integrityOk: false` — `gzip -t` reliably rejects a truncated gzip stream (missing trailer/CRC),
   so it cannot masquerade as a successful backup or get picked up by `newestIntactAt`. It is real
   debris, though: nothing ever cleans it up (the random-suffix naming that makes collisions
   impossible also means nothing will ever overwrite it), and an operator scanning the raw folder by
   eye — rather than through the health banner or archive list's integrity column — could
   momentarily read its *presence* as "a backup exists" before checking the flag. This is the
   closest thing to a real "misleading archive" risk in the whole design, and it is inherent to
   writing gzip output directly to the final path rather than to a second temp file that gets
   renamed only after `integrityOk` passes — a hardening a future task could consider, at the cost
   of a second temp file and rename.

3. **Inside the `fail()` cleanup path itself**, between its own `unlink`/`writeStatus`/
   `auditBackupRun` calls. All three are `.catch(() => {})`-guarded so a failure in one doesn't stop
   the others from being attempted, but a process kill between them can still leave a subset applied
   — e.g. `finalPath` unlinked but the failure status/audit never written. The residual risk here is
   strictly *less* than a missing report of failure (worst case: a failed run leaves no status/audit
   trace at all, which reads the same as case 1's gap — silence, not a false "ok"), never a false
   positive, because `evaluateHealth` already treats a missing/stale status file as `unknown`/`stale`
   (red), not `ok`.

In short: the design's own "the archive is the evidence" principle means a process crash can produce
either (a) a real archive with a missing audit trail — invisible as a gap, not misleading — or (b) a
visibly-corrupt archive correctly flagged `integrityOk: false` — debris, not a false success. Neither
case can make `backupHealth` report green when the last real event was a failure or when no
integrity-passing archive exists; the one soft spot is (b)'s debris being eyeball-confusable if an
operator looks at the raw folder instead of the health/list UI, which application code inside
`runBackupNow` cannot fully close without a second temp-then-rename hop around the gzip step itself.

---

## Addendum — review round 2 fixes (findings #1, #2, #4)

The independent review confirmed the round-1 stream-race diagnosis (reproduced both halves: the
brief's shape logs `writableFinished = true` at 4ms and never settles; the replacement settles
exactly once on all five paths; a 40MB dump proves nothing settles before flush) and raised three
new findings in the same function region. All three are fixed in commit `1bb5fcb`. #3/#5/#6/#7/#8/#9
are deferred to the whole-branch review per the coordinator's explicit instruction and are
untouched here.

### Finding #1 (Important, REQUIRED) — the child was never killed; `child.stdout` had no `error` listener

**What changed** (`src/server/backups.ts`, inside `doBackup`'s dump-step Promise): `settleError` —
the one function every error path now funnels through (`child.on("error")`, the new
`child.stdout.on("error")`, `out.on("error")`, and the finding-#2 timeout below) — now calls
`child.kill()` before rejecting. `child.stdout.on("error", settleError)` is new; previously
`child.stdout` had zero `"error"` listeners, so a source-side stream error would have been an
uncaught exception (`pipe()` only attaches error handling to the destination, never the source).
`child.kill()` on an already-dead or never-spawned child is a documented no-op, so calling it
unconditionally from every error branch is safe.

**Test**: `tests/backup-run.test.ts` → `"kills the still-running child when the destination write
stream errors (finding #1)"`. It points `dir` at a plain regular file (not a directory), which makes
`createWriteStream(tmpPath)` fail with `ENOTDIR` — deterministic and root-proof (a structural error,
not a permission one, so it fails even for root, unlike a chmod-based trick). The dump is run in the
fixture's new `hang` mode (`FAKE_DUMP_MODE=hang`, added to `fake-pg-dump.sh`), which writes its own
pid to `$FAKE_PID_FILE` as its first action, then `exec`s into `sleep 3600` (exec, not a forked
child, so the recorded pid can never become an orphan left running under a different, unwatched pid
if the shell itself were killed instead). After `runBackupNow` rejects, the test confirms the OS
process at that pid is actually gone via `process.kill(pid, 0)` throwing `ESRCH` — **not** just that
the promise rejected, which is exactly what the round-2 review asked for.

**This test reliably fails before the fix and reliably passes after it** — verified directly, not
just asserted: I temporarily deleted the `child.kill()` line and re-ran the test in isolation. It
failed with `pid 1243159 is still alive 2000ms after the backup run settled` — the exact defect the
reviewer's own repro described (their repro: child alive 600ms after settling, killed only by hand).
Restoring the fix (confirmed via `diff` against a saved copy) makes it pass again.

**One deviation worth flagging**: the ENOTDIR error can fire in the same instant `spawn()` returns,
which occasionally raced ahead of the fixture's very first instruction (`echo $$ > "$FAKE_PID_FILE"`)
in this environment — reproducible 5/5 when the test ran alone, but a *deterministic* (not flaky)
failure 5/5 when run after the rest of the file, because a "warm" libuv threadpool from earlier
tests' fs operations resolves the `ENOTDIR` open() faster relative to a freshly-forked shell's first
instruction. That race is real but immaterial to what's being tested: without the fix, the child is
**never** killed, so it has unlimited time to write its pid regardless of threadpool state, and the
"still alive" check then reliably times out and fails — the pre/post-fix contrast the reviewer asked
for holds regardless of which side of the race wins post-fix. So the test tolerates *either* outcome
of that race post-fix (pid recorded and later confirmed dead, or the kill wins before the pid write
and nothing is ever recorded) while still deterministically catching the *actual* regression (a child
that is never killed at all, and so always gets to write its pid and then keeps running). I checked
this by running the full file 5/5 times after the fix (all green) and by reverting the fix and
confirming a clean, reproducible failure.

### Finding #2 (Minor, requested) — no dump timeout

**What changed**: `DEFAULT_DUMP_TIMEOUT_MS = 30 * 60_000` (30 minutes), a module-level named
constant with its reasoning in the comment directly above it. A `setTimeout` inside the same Promise
now calls `settleError` with a "stalled" message if neither the "close" nor "finish" signal has
arrived in time; the timer is cleared on every settle path (both `settleError` and the success
`maybeSettle`) so it never fires after a normal run. `runBackupNow`'s `opts` gained an optional
`timeoutMs` override (same shape/spirit as the existing `dumpBin`/`dumpArgs`/`dir` test seams) so
tests exercise the stall path without a real 30-minute wait.

**Reasoning on the number**: this deployment dumps its own database over a local/same-host
connection — a shop-floor ERP's working set, not a data-warehouse workload — so even a `pg_dump`
meaningfully larger than today's actual data should finish in well under a minute. 30 minutes is a
deliberately generous multiple of that (roughly 30-100x plausible real runtimes) so the ceiling only
ever fires for a dump that is genuinely stuck (a wedged lock, a network partition, a full pipe with
nothing reading it), never one that is merely large.

**Test**: `"kills a stalled dump instead of wedging the button forever (finding #2)"`. Runs the fixture
in `hang` mode with `timeoutMs: 200`, asserts the rejection message matches `/stalled/i`, confirms via
the same pid-file + `kill(pid, 0)` technique that the child is actually dead (not just that the
promise settled — this test isn't racy the way #1's is, since the 200ms head start gives the fixture
ample time to record its pid well before the timer fires), and then — the part that directly answers
"wedges the button" — makes a **second** call to `runBackupNow` after the timeout-triggered failure
and asserts it succeeds, proving `inFlight` was correctly released rather than left permanently
occupied by the dead promise.

**Verified this test fails before the fix**: temporarily hardcoded `timeoutMs` inside `doBackup` to
ignore `opts.timeoutMs` (simulating "no working timeout override," i.e., an effectively unbounded
wait). Re-ran the isolated test; as expected it never settled inside the timeout window. (This
particular verification run collided with a still-running background full-suite check from my own
earlier session and produced a noisy, unrelated `truncateAll` error from two processes racing the
same test database — a self-inflicted process-management mistake, not a defect in the fix or the
test; re-verified cleanly afterward with no other test process running. Restored the real 30-minute
default immediately after, confirmed via `diff` against a saved copy.)

### Finding #4 (Minor, requested) — the success path didn't guard against its own bookkeeping failing

**The decision, and the justification asked for**: once `finalPath` passes `integrityOk`, the backup
has already succeeded — a real, complete, verified archive exists on disk. `writeStatus` and
`auditBackupRun` after that point are **evidence about** the success, not a **precondition for** it.
So both calls are now wrapped in `.catch(() => {})` (matching `fail()`'s own established per-step
best-effort pattern immediately above them in the same file), and the function unconditionally
returns the real `ArchiveInfo` regardless of whether either write succeeded. I chose silent
swallowing over logging (e.g. `console.error`) because the codebase has zero `console.*` calls
anywhere in `src/` and already uses bare `.catch(() => {})` five times in this same file for
identical "best-effort, non-load-bearing" side effects (`fail()`'s own cleanup) — matching existing
convention rather than introducing a new one.

This is deliberately **not** symmetric risk: it can only make a genuinely successful run report
success (correct), never make a genuinely failed run report success, because `fail()`'s own
status/audit writes are unconditional and independent of this code path. The one tradeoff I want on
record rather than silently assumed away: `evaluateHealth` checks `!status.ok` before checking
archive staleness, so if a *stale* `ok: false` status from an earlier failed run is still on disk
when *this* run's `writeStatus` also fails, the health banner keeps reading "failed" even though a
fresh, good archive now exists underneath it — under-reporting health, never over-reporting it. That
is the same fail-toward-red bias §6.2 already applies everywhere else in this module (a missing or
unparseable status file also reads red, never green), so I treated it as consistent with the
existing design rather than a new gap to close.

**Test**: `"still returns the archive when writing the status file fails (finding #4)"`. Pre-creates
`BACKUP_STATUS_FILENAME` as a **directory** before calling `runBackupNow`, so `writeStatus`'s
`rename(tmp, final)` fails with `EISDIR` — deterministic, and isolated to the status file only (the
archive itself lives at an entirely different path, so this can't accidentally corrupt or block the
dump). Asserts the call still resolves with `integrityOk: true` and that `listArchives` shows the
real, intact archive. Before the fix (the unguarded `await writeStatus(...)`), this same setup makes
the whole call reject despite a valid archive already sitting on disk — exactly the failure mode the
reviewer flagged.

### Final gate run (post-fix, exact command requested)

```
$ cd erp && npx vitest run tests/backup-run.test.ts tests/backup-health.test.ts tests/permissions-sweep.test.ts && npx tsc --noEmit && npx eslint src tests
```

```
 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp

 ✓ tests/backup-run.test.ts (15 tests) 1841ms
   ✓ runBackupNow > review round 2 fixes > kills the still-running child when the destination write stream errors (finding #1)  572ms
   ✓ runBackupNow > review round 2 fixes > kills a stalled dump instead of wedging the button forever (finding #2)  302ms
 ✓ tests/backup-health.test.ts (17 tests) 302ms
 ✓ tests/permissions-sweep.test.ts (6 tests) 16ms

 Test Files  3 passed (3)
      Tests  38 passed (38)
   Start at  02:15:22
   Duration  2.76s (transform 125ms, setup 13ms, collect 336ms, tests 2.16s, environment 0ms, prepare 73ms)
```

`npx tsc --noEmit` — exit 0, no output.
`npx eslint src tests` — exit 0, no output.

Re-ran the three-file gate 5 more times back-to-back beforehand to confirm no flakiness from finding
#1's race (all 5 green, 38/38 each time).

### Commit

`1bb5fcb5cf1c374b51c3a41b7cae2126baaf5456` — `fix(backups): kill a stalled or failed pg_dump and
bound the dump step`

`git ls-files -s tests/fixtures/fake-pg-dump.sh` after this commit: `100755
067bd02b570a11f1a6b4043f5cc276cec9c0ddc0 0 tests/fixtures/fake-pg-dump.sh` — mode preserved through
the content edit (adding the `hang` case), confirmed both via `git diff`'s unchanged `100755` header
and this direct check.
