# Task 4 review — `runBackupNow`, the fail-loud on-demand dump

**Spec Compliance:** ✅ Spec compliant (every brief requirement and every global constraint met; the
one deviation is a verified correctness fix to the brief's own example code).
**Task quality:** Needs fixes (one Important, three-line fix, in the block that was restructured).

---

## 1. The deviation: verified correct, and the brief's code is genuinely broken

I reproduced both shapes against the committed fixture (`erp/tests/fixtures/fake-pg-dump.sh`).

**The brief's shape hangs.** Running the brief's exact logic (`out.on("finish", …)` registered
*inside* `child.on("close")`):

```
[observer] finish at 4ms
[brief] close handler at 4ms   writableFinished = true      <-- finish ALREADY fired
Warning: Detected unsettled top-level await   (promise never settled; 3000ms timeout)
```

`child.stdout.pipe(out)` calls `out.end()` at stdout EOF, and for a small dump the flush completes
before the child's `"close"` event; the `finish` listener is then attached to a stream that is
already `writableFinished`, so it never fires and the promise never settles. The implementer's
diagnosis is exactly right, and every `runBackupNow` test would indeed have timed out.

**The replacement settles exactly once on every path.** I instrumented the committed
`resolve`/`reject` (`erp/src/server/backups.ts:240-267`) and drove five paths, counting settle
calls:

| path | outcome | settle calls |
|---|---|---|
| zero exit (`ok`) | resolved | `["resolve"]` |
| non-zero exit (`fail`) | rejected `pg_dump: error: connection failed` | 1 |
| zero exit, no output (`empty`) | resolved (empty check catches it later) | 1 |
| child `error` (ENOENT binary) | rejected `spawn … ENOENT` | 1 |
| write-stream `error` (bad tmp dir) | rejected `ENOENT … open` | 1 |

No path can `resolve()` *and* `reject()`: the `settled` flag is checked and set in both
`maybeSettle` and `settleError`, and all four listeners are attached synchronously before any event
can fire, so no signal can be missed regardless of ordering.

**Nothing settles before the file is flushed.** The success settle requires `closed && finished`,
and `finish` on an `fs.WriteStream` means every byte has reached the OS. Measured with a 40 MB
producer: size at settle = 40 000 000, size 500 ms later = 40 000 000. The size check and the gzip
therefore never see a partial file. Child-errors-before-the-stream-opens and
write-stream-errors-mid-dump both reject promptly (rows 4 and 5 above) — the promise cannot hang on
either.

## 2. Global constraints — each checked against the diff

- **argv, never a shell.** `spawn(bin, args, { stdio: [...] })` (`backups.ts:242`), no `shell`
  option, no `exec`, no interpolation. The fixture's `echo "-- fake dump of $1"` proves argv
  delivery end-to-end. `execFile` (already present) is likewise argv-only.
- **Never an empty archive.** `stat(tmpPath)` + `size === 0` check at `backups.ts:274-277` — on the
  **temp** file, **before** the gzip at `:281`. The `empty` fixture mode pins it.
- **`dumpBin` is a parameter.** `opts.dumpBin ?? "pg_dump"` (`:214`); no `process.env` read for the
  binary anywhere in the file.
- **A FAILED run is audited**, from `audit.ts` only: `auditBackupRun` lives at `audit.ts:452-465`
  beside `auditSettingChange`, the same sanctioned direct-write shape (a backup has no entity row),
  so the permissions sweep's sole-`prisma.auditLog.create`-caller rule still holds. `AuditLog.entity`
  is a free `String` (`prisma/schema.prisma:104`) and no UI enumerates entity values, so `"backup"`
  needs no registration.
- **Production-only.** `await assertNotPracticeDatabase()` is the first statement of `doBackup`
  (`:205`), before any path, name, or spawn work; it is the un-memoized `currentDatabase` re-check
  (`practice-mode.ts:74-82`).
- **`archivePath` for the archive path** (`:225`). `tmpPath` uses `path.join(dir, tempNameFor(name))`
  (`:224`), which cannot go through `archivePath` (a dotfile is deliberately not an archive name);
  the input is machine-generated (`manualArchiveName(new Date(), randomBytes(4).toString("hex"))`),
  so no attacker-controlled string reaches a join. Acceptable.
- **Status file temp-then-rename** — `writeStatus` (`:182-187`), random-suffixed temp then `rename`.
- **`integrityOk` reused** (`:287`), the module-local one at `:83`; no second gzip check added.
- **`HttpError`** on every thrown path; commit `4fab46b` carries no attribution trailer.
- ESLint on the three changed source/test files: clean, exit 0 (re-run by me).

## 3. Failure windows — can any leave a file a later read would trust?

Walked each one against `listArchives`/`newestIntactAt` (`backups.ts:92-153`):

| failure | file left behind | trusted? |
|---|---|---|
| spawn error | 0-byte **dotfile** temp, unlinked by `fail()` | No — `isArchiveName` never matches a dotfile |
| non-zero exit | same | No |
| empty dump | same | No |
| gzip failure | possibly a truncated `.sql.gz` at the final name; `fail()` unlinks it | No — `createGzip` only writes its trailer at end, so a truncated member always fails `gzip -t`, and `newestIntactAt` only counts integrity-passing files |
| integrity failure | the bad `.sql.gz`; `fail()` unlinks it | No — same reason |
| status-write failure (success path) | a **valid** archive, no status update, no audit row | Not misleading: health derives from the archive, so it still reads green. See Minor 3 |
| audit failure (success path) | valid archive, `ok:true` status, request 500s | Not misleading, same |

The report's own three crash windows are accurate and honestly stated; I agree with its conclusion
that no in-process handling can close a `kill -9` window and that the residual debris is always
`integrityOk:false`, never a false success.

---

## Strengths

- The deviation was diagnosed correctly, fixed minimally, explained in a comment that will stop the
  next person "simplifying" it back (`backups.ts:246-250`), and reported honestly as a deviation
  rather than smuggled in.
- The settle logic is genuinely order-independent and single-settle — verified, not assumed.
- Failure cleanup is symmetric and best-effort throughout `fail()` (`:227-235`): unlink temp, unlink
  final, status, audit, each independently `.catch`ed so one failure cannot suppress the others.
- The temp file is a dotfile by construction (`backup-paths.ts:79-81`), which is what makes every
  abort window above un-listable rather than merely usually-cleaned-up.
- All three fixture modes are exercised (`ok` ×6, `fail` ×2, `empty` ×1), and the two extra tests
  close gaps Task 3's reviewer had only verified by hand.
- TDD evidence is real and specific (RED: `runBackupNow is not a function`, 10 failed / 2 passed —
  and the 2 passing are correctly explained as the `listArchives`-only additions).

## Issues

### Critical (Must Fix)

None.

### Important (Should Fix)

**1. The `pg_dump` child is never killed on the error paths, and `child.stdout` has no `error`
listener** — `backups.ts:240-267`.

When the write stream errors (ENOSPC on the backup folder is the archetypal failure this feature
exists to survive), `settleError` rejects immediately, `fail()` unlinks and throws — and the child
keeps running. `pipe()` unpipes on destination error but neither destroys nor pauses-and-kills the
source, so once the 64 KB pipe buffer fills the dump blocks on `write(2)` forever, holding a libpq
connection, a `REPEATABLE READ` snapshot and `ACCESS SHARE` on every table (blocking vacuum and any
migration). Because `inFlight` correctly clears on rejection, every retry click strands another one.
Reproduced: after simulating a mid-dump write error, the child was still alive 600 ms later and had
to be killed by hand.

The same block has a second, rarer face: `child.stdout` gets no `"error"` listener, and `pipe()`
attaches none to the source (verified: `listenerCount("error") === 0` after `pipe`, and a source
`destroy(err)` produced an *uncaught exception*). A stdout read error would therefore take down the
Node process rather than reject.

Both close with three lines:

```ts
const settleError = (err: Error) => {
  if (!settled) { settled = true; child.kill(); reject(err); }
};
child.stdout.on("error", settleError);
```

(plus `child.kill()` on the non-zero-exit branch is unnecessary — the child is already dead there.)

### Minor (Nice to Have)

1. **No timeout on the dump.** A `pg_dump` that stalls (network partition) settles neither `close`
   nor `finish`, so the promise never settles, `.finally()` never runs, and `inFlight`
   (`backups.ts:191-199`) stays non-null for the process lifetime — the button is wedged until
   restart. To be explicit about the question asked: `inFlight` does **not** leak on the rejection
   path (`.finally()` covers resolve and reject alike); it leaks only on never-settles. A
   `setTimeout` → `child.kill()` guard would close both.
2. **`pg_dump`'s stderr is persisted verbatim** into the status file, the audit `after.error`, and
   the operator-visible `HttpError` message (`:230-234`). I checked three realistic failures
   (unresolvable host, bad `sslmode`, non-URL dbname) and libpq echoed no credential in any of them,
   so this is insurance rather than a demonstrated leak — but `redact()` scrubs by *key*, not by
   value, so a DSN that ever did appear in stderr would be written to a file and an audit row
   unscrubbed. A `replace(/postgres(?:ql)?:\/\/\S+/g, "<dsn>")` on `message` is cheap. Related and
   brief-mandated, so noted only: the DSN sits in argv and is visible in `/proc/<pid>/cmdline`.
3. **The success path guards nothing** while `fail()` guards everything: if `writeStatus` (`:292`)
   or `auditBackupRun` (`:295`) throws after a good archive is on disk, the call rejects with a raw
   non-`HttpError`, the operator is told the backup failed while a valid archive sits in the folder,
   and a dump of production that actually happened gets **no audit row** — the mirror image of the
   "a FAILED run is audited too" rule. Consider `.catch()`ing both and still returning the
   `ArchiveInfo`, or auditing first.
4. **`runBackupNow` ignores the second caller's `opts`** (`:196`): a concurrent call with a different
   `dir` silently receives the first caller's archive and writes nothing to its own folder. Harmless
   today (one call site, sequential tests) — worth a line of comment.
5. **The "two concurrent clicks never clobber each other" test never runs two dumps**
   (`backup-run.test.ts:338-345`): `runBackupNow` assigns `inFlight` synchronously, so
   `Promise.all([run(), run()])` deterministically collapses to one run and the assertions reduce to
   `1 === 1`. It tests the single-flight guard, not collision-proof naming; nothing exercises two
   genuinely overlapping dumps.
6. **The success audit test asserts existence-plus-two-fields, not content**
   (`backup-run.test.ts:322-328`): `entityId` and `action` only. The house rule wants the `after`
   payload — `{ archive: info.name, ok: true, error: null }` — asserted, as the failure test does.
7. **`it("refuses a folder it cannot write to, without leaving debris")`** (`:347-350`) asserts the
   rejection but never the "without leaving debris" half. Worth noting while there that the three
   pre-flight refusals (practice DB, missing `DATABASE_URL`, unwritable folder) deliberately write
   no status file and no audit row.
8. **No test pins the production-only refusal** — `assertNotPracticeDatabase` is the §6.3 guard and
   `backup-run.test.ts` never exercises it.
9. **Dynamic `await import("node:fs/promises")` for `mkdir`** inside a test (`:371`) where the other
   fs helpers are top-level imports.

## Assessment

**Task quality:** Needs fixes
**Reasoning:** The requirements are all met and the headline deviation is a real, reproducible fix to
a hang the brief would have shipped — but the restructured spawn block leaks a running `pg_dump` (and
can take an uncaught exception) on exactly the disk-full path a backup feature must survive, which is
a three-line fix in the code under review.
