# Phase 3 (Orders & Loads) and all of Phase 2C — merged through 2026-08-03

*Moved verbatim out of `docs/HANDOFF.md` §4a-prior on 2026-08-06, when the handoff was split into current state plus `docs/history/`. Nothing below is edited or summarised, and the original `### 4a-prior.` heading is kept as written so older references still resolve here. Despite the heading it also carries the 2C-1/2C-2/2C-3 records, the Phase 2B merge, and the 2026-08-02 toolchain run. Current one-paragraph state: HANDOFF §4.*

---

### 4a-prior. Phase 3 (Orders & Loads) MERGED to main — state as of 2026-08-03

**Phase 2C was split into three branches** (owner ruling, 2026-08-01) because as originally framed it was ~11 new models and ~30 tasks, roughly 3× Phase 2B: **2C-1 shared foundations** (done), **2C-2 Parts core** (next), **2C-3 Process Steps + Templates**.

**Phase 2C-1 is complete and MERGED to `main`.** Squash-merged 2026-08-01 as `47d6d0a` (PR #12, 31 commits); the `phase-2c1-foundations` branch is deleted on the remote. Verified after merge: the squashed tree is byte-identical to the branch tip, `main` is green on all four gates — **304 tests**, `tsc`, `eslint`, `npm run build` — and both databases report no pending migrations. **It changed no schema**, deliberately: `git diff` on `prisma/` against the pre-branch `main` was empty throughout.

It delivered the five obligations §4a previously listed as inherited by 2C, each as one shared implementation: the FK registry (`src/lib/reference-links.ts`) and its sweep, FK name resolution on read/export/create/paste, the reference-delete guard with blocker listing and Excel export, the session-only `/api/picklists/[kind]` route, the shared permission-gating helper (`src/lib/permission-ui.ts` + `use-permissions.ts`), and `deleteRole`'s required reason. Spec: `docs/superpowers/specs/2026-08-01-phase-2c1-shared-foundations-design.md`.

Codex posted five findings on PR #12; four were fixed on the branch. The fifth (the delete guard's TOCTOU) is **partially fixed and knowingly open** — see §6, which records exactly what the Serializable wrap does and does not close, and why the writer-side half is 2C-2's.

**Phase 2C-2 (Parts core) is complete and MERGED to `main`.** Squash-merged 2026-08-01 as `aeed372` (PR #13, 39 commits); the branch is deleted. Verified after merge: the squashed tree is byte-identical to the branch tip, `main` green on all four gates — **421 tests** — and both databases report no pending migrations. Spec: `docs/superpowers/specs/2026-08-01-phase-2c2-parts-core-design.md` (its §3 records four owner rulings from the design session; §11's count-only customer-delete bullet carries a dated amendment — the refusal now returns a full blocker list, owner ruling during PR review). Plan: `docs/superpowers/plans/2026-08-01-phase-2c2-parts-core.md`.

It delivered: the six part models (partial-unique `(customerId, partNumber)`, no revival anywhere) with services, routes, list/detail/admin pages, Excel export and paste; **both carried debt items closed** — the audited helpers' `tx` is now **required** (compiler-enforced transactional audit) and every registered-FK writer validates its target in-tx under scoped Serializable (`assertRefExists`), completing the reference-TOCTOU fix on both sides; parts' four registry entries with `CODE · partNumber` display via a generic `include`/`blockerId`/dedupe extension to `findBlockers`; customer child routes scoped to their customer; `deleteCustomer` blocked-with-discoverable-blockers while live parts exist; the shared stale-response gate (`use-latest.ts`) on both list pages; field-def delete **and type-change** blocked while non-empty values exist (blocker panel + export, shared `BlockerPanel` component). Codex posted three review rounds (16 findings): 14 fixed on the branch, 1 refuted with a regression test, 1 filed as issue #15 (per the 2B compound-race precedent). Issues #14 (UI papercuts from the browser walkthrough) and #15 are the new backlog entries.

**Phase 2C-3 (Process Steps + Templates) is complete and MERGED to `main`.** Squash-merged 2026-08-02 (PR #22, 49 commits, 67 files); **Phase 2C is now done end to end.** Verified before merge: all four gates green — **585 tests** (58 files), `tsc`, `eslint`, `npm run build` — plus the six-flow E2E harness 6/6, and both databases migrated. Spec: `docs/superpowers/specs/2026-08-01-phase-2c3-process-steps-design.md`. Owner-facing walkthrough with screenshots: `docs/2026-08-02-2c3-demo.md`.

It delivered the five process models, the revision-cut rule (§5), shop-built templates that load structure and never values, step-code deletion protection through the generalized `BlockerTarget` registry, the Process Steps designer on the part page, the Processes nav section, and the step-codes admin page's closed §6 backlog — plus `npm run test:e2e`, the first owner-reviewable Playwright harness in the project.

**Codex posted six review rounds — 37 findings, 36 fixed on the branch, 1 refuted with a reproduction.** Read this before the next phase, because three of the lessons are general:

- **Serializable on one side of a race buys nothing.** `workingRevision` read `lockedAt` and then wrote children, relying on its own Serializable transaction to order against `lockRevision` — but Postgres only guarantees serializability among transactions that are *all* Serializable, and `lockRevision`'s documented caller (Phase 3's order save) holds it inside the order's own default-isolation transaction. A locked revision could therefore be modified after its lock committed, breaking §5's central guarantee. Fixed with `SELECT … FOR UPDATE`, which both sides take at any isolation. **Phase 3 must not "fix" this by making the order save Serializable — the row lock is the guarantee, and it must stay.** A serialization failure from a raw query arrives as P2010 with the SQLSTATE inside the driver adapter's error, not P2034; `translatePrisma` now normalizes it.
- **A guard is only as good as what it actually discriminates.** The E2E fixture reaper hard-deleted rows in the developer's own database on a `startsWith("E2E")` scan, behind a guard that checked only the database *name* — which `docker-compose.yml`'s prod profile shares. Now exact-key, scoped to the fixture customer (a part's natural key is `(customerId, partNumber)`, not the number alone), and localhost-gated with no override.
- **Preserving unsaved UI work is a model problem, not a patch problem.** Draft preservation produced findings in three consecutive rounds — first not preserved, then not preserved across a revision cut, then preserving *clean* copies that masked another user's edit and let one click of Save revert it. The editors now keep only what the user actually typed, composed with server state at render time, which makes the staleness unrepresentable. **The same shape is worth reaching for first anywhere a page holds an editable copy of server data.**

**Two follow-ups were filed rather than fixed on the branch** (both pre-existing or UI-only, neither blocking): **#23** — the step-codes field-def blocker panel lacks the cross-row stale guard its code-delete sibling has, so a superseded blockers fetch can name a field from the previously selected code (same family as #5/#15; fix with the `use-latest` ticket idiom rather than a second bespoke guard). **#24** — `role.permissions` and `processStepCode.fields` have no `orderBy` in `SNAPSHOT_INCLUDE`, so two snapshots of identical state can render as a spurious diff in History; `partProcessRevision` was fixed in this branch and carries the reasoning. Worth a sweep test, since every future `SNAPSHOT_INCLUDE` collection has the same trap.

Two process observations worth carrying: roughly half the findings in rounds 4–6 were in code written to satisfy the previous round, so review of review-fixes converges slowly — 2C-3 stopped at round 6 by a stated rule (it had reviewed the last large change; anything later is triaged to backlog unless it is a correctness, concurrency, or data-integrity defect). And a parts/template **sibling split** — the same defect existing on two parallel screens or services, fixed on one and missed on the other — accounted for six separate findings. When a fix lands on one of a pair, check the other in the same commit.

**Owner rulings taken 2026-08-01 during 2C-2** (also in the spec §3 and PR #13): price-break basis follows the part's price-per unit; material optional on a part; unit/break prices store 4 decimals; field-def type changes blocked while values exist; customer-delete refusals carry a blocker list (amends spec §11); and **issue #4 is decided** — see the issues list above.

**The Prisma 7 upgrade and the removal of revival-on-create are complete and MERGED to `main`.** Squash-merged 2026-08-01 as `22e0dd3` (PR #11, 26 commits); the `prisma-7-upgrade` branch is deleted on the remote. Verified after merge: the squashed tree is byte-identical to the branch tip, and `main` was green on all four gates — 258 tests at that point, `tsc`, `eslint`, `npm run build`.

One Codex finding was posted against the PR and fixed before merge (`f6fd887`): `prisma/seed.ts` passed a possibly-unset `DATABASE_URL` straight to `PrismaPg`, which falls back to `PGHOST`/`PGUSER` rather than failing — so an unset variable would have seeded an admin account with a known password into whatever database happened to be reachable. `src/server/db.ts` already carried that guard; the seed now does too.

**Phase 2B (customers) is complete and MERGED to `main`.** Squash-merged 2026-08-01 as `32f7f9d`; PR #2 closed, the `phase-2b-customers` branch deleted on the remote. Verified after merge: the squashed tree is byte-identical to the branch tip, and `main` was green on all four gates — 255 tests at that point, `tsc`, `eslint`, `npm run build`.

Eight rounds of automated review ran against it. **All 40 threads were answered and resolved.** Thirty-three were fixed on the branch; seven were filed as issues; one was answered as already-recorded. The issues below are the surviving record — all are deliberate deferrals or owner decisions, none an oversight. **#6, #7, #8 and #10 are already decided; their rulings are §5.14–§5.18:**

- **#3** — a correction typed during a failing save can leave the UI stale. Database stays correct; needs a compound race; resolves on reload.
- **#4** — **DECIDED 2026-08-01 (owner): allow the combination.** Delivery flags mean "this is the invoices/certs person" even when delivery happens by mail or fax; rejecting a blank email would force fake addresses. **Phases 4–5 build obligation:** a flagged contact with no email is skipped **visibly** (named in the send result — "skipped: J. Smith (no email)"), never silently; plus a soft, non-blocking warning on the contact form whenever a delivery flag is on with a blank email. Entry stays unrestricted. Full ruling recorded on the issue, which stays open as the build obligation.
- **#5** — **CLOSED by 2C-2**: the shared stale-response gate (`src/lib/use-latest.ts`) guards both the customers and parts list loads, success and rejection paths alike.
- **#6** — **decided 2026-07-31; 2C builds it.** Reference-row deletion: block it, list the blockers, export the list. See §5.14.
- **#7** — **decided 2026-07-31; 2C builds it.** Controls the user lacks permission for are disabled and say why, never hidden. See §5.16.
- **#8** — **decided 2026-07-31; 2C builds the one remaining site.** A delete needs a reason when it cascades or frees a unique identifier — customer (built) and role (owed). See §5.17.
- **#9** — concurrent edits to *different* fields absorb each other into their audit diffs. Row ends up correct; the entries are too wide, not wrong. Proper fix needs `tx` threaded through all 17 `audited*` call sites — the half-closed transaction gap in §6.
- **#10** — **decided 2026-07-31; DONE 2026-08-01 on `prisma-7-upgrade`.** Reusing a deleted code inherited the predecessor's audit identity. See §5.18.

Round 4's fixes (`047eb51`): `assertTermsExists` closed the last unguarded reference column (a soft-deleted Terms row passed the foreign key and left a customer holding a reference no list resolves); the terms selector now carries inactive rows so an assigned one stops rendering as blank; address `kind` became editable (the service always supported it); and customer delete got a UI at last — the route and its `customers.delete` permission had shipped with nothing able to call them, which also made revival-on-create unreachable from the app.

**The Prisma 7 upgrade is DONE** (owner's ruling, issue #10 — the full record is §5.18). Built on branch `prisma-7-upgrade`: Prisma 6.19.3 → 7.9.1, revival-on-create deleted everywhere it existed (`customer`, `role`, all ten reference kinds, `processStepCode`), all four quality gates green on both databases (258 tests). **Not yet merged to `main`** as of this writing — merge it (or continue on the branch) before starting 2C, since 2C's obligations below assume the removal already happened and no longer carry a "consolidate revival" item.

**The toolchain was brought current on 2026-08-02, after 2C-3 merged.** Five PRs, all verified on all four gates plus the E2E suite before landing: patch bumps with security overrides taking `npm audit` from 5 advisories to 0 (#25), **Node 22 → 26** (#28), **Postgres 16 → 18** (#27), **Next 15 → 16** (#29). The stack is now **Node 26.5.1 · npm 12.0.2 · Next 16.2.12 · React 19.2.8 · Prisma 7.9.1 · PostgreSQL 18.4 · TypeScript 5.9.3 · Vitest 3.2.7**.

Three of those carried a trap that a version bump alone would have walked into, all recorded where they bite: the Postgres 18 image moved its data directory (§6a), npm 12 stopped running install scripts (§8), and Next 16 renamed `middleware` to `proxy` (`src/proxy.ts`, CLAUDE.md). ESLint 10 and TypeScript 7 remain blocked on what `eslint-config-next` vendors — see §6.

Two issues were filed from that run and are open backlog, neither blocking Phase 3 or Phase 4:
**#30** — CI never builds the Docker image, though production *is* that image, so a broken
Dockerfile passes today (this is why #16's green check proved nothing about Node 25). **#31** —
whether this app should keep fetching data in effects; Next 16's `react-hooks/set-state-in-effect`
is overridden in `eslint.config.mjs` for a defensible reason, but the rule points at the pattern
behind issues #5/#15 and several PR #22 findings, and Phase 3 added more pages in that same style
— Phase 4 will add more still, in whichever style is eventually chosen.

**Phase 3 (Orders & Loads) is complete and MERGED to `main`** — squash-merged 2026-08-03 as
`12a17f9` (PR #39, 56 commits: 17 tasks `5a93325`–`125ea43`, then four Codex fix-round waves and
docs). The final whole-branch review ran on the strongest model (verdict: with-fixes; wave applied)
before the PR opened; Codex then posted five rounds — rounds 1–4's 34 findings all fixed on the
branch with regression tests, round 5's 6 findings triaged to issues #41–#46 by owner ruling
(2026-08-03: the round was not converging; no further code on the branch). Verified after merge:
squashed tree byte-identical to the branch tip (`56063b6`); `main` green on **1010 tests**
(85 files), `tsc` clean, `eslint` clean, `npm run build` clean, **`npm run test:e2e` 10/10** — the
original six 2C-3 flows unchanged, plus four new order flows (`order-entry-full`,
`board-search-scan`, `loads-after-print`, `void-order`), run three times consecutively to confirm
stability. Spec:
`docs/superpowers/specs/2026-08-02-phase-3-orders-design.md` (§3 records ten owner decisions from
the design session, with two dated 2026-08-03 amendments closing the traveler samples gate — see
below; §16 is Phase 4's own inheritance list, quoted in §9's kickoff prompt). Plan:
`docs/superpowers/plans/2026-08-02-phase-3-orders.md`. Owner-facing walkthrough with screenshots:
`docs/2026-08-03-phase-3-demo.md`.

It delivered the eleven order tables and the whole order lifecycle on top of them: `createOrder`'s
one-transaction save (validate → allocate the order number via the new generic `allocateNumber` →
lock the lead part's current revision via `lockCurrentRevision`, reusing `workingRevision`'s row-
lock claim → auto-split loads on order totals under the lead's caps → write via the audited
helpers → clear the caller's draft in the same transaction, spec §5), a loads editor with renumber
and the two-phase negative-park re-split pattern (`order-loads.ts`), unaudited autosaved drafts and
saved board views (`order-drafts.ts`/`saved-views.ts`), the full order route surface behind
`orders.*`/`void_order`, the shared attachments story widened to a second owner (orders, alongside
parts), permission-filtered global search with a deliberately-open exact-order-number short-circuit
(`search.ts`), the order board home page (traffic light, saved views, live search-to-scan)
replacing the Phase 1 welcome stub, order entry with crash-safe autosave, the ten-section order
hub, delete-guard extensions blocking part/customer deletion while a live order references them
plus request-day overrides surfaced on both pages, and — closing the traveler samples gate — real
PDF travelers via `pdfmake` + `bwip-js`, one document per print action, every print stored
byte-for-byte for exact reprints.

**Every one of the 16 feature tasks went through this project's independent spec-and-quality
review with fix rounds before being marked done** (each task's own report is in
`.superpowers/sdd/task-N-report.md`; this task — the E2E/demo/docs close-out — is reviewed as part
of the final whole-branch pass). Three lessons from those rounds are general enough to carry into
Phase 4:

- **The 2C-3 "sibling split" pattern recurred.** Four sibling bulk-edit grids
  (Containers/Charges/Serials/Loads on the order hub) share one hook (`src/lib/bulk-grid.ts`); a
  fix for three of them (a concurrent-edit orphan warning) was believed not to apply to the fourth
  (Loads, whose mutator updates rows in place rather than delete-and-recreate) — until review
  caught the one path (a save that *shrinks* the array) where it does too. When a fix lands on one
  member of a sibling group, check every other member in the same commit, even ones that look
  structurally different.
- **The row-lock lesson from 2C-3 held under its first real caller.** `createOrder` calls
  `lockCurrentRevision` inside the order save's own transaction exactly as 2C-3's review demanded
  — the row lock in `workingRevision`/`lockCurrentRevision` is the guarantee regardless of the
  caller's isolation level, and this phase did not "fix" that by making the order save Serializable
  (it IS Serializable, but for an unrelated reason — the registered-FK writer pattern on
  `containers[].typeId`).
- **A too-loose URL-matching pattern in a new E2E flow raced its own navigation** (Task 17):
  `page.waitForURL(/\/orders\/[^/?]+$/)` also matches the literal route `/orders/new` (a real page,
  still on screen right up until the click that navigates away from it), so it resolved instantly
  against the page still showing rather than the navigation the click was about to trigger. Fixed
  by waiting for hub-only content (a badge that can only render post-navigation) before reading the
  URL, not a broader regex. Worth remembering for Phase 4's own `/new`-suffixed entry routes.

**Owner rulings this phase took, all in spec §3 (dated amendments in the same section):**
lead+rider order lines with no recipe-match validation between them (accepted trade-off); auto-
split on order totals honoring both `loadQty` and `loadWeight` together; loads stay editable after
a traveler prints, with a reprint warning, never a freeze; business-day request dates,
most-specific override wins, silent; the traffic light reads the request date, not target; extra
charges captured now, priced later; credit hold warns at entry, never blocks (the squeeze moves to
Phase 4 shipping); an optional `vsOrderNumber` cross-reference field; and `pdfmake` + `bwip-js` for
the PDF stack. **Amended 2026-08-03, closing the Task 16 samples gate:** the 2025 mockup is the
traveler's build target with no further samples gating it; `PartInspection.sampleQty` (new
optional free-text column, prints in the Key Characteristic Quantity column); no
inspection-location images in Phase 3. **Further amended the same day** (Task 16 review): the
traveler's `Process:` cell renders blank in Phase 3 (Phase 7's template designer owns that slot) —
this phase's demo doc records the two cosmetic-but-real deviations alongside it (Process ID prints
the lead part number, not a masked family number; the load's weight prints as a small grey
addition with no column of its own on the mockup). Linking (§5d) also carries an amendment:
linking two orders UNIONS their groups rather than one side silently adopting the other's, so no
order is ever detached from a group by linking.

**What to do next, in order:**
1. **Merge Phase 3.** `phase-3-orders` needs the final whole-branch review this project always
   runs before merging a phase — the per-task reviews already caught and fixed real issues
   throughout (each task's own report has the detail); the whole-branch pass is what 2C-3's own
   history shows catches what review-of-review-fixes misses.
2. **Phase 4 — Certifications & Shipping**, once Phase 3 merges. Follow the roadmap
   (`docs/superpowers/plans/2026-07-29-roadmap.md`) and brainstorm → spec → plan → subagent
   execution as before — §9 below has the kickoff prompt, including what Phase 4 inherits from
   Phase 3 (design spec §16).
3. **No owner decision is pending.** Issue #4 is ruled (binds Phases 4–5); issues
   #14/#15/#30/#31 are triaged backlog, not blockers.

**After a reboot the environment comes back on its own** — `docker.service` is enabled and `erp-db-1` is `restart: unless-stopped`, so both databases return migrated. Git identity is set repo-locally. One nice change: a fresh login shell will carry the `docker` group natively, so the `sg docker -c '…'` wrapper used throughout this session is no longer needed — plain `docker compose …` works.
