# Backlog round 3 — grouped (2026-08-20)

**Paste this into a fresh session to continue clearing issues.** Round 2 closed its grouped work on
2026-08-19 (`docs/2026-08-17-backlog-round-2.md`). The pre-acceptance verification pass — the
demonstration dataset, the 45-route screen sweep, the 14-chapter manual (PR #164) — then filed five
issues and drove **seven owner rulings** (spec §15, "Amendments after the manual walkthrough").

**Nine issues are open and NONE is owner-gated.** That is the state this round starts from, and it is
the first time in Round 2 or 3 it has been true.

## What the sizing pass established

A 14-agent recon sized every option on every issue and adversarially re-checked every premise.

**No premise was refuted.** All five issues that carried an owner question — #155, #157, #159, #161,
#162 — verified true against the code. Nothing came off the list for being wrong. (Contrast the
manual walkthrough itself, which *rejected* two of its own candidate findings.)

**Nothing in this backlog is a posting change.** Verified across all nine: no new auditable entity
(so no four-edit `AuditableModel`/`SNAPSHOT_INCLUDE`/`AUDIT_CHILDREN`/`invalidateHistory` work), **no
migration**, no new allocating entry point (no `retryAllocation` site), no new Serializable mutation
(the period-lock STANDING INVARIANT is untouched), and no change to the GL delta, the close
roll-forward or the aging. #159's closure removed the only issue that would have dragged them in.
**That is what keeps every group in days rather than a phase.**

## The groups

Four groups, one branch each, in this order. The house process is unchanged: brief committed first, a
fresh implementer per task, an independent reviewer per task, full gates plus a mandatory
`npm run test:e2e`, one PR with a `Closes #n` per issue, then the Codex loop.

### Sequence gate: merge PR #164 first

The manual, the demonstration seed and the capture harness live **only** on the unmerged
`manual-and-demo-dataset` branch (`ls docs/manual` → no such directory on `main`; `manual:capture` is
absent from `erp/package.json` at HEAD). Three pieces of work below reach into it:

- **#160 has no other verification path.** No vitest and no Playwright flow can observe *"a request is
  not fired"*. `npm run manual:capture` is the gate that found it, and the `KNOWN_EXPECTED` entry
  naming #160 lives in `e2e/manual-capture.mjs` on that branch — the fix's last step is **deleting
  that exemption**, which cannot be done from `main`.
- **#162's ruling** directs a documentation correction into `docs/manual/07-receivables.md`.
- **#159's closure** directs a rewording into `docs/manual/dataset.md`.
- **#163 has nothing to photograph**: the demo seed gives every batch a control total
  (`manual-seed.ts:1640-1643`, `:1728-1729`, `:1742-1743`), so a control-total-less batch has to be
  seeded before the fix can be shown.

### Group C — "wording, and one wasted request": **#162, #160** — FIRST

Smallest group, and **#162 carries a real deadline.** The statement's finance-charge label is a
template-contract default (`src/lib/template-contracts/statement.ts:97`), and per the #103 rule a
stored config pins only what it explicitly stores — so **a changed contract default is live at every
print, including for already-published versions.** Relabelling is free today because nothing has
published a custom statement template. It stops being free the moment one does, which is the
acceptance month. Do it now.

Fully file-disjoint from every other group.

| Issue | Files |
|---|---|
| #162 | `src/server/statements.ts:308-309`, `src/server/pdf/statement.ts:331-341`, `src/lib/template-contracts/statement.ts:97`, `src/app/receivables/statements/Statements.tsx:511` and `:598-604` — **plus** main spec `§5:121` and `§12:166`, which still promise a persisted idempotent finance-charge run and now contradict the ruling |
| #160 | `src/server/users.ts:32-59`, `src/app/admin/users/page.tsx`, `src/components/UserSignatureControl.tsx:29` — and the `KNOWN_EXPECTED` exemption in `e2e/manual-capture.mjs` |

**Size: S + S, 1–2 days.**

### Group A — "the A/R screens tell the truth": **#155 (arm 2), #157, #163**

Three tasks, one branch. They **cannot** be split: two files are shared.

- `src/server/applications.ts` — #155 edits the offer read at `:194-204`; #157 edits the retention
  branch at `:424`.
- `src/app/receivables/batches/[id]/BatchDetail.tsx` — #155 edits the Discount cell at `:319-328`;
  #163 edits the Balance tile at `:629-633`.

Two constraints belong in the brief, not in implementation:

1. **The retention read must NOT reuse `closedPeriodFor`** — it takes `lockMonth`'s advisory lock
   first (`period-locks.ts:44-52`), and a display read taking that lock would serialize every
   customer-page view against a running close. It needs a lock-free closed-period read in
   `period-locks.ts` (a deliberate dependency-free leaf).
