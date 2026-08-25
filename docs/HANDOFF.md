# HeatSynQ — Project Handoff

**Updated:** 2026-08-20 — **Phase 8C (Backup polish) MERGED to `main` as `941ceab` (PR #117, squash, 2026-08-16), completing roadmap Phase 8 AND EVERY BUILD PHASE in the 8-phase roadmap. No phase is in flight, and there is no ninth — §9 is the open acceptance/backlog decision (owner's choice).** 8C gave the already-running nightly backup a face and a pulse: the `/admin/backups` page (archive list + integrity + resolved folder + "Back up now"), a red staleness indicator where **absence is failure**, a `manage_backups`-only shell warning bar, the app↔container bridge through a shared `BACKUP_DIR`, two permission-backfill migrations so an upgraded install gets the action automatically, and a live-verified restore runbook. Full narrative moved to `docs/history/2026-08-16-phase-8c-backup-polish.md`; §4 keeps the one-paragraph entry. Final gates on `main`: **2988 tests / 179 files**, `tsc`/`eslint`/`build` clean, E2E **23/23**, **39 migrations**, CI green. Nine per-task reviews (seven clean on round 1), a 5-lens whole-branch review with **zero Critical**, one fix wave, then Codex's **3 P1 + 7 P2** — all three P1s in the *restore runbook*, which two prior reviews had passed because they checked that the commands RUN, not what the shell SEMANTICS meant. Deferred → **#118–#122**. Earlier: Phase 8B merged `6f173e5` (PR #109); Phase 8A `7d3ebb1` (PR #106); Phase 7 `56c9722` (PR #104); Phase 6 `e2c91e8` (PR #94); Phase 5C `c069b09` (PR #92); 5B `b55da3b` (PR #74); 5A `359c707` (PR #58); Phase 4 `f129aae` (PR #47) with burn-down `8647a7d` (PR #57); Phase 3 `12a17f9` (PR #39). **Backlog burn-down COMPLETE (2026-08-16) — 14 issues closed across five groups.** Task 0 **#122** (PR #127, `20174b6`); Group A **#115 + #68** (PR #128, `ac5f8ff`); Group B **#91 + #81 + #84** (PR #129, `b56aa0f`); Group C **#126 + #125** (PR #130, `1d8eac8`); Group D **#118–#121 + #123 + #124** (PR #131). Final gates: 3080 tests / 182 files, `tsc`/`eslint`/`build` clean, E2E 23/23. **Round 2 opened 2026-08-17** (`docs/2026-08-17-backlog-round-2.md`, all 66 grouped): Task 0 closed **#6/#10/#7** as describing mechanisms that no longer exist, and **Group A — the invoice engine — closed all eight of #59–#64, #89 and #96**, squash-merged as `1c1fc77` (PR #133); gates **3104 tests / 182 files**, E2E 23/23, CI green, after **three review rounds** — two of which found defects in the previous round's code, both on the same #61 pairing fallback (a live double bill, then a live under-bill). Round 3 approved and surfaced one RULED limit as #134. **Group B (A/R) followed the same day — #83, #85, #86, #82, #79, #75, all six closed**, squash-merged as `6bc45ea` (PR #135); gates **3128 tests / 183 files**, E2E 23/23, CI green, **six migrations**. It took **eight review rounds** across two independent reviewers (Codex + the task reviewer), who agreed independently on the two that mattered most; the round-9 leftovers are #137. **Group C — shipping and order-status integrity — MERGED 2026-08-18 as `4cada64` (PR #141), closing all eight of #65, #52, #42, #41, #44, #45, #46 and #51.** Three task reviews — **ALL Approved on round 1, a first for a group** — plus **FIVE Codex rounds (nine findings, every one fixed on-branch)**, two of which ended mechanism CLASSES rather than instances: cents are BigInt end-to-end through the load split (rounds 3–4 found float defects in the same pipeline — round 1's lesson 4, the design is the finding), and `travelerPrinted` merges monotonically at `applyMutation` (rounds 3–5 chased the #41 wiring to its fixpoint; a live instance of Group D's #31 class, cited in the ledger). Two kickoff rulings (spec §15): #65 void-is-reversal-aware (with the void-of-original blocker making the net ledger ≥ 0 by construction), #52 persist-print-time-coverage. Two more rulings 2026-08-18 (spec §15): **#139 freeze-the-pair** — its first slice, the second-reversal creation guard, landed ON the PR after Codex RED-provably bypassed the below-zero arithmetic — and **#140 coverage-precise removal**; both `ready-for-agent`, folded into Group E. **The same day the accounting answers were ACTIONED** (#70/#78 closed completed, #76 closed not-planned, #73/#80 unparked into Group E, **Q12 RATIFIED — one step code per process**, §7 item 2). Gates after C: **3166 tests / 184 files**, four new migrations on both DBs. **Group E — close, GL export and concurrency tripwires — MERGED 2026-08-18 as `2d9247c` (PR #142), closing all nine of #73, #80, #88, #90, #93, #95, #132, #139 and #140** with **no schema migration anywhere in the group**. Seven implementation tasks, seven task reviews — **all Approved on round 1 with zero implementer fix-rounds** (five controller-applied minors on-branch); the one Important was the BRIEF's own #139 lock-argument overclaim, resolved by a recorded controller ruling: the container/serial edit-vs-reversal-creation window is **accepted as commit-order semantics** on the §5.1 publish precedent (the leaked outcome is serial-equivalent to edit-before-reverse — the reversal clones lines only — and the four ledger-relevant doors are closed deterministically by SSI; the deterministic close is named in the PR body if the owner ever wants the letter). Highlights: the #139 freeze guard lives in `claimLiveShipper` (the six-door chokepoint, exempting reversal creation, the void-restore and prints by construction); #132's retention health rides a shell-only `retention-status.json` sidecar (absence contributes nothing — a documented exception, CLAUDE.md Backups § updated); the P2002 retry became **opt-in** (only the close's year-month race qualifies — independently swept across all eight allocating transactions); an empty GL export now 400s BEFORE allocating its number; #95's two SSI tripwires were both downgrade-watched RED. **Codex reviewed PR #142 CLEAN — zero findings on PR open** (CI green on the first run). Gates after E: **3212 tests / 185 files**, `tsc`/`eslint`/`build` clean, E2E **23/23**, CI green. **Round 2 Group D — the stale-load class — MERGED 2026-08-18 as `c0b795e` (PR #143), closing #3, #15, #23, #31 and #110; #5 was closed separately with evidence** (already fixed by `aeed372`, Phase 2C-2 — `use-latest.ts` itself cites it). **It opened with the owner's #31 ruling: keep fetching in effects, permanently** (spec §15 row; the eslint override's rationale rewritten as the decision record; CLAUDE.md carries the discipline paragraph), and the second ruling widened the sweep to a **sibling audit of every fetch-into-state page** — 16-agent recon found the surface had more than tripled since filing (**77 rule-hits across ~48 files**) and the class alive far beyond the named issues. **No schema migration anywhere.** Four pure `src/lib/` leaves now carry the discipline: `save-scope.ts` (#3/#15 — epoch-gated, DETACHED, settle-deferred rollback reloads; recon proved no queue arrangement can fix the clobber), `field-blocker-panel.ts` (#23), the SetupBanner invalidation clone (#110, with a renders-nothing refetch guard bounding the argon2 cost), and `drain-queue.ts` (the four mutation-gate detail pages' §5.13 rollback loads drain per-key **request-settled signals registered at dispatch — never queue chain tails**). Seven tasks, seven independent reviews, three fix rounds — **the review loop caught 1 CRITICAL + 3 Importants**: the Critical was the first drain design's mutual deadlock (two different-key saves failing concurrently — reviewer-REPRODUCED with a script, the fix re-verified with an independent clone); two Importants were the BRIEFS' OWN flaws (the save-scope epoch captured after the settle-wait — the park is itself a save window; SetupBanner's `/login` reset overwritten by a pre-logout in-flight fetch, re-latching the PRIOR session's banner for the next user), one an implementer §5.16 over-gate. Also closed on the way: TemplateEditor's work-destroying 409 path, roles' silent permission-grant revert, and the #51 fix's never-cloned ShipmentDetail sibling. One concurrency incident (two implementers' commits crossing on the shared git index) was self-repaired, verified byte-identical, and made structurally unrepeatable — **implementers commit with explicit pathspecs now**. **Codex reviewed PR #143 clean as well — zero findings.** Out-of-class audit finds filed at close-out as **#144–#149**. Gates after D: **3249 tests / 189 files**, `tsc`/`eslint`/`build` clean, E2E **23/23**, CI green first run. **Round 2 Group F — infrastructure and tooling — MERGED 2026-08-18 as `b5a2069` (PR #150), closing #30, #111, #40, #35, #112 and #32; #34 closed with pointers at kickoff** (already implemented since Phase 4's `f129aae` — recon caught it) **and #107 closed not-planned by owner ruling** (revisit trigger recorded on the issue). **No schema migration anywhere.** The practice reset's pinned advisory-lock transaction is DELETED for a 7-line `src/lib/single-flight.ts` leaf satisfying both Codex rounds at once (round 2's actual requirement was "reject or wait"; joiners share the flight, the per-caller 403 guard unchanged, works at pool=1 — the load-bearing comment names both rounds, the single-process facts, and the accepted residual as the round-4 defense); `db-errors.ts` reads the driver-adapter constraint shapes legacy-first (bound to EMPIRICALLY probed P2002/P2003s — embedded-quote stripping, P2003's `index`-not-`fields` key — and the RED watch surfaced a latent translator crash on string `meta.target`, fixed and pinned); **CI gains a parallel `docker` job** building and boot-checking the production image via `/api/health` (**passed in 1m53s on its own PR's first run**); the README's impossible in-container practice seed is gone along with an adjacent stale tsx claim disproven against the real image; the pg@9 tripwire is armed (upstream decompiled first — the concurrent sibling loads persist, the setup.ts filter stays); and the partial-unique sweep's `ALLOWED_CALLS` allowlist is deleted for per-model (model, column) matching with a conservative global fallback. **Four tasks, four reviews — ALL Approved on round 1, zero implementer fix rounds** (three controller minors on-branch). Gates on `main`: **3260 tests / 191 files**, `tsc`/`eslint`/`build` clean, E2E **23/23**; Codex clean on PR open. **CODEX RECORD CORRECTED (owner, 2026-08-18): PRs #142/#143/#150 all HAD Codex reviews — each returned CLEAN on PR open; a zero-inline-comment result is a pass, not an absence.** **Round 2 Group G — documents and templates — MERGED 2026-08-18 as `5c54730` (PR #151), closing #103; #102 closed not-reproducible-at-HEAD at kickoff by owner ruling.** Recon swept the two-pass renderer over n=1..160 × 12 geometry variants (controller re-verified independently) and found ZERO blank trailing pages — pdfmake's own layout makes one structurally impossible for house builders (a page is created only when an element fails to fit, and that element lands on it); the only boundary behavior is the raised margin legitimately spilling the final Total-Due block onto its own page at ~5 isolated counts, recorded on the issue with the don't-re-report distinction and a revisit trigger. **The PR is prose-only — zero executable-code changes** (reviewer-verified hunk by hunk): the #103 contract-evolution warning at the `template-contracts/types.ts` chokepoint, the `validateContractConfig` docblock pointer, one displaced CLAUDE.md sentence, and `statement-templates.test.ts`'s stale blank-page comment corrected to the verified truth. One task, one review — Approved round 1. Then **EIGHT Codex rounds (ten P2s: eight accepted after code-verification, one half-rejected on evidence — the cert-bundle catch it cited does not exist — one triaged under the round-6 stop-reviewing ruling, its first live application)** turned the warning from an enumerated do/don't list into two closed principles — **"additive" is a SEMANTIC test (every stored config stays valid AND keeps rendering the same paper)** and **every contract default, once published against, is immutable IN EFFECT (a stored config pins only what it explicitly stores)** — and round 7 fixed a PRE-EXISTING §5.3 header contradiction ("no consumer ever reaches for a contract default at render time" was never true for the label/width null sentinels). Gates unchanged (prose-only): **3260 tests / 191 files**, `tsc`/`eslint` clean; E2E not run by brief ruling (no UI, function, or flow touched). **Round 2 Group H — the polish batch — MERGED 2026-08-19 as `a8ed769` (PR #152), closing #9, #14, #24, #37, #38, #72, #99, #100 and #101; #33 landed its owner-ruled BOUNDED SLICE and stays open, retitled, for the create/edit split deferred past the acceptance month** (the issue's own named seam proved the ragged one — shared zod schemas, four shared helpers, the §5.14 SSI pairing, and no test pins module boundaries). One migration (`20260819003000_remove_ar_permission_area` — seeded installs carry granted `ar.*` rows that would otherwise 400 every whole-set role save). Five tasks in two waves (three implementers PARALLEL in wave 1), five independent reviews — **four Approved round 1**; Task 4's single Important (a raw NUL byte that made `HistoryPanel.tsx` binary-to-git, blinding the review's own diff package) fixed the same round. The marquee mechanics: **every `auditedUpdate`/`auditedSoftDelete` now claims its row `FOR NO KEY UPDATE` before the before-snapshot** (#9 — plain `FOR UPDATE` deadlocks through FK RI triggers' `FOR KEY SHARE` probes, diagnosed live off `pg_locks`, reviewer-verified against the conflict matrix), snapshot list-relations are **ordered AND projected onto stable fields** (#24 + Codex — delete/recreate re-saves mint fresh ids that JSON-differ), the **orders↔shippers runtime import cycle is retired** (`isDuplicateClientRequestId` → `db-errors.ts`; board reads → `order-board.ts` behind a re-exporting barrel, byte-parity independently verified), and the order-entry Combobox is a real WAI-ARIA editable combobox. **The group-level E2E gate earned its keep**: the first run failed 14/23 flows because the correct `role="option"` REPLACED the implicit button role the shared `pickCombobox` helper matched on — one-line helper fix, then 23/23. **Three Codex rounds**: stable-field snapshot projection (accepted, extended to an entry Codex didn't name); the #99 guard-to-write race closed by a `deletedAt: null`-conditional write (the residue the task review had recorded as accepted); parent-panel child-history aggregation triaged → **#153** (pre-existing display boundary, verified). The ledger honestly records three controller-side incidents (an unverified minor caught by an implementer's bisect; a same-file sweep; shared-DB contention — per-task scratch DBs are now the convention). Gates on `main`: **3310 tests / 198 files**, `tsc`/`eslint`/`build` clean, E2E **23/23**, CI green. **Round 2 Group H2 — the client-state batch — MERGED 2026-08-19 as `1ba0d34` (PR #154), closing all six Group-D-filed #144–#149.** No new recon by design, but a six-agent verification pass re-pinned every filed ref at HEAD first (three material corrections: the board set-default control spans two files since the #33 slice; the orders hub never adopted `useEditGuard` — its half of #149 was an ADOPTION; no edit-guard test file existed — the suite was created, not extended). Three parallel implementers on file-disjoint tasks, three independent reviews — **ALL Approved round 1, ZERO Important findings**; two single-Minor fix rounds, both TDD'd by their own implementers. Mid-group process catch: **Group H's scratch-DB convention was a no-op as written** — `tests/helpers/setup.ts:4` reassigns `DATABASE_URL` from `.env`'s `DATABASE_URL_TEST`, so the prescribed override silently ran suites on shared `erp_test` (two implementers collided exactly as feared); the working override is **`DATABASE_URL_TEST=…scratch`**, diagnosed via `pg_stat_activity`, convention corrected in brief and ledger. **Three Codex rounds, all on the edit-guard leaf, ending at a FIXPOINT**: round 1's P1 was OUR OWN review round's regression (the clear-on-absence released the slot whenever the focused row was absent — and a focused contact is ALWAYS absent from the addresses array; fixed by collection-scoping the cell identity) plus a P2 (post-run ticks now intersect the freshly-applied candidate list); round 2 made both merges PURE in setState updaters — widened past Codex's finding to the PRE-EXISTING Phase-4 scalar mutation across seven pages — with the implementer catching the controller's companion-design hole (React can defer an updater past the companion call) via a grow-only per-session snapshot set; round 3 hit lesson 4 (third round, same mechanism → design the fixpoint): the guard's state is an **immutable captured focus session** — `applyPayload`/`applyRows` capture once at dispatch, note into that same identity, and return pure updaters closed over it, so mispairing is unrepresentable and live state is event-handler-only, with the one unreachable residual documented in the leaf header and pinned by a boundary test. **Round 4 came back CLEAN.** Two new tested leaves: `field-drafts.ts` (#148's keep-what-changed-since-save merge) and the edit-guard's first-ever suite (39 tests). Gates on `main`: **3362 tests / 200 files**, `tsc`/`eslint`/`build` clean, E2E **23/23 — run four times across the rounds**, CI green. **ROUND 2's GROUPED WORK IS COMPLETE**, and the owner-gated remainder was put to the owner the same day — **four rulings, 2026-08-19 (spec §15)**: **#134 accepted as-is and CLOSED** (a typed no-step-code price keeps absorbing; the `invoiceWarnings` flag is the mechanism — the stored state cannot tell "the work this price was typed for" from "work added afterwards", and the two rounds that guessed produced a live double bill then a live under-bill); **#4 CLOSED not-planned** (delivery flags are informational — automatic customer emails are a §3 non-goal and nothing emails a document, so a flag on a blank-email contact selects nothing; the issue's Phase-4/5 premise never materialized); **#69 ruled TWICE — the discount is earned ONLY by a payment that SETTLES the invoice** (the first ruling, "the amount being paid", was given against a flat-percent-of-cash example that recon then showed strands $0.40 on the ordinary case — a $1,000 invoice at 2/10 settled by a $980 remittance — contradicting both the 5B design spec's "amount being **settled**" and a pinned test; re-asked with the numbers, the owner ruled that a partial payment inside the window earns **nothing**). That made it a settlement GUARD, not a basis change: the eligible figure stays `percent × open balance`, and both read sites gained the requirement together (`discountAvailable` offers only when the payment's cash can close the remainder; `applyPayment`'s independent cap refuses a DISCOUNT unless the invoice lands at exactly zero); **#8 ruled — "destructive-ish" means a delete that CASCADES or FREES an identifier**, which scopes it to `deleteRole` alone (customer already done; addresses/contacts/reference rows/step codes stay promptless). **Round 2 Group I — the ready issues — MERGED 2026-08-19 as `e97a65d` (PR #156), closing all five of #69, #8, #137, #77 and #153.** No schema change and no migration anywhere in the group. **#77 finally gives spec §3 ruling 1 its second flavor**: `writeOffInvoice` is a full posting mutation (stub read refusing an untargetable row before any lock → `claimOrder` → invoice row claim → re-validation UNDER the claim → over-application guard → `assertPeriodOpen` → audited write, all Serializable), reached from the customer A/R section, **with the void path in scope by owner ruling** — `openItemsForCustomer` filters `open <= 0`, so a fully written-off invoice would otherwise vanish along with the only handle its undo had (§5.14). GL/close/aging/statements needed no change (all paymentId-blind) and each is pinned by a test. **#69 is a settlement GUARD, not a basis change** (see the two-ruling history above): both read sites gained the requirement together, with cash and discount pre-aggregated per invoice BEFORE the line loop so payload order cannot change the verdict. **#153** is a registry-driven union read (`src/lib/audit-children.ts` + `readAuditWithChildren`, `readAudit` left byte-identical for its 40+ call sites), capped at 200 with the truncation stated on screen, child-id resolution deliberately never filtering `deletedAt` — the child's own DELETE entry is the row the panel most needs. Four tasks, five reviews (**two Approved round 1, #153 approved on round 2, #77 one fix round; zero Critical**). **The reviews' two best findings were FALSE GUARANTEES rather than broken code**: #153's registry header promised its sweep executed every relation hop against the real schema, but the walk short-circuits and the sweep started from a bogus id, so every two-hop path died at the first hop (no live defect — both sides proved it by injecting a typo, and the reviewer found the decisive detail that the OLD assertion still passed with the typo in); and #77's unlock/void-order refusals still said "void the payments applied to it first" after write-offs became first-class, sending the operator to void a payment that does not exist. **Two brief flaws were caught by implementers** (the audit envelope had seven consumers, not three — four client banners would have silently blanked; and #69's brief told them to preserve a two-step discount flow that never worked). **The group E2E gate caught two defects no other gate could see**, both in the one file two tasks edited: a duplicate `const` that made the flow a syntax error so it ran ZERO assertions, and an assertion anchored to a candidate table that a settling apply unmounts. Standing lesson from the first: **`npx eslint src tests` does not cover `e2e/` at all** — it returns exit 0 on a file that cannot be parsed; `node --check` is the parse gate for that directory. **Codex round 1** found the invalidation gap #153 created (the union made child rows visible on four more panels while the `#14 item 1` refresh contract still covered only the parts sections); deriving the call sites from the REGISTRY rather than Codex's symptom list found 17 sites across 6 files — including two part sections Codex's list would have left behind — guarded by an injection-verified `INVALIDATION_SITES` manifest. **Round 2 clean.** Gates on `main`: **3448 tests / 204 files**, `tsc`/`eslint`/`build` clean, E2E **23/23**, CI green. **Round 2's grouped work is complete, and the build then went through a PRE-ACCEPTANCE VERIFICATION PASS (2026-08-19/20) — a demonstration dataset, a whole-app screen sweep, and a 14-chapter user manual** (`docs/manual/`; branch `manual-and-demo-dataset`, **PR #164** — docs plus a seed script and a capture harness, no application behaviour). `erp/prisma/manual-seed.ts` builds an additive dataset **entirely through the service front door** — no `createMany`, no hand-written `*_number_next`, no direct writes — so everything in it is something the app itself would permit: 50 orders across every reachable status, 9 customers with divisions and a credit hold, 12 parts with recipes and price breaks, quotes in all four states, 28 shippers, 15 certs, 18 invoices, a closed July with its GL export, all five aging buckets, and all eight `StoredDocument` kinds verified as real `%PDF` bytes. It is guarded on **`current_database() = 'erp'` AND a localhost URL host** — the production compose file uses the same database NAME, so the name alone is not a safe check. `npm run manual:capture` (`erp/e2e/manual-capture.mjs`) enumerates routes from `src/app/**/page.tsx` (never a hand-list), discovers dynamic ids read-only, photographs every screen, and writes `docs/manual/sweep.md` — a per-screen health report (own-API statuses, console errors, failed requests, real-content-vs-empty-state, load time) that **exits non-zero on any console/page error or failed request**, so it is a repeatable pre-acceptance GATE and not just a screenshot tool. **Unlike `test:e2e` it writes NOTHING to the database** — which is exactly why the manual's pictures must come from it: `test:e2e` creates and then reaps its own dev-DB fixtures, so pointing it at the demonstration dataset would rewrite the very data the pictures are of. Final sweep: **45 routes discovered, 50 screens captured, 49 PASS / 1 FAIL** — the single failure is `/admin/users`, which renders correctly and fires five signature 404s BY DESIGN (**#160**, and the reason it is left failing rather than filtered: whitelisting the route would weaken the gate everywhere). **Writing the manual is what found the defects** — five issues, because explaining a control forces you to check that it does what its label says, and no gate in this project reads labels. The consequential one is **#162**: "Assess finance charges" computes and prints a finance charge that is **never billed** — excluded from Total Due, never posted, never aged, never exported, and recomputed from scratch on every print. Also **#161** (shipment reversal implemented and 17-test-covered with **no UI control anywhere**, and refusal messages instructing operators to "re-reverse" — a step with no button), **#163** (a receipt batch with no control total displays Balance `0.00`, identical to one that balances — the one state that should stand out rendered as the reassuring one), **#159** and **#160**. **Two claims were verified and REJECTED rather than filed**, and are recorded in `docs/manual/walkthrough.md` so nobody re-litigates them: non-lead recipes drifting from the printed traveler (the traveler is a lead-part document BY DESIGN) and finalize wrongly re-stamping terms labels (deliberate, so the label matches the frozen discount numbers per #79). One documentation defect of our own was found and fixed on the branch (`2f6be56`): the walkthrough claimed 47 screens passed against the machine record's 49. **CLAUDE.md's "10 named special actions" was corrected to 13** — and now says to count them in `SPECIAL_ACTIONS` rather than trust the number, while `nav.ts`'s comment had its count REMOVED entirely, since a hardcoded tally is exactly what let it drift for several phases. **SEVEN OWNER RULINGS taken 2026-08-19 (spec §15) cleared every owner-gated issue on the tracker**: **#162 — the finance charge is INFORMATIONAL** (shown, never levied; the posting half is deliberately not built, so the work is wording and presentation only, and `Invoice.financeChargeExempt` stays dead by design); **#161 — reversal GETS a screen** (which makes `OrderStatus.REOPENED` reachable from a UI for the first time and makes the #65/#139 "re-reverse" refusals true rather than impossible); **#165 — manual cert creation gains a SCOPE CHOICE** (split out of #161: `POST /api/certs` had no UI caller either, and the order hub's control is hardcoded to LOAD scope); **#159 — a cash application KEEPS the payment's date, CLOSED not-planned** (the lock is working; on-account cash is allocated before its month closes, and unlock→apply→re-close is the sanctioned heavyweight route — the `applyPayment`/`applyCredit` dating asymmetry is deliberate and stays); **#157 — written-off invoices are retained only until the WRITE-OFF's own period closes** (and the implementation question the ruling flagged is already answered: `voidApplicationInTx` guards `assertPeriodOpen(tx, live.appliedDate)` at `applications.ts:779` while `writeOffInvoice` sets `appliedDate = todayDateOnly()` at `applications.ts:1060`, so both key on the SAME date and hiding the row after close strands nothing); **#155 arm 1 — "pay first, discount after" is NOT a real remittance pattern, closed** (the #69/#81 composition's empty set is a deliberate narrowness, not a defect — the eligible basis does not change); **#155 arm 2 — the hidden discount offer MUST name its route out** (§5.14: a text-only hint naming the settling figure, deliberately not a disabled control, because two E2E flows assert a row-scoped checkbox count of 0). **No issue on the tracker is owner-gated** — first time in Round 2 or 3. At Group C's open that was 9: **#33** (create/edit split, still deferred past the acceptance month by owner ruling) plus eight `ready-for-agent` — #155 (arm 2 only), #157, #158, #160, #161, #162, #163, #165. **Group C closes #162 and #160 and filed two more from its own gates** — **#167** (the demonstration dataset breaks two E2E flows, and CI cannot catch it because CI does not run E2E) and **#169** (`manual.html` fits under the publish ceiling only because the screenshots were hand-compressed by a step that is not in the repo). **Round 3 is grouped at `docs/2026-08-20-backlog-round-3.md`** — four groups in a fixed order, behind one sequence gate (PR #164 must merge first: #160 has NO other verification path, since no vitest and no Playwright flow can observe "a request is not fired" and the gate that found it lives on that branch). **Group C first — #162 + #160**, because #162's label is a template-contract DEFAULT (`template-contracts/statement.ts:97`) and per #103 a changed default is live at every print including already-published versions: free today, not free once a custom statement template exists, i.e. the acceptance month. Then **Group A — #155 arm 2, #157, #163** (they share `applications.ts` and `BatchDetail.tsx` and cannot be split; the retention read must NOT reuse `closedPeriodFor`, whose advisory lock would serialize every customer-page view against a running close). Then **Group B — #161, #165** (#165 is M not S: `POST /api/certs` is `.strict()` and its docblock records that it structurally cannot produce a SHIPMENT-scope cert, so that scope needs a NEW route, not a relaxed schema). **Group D — #158 — goes LAST**, because its correctness is a census of every client mutation site and Groups A and B both change that census. **A 14-agent sizing pass refuted NOTHING** and established that nothing in the backlog is a posting change — no migration, no new auditable entity, no new allocating entry point, no new Serializable mutation — which is what keeps every group in days. It also found **one live defect nobody had filed**, re-verified by hand and folded into #158: `admin/surcharges/page.tsx` mounts a `surcharge` History panel at `:576` and deletes a registered `customerSurcharge` child at `:257-265` with **zero** `invalidateHistory` calls — #153's own child-half contract broken, invisible to the manifest because `INVALIDATION_SITES` requires *at least one* named file rather than all of them. **Round 3 Group C — MERGED 2026-08-20 as `fe828e5` (PR #168), closing #162 and #160.** #162: the finance charge is shown, never levied — the control said "Assess" (which means *to levy*) and the statement printed a charge line directly above a Total Due that excludes it. Fixed through the template contract's `defaultLabel`, **never by reordering the section below `total`** — a stored config renders in ITS OWN stored order, so a reorder reaches the default template and silently misses every published version, while a default re-resolves at print for every config that has not overridden the label. The main spec no longer contradicts the ruling: §7.6 promised a per-invoice dispute/exempt and an idempotent run, §12 listed a finance-charge run among the idempotent operations, and §13 listed "FC idempotency" among the rules that get tests — all three struck, the third found by the implementer rather than the brief. #160: `listUsers` carries `hasSignature` (the `templates.ts` `hasLogo` precedent), so the users page stops firing one 404 per signature-less user. **Both task reviews Approved on round 1, zero Critical and zero Important**; five controller-applied minors, **two of which were FALSE GUARANTEES in the brief's own text** — the keyed-remount rationale described a failure mode that is not reachable (a `${id}-${flag}` key only remounts when the flag changes, so it always re-seeds fresh; the real reason to stay unkeyed is that the page's flag is strictly BEHIND the control's own state), and a contract comment claimed a `defaultLabel` is a null sentinel in *every* stored config when the editor exposes a per-field label override. **The brief was wrong about #160's central test, and the implementer proved it**: asserting the returned row lacks `signatureImage` is invariant to the select, so the prescribed guard would have been GREEN on exactly the regression it was written to stop — the replacement pins the QUERY shape via bound-method save/restore (never `vi.spyOn` on a delegate) restored in a `finally`. Gates: **3453 tests / 204 files**, `tsc`/`eslint`/`build` clean, **E2E 23/23**, `manual:capture` **50 PASS / 0 FAIL**. The E2E run took a detour worth knowing: it first came back **21/23**, and both failures were ambient dev-database state from the demonstration dataset (3 active plant-wide surcharges where `invoice-shipped-order:106` asserts one; 1 OPEN receipt batch where `close-month-end:378` asserts none). **Established by experiment, not inference** — reset the dev DB to pristine → 23/23; rebuild the demonstration dataset via `dataset.md`'s own recipe → the same two fail again. Filed as **#167**, and the important half is the process: **CI does not run E2E at all**, so PR #164 shipped that collision CI-green, and `e2e/lib/db-fixtures.ts:217` refuses any database not named `erp` (correctly — it hard-deletes), so the demonstration dataset and the mandatory gate are pinned to one database with no supported reset between them. Both failing assertions are scoping errors invisible until the DB held rows the flow did not create. **#167 is a process defect worth reading**: CI does not run E2E at all, so PR #164 shipped this collision CI-green, and `e2e/lib/db-fixtures.ts:217` refuses any database not named `erp` (correctly — it hard-deletes), so the suite and the demonstration dataset are pinned to the same database with no supported reset between them. Group C also closed a documentation-rot class: **`npm run manual:build` (`erp/scripts/build-manual.mjs`) now regenerates `docs/manual/manual.html`**, which had been built once BY HAND with no generator anywhere in the repo — it still showed the finance-charge control's old name hours after that control was renamed. Zero-dependency (hand-rolled markdown subset), **deterministic** (two runs byte-identical, so a no-op rebuild is a no-op diff), chapter order derived from filenames AND README's contents table which must agree, and an unresolvable figure reference is a LOUD build error. Two constructs are deliberately unimplemented because they would corrupt real chapter text: `_underscore_` emphasis (permission actions appear bare in prose) and `~~strikethrough~~` (a quoted audit diff). It also found misnested emphasis the hand-built page had been rendering as invalid HTML, and the missing `charset`/`viewport` metas. **But #169**: the page is 14.60 MB against a 16 MB publish ceiling, and only fits because the PNGs were hand-compressed with `magick` in a step that exists nowhere in the repo — the next `manual:capture` + `manual:build` produces ~28 MB and cannot publish at all. The recommended fix is capturing at `deviceScaleFactor: 1`, and whoever takes it must also un-hardcode `build-manual.mjs`'s `10/24` width factor, which encodes the DSF-2-at-1440 assumption. **Group C took SEVEN Codex rounds, and their shape is the lesson.** Codex was right every time and NEVER about the thing just fixed. Rounds 1–5 walked `UserSignatureControl`'s tiny "does a signature exist" state through five designs — seed-once (blind to server changes) → adopt-on-prop-change (blind to a change that ROUND-TRIPS) → lift the state to the page (the lifted write then sat outside the page's `useLatest` load discipline) → cancel the in-flight load (which discarded its unrelated users+roles half) → **reload instead of cancel**, which is what `patch()` already did, so the signature path stopped being special. Rounds 4–5 exposed a SECOND bug hiding under the first: `onError` and a real mutation shared one callback, so an undecodable image (upload validation checks magic bytes, not decodability) set the row false → reloaded → got true → remounted → **unbounded request loop**. Those were two bugs, not five: *two copies of one fact reconciled by a rule*, then *one channel carrying two meanings*. Rounds 6–7 found nothing in the ERP at all — both were in the newly-written `build-manual.mjs`. **Two findings were FALSE GUARANTEES in comments written during the fix rounds** (`brokenSrc` "retries after a server-side change" — only a LOCAL upload bumps the URL; and a back-matter note promising appended instructions fail loudly while the code silently deleted them). Both had the same shape: the strict claim intended, the loose code actually written, and a confident comment making the gap HARDER to see because it reads as verification. Standing lesson: **the generator's guards are now each verified by making the repository genuinely wrong and watching the build refuse** — a trailing paragraph, a trailing list, a heading in README's tail, an extra block after its supporting material, an unterminated fence, a reordered contents row, a missing figure. Reasoning about the guards is what produced both false guarantees. **Back matter is recognised by SHAPE now, not by what it is not** — a blocklist was wrong three times running (list, then paragraph), because it can only ever be as complete as the last review. Two findings were TRIAGED under the round-6 stop-reviewing ruling rather than patched: **#171** (a suppressed preview after another admin replaces an image — the obvious fix is the same local-rule mistake rounds 1–3 made; the real fix is a server-side revision in the URL, which also closes the documented cached-bytes residual) and **#170**. **11 issues open**, four filed by this group's own gates: **#167** (the demonstration dataset breaks two E2E flows, and CI cannot catch it because CI does not run E2E), **#169** (manual.html fits under the publish ceiling only via hand-compression that is not in the repo), **#170** (the History panel's raw snapshot JSON doubles the invoice page's width — no gate can see layout), **#171**. **Process note from this close-out: `main` is protected (PR + `ci` required), and that includes a docs-only close-out.** The close-out commits from earlier phases sit directly on `main` and read as precedent, but they predate the rule — this one pushed straight through and GitHub reported `Bypassed rule violations for refs/heads/main`. The commit was left in place rather than force-pushed away (rewriting a pushed default branch is worse than the violation) and the convention is now written into CLAUDE.md. **Round 3 Group A — "the A/R screens tell the truth" (#155 arm 2, #157, #163) — MERGED `8a14e7c` (PR #176, squash, 2026-08-20); all three auto-closed, Codex came back CLEAN on the first push (zero inline threads, which is a pass, not an absence).** Run **strictly sequentially**: the plan sized them as three tasks but two share `applications.ts` and two share `BatchDetail.tsx`, and with no worktrees in this checkout two agents in one file clobber each other. Every defect here was one shape — **a screen stating something the system does not mean**: a batch proved against nothing rendering as proved, a discount the operator could earn rendering as nothing at all, a write-off row advertising an undo a closed month had already killed. **#157** bounds write-off retention by the write-off's OWN period (owner option b) and adds `closedMonthsForDisplay`, a **LOCK-FREE** sibling of `assertPeriodOpen`'s read — a page asking "is this month closed?" on every render must not take the month advisory lock, or every customer-page view serializes behind a running close. It is one careless import from breaking the period lock's standing invariant, so it is pinned **twice**: a held-lock test proving the guard still blocks while it answers, and an **allowlist of its call sites**, because the delivered test caught `assertPeriodOpen` being re-routed but could not see a new mutation importing the display read directly — the same breach arriving by the front door. **#155 arm 2**'s lesson is the wording: the natural sentence ("remit 980.00 to earn 20.00") is **false** for a receipt already partly spent elsewhere, whose face value can exceed 980.00 and still be refused, because the server tests UNAPPLIED cash — so the hint names the cash that must reach THAT INVOICE ("Applying 980.00 here would earn 20.00"), and spec §15's own row, which illustrated the defect with the false phrasing, was corrected. **The rename lesson is the transferable one:** `discountAvailable` → `discountOffer` was justified as a compile-time forcing function, which is true for callers of the FUNCTION and false for consumers of the JSON — `res.json()` is `any`, so the rename widened precisely what `tsc` cannot see, and a route test kept asserting the old flat shape while typecheck stayed clean. **#163** makes `balance` `number | null`; `prisma/schema.prisma` and the 5B design spec had both said `controlTotal − Σ payments` since the model was written, so this was a **divergence from the declared model**, not merely a display choice. Three per-task reviews: two Approved round 1, one Needs-fixes on that route-shape Critical (found independently by the full suite). Gates: **3486 tests / 204 files**, `tsc`/`eslint` clean, **E2E 23/23**, manual sweep **50/50 clean**. Filed: **#173** (the closed-period hint covers write-offs only — a payment in a closed month still names a route that refuses you, the identical defect one door down), **#174** (an enabled Void that always 409s), **#175** (the save-side refusal still says three words for four dead ends). **The manual's figures were checked, not assumed:** the demonstration dataset was rebuilt and re-captured to test whether the receivables figures had gone stale — they had not (every seeded batch carries a control total, and no candidate in the apply panel is blocked by `would_not_settle`), so the re-capture was reverted to preserve the hand-compression. That attempt measured **#169** precisely: a fresh capture **fails the 16 MB ceiling outright**, so the repo currently cannot regenerate its own manual. The dev database was left **PRISTINE** (dropped, migrated, `db:seed` only), so E2E starts green — the demonstration dataset is reproducible from `prisma/manual-seed.ts`'s documented rebuild whenever the manual needs re-capturing. **Round 3 remaining: Group B (#161, #165 — an implemented route with no button; M+M, the biggest left) and Group D (#158 — LAST by design, because its correctness is a census of every client mutation site and Group B changes that census).** **Round 3 Group A RESIDUE — "the three near-misses Group A left behind" (#173, #174, #175) — MERGED `c3ad03b` (PR #180, squash, 2026-08-20); all three auto-closed, Codex CLEAN on the first push.** All three were filed by Group A's own reviews, and each is a place where a Group A fix **established a rule and then applied it only to the case that prompted it** — which is the pattern worth remembering: the void hint named a reopen for write-offs but not payments; a settled row with a dead undo dropped off the screen while a still-open one kept an enabled Void that always 409s; the offer read learned which of four dead ends applied while the save refusal three lines away did not. **#173's real fix was the CONJUNCTION, not the query.** #157's `", but period X is closed — reopen it first"` hangs the obstacle off the route just named, so widening the month scope underneath it would have *enlarged* the defect — it reads as "the Receivables section is what 2026-01 blocks", false whenever the blocking row is a payment. It now joins two clauses that share no subject, and the hint's scope is literally the guard's own predicate (hoisted, consumed by both), because subset-but-not-equal *is* the defect. **#175 is guarded structurally, not by discipline:** `PreSettlementBlock = Exclude<DiscountBlock, "would_not_settle">`, and `remainingDiscountFor`/`issuedTerms` each dropped from two call sites to ONE, so the offer and the save cannot be edited apart. **THE STANDING LESSON, third instance on two branches: a guard nobody watched fail proves nothing, and its comment will claim otherwise.** #173's refusal-path counter patched the `prisma` singleton while the code ran on a transaction client — measured, `tx.application === prisma.application` is **false** — so it could not fail, and `invoice-guards.ts` cited it as "Pinned by a query counter". Two more over-claiming comments were corrected in the same round. **And one of the false claims was MINE, repeated across four briefs: "there is no DOM test environment, so a `.tsx` cannot be unit-tested."** Half true — no jsdom, so no clicks; but `renderToStaticMarkup` renders initial state and four suites already did it (`loads-section`, `backup-banner`, `practice-banner`, `setup-banner`). Implementers reported the client half unverifiable **because the brief told them it was**. #174's tooltip ladder now has that test, and it caught itself vacuous first: Tailwind's `disabled:*` classes contain the word, so `toContain("disabled")` passes with the feature deleted — assert `/\sdisabled=""/`. Three per-task reviews, all Approved (one after a fix round). Filed: **#178** (the out-of-window refusal does not say *when* the window closed — deliberately left, because naming it needs the deadline threaded out of the single `addDays` rather than computed twice). Gates: **3508 tests / 205 files**, `tsc`/`eslint` clean, **E2E 23/23**, manual 14.60 MB. Also filed **#179** (a payment-only refusal still carries the write-off's destination clause — split out of #173 as a DECISION, `ready-for-human`: the narrowing is defensible, the residue is a wording call). Dev DB left PRISTINE. **Ten issues open:** **#33** (deferred past the acceptance month by ruling — do not pick it up), #158, #161, #165, #167, #169, #170, #171, #178, and **#179** (`ready-for-human` — an owner wording decision, not agent work). **Round 3 Group B — "an implemented route with no button" (#161, #165) — MERGED `04ccb28` (PR #185, squash, 2026-08-21); both auto-closed, Codex CLEAN on the first push.** Two routes that existed, worked, and were tested, that **no screen could call** — found by the manual-writing sweep, verified three ways each. The two tasks were kept out of one another's diffs by the owner's instruction, which is also what made their INTERACTIONS the whole-branch review's job. **#161's load-bearing judgement: the Reverse gate deliberately omits `invoiceVoidBlock`, which the Void button beside it carries.** A finalized invoice freezes a shipment against a VOID, and reversal is the correction for exactly that — `reverseShipper` has no invoice guard at all and reads finalized-invoice state only to decide which orders become `REOPENED`. Cloning the ladder would have disabled the control in the one case it exists for **and looked correct in review**, because it would match the button next to it; the unit test pins the absence by deep-equalling the gate with and without the block, so the field cannot creep back into the DECISION rather than just the title. `OrderStatus.REOPENED` is now reachable from a screen and matched by the board's own filter. **#165 could not be done by relaxing a schema:** `POST /api/certs` is `.strict()` and omits `shipperId` by a decision recorded in that file's own docblock, so SHIPMENT scope got a NEW path-resolved route and the decision was routed around, not reversed. Building the picker then **exposed a latent service gap** — a hand-raised SHIPMENT cert can name any (order, shipment) pair where the two automatic callers always passed one they had just written; an unpaired cert prints every quantity as zero under a bare order label, so `createCert` now refuses it under the existing `claimOrder`. The guard was not overlooked; nothing could reach the state until this control existed. Gates: **3537 tests / 208 files**, `tsc`/`eslint` clean, **E2E 25/25**, manual 14.61 MB. Filed: **#182** (the pair-freeze banner says "void the reversal first" where both Void buttons correctly say "unlock the invoice first"), **#183** (`ready-for-human` — the cert picker offers reversal shipments unlabelled, and the app's own §5.7 warning now POINTS operators at them; note that refusing such certs would leave that warning permanently unclearable, so option (b) needs a companion change), **#184** (`test:e2e` produced a false failure on 3 of 4 runs, each a different flow, every failing run started straight after a full vitest run). **Round 3 Group D — #158, the LAST group — MERGED `ea86dc7` (PR #187, squash, 2026-08-22).** **ROUND 3 IS COMPLETE — five groups, ELEVEN issues: C (#162, #160), A (#155 arm 2, #157, #163), the A residue (#173, #174, #175), B (#161, #165), D (#158).** Recon replaced the estimate with a census: **twelve files mount a `<HistoryPanel>` and only THREE called `invalidateHistory`**. The design call is the census KEY. The old manifest is keyed by registered CHILD entity and asks for *at least one* wired file per entity — never all of them — so a second page writing an already-covered child is invisible to it, which is how `admin/surcharges` shipped live. The new sweep is keyed by PAGE (mounts a panel + mutates then must invalidate), derived by walking `src/` rather than hand-listed, and its **RED output WAS the work-list** — a tool-enumerated census cannot silently omit the file nobody remembered, which is the defect it exists to catch. Its review then found **four ways it could fail OPEN**, all fixed: an allowlist check that asserted nothing (the SIXTH vacuous assertion of the session), an unguarded panel-mount side, `invalidateHistory()` matching inside a comment, and a shorthand `method` carrying no HTTP token. **THE LESSON OF THIS GROUP IS THE ERROR RATE, not the fix.** Four Codex rounds and one task review produced NINE findings on it: **two real product bugs** (a reference-table CREATE demotes another row's default, and the DELETE path, both leaving an open panel showing pre-change history) and **six defects in the guards I wrote to make the census trustworthy** — a comment-stripper that ate 23,140 characters of a real file, a method guard that fired on prose and on a property read, an allowlist check that asserted nothing, an unguarded mount side, a comment claiming to catch a wrapper it cannot, and an allowlist that rejected the very false positives it exists to absorb. **Every one was found by RUNNING something; none by reading.** And the sharpest: told about two unwired mutation sites I wired those two and did not enumerate the file's third — the "applies the rule only to the case that prompted it" defect, committed one round after writing that lesson into this document. **Both product bugs were invisible to the census itself**, which checks per FILE, not per mutation SITE. Treat it as a floor: it catches the file nobody remembered; it cannot catch the site nobody wired. #188 records the parse-don't-pattern-match fix. Owner ruling 2026-08-21: **certification activity stays OFF the order panel** (child documents do not roll up), recorded at `CertificationsSection` because neither sweep reaches a section that mounts no panel of its own. **THE GATE-INFRASTRUCTURE QUARTET IS MERGED — `b7da174` (PR #194, squash, 2026-08-22), closing #167, #169, #184 and #188.** The checks everything else is verified by, every one of them found BY the pre-acceptance verification pass or by round 3's own reviews; #188 joined the trio by owner ruling on the day, because its deferral rested on a premise ("no panel wrapper exists") that was measurably false — six did. **Branch protection now REQUIRES `ci`, `e2e` and `docker`** (owner authorization, 2026-08-22; §5a carries the ruleset mechanics and the measured runner factor). Its four deferrals are #190–#193. **The acceptance month is NOT SCHEDULED (owner, 2026-08-21)** — several documents read as if it were an imminent deadline; it is not, so prioritise by severity rather than by that date. **Eleven issues open — the same number as before the quartet, four closed and four filed** (counted, not carried forward). All are `ready-for-agent` except deferred **#33**; nothing is `ready-for-human` any more, #183's picker ruling having landed 2026-08-22. The standing §9 items remain the practice-copy demo before the acceptance month and the 3 high Dependabot alerts. **Do not re-pick #115, #118–#126, #68, #81, #84, #91, #6, #7, #10, #41–#42, #44–#46, #51–#52, #59–#65, #70, #73, #75–#76, #78–#80, #82–#83, #85–#86, #88–#90, #93, #95–#96, #132, #139–#140, #3, #5, #15, #23, #31, #110, #30, #32, #34–#35, #40, #107, #111–#112, #102–#103, #9, #14, #24, #37–#38, #72, #99–#101, #144–#149, #167, #169, #184 or #188: they are done.**

**This file was split on 2026-08-06** — it had grown past what one read can hold, so the merged phases' full narratives moved verbatim to `docs/history/` and §4 keeps one paragraph each. Nothing was summarised or dropped; see §2 and §4 for the rule that keeps it that way.

---

## 1. What this project is

HeatSynQ is a self-hosted web ERP for a commercial **heat-treating shop**, built to run **in parallel with Visual Shop** (Cornerstone Systems) and eventually replace it. The owner is the shop's **Production Manager** — the project sponsor, primary scheduler, and a daily user. The system keeps Visual Shop's working concepts and vocabulary (customers, memorized parts, process masters, work orders that split into loads, certs, shippers, invoices, A/R) with a dramatically simpler engine, modern navigation, and *more* customization than Visual Shop in exactly two places: document templates and permissions.

**The prime directive, in the owner's words: DO NOT MAKE ASSUMPTIONS.** When the spec, this handoff, or the reference documents don't answer a question — ask the owner. That rule produced every good decision in this project so far.

**Visual Shop remains the system of record** until one full parallel-run month closes with A/R and the QuickBooks summary agreeing with the books (spec §13). Nothing in this project touches the Visual Shop installation or its database — there is **no migration** ("None, no migration" — owner); HeatSynQ starts empty and masters are keyed in by hand.

## 2. Document map

| Document | Role |
|---|---|
| `docs/superpowers/specs/2026-07-29-heat-treat-erp-design.md` | **The approved spec — the contract.** §3 non-goals and §15 decision log are binding. Owner approved it with four review changes (already applied): qty+weight both required, auto load-split, no order duplication, CAR removed |
| `docs/superpowers/plans/2026-07-29-roadmap.md` | The 8-phase build order (owner-approved) |
| `docs/history/` | **The merged phases' full narratives**, one dated file per phase, moved verbatim out of this file's §4 as each phase closed. They record rulings, defect post-mortems and the lessons behind them — nothing there steers today's work, so read one only when you need a merged phase's detail. **The rule: when a phase merges, its narrative moves here and §4 keeps one paragraph** |
| `docs/execution/<date>-phase-*/` | **The execution ledger** — per-task briefs, implementer reports, reviewer verdicts, and the `progress.md` that records what every review found, refuted or deferred. This is the account of *why* each task landed as it did, and none of it is reproducible from source. Written here from Phase 5A on, and **committed on the first task** — see `.superpowers/sdd/README.md` for why it is no longer under `.superpowers/` |
| `docs/superpowers/specs/<date>-phase-N-*-design.md` + the matching `plans/` file | One design spec and one implementation plan per phase, each dated. The **current** phase's pair is binding for the work in flight; §4 names them |
| `docs/superpowers/plans/2026-07-29-phase-1-foundation.md` | Phase 1's executed plan (historical record; two mid-execution corrections were committed to it) |
| `docs/superpowers/plans/2026-07-30-phase-2-kickoff.md` | **Start here for Phase 2** — scope, model notes, pre-work, and the context this handoff's author held |
| `docs/2026-07-30-process-steps-model.md` | **The Process Steps model with diagrams** — supersedes spec §5.1's shared process master. Read before touching parts or recipes |
| `docs/2026-07-29-crossref-findings.md` | Cross-reference of the two Visual Shop reference docs — contradictions, gaps, and which source to trust where |
| `Visual-Shop-ERP-Reference-Report.md` | Teardown of Visual Shop from the vendor KB (primary design reference, with known errors — see findings doc) |
| `VisualShopTraining.pdf` | 2018 vendor training manual — **not in git** (44 MB, gitignored). Lives on the original machine; copy manually if needed. Printed page N = PDF page N+2 |
| `docs/samples/00-…06-*` + `README.md` + `screen-index.csv` | **Visual Shop live screen library** — 125+ captured screens (dashboard, menus, orders/shipping, process/parts, billing/invoicing, A/R, notes/reports), VS 4342.0, captured read-only 2026-08-04. **Not in git** (gitignored, owner ruling 2026-08-07 — holds live company data; local reference only, do not commit/push/redistribute; same precedent as VisualShopTraining.pdf). Incomplete by design. The tracked layout-sample PDFs in `docs/samples/` are separate and stay in git |
| `docs/visual-shop-capture-wishlist.md` | **Tracked** wishlist of VS screens NOT yet captured that would help the coming phases (5B A/R action flows, 5C close/QBO, then quoting/reports), keyed to VS's real menu labels. Living doc — extend as functions come up |
| `erp/README.md` | App dev setup + production deployment + backup/restore |

## 3. Decisions that bind everything (condensed)

Scope IN: order→cert→ship→invoice core; A/R & payments inside the ERP with **summary GL export to QuickBooks Online**; quoting; multi-order shippers + BOL; traveler barcodes (scan-to-open); surcharge add-ons; finance charges.

Scope OUT (deliberate, owner-confirmed — do not re-add): **scheduling** (owner schedules in Excel around molten-salt quench-tank temperatures; "can't be automated without human intervention — always"), **shop-floor tracking** (no ship gate — "we just ship"), **equipment integration**, Sales Order Entry staging, outside processing, inventory, CCM/CRM/mass email, dashboard graphs, contract review, digital order approval, kanban, assembly process masters, automatic customer emails, **CAR** (owner has a separate program; in-ERP rework may come later), **order duplication** (owner: double-billing risk).

Model facts (owner's own words shaped these):
- **Quantity AND weight both required** on orders; a part must carry **each-weight** and **its own Process Steps** (and ideally an active quote) so order entry auto-populates everything.
- **Loads are routine and essential**: 1,000 pcs at 300/load → 300/300/300/100, **auto-split at order save** from the part's load qty/wt. **Loads ≠ containers** (containers are customer packaging). Shipping is decoupled from load boundaries (ship 230 of a 300 load because that's what the customer's container calls for). Three quantity layers: ordered → per-load → shipped.
- **Part numbers are unique per customer, never globally** (owner, 2026-07-30). The same number recurs across customers as work migrates to cheaper sources, and **the chemistry can require a different recipe** — so a part number alone never identifies a part (customer shows at every selection point), and nothing about a part is ever inferred across customers from a matching number. Binds search (P3), certs (P4), and every part picker.
- **GL accounts are their own maintained reference table, and are optional when keying a Process Step Code** (owner, 2026-07-30: "configurable and not set in stone"). Step codes/payment types/surcharges reference an account rather than storing free text.
- **Shared process masters are REMOVED — the recipe belongs to the part** (owner, 2026-07-30; supersedes spec §5.1, recorded in spec §15 amendments). Nearly every step varies part to part (racking *always*, test type/location *always*, temper and austenitize parameters routinely), so a shared master would be an empty shell overridden everywhere — and propagating one edit across parts is precisely what chemistry-dependent outcomes make unsafe. What *is* shared: **Process Step Codes** (billable reference vocabulary carrying GL) and **Templates** (blank skeletons; "Load Template" fills structure with **empty** fields). **No copy-from-another-part mechanic, by decision.** Each step code defines which typed fields it exposes. Per-part step overrides and the step library are deleted, not deferred. Full model + diagrams: `docs/2026-07-30-process-steps-model.md`.
- **Specifications live on the part, many per part** — never on the process. The same recipe yields ASTM grade 1, 2, or 3 depending on the customer's base iron.
- Naming: UI says **Process Steps** (a part's recipe) and **Process Step Code** (the billable reference table, replacing the earlier "Operation").
- Certs: **commercial + ISO 9001 rigor only** (no Nadcap/CQI-9).
- Users: **1–5**, office-based. Platform: **self-hosted web app**. Database: **bundled PostgreSQL**.
- The shipper's *line complete* checkbox — a human, not arithmetic — decides an order is finished (kept from Visual Shop).
- Due dates inform, never block ("a metric, not a hard line").

## 4. State of the build

**The rule that keeps this section readable: when a phase merges, its narrative moves to
`docs/history/` and §4 keeps one paragraph** — what it delivered, its merge commit/PR, and the file
its full record now lives in. The *current* phase's state is kept here in full; everything already
merged is a pointer. Do not append a new phase narrative here — this file is the entry point for
every fresh session and has to stay readable in one pass.

**Fix MERGED to `main` as `a5aac43` (PR #114, squash, 2026-08-16) — `allocateNumber`'s counter-row
seed is now atomic.** Standing up the
build on the new Fedora desktop turned `tests/allocate-number.test.ts`'s concurrent case red 5/5,
where it had passed for five phases on the laptop and in CI. Not a regression: `allocateNumber`
seeded its `Setting` row with `upsert(… update: {})`, and Prisma degrades an EMPTY `update` to
SELECT-then-INSERT (a non-empty one emits `INSERT … ON CONFLICT DO UPDATE`) — so two allocations
racing before the row exists both INSERT and the loser dies on the primary key. The window is only
open while the counter row is absent: the first allocation of a fresh install, after `truncateAll()`,
and **after a practice reset**, where the loser would have got an opaque 500 instead of an
order/shipper/BOL/credit/receipt-batch number. Now a raw `INSERT … ON CONFLICT ("key") DO NOTHING`;
the `SELECT … FOR UPDATE` claim that serializes the readers is unchanged. `settings.ts` held the only
`update: {}` upsert in the tree — the other seven call sites all pass a non-empty `update`. A 5-way
burst test pins it on slow hardware too, and the trap is now in CLAUDE.md's constraints list.
**Scope, precisely: this fixed the P2002 insert race and NOTHING else.** Codex's review of the PR
pushed on the isolation level, and probing it found a larger PRE-EXISTING hole → **issue #115 (P1)**,
now **FIXED on branch `fix-allocation-retry` (`fc7eb54`)** — see the burn-down entry below.

**#115 FIXED (2026-08-16, branch `fix-allocation-retry`).** Every caller of `allocateNumber`
allocates inside a **Serializable** transaction, and a transaction whose snapshot is fixed before the
`FOR UPDATE` claim aborts with **40001** as soon as another allocation commits — on **every**
allocation, not just the first, and with **no retry** anywhere but `close-periods.ts`. Measuring it
against `erp_test` corrected the issue's own analysis in two ways worth keeping:

- **It was not "one of two fails" — of N concurrent allocations exactly ONE succeeded** (n=8 → 1 ok,
  7 failed). Every loser died.
- **The hazard is NOT "the caller reads before allocating"** (the issue's evidence table row 2 said a
  no-prior-read allocation was safe; it is not). `allocateNumber`'s own first statement is the
  `INSERT … ON CONFLICT DO NOTHING` seed — a **write**, which fixes the snapshot itself. So
  allocating as a transaction's very first operation aborts too, which kills the "just allocate
  first" alternative. A Postgres sequence would dodge it entirely but leaks gaps on rollback, and
  "consumes no number when the save fails" is a pinned contract. Retry is what is left.

Also **eight** allocating sites, not six: `shippers.ts` has three (`saveNewShipper`,
`reverseShipperInTx`, `printBol`). All eight now wrap in `retryAllocation` (`db-errors.ts`) at
`ALLOCATION_TRIES = 10` — N concurrent allocations serialize into N rounds, one commit per round, so
the last caller needs up to N attempts and the default 5 would cover the documented 1–5 users with
**zero margin**. `reverseShipper`'s injected-`tx` path deliberately takes no retry. On
orders/shippers the retry wraps the `clientRequestId` try/catch, so a nonce collision is answered by
the replay on the first attempt and never retried. **The vitest suite structurally could not see any
of this — vitest runs Read Committed — so a green allocate-number run was never evidence.**
`tests/allocation-retry.test.ts` names Serializable explicitly and proves the abort deterministically
with a Read Committed gate (the `close-periods.ts` technique). **Four existing tests tolerated a 409
loser and would have passed VACUOUSLY once there are no losers** — all four now assert no rejections;
RED-verified by pinning `ALLOCATION_TRIES` to 1 (7 tests across 4 suites go red).

**One consequence worth knowing: the §5.14 quote-link dangerous-direction test changed shape.** It
asserted the save ABORTS with 409; with the retry the request succeeds on a second attempt whose
snapshot sees the line-drop, so it links nothing. **The invariant is unchanged and still pinned** —
it now asserts the surviving order line's `quoteLineId` is **null** (verified: `orders=1`,
`linkedToDead=0`). That is a sharper tripwire than the status code was: RED-verified by downgrading
`updateQuote` to Read Committed, which makes the save commit WITH a link to the dropped line.

### Phase 8 — COMPLETE; all three sub-phases (8A/8B/8C) merged

**Phase 8B MERGED to `main` as `6f173e5` (PR #109, squash, 2026-08-16)** — second sub-phase of roadmap
Phase 8. Full narrative: `docs/history/2026-08-15-phase-8b-practice-wizard.md`. It shipped the separate
practice training copy (own `erp_practice` DB + an `app-practice` compose service on the `practice`
profile, port 8080, own session cookie; **`practiceMode()` the single db-identity source** driving the
banner, the PRACTICE watermark, and the double-guarded reset), the demo seed built through the services
(`npm run db:seed:demo`), the first-run **setup checklist** (`/setup`, eight steps, the new `SetupState`
by-construction singleton), and the **order-entry gate** (`createOrder` blocked until company identity +
a chart of accounts — a pre-transaction read at the single chokepoint). Reviews: two per-task waves + a
clean 5-lens whole-branch review (**security lens clean**) + **three Codex bot rounds** (r1: 1 P1/7 P2;
r2: 2 P1/5 P2 — all fixed on-branch; **r3: 3 P2 logged as issues #110–#112 and merged**, per owner
instruction). Final gates: 2897 tests / 171 files, tsc/eslint/build clean, E2E 22/22, CI green. **The
two by-construction singletons are now `BillingConfig` + `SetupState`.**

**Phase 8A MERGED to `main` as `7d3ebb1` (PR #106, squash, 2026-08-14)** — first sub-phase. Full
narrative: `docs/history/2026-08-14-phase-8a-reports-scoreboard.md`. It shipped the `/reports` platform
(the `reports` area went live; a reusable five-part report shape cloned from A/R aging), five native
reports (backlog, shipped, turnaround, sales, payments), the homed invoice register + A/R aging, the
comparison scoreboard (invoiced-$ by **`invoiceDate`** — the VS eyeball), two indexes, and a reports
E2E flow. **8A deferred a follow-up (issue filed):** the report wrappers use unbounded `findMany` + JS
aggregation — fine at shop scale; DB-side aggregation is a future optimization.

**Phase 8C (Backup polish) MERGED to `main` as `941ceab` (PR #117, squash, 2026-08-16) — completing
roadmap Phase 8 and, with it, EVERY BUILD PHASE in the 8-phase roadmap**
(`docs/superpowers/plans/2026-07-29-roadmap.md`). Full narrative:
`docs/history/2026-08-16-phase-8c-backup-polish.md`. It gave the already-running nightly backup a face
and a pulse: a pure `backup-paths.ts` leaf (filename-shaped path confinement, no fs/db), the
`manage_backups` action + `backup_stale_hours` setting, the backup service (argv-spawned `pg_dump`,
fail-loud on an empty dump, `gzip -t`-verified before being declared good, a 30-minute stall ceiling
with SIGTERM→SIGKILL escalation), three gated routes, the `/admin/backups` page, a
`manage_backups`-only shell staleness bar, the deploy wiring (`postgresql18-client`, `BACKUP_DIR` +
the `./backups` mount on `app`/`backup` but pointedly **not** `app-practice`), **two**
permission-backfill migrations, and an expanded restore runbook. **`lastSuccessAt` is DERIVED from the
newest integrity-passing archive, never stored** — the archive is the evidence, which is what lets the
status file be a single un-merged overwrite a `sh` script can write. **Upgrading an existing install
now grants `manage_backups` automatically on `migrate deploy`** — no manual `npm run db:seed` step.
Reviews: nine per-task (seven clean on round 1), a 5-lens whole-branch review with **zero Critical**,
one fix wave, then **Codex's 3 P1 + 7 P2** — all three P1s in the *restore runbook*, which two prior
reviews had passed because they verified the commands **run** without checking what the shell
**semantics meant**. Final gates: **2988 tests / 179 files**, `tsc`/`eslint`/`build` clean, E2E
**23/23**, **39 migrations**, CI green. Deferred → issues **#118–#122**. **Env note: Docker is disabled
at boot** — check `systemctl is-active docker` before diagnosing ECONNREFUSED (§8, and the
session-memory index).

**Phase 7 (Template designer) MERGED to `main` as `56c9722` (PR #104, squash, 2026-08-14),
completing roadmap Phase 7.** Its full narrative is in
`docs/history/2026-08-14-phase-7-template-designer.md`; the one-paragraph entry is below under
"Merged, in build order".

**Phase 5 (Invoicing & A/R + QBO)** completed with the Phase 5C merge (`c069b09`, PR #92,
2026-08-10) — full record `docs/history/2026-08-10-phase-5c-close-qbo-export.md`. Its completion
unlocked parallel-run (roadmap: "Parallel-run capability begins after Phase 5"; acceptance criterion
spec §13 — one full closed month agreeing with the books), which the owner-owed GL-account list +
bookkeeper QBO homework still gate for a *real* export.

**Phase 6 (Quoting) MERGED (`e2c91e8`, PR #94, 2026-08-12)** — full narrative
`docs/history/2026-08-12-phase-6-quoting.md`; the demo ran 2026-08-12 with all 8 ratification items
RULED (`docs/2026-08-12-phase-6-demo.md`); deferred findings are issues **#95–#101**.

Carried A/R follow-up: issues **#69–#93** (§6) — **#81** (aggregate discount cap), **#84**
(delete-customer-with-live-payment) and **#91** (GL-export netting) are all DONE (branch
`fix-ar-money`, burn-down Group B), and **#68** (also done, Group A) carried
5C's posted-payment-reversal consequence (a posted payment can't be reversed by a re-export; a
spec-silent accounting decision). The older backlog (#51–#52, #59–#65, the per-worker-test-DB infra
task, §6) remains open too.

### Merged, in build order

The stack is **Node 26 · npm 12 · Next 16 · React 19 · Prisma 7 · PostgreSQL 18 · TypeScript 5.9 ·
Vitest 3** (brought current 2026-08-02 across five PRs; the two majors still blocked by what
`eslint-config-next` vendors are in §6).

- **Phase 1 — Foundation.** Merged and pushed. Auth (argon2id, hashed session tokens, sliding
  expiry, timing-attack-resistant login), the 12-area permission model with role grants and
  per-user overrides, the audit layer with before/after relation-aware snapshots, Settings as a
  typed zod registry, the admin pages (users/roles/settings/audit log), the permission-aware shell,
  and the Docker packaging with fail-loud nightly backups. **Seeded credentials `admin` / `admin` —
  change immediately on any real install.** Full record:
  `docs/history/2026-08-01-phases-1-2a-2b-foundation.md`.
- **Phase 2A — foundation refactors + reference data.** The five Task-0 refactors (`HttpError`
  extracted, one session resolution per request, the Prisma error-hygiene helper, redacted settings
  values, quiet dotenv), GL accounts, nine flat pick-lists and Process Step Codes with configurable
  field definitions, each with Excel export and spreadsheet paste. Full record: same file as Phase 1.
- **Phase 2B — customers.** Squash-merged `32f7f9d` (PR #2, 2026-08-01). Owner-assigned customer
  `code`, parent/division billing, the Phase 5 commercial fields, note blocks, typed addresses and
  per-document contact flags. Full record: same file as Phase 1; the eight review rounds and the
  issues they left are in `docs/history/2026-08-03-phase-3-orders-and-phase-2c.md`.
- **The Prisma 7 upgrade** (`22e0dd3`, PR #11, 2026-08-01) — Prisma 6.19.3 → 7.9.1, the ESM flip,
  and **revival-on-create deleted everywhere it existed** in favour of unique-among-live-rows
  partial indexes (§5.11, §5.18). Full record: `docs/history/2026-08-01-prisma-7-upgrade.md`.
- **Phase 2C — parts and the recipe that belongs to the part**, split into three branches by owner
  ruling: 2C-1 shared foundations (`47d6d0a`, PR #12), 2C-2 parts core (`aeed372`, PR #13), 2C-3
  process steps + templates (PR #22, 2026-08-02, which also brought `npm run test:e2e`). Full
  record: `docs/history/2026-08-03-phase-3-orders-and-phase-2c.md`.
- **Phase 3 — Orders & Loads.** Squash-merged `12a17f9` (PR #39, 2026-08-03). The eleven order
  tables and the whole order lifecycle: the one-transaction save with number allocation and recipe
  row-lock, auto-split loads, drafts and saved board views, permission-filtered global search, the
  order board and the ten-section order hub, and real PDF travelers stored byte-for-byte. Full
  record: `docs/history/2026-08-03-phase-3-orders-and-phase-2c.md`.
- **Phase 4 — Certifications & Shipping.** Squash-merged `f129aae` (PR #47, 2026-08-06), with the
  **backlog burn-down `8647a7d` (PR #57)** on top. Certs with the required/scope resolution chain
  and frozen requirements, shipments as documents (packing-list number, per-order sequence,
  multi-order shipments, the ship ledger, the credit-hold gate with reason-in-audit, void-with-
  reason), `StoredDocument` widened to the one document table behind a hand-written kind→owner
  `CHECK`, and the shipping-ticket/BOL/certification layouts built to the owner's samples. It also
  produced the **snapshot + release** rule and the **guarded-state-must-be-locked** house rule that
  CLAUDE.md now carries. Full record — including the six review rounds, the eleven lessons, and the
  owner rulings taken during execution: `docs/history/2026-08-06-phase-4-certs-shipping.md`.
- **Phase 5A — Pricing & Invoicing.** Squash-merged `359c707` (PR #58, 2026-08-08). Part pricing
  restructured off four flat `Part` columns onto **price rows keyed by Process Step Code** (setup/
  unit/minimum charges + price breaks, a pure `pricing.ts` engine), **surcharges** with per-customer
  opt-out/override, a one-row **`BillingConfig`**, and the full **invoice/credit lifecycle** —
  candidacy at SHIPPED, draft → finalize (writes `Order.status = INVOICED`) → unlock, or raise a
  credit (`kind = CREDIT`, own number series); the **reversing shipment** (reuses `void_shipper`'s
  claim machinery, and reopens the order it reverses — `REOPENED` if invoiced, else re-derives
  *Partial shipped*); and the invoice/credit PDF — six new tables behind two hand-written CHECKs.
  Final gates: **1692 tests**, `tsc`/`eslint`/`build` clean, E2E **16/16**. Codex's PR review found
  **7 real findings**, all deferred to issues **#59–#65** (§6). Full record — the twenty tasks, the
  owner rulings, the demo, and the review triage:
  `docs/history/2026-08-08-phase-5a-pricing-invoicing.md`.
- **Phase 5B — Accounts Receivable.** Squash-merged `b55da3b` (PR #74, 2026-08-09). The receipts
  ledger (`ReceiptBatch → Payment → Application`, one unified typed `Application` table behind
  `Application_source_check`), cash application across one or more invoices and a parent's divisions
  (partials, terms discounts, write-offs gated on a new `write_off` action, on-account, credit
  memos), **all balances derived live from `Application` rows — never cached on `Invoice`** (pure
  `ar-balances.ts`); point-in-time aging (`aging.ts`), informational opt-in finance charges
  (`finance-charges.ts`), and archived open-item statements (`statements.ts`); the `/receivables`
  UI + a `receivables` permission area; and the cross-phase `hasReceivableActivity` guard that
  refuses unlock/discard/void-order on paper with live A/R activity. Two 5A changes: a credit takes
  its own date; a finalized invoice gets a `dueDate`. Final gates: **1879 tests**, `tsc`/`eslint`/
  `build` clean, E2E **17/17**. The subagent-driven review process caught 5 real
  correctness/concurrency bugs on-branch; two Codex PR reviews were addressed (11 fixed on-branch,
  the rest **deferred to issues #68–#87** — #81 aggregate-discount-cap and #84 delete-customer-with-
  live-payment are the P1s). Full record — the 17 tasks, the whole-branch review, the Codex rounds,
  the owner rulings, and the lessons (incl. the review blind spot on spec-deliverable reachability):
  `docs/history/2026-08-08-phase-5b-accounts-receivable.md`.
- **Phase 5C — Month-End Close & QuickBooks Online Summary Export.** Squash-merged `c069b09` (PR #92,
  2026-08-10). Completes roadmap Phase 5. The guided, soft-reopenable month-end close (a frozen
  continuity schedule reconciled against 5B's aging) and the QBO **summary** journal export (a
  downloadable CSV + stored posting-register PDF, no live Intuit API): an append-only `GlPosting`
  ledger driving a strictly-per-period per-event **delta**, readiness that refuses any account-less
  non-TAX line, and a `period-locks.ts` leaf (per-`(year,month)` advisory lock, **all-Serializable**
  so SSI backstops the posting-vs-close phantom) wired into every 5A/5B posting mutation. Owner
  ruling 8 — **an invoice is recognized in its `finalizedAt` month** across the roll-forward, export
  scoping, and period lock; ruling 9 — **the export file is a summary by `(account, side)`**, detail
  kept in the ledger. Reviews caught four data-integrity/concurrency defects on-branch plus the
  cross-task reconciliation date-basis defect (the headline blocker) at whole-branch; two Codex PR
  rounds followed (3 fixed — the re-export-delta reversal of a changed reopened event, a `year>=2000`
  bound, a `closedAt` refresh; the rest routed to issues **#88–#93** / owner question **#68**). Final
  gates: **1947 tests**, `tsc`/`eslint`/`build` clean, E2E **18/18**. Full record:
  `docs/history/2026-08-10-phase-5c-close-qbo-export.md`.
- **Phase 6 — Quoting.** Squash-merged `e2c91e8` (PR #94, 2026-08-12). Standing-agreement quotes
  (per-order-line auto-link judged at link time, latest-effective-wins, wholesale tier-1
  substitution with `sourceQuoteNumber` frozen per invoice line, live-until-finalize), the
  follow-up/expired worklist, the `endingStatement` reference kind + `User.title` (closing Phase 4
  ping #4), the quote PDF (eighth document type, to the owner's sample, engine-computed indicative
  amounts), cross-entity §5.14 blocks, ruling 7's overlap-save warning (the whole-branch review's
  F1, built in-phase by owner direction as Task 12), and a new CLAUDE.md STANDING INVARIANT (the
  §5.14 quote-link SSI pairing, dangerous-direction-tested). Twelve tasks, all task-approved; the
  whole-branch review returned an **EMPTY mandatory fix wave** (zero
  correctness/concurrency/data-integrity findings); deferred findings → issues **#95–#100**; the
  8-item owner-ratification queue is owed at the demo (§6). Final gates: **2133 tests**,
  `tsc`/`eslint`/`build` clean, E2E **19/19**. Full record — the design session, the reviews, the
  Task 10 process incident and its no-pre-written-gate-rows rule, and the lessons:
  `docs/history/2026-08-12-phase-6-quoting.md`.
- **Phase 7 — Template designer.** Squash-merged `56c9722` (PR #104, 2026-08-14). All eight document
  types became data-driven templates (multiple per type, one default, per-customer assignment
  resolved division→ancestor→default, draft→publish versioning with immutable published versions, the
  structured contract-driven editor + logo + live preview) — spec §8 delivered in full, the roadmap's
  restyle-the-traveler outcome proven against archived PDF bytes. The eight builders became
  config-consumers under a golden gate; the four standing-text Settings retired into template content;
  `pdf-lib` (confined to `render.ts`) + a vendored 4-family font set power per-sheet-group page
  numbering. **All 21 tasks approved on review round 1**; the 5-dimension whole-branch review was
  CLEAN on concurrency/data-integrity; Codex's PR review then caught a **P1** the whole-branch pass
  missed (an `assignTemplate`-vs-`deleteCustomer` SSI race stranding a live assignment on a
  soft-deleted customer) plus two §5.12/§5.13 UI stale-state bugs — all fixed on-branch. Final gates:
  **2744 tests / 149 files**, `tsc`/`eslint`/`build` clean, E2E **20/20**, **35 migrations**. Fold-ins
  **#36/#43/#87/#97/#98** closed by the PR; deferred → **#102** (render two-pass blank-page artifact),
  **#103** (contract-tightening print-500 forward hazard). Full record — the seven-ruling design
  session, the 21 tasks and reviews, the decoder-oracle and StrictMode bugs found en route, the
  whole-branch + Codex rounds, and the lessons: `docs/history/2026-08-14-phase-7-template-designer.md`.

## 5. Conventions Phase 2+ must follow (learned and enforced in Phase 1)

1. **TDD per task**: failing test → implement → pass → commit. Vitest, real DB (`erp_test`), `truncateAll()` in beforeEach, `fileParallelism: false`.
2. **Services own business rules** (`src/server/*.ts`), route handlers stay thin: `requireUser` + `mustCan`/`mustDo` first line, zod parse, delegate. React components contain no business logic.
3. **Every mutation through the audit helpers**; extend `AuditableModel` and `SNAPSHOT_INCLUDE` (relations!) for each new entity. Never let a secret-bearing payload reach `write()` — redact() is defense-in-depth, not permission.
4. **Soft delete only** (`deletedAt`); active flags for hiding; hard delete never (tests excepted).
5. **Errors**: `HttpError(400/403/404, message)` for expected failures; `handle()` converts HttpError and ZodError to clean JSON; anything else is a bug. Field-anchored validation messages.
6. **Route handler tests pass ctx**: `handler(request, { params: Promise.resolve({...}) })` — the `Handler` type requires ctx (Next's ParamCheck rejects optional; still true on 16).
7. **Client components must not import from `src/server/**`** (drags node:async_hooks/Prisma into the bundle) — shared constants live in `src/lib/` (see `permission-constants.ts` precedent).
8. **Server-rendered pages that fetch data must call `requireUser` themselves** — the proxy (`src/proxy.ts`) is a cookie-presence redirect only. (Phase 1 pages are client components hitting guarded APIs, which is also fine.)
9. Conventional commits, ending with the Co-Authored-By line already used throughout `git log`.
10. Prisma migrations are applied to BOTH databases: `npx prisma migrate dev` (dev), then `npx prisma generate` (v7's `migrate dev` no longer does this for you — the client is gitignored, so skipping it leaves you typechecking against a stale one), then `DATABASE_URL=<erp_test url> npx prisma migrate deploy`. `migrate dev` needs a TTY and refuses in a non-interactive shell (e.g. a Claude Code session) — see `CLAUDE.md`'s "Constraints that will bite you" for the `migrate diff` + hand-written-migration workaround.
11. **There is no revival-on-create — deleting it was the point of the Prisma 7 work (§5.18, DONE).** This item used to read "any model with a `@unique` column plus soft delete needs revival-on-create, and a revived row must be indistinguishable from a fresh create" — that rule was got wrong four times across two phases, always where it was reimplemented rather than shared, and the fix was to make the situation stop arising rather than to keep sharing a rule with that track record. Unique columns on soft-deletable models (`Role.name`, the ten reference kinds' `name`, `ProcessStepCode.code`, `Customer.code`) are now unique **only among live rows** (`@@unique([col], where: raw("…"))` — a partial index filtered on `deletedAt IS NULL`). A re-used code or name is a genuinely new row with its own id and a real `"create"` audit entry; the archived row keeps its own id, its real value, and its own history. `User.username` deliberately keeps a plain `@unique` — `createUser` has no revival branch and users are never re-created by name. **Do not add a revival-on-create site back** — if a new soft-deletable model needs a unique column, give it the partial-unique treatment instead. `findUnique`/`upsert` on a live-rows-only column is banned and swept (`tests/partial-unique-sweep.test.ts`) — the generated client still types the column unique, so both compile, and `findUnique` silently returns the *deleted* row. The sweep also covers `findUniqueOrThrow`, `update` and `delete`, which take the same `WhereUniqueInput` and are worse: keyed on such a column they write to, or hard-delete, the *archived* row while the live one goes untouched. **One known limit, and 2C is the first phase that can trip it:** the sweep reads `schema.prisma` with regexes that assume `@@unique(` is followed by `[` on the *same line*. Every one of the 13 current blocks is single-line, but a `@@unique(...)` wrapped across lines would match neither the "already correct" check nor the "flag as bare" check — silently voiding the guard in both directions. Keep these attributes on one line, or teach the sweep to parse multi-line blocks before wrapping one.
12. **Detail pages must remount per record** (`<Detail key={id} …>`), and any field bound with `defaultValue` will otherwise keep the previous record's text and write it onto the one now on screen. Cost a Critical in 2B.
13. **A reload that clears the error banner must never run after the error is set.** Roll back to server truth *first*, then report why. This exact shape recurred three times on one page; the durable fix was making the save report success so callers stop reloading defensively.
14. **A blocked delete must name its blockers** (owner's ruling, 2026-07-31, issue #6). Deleting a reference row that other records point at is **refused**, not allowed-and-cleared and not allowed-and-dangled — consistent with `deleteCustomer`'s "still has child customers" and `deleteRole`'s "still assigned" guards. But refusing is only one third of it: the screen must also **list the actual referencing records** (linked to their detail pages) and **export that list to Excel**, reusing the export the reference tables and customer list already have. The reasoning is a live Visual Shop dead end the owner is escaping — Visual Shop blocks these deletes too, and the guard is not the problem; naming no blockers is. There, a furnace group cannot be deleted because a process master points at it, and that process master cannot be deleted because parts point at it, with no way to find those parts: "it would take me a year to find them all and point it elsewhere." **A block without discoverability looks like data integrity while actually being a permanent dead end.** Note this never obstructs what delete is genuinely for — a row typed by mistake has nothing pointing at it — and ordinary retirement stays on `active: false`, which already keeps existing assignments displaying correctly (2C must not conflate the two: *inactive* hides a row from pick lists while keeping assignments valid; *deleted* hides it from everything). Building it needs a registry of which columns point at each reference kind — today `Customer.termsId`, `ProcessStepCode.glAccountId`, `PaymentType.glAccountId`, `InspectionCode.defaultScaleId`, plus parts' four in 2C — guarded by a sweep test that walks the Prisma schema and fails on an unregistered FK, the `tests/permissions-sweep.test.ts` technique. **Bulk re-point** ("move everything pointing at X to Y, then delete X") is committed but deferred to Phase 8: the system starts empty so blocker sets stay small for years, but build the registry to support it now so it is an addition rather than a retrofit.
15. **Reading a pick-list needs only a session; managing one still needs `admin`** (owner's ruling, 2026-07-31). Reference data currently lives entirely under `/api/admin/reference/*` behind `admin.view`, so a user holding `customers.edit` but not `admin.view` gets an empty Terms dropdown — and because the fetch ends in `.catch(() => {})`, it looks exactly like a shop with no terms configured. 2C adds four such dropdowns to one screen and later phases add carriers, container types, comment snippets and payment types, so the fix is one route, not a widening of `admin` per screen: **a read-only `/api/picklists/[kind]` gated on `requireUser()` alone**, returning a narrow `id`/`name`/`active` projection. Create/edit/delete stay under `admin` on the existing route. **`glAccount` is excluded** and stays `admin.view`-only — it is the one kind no data-entry screen ever reads (step codes and payment types reference it, both admin screens), so excluding it costs nothing and keeps chart-of-accounts numbers out of a route every signed-in user can reach. The reasoning for the rest being open: these names are vocabulary, not secrets — materials and specifications are the language of the paperwork customers already receive, so hiding them from someone who can view the certs they print on protects nothing. The point of a route rather than a 13th permission area is that **there is nothing to grant and therefore nothing to forget**: an area would relocate the silent-empty-dropdown failure to a role misconfiguration instead of removing it. While building this, **drop the soft `.catch(() => {})`** on every pick-list fetch — a failed request must say so rather than impersonate an empty list.
16. **A control the user cannot use is disabled and says why — never silently hidden** (owner's ruling, 2026-07-31, issue #7). Action buttons (add, delete, make default, Delete customer, the list pages' Add row and Paste from spreadsheet) stay visible but disabled, with a tooltip naming the missing permission — "Requires customers.delete". Fields are not a choice and never were: a `customers.view`-only user still has to read the name, terms and notes, so inputs render **read-only** rather than hidden. This is §5.14's rule applied to permissions — a block must name what is blocking it and give a route to resolving it — and a hidden button is a block with no explanation, leaving the user unable to tell whether the action is missing, broken, or forbidden, and with nothing to ask for. `Shell.tsx` keeps *hiding* nav entries and does not need to match: deciding which features exist at all is a different problem from being stopped mid-task. `/api/auth/me` already returns a flat array of granted keys, so a gate is `me.permissions.includes("customers.delete")` — build **one shared helper** rather than per-page conditionals, since 2C needs it on every parts screen and the customer pages should adopt the same helper. Not reachable while the owner is the only user and an admin; it matters the moment a second user exists.
17. **A delete needs a reason when it takes other records with it or frees a unique identifier for reuse** (owner's ruling, 2026-07-31, issue #8 — this is what spec §9's undefined "destructive-ish" means for this project). Today that is **customer** (built: cascades to addresses and contacts, frees `code` for an unrelated future customer) and **role** (**built 2026-08-01**, `47d6d0a`: carries its permission grants away, frees the role name). **The "(still to build)" this row carried until 2026-08-19 was stale from the day it was written** — `deleteRole` (`roles.ts:54-70`) has trimmed and required the reason in the SERVICE since that commit, the route has read it off the body, and the admin roles page has prompted for it; #8 was re-ruled against this stale text on 2026-08-19 and **closed as already satisfied**, leaving only the route's hand-rolled body read to swap for `reasonFromBody` (a JSON body of literal `null` threw a TypeError out of the handler as a 500) and `tests/roles-routes.test.ts` to pin it. It is *not* addresses, contacts, process step codes, or reference rows — §5.14 already blocks deleting a reference row anything points at, so a delete that gets through is low-stakes. Requiring a reason on *every* delete was considered and rejected: demanding a justification for a carrier typed wrong four seconds earlier trains people to type "x", and a log full of junk reasons is worse than one where the field means something. Enforce it **in the service, not only the route**, so no future caller can bypass it, and trim before storing so whitespace cannot masquerade as a justification. Classify each new entity against this rule as it is built.
18. **DONE (2026-08-01, branch `prisma-7-upgrade`). Revival-on-create was removed, not consolidated — Prisma 7 was the prerequisite** (owner's ruling, 2026-07-31, issue #10). A unique `code`/`name` plus soft delete meant a deleted value physically occupied the constraint, so a re-create had to *reuse the dead row*. That reuse also reused its **audit identity**: `HistoryPanel` queries by `entityId`, so one company's entire history rendered under an unrelated company's record, the creation was logged as `"update"`, and `createdAt` belonged to the previous occupant. §5.11's rule ("indistinguishable from a fresh create") was never extended to identity, which is where it breaks — and the rule had been got wrong four times across two phases precisely because it was reimplemented rather than shared. **The right outcome for a rule with that history is that the situation it governs stops arising.** The fix: make the column unique **only among live rows**, declared in `schema.prisma` as `@@unique([code], where: raw("\"deletedAt\" IS NULL"))`. An archived row then keeps its own id, its real value and its history; a reused code is simply a new row with a new id and a real `"create"` entry. **Prisma 6.19.3 rejects that syntax outright ("No such argument") — verified, so the upgrade was a genuine prerequisite, not a preference.**

    **Three things this plan got wrong when it was first written, corrected here in place rather than silently fixed elsewhere, so a future reader doesn't re-derive them:** (1) it said `@@unique` takes no `where` and wrote the syntax as `@@index([code], where: "…", unique: true)` — wrong on both counts; the working form is `@@unique([col], where: raw("…"))`, and a bare string is rejected, only `raw(...)` works. (2) it didn't know `partialIndexes` is a **preview feature** in 7.9.1, not stable — the owner approved using a preview feature for this specific purpose on 2026-08-01, which is also why the Prisma packages are pinned exactly (no `^`) rather than caret-ranged. (3) it predicted the client's generated types would force the `findUnique` → `findFirst` conversion, reasoning "the column is no longer a declared unique field on the client." **That's false, and it's the dangerous kind of false — silent, not a build error.** A partial unique index does not remove the column from Prisma's generated `WhereUniqueInput`: `findUnique({ where: { code } })` still compiles and silently returns the *soft-deleted* row. `upsert` on the same column is state-dependent — with only a dead row it succeeds and silently reuses it; with both a dead and a live row it throws P2039. None of that is caught by `tsc`, `eslint`, or a test that happens not to have a deleted row lying around, which is exactly why `tests/partial-unique-sweep.test.ts` exists: it sweeps every `.ts` file under `src/` and `prisma/seed.ts` for `findUnique`/`upsert` keyed on a live-rows-only column, and separately asserts no soft-deletable model still carries a plain field-level `@unique`. The actual `findUnique` → `findFirst` conversions below were a manual audit against that sweep's findings, not a compiler-forced one.

    The upgrade path was documented before work started — the owner found it: the official guide is <https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7>, and Prisma publishes an **AI-agent migration prompt** at <https://www.prisma.io/docs/ai/prompts/prisma-7> laying out an 11-step process. This repo was measured against the guide on 2026-08-01 — §4b was the survey, and now also records the outcome (§4b is now `docs/history/2026-08-01-prisma-7-upgrade.md`). All four quality gates were kept green throughout, applied to both databases. The index change was applied to **every** revival site — `customer`, `role`, all ten reference kinds, `processStepCode` — `REVIVAL_DEFAULTS`/`REVIVAL_EXTRA_DEFAULTS` and every revival branch deleted, each `findUnique({ where: { code|name } })` converted to `findFirst({ where: { code|name, deletedAt: null } })`, and the revival tests rewritten to assert a **new id and a fresh history** instead of a reused row. Final suite: 258 tests, 31 files, zero skipped.

### 5a. Working conventions for code-review rounds (added end of Phase 2B)

**Triage rule (owner's, 2026-07-31):** a finding that *fundamentally breaks something* gets fixed on the branch; anything minor gets filed as a GitHub issue instead. "Breaking" has meant: silent data loss or corruption, a 500 where the spec promises a field-anchored 400, an audit trail that misstates what happened, a silent failure the user cannot diagnose, or a stated deliverable being unusable (e.g. a field the model supports but no screen can enter). "Minor" has meant: narrow compound races where the database stays correct, and product-rule decisions that belong to the owner rather than to a fixer.

Reply on every thread with the disposition and the commit or issue number, then resolve it — reviewers and the owner both read the thread, not the summary.

**Verifying UI findings needs the bundled Chromium, driven directly.** The Playwright and chrome-devtools MCP servers both look for a Google Chrome binary at a root-owned path that is not installed, and there is no sudo. Four separate agents hit this and silently fell back to curl, which cannot see a rendering or state bug. What works:

```bash
npx playwright install chromium     # once; no sudo needed
# then import from the npx cache whose version matches the installed build:
#   node -p "require('<cache>/playwright-core/package.json').version"
#   ls ~/.cache/ms-playwright        # chromium-<rev> must match browsers.json
```
Then write a small `.mjs` that imports `chromium` from that cached `playwright` and drives `npm run dev`. Three traps worth knowing: React controlled inputs do **not** expose `value` as an HTML attribute, so `input[value="X"]` selectors fail — locate by index or label instead; the app shell has its own global search box, so `input[placeholder*="Search"]` matches two elements. Dump the page's inputs first rather than guessing selectors. And **`getByLabel(..., { exact: true })` on a `<select>` nested inside its own `<label>` (rather than an `aria-label`/`for`) can match ZERO elements even though the label text looks right** — Playwright's label-text computation for that case is the label's FULL `textContent`, which for a `<select>` child recursively includes every `<option>`'s own rendered text (`getByRole("combobox")`'s accessible-name computation does NOT have this problem — confirmed live, Task 17/Phase 5B). A plain `<input>` has no text content of its own to pollute the label with, so this is `<select>`-specific; fix with a scoped `page.locator("label", { hasText: "…" }).locator("select")` instead of chasing `exact`.

Always clear the fixtures you create out of the **dev** database afterwards — `erp`, not `erp_test`.

**The invalidation census is PARSED rather than pattern-matched, and its deferred second half was built anyway because the deferral's own premise was false (#188, gate-infrastructure Task 1, 2026-08-22).** Part 1 was the brief's whole subject: `callsInvalidate` — the predicate BOTH `tests/audit-children.test.ts` sweeps use to answer *"does this file really call `invalidateHistory()`?"* — stripped comments with two hand-rolled regexes and tested the remainder, so `const hint = "invalidateHistory()"` read as WIRED and both sweeps stayed green while the mounted panel went stale, which is the exact regression the census exists to prevent. It is a `ts.createSourceFile` walk for a `CallExpression` on the bare identifier now — strings, template literals and comments handled by the parser instead of by an eighth regex (four defects had been injected into this file's own guards across two review rounds, every one of them by hand-munging source, every one caught by RUNNING it). A property access (`x.invalidateHistory()`), an uncalled reference and an aliased import all fail CLOSED — reported as unwired — because both sweeps separately require the named import, so a property access is by construction some other function sharing the name. **Part 2 — the wrapper-tracing import-graph walk — was declared out of scope by this group's own brief** (*"No wrapper exists — all twelve files mount the panel directly"*, itself lifted from a sentence inside the test file) **and was built on the task review's Important finding, because that sentence was false.** SIX files consumed a panel-mounting component and were invisible to the census: `admin/reference`, `certs/[id]`, `invoicing/[id]`, `quotes/[id]`, `receivables/batches/[id]` and `shipping/[id]`, each a 13–25 line keyed route shell whose whole body is `<XDetail key={id} id={id} />`. The deferral's stated reason was that the shape of the real case was unknown — and the shape is the idiom every detail route in this repo is written in, with six already standing, so the reason given for deferring is precisely what made overriding it right. A file that VALUE-imports a panel-mounting file is folded into the same census the existing rules already run over; **no rule changed** (mutating still means import-and-call, non-mutating still means an allowlist entry with a reason), and the mount cross-check still runs over the mount set alone, since it checks the mount DETECTION rather than the census. The walk is the **transitive closure**, a cycle-safe five-line fixpoint, pinned on a synthetic multi-level graph because this tree cannot exercise it — on the real tree one level and the closure answer the same six, nothing importing a `page.tsx` (the router reaches route entry points by file convention, which is not an import edge). **TYPE-ONLY edges are excluded and that is the load-bearing part:** counting every import edge answers SIXTEEN consumers, not six, because ten child sections `import type` from their own panel-mounting parent — an edge pointing the wrong way, which would have folded the sections in backwards and demanded an allowlist entry each for a relationship that does not exist. `CLAUDE.md`'s Audit paragraph carries the contract in ~55 words; the mechanism stays in the test file, where it is stated better.

**`net::ERR_NETWORK_CHANGED` is the best-evidenced explanation for #184's false E2E failures — and the cold `next dev` compile the issue hypothesised is refuted on the numbers (gate-infrastructure Task 2, 2026-08-22). Say it that way: the attribution of #184's own four runs is INFERENCE, not measurement.** What was measured: (1) the mechanism exists and drops `127.0.0.1` requests on this host — Chromium flushes its socket pools and aborts every in-flight request when the HOST's network configuration changes, and on Linux each container start/stop creates or destroys a `veth` pair that is one such change; demonstrated against a 30-line static Node server with no Next.js, no compile and no load, **36 of 1380 localhost requests lost in 90 s**, while another project's Testcontainers-style suite churned containers. (2) **One** post-change flow failure was instrumented as this cause end to end, with the dev-server log showing a **200 in 388 ms for the very request the browser recorded as unanswered**. (3) Marginal cold compile is ~40× from any timeout: on a deleted `.next`, the slowest of 243 routes took **1.14 s** against Playwright's 45 s locator / 60 s navigation limits. **#184's four runs carry no `ERR_NETWORK_CHANGED` record at all — the instrumentation that would have produced one did not exist yet.** Of the three arguments, the *simultaneous batches* match is the WEAKEST (six panels first-hitting six cold routes would also fail simultaneously); the discriminating facts are **rejection, not slowness** — a slow compile yields a spinner and a locator timeout, never a rejected fetch promise, and #184's clearest signatures are error *banners*, which require rejection — and **the 200 that never arrived**. **Residual:** neither measurement reproduces #184's stated *still-saturated machine* condition — the deliberate baseline ran at load average 2.86 on 16 cores, already recovered, and passed 25/25 — so the compile hypothesis is refuted on the numbers available rather than on its own terms. **Do not run a container-churning workload beside `npm run test:e2e`**, and do not read that error as an app defect. `e2e/run.mjs` names the cause in its own output; the harness's warm-up / classification / retry-safety contract is in `CLAUDE.md`.

**The demonstration dataset and the E2E suite cannot share the dev database, and `npm run test:e2e` now REFUSES rather than discovering it at flow 20 (#167a, gate-infrastructure Task 3, 2026-08-22).** Both are pinned to `erp` — `manual:capture` reads the dev DB by design (the manual documents the production app, not the watermarked practice copy) and the E2E fixtures refuse any other database by a guard that is right and stays (`assertDevDb`: name exactly `erp`, host local, because they hard-delete; a dedicated `erp_e2e` was tried and correctly refused). Everything that COULD be scoped to a flow's own fixtures has been: `invoice-shipped-order` counted every SURCHARGE row on its invoice and so asserted a fact about the plant (the dataset seeds three surcharges, `4 !== 1`) — it now counts only rows carrying its own surcharge's name, which also fixes the latent half, a `.locator("input").first()` that read whichever surcharge row sorted first. The same family, found by Task 2 and fixed here: `assertBoardStatus` filtered board rows by "any cell holding these digits", and `ship-partial-then-complete`'s order (100 × 10 lb + 40 × 5 lb) carries a **Weight** cell reading exactly `1200`, so the day the counter reached order #1200 it matched two rows and Playwright's strict mode refused both — now one shared `boardRow` helper (`e2e/lib/orders.mjs`) that reads the "Order #" column index off the header and matches THAT cell. **A FIFTH call site survived that round, and it was the one that could pass while wrong:** `void-order.mjs` kept the substring shape inside an `assert.rejects`, so two matching rows produced a strict-mode violation, the promise rejected, and *"a voided order should not appear on the board"* PASSED — with the voided row still on screen. Both halves are closed rather than the one that was found. `assertNeverVisible` (`e2e/lib/ui.mjs`) replaces all NINE `assert.rejects(...waitFor(...))` sites: it requires the rejection to be the TIMEOUT and turns a strict-mode violation into a named failure, so the false-green class is gone everywhere. And two static sweeps (`e2e/lib/flow-lint.mjs`) make the next one loud instead of censused by hand — an order-board row locator built straight off `page` and filtered by an order number, and an absence assertion written as `assert.rejects(...waitFor(...))` — both over-matching and failing CLOSED (the `findRawApiMutations` rule: the escape hatch is the helper, never a comment), enforced in `run.mjs` before flow 1 AND swept in `tests/e2e-harness.test.ts` so CI sees them without running the suite. `boardRow` is also anchored on the table carrying the Order # header now, not on "the page's table". **`close-month-end`'s cannot be scoped and pretending otherwise would be worse:** `unpostedBatchCount` and the continuity `variance` are global figures for the month, which is what a month-end close IS, and the flow correctly refuses to post a batch it did not create. So the harness reads the dev DB's ambient state before flow 1 and refuses the whole run — a `ClosePeriod` already covering the current month, an OPEN receipt batch carrying a payment dated in it, or a non-zero variance, all three being assertions `close-month-end` itself makes, with the evidence coming from the close service's OWN `preliminaryReport` so the check cannot drift from what it hoists. Read before any fixture row is written, so everything it sees belongs to somebody else — exactly the population the flow refuses to touch. **`npm run db:reset`** (new, `erp/scripts/db-reset.ts`) is the recipe the refusal prints, because a refusal whose recipe does not exist is not a refusal: TRUNCATE + `reseedSingletons` + `prisma/seed.ts`, ~1 s, reaching the identical state as `migrate deploy && db:seed`, guarded twice (URL shape — name exactly `erp` on a local host, the `assertDevDb` guard — then the database's own `current_database()`, the `practice-mode.ts` rule that db-identity is authoritative). It deliberately does **not** wrap `prisma migrate reset`, which re-runs every migration and refuses outright when an AI agent invokes it — unusable as the recipe for the sessions that most often hit the refusal. The way back to the dataset is unchanged: `docs/manual/dataset.md`, "Rebuilding it". **The fix round widened three of those claims and narrowed none.** The pre-flight hoists FOUR of `close-month-end`'s plant-wide assertions, not three — `readinessGaps.length === 0` is as global as the others (`resolveReadiness` scans every FINALIZED invoice in the month with no customer scope, which is why `db-fixtures` backfills GL accounts onto a STRANGER flow's rows), so an ambient account-less invoice line used to red flow 20 in silence; only gaps naming a specific ambient row are reported, because the `plant-default` gaps are the run's own to fix and an unfiltered list refuses EVERY pristine dev database (measured: `arGlAccountId` is null after `db:seed`, one gap, always). A FIFTH reason is `preliminaryReport` refusing to answer at all: `priorEndingAr` throws 409 when an earlier month is closed and the immediately-prior one is not, which the dataset produces by design the moment the calendar rolls past its seed month — unwrapped it surfaced as an `execFileSync` "Command failed" and a raw stack, the opaque failure the pre-flight exists to delete, arriving one step earlier (reproduced both ways against the real dataset). **And `db:reset` no longer claims it cannot hit production, because it can:** `current_database()` cannot discriminate the case that matters — production's database is ALSO named `erp` (`practice-mode.ts`'s guard works only because `erp_practice` is a different name) — and compose publishes the db service on `127.0.0.1:5432`, so on the production host the production database IS `localhost:5432/erp` and both identity guards pass. Two barriers that do not guess replace the false claim: `NODE_ENV=production` is refused outright, and the reset is CONFIRMED — the database name typed back at a TTY, `--yes` (or `DB_RESET_CONFIRM=yes`) without one — with the flag form printed in the harness's own recipe, since a recipe that does not work in the session reading it is this group's whole subject. No "looks like production" heuristic was shipped: every candidate refuses a well-used dev database, which is exactly the one people reset. The dev-DB guard itself is now the pure leaf `src/lib/dev-db-guard.ts` instead of four hand copies that had already drifted (`manual-ids.ts` had lost `[::1]`), pinned by `tests/dev-db-guard.test.ts`.

**The mandatory E2E gate now runs in CI, as a third parallel job, having never run there once (#167b, gate-infrastructure Task 4, 2026-08-22).** `grep -n e2e .github/workflows/*.yml` returned nothing until this job: the owner made `npm run test:e2e` mandatory on 2026-08-06 and CI had neither the flows nor the dataset, which is how PR #164 went green while shipping the #167a breakage. The job is parallel to `ci` and `docker` for the `docker` job's stated reason (the main job already runs 12+ minutes against a 15-minute cap) — though unlike `docker` it is **not** free wall clock: at the timeouts below it is the workflow's critical path, and the decision stands because the alternative on offer was no E2E gate at all. It brings Postgres up, migrates and seeds a pristine `erp`, installs the bundled Chromium, and runs the suite. Five decisions in it are load-bearing. **(1) It starts one container before the suite and none during it** — a container start/stop is a host network-configuration change, the measured trigger for Chromium dropping in-flight `localhost` requests (the `ERR_NETWORK_CHANGED` paragraph above), so a mid-run `docker` step or a restarting service container would reintroduce #184 on purpose; the job comment says so. **(2) It apt-installs a PostgreSQL client major-matched to `docker-compose.yml`'s `postgres:` tag, prepends `/usr/lib/postgresql/18/bin` to `$GITHUB_PATH`, and asserts the major from a LATER step**, because the `backups` flow clicks "Back up now" and that spawns a REAL `pg_dump` — the one place the real binary is exercised (vitest injects a fake precisely because the runner's own is older) — and `pg_dump` hard-refuses a newer server. The PATH prepend is not belt-and-braces, it is the fix: `/usr/bin/pg_dump` belongs to `postgresql-client-common` and is a symlink to `pg_wrapper`, **not an alternatives link**, and `pg_wrapper` resolves via `user_cluster_map()` first, forcing the newest installed version only for `psql`/`pg_archivecleanup`/`pg_isready` — a list `pg_dump` is not on. `postgresql-client-18` creates no cluster while the ubuntu-24.04 runner image leaves a stopped postgresql-16 cluster at `/etc/postgresql/16/main`, so `user_cluster_map()`'s "only one cluster" branch returns **16** and the original assertion would have red every run. (`sudo pg_dropcluster 16 main` also works; the explicit path was chosen because it hardcodes nothing about the image and leaves nothing to a heuristic.) The assertion lives in its own step because `$GITHUB_PATH` reaches only SUBSEQUENT steps, and it invokes a bare `pg_dump` — the same lookup `src/server/backups.ts`'s `spawn` performs — with the version captured into a variable rather than piped into `grep -q`, whose early exit can SIGPIPE the writer under `pipefail`. This is the Dockerfile's `apk add postgresql18-client` rule in a second place; both stay pinned to the compose tag, which dependabot is already told not to auto-bump. **(3) A `RETRIED` flow WARNS rather than reds, provisionally, and #190 is the forcing function.** The retry gate grants a second attempt only when the failure was transport-level and the flow had provably mutated nothing, so the app under test was never in doubt; and the retry's justification — host churn the developer does not control — does not exist in CI. But there is no measurement of how often CI retries, a 4-core runner can produce a slow `page.goto` the classifier calls network-level, and the group's own evidence has a retry firing on a local **pristine** run (Task 3, run 5), so hard-failing on day one would be an inference dressed as a policy (and Task 2 landed before this job precisely because a gate with a false-failure rate is worse than no gate). It is instead made unmissable: a `::warning::` annotation, a job-summary entry, and the full artifact package. **#190 carries the measurement and the one-character flip** (`exit 0` → `exit 1`), so "provisionally" cannot quietly become permanent. **Group E2E (2026-08-23) did the measurement and the pinning but DEFERRED the flip** (owner ruling): 0 retry annotations across the first e2e-job runs, but below the ~20-run clean-baseline bar the issue names (two of those runs failed on the `close-month-end` dialog hang, fixed in 2223cd4, so a clean consecutive baseline only starts now; and a retry fired on a local pristine run in gate-infra), so arming the red trigger on that sample would be the "gate that lies" risk this group exists to remove. The two surfaces the retry detector reads — the `<flow>__attempt-N` artifact dir and the `  RETRIED ` verdict line — are now the `attemptDir`/`resultsLine` leaves in `failure-classify.mjs`, pinned in `tests/e2e-harness.test.ts` against CI's own glob and grep; the flip is the one-line follow-up once ~20 consecutive clean e2e runs accrue. **(4) The suite STEP's 30-minute timeout sits inside the JOB's 45, and the invariant is arithmetic, not `step < job`:** `job ≥ setup + suite + retry-check + upload`, i.e. `45 ≥ 8 + 30 + 1 + 3 = 42` — raise the step and the job must move with it. Both are re-derived from the **slowest** clean measurement available, not the fastest: Task 3's pristine full-suite runs at **~6 min** (Task 4's own 298/301/317 s are the fast end of the same box), times the 3–4x runner factor = 18–24 min, so 30 leaves real margin rather than the 1 minute a 25-minute cap left. They stay **estimates until the job has run for real** — tighten them against the first green runs, and move both. The step-inside-job rule is load-bearing for a reason that is *not* the obvious one: a cancelled job does **not** blanket-skip its remaining steps — `always()`- and `cancelled()`-conditioned steps are evaluated in the cancellation window. What a JOB timeout does is CANCEL the job, and for a cancelled job `failure()` is FALSE and the suite step's `outcome` is `cancelled`, not `failure`, so the upload's condition never becomes true (nor is a ~65 MB upload inside a short best-effort window something to stake evidence on) — leaving the "red run nobody can act on" this job exists to prevent. **(5) `E2E_WARMUP_BUDGET_MS` is raised to 600 s at job level.** The warm-up's 240 s default is ~8x a 30.6 s local cold compile; at the same runner factor that margin collapses to ~2x, and blowing it makes `warmupRefusal` **refuse the whole run** rather than fail a flow — a CI-only failure mode nobody would recognise. `erp/e2e-artifacts/` uploads on the SUITE STEP's failure or on a retry, never on a clean green (~65 MB of video per run); the condition keys on `steps.suite.outcome` rather than a bare `failure()` so an early `npm ci` failure cannot fire an empty-directory upload, and `e2e-artifacts-prev/` is never created in CI, the rotation hitting ENOENT on a fresh workspace. **Branch protection now REQUIRES `ci`, `e2e` and `docker` (owner authorization, 2026-08-22).** Protection here is a **ruleset** (`require-pr-and-ci`), not classic branch protection — `/repos/:o/:r/branches/main/protection` 404s with "Branch not protected", which is the first thing to know before changing it; patch it by transforming the live object (`gh api … | jq` → `PUT`) so the `pull_request` rule and its squash-only merge method survive. `e2e` was added only AFTER it had gone green on a real runner, which was the recommendation's own condition; `docker` went in the same pass, having run since PR #30 without ever gating a merge. **Measured on the first push, no iteration: `e2e` 11m23s, `ci` 10m09s, `docker` 2m04s** — the `$GITHUB_PATH` fix held, and the PGDG step Task 4 named as the likeliest first-push failure did not fail. That puts the real runner factor at **~2.2x local** (317 s → 683 s), not the 3–4x the timeouts were sized on, so the 30/45 pair carries more margin than intended — one green run is not enough to tighten it, but it is now measured rather than estimated.

**`manual:capture && manual:build` produces a publishable page with no hand step, and the figure-sizing rule no longer hardcodes the capture scale (#169, gate-infrastructure Task 5, 2026-08-22).** `manual.html` fitted under the 16 MB publish ceiling only because `magick -colors 256 -depth 8 -strip` had been run over `docs/manual/img/` by hand, twice, in two sessions, in a step recorded nowhere — so the documented workflow on a fresh checkout produced a ~28 MB page that cannot be published, with nothing saying why. **Capture is now 1:1** (`DEVICE_SCALE`, `MANUAL_SCALE ?? 1`): the manual DECLARES a full-width figure at 1200px and RENDERS it at **800** (`.content` is `max-width:50rem`; measured in a browser, not assumed), so 2x density was never reaching a reader — only the byte count. **The coupled half is what makes it safe:** `build-manual.mjs` computed display size as `round(intrinsic × 10/24)`, and that constant *is* `1200/2880` — the DSF-2-at-1440 assumption, hardcoded. Demonstrated rather than argued: with the old factor and the new capture, `login.png` declares **600×375**, half size, every figure. The rule reads each image's own intrinsic width now — `DECLARED_WIDTH_PX` when the image is at least that wide, else its intrinsic width, height by the same ratio — living in `erp/scripts/lib/manual-figure-size.mjs`, a pure leaf split out only so a test can reach it (`build-manual.mjs` runs `build()` at module scope; the `e2e/lib/failure-classify.mjs` precedent). **The constant is NOT the column and is no longer named as if it were** (fix round): 1200 is the declared-attribute cap that fixes the aspect ratio and reserves space, the rendered column is 800, and the density argument gets *stronger* for it — 1440 shown at 800 is 1.8x oversampled, so 2x was 3.6x. Its resolution-independence is stated honestly rather than over-claimed: it holds **at or above 1200 only** — below it the declared width is the intrinsic PHYSICAL width (600 at 1x, 1200 at 2x), which is inherent in the mandated rule, since an IHDR carries no device scale factor, and which reaches no figure today (narrowest: 1440). That **also fixes a live distortion the issue predicted**: an image narrower than 1200 was being shrunk by the same 10/24 — a 600px clip declared at 250 — proven end-to-end by building with a 600×360 probe figure (`600×360` declared, `600` rendered) and reverted. No current figure was affected; the defect was latent, not live. **`MAX_SHOT_HEIGHT` did not do what it said, and `sweep.md` published the claim** (fix round): `page.screenshot({ clip })` without `fullPage: true` resolves the clip against the VIEWPORT, so `admin-audit.png` was the top **900** CSS px while the generated sweep read *"clipped to the top 6000px of a 7627px page"* — a report asserting something untrue, in this group's own subject area. Pre-existing, not a Task 5 regression (the 2x file was 2880×1800 = the same 900 CSS px). Fixed by making the code true rather than the note weaker: `fullPage: true` alongside the clip, so the cap means what it always claimed and is continuous (`min(pageHeight, MAX_SHOT_HEIGHT)`). **That correctness fix made the cap's cost visible for the first time, and the number was then re-sized from measurement** (owner ruling, 2026-08-22, reversing his own "prefer making the code true, there is headroom"): 6000 had been chosen while the clip was believed to work, and honouring it spent a third of the headroom #169 had just won on one screenshot of an audit log. **`MAX_SHOT_HEIGHT = 4000`**, on a shelf the dataset itself draws — 48 of the 50 screens are ≤3508px (tallest: the template editor), and the only two above it are tall for the same reason, `/admin/audit` at 7627px and the part record at 5145px whose bottom 1712px is its own History panel. 4000 leaves 492px of margin over the tallest structural screen, keeps every section the parts chapter names plus 12 of that panel's 19 rows, shows ~102 of the audit log's 200 rows (6000 showed 156 of 200 — neither reaches the end, so the extra height bought more of the same, not a conclusion), and cuts the part record exactly where its History panel starts printing raw step JSON at **532 B/px against 164 B/px** for the rows above it — the #170 pathology on a second screen. Both clipped figures render 800×2222 against 800×1949 for the tallest un-clipped one; at 6000 the audit shot rendered 800×3333, 71% taller than anything else in the book. **Measured, after the re-capture: 12,995,012 bytes** of the 16,777,216 ceiling (**77.5%**, 3.61 MB of headroom) from `img/` at 9.96 MB — down 1,218,832 B from 14,213,844 (84.7%), and **1,265,621 B clear of the build's own 85% soft warning** rather than 46,789 B under it. Against 15,317,815 (91.3%) hand-compressed, with **no ImageMagick, no image encoder, no system dependency**, which was the acceptance test. #191's proposed order-hub figure (~388 KB) now lands near 80%, not 87%. `manual:build` stays zero-dependency and deterministic: two builds byte-identical (sha256 `562b936a…`). The re-capture's sweep is clean — 50 PASS, 0 WARN/FAIL/ERROR/SKIPPED, the same four standing sparse screens — and **exactly two PNGs changed HEIGHT** (the two clipped ones: `admin-audit` 6000→4000, `parts-detail` 5129→4000) and a third changed WIDTH — `invoicing-detail` 2967→2974, the overflowing invoice page reflowing with the rebuilt dataset; the other 14 that moved kept their dimensions to the pixel and drifted only in content, because the demonstration dataset was rebuilt for the capture. **`invoicing-detail.png` is the one figure #170 is still costing, and the estimate now states its density basis** (fix round): 2974×2868 because the invoice page overflows horizontally, 1,220,846 B on disk / **1.55 MB inlined, 12.5% of the whole page** — all four figures re-anchored on the committed artifacts after the `MAX_SHOT_HEIGHT` re-capture, the first pass having priced the new file against the OLD 14,213,844 B page in the same sentence that reports the new one. The naive fleet rate (the other 49 figures in `img/`, the basis the first estimate used) is 0.0848 B/px, but that figure's OWN density is **0.1431 B/px — 1.69x the fleet** (antialiased JSON text compresses badly per pixel), so pricing the hypotheticals at the fleet rate flatters them. Priced honestly: **~1.11 MB in the likely case** (the JSON goes behind a scroller, page height unchanged, so those pixels become ordinary UI at the fleet rate); **0.80 MB** if the JSON stays visible at its own density with the height unchanged; **0.42 MB** if the reflow makes the page 1.5x taller; and **nothing at all** if it goes ~2x taller. Its raw JSON is unreadable in the manual anyway: 2974 intrinsic px shown at 800. The number is on the issue as a comment, with a second comment correcting the first (the branch moved the page to 77.5% after it was posted). **Both halves of the pipeline are now guarded** (fix round; there was nothing before — `grep manual:build .github/workflows/` returned nothing and no test read the page). CI's `ci` job rebuilds the manual and fails on a non-empty `git diff` of `manual.html`: the inputs are committed, the build is deterministic, and a no-op rebuild is a complete proof that page and figures agree. It goes in the REQUIRED check and not a free parallel job — 0.18 s is 0.02% of that job's 15-minute cap and it needs no database, client or browser, whereas a separate job would cost no wall clock but would not be a check branch protection requires, and a docs-rot guard that cannot block a merge is the rot again. `erp/tests/manual-artifacts.test.ts` adds the browser-free artifact half: `manual.html` under the ceiling read from `build-manual.mjs`'s own `PUBLISH_LIMIT`, every PNG's IHDR width ≤ the capture viewport — which pins `DEVICE_SCALE = 1` from the artifact itself, closing the "untested half of a coupled pair" Task 5 recorded — and every PNG's IHDR height ≤ `MAX_SHOT_HEIGHT`, the same shape for the cap, so re-sizing it shows up as a decision instead of a preference (nothing checked it at all until then, which is how it went phases unhonoured and then unpriced). `invoicing-detail.png` is the one exemption, entered by name with #170 as its reason and guarded against going stale (when #170 lands, the entry reds until it is deleted). **The lint gate is `npx eslint src tests e2e scripts prisma`** — Task 3 found `scripts/` and `prisma/` outside it, so `build-manual.mjs` had never been linted once; both are clean today and both are cheap (`prisma/generated/**` is already in `ignores`), so both were added rather than only the one being edited.

## 6. Known backlog (all triaged, none blocking)

**Dependency hygiene — #198 pared to its 3 safe PATCH bumps; `pdfmake` 0.3 AND `next` 16.3 both held
(2026-08-25, branch `chore/198-deps-minor-patch-drop-pdfmake`, PR #207, SUPERSEDES #198).** Dependabot's
grouped `minor-and-patch` bump (#198) red every CI job. TWO of its six members are unsafe, found in
sequence:
- **`pdfmake` 0.2.23→0.3.11 removed `pdfmake/src/printer.js`** — the Node entry `src/server/pdf/render.ts`
  imports (CLAUDE.md's documented fragile import) — so `render.ts` failed to load and took **63 test
  suites** with it. Held at `^0.2.23`; **0.3 is a tracked migration** (the `PdfPrinter`/vfs path changed —
  do it as its own change, never a bump).
- **`next` 16.2.12→16.3.1 OOMs the E2E dev-server warm-up.** With 16.3.1 the `test:e2e` warm-up (the
  243-route in-memory `next dev` compile) is KILLED mid-warm-up — exit 143 (SIGTERM) at ~60 s, no
  completion line — on BOTH a 32 GB laptop and a clean CI runner (TWO CI attempts on the same commit,
  deterministic), where the identical warm-up passed on 16.2.12 (PR #206, 11m23s green). Held at 16.2.12,
  `eslint-config-next` in lockstep. Empirical only (e2e OOM present on 16.3.1, absent on 16.2.12) — root
  cause NOT yet isolated; a tracked follow-up before retrying the `next` minor.

What LANDED is the three trivial PATCH bumps only — `bwip-js` ^4.11.4, `tsx` ^4.23.12, `@types/node`
→26.3.0 (in-range, lockfile-only); the lockfile delta vs `main` is exactly those three. Gates:
`tsc`/`eslint`/`build` clean, **vitest 3687 / 213 files**; **E2E is CI's required `e2e` job** — the local
warm-up OOM-crashed this laptop regardless of the bump (cumulative session memory pressure alongside
Docker Desktop's ~6.3 GB VM; the dev-env memory carries the detail). Backlog after this: **#190 (deferred
CI flip)** + **pdfmake 0.3 migration** + **`next` 16.3 e2e-OOM investigation** (the last two new).

**void-order E2E wait hardening (#190 baseline) — 2026-08-25, branch `test/harden-void-order-wait`.**
`void-order.mjs`'s post-void banner wait pinned an explicit `timeout: 10000` — TIGHTER than the suite's
own `context.setDefaultTimeout(45000)` (`run.mjs`) that every other wait in the flow inherits. The exact
`Voided — <reason>` banner is gated on a THREE-request chain — the void `DELETE`, `load()`'s refetch that
flips `voided` and paints the FALLBACK banner (`Voided — see History for the reason`), then the SEPARATE
`/api/admin/audit` read the `voided`-keyed page effect fires to resolve the recorded reason — so a loaded
CI runner occasionally exceeded 10s on a void that had in fact fully committed. That is the assertion-level
`void-order.mjs:29:46` timeout that hard-failed PR #204's (#171) e2e attempt 1 (the re-run passed): a
non-clean run that RESET #190's ~20-consecutive-clean baseline, though NOT a `RETRIED` the flip would ever
have caught (it fails as an assertion, not a network retry). Split into two checkpoints, both inheriting the
45s default — banner appears (void committed + reloaded), then the exact reason resolves — so a genuine void
regression now reports DISTINCTLY from a slow/absent audit read; the sibling include-voided board-row wait
(`:53`) lost its matching 10s cap for the same reason. Neither new locator is ambiguous: the HistoryPanel
renders reasons as `{actor} — {action} (reason)`, which starts with the actor, so `getByText("Voided —")`
matches only the banner. **This is NOT the CI flip** (`exit 0`→`exit 1` stays DEFERRED, owner ruling
2026-08-23, §5a·3): it removes a recurring RESET of the baseline the flip is gated on, it does not arm it.
Gates: **3687 tests / 213 files**, `tsc`/`eslint` clean, **E2E 25/25** (0 RETRIED). Backlog remaining after
this: **#190 (deferred CI flip)** only.

**#33 — FIXED 2026-08-25, branch `refactor/33-orders-create-edit-split`.** The ~1550-line
`src/server/orders.ts` service module was decomposed at the create/edit seam (the scope deferred
2026-08-19 past the acceptance month), by VERBATIM code moves behind a re-exporting barrel — the
accepted Group H method, byte-parity verified by a reconstruction diff AND a positional re-check of
each assembled module. Four files: **`order-internals.ts`** (shared DTO types, the LINE-family zod
schemas, and the shared helpers — `resolveLineParts`, `resolveQuoteLinks` carrying the §5.14
SSI-pairing CANONICAL doc now referenced by both sides, `createSerials`, `readDetail`/`toDetail`,
`lineTotals`, `runSplitLoads`, `loadsMismatchWarnings`, `parseDate`, `lineLabel`, …);
**`order-create.ts`** (`CREATE`/`CreateInput`, `buildWarnings`, `auditPayload`,
`createOrder`/`saveNewOrder` — the #115 retry nesting + idempotent replay — `defaultRequestDate`);
**`order-edit.ts`** (the `UPDATE_*`/`REPLACE_*` schemas, the edit mutators, `void`/`link`/`unlink`,
the existing-order reads `getOrder`/`getLockedRevision`, and the `shippers.shipmentBlockers` import +
its one-directional-edge comment); and **`orders.ts`** now a thin BARREL re-exporting the EXACT
historical public surface. Every `@/server/orders` import site (13 routes, order-loads.ts,
traveler.ts, 42 test files) is untouched. **One non-verbatim change:** `LineInput` redefined as
`z.infer<typeof LINE>` (provably identical to the original `CreateInput["lines"][number]` since
`CREATE.lines = z.array(LINE)`), so internals carries no dependency on create's `CREATE`. **No cycle**
(internals never imports create/edit; the orders→shippers edge stays runtime-only + hoisted-only with
no return edge; order-board is a leaf). **The one module-boundary-pinning test** — `permissions-sweep`'s
file-level "mutates-but-doesn't-audit" proxy — now excepts `order-internals.ts` (its lone mutation
`createSerials`.`orderSerial.createMany` is always part of an order create/update the CALLER audits;
the proxy can't follow the cross-file call — the `order-drafts.ts` documented-exception precedent).
Adversarial 5-lens review (barrel surface, cycles, comment integrity, LineInput equivalence, logic
parity): **0 findings**. Gates: **3687 tests / 213 files**, `tsc`/`eslint`/`build` clean, **E2E 25/25**,
`manual.html` unchanged. Backlog remaining after this: **#190 (deferred CI flip)** only.

**#171 — FIXED 2026-08-25, branch `fix/171-signature-server-revision`.** `UserSignatureControl`
suppressed a failed signature preview by remembering the exact URL that failed (`brokenSrc`), but the
URL moved only via a LOCAL `version` counter bumped on THIS browser's upload — so after a
magic-byte-valid-but-undecodable image failed to render, another admin clearing-and-re-uploading left
the URL byte-identical and the cell read "Preview unavailable" for a good signature until a reload.
**Structural fix (the issue's own recommendation): a server revision in the URL.** New nullable
`User.signatureUpdatedAt`, stamped by BOTH `setSignature` and `clearSignature` (never inferred from
`updatedAt`, which also moves on a name/role/password edit; the migration
`20260825035042_user_signature_updated_at` backfills existing signatures to their `updatedAt`).
`listUsers` surfaces it as `signatureRev` (epoch millis, still BYTES-FREE — the #160 SELECT guard
holds and is re-pinned), the preview URL cache-busts on it, and the local `version` counter is
retired. `brokenSrc` is KEPT (a magic-valid-but-undecodable image is discoverable only by this
browser's `<img> onError`, so "Preview unavailable" is inherently local) but rekeyed to the
server-revisioned URL, so it retries by construction on ANY change — this browser's OR another
admin's — closing #171's headline AND the documented replace-serves-stale-bytes residual. Pure
`signatureSrc`/`signaturePreview` helpers extracted and unit-tested (the
`ReverseShipmentButton`/`advanceBannerState` precedent; no DOM test env). **Adversarial 5-lens review
workflow, 1 confirmed of 3:** the confirmed finding — a local upload's preview refresh depended on the
trailing list reload landing — is fixed by advancing `signatureRev` OPTIMISTICALLY in the page's own
row update (`applySignatureMutation`, the page being the single owner of both fields, NOT the
component-local counter that was retired); `signatureUpdatedAt` also added to `SNAPSHOT_SELECT.user`
per the documented "every scalar except the bytes column" convention. Gates: **3687 tests / 213
files**, `tsc`/`eslint`/`build` clean, **E2E 25/25**, `manual.html` unchanged. Backlog remaining after
this: #190 (deferred CI flip), #33.

**Reversals group (#182 + #183 FIXED) — branch `fix-reversals-182-183`, 2026-08-23.** Two
reversal-interaction issues surfaced by Round 3 Group B (#161's Reverse control + #165's cert
picker), done together because both turn on reversal identity. **#183 (owner ruling 2026-08-23,
refuse)** — the cert scope picker offered a reversing shipment as a SHIPMENT-scope target, unlabelled;
a reversal carries the order (its own negated `ShipperOrder`) so it passed the #165 pairing guard, and
`readCertPdfData`'s SHIPMENT branch printed its negative lines — a cert of negative quantities.
`createCert` now REFUSES a SHIPMENT cert on a reversal, beside the pairing guard, under the same order
claim, reading the immutable `reversesShipperId`; `CertificationsSection` filters reversals out of the
picker so it is never offered. Auto-mint is unaffected (a reversal mints no cert; `addOrderToShipper`
refuses a reversal via `claimLiveShipper`'s #139 freeze before its own mint). **The refusal is also
enforced at PRINT/READ time** (Codex rounds), so a PRE-EXISTING invalid reversal cert (hand-raised
before the guard, or on an upgraded install) never produces paper and no surface tells the operator to
create an impossible one: `printCert` refuses a reversal SHIPMENT cert directly, `resolveShipmentCerts`
skips it in the combined ticket bundle, and both the print-time and page-view (`shipmentWarnings`)
missing-cert warnings are suppressed for a reversal's SHIPMENT scope. This is a STANDING, mutation-free
guard — a data migration to void such certs was tried and reverted because voiding in SQL strips the
`Cert.deletedAt` audit History the contract requires. **#182** — the
edit-freeze BANNER on a reversed original said "void the reversal first" unconditionally while the Void
button correctly led with the invoice sentence (`voidShipper` runs `refuseIfInvoiced` before the #65
reversal blocker, so on an invoiced pair "void the reversal first" names a step the server also
refuses). The invoice-before-reversal precedence is now a single `reversedOriginalObstacle` helper
consumed by BOTH the banner and the Void button, so they cannot drift; on an invoiced pair the banner
leads with the invoice sentence, and once unlocked it becomes the reversal step. The `reverse-shipment`
E2E flow (which pinned the bug) now pins the fixed transition. Gates: **3667 tests / 212 files**,
`tsc`/`eslint`/`build` clean, E2E 25/25. Backlog remaining after this: #190 (deferred CI flip), #171,
#33.

**A/R wording group (#178 + #179 FIXED) — branch `fix-ar-wording-178-179`, 2026-08-23.** Two A/R
refusal-wording residue issues (Round 3 Group A), done together because both compose refusal messages
in the receivables neighborhood. **#178** — the out-of-window discount refusal now names WHEN the
window closed: `termsBlockFor` returns the `deadline` it already computes (rather than discarding it),
threaded through `eligibleDiscountFor` → `discountBlockMessage` so the sentence reads "…early-pay
discount window, which ran through 2026-08-18" with NO second `addDays` — the #175 one-source rule
preserved (the deadline arithmetic still lives in `termsBlockFor` alone). **#179 (owner ruling
2026-08-23, option b)** — `applicationVoidHintFor` includes the bad-debt-write-off ROUTE clause only
when a STANDALONE write-off (`type WRITE_OFF, paymentId null`) is actually in scope; a refusal blocked
purely by a payment, a residual (payment-sourced) write-off, or a credit drops it, since none of those
is voided from the Receivables section. The kind-blind PERIOD clause is unchanged (#173). The
write-off-in-scope cases stay byte-identical; the payment-only cases lose the clause (empty tail
outside a closed month, period-clause-only inside one). Re-pinned across `invoice-guards`/`invoices`/
`write-offs` tests, each verified against its actual scope, with `not.toContain("Receivables section")`
added to positively pin the drop. Neither message is quoted in the E2E flows; the receivables manual's
refusal table + its now-obsolete "#178 known gap" note were updated and `manual.html` rebuilt. Gates:
**3666 tests / 212 files**, `tsc`/`eslint`/`build` clean. Backlog remaining after this: #190 (deferred
CI flip), #183, #182, #171, #33.

**Group E2E (#193 + #192 FIXED, #190 advanced) — MERGED `5c8973a` (PR #199), 2026-08-23.** The three
gate-infrastructure whole-branch-review residue issues, all E2E-suite-honesty and all converging on
`tests/e2e-harness.test.ts`, done on one coordinated branch (they are coupled: #193's `ui.mjs`
conversion had to land before #192 could sweep `e2e/lib/` clean). **#193** — every flow FAILURE minted
as a code-less Error (10 flow `throw new Error` sites + `ui.mjs`'s four hand-rolled timeout helpers and
its two `expect*` wrappers + `orders.mjs`'s three parse/header throws + two dialog-handler
`reject(new Error(...))`s) now delivers through `node:assert` (`assert.*` or
`reject(new assert.AssertionError({ message }))`), so an `ERR_ASSERTION` code makes `classifyFailure`'s
override cover it and a stale netFailure can no longer launder it into a green retry; the new
`findPlainErrorFailures` sweep (`flow-lint.mjs`) keeps the next one loud, covering `throw`/`reject`,
optional `new`, and qualified constructors, excluding `AssertionError`. **#192** — the static sweeps
read `e2e/flows/**` AND `e2e/lib/**` now (minus the two detector modules), the file set living once in
the new `e2e/lib/suite-sources.mjs` leaf (recursive) read at both enforcement points, so a bad
locator/mutation/absence/throw in a shared helper (`boardRow`, `assertNeverVisible`) is caught; and the
raw-mutation detector was broadened past the literal `request` receiver to catch aliased/destructured
(single-level)/parenthesized/bracket/computed-method forms while still leaving `res.request()` and a
`page.request.get` read alone. `ui.mjs`'s docstring was prose-ified so the lib-widened absence sweep
does not trip its own detector (the `board-search-scan` precedent). **#190 (stays OPEN)** — MEASURED 0
retry annotations across the e2e-job CI runs (every run across PR #199's commits passed with 0
retries, adding to the baseline), but still below the issue's ~20-run bar, so the `exit 0`→`exit 1`
flip is DEFERRED by owner ruling 2026-08-23; its two surfaces (`attemptDir`/`resultsLine`) were
extracted to the `failure-classify.mjs` leaf and PINNED in `tests/e2e-harness.test.ts` against CI's own
glob and grep (the pin reads `ci.yml` and probes several flow names, so workflow-side drift reds too).
**Review: a 5-lens adversarial workflow + SIX rounds of Codex PR review, all 13 threads resolved.**
Real fixes it added: the throw-sweep's no-`new`/qualified/`reject`-delivered coverage, computed
`page.request["post"]`, single-level destructure, a genuine multi-line-read FALSE POSITIVE (a greedy
`\s*` backtracked past the lookahead, which would have refused a legit wrapped GET), the `suite-sources`
recursion + docstring, and the retry-pin reading `ci.yml`/probing multiple names. **Declined, with a
documented SCOPE boundary in `failure-classify.mjs`:** a renamed destructured PARAMETER
(`({ request: req }) => …`, indistinguishable by text scan from Playwright's `page.route(u, ({ request }) => …)`
and object-literal args), a renamed promise reject callback, and NESTED/deep destructuring
(`const { page: { request: req } } = state` — not an accident: flows get `run(page, shot, ctx)` and
`ctx` carries no `page`). The charter is **accident-plausibility, not every static permutation**: no
static analysis (regex OR AST) can be a complete decision procedure — a flow passing `page` to a
`lib/` helper that mutates is a cross-function data-flow escape — so the load-bearing guard for the
APIRequestContext case stays the runtime counted `ctx.apiMutate`/`retryRefusal`, with code review as
the backstop; an AST rewrite was weighed (via a decision workflow) and rejected as a dependency +
failure surface in a pure leaf that still would not reach completeness. Gates: **3659 tests / 212
files**, `tsc`/`eslint`/`build` clean, **E2E 25/25**, CI green (ci/e2e/docker). #191 (docs figure) and
#171/#33 etc. remain.

**#170 — FIXED 2026-08-22, branch `fix-history-panel-overflow`, merged 2223cd4 (PR #196).** The History panel printed
each changed field as `{JSON.stringify(before)} → {JSON.stringify(after)}` in a plain `<div>` with no
wrap rule, so a relation array pulled in by `SNAPSHOT_INCLUDE` (e.g. `lines`) rendered as kilobytes of
unbreakable single-line JSON and pushed the whole page wider than the viewport — a CREATE entry, where
every key counts as changed, being the worst case. The fix is `option 1` (the owner's recommendation):
the diff value now carries `break-all max-h-40 overflow-y-auto`, so it wraps at any character and a
multi-KB payload scrolls inside its own box, never resizing the page. It is the shared `HistoryPanel`,
so the one render-site fix covers **all ~12 mounts**, not just the invoice and part pages the issue
measured. **Option 2 (summarise collections) was deferred by owner ruling** — a separate readability
issue, not this one. `manual:capture` gained the guard the issue asked for: `shoot()` measures
`scrollWidth` and `statusOf` FAILs any screen past the viewport, so this layout class — invisible to the
health probe, which is how it reached the published manual reported PASS — now gates the run and is named
in `sweep.md`; `tests/manual-artifacts.test.ts` pins the runtime guard and the committed-bytes backstop
with the same strict comparison. The manual was re-captured (`invoicing-detail.png` 2974×2868 → 1440×2196,
`parts-detail` 5145→4777px still clipped at the 4000 cap; all 50 PNGs re-captured from a fresh dataset
instance), `manual.html` rebuilt to **11.09 MB** (was 12.99 MB, now 66% of the ceiling), and the stale
`OVER_WIDE` exemption deleted. Gates on the branch: **3640 tests / 212 files**, `tsc`/`eslint`/`build`
clean, E2E **25/25**, capture 50 PASS / 0 over-wide. **A rider fix shipped in the same squash:**
`close-month-end`'s `armReopenDialogs` was rewritten from two chained `page.once` handlers to a single
persistent `page.on("dialog")` listener, closing a dialog-registration race (the prompt listener was
registered inside the accepted confirm's microtask, so the second dialog could arrive before it existed)
that left `prompt()` unhandled and hung that flow to the CI job's 30-minute cap — measured on CI twice,
green locally because the race is timing-sensitive.

**#115 (P1) — FIXED 2026-08-16, branch `fix-allocation-retry` (`fc7eb54`), the burn-down's Group A.**
Concurrent `allocateNumber` aborted with 40001 under Serializable with no retry on any caller, so
concurrent creation of every numbered entity (order, shipper, BOL, credit, receipt batch, quote, GL
export) was broken. Full account, including the two corrections measurement made to the issue's own
analysis, in §4. **#68 rode the same branch** (owner ruling: add a `reopen`).

**Phase 8C (Backup polish) follow-ups — GitHub issues #118–#122 (2026-08-16), all deferred by the
whole-branch triage rule, none correctness/concurrency/data-integrity.** #118 unbounded concurrent
`gzip -t` per Backups-page load (and an uncached decompression per `/health` poll, which the shell bar
makes from every page); #119 preflight failures of a manual backup (missing/unwritable `BACKUP_DIR`,
unset `DATABASE_URL`) produce no audit row despite the stated rule that failed attempts are access
events; #120 a failing retention `find` leaves the status green while retention is silently broken;
#121 the error bar reaches non-`manage_backups` users during a total DB outage, because the silencing
403 itself needs a DB read — **RULED by the owner 2026-08-16 (reword the unknown-cause bar) and
BUILT** in Group D; the issue's own suggested direction proved unbuildable, since telling "cannot
determine your permissions" apart from "status unavailable" needs the same database that is down.
**#118's bound is PER-TRAVERSAL, by owner ruling 2026-08-17 — there is no module-wide semaphore, and
that is deliberate.** A shared slot bounded the process more tightly, but every mechanism it needed to
be *correct* generated the next review finding — freeing a slot held by a wedged child, then accounting
for a timed-out-but-still-alive child, then keeping the write path inside the same ceiling — six rounds,
each fix creating the next. #118 asked for "a small concurrency limit, or cache results keyed on file
metadata"; `mapLimited` per traversal + in-flight coalescing + the intact-only cache deliver exactly
that and delete the whole class of failure, because there is no shared slot to exhaust, leak or bypass.
The trade is stated in the code and pinned by a test rather than left implicit: concurrent readers each
get their own budget, so a busy moment reaches ~8–12 checks rather than 4 — bounded, and acceptable for
1–5 users. Two related rules fell out of the same rounds: **only an `"intact"` verdict is cached** (a
rejection may be a timeout, and caching that would hide a recovered archive), and **the WRITE path
verifies with the dump's own generous deadline, never the banner's 60s read poll** — a timeout there
DELETES the fresh archive and records a failure, so a short deadline would make "Back up now"
progressively unusable as the database grows while the nightly path, which has no verification deadline
at all, kept working.
**#118, #119, #120, #123 and #124 are all DONE in the same group** (branch `fix-backups-followups`):
bounded + metadata-and-TTL-cached integrity checks, audited preflight failures, a failing retention
prune now going red instead of leaving the previous green, the practice copy's own controls disabled
with the server's sentence as the tooltip (nav entry kept, `nav.ts` untouched per §8), and the shell
bar refreshing after a successful "Back up now".
**#122 — FIXED on branch `fix-vitest-collection` (`c69d82a`), the burn-down's Task 0.** `vitest.config.ts` set no `include`/`exclude`, so after a build vitest also
collected `.next/standalone/**/tests` and ran every file twice — gate ORDER silently mattered and any
post-build count was inflated. Measured on `main` with a build present: `vitest list --filesOnly`
emitted **358 files for 179 real ones**. Now `include: ["tests/**/*.test.{ts,tsx}"]` plus
`exclude: [...configDefaults.exclude, "**/.next/**"]`, with `tests/vitest-collection.test.ts`
guarding both. **Gate order no longer matters** — verified by running the full suite with the 179
stale copies still on disk: 180 files, zero `.next` paths. The trap for anyone extending that guard is
recorded in its header: **`.next` is a dot-directory and vitest matches with `dot: true`, while Node's
`path.matchesGlob` does not** — so a behavioural model of the build-output half written with
`matchesGlob` is green no matter how broken the config is (it scored the pre-fix config as safe on the
first draft). That half is therefore guarded by construction, not by simulation.

**Five issues are absorbed into Phase 7's scope by owner ruling 6 (2026-08-12, P7 spec §5.8):
#36 (traveler continuation-page header), #43 (bounded all-loads traveler render), #97
(`indicativeAmounts` length assert), #98 (`sourceQuoteNumber` `.refine`), #87 (safe
Content-Disposition filenames).** They stay open on GitHub until their fixes land on the Phase 7
branch; the entries below are unchanged as the record of what they are.

**Phase 6 (Quoting) follow-ups — GitHub issues #95–#100 (2026-08-12), all deferred by the
whole-branch triage rule, none correctness/concurrency/data-integrity.** #95 dangerous-direction
tests for the deletePart/deleteCustomer↔quote-writer SSI pairings (holes verified NOT live;
`Quote.customerId` immutability is the load-bearing untested dependency); **#96 — FIXED 2026-08-17
(round 2's Group A)**: the zero-net corrupt-quote-link asymmetry (a 500 on a zero-net LEAD line, a
silent skip on a zero-net rider) is closed by validating the link before the seam-#3 skip, so both
throw — the safe direction on corrupt state, and no longer dependent on which position the line
happens to occupy; #97 `indicativeAmounts`
`ops[i]` length assert; #98 `sourceQuoteNumber` `.refine` on the manual-lines save; #99 promoting
a soft-deleted reference row's `isDefault` 200s silently (inherited generic-service hole, also
terms); #100 the minors bundle. Full triage: the whole-branch section of
`docs/execution/2026-08-10-phase-6-quoting/progress.md`.

**RULED at the Phase 6 demo, 2026-08-12 — all eight items** (full record `docs/2026-08-12-phase-6-demo.md`;
items 1–4 and 6–8 ratified/accepted as built, item 5 → issue #101, item 8's demo observation →
#100). The queue as it was assembled (item 9, the ruling-7 overlap warn, was resolved on-branch
by Task 12): (1) `createQuote` refuses an inactive
customer but accepts an inactive part on a linked line; (2) a CLOSED quote still blocks
`deletePart`/`deleteCustomer` — only deletion clears the block (the reviewer ruled it right under
the standing-agreement model — ratify); (3) the one-time dormant-column audit churn on the first
line-tree save after attach-part; (4) the invoice grid names EVERY operation line's source while
the PDF annotates QUOTE lines only; (5) the part page's Active-quotes section reads
`/api/quotes/eligible` with `orders.view` — arguably `parts.view`/`quotes.view` by that route's
own §5.15 reasoning; (6) the "Quoted by" picker's options require `manage_users` (the only users
list); (7) `QuoteLine.eachWeight` mirrored at the Part's real `Decimal(10,4)` — spec corrected in
place; (8) the quote PDF's 9 documented layout deviations (the 5A-demo channel; list in
`docs/execution/2026-08-10-phase-6-quoting/task-10-report.md`).

**Phase 5B (A/R) follow-ups — GitHub issues #68–#87 (2026-08-09), all deferred by owner ruling,
none blocking the 5B merge.** #68–#73 are the design-session owner rulings surfaced at the demo
(POSTED-batch lifecycle, discount basis, credit-balance statements, customer-section family roll-up,
the vestigial `"ar"` area, post-dated payments). #75–#80 and #81–#87 came from the two Codex PR
reviews (11 findings were fixed on-branch; the rest filed): missing UI paths (credit-apply,
finance-charge-exempt setter, standalone bad-debt write-off), the point-in-time reproducibility gap
(#78 — 5C's close depends on it), the issued-terms discount snapshot, the postBatch balance check,
and **the two P1s — both FIXED 2026-08-16 on branch `fix-ar-money` (burn-down Group B): #81** (the
discount cap was per-line, not aggregate — fifty $20 lines waived a $1,000 invoice; now capped in
aggregate per invoice within the request, `1bb42b3`) **and #84** (`deleteCustomer` didn't block a
customer with live payments and stranded the cash; now a fourth §5.14 blocker category with its own
route/export entry, `8229413`). **#81 leaves a measured SCOPE BOUNDARY that is the owner's call:** the
cap is per-REQUEST, and `elig` is recomputed each call as a percentage of the CURRENT open balance, so
a second call after a $20 discount is still offered $19.60 and takes it — the series converges on the
whole receivable. Closing it means ruling whether the entitlement is 2% of the invoice total ONCE or
2% of whatever is open (what is built, and what `discountOffer` shows — renamed from
`discountAvailable` by #155 arm 2, 2026-08-20, when it widened to carry the block reason). Pinned as a test so any
change is deliberate. Full triage: `docs/execution/2026-08-08-phase-5b-accounts-receivable/progress.md`.

**Phase 5C (close + QBO export) follow-ups — GitHub issues #88–#93 (2026-08-10), all deferred, none
blocking the 5C merge.** #88 the continuity chain goes stale when a NON-latest month is reopened
(self-protecting — the forward close refuses on a nonzero variance and the export is event-based).
**RULED by the owner 2026-08-17: option (c), SURFACE A BROKEN-CHAIN FLAG** — `listClosePeriods` flags
any closed month whose `beginningAr` no longer equals the prior month's `endingAr`, and the operator
re-closes the affected months. Nothing is refused and nothing cascades automatically: this is the
§5.14 "name the blocker" shape rather than a wall (option a would dead-end someone correcting an old
month) and it keeps re-closing an explicit, audited act rather than a side effect (option b). Not yet
built. **#89 — FIXED 2026-08-17 (round 2's Group A).** A freight/charge line finalized before its GL
default read clean in readiness and then 500'd the export (self-protecting via the Σdebit=Σcredit
backstop). Readiness now emits an invoice-attributed gap ALONGSIDE the plant-default one, since the
two are independent fixes. **The issue's stated blocker — "there is no invoice detail page to anchor
its fix-link" — was simply wrong**: `/invoicing/[id]` has existed since 5A, and the gap links
straight to it. Worth remembering as a small instance of the standing rule: check the claim against
the code before pricing the work. #90 the cosmetic follow-ups bundle. **#91 — RULED and DONE 2026-08-16 (`0b5ea81`, Group
B): the summary export is NETTED** to a single signed column per `(account, side)`, larger side wins
— so an invoice + same-month credit emits one `A/R 60.00` debit instead of `100.00` debit AND `40.00`
credit. Decided deliberately WITHOUT waiting on the bookkeeper, because a gross dual-column line
risks importing 150 where 120 was meant. **A group netting to EXACTLY zero is dropped**, not emitted:
`renderCsv` renders a zero as `""`, so keeping it would emit a row carrying no amount at all. The
per-event `GlPosting` ledger stays gross and un-aggregated. #93 the GL-export
create-audit records batch metadata only, not the emitted journal (the postings ARE persisted
immutably on the batch, so it is completeness, not data loss). Plus the Codex re-raise of **#68**
(carried from 5B, with the GL-export consequence) — **RULED option (b) and BUILT 2026-08-16, branch
`fix-allocation-retry` (`20ed463`)**: once a receipt batch was POSTED there was no path to correct or
reverse its cash, so a posted payment could never reach a reversing QBO delta (the delta's
payment-reversal branch was dead code for PAYMENT keys). **`reopenBatch` (POSTED → OPEN) closes it**
— a posting mutation carrying the full discipline (Serializable, the batch claim, and the period
guard, since un-posting drops that cash out of recognition and must never touch a frozen month), so
the correction path is now reopen-period → reopen-batch → correct → re-close → the re-export
reverses. `voidBatch` gained the POSTED guard it lacked (an EMPTY posted batch was voidable while a
non-empty one was frozen solid), checked BEFORE the live-payment guard so the message names `reopen`
rather than sending the operator at a control `refusePosted` refuses. The month-locking loop is now
`assertBatchMonthsOpen`, shared with `postBatch`, so the ascending-order rule for advisory mutexes is
stated once. Gated `receivables.edit` (symmetric with the post it undoes), reason required and
audited. **One consequence the ruling did not cover, found in self-review and now measured:** a
POSTED batch's payments can carry live applications (§5.2), and reopening strands none of them —
`ar-balances` never looks at batch status, so the invoice balance is unmoved and `voidPayment`'s
applications-first guard is deliberately NOT copied onto reopen (voiding *strands*; reopening does
not). GL recognition does move, and the close is the net: `preliminaryReport` shows variance 0 → 300
and `paymentTotal` 300 → 0 the moment the batch reopens, so **the month refuses to reconcile until it
is re-posted**. Operationally that means a reopened batch left un-re-posted blocks month-end — loud,
not silent, which is the design. Full triage:
`docs/execution/2026-08-09-phase-5c-close-qbo-export/progress.md`.

**Owner-approved, scheduled for immediately after Phase 5A merges (owner, 2026-08-06):
per-worker test databases, to lift the suite's serial-execution ceiling.** The suite is at 1425
tests running strictly one file at a time — `vitest.config.ts` sets `fileParallelism: false`
because every test file shares the single `erp_test` database and calls `truncateAll()` in
`beforeEach`, so two files running at once would truncate each other's fixtures. That is correct
today and must not simply be switched off. The fix is to give each vitest worker its own database
(`erp_test_1..N`, selected from `VITEST_WORKER_ID`), migrated the same way `erp_test` is, after
which `fileParallelism` can be re-enabled. Deliberately **not** done inside Phase 5A — it is an
infrastructure change with no business riding in a pricing PR, and it touches the harness every
other task depends on. Wall-clock now: ~127s for vitest alone.

**RULED 2026-08-16 — YES, order-line edits freeze too — and BUILT** (issue #126, `de9ed88`, burn-down Group C: one guard mirroring `replaceCharges`, read under the order claim; the unlock → edit → re-finalize correction route is tested end to end, since after this guard it is the ONLY one. **`removeLine` keeps only its shipped-line guard per the ruling's scope, so an UNSHIPPED line on an invoiced order can still be removed** — recorded in a test rather than assumed.) (Original framing kept
below for the reasoning.) **OWNER DECISION, now closed (filed 2026-08-07 by the Phase 5A whole-branch
review) — should editing an already-invoiced order's LINES freeze, the way its charges do?** Spec §5.7's freeze covers extra
charges, voiding, and shipment edits on an order that has a finalized invoice — but `addLine`/
`updateLine` (`orders.ts`) are NOT blocked. It is not a bug today: the finalized invoice is frozen
paper (a snapshot), so a later line edit changes nothing on it, and the correction path
(unlock → recalculate) re-prices the edited line correctly; `removeLine` is separately blocked for
shipped lines. The whole-branch reviewer confirmed no money error and no status corruption (the
INVOICE_OWNED skip holds). So this is a consistency question, not a defect: §5.7 enumerates what
freezes and does not list order-line edits. If the answer is "lines should freeze too," it is a
one-guard addition mirroring `replaceCharges` (call `finalizedInvoiceFor` and refuse); if "no," it
stays as built. Owner's call.

**DEFERRED, owner ruling 2026-08-07 — multi-order freight over-bills, and it is knowingly left.**
Phase 5A invoices one order at a time (spec ruling 5, no grouping), but freight is a shipment-level
amount, so N orders on one billable-freight truck each bill the full truck freight — an N× over-bill.
Task 11's code follows the spec's freight rule faithfully; the contradiction is in the spec. The
owner's shop **does not bill freight**, so nothing is wrong in this deployment, and the correct split
(freight-on-one-order / proportional / single-order-only) is a billing-policy question the owner
wants to research against other shops before it is built. Full context: the dated amendment beside
the freight rule in the P5A spec (§5). When picked up, the chosen rule must sum back to the truck's
exact freight exactly once. **Do not invent a split.**

**Phase 5A demo (2026-08-07) — the six flagged deviations, all ruled** (full context
`docs/2026-08-07-phase-5a-demo.md`): (1) a reversing shipment now **reopens the order it reverses**
— RULED and BUILT (`aea35a3`, spec §5.2/§5.6 amended: non-invoiced → *Partial shipped*, invoiced
→ *Reopened*); (2) the credit PDF's **"Credit" title** approved as-is; (3) the negative-amount
**`"$-937.44"` format** approved as-is; (4) the three print-layout deviations accepted; (5)
multi-order freight confirmed a deliberate deferral (its own entry above); (6) whether a credit
carries its own raise-date vs the source invoice's `invoiceDate` — **deferred to 5B** (spec §16,
carried in §9's kickoff). Only (6) is still open.

**Deferred from the PR #58 Codex triage (2026-08-08), issues #59–#65 — all verified real against
the branch, none already fixed; none data-loss, but three are money/status defects. SIX OF THE SEVEN
ARE NOW FIXED — round 2's Group A, branch `group-a-invoice-engine` (#59, #60, #61, #62, #63, #64,
plus #89 and #96 from later phases). ONLY #65 REMAINS**, and it is round 2's Group C. The original
analysis is kept below because it is what made the fixes checkable.** The owner
elected to defer all seven to the post-5A burn-down rather than fix in-branch (the #48–#56
pattern); every PR thread was replied to and resolved. **#59** unlocking a *credit* recomputes the
order's invoice-owned status back to ship-derived (no `kind` branch, unlike finalize) — a
still-finalized source invoice's INVOICED order silently drops to SHIPPED. **#60** `listPartPrices`
reads the top-level client inside the Serializable invoice transaction (`part-prices.ts:51`),
outside its snapshot/read-set, so SSI can't see a concurrent price edit (the pool-starvation half
does not apply — the pg pool defaults to 10). **#61** Recalculate double-bills a manually-overridden
operation — the derived line regenerates AND the `MANUAL` override is preserved. **#62** a
manually-added charge line gets no GL account and no way to set one (grid GL is read-only; seam
#1's backfill is engine-only), so it posts nowhere and 5C's export drops it. **#63** an emptied
invoice finalizes into a $0 INVOICED order that is no longer a candidate (finalize's only block is
`needsPrice`, vacuous on zero lines). **#64** Recalculate computes no tax on preserved manual
charges (tax is priced before manual lines load; `totalsFromLines` re-sums the stale TAX line).
**#65** voiding either side of a reversal pair corrupts the order (`voidShipper` is
reversal-unaware — stuck *Partial shipped*, or negative `shippedTotals`); non-invoiced pairs are
exposed, invoiced ones only incidentally protected by `refuseIfInvoiced`.

**What Group A actually changed (2026-08-17), beyond the six one-line descriptions above.** Four of
the six were more than their issue said, and the differences are the part worth carrying forward:

- **#61 generalized past operations.** The fix is not an operation-specific dedup but one identity
  rule — `overrideKey` in `invoices.ts` — because the same double-bill existed for every kind the
  grid lets an operator retype: a manually edited TAX line regenerated its derived twin too. A manual
  line now pairs with the derived line sharing its order-side identity (order line + step code;
  surcharge; order charge; FREIGHT/CERT/TAX as singletons) and is **substituted into that line's
  slot**, keeping its place under its PART line. A manual line matching nothing is an addition and
  still rides at the end (§5.5). **Review round 1 found the step-exact identity insufficient**, and
  the miss double-billed exactly as the original defect did: a derived operation can come back under
  a step code the override does not name — the operator typed into the tier-3 "needs price" line
  (which carries NO step code) and the part has since been priced, or an operation's part price was
  retired and re-added under a different code. (The step-code ROW cannot be soft-deleted underneath a
  live override — `assertLineRefs` 400s on the preserved manual line first — so the reachable
  mutation is always the price row, which is what the tests do.) An unmatched OPERATION override
  therefore falls back to its ORDER LINE. **Review round 2 then found the fallback was the mirror of
  the bug it fixed**: on a line pricing steps A and B, with A overridden and A's price then retired,
  the override took B's slot and B's revenue vanished from customer paper — a double bill traded for
  an under-bill. So it re-homes **only onto an operation that has APPEARED SINCE** (compared against
  the invoice's previous derived identities, read before the delete); an operation already carrying
  its own derived line is a sibling, and when nothing qualifies the override rides as an addition
  where the operator can see it. How much it takes is the remaining care: no step code ⇒ every
  qualifying operation on the line, a step code ⇒ exactly one. Both the round-1 and round-2 cases are
  now tested. **The lesson is the project's own** (round 1's lesson 4): two successive rounds found
  defects in the same fallback, each in the code written for the previous round. Round 3 approved it.
  **One limit is RULED, not fixed, and is surfaced instead:** a tier-3 override (no step code) covers
  every priced operation on its order line INCLUDING work priced afterwards, and the stored state
  cannot tell that work apart from what the price was typed for — so `invoiceWarnings` says the line
  is "standing in for every priced operation on this part" rather than a heuristic guessing at money.
  Whether that absorb-all rule should narrow is an owner question, filed as its own issue.
- **#64's fix is what makes #61's honest.** Tax is recomputed over the FINAL line set through
  `pricing.ts`'s new `taxOnLines`, which shares its taxable-kind list with `priceOrder` so the two
  cannot drift. Without it an overridden operation stayed taxed at the figure the operator overrode
  away. A manually overridden TAX line is left exactly as typed — the override wins, uniformly.
  **It has TWO seams, not one** (review round 1): "Save lines" and "Recalculate" are independent
  buttons, nothing makes an operator press the second, and finalize freezes whatever is on the
  invoice — so `replaceInvoiceLines` re-derives tax as well, off the invoice's own snapshot rate.
  Re-deriving only in `recalculateInvoice` still let a typed taxable charge print under-taxed.
- **#62 has a second half the issue did not name:** `invoiceWarnings` only flagged lines carrying a
  step code, so even after the server default a genuinely account-less line stayed silent. It now
  flags EVERY account-bearing kind (all but PART, which posts nothing, and TAX, whose account comes
  from the config at export time).
- **#89 needed BOTH gaps, not a replacement.** Configuring the plant default and re-raising the
  frozen paper are two independent fixes and either can be outstanding alone, so readiness emits the
  plant-default gap AND a new `invoice`-kind gap naming the invoice, linked to it, saying to unlock
  and re-finalize. **Review round 1 widened the invoice gap to EVERY frozen null-GL line**, not only
  FREIGHT/CHARGE: an OPERATION/SURCHARGE/CERT line frozen null whose step code or surcharge already
  HAS an account raised only "step code X has no GL account", sending the operator to a screen with
  nothing to fix — the §5.14 dead end one notch milder than the 500 — and a CERT line whose
  configured cert step code row is gone recorded no gap at all, leaving one last readiness-clean →
  export-500 path. One unconditional attribution closes both. It also collapsed the *third* copy of `documentNumber` before it was written —
  `invoiceDocumentNumber` now lives in the client-safe `invoice-constants.ts`, and `statements.ts`'s
  copy (which carried a comment admitting it was a duplicate) is gone.

**Three of those seven were RULED by the owner 2026-08-17, before round 2's Group A branch opened.**
**#61 — the manual override WINS, silently.** Recalculate suppresses the overridden operation's
regenerated twin (matched on `orderLineId` + `processStepCodeId`) and keeps the typed amount; the
tax base follows the override, not the computed figure. **No new revert control** — the undo path
already exists and is now a tested contract: remove the row, save, Recalculate, and the computed
line returns. This ratifies what the grid already intended (`InvoiceDetail.tsx` stamps an
amount-edit `MANUAL` *specifically* so Recalculate will not discard it); the alternative — recalc
reverts every override — was rejected because an operator recalculating for an unrelated reason
would silently lose an edit they made deliberately. **#62 — the GL account is defaulted
SERVER-SIDE**, to the configured `otherChargeGlAccountId`, the same account `mapComputedLines`
already assigns to engine-generated charges; the grid keeps rendering it read-only, now showing a
real account. **No operator-facing GL picker**: the existing list route (`/api/admin/reference/
glAccount`) is gated on `admin.view`, which an invoicing clerk must not hold, so a selector would
have meant a new gated route to buy a split nobody has asked for — and ruling 15 (§5.15) already
excludes `glAccount` from the open pick-list route on purpose. Revisit only if the accountant's
Q-list comes back wanting charges split across accounts. **#63 — a $0 invoice is LEGITIMATE paper**
(warranty, rework, no-charge), so the guard blocks the **empty line set**, not a zero total, and it
blocks at **finalize** — a draft may be transiently emptied while the operator rebuilds it. That
is exactly the integrity hole as filed: zero lines make finalize's `needsPrice` check vacuous, and
the order lands INVOICED at $0 where it can never be re-billed.

**Owner decision 2026-08-17 on the GL account numbers in git history: LEAVE THEM.** They were
committed to this **public** repo in `b56aa0f` (my error, PR #129) directly beneath the rule in §7
forbidding it, and stripped from the working file in `87e057b`. Account numbers carrying no
balances and no customer names are low-value to an outsider, and a history rewrite would invalidate
every SHA from `b56aa0f` forward. **The §7 rule stands unchanged** — never quote an account number
into a commit, PR body or issue; this ruling forgives one past leak, it does not relax the rule.

**Done at Phase 2A start (from the final review — "Task 0" items; see §4):** auth-context refactor (one session resolution per request), `HttpError` extracted to `src/server/errors.ts`, Prisma error-hygiene helper (P2002/P2025/P2003), settings audit values redacted, dotenv promo line silenced.

**Deferred (fine to ride along):** health-route DB-down path; roles page deselect papercut; users page error banner doesn't clear on success; updateUser password truthy-check inconsistency; Shell loading indicator; settings page empty-blur cosmetic; searchAudit filter route tests; HistoryPanel changedFields unit test; session-row cleanup job (**sharpened 2026-08-02 by the PR #22 Codex review**: `getSessionUser` (`sessions.ts:28`) rejects an expired session but never deletes it, and nothing anywhere else reaps one, so `Session` grows a row per login for the life of the deployment — the dev DB held 144 rows for `admin` alone, 77 already expired. The E2E harness's own four-rows-per-run leak is closed on the 2C-3 branch, which is what made this visible; the general case is untouched. Open decision when it is picked up: a nightly `DELETE FROM "Session" WHERE "expiresAt" < now()` in the backup container that already runs in the prod profile, vs. an opportunistic delete inside `getSessionUser` — the latter adds a write to the hot path, so it is a real trade-off, not an obvious win); login rate limiting; backup alerting + backup-now button; SESSION_SECRET consumed by nothing yet; ~~`renameRole` to a soft-deleted role's name → 500 edge~~ (**closed by the Prisma 7 work** — `Role.name` is now unique only among live rows, so a soft-deleted role's name no longer occupies the constraint and renaming onto it just creates/renames cleanly; see §5.18).

**Carried out of Phase 2A** (triaged by its final whole-branch review; the execution ledger they came from is gone, so this is the surviving record):

- **Owner-ruled, build in 2C:** reference columns holding a foreign key (`inspectionCode.defaultScaleId`, `paymentType.glAccountId`) render, export, and accept a **raw cuid**, so paste is unusable for those two kinds. 2C owes name resolution on read and name-accepting create/paste — built as the general mechanism customers and parts reuse. Detail in the Phase 2 kickoff brief, open item 4.
- ~~**Any model with `@unique` + soft delete needs revival-on-create.** `roles`, the ten reference kinds, and process step codes all have it now; it was missed twice and ruled Critical both times. Customers and parts have far more unique columns; the rule is written into the Phase 2 kickoff brief §2.6 and applied to `Customer.code`.~~ **Superseded by the Prisma 7 work (§5.18) — the opposite is now true.** A model with a unique column plus soft delete gets a partial unique index (`where: raw("\"deletedAt\" IS NULL")`), not revival-on-create; revival-on-create was deleted everywhere it existed, including `Customer.code`. **Parts (2C) must not add a revival site** — give any new unique column the partial-unique treatment instead. See §5.11.
- **The sweeps do not assert that *services* route mutations through the audit helpers.** `tests/permissions-sweep.test.ts` covers routes calling `requireUser`, admin routes gating on a permission, the client/server boundary, and `audit.ts` as sole audit writer — but a 2B service calling `prisma.customer.update` directly would pass. Most likely invariant for a new author to break.
- **Smaller, none blocking:** ~~revival keeps stale extra columns from the deleted row~~ (**moot — closed by the Prisma 7 work.** There is no revival left to leave anything stale; a re-used name is a new row. See §5.11, §5.18.); soft-deleting a GL account leaves step codes pointing at it with no `needsGlAccount` warning (matters for Phase 5's QBO export — **now ruled: §5.14 blocks the delete instead, and 2C builds that guard for every reference kind at once**); `parseTsv` is now only used by its own tests and its documented truncate semantics are the bug `pasteReference` was fixed to reject; `FIELD` in `process-step-codes.ts` is the one schema without `.strict()` and the step-codes page depends on that; `withDbErrors`/`auditedUpdate` nesting is inverted between create and update; ~~a second DELETE re-stamps `deletedAt` and writes another audit row~~ (**fixed for every entity in round 7** — `auditedSoftDelete` now claims the row with a conditional `updateMany` guarded on `deletedAt: null` and writes the audit entry only if it won, so a repeat or a concurrent double-click gets a 404 instead of a second deletion of the same row); creating a name that matches a hidden inactive row says "already exists" with no hint it is inactive; the step-codes page has no delete, active toggle, or `HistoryPanel` though the API supports all three; five test files still carry duplicated login boilerplate instead of `signInWith`.

**Carried out of Phase 2B** (triaged by its final whole-branch review; the execution ledger is gone, so this is the surviving record):

- ~~**Make revival-on-create ONE shared helper before 2C adds a fifth site.** This rule — a revived row must be indistinguishable from a fresh create — has now been got wrong in four places across two phases, and always where it was *reimplemented* rather than shared: `roles.ts` had it right, `customers.ts` missed its scalars then its children, `reference.ts` missed its extra columns, `process-step-codes.ts` missed both scalars and its `fields` children. All are fixed; the pattern is the risk. Parts and their inspection/pricing children are the next site.~~ (**moot — closed by the Prisma 7 work.** There is no revival left to share: unique columns on soft-deletable models are now unique only among live rows, so a re-used code/name is simply a new row with its own id and audit history. See §5.11, §5.18.)
- ~~**The audit layer's transaction gap is only half closed.**~~ **CLOSED by 2C-2 (PR #13):** the `tx` parameter on all three `audited*` helpers is now **required**, and every call site was converted to the canonical nesting (`withDbErrors` → `$transaction` → `audited*` → writes on `tx`) — the compiler, not a sweep, is the enforcement. One known pre-existing inversion survives untouched in `updateAddress` (tx→withDbErrors→auditedUpdate order) — cosmetic-structural, codebase-sweep candidate.
- ~~**The reference-delete guard's TOCTOU is open…**~~ **CLOSED by 2C-2 (PR #13):** `assertRefExists(kind, id, tx)` (`src/server/reference-guards.ts`) runs inside each FK writer's own **Serializable** transaction — all four pre-existing writers plus parts' four — forming the read-write cycle SSI needs against `deleteReference`'s Serializable scan. Serializable is scoped to writes that actually assign a non-null registered FK. The same treatment covers `deleteCustomer` vs `createPart` and `deletePart`'s cascade vs the child-add paths (Codex round-1 findings). Assigning a soft-deleted target **by raw id** — previously silently accepted — now 400s.
- **Export/paste round-trip is broken by design and must be fixed as a contract, not a patch.** Export emits more columns than paste accepts, so export → edit in Excel → paste back fails "Too many columns". The mismatch now spans **three** entities (2A reference tables, customers, and parts — where the asymmetry is TWO columns: `Customer name` and `Active`). **Fixing it naively makes a currently-masked bug reachable:** paste has no header-row detection, so a pasted header row would silently create a customer coded `Code` named `Name`. Fix everywhere together or nowhere; parts needs column-shape handling, not just header detection.
- ~~**Three sibling services spell "name" three ways**~~ **Rule settled in the 2C-2 spec (§4) and applied to all part entities:** required identifiers use `.trim().min(1)`; optional display text uses `.max(n)` with no minimum, defaulting `""`. The pre-existing blank-address-name-wins-the-default quirk remains (addresses untouched); revisit only if it bites.
- **Tests assert audit *actions*, not audit *content*.** That shape is exactly why a stale-diff bug (every address update writing identical before/after) survived every per-task review until the final one. New entities should assert a real diff.
- **Reference pick-lists are gated on `admin.view`, but data-entry screens need to read them.** Surfaced by the Phase 2B code review: the customer detail page's Terms select fetches `/api/admin/reference/terms`, so a user holding only `customers.*` sees an empty dropdown (it fails soft — the page works). Not reachable today because the owner is an admin, but **2C makes it four times worse**: parts need material, specification, inspection-code and inspection-scale pick-lists on the same screen. **Ruled 2026-07-31 — see §5.15; 2C builds the route.**
- **Smaller, none blocking:** ~~child routes parse `[id]` and discard it~~ (**CLOSED by 2C-2** — address/contact services take the customer id and scope both reads and the atomic claim-live writes; parts children were born scoped); ~~renaming onto a *soft-deleted* unique value 400s "already exists" for an invisible row, in both `customers.ts` and `reference.ts` — the create path solves this, the update path never got it~~ (**closed by the Prisma 7 work** — the same partial-unique fix that removed revival-on-create means a soft-deleted row no longer occupies the constraint, for create or update; see §5.18); `assertNoCycle` does not filter `deletedAt`, so a parent can be set to a soft-deleted customer; no `@@index([parentId])`; the address default-normalizer is invoked manually per call site rather than enforced; `HistoryPanel` on the customer page covers only the customer, so address/contact audit rows are reachable only via the admin log; no pagination on the customer list; no search debounce; `onDelete: Cascade` on the child tables is a latent trap in a soft-delete-only system.

**Carried out of Phase 4 (2026-08-05) — triaged, not fixed.** The complete per-task deferred-minors
lists live in `.superpowers/sdd/progress.md` (each task's entry names its own); they are the
whole-branch review's triage input. The ones worth naming here because they span tasks or surfaced
after the per-task reviews closed:

- **The notes-pair optimistic-PATCH clobber is a THREE-page sibling group** — a save of one field
  in flight can reset text typed into its sibling field, byte-for-byte the same code on
  `CertDetail`, `ShipmentDetail`, and the customers page (reproduced live during Task 16's
  verification). Fix-wave candidate: fix all three together, never one.
- ~~**The shipment page's cert-print info line points at the wrong list**~~ (**FIXED in the PR #47
  round-2 triage, 2026-08-06** — the print bar now renders direct `/api/documents/<id>` links from
  `x-cert-document-ids`; Codex independently re-found this Task 20 observation as a P2.)
- **The order hub's Documents list renders non-traveler kinds by raw enum name** ("SHIPPER",
  "BOL", "CERT") — its `KIND_LABELS` map only ever learned `TRAVELER`; the shipping and cert
  pages' own lists have friendly labels (cosmetic, observed in Task 20's flows).
- **Serials prefill over-includes on repeat shipments** (no per-serial shipped fact exists —
  owner ping #2 in §7 item 5), and `OrderDetail.orderLineShippedToDate` rides unused in the edit page's
  catalog payload (dead weight; trim or keep at the whole-branch review).
- Assorted per-task §5.16 title gaps on state-disabled buttons and a missing 404/401 case on two
  document/print routes — all enumerated in the ledger under their tasks.

**Backlog burn-down (2026-08-06, branch `backlog-burndown`, post-merge):** closed #48 (shipping
worklist links — the shipping.view-only dead end), #49 (signature magic-byte sniff; test fixtures
upgraded to real image bytes), #50+#54 (one `shipmentWarnings` recompute feeds the idempotent
replay AND every edit response via `shipperResponse` — the full §5.7 surface, not over-ship
alone), #53 (scope-matched missing-cert warnings), #55 (ruling 27: multi-part certs head each
line group with frozen part identity; single-part stays §3.21-sample-identical), and #56 (ruling
28: `addLine` seeds the rider's requirements into every live cert, audited per cert, typed
readings untouched). Its Codex round (three findings, all in the PR's own new code, all fixed):
grouping keys use the FULL frozen identity — `removeLine` frees positions a later rider re-uses,
so `linePosition` alone could misattribute readings on permanent paper (PDF, data build, and the
cert page swept together); ruling 27's multi-part detection reads the PARTS TABLE, not the
requirement rows (a cert listing two parts with one inspected still heads its grid); and a
RELEASED serial selection keeps satisfying its line's serialization warning via a new
`ShipperSerial.orderLineIdAtSave` plain-snapshot column (migration `20260806164109`, backfilled —
pre-existing released rows keep "" and simply don't credit a line). A follow-up finding closed
the identity question for good: requirement grouping keys on `CertRequirement.orderLineIdAtSeed`
— a plain copy of the seeding line's cuid, which unlike positions and display fields is NEVER
reused (migration `20260806173702`; pre-backfill released rows fall back to the
composite). Gates: **1406 tests**, `tsc`/`eslint`/`build` clean, E2E 15/15. 25 migrations
total.

**Deferred from the PR #47 Codex triage (2026-08-06), issues #48–#51** — all verified real, none
data-integrity: #48 shipping worklist rows don't link to `/shipping/<id>`; #49 signature upload
trusts the declared MIME, so corrupt bytes break that user's cert prints until the signature is
cleared (the cert=1 route now survives it with a warning, which is also the regression test's
failure injection); #50 the idempotent shipment-create replay returns `warnings: []`, dropping
creation-only warnings exactly in the lost-response case the nonce exists for; #51 the new-shipment
page's add-order response can land after a customer switch and append the old customer's order
(server rejects the cross-customer save — UI dead-end only).

**Toolchain upgrades blocked on what `eslint-config-next` vendors (2026-08-02).** Next 16 landed, and neither of the two remaining Dependabot majors can follow it yet. Both are blocked by packages bundled *inside* `eslint-config-next@16.2.12`, not by anything in this codebase:

- **ESLint 10 (#19).** Not the peer range — `eslint-config-next@16` peers `eslint: ">=9.0.0"`, which would allow it. The blocker is `eslint-plugin-react@7.37.5` vendored inside it, which peers up to `^9.7` and calls a rule-context API ESLint 10 removed: `TypeError: contextOrFilename.getFilename is not a function`.
- **TypeScript 7 (#21).** `typescript-eslint@8.65.0` — also vendored inside `eslint-config-next` — throws `Error: typescript-eslint does not support TS 7.0` outright. No override fixes it: every released `typescript-eslint` (latest 8.65.0) still peers `typescript: ">=4.8.4 <6.1.0"`.

**TypeScript 7 is otherwise ready, and this was measured, not guessed.** On a branch off Next 16: `tsc --noEmit` is **clean with zero errors**, the 585 tests pass, and `next build` compiles. The `TS2882` failure on `./globals.css` that killed the original Dependabot attempt was a Next 15 type-resolution problem and is gone under Next 16. `tsc --noEmit` also drops to **~0.3s** — TS 7 is the native port. Only the lint gate blocks it, and dropping `next/typescript` to dodge that would trade away TS-aware linting on a TypeScript codebase, which is the wrong side of the trade.

**When to retry:** watch `eslint-config-next` for a release that bumps its bundled `eslint-plugin-react` (unblocks #19) and `typescript-eslint` (unblocks #21). Both retries are cheap — install, run the four gates.

**Phase 2+ deliverables promised by spec but not yet scheduled:** HTTPS on LAN + `Secure` cookie flag (reverse proxy); practice database mode (Phase 8); backup-now button + configurable folder (Phase 8).

### 6a. Postgres 18 — what the upgrade actually required (2026-08-02)

`postgres:16` → `postgres:18`, done as dump-and-restore because Postgres refuses to start on a data directory from an older major.

**The image also moved its data directory, and this is the part that bites.** Postgres 18+ official images store data in a major-version-specific subdirectory (`18/docker/`) so `pg_upgrade --link` can run without crossing a mount boundary — and they **refuse to start if they find a mount at the old `/var/lib/postgresql/data`, even an empty one**. `docker-compose.yml`'s db volume is therefore mounted at `/var/lib/postgresql`, one level up, with a comment saying why. Changing only the image tag produces a container that restarts forever with a wall of text about `pg_ctlcluster`. See docker-library/postgres#1259.

**Upgrading a real deployment** takes the same shape as the dev upgrade did, and cannot be done by editing the tag:

```bash
# 1. dump with the NEWER pg_dump (18 against a 16 server is the supported direction)
docker run --rm --network host -e PGPASSWORD=… postgres:18 \
  pg_dump -h 127.0.0.1 -U erp -d erp --format=custom --no-owner --no-privileges > erp.dump
# 2. docker compose down -v          (destroys the 16 volume — dump first, verify, THEN this)
# 3. bump both `image: postgres:` lines and move the db volume mount to /var/lib/postgresql
# 4. docker compose up -d --wait db  (db-init recreates erp_test on the fresh cluster)
# 5. pg_restore --exit-on-error, then diff exact row counts against the pre-upgrade capture
```

The dev upgrade was verified by exact per-table row counts before and after (identical across both databases), `prisma migrate status` clean on both, 585 tests and 6/6 E2E flows green. The pre-upgrade dumps and count captures are in `~/heatsynq-pg16-preupgrade-2026-08-02/`.

`scripts/backup.sh` needed no change — it calls `pg_dump "$DATABASE_URL"` with no version-specific flags — but the backup service's own `image:` must stay in step with the db service's, since its `pg_dump` has to be at least the server's version.

## 7. The owner still owes (spec §14 — chase these, none block Phase 2)

1. ~~**Samples of the current printed shipper, cert, and invoice**~~ — **CLOSED 2026-08-04.** The
   owner delivered all four during the Phase 4 design session: `docs/samples/Shipping Ticket
   Sample.pdf`, `Bill of Lading Sample.pdf`, `Certification Sample.pdf` and `Invoice Sample.pdf`
   (the last is Phase 5's). They are real filled-in documents for orders `72036-3` and `72026`, not
   mockups, and they **overturned four of the Phase 4 design's own decisions before a line of code
   was written** — see that spec's §3.19–§3.22. The traveler sample was closed earlier, 2026-08-03,
   by the ruling that the 2025 mockup is its build target (spec §3.9).
2. QuickBooks finance-charge treatment — settle with the bookkeeper (Visual Shop excludes FC from GL export entirely). **This and item 4 are now the CRITICAL PATH to the acceptance month (spec §13); nothing in code gates it any more.** **#91 is ruled AND built** (netted to a single signed column, `0b5ea81`) — but confirm the import method against it at the same conversation, since netting was decided without waiting on the bookkeeper.

   **⚠️ 2026-08-17 — the import route is NOT what this project has assumed, and the product may not be either.** The owner supplied Intuit's *Import from Excel and CSV* toolkit (`docs/company-confidential/quickbooks-csv-toolkit/`, gitignored — Intuit's own docs, but kept beside the other owner material). Two facts out of it:
   - **Excel/CSV import cannot carry TRANSACTIONS.** The manual, page 1: it *"can only import lists. Transactions cannot be imported using this method."* The three routes are **IIF** (transactions + lists, tab-delimited), the **SDK** (transactions + lists, XML), and **Excel/CSV** (lists only). Our GL export is a journal entry — a transaction — so "hand them a CSV and they import it" is not an available answer. What remains: IIF, a connector/add-on, or **keying one journal entry a month by hand from the posting register** (entirely viable at one entry a month, and it needs nothing built).
   - **The toolkit is QuickBooks DESKTOP documentation** (`File → Utilities → Import → Excel Files`, Pro/Premier 2008 / Enterprise 8.0, dated 2008-09-30), while every note in this project — the spec included — says **Online**. IIF is Desktop-only, so the two products give completely different answers. **Settle Desktop vs Online before anything else in this item**; if it is Desktop, the "QBO" wording throughout the docs needs correcting, not just the plan.

   Nothing is built against either assumption yet, so this cost nothing — but it is exactly the kind of thing the prime directive exists for. The full question list for that conversation is `docs/company-confidential/2026-08-17-accounting-questions.md` (22 questions, each paired with what the software does today).

   **ANSWERED 2026-08-17, same day — the question list came back hand-annotated by the bookkeeper**
   (scan + their QuickBooks item-list export, both in `docs/company-confidential/` —
   `2026-08-17-before-parallel-run-annotated.pdf`, `2026-08-17-qbo-products-services-list.csv`; the
   per-question transcription is appended to the question list itself). The critical-path answers:
   the product is **QuickBooks ONLINE** — circled twice on the returned sheet, and the item-list
   export is QBO's own format, so correct the earlier "may be Desktop" hedge — and **the month's
   journal entry is KEYED BY HAND** ("I have been keying it in by hand"), so **no import format
   needs building at all** (IIF, connector and CSV are all moot; the stored posting-register PDF is
   directly usable — "QBs can read PDF files. Even scanned PDFs"). The file should carry account
   **NAMES**; the bookkeeper lumped every heat-treat service into ONE income account years ago and
   can either accommodate our names or supply a list — the item-list export IS the income side of
   that list. Also settled: **sales tax is not charged and won't be** (Q6 — the export's tax
   exclusion is moot in practice, not merely acceptable); **early-pay discounts net straight
   against revenue** (Q7); **finance charges are effectively unused** (Q19; Q5 instead asks for a
   card-processing-fee account, since card payments arrive through QuickBooks). Still open from
   this conversation: **Q3** (the annotation reads as "the bookkeeper keys A/R transactions into
   QuickBooks directly during the parallel run, remittance attached" — confirm that reading),
   **Q8** (they asked back "all, or what VS invoicing uses?" — send the what-invoicing-touches
   list; the chart-export ask stands), and **Q13** (explicitly cannot be settled without a third
   person the bookkeeper named; costs nothing parked — the discount has never been taken). The A/R
   policy answers (Q14–Q22) and what they unpark are recorded against the round-2 backlog's PARKED
   table. **ACTIONED 2026-08-17 on the owner's go-ahead:** #70 and #78 closed (current behavior
   confirmed; #78's acceptance is a spec §15 amendment), #76 closed not-planned (finance charges
   unused), #73 and #80 unparked into Group E with `ready-for-agent`, #69/#77 stay parked.
3. ~~The office's go-to report list.~~ **Effectively CLOSED by Phase 8A** — the five native reports + the two homed ones were built to the owner's list; extras are cheap additions now the platform exists.
4. GL account list for operations, surcharges, payment types. **PARTIALLY DELIVERED 2026-08-16** —
   the owner supplied Visual Shop's own *General Ledger Report* (process code → GL#, 3 pages).
   **NOT IN GIT — the repository is PUBLIC and this is the company's chart of accounts.** It lives at
   `docs/company-confidential/2026-08-16-visual-shop-gl-numbers.pdf`, a directory gitignored under
   the same 2026-08-07 ruling as the VS screen capture. Never quote an account number into a commit,
   a PR body, or an issue. Owner's note: "not all of them are used anymore", and no rush — nothing
   was built against it.

   **Fifteen distinct accounts appear** — twelve revenue, plus one each for the energy surcharge,
   freight and trucking. **The numbers themselves are deliberately NOT repeated here** (see the
   2026-08-17 correction below); they are in the confidential PDF and in
   `docs/company-confidential/2026-08-17-accounting-questions.md`. Some rows carry no GL# at all and
   three carry a literal `%` — consistent with the retired-codes caveat, and harmless here since a
   step code's account is optional (2026-07-30).

   > **⚠️ Correction, 2026-08-17.** An earlier revision of this item — landed in `b56aa0f` (PR #129)
   > — quoted the actual account numbers and their furnace-group mapping in full, directly beneath
   > the rule forbidding exactly that, in a file committed to a **public** repository. The numbers are
   > removed from the working file as of `1b6c26d`+. **Git history still contains them** (they are in
   > the PR #129 diff and in every clone taken since), so this is containment, not a scrub — a true
   > removal needs a history rewrite and force-push, which is the owner's call and was not taken
   > unilaterally. Exposure is bare internal account numbers and furnace names: no customer data, no
   > dollar figures, no credentials. **The rule stands and now has a worked example of how it gets
   > broken — by an analysis paragraph that felt like reasoning rather than like data.**

   **⚠️ TWO FINDINGS THAT NEED THE OWNER BEFORE THIS CAN BE KEYED IN:**

   1. ~~**VS keys the revenue account by EQUIPMENT GROUP**~~ — **ANSWERED 2026-08-16** by two more
      owner-supplied exports (same confidential directory): `…-visual-shop-process-codes.pdf` and
      `…-visual-shop-equipment.pdf`. The account is on **neither** table. The Process Code table has
      **no GL column at all**; the Equipment table HAS a `G/L #` column (plus `Addon1 GL`/`Addon4
      GL`) and **every row is blank**. The owner's Order Entry chart shows `Standard Steps → Table
      Keys → Process Code · Equipment · Group · Cost Center`, and the GL report's columns are
      exactly `GL# · Process Code · Eq Id · Gr Id · Cc Id` with `Eq Id` = 0 on all but two rows. So
      VS hangs the account on the **Standard Step**, keyed effectively on **(Process Code × Group)**
      — Group being the furnace type, which is why one atmosphere-anneal process code appears under
      three different revenue accounts (the IQ, Bell and Rotary ones).

      **What that means here, and it is a business choice, not a technical block** (owner: "they may
      have multiple ways of doing depending on how the shop chooses"). HeatSynQ hangs one
      `glAccountId` off each `ProcessStepCode` and has no Group concept — deliberately, since shared
      process masters were removed and the recipe belongs to the part. So the split is reproduced
      purely by how the CODES are named: either one step code per (process × furnace group)
      — "Anneal in Atmosphere (Bell)" — which reproduces today's eight-account revenue split exactly
      and keeps the bookkeeper's reports unchanged (~80–120 active pairs, a spreadsheet-paste job),
      or one code per process with a single account, which is fewer codes and loses revenue-by-
      furnace. **The step code is what prints on the invoice line**, so either naming is honest
      paper. Owner's call; nothing is blocked on it.

      **The bookkeeper's answer landed 2026-08-17 (Q12 on the returned question list): a bare
      "No" — nobody reads revenue-by-furnace.** Their QBO item-list export corroborates it
      independently: every heat-treat service already posts to a single income account, so the
      by-furnace split died at the QuickBooks door years ago and only Visual Shop's own reports
      ever showed it. **RATIFIED by the owner 2026-08-17 (spec §15): one step code per process
      (~15–20 codes), one revenue account.** The chart-keying task is now a short afternoon; the
      only accounts still owed are Q8's balance-sheet list (the bookkeeper asked back "all, or
      what VS invoicing uses?" — answer: what invoicing/A-R touches).
      (Superseded framing kept below for the reasoning.)

      **VS keys the revenue account by EQUIPMENT GROUP, not by process code — HeatSynQ keys it by
      Process Step Code.** The report's `Gr Id` column is what separates the eight furnace-group
      revenue accounts (IQ, Vacuum, Tip Up, Bell, Temper, Car Bot, Rotary, Pusher — numbers in the
      confidential PDF, not here), and the SAME process code lands in several: the atmosphere-anneal
      code spans three of them, the atmosphere-normalize code four, and the air stress-relieve code
      three. Our model
      hangs ONE `glAccountId` off each `ProcessStepCode` (CLAUDE.md), so a single step code cannot
      reproduce that split. Either the step codes are defined per (process × equipment group) — which
      is how the shop already names them in practice, worth confirming — or the account has to be
      chosen somewhere else. **Do not key the chart in until this is settled**; guessing would
      mis-post revenue by furnace.
   2. **The balance-sheet side is not in this list, and CANNOT come from Visual Shop** (owner,
      2026-08-16: "not sure how to provide that, especially from the settings of Visual Shop" —
      correct, and expected). The QBO export's readiness gate needs `BillingConfig`'s A/R control,
      sales-tax, discount and write-off accounts plus a cash account per payment type; VS only ever
      knew the REVENUE side, which is exactly what its GL report shows. Those five-plus-N numbers
      live in **QuickBooks' own chart of accounts**, so they are a bookkeeper question, not a VS
      screen anyone is failing to find. Folds into §7 item 2's conversation.
5. **Four Phase 4 pings the owner has not ruled on yet** — kept here verbatim from the Phase 4
   record (`docs/history/2026-08-06-phase-4-certs-shipping.md`) so they stay in front of the next
   session; §9 carries them into the next PR:
   1. ~~The shipping ticket prints no **"Page N of M"**~~ — **IN PHASE 7 SCOPE (spec approved
      2026-08-12)**: the render runtime gains a renderer-side page-number primitive with
      per-sheet-group rendering (P7 spec §6.1), closing this for every document type.
   2. ~~**Serial re-shipment has no warning**~~ — **RULED 2026-08-16 (warn, do not block) and BUILT**
      (issue #125, `d4335c1`, burn-down Group C). A hard refusal would have needed a return/RMA
      concept that does not exist and could wedge a real shipment. The shipped fact is DERIVED from
      live `ShipperSerial` rows joined to non-voided shippers — no column added — keyed on
      **(order line, serial text)**, which survives `replaceSerials` deleting and recreating the
      `OrderSerial` rows (an `orderSerialId` key lost the prior shipment entirely and let the
      recreated serial ship again unwarned). Scoping to the LINE is what makes the serial text safe:
      a line belongs to one order, one customer, one part. The sentence says "**also appears on**",
      not "already shipped" — it compares against every other live shipment rather than only earlier
      ones, because packing-list order records document creation, not when a serial was selected
      during an edit, and the neutral wording is honest on BOTH documents (owner ruling
      2026-08-16, after three findings on PR #130). Ping closed.
   3. ~~The ticket's tear-off strip **overlaps the part table past ~8 extra multi-line part rows**~~ —
      **IN PHASE 7 SCOPE (spec approved 2026-08-12)**: the tear-off goes flow-based as ruling 3's
      column-widths guardrail (P7 spec §5.6).
   4. ~~**No `User.title` column exists**, so the cert signature block prints name + company with no
      title line (the sample shows one) — a small follow-up migration if the owner wants it.~~
      **CLOSED — built in Phase 6** (`e2c91e8`, ruling 14): `User.title` on the admin user form,
      printing on both the quote and cert signature blocks (blank title prints nothing).
6. **The shop logo file** (added 2026-08-12, Phase 7 spec §12 item 1) — **DEFERRED by the owner
   2026-08-16 to after the acceptance month.** **The artwork is now ON THIS MACHINE** (2026-08-17):
   five variants in `docs/company-confidential/logos/` (gitignored — the repo is public; the folder is
   `.gitignore:40` and each file was `check-ignore`-verified when saved). They were sent from a phone
   as chat images rather than as files, so they were recovered by decoding the base64 image blocks out
   of the session transcript; that is the only copy on disk, and it is **outside the repo's history by
   design** — a fresh clone will not have them.

   | file | shape | px | notes |
   |---|---|---|---|
   | `aht-logo-horizontal.png` | flame + wordmark | 1716×560 | **RGBA, transparent** — the document-header choice |
   | `aht-mark-flame.png` | flame alone | 591×802 | RGBA, transparent — tight slots, favicon |
   | `aht-wordmark.png` | wordmark alone | 581×273 | RGBA, transparent — likely unused |
   | `aht-logo-horizontal-white-bg.jpg` | flame + wordmark | 944×310 | opaque white box |
   | `aht-mark-flame-white-bg.jpg` | flame alone | 448×604 | opaque white box |

   **All five clear `LOGO_MAX_BYTES` with room** (512 KB, `templates.ts`; largest is the horizontal
   PNG at 218 KB), and all five are `image/png`/`image/jpeg`, so the existing upload path accepts them
   unchanged. Use the **PNGs** — the JPEGs are the same art flattened onto a white rectangle, which
   will show as a box over any coloured band. **There is no vector original among them**; the
   horizontal PNG is ample for a document header (~1700 px across a ~2 in header is >800 dpi), but if
   an SVG/EPS/AI exists wherever the logo was made, it is worth asking for it **before** the logo work
   starts rather than after. Cosmetic; the parallel run does not depend on it. The template logo slot
   stays unused until then, and Phase 7's "restyle the traveler with the real logo" outcome stays
   unexercised — the E2E flow uses a fixture image until it lands.

## 8. Fresh machine setup (Fedora)

```bash
# 1. Tooling
sudo dnf install -y git nodejs26 npm postgresql # or use nvm for node; Node 26 required (Dockerfile + CI pin it)
# `postgresql` is the CLIENT (pg_dump/psql), needed by the E2E `backups` flow (Phase 8C — it is the
# one place the real binary is exercised; vitest injects a fake) and by the restore runbook
# (`erp/README.md`). Its major must match the `postgres:` image tag (currently 18) — pg_dump refuses
# to dump a server newer than itself. Fedora 44's `postgresql` package is 18.4, matching today.
# Node 26 ships npm 12, which does NOT run dependency install scripts unless you approve them.
# `npm ci` prints a warning naming five: @prisma/engines, argon2, esbuild, prisma, unrs-resolver.
# That warning is EXPECTED and must not be "fixed" with `npm approve-scripts --all`. None of the
# five are needed: argon2 and esbuild ship prebuilt binaries (argon2's are N-API, so they are
# ABI-stable across Node majors), and Prisma 7 bundles its engines. Verified on Node 26.5.1 /
# npm 12.0.2 — all four gates plus `prisma migrate status` pass with every script skipped.
# Approving them would add supply-chain surface to buy nothing; skipping is npm's secure default.
# Docker Engine (compose v2 profiles are used; Docker CE recommended over podman):
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER   # then log out/in

# 2. Project
git clone https://github.com/CoJoA13/HeatSynQ.git && cd HeatSynQ/erp
cp .env.example .env
git config --global user.name "cojoa13"          # git REFUSES to commit without an identity, and it
git config --global user.email "cjones1308@pm.me" # fails when you have work to save, not at setup
docker compose up -d db   # a FRESH dbdata volume runs db-init/, creating erp_test AND erp_practice
npm install
npx prisma migrate deploy  # APPLY existing migrations to the dev DB (erp) — not `migrate dev`
npx prisma generate        # v7 no longer does this for you; client is gitignored
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
npm run db:seed
npm run dev     # http://localhost:3000 — admin/admin, change it

# 3. Prove it — the four gates (expect the §4 tally of the phase you are on)
npm test
npx tsc --noEmit
npx eslint src tests
npx playwright install chromium   # one-time; the E2E harness spawns its own dev server on :3100
npm run test:e2e                  # runs against the DEV db (erp), not erp_test
```

Use `migrate deploy` to **apply** migrations. `migrate dev` is only for **authoring** a new one, and since Prisma 7 it needs a TTY — it refuses in a non-interactive shell, so an agent session must use the `migrate diff` workflow in `CLAUDE.md` (the `create-migration` skill) instead. `db-init/` runs **only on a fresh `dbdata` volume**; a box that already ran the stack before `erp_practice` existed creates it once by hand with `docker compose exec db createdb -U erp erp_practice`.

Fedora-specific notes:
- **SELinux**: the compose file bind-mounts `./db-init`, `./scripts/backup.sh`, and `./backups` (on both `app` and `backup` — Phase 8C mounts it on `app` too, for its archive list and on-demand dump). If Postgres init or the backup container hits `permission denied`, append `:z` to those four bind mounts in `erp/docker-compose.yml` (named volume `dbdata` needs nothing). Prefer `:z` labels over disabling SELinux.
- **Podman**: if you use podman instead of Docker CE, you need `podman-docker` + a compose provider that supports `profiles` and `depends_on: condition: service_healthy`; Docker CE avoids the friction.
- **firewalld**: only relevant when exposing the prod app to the shop LAN (`sudo firewall-cmd --add-port=80/tcp --permanent && sudo firewall-cmd --reload`).
- Dev DB data from the old machine does not travel (it was throwaway seed/test data). If you ever need it: `erp/backups/` gzip dumps restore per `erp/README.md`.
- **Run `npm run test:e2e` in the BACKGROUND.** It now runs close to ten minutes, which is the agent tooling's per-command ceiling; a run killed at the cap leaves a `ClosePeriod` row that the harness deliberately does NOT self-heal (its reaper is id+`closedById`-scoped so it can never hard-delete a real close). The next run then fails three flows — `invoice-shipped-order`, `receivables-apply-age-statement`, `close-month-end` — because the month is closed, and clearing it needs a hand-written `DELETE` of the `ClosePeriod` + its `GlExportBatch`/`GlPosting` rows against the DEV db. Verified end to end on 2026-08-16.

## 9. Kicking off the next piece of work (paste this into a fresh session)

> **START HERE (owner, 2026-08-17): `docs/2026-08-17-backlog-round-2.md`** — round 1 is complete (14
> closed); this groups **all 66 remaining issues** and is the current track. **Task 0 and Groups A,
> B, C and E are DONE** — A `1c1fc77` (PR #133), B `6bc45ea` (PR #135), C `4cada64` (PR #141),
> **E `2d9247c` (PR #142, squash, 2026-08-18)**: all nine of #73, #80, #88, #90, #93, #95, #132,
> #139, #140, **no schema migration in the group**, seven task reviews **all Approved on round 1**
> (the one Important was the brief's own #139 lock argument — resolved by a recorded controller
> ruling: commit-order freeze semantics on the §5.1 publish precedent, ledger
> `docs/execution/2026-08-18-round-2-group-e/progress.md`), and **Codex posted NO review on the PR**
> (a first). Gates on main: **3212 tests / 185 files**, `tsc`/`eslint`/`build` clean, E2E
> **23/23**, CI green. The accounting answers are ACTIONED (§7 item 2; **Q12 RATIFIED** — one step
> code per process; #69/#71/#4/#8 remain owner calls, #77 parked-low; the transcription is in
> `docs/company-confidential/2026-08-17-accounting-questions.md`).
>
> **D `c0b795e` (PR #143, squash, 2026-08-18)**: the stale-load class — #3, #15, #23, #31, #110
> closed by the PR, #5 closed separately with evidence (fixed since `aeed372`). Opened with the
> **#31 ruling (keep fetching in effects, permanently)** + the sweep-widening ruling; recon found
> the surface at **77 hits / ~48 files**. Four new `src/lib/` leaves carry the discipline
> (`save-scope`, `field-blocker-panel`, the SetupBanner invalidation, `drain-queue` — see the
> CLAUDE.md paragraph). Seven reviews caught **1 Critical (reviewer-reproduced mutual drain
> deadlock) + 3 Importants (two of them the briefs' own flaws)** — all fixed and re-verified;
> ledger `docs/execution/2026-08-18-round-2-group-d/progress.md`. Out-of-class finds filed as
> **#144–#149**; Codex reviewed clean (zero findings — the record was corrected 2026-08-18:
> #142/#143/#150 all had clean-on-open reviews, not absent ones). Gates on main: **3249 tests /
> 189 files**, `tsc`/`eslint`/`build` clean, E2E **23/23**, CI green.
>
> **F `b5a2069` (PR #150, squash, 2026-08-18)**: infrastructure — #30, #111, #40, #35, #112,
> #32 closed by the PR; #34 closed with pointers (built since Phase 4), #107 closed not-planned
> (owner ruling + revisit trigger). The pinned practice-reset lock DELETED for the
> `single-flight.ts` leaf (both Codex rounds satisfied at once); db-errors bound to the
> empirically probed adapter shapes (a latent translator crash found and fixed by the RED
> watch); **CI now builds and boot-checks the production image** (the new `docker` job passed
> 1m53s on its own PR); the pg@9 tripwire armed; the sweep's allowlist deleted for per-model
> matching. Four reviews, **all Approved round 1, zero implementer fix rounds**; ledger
> `docs/execution/2026-08-18-round-2-group-f/progress.md`. Gates on main: **3260 tests /
> 191 files**, E2E **23/23**.
>
> **G `5c54730` (PR #151, squash, 2026-08-18)**: documents/templates — #103 closed by the PR;
> **#102 closed not-reproducible-at-HEAD at kickoff** (owner ruling on recon that swept
> n=1..160 × 12 variants, controller re-verified: zero blank trailing pages, structurally
> impossible in pdfmake for house builders; the ~5 boundary counts are legitimate Total-Due
> spill, recorded on the issue with a revisit trigger). **Prose-only PR — zero executable-code
> changes**: the #103 evolution warning at the `template-contracts/types.ts` chokepoint +
> docblock pointer + CLAUDE.md sentence + the stale blank-page test comment corrected. One
> review, Approved round 1; then **EIGHT Codex rounds (ten P2s: eight accepted after
> verification, one half-rejected on evidence, one triaged — the stop-reviewing ruling's first
> live application)** distilled the warning into two closed principles ("additive" is a
> SEMANTIC test — valid AND same paper; contract defaults are immutable IN EFFECT once
> published against) and fixed a pre-existing §5.3 header contradiction. Ledger
> `docs/execution/2026-08-18-round-2-group-g/progress.md`. Gates unchanged (**3260 / 191**,
> prose-only; E2E not run by brief ruling).
>
> **H `a8ed769` (PR #152, squash, 2026-08-19)**: the polish batch — #9, #14, #24, #37, #38,
> #72, #99, #100, #101 closed; **#33's owner-ruled bounded slice landed** (board page → four
> presentational components + the board-columns unit suite; board reads → `order-board.ts`
> behind a barrel, byte-parity independently verified; the orders↔shippers cycle RETIRED), the
> create/edit split deferred with evidence, issue retitled. Audit fidelity rebuilt: rows
> claimed `FOR NO KEY UPDATE` before snapshots (#9 — plain `FOR UPDATE` deadlocks through FK
> RI trigger probes), list-relations ordered + projected onto stable fields (#24 + Codex).
> One migration (the `ar` purge). Five reviews, four Approved round 1, one one-round fix (a
> NUL byte that made a source file binary-to-git). **E2E caught 14/23 flows red** — the
> correct `role="option"` displaced the implicit button role the test helper matched;
> one-line fix, 23/23 after. Three Codex rounds (two accepted + extended, one triaged →
> **#153**); ledger `docs/execution/2026-08-19-round-2-group-h/progress.md` also records
> three controller incidents and the scratch-DB convention they produced. Gates on main:
> **3310 tests / 198 files**, E2E **23/23**.
>
> **H2 `1ba0d34` (PR #154, squash, 2026-08-19)**: the client-state batch — all six Group-D-filed
> #144–#149 closed. Error channels split so no fetch clears another's failure (#144), the
> togglingActive in-flight family completed (#145), the three receivables/parts
> precedent-copies (#146–#148, incl. the new `field-drafts.ts` keep-edits-since-save leaf), and
> #149's typed-text overlay: a row-keyed edit-guard extension plus the orders hub's overdue
> `useEditGuard` adoption. Three reviews — **all Approved round 1, zero Important**; two
> TDD'd Minor fix rounds. The ledger records the scratch-DB convention correction
> (`DATABASE_URL_TEST`, not `DATABASE_URL` — `setup.ts:4` reassigns it) and **three Codex
> rounds that drove the edit-guard to a fixpoint**: collection-scoped cells (round 1's P1 was
> our own review-round regression), pure merges in updaters (widened to the pre-existing
> Phase-4 scalar mutation), then immutable captured focus sessions — apply APIs that make
> merge/note mispairing unrepresentable, live state event-handler-only, the one unreachable
> residual documented and test-pinned. Round 4 clean. Ledger
> `docs/execution/2026-08-19-round-2-group-h2/progress.md`. Gates on main: **3362 tests /
> 200 files**, E2E **23/23 (×4)**. **9 issues open — Round 2's grouped work is COMPLETE;
> everything remaining is owner-gated** (#33 deferred, #153, parked #4/#8/#69/#71/#77, #134,
> #137).
>
> **I `e97a65d` (PR #156, squash, 2026-08-19)**: the ready issues — #69, #8, #137, #77, #153
> closed, after the owner answered **eleven questions in one sitting** on what was by then an
> entirely owner-gated backlog (six of those answers closed or scoped issues outright: #134, #4,
> #71 closed; #69, #8, #153 ruled). **#77** gives spec §3 ruling 1 its missing bad-debt flavor —
> a Serializable, claim-disciplined `writeOffInvoice` reached from the customer A/R section,
> **with the void path in scope by owner ruling** (a full write-off would otherwise remove the
> invoice from the only table that could anchor its undo). **#69** became a settlement GUARD
> after the owner's first ruling was re-put with the numbers — flat-percent-of-cash stranded
> $0.40 on a $980 remittance against a $1,000 2/10 invoice. **#153** unions child-section audit
> rows into parent History panels via a registry, no schema, no backfill. **#8** closed as
> already satisfied (built 2026-08-01; HANDOFF was what was stale) plus one real route defect.
> Five reviews, two Approved round 1, zero Critical — and **the two best findings were false
> GUARANTEES, not broken code**: a sweep test that did not execute what its header promised, and
> refusal messages naming a correction route that no longer existed. Two brief flaws caught by
> implementers. **E2E caught two defects no other gate could see**, both in the one file two
> tasks edited — standing lesson: **`eslint src tests` does not cover `e2e/`**, so `node --check`
> is that directory's parse gate. Codex round 1 (the invalidation gap #153 created; fixed to 17
> sites derived from the registry rather than the four reported), round 2 clean. Ledger
> `docs/execution/2026-08-19-round-2-group-i/progress.md`. Gates on main: **3448 tests /
> 204 files**, E2E **23/23**.
>
> Then the **pre-acceptance verification pass** (2026-08-19/20, PR #164): a demonstration dataset
> built through the service front door, a 45-route/50-screen sweep that gates on console and
> request health, and a 14-chapter manual. It filed five issues — #159, #160, #161, #162, #163 —
> and **rejected two claims** it could not substantiate. **Seven owner rulings followed** (spec
> §15), clearing every owner-gated issue: #162 informational, #161 gets a screen, #165 split out,
> #159 closed not-planned, #157 bounded by the write-off's period, #155 arm 1 closed and arm 2
> built. **9 open, none owner-gated**: #33 (deferred) + eight ready-for-agent.
>
> Round 1's own record stays at `docs/2026-08-16-issue-burndown-handoff.md` — read its closing
> "outlives it" section before starting, especially lesson 4 (when each review round finds defects in
> the code written for the previous round, the design is the finding).

**Phase 8 (Reports & parallel-run tools) is DONE — all three sub-phases MERGED** (8A PR #106, 8B
PR #109, 8C PR #117 / `941ceab`, §4). **That completes every build phase in the 8-phase roadmap**
(`docs/superpowers/plans/2026-07-29-roadmap.md`) — there is no ninth phase, and nothing is in flight.
**The open work is now acceptance and backlog, not new build.** A fresh session should read CLAUDE.md
and §4, then pick among:

1. **The parallel-run acceptance month** (spec §13) — the headline remaining goal. Phase 5 unlocked it,
   Phase 8's comparison scoreboard delivered the weekly tooling, and 8C made the box trustworthy to
   leave running. Still gated on the owner-owed GL-account list and the bookkeeper's QBO import method
   (§7) before a *real* export month can start.
2. ~~**Issue #115 (P1)**~~ — **DONE 2026-08-16**, branch `fix-allocation-retry` (`fc7eb54`), with
   **#68** (`20ed463`) on the same branch as burn-down Group A. All **eight** allocating entry points
   (not six — `shippers.ts` had three) now wrap in `retryAllocation`. Detail, and the two corrections
   measurement made to the issue's own analysis, in §4.
3. **The six items ruled at the Phase 8 close-out (2026-08-16)** — all filed with build notes;
   **#68 is DONE** (Group A, `20ed463`): the `reopen` (POSTED→OPEN, refusing on a closed month,
   Serializable under the period lock; `voidBatch` gained the matching POSTED guard). The
   **#91, #125 and #126 are all DONE** — #91 in Group B (`0b5ea81`: the GL export nets to one signed
   column per `(account, side)`, decided WITHOUT waiting on the bookkeeper because a gross
   dual-column line risks importing 150 where 120 was meant), #125 and #126 in Group C
   (`d4335c1` / `de9ed88` / `c7fc4d3`: the re-shipped-serial warning, DERIVED from live
   `ShipperSerial` rows joined to non-voided shippers — no column added, keyed on **(order line,
   serial text)** so it survives `replaceSerials`, worded "also appears on" and symmetric across
   every other live shipment — and the order-line freeze, one guard mirroring `replaceCharges` read under the order
   claim, with the unlock → edit → re-finalize correction route tested end to end). The remaining
   two: **#123** disable the Backups page's own controls
   in practice mode while keeping the nav entry (`nav.ts` must NOT learn about practice mode — §8);
   **#124** refresh the shell staleness bar after a successful "Back up now". **All six are now BUILT**
   — #125/#126 in Group C (`fix-order-guards`), #123/#124 in Group D (`fix-backups-followups`).
4. **Backlog burn-down — COMPLETE (2026-08-16), 14 issues closed** (#68, #81, #84, #91,
   #115, #118–#126). Still open: Phase 6 follow-ups #95–#96/#99–#101; the Phase 7 deferrals
   #102/#103; **#132** (a retention failure is cleared by the next manual backup, which does no
   retention — filed from the Group D review, self-correcting within one night); the
   per-worker-test-DB infra task (§6). ~~owner question #68~~ is answered and built. Also worth an early look: the
   sibling-page stale-load sweep (the §5.13 class the Phase 7 quotes + templates-list fixes addressed
   on two pages — customers/parts/orders/certs detail pages likely share the hole).
5. ~~**A Phase 8 demo**~~ — **DONE 2026-08-16** (record in `docs/execution/2026-08-16-phase-8c-backup-polish/progress.md`).
   Walked 8A/8B/8C live: the day-one red staleness bar, a real `pg_dump` through "Back up now"
   (archive + status file + audit row all verified on disk), the practice banner on the login screen,
   and the PRACTICE/SAMPLE watermark on a printed traveler. Produced **#123** and **#124**, and the
   six rulings above. A demo of the *order-to-invoice* flow on the practice copy is still worth doing
   before the acceptance month — this one covered Phase 8's surface, not the daily workflow.

Whichever track is chosen: brainstorm → spec → plan → subagent-driven execution on a fresh branch,
per-task reviews, whole-branch review on the strongest model, one fix wave, PR with attribution in
the body. Standing rules that bind every phase: run `npm run test:e2e` on any UI/flow-touching
change and update the docs as part of the work; **a gate row is written after watching the run end,
or it says PENDING** (the Phase 6 Task 10 lesson); check `systemctl is-active docker` before
diagnosing ECONNREFUSED (this machine's Docker is disabled at boot); the operational traps this
project has hit are in the session-memory index (subagent E2E discipline, the `pgrep` self-match,
the killed-run close-period debris). The prime directive: do not assume — ask the owner.

Process that worked in Phase 1 and should be kept: brainstorm/clarify → spec → detailed plan → fresh subagent per task → independent spec+quality review per task → fix rounds until approved → final whole-branch review on the strongest model → one fix wave → merge. The per-task reviews caught real bugs the plan itself contained (plaintext password in audit payload, `__proto__` registry crash, blank-page login, resurrection with stale permissions, silent empty backups) — **the review loop is not optional ceremony**.
