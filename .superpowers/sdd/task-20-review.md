# Task 20 Review — E2E flows, demo, docs (a7fe24b..b482844, range 5459cb4..b482844)

> Filed by the controller verbatim-in-substance from the task-reviewer's returned text. Review ran
> 2026-08-06.

### Spec Compliance — all ✅ (one ⚠️)

- Five flows match spec §13.1–§13.5 exactly (remainder prefill, /Count 2 two-sheet proof, live pass/fail then Buffer.compare===0 stored reprint, void-with-reason + sequence-never-freed, held refusal→override→reason in history).
- Harness-convention deviation (e2e/flows/*.mjs + run.mjs registry vs the brief's .spec.ts names) faithful, 1:1, disclosed.
- Phase 3 URL trap avoided: zero waitForURL anywhere; waits anchor on the Packing List heading / hub heading with the trap documented in-place.
- Both ledger pins landed: (a) Task 14 recapture — including a PROGRAMMATIC $$eval sweep over every main control asserting disabled || readOnly with a loud offender list, plus the two verbatim §5.16 titles (stronger than the lost original spot-check); (b) Cust Cont Id round-trip reproducing the precise data-loss shape (second save touches only count, full reload, both values re-asserted).
- x-print-warnings pinned in-browser (voided cert, box ticked, both warning strings); §5.7 amber panel asserted before navigation.
- Fixture hygiene per §5a complete, including the audit-row sweep (shipper/cert/storedDocument entities grep-verified exhaustive); FK-ordered cleanup reasoned in comments; voided rows deliberately kept.
- Shakedown fix was fixture-only (clerk gains processes.view, commented); ZERO production src/ files in the diffstat; no waits/retries added.
- Demo walkthrough checkpoints + the three §3.22 deviations present; PDF descriptions verified against the actual builders (bol.ts:172, :261-265; shipping-ticket.ts:348).
- HANDOFF §4a verified claim-by-claim against the ledger (21 tasks incl 14b, retro-14 story, 1010→1357, five first-pass approvals in exact order, fix-round counts, the 2026-08-05 rulings, fold-in SHAs, owner pings); §6 matches deferrals; §7 item 1 already struck; §9's Phase 5 kickoff quotes §16's nine bullets verbatim with two disclosed additive parentheticals.
- CLAUDE.md's three additions each verified against the tree (order-locks.ts:89 + :58-59; migration SQL :329-334 incl. the deliberate SHIPPER-orderId looseness; the five plain-@unique + Cert-no-unique claims vs schema and the sweep's ALLOWED set).
- ⚠️ the three 15/15 runs / gate tails / screenshots unverifiable from diff; flows deterministic-by-construction; whole-branch reviewer may re-run test:e2e once.

### Minors (deferred)

1. Brittle id extraction (page.url().split("/").pop()) in two e2e helpers — URL-based parse sturdier.
2. Soft negative assertions on short timeouts (500ms board check, 1500ms not-yet check) — anchored by preceding positive assertions, mostly defused.
3. Credit-hold "reason in history" satisfied at the audit API + screenshot — correctly framed as a HistoryPanel feature request (no screen renders create-entry payloads).
4. Flows assert raw kind names (SHIPPER/CERT) — deliberately pins today's rendering; coupled to the triaged KIND_LABELS cosmetic fix; the coupling is flagged for the eventual fixer.

### Assessment

**Spec Compliance:** ✅  **Task quality:** Approved (first pass — the sixth this phase)
