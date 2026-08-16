# Issue burn-down handoff (2026-08-16)

**Paste this into a fresh session to start clearing issues.** The 8-phase build is complete and merged
(`main` at the Phase 8C close-out). This is the post-build backlog pass that precedes the **parallel-run
acceptance month** (spec §13).

> **A naming note, so nobody chases a ghost:** there is **no Phase 9.** The roadmap
> (`docs/superpowers/plans/2026-07-29-roadmap.md`) has eight phases and all eight are merged. The next
> milestone is the **acceptance month**, which is an operational exercise, not a build phase — and
> **nothing in code gates it any more.** Its critical path is two owner conversations (HANDOFF §7 items
> 2 and 4: the GL account list, and the bookkeeper's QBO import method). Chase those in parallel with
> this burn-down; they are the long pole and no amount of coding shortens them.

## Read first

`CLAUDE.md`, then `docs/HANDOFF.md` §4 (state), §6 (backlog) and §9 (tracks). Every standing rule in
CLAUDE.md binds this work — these are small changes in load-bearing places, which is exactly where this
project's worst defects have lived.

## The five groups, in recommended order

Grouped by **shared machinery and shared risk**, so one branch's review covers one concern and the same
fixtures/invariants get exercised once rather than three times.

**This reorders your stated sequence in one place, deliberately:** you said #115 → the six ruled → #81/#84.
I have pulled **#81 and #84 forward to sit beside #91** (Group B), because all three are money-correctness
in the A/R + invoice graph and share fixtures — doing them together saves a whole setup pass and one
review context. If you would rather keep your original order, do Group C and D before B; nothing depends
on the order between B, C and D.

---

### Task 0 — #122 · **DONE** (branch `fix-vitest-collection`, `c69d82a`)

`erp/vitest.config.ts` set no `include`/`exclude`, so after a build vitest also collected
`.next/standalone/**/tests`. Consequences: **gate order silently mattered** (`npm test` had to precede
`npm run build`, or `.next` had to be cleared), and **any test count reported after a build was inflated** —
a reviewer during Phase 8C saw 4 files / 66 tests when it requested 2 files.

Reproduced on `main` before touching anything: with a build present, `vitest list --filesOnly` emitted
**358 files for 179 real ones**. Fixed with `include: ["tests/**/*.test.{ts,tsx}"]` and
`exclude: [...configDefaults.exclude, "**/.next/**"]`, guarded by `tests/vitest-collection.test.ts`.
Verified by running the **full suite with the 179 stale copies still on disk**: 180 files / 2996 tests,
zero `.next` paths collected. Gate order no longer matters.

**One trap worth carrying forward, because the first draft of the guard test fell into it:** `.next` is
a **dot-directory** and vitest matches with `dot: true`, but Node's `path.matchesGlob` does **not** match
dot segments. A behavioural model of the build-output half written with `matchesGlob` scores the
*pre-fix* config as safe — green for a reason unrelated to what it claims. It was caught only because the
test carried a bite-proof case asserting the broken config is detected as broken. That half is now
guarded **by construction** (every include pattern begins with the literal segment `tests/`, which no
`.next/...` path can match), not by simulation. This is the exact failure shape §"The failure shape to
hunt" describes, found in the burn-down's own first fifteen minutes.

---

### Group A — Allocation & posting concurrency  ·  **#115** then **#68**

**Branch:** `fix-allocation-retry` · **Do #115 first — it establishes the pattern #68 then follows.**

**#115 (P1)** — `allocateNumber` claims its counter with `SELECT … FOR UPDATE`, but every caller runs
**Serializable** and reads before allocating, so a snapshot fixed before the claim aborts with **40001**
the moment another allocation commits. Nothing retries. One of two concurrent order saves just fails.

Six callers, each needing its own retry-safety pass before being wrapped in `retryOnSerializationConflict`
(the pattern `close-periods.ts` already uses):

| File | Entry point | Watch for |
|---|---|---|
| `orders.ts` | `saveNewOrder` | **`clientRequestId` idempotency** — what a retry does to the key is the one genuinely subtle question here |
| `shippers.ts` | `createShipper` | multi-order claims via `claimOrdersInOrder` |
| `invoices.ts` | `createCredit` | period lock (posting mutation) |
| `receipts.ts` | `createReceiptBatch` | period lock; also touched by #68 |
| `quotes.ts` | `createQuote` | §5.14 quote-link SSI pairing |
| `gl-export.ts` | `exportClose` | Σdebit = Σcredit assertion must still run per attempt |

**The test trap that hid this for five phases:** vitest runs **Read Committed**, so a regression test at
the default isolation **passes while production fails**. Every test for this must set Serializable
explicitly. A green `allocate-number.test.ts` is not evidence.

**#68** — add a `reopen` (POSTED → OPEN) so mis-keyed posted cash is correctable; `voidBatch` gains the
matching POSTED guard it currently lacks; reword `voidPayment`'s refusal now that `reopen` exists.
**`reopen` must refuse when the batch's month is closed** — reopening into a frozen month would silently
change closed figures, the exact leak the period lock exists to close. It is a posting mutation: run it
**Serializable** under the per-`(year,month)` advisory lock, and take the locks **in ascending order** if
the batch spans months (the `claimOrdersInOrder` rule for advisory mutexes). Audit it with a reason.

**Why grouped:** both are about Serializable discipline and the period lock, and both touch `receipts.ts`.
Split them and you do the retry-safety analysis of that file twice.

---

### Group B — Money shape & A/R integrity  ·  **#91**, **#81**, **#84**

**Branch:** `fix-ar-money` · All three can corrupt or strand money; none merely fails a request.

**#91 (ruled 2026-08-16)** — net the GL export to a **single signed column** per `(account, side)`
(larger side wins, other zero). Balance is preserved and ruling 9 still holds; this is purely the emitted
column shape. Change is local to `aggregateLines` (`gl-export.ts`). **The current gross behaviour is
pinned by a test** (`gl-export.test.ts`, invoice + same-month credit memo) — update it deliberately and
assert the netted shape. **The per-event `GlPosting` ledger stays un-aggregated** (CLAUDE.md: do not
de-aggregate the file or aggregate the ledger).

**#81 (P1)** — the DISCOUNT cap is **per-line, not aggregate**. `APPLY.lines` permits repeated lines
against the same invoice and `resolveReason` derives eligibility only from applications persisted
*before* the call, so fifty $20 discount lines each pass the $20 check and waive a $1,000 invoice
entirely. Fix: track discount accepted **within this request** and cap the aggregate at the
terms-derived eligible amount.

**#84 (P1)** — `deleteCustomer` checks child customers, parts and orders, but not **live payments**. A
customer holding unapplied cash and no live order can be soft-deleted, after which `applyPayment` can't
use that cash (`familyCustomerIds` requires a live payer) — **the money is stranded.** Extend the blocker
guard, and remember §5.14: **the block must name its blockers** and export them, like every other
reference-delete guard in this system.

**Why grouped:** one A/R fixture set (customer → invoice → payment → application) serves all three, and
they share the same review lens.

---

### Group C — Order & shipment guards  ·  **#126**, **#125**

**Branch:** `fix-order-guards` · Both are "a guard or warning that names its cause."

**#126 (ruled)** — freeze `addLine`/`updateLine` once a finalized invoice covers the order, so §5.7 means
one thing. One guard mirroring `replaceCharges`: read `finalizedInvoiceFor` **on the caller's own claimed
`tx`** and raise the caller's own `HttpError` with `invoiceBlockMessage`. **Read it under the order claim,
not before it** (CLAUDE.md: the guarded state must live on, or be locked with, the claimed row). Check it
doesn't contradict `removeLine`'s existing shipped-line message. Then test that unlock → edit →
recalculate → finalize still works — after this, that is the *only* correction route.

**#125 (ruled)** — warn (don't block) when an already-shipped serial is re-selected. The warning must name
**which shipper and when**. Check first whether the shipped fact can be derived from live `ShipperSerial`
rows joined to non-voided shippers before adding a column (the `orderLineIdAtSave` precedent solved a
similar "released rows still need to credit a fact" problem). Voided shipments must not count.
**Fold it into `shipmentWarnings`** so it reaches BOTH the idempotent replay and every edit response via
`shipperResponse` — the #50/#54 lesson: a warning computed in one path only is half-built.

---

### Group D — Backups follow-ups  ·  **#123**, **#124**, **#119**, **#120**, **#118**

**Branch:** `fix-backups-followups` · All in `backups.ts` / `BackupBanner.tsx` / `scripts/backup.sh`.

- **#123 (ruled)** — disable the Backups page's own controls in practice mode (the route's 403 already
  tells the page), with a §5.16 tooltip naming why; drop the `…` folder placeholder. **Keep the nav
  entry, and do NOT teach `src/lib/nav.ts` about practice mode** — §8 forbids reading the flag in a
  client component, and Phase 8B deliberately designed around that.
