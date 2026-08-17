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

### Group A — Allocation & posting concurrency  ·  **#115**, **#68** · **DONE**

**Branch:** `fix-allocation-retry` · #115 = `fc7eb54`, #68 = `20ed463`.

**#115 (P1) — fixed at eight sites, not six.** `shippers.ts` had three allocating entry points
(`saveNewShipper`, `reverseShipperInTx`, `printBol`), not one. Full set: `saveNewOrder`,
`saveNewShipper`, `reverseShipperInTx`, `printBol`, `createCredit`, `createBatch`, `createQuote`,
`exportClose`. All wrap in `retryAllocation` (`db-errors.ts`), INSIDE `withDbErrors` and OUTSIDE
`$transaction`. `reverseShipper`'s injected-`tx` path deliberately takes no retry — a caller's
aborted transaction cannot be re-run from inside it.

**Measurement corrected the issue's own analysis twice**, and both corrections matter:

| concurrent | before | after |
|---|---|---|
| 2 | 1 ok, **1 fail** | 2 ok |
| 5 | 1 ok, **4 fail** | 5 ok |
| 8 | 1 ok, **7 fail** | 8 ok |

1. Not "one of two fails" — **of N concurrent allocations exactly ONE succeeded.**
2. The issue's evidence-table row 2 ("row exists, no read before allocating → both succeed") is
   **wrong**. `allocateNumber`'s own first statement is the `INSERT … ON CONFLICT DO NOTHING` seed —
   a write, which fixes the snapshot before the claim. Allocating as a transaction's *first*
   operation aborts too, so "just allocate first" is not a fix. A sequence would dodge it but leaks
   gaps, and "consumes no number when the save fails" is pinned. Retry is what is left.

`ALLOCATION_TRIES = 10`, not the default 5: N concurrent allocations serialize into N rounds (one
commit per round), so the last caller needs up to N attempts, and 5 covers the documented 1–5 users
with **zero margin**.

**The `clientRequestId` question resolved cleanly.** On orders/shippers the retry wraps the
try/catch rather than sitting inside it, so a nonce collision is answered by the replay on the FIRST
attempt and never retried, while a 40001 is rethrown by the catch and absorbed.

**The test trap was real, and it bit in a second way nobody had flagged.** Beyond "vitest runs Read
Committed", **four existing tests tolerated a 409 loser** — once there are no losers their rejection
branch simply stops executing and they pass VACUOUSLY. All four now assert no rejections at all.
RED-verified by pinning `ALLOCATION_TRIES` to 1: **7 tests across 4 suites go red.** The new
`tests/allocation-retry.test.ts` names Serializable explicitly and proves the abort deterministically
with a Read Committed gate (the `close-periods.ts` technique), rather than hoping for overlap.

