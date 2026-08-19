# Round 2 Group F — infrastructure and tooling — task brief

Branch `group-f-infra` from `a11f6c2`. Issues: **#30, #111, #40, #35, #112, #32 build; #34 closes
with pointers (already implemented, Phase 4 `f129aae`); #107 closed not-planned at kickoff.**
Grounded in a 4-agent recon including an empirical probe of the real driver-adapter error shapes
against erp_test and a decompiled check of the current adapter's relation-load behavior.

**No schema migration anywhere in this group. No E2E-visible UI change** (#111 touches a server
route path, so the standing E2E run happens at close-out as a regression backstop; no flow
exercises the practice reset — structurally impossible against the dev DB).

The four implementation tasks touch **disjoint files** and may run concurrently. Commit
discipline (Group D's lesson, binding): `git status --short` first; stage only your paths;
commit with explicit pathspecs (`git commit -m "..." -- <files>`); never `git add -A`.

## Task 1 — #111: single-flight the practice reset, DELETE the pinned transaction (TDD)

Recon's recommendation, ratified by the controller: **candidate (a), join semantics.**

- `src/server/practice-reset.ts:38–52`: delete the `$transaction` + `pg_advisory_xact_lock(88018802)`
  + both 120s knobs. Replace with a module-scoped in-flight promise: a second concurrent caller
  **joins** the running reset (shares the promise; the observable outcome — "my click ended with
  a fresh baseline" — is identical, and `PracticeResetControl` needs no change). Keep
  `assertPracticeDatabase(prisma)` first, un-memoized, exactly as-is.
- Why this satisfies BOTH review rounds (the issue's round-3-flagging-round-2 trap): round 2's
  actual requirement was "reject or wait for overlapping resets" — the advisory lock was Codex's
  suggested implementation, not the requirement. Single-flight serializes every caller in the
  ONLY process that can invoke the route (compose `app-practice` is one container with a host-port
  bind — `--scale 2` cannot start; `node server.js`, no cluster), and pins zero connections
  (works at pool=1). Net-negative diff — the house delete-a-mechanism preference.
- The rewritten comment must name BOTH rounds and the single-process rationale (one container,
  host-port pin, one Node process), plus the accepted residual: a hand-run local server pointed
  at erp_practice alongside the container reverts, at worst, to the pre-round-2 state the Phase 8B
  merge message accepted as design-sanctioned self-healing — and the un-locked CLI seed
  (`npm run db:seed:demo`) always had identical exposure, so the advisory lock never closed that
  class. Without this comment, round 4 re-flags whatever replaces it.
- **TDD**: extract the single-flight as a tiny pure leaf (`src/lib/single-flight.ts` or similar —
  zero imports; note it is used from server code, which is fine, `src/lib` is the shared layer).
  RED-watched tests (`tests/single-flight.test.ts`, hand-held deferreds): call 2 during call 1
  joins (same promise, fn invoked once); resolution clears the slot (call 3 runs fresh);
  **rejection also clears the slot** (a failed reset must not wedge the endpoint); the joined
  caller sees the same rejection. The `resetPracticeData` wiring stays covered by the existing
  403 tests (`tests/practice-reset.test.ts` — the guard-split means no test can reach past
  `assertPracticeDatabase` on erp_test; do not fight that).
- Docs in the same breath: correct the issue's pool-size framing where relevant (this stack's
  default is pg-pool's fixed 10, not `num_cpus*2+1`) in the comment or report; CLAUDE.md's
  Phase 8B paragraph mentions the reset — check whether its wording needs a clause (likely not;
  it doesn't describe the lock).

## Task 2 — #40: db-errors reads the driver-adapter constraint shapes (TDD)

Bind to the **empirically measured** shapes (recon §2 — the probe scripts' output):

- P2002 on this stack: NO `meta.target`; `meta.driverAdapterError.cause.constraint.fields`
  (e.g. `['name']`), with **embedded double quotes on mixed-case identifiers**
  (`['"tokenHash"']`, `['"customerId"', '"partNumber"']`) — parsed by the adapter from Postgres'
  DETAIL line, and `constraint` is **undefined entirely when pg sends no DETAIL**. P2003:
  `cause.constraint.index` = the constraint NAME (`'PaymentType_glAccountId_fkey'`) — the key is
  `index`, not `fields`; accept the `{ fields: [column] }` variant too (the adapter emits it when
  `error.column` is set). `meta.modelName` is present on both codes.
- Two extractors in db-errors.ts (no new file), **legacy-first, adapter-fallback** — the
  `isDuplicateClientRequestId` precedent and its documented rationale (orders.ts:627–629):
  `uniqueConflictFields(err)` — `meta.target` (string[] or string) → `cause.constraint.fields`,
  stripping one layer of surrounding `"` per field; `fkConstraintName(err)` — `meta.constraint` →
  `cause.constraint.index` → last-resort regex on `cause.originalMessage`
  (`/foreign key constraint "([^"]+)"/`), plus the `{fields:[column]}` mapping. Type every read
  `unknown` and narrow (the `isRawSerializationFailure` style). `readableFkField`'s existing
  prefix/suffix/humanize logic runs unchanged against the extracted name.
- **Comment touch-points in the same commit**: db-errors.ts:113–114 claims meta.target
  discrimination "is unavailable on the driver-adapter stack (#40)" — after this fix the
  justification changes (the per-call-site opt-in decision may stand on its own merits; restate
  it honestly); mirror comment at tests/db-errors.test.ts:90–94. Do NOT touch
  `violatedCheckConstraint` (its text-sniff works — the #82 test passes through the real DB) or
  `isDuplicateClientRequestId` (already adapter-aware; consolidation is optional and NOT in
  scope). `isRawRetryableFailure` is already adapter-aware.
- **RED tests** (extend tests/db-errors.test.ts — it already mixes real-DB and synthetic styles):
  (1) real P2002 through the real DB, no conflictField, `Role.name` → "A role with that name
  already exists" (today "…that value…") — the primary pin; (2) real camelCase P2002
  (`Session.tokenHash`) → message contains the field and NO `"` character (pins the
  quote-strip); (3) real P2003 (`paymentType.create` with bogus glAccountId, calling the
  delegate directly — the service pre-check would mask it) → "That gl account does not exist";
  (4) synthetic legacy shapes (meta.target; meta.constraint+modelName) → same messages (pins
  legacy-first ordering); (5) synthetic P2002 with neither shape → falls back to "value", the
  extractor never throws. Keep the existing legacy-shape synthetic at :96–98. Recon verified
  **zero existing tests pin the generic fallbacks** — nothing else changes.

## Task 3 — #30 + #112: CI builds and boots the image; README practice-seed fix

- **#30**: add a **separate parallel `docker` job** to .github/workflows/ci.yml (the main job
  runs 12+ min against a 15-min cap — serial risks the timeout; parallel costs no wall clock).
  Recon's job shape (§"#30 recommendation", use it verbatim as the base): checkout →
  `cp .env.example .env` → `docker compose up -d --wait db` → `docker build -t heatsynq-app:ci .`
  → `docker run -d --network erp_default -p 127.0.0.1:3000:3000 -e DATABASE_URL=postgresql://erp:erp_local_dev@db:5432/erp`
  → a 60×3s curl retry loop against **`/api/health`** (exists, unauthenticated by design,
  `SELECT 1` — a 200 proves container start + all 51 migrations applied + Next serving + the
  adapter connecting), with a fail-fast container-exited branch that dumps `docker logs`.
  No path filter (run always — filtering recreates the #16 blind spot in reverse), no caching
  (boring first; the gha-cache upgrade is noted for later if slow). **Verify locally before
  pushing**: run the build + boot-check command sequence on this machine (Docker is up; use a
  throwaway container name + the compose network; clean up after).
- **#112**: replace README:74–77's parenthetical with recon's exact replacement wording (the
  from-checkout invocation + the same-constraint-as-production sentence). **Also fix the
  adjacent stale claim** recon found at README:53–57: "tsx and dotenv themselves are in the
  pruned image now, as production dependencies" — HALF WRONG (`dotenv` is a production dep;
  `tsx` is dev-only and never was production; container start does not need tsx). Verify against
  the real image you just built (`docker run --rm --entrypoint sh heatsynq-app:ci -c 'ls node_modules/.bin | grep -c tsx'`
  expecting no match) and reword that half-sentence accurately.
- No tests (CI yaml + README). Your verification evidence (the local boot-check transcript, the
  image-inspection output) goes in the task report — a gate row is written after WATCHING the
  run end.

## Task 4 — #32 + #35: the pg@9 tripwire + per-model sweep scoping (TDD)

- **#32** (upstream NOT fixed — recon decompiled the current interpreter: the `Promise.all(...
  children.map)` concurrent sibling loads are still there; the setup.ts REMOVE note does not
  trigger): new DB-free `tests/pg-forward-hazard.test.ts`, the sweep style. (a) MAJOR check:
  `pg/package.json` version (resolvable — pg's exports map exposes it), fail when major ≥ 9 with
  a message naming issue #32, tests/helpers/setup.ts's emitWarning filter, and the reason (pg@9
  removes the deprecate-and-queue path — the suppression's premise, and possibly the queuing
  correctness itself). (b) suppression-still-real check: assert `node_modules/pg/lib/client.js`
  still contains the suppressed literal — **export `SUPPRESSED_PG_DEPRECATION` from setup.ts**
  rather than duplicating the string. Skip the dynamic-provocation variant (threshold-coupled);
  note the sourcemap re-check procedure in a comment. pg arrives only via adapter-pg's `^8.16.3`
  (can never resolve to 9.x), so the tripwire fires exactly when someone deliberately upgrades
  the exact-pinned Prisma stack — the intended moment.
- **#35**: refactor tests/partial-unique-sweep.test.ts to per-model scoping per recon's
  prototyped design: keep `models()`; build `Map<model, Set<column>>`; delegate→model map by
  lowercased-first-letter; widen the call-site regex to optionally capture the receiver
  (`/(?:\.(\w+))?\.(findUnique|...)/`); a captured delegate scopes to that model's set, an
  uncaptured/unknown receiver falls back to the GLOBAL union (conservative — detection strength
  never decreases; state the multi-line-receiver residual in a comment). **RED first**: delete
  the two ALLOWED_CALLS entries and watch the two order-drafts call sites flag under the old
  global matching; then implement scoping and watch them pass with the allowlist gone. **Delete
  ALLOWED_CALLS entirely** (recon prototyped: those two entries are the only matches). Do NOT
  touch the second test's ALLOWED set (the owner-ruled plain-@unique exemptions — all survive)
  and do NOT "improve" the parse regexes (the one-line `@@unique(` assumption is a documented
  HANDOFF §5.11 dependency; the refactor changes where columns are STORED, not how they parse).
  Keep the existing non-emptiness guard rails.

## #34 — close with pointers (controller, no code)

Already implemented in Phase 4 (`f129aae`): `NumberSettingKey = Extract<SettingKey,
`${string}_number_next`>` at settings.ts:116–124 (comment cites #34) PLUS the runtime
non-numeric-default backstop at :126–131, tested at tests/allocate-number.test.ts:72–95. All
eight allocating call sites pass literal keys. Close citing those pointers.

## Process

TDD where a test seam exists (Tasks 1, 2, 4 — watched RED first, exact failure text in the
report). Fresh implementer per task, task-reviewer per task, fix rounds until approved. Full
gates + E2E at close-out. PR closes #30, #111, #40, #35, #112, #32 (NOT #34/#107 — closed
separately); attribution in the PR body; no commit trailers; explicit-pathspec commits.