2. **`WRITE_OFF_VOID_HINT` must become conditional** (`invoice-guards.ts:105`, appended to three
   refusals at `invoices.ts:1479`, `invoices.ts:1640`, `orders.ts:1358`). The decision is recorded on
   #157: recompute from the write-off's own period rather than widening the wording unconditionally,
   because §5.14 asks a block to name the route that *actually exists* and an unconditional "or reopen
   the period" sends operators toward a month reopen they usually do not need. **This hazard is
   pre-existing** — `voidApplicationInTx` already refuses on a closed period (`applications.ts:779`),
   so the hint is already sometimes impossible; #157 makes it worse by also hiding the row.

Carries #159's doc-only rewording (`docs/manual/dataset.md`), per that ruling.

**Size: S + S/M + S, 2–3 days.**

### Group B — "an implemented route with no button": **#161, #165**

One branch, two tasks, deliberately kept out of one another's diffs — the owner's own instruction, so
the two surfaces stay independently reviewable. File-disjoint apart from `e2e/run.mjs`, where both
register a flow.

- **#161** → a Reverse control on `src/app/shipping/[id]/ShipmentDetail.tsx` (beside Void at `:611`).
  The server side is finished and 17-test-covered, so the cost is the E2E flow.
  **Hazard:** `e2e/flows/void-shipment.mjs:63-68` sweeps *every* `main button` on a voided shipment and
  asserts each is disabled — a present-but-enabled Reverse control reds a flow this task does not
  otherwise touch.
- **#165** → **M, not S.** `POST /api/certs` is `.strict()` and deliberately omits `shipperId`; its
  docblock (`src/app/api/certs/route.ts:14-22`) records that it *"structurally cannot produce a
  SHIPMENT-scope cert."* SHIPMENT scope therefore needs a **new route**, not a relaxed schema —
  relaxing it would reverse a documented decision in the file whose comment is the record of it. The
  LOAD-hardcoded control is at `src/app/orders/[id]/CertificationsSection.tsx:108`.

**Size: M + M, 3–4 days.**

### Group D — **#158 alone, and it goes LAST**

Not because it is big — ~29 one-line calls across 11 files, wide and shallow — but because **its
correctness is a census of every client mutation site, and Groups A and B change that census.** #161
adds a mutation to `ShipmentDetail.tsx`; #165 adds one to the order hub; #155 and #163 both edit
`BatchDetail.tsx`. Landing #158 first ships those as fresh staleness gaps on day one. Landing it last
sweeps them in the same pass.

**Scope widened by the sizing pass, independently re-verified:** `src/app/admin/surcharges/page.tsx`
mounts `<HistoryPanel entity="surcharge">` at `:576`, deletes a `customerSurcharge` at `:257-265`, and
contains **zero** `invalidateHistory` calls. `audit-children.ts:144-146` registers that child under
`surcharge`. So the panel advertises override history and goes stale on the overrides that same page
clears — **a live break of #153's own child-half contract**, not the parent-own gap in this issue's
title. The manifest missed it because `INVALIDATION_SITES` requires *at least one* named file, never
all of them; a second page writing the same child is invisible to it.

That argues the manifest's **redesign** rather than its extension: entity → *every* file that writes
it. One design call goes in the brief — `INVALIDATION_SITES` asserts exact key equality with the
registered CHILD set (`tests/audit-children.test.ts:148-163` against `:174-182`), so adding parent
keys makes it red: a second map, or one widened map with the equality assertion split.

Also: #158 must **delete** the now-redundant `invalidateHistory()` calls at `BatchDetail.tsx:483`/`:506`
once `applyMutation` (`:382`) carries the call, rather than leaving both.

**Size: M, 2 days.**

### #33 — unchanged

Decompose `orders.ts` at the create/edit seam. **Deferred past the acceptance month by owner ruling**;
its bounded board slice already landed in Group H. Do not pick it up.

## Every file collision across the nine issues

| File | Issues | Detail |
|---|---|---|
| `src/app/receivables/batches/[id]/BatchDetail.tsx` | **#155, #163, #158** | Three-way: `:319-328` / `:629-633` / `:519`,`:538`,`:556` (+ the `:483`,`:506` deletions) |
| `src/server/applications.ts` | **#155, #157** | `:194-204` and `:424` — different functions, same module, same reviewer |
| `src/app/shipping/[id]/ShipmentDetail.tsx` | **#161, #158** | #161's new control needs its own `invalidateHistory` call, which only #158's brief knows about |
| `e2e/run.mjs` | **#161, #165** | Both register a new flow; same group, so trivial |
| `docs/HANDOFF.md`, spec §15 | all | Standard; resolved by merge order |

**#160 collides with nothing.** The sizing pass's per-issue report claimed otherwise; re-checked, and
`users.ts`, `admin/users/page.tsx` and `UserSignatureControl.tsx` are touched by no other issue. The
apparent collision was `docs/HANDOFF.md` alone.

## Honest total

**8–11 working days across four sequential merges** — or 6–8 if Groups C and A run in parallel (they
are fully file-disjoint) with B and D behind them. Every estimate assumes this repo's real process,
including Codex rounds, which have run between two and eight per group.