**One STANDING INVARIANT test changed shape — the invariant did not.** The §5.14 quote-link
dangerous-direction test asserted the save ABORTS with 409. With the retry the request succeeds on a
second attempt whose snapshot sees the line-drop, so it links nothing (measured: `orders=1`,
`linkedToDead=0`, the surviving line's `quoteLineId` null). It now asserts that null — the data
outcome rather than a status code — which is a **sharper** tripwire: RED-verified by downgrading
`updateQuote` to Read Committed, which makes the save commit WITH a link to the dropped line.

**#68 — `reopenBatch` (POSTED → OPEN), owner ruling option (b).** Full posting-mutation discipline:
Serializable, the batch claim, and the period guard (un-posting drops that cash out of recognition,
so it must never touch a frozen month). The month-locking loop became `assertBatchMonthsOpen`, shared
with `postBatch`, so the ascending-order rule for advisory mutexes is stated once. `voidBatch` gained
the POSTED guard it lacked — checked BEFORE the live-payment guard, so the message names `reopen`
instead of sending the operator at a control `refusePosted` refuses. Gated `receivables.edit`
(symmetric with the post it undoes), reason required and audited, with a route and a Reopen button.
RED-verified twice: removing the period guard reds both period tests, and narrowing it to the first
month only reds the multi-month one specifically.

This also makes posted cash reachable by the GL-export delta for the first time — the correction path
is reopen-period → reopen-batch → correct → re-close → the re-export reverses.

**One question the ruling did not cover, found in self-review: a POSTED batch's payments can carry
live applications** (§5.2 allows applying on-account cash after posting), so what does reopening do
to them? Answer: nothing is stranded — payment, applications and invoice balance all survive, because
`ar-balances` derives from live `Application` rows and never looks at batch status. So `voidPayment`'s
applications-first guard is deliberately NOT copied onto reopen (voiding *strands*; reopening does
not). What moves is GL recognition, and the safety net is **measured, not inferred**: the roll-forward
scopes `paymentTotal` to POSTED batches while the aging does not, so `preliminaryReport` shows
variance 0 → **300** and `paymentTotal` 300 → 0 the moment the batch reopens, with the aging unmoved
and `unpostedBatchCount` naming the batch to re-post. **The month cannot close quietly** — the close
refuses on the nonzero variance until it is re-posted. Worth the owner knowing, since it means a
reopened batch left un-re-posted blocks the month-end.

---

### Group B — Money shape & A/R integrity  ·  **#91**, **#81**, **#84** · **DONE**

**Branch:** `fix-ar-money` · #91 = `0b5ea81`, #81 = `1bb42b3`, #84 = `8229413`.

**#91 — netted.** `aggregateLines` nets each `(account, side)` in integer cents, larger side wins,
the other zero — the same arithmetic `buildPriorNet` already applied to the prior-posting side, so
both halves of the delta now agree on shape as well as on keys. The invoice + same-month credit case
goes from `A/R 100.00 debit AND 40.00 credit` to a single `60.00` debit. The old gross behaviour was
pinned by a test; it was replaced deliberately, and the new one also asserts the per-event
`GlPosting` ledger still totals the GROSS 140.00 while the file totals the netted 60.00.

**One decision the ruling did not spell out:** a group netting to EXACTLY zero is **dropped**, not
emitted. `renderCsv`'s `money()` renders a zero as `""`, so keeping it would emit
`2026-07-31,1200-AR,,,A/R` — a journal line carrying no amount at all, which is precisely the
malformed row the netting ruling exists to prevent. Balance is unaffected and the ledger keeps every
posting. Covered by its own test.

**#81 — aggregate discount cap.** `applyPaymentInTx` now tracks DISCOUNT cents accepted per invoice
**within the request**, and `resolveReason` caps `soFar + line` against `elig`. Splitting the
entitlement across lines still works (12 + 8 under a 20 cap); what is refused is the total exceeding
it. Keyed per invoice, so a multi-invoice apply never lets one invoice consume another's.

**⚠️ A SCOPE BOUNDARY worth your attention, measured and pinned as a test.** The cap is
**per-request**. `elig` is recomputed each call as `discountPercent × the CURRENT open balance`, so
after a $20 discount on a $1,000 invoice a second call is still offered **$19.60** (2% of 980) and
takes it. Repeated, `20 + 19.60 + 19.21 …` converges on the whole receivable — the same hole #81
describes, an order of magnitude slower. Closing it means deciding what the entitlement IS: 2% of the
invoice **total, once**, or 2% of whatever is open at the moment of payment (what is built, and what
`discountAvailable` shows the operator). **That is a terms-policy question, so it is left as the
owner's call** rather than changed under a bug fix; the test asserts today's behaviour so any change
is deliberate.

**#84 — live payments block deleteCustomer.** `customerPaymentBlockers` joins the §5.14 union in both
the blockers route and its Excel export; a Payment has no detail page, so the link goes to the BATCH
holding it — which is also where it can be voided, so "name the blocker AND give a route out" is kept
rather than half-kept. Deliberately the only new category: a live invoice hangs off an order (already
blocking) and a live application needs both an invoice and a payment, so both are covered
transitively. Payments are the one A/R row that can exist with no order behind it, which is why this
was the hole. In-tx Serializable, SSI-pairing with `addPayment`'s `assertRefExists`.

**The half of #84 that nearly shipped missing.** The customer page decides whether to show the
blocker panel by **pattern-matching the refusal text**, and did not know about payments — so a
payment-blocked delete would have rendered a bare error banner with no list and no export: a refusal
naming nothing, the exact Visual Shop dead end §5.14 exists to escape. Found by reading the page
rather than by any test. That coupling is now **swept, not commented**: a test extracts every
templated "That customer still has …" message from the service and asserts each appears in the page's
match condition, so the next guard added cannot degrade silently. RED-verified.

---

### Group C — Order & shipment guards  ·  **#126**, **#125** · **DONE**

**Branch:** `fix-order-guards` · #126 = `de9ed88`, #125 = `d4335c1`.

**#126 — order lines freeze.** One guard mirroring `replaceCharges`: `finalizedInvoiceFor` on the
caller's own claimed `tx`, the caller's own `HttpError`, `invoiceBlockMessage` naming the invoice and
linking to it. In `updateLine` the guard sits **before** the line read, deliberately — the freeze is
a property of the ORDER, so an invoiced order refuses identically whether or not the line exists,
rather than the refusal depending on which settled fact is checked first.

The correction route the ruling asked to be proven is tested end to end: **unlock → edit →
re-finalize still works**, and re-freezing closes it again. After this guard that is the only route,
so a break there would lock the shop out of its own paper.

**Scope note worth carrying:** `removeLine` keeps only its shipped-line guard, per the ruling. A test
records what that leaves reachable rather than assuming it — **an UNSHIPPED line on an invoiced order
can still be removed.** The two guards never contradict each other, but §5.7 is therefore "one thing"
for add/update and not quite for remove. Flagged rather than silently extended.

**#125 — re-shipped serial warns.** Landed in three passes; the final shape came out of Codex's
three findings on PR #130 plus an owner ruling, and the reasoning is worth keeping.

- **Keyed on (order line, serial text), NOT `orderSerialId`.** `replaceSerials` deletes and
  recreates every `OrderSerial`, nulling the earlier `ShipperSerial.orderSerialId` — so an id-keyed
  match lost the prior shipment entirely and the recreated serial went out again unwarned. My own
  comment had *rationalised* that as correct ("a released row no longer refers to a serial anyone
  can re-select"), which was simply wrong: the recreated serial is the same physical part. Scoping
  to the LINE is also what makes the serial TEXT safe to match on — a line belongs to one order, one
  customer, one part — which was the original objection to using it.
- **Compares against EVERY other live shipment, and says "also appears on".** The first draft said
  "has ALREADY shipped on …" and excluded only the current shipment, making the relation SYMMETRIC
  and reversing history — re-reading the ORIGINAL ticket accused it of duplicating its own
  successor. Bounding on an earlier `shipperNumber` fixed that and broke something else: packing-list
  order records DOCUMENT creation, not when a serial was selected during an EDIT, so
  `replaceShipperSerials` on an older ticket could newly add a serial a higher-numbered ticket
  already held and the `lt` filter ignored it. **Distinguishing those needs a
  `ShipperSerial.createdAt` column; the owner ruled for the symmetric wording instead.** Both
  documents now carry an advisory that is true from either side — which is the right reading anyway,
  since a duplicate involves both tickets — at no schema cost.

**Derived, not stored** — the ruling asked whether live
`ShipperSerial` rows joined to non-voided shippers already carry the fact, and they do, so the schema
is untouched. Keyed on **`orderSerialId`** (the physical part instance within its order), never on
the `serial` TEXT, which is unique only per line and would fire falsely across customers reusing a
numbering scheme. Two wanted consequences: a RELEASED row is excluded (it no longer names anything
re-selectable), and the current shipment is excluded by id, so re-reading a shipment never accuses it
of duplicating its own selection. Voided shipments don't count. §5.14: the sentence names the serial,
the packing list, the date, and links to it.

**A finding about the #50/#54 surface, since the ruling invoked it.** That lesson is usually read as
"warnings live in `shipmentWarnings`" — but `createShipper` still builds its list **inline**, and
deliberately so: its messages name the input just sent ("shipping 5 / 5.00 lbs exceeds the
remaining …") where a later read can only speak of shipped-to-date. The two lists are not one
function and should not be. What the lesson actually requires is that the **rule** behind any single
warning live in one place — so creation calls the SAME `priorShipmentsOf` + `reshippedSerialWarnings`
helpers `shipmentWarnings` does, rather than carrying a second copy. Edits and the idempotent replay
both arrive through `shipmentWarnings` via `shipperResponse`, so all three paths share one rule.
Tested on creation, on an edit, and on all three silent cases.

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
