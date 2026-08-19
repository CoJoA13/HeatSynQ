# Round 2 Group F — infrastructure and tooling — progress ledger

Branch `group-f-infra`, opened 2026-08-18 from `a11f6c2`.
Issues: **#30, #111, #40, #34, #35, #112, #32** build; **#107 closed not-planned at kickoff**
(owner ruling, recorded on the issue: the shop's scale cannot produce the problem, reports stay
deliberately simple pure reads; revisit trigger = a source table grows large enough that a
no-filter run gets visibly slow or memory-heavy).

## Kickoff rulings (2026-08-18)

- **#107 → closed not-planned** (owner, asked at kickoff — the #76 precedent). Nothing built.
- Controller scope calls, per the issues' own texts: **#112 takes the minimal fix** (remove the
  broken in-container parenthetical; consistent with the production seed's documented
  constraint); **#30 includes the boot check** ("ideally starts the image far enough to confirm
  the server boots" — the issue's own ask); **#111's fix shape decided by recon** under the
  binding constraints serialize + no-pinning + prefer-deleting-a-mechanism (the issue's
  round-3-flagging-round-2 warning).

## Task verdicts

**Task 1 (#111, single-flight the practice reset)** — implementer `a2633de`, RED watched on the
join semantics. Review: **Spec ✅ · Approved (round 1)**, zero fixes. The reviewer verified the
`??=`-with-`.finally` composition yields all four semantics from one expression (join,
clear-on-resolve, clear-on-reject, sync-throw-leaves-clear), traced that a joiner still gets its
per-caller 403 and cannot double-run the flight, and checked every factual claim in the
round-4-defense comment true against the repo (host-port bind, CMD, no cluster, pg-pool's
default 10). One no-action minor (the async-wrapper promise identity nuance).

**Task 2 (#40, driver-adapter constraint shapes)** — implementer `50ed054`/`cc1697e`. RED-watching
surfaced a **latent crash in the old translator** (a string `meta.target` hit
`TypeError: .join is not a function` through the cast) — fixed and pinned. Review: **Spec ✅ ·
Approved (round 1)**. The adversarial legacy-first pin (both shapes present, disagreeing) and the
delete-direction FK semantics were singled out as correct; the honest restatement of the
retry-scope comment verified coherent. One synthetic-only minor (empty-string targets slipping
the hardening) — **controller-applied on-branch** (`9c6ab52`), 16/16 green after.

**Task 4 (#32 tripwire + #35 per-model scoping)** — implementer `5ceae06`. #35's RED watched
(the two order-drafts sites flagged under global matching with the allowlist deleted); #32's
failure paths proven by watched inversion (no pg@9 exists to go genuinely RED against). Review:
**Spec ✅ · Approved (round 1)**. The reviewer re-probed the widened regex against adversarial
receiver shapes (bare variable, multi-line split, unknown delegate — all fall back to the global
union and still flag), verified all 71 model names satisfy the delegate convention, confirmed
the load-bearing empty-set-vs-absent distinction (no silent-pass path exists), and checked the
tripwire's parse robustness in both failure directions. ALLOWED_CALLS deleted entirely — a
permanent allowlist replaced by a structural fix. Two polish minors, no action.

**Task 3 (#30 CI docker job + #112 README)** — implementer `6786989`/`4326860`/`d13ec3e`, with
the watched local verification as the task's gate (build exit 0, health 200 — including a real
transient curl failure absorbed by the very retry loop under review; the README stale claim
empirically disproven against the just-built image). Review: **Spec ✅ · Approved (round 1)**.
The reviewer traced GHA's actual shell semantics (no pipefail by default; the pipeline sits in
an if-condition exempt from errexit either way), verified the `erp_default` derivation holds
under CI's checkout layout, and confirmed the report's 50-vs-51 migration off-by-one (the 51st
entry is migration_lock.toml). Two consequence-free nits (unanchored `-f name=` filter; curl
without `--max-time`) — **controller-applied on-branch**.

## Group tally

Four implementation tasks, four reviews — **ALL Approved on round 1, zero implementer fix
rounds** (three controller-applied minors on-branch: the empty-string target hardening, the two
CI-loop nits). Two issues closed without code by recon/ruling: #34 (already implemented since
Phase 4) and #107 (owner ruling, not-planned). No schema migration anywhere in the group.