- **#124** — refresh the shell staleness bar after a successful "Back up now"; today the page flips green
  while the bar above it stays red until the next page load. Keep the 5-minute throttle for ordinary polling.
- **#119** — audit preflight failures (missing/unwritable `BACKUP_DIR`, unset `DATABASE_URL`), which
  currently throw before the audit path exists, so a permitted user's attempt leaves no record.
- **#120** — a failing retention `find` exits before `write_status true`, leaving the UI green while
  retention is silently broken.
- **#118** — bound the concurrent `gzip -t` checks (currently one subprocess per archive per page load,
  plus an uncached decompression per `/health` poll, which the banner makes from every page).

**#121 needs a decision, not a fix:** in a total DB outage the error bar reaches users without
`manage_backups`, because the 403 that would silence them itself needs a DB read. Arguably correct — the
shop probably *should* know something is broken. Raise it with the owner rather than picking silently.

---

## How to work these

**Per group:** brainstorm only if the shape is unclear → branch → TDD per issue (failing test → implement
→ pass → commit) → per-issue or per-group review → gates → PR with attribution **in the body**, never in
individual commits (this repo squash-merges; a per-commit trailer concatenates N times).

**Gate chain**, and a gate row is written **only after watching the run end** — otherwise it says PENDING:

```bash
cd erp
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
npm run test:e2e     # run in the BACKGROUND — ~10 min, near the tooling ceiling
```

Run `npm run test:e2e` on **any** UI/flow-touching change, even incidental. A killed E2E run leaves a
`ClosePeriod` row that reds three unrelated flows next time; clear it by hand from the DEV db.

**Two operational rules this project learned the hard way:**
- **Only one test-running process at a time.** `fileParallelism: false` serializes test *files* within
  **one** vitest invocation and does nothing across separate processes sharing `erp_test`.
- **Never `git add -A` while a subagent is editing.** Stage explicit paths.

**Docs are part of the work, not a follow-up** — a change that alters a decision or convention updates
`docs/HANDOFF.md`, the spec's §15 decision log if it amends the contract, and `CLAUDE.md`, in the same
breath.

## The failure shape to hunt

Every serious defect this project has found — across eight phases — has been **something that fails while
reporting success**: a dump exiting 0 having written nothing, a backup worker archiving a half-restored
database and marking it green, `psql` sailing past errors, a promise awaiting an event that never fires,
a test passing via a branch that never executed. When reviewing these fixes, ask not "does it work?" but
**"what does it do when it doesn't, and does anything notice?"**

Four tests in Phase 8C alone passed for the wrong reason, by four different mechanisms. Assume the same
of yours until you have watched one fail.
