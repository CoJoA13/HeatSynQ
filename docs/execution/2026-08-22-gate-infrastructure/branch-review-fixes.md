# Whole-branch fix round — `gate-infrastructure` (2026-08-22)

The whole-branch review returned **"Ready with follow-ups"**. Nothing in it was a correctness
defect: the branch changes no application code, and every new guard had already been verified to
fail in the closed direction. What it did return was one merge blocker, two documentation findings
that matter, six cheap fixes and two issues to file. All of them are dispositioned below.

This round is recorded in its own file rather than appended to a task report because it spans four
of the five tasks and two documents neither of them owns.

---

## 1. Merge blocker — the `gates` skill under-ran the lint gate that CI runs

`.claude/skills/gates/SKILL.md:19` said `npx eslint src tests e2e`. Task 2 widened it to that;
Task 5 then widened **CI** (`.github/workflows/ci.yml:57`) and `CLAUDE.md` to
`npx eslint src tests e2e scripts prisma` and did not come back for the skill. So an agent running
the `gates` skill got a green lint that CI could red — **in the branch whose subject is checks that
do not run what they claim**, and against directories (`scripts/`, `prisma/`) this very branch
discovered had never been linted once.

Fixed to `npx eslint src tests e2e scripts prisma`, with `# keep in step with ci.yml` beside it so
the next widening has somewhere to look.

While in the file: line 28 said "10 Playwright flows". There are 25. Rather than write 25 — the
same number goes stale the same way, and `CLAUDE.md`'s own maintenance rule forbids counts that
ordinary commits move — it now reads "the whole Playwright flow suite".

`.claude/settings.json`'s stale `Bash(npx eslint src tests)` allowlist entry was **left alone**: it
is the owner's to edit, and two implementers correctly left it alone before me.

---

## 2. Important 1 — the sixth over-claim, about this branch's own artifacts

`docs/HANDOFF.md` stated `invoicing-detail.png` as *"2967×2868 … 1,229,354 B on disk / 1.56 MB
inlined, 11.5% of the whole page"*. Every one of those numbers described the **pre-re-capture**
file, and the 11.5% was computed against the **pre-re-capture 14,213,844 B page** — in the same
sentence that correctly reports the new 12,995,012 B page size. `task-5-report.md:659` and its §13.5
have it right — the report even carries the parenthetical HANDOFF dropped (*"`invoicing-detail.png`
moved 2967→2974 px wide for the same reason"*). The permanent document was simply never re-anchored
after the final commit (`2e424f3`).

Re-measured from the committed artifacts, not from the report:

| | stated | measured |
|---|---|---|
| dimensions | 2967 × 2868 | **2974 × 2868** |
| on disk | 1,229,354 B | **1,220,846 B** |
| inlined (base64) | 1,639,140 B / "1.56 MB" | **1,627,796 B / 1.55 MB** |
| share of the page | 11.5% of 14,213,844 B | **12.5% of 12,995,012 B** |

The density basis was re-derived on the **same basis the first estimate used** (the other 49 files
in `docs/manual/img/`, verified by reproducing the old 0.0897 / 0.1445 / 1.61× from `2e424f3^`) so
the correction is a re-measurement rather than a quiet change of method: fleet **0.0848 B/px**, this
figure's own **0.1431 B/px**, ratio **1.69×**. Only the first hypothetical moves materially
(**~1.11 MB** recovered in the likely case, was ~1.09; the 1.5×-taller case 0.43 → 0.42; the other
two unchanged).

The same HANDOFF line claimed *"exactly two PNGs changed HEIGHT; the other 15 that moved kept their
dimensions to the pixel."* Measured across `2e424f3^..2e424f3`, **three** figures changed
dimensions:

```
admin-audit.png        (1440, 6000) -> (1440, 4000)
parts-detail.png       (1440, 5129) -> (1440, 4000)
invoicing-detail.png   (2967, 2868) -> (2974, 2868)     <- WIDTH, and unreported
```

The height half was true; the "other 15 kept their dimensions to the pixel" half was not — it is 14,
and the fifteenth is the very figure the next sentence goes on to price. Corrected in place, naming
all three.

**The public record was corrected too.** The stale figures had been posted as a comment on #170, and
the branch moved the page from 84.7% to 77.5% of the ceiling *after* that comment. A short
correcting comment now sits under it — what changed and why (`MAX_SHOT_HEIGHT` was right-sized
afterwards), the corrected table, the re-derived density caveat, and the unchanged conclusion that a
fix recovers ~1 MB in the likely case:

<https://github.com/CoJoA13/HeatSynQ/issues/170#issuecomment-5383726685>

---

## 3. Important 2 — #188 had no HANDOFF entry, and it is the one whose scope was overridden

The other four tasks each got a dated paragraph in HANDOFF §5a. #188 had none — so the record that
**part 2 was built despite `brief.md:63–65` declaring it out of scope** existed only inside
`task-1-report.md` §8, and HANDOFF is the portable memory a future session actually reads.

One paragraph added, ahead of Task 2's, so the five now run 1 → 5 in order. It carries: the
falsified premise (*"No wrapper exists — all twelve files mount the panel directly"*, a sentence
lifted from inside the test file itself); the six route shells that were invisible to the census and
are now folded into it; that the walk is the transitive closure and why type-only edges are excluded
(counting every import edge answers sixteen, not six, because ten child sections `import type` from
their own panel-mounting parent); and the argument that mattered — **the deferral's own stated
reason, that the shape of the real case was unknown, is exactly what made overriding it right**,
because the shape is the idiom every detail route here is written in and six were already standing.

Part 1 (the AST detector) is in the same paragraph, since there was no entry for it either.

---

## 4. The six cheap fixes

**(1) `ci.yml`'s pre-flight comment under-enumerated what it reasons about.** It named three
conditions; there are four, plus the `preliminaryError` reason added in `2c06e21` — after that
comment was last edited. The conclusion (a pristine CI database cannot trip it) still holds and is
kept; the enumeration is now four-plus-one and says outright that `e2e/lib/preflight.mjs` is the
authority and this comment has already gone stale against it once. **Two more copies of the same
stale count were found and fixed while there**: `e2e/run.mjs`'s call-site comment and
`e2e/lib/db-fixtures.ts`'s `preflight` docblock, both saying "three conditions". All three now point
at the one authority instead of re-listing.

**(2) `CLAUDE.md` stated the flow-lint and raw-mutation rules without their real scope.** Both
sweeps read `e2e/flows/` **only** — `e2e/lib/`, where `boardRow` and `assertNeverVisible` now live,
is unswept — and `RAW_API_MUTATION` matches the literal receiver `request`, so
`const req = page.request; req.post(...)` walks through. `CLAUDE.md` said "in any flow", which reads
as "anywhere in the suite". Both paragraphs now state the scope truthfully and point at #192. **The
sweeps themselves were deliberately not widened** — that changes what the suite refuses, which is a
decision of its own, and it is the issue below.

**(3) Artifact rotation ran before the refusals.** `e2e/run.mjs` rotated `e2e-artifacts/` into
`-prev` *before* the flow-lint sweep and the dev-DB pre-flight, so two consecutive **refused** runs
pushed a real failing run's evidence out of `-prev` while producing none of their own to replace it
— defeating the one-generation guarantee #184 fix (b) exists to provide, in exactly the situation a
developer hits it (fixing the thing being refused, re-running each time). `task-2-report.md` §12
called this harmless; it is not quite. The rotation now happens **after** both refusals and before
the fixtures, which is the first moment anything on disk needs to exist. The port check stays first,
for its own reason (a refused second process must leave a running one undisturbed) — the two
orderings are the same principle one step further apart, and the comment says so.

**(4) `warmupRefusal` was silent on an empty route set** and pinned that way
(`tests/e2e-harness.test.ts`, *"says nothing about an empty route set"*). It was the one path where
the warm-up did nothing whatsoever and the run proceeded, printing `warmed 0 routes` — a phase whose
entire job is compiling every route before flow 1, compiling none of them, while every other failure
of that phase refuses. It is now a fourth refusal, placed after the `skipped > 0` branch so a blown
budget still reads as a blown budget. It names the real cause — `enumerateRoutes` walks a directory,
so an empty answer is a harness fault (`appDir` no longer points at `src/app`), never a server one.

The pinning test is flipped to match and a second test added for the discrimination
(`count: 0, skipped: 243` must still report the budget). **RED-verified**: with the new branch
disabled, exactly one test fails —

```
× warmupRefusal > refuses an empty route set — the warm-up did nothing, which is not a healthy warm-up
  Tests  1 failed | 60 passed (61)
```

**(5) `CLAUDE.md`'s two E2E paragraphs had accreted, and reintroduced a moving number.** The CI-job
and harness paragraphs came to 913 words between them, much of it restating `ci.yml`'s own comments
and HANDOFF's dated entry nearly verbatim. Cut to **773**, keeping every durable rule and dropping
the mechanism that is better stated where it lives: the `pg_wrapper`/`user_cluster_map` derivation,
the 240 s / 8× / ~2× warm-up-budget arithmetic, the 4-core runner reasoning, the ~65 MB upload size,
and the `docker`-precedent argument. Both now end by pointing at HANDOFF §5a, dated, for the
numbers. The moving measurement this branch had introduced — *"0.18 s"* for the manual rebuild in
CI — is now "a fraction of a second". (The reviewer also cited a "15-minute cap" in `CLAUDE.md`;
that string does not appear in the file — it lives, correctly, in the dated HANDOFF entry.)

**(6) `task-4-report.md` §8 read as current until §11.** Its item 1 retained both the 25/35 timeouts
and *"a cancelled job skips its remaining steps"*, each corrected by that report's own fix round
(§11 minors 3 and 1), with no strike-through. Marked superseded in **Task 1's convention** —
`~~struck~~` with the correction stated inline — plus a blockquote at the top of §8 saying to read
§11 first. The wrong text is kept rather than rewritten, because what a round got wrong is part of
the record.

---

## 5. Issues filed

- **#192** — <https://github.com/CoJoA13/HeatSynQ/issues/192> — the flow-lint and raw-mutation
  sweeps never read `e2e/lib/`, and `RAW_API_MUTATION` matches only the literal receiver `request`.
  Names both concrete escapes (a bad locator in a shared helper is uncaught;
  `const req = page.request; req.post(...)` passes) with the four-case demonstration, every
  enforcement point by file, and the note that the detector documented as failing CLOSED fails OPEN
  on the receiver. `ready-for-agent`.
- **#193** — <https://github.com/CoJoA13/HeatSynQ/issues/193> — ten `throw new Error(...)` sites
  across `e2e/flows/*.mjs`, tabulated by file:line, plus `e2e/lib/ui.mjs:178,184`'s
  currently-unused `expectEqual`/`expectTrue`, are plain `Error`s and so escape `classifyFailure`'s
  `ERR_ASSERTION` hard override — with any stale `netFailure` in the flow they classify as
  `network`. Bounded exactly as the docstring says ("23 of the 25 flows import `node:assert`"), but
  the override is mostly-complete rather than complete, and the sharpest cases are the hand-rolled
  timeout throws — the shape most likely to fire on the same contended machine most likely to carry
  a stale `netFailure`. `ready-for-agent`.

---

## 6. Gates

| Gate | Result |
|---|---|
| `npx eslint src tests e2e scripts prisma` | **exit 0** |
| `npx tsc --noEmit` | **exit 0** |
| `node --check` on both touched `.mjs` (`e2e/run.mjs`, `e2e/lib/warmup.mjs`) | **ok** |
| `npx vitest run tests/e2e-harness.test.ts tests/audit-children.test.ts tests/manual-artifacts.test.ts` | **110/110 passed** (61 + 43 + 6) |
| `actionlint 1.7.12` on `ci.yml` | **exit 0** |
| `npm run test:e2e` | **25/25, exit 0, zero RETRIED** — on the second run; see below |

`shellcheck` was not on this machine's PATH, so `actionlint -shellcheck` could not run its script
pass. The `ci.yml` change is **comment-only** (verified from the diff — no `run:` block is touched),
so nothing shellcheck inspects changed.

The full `npx vitest run` was deliberately **not** run here; the owner runs it centrally.

### The E2E suite, honestly: the first run was red, for the cause this branch documents

Run 1 (`npm run db:reset -- --yes` first, pristine dev DB) came back **2 of 25 failed**:

```
FAIL  reverse-shipment  (network-level; not retried: 4 mutating request(s) already committed)
FAIL  close-month-end   (assertion-level; not retried: assertion failure, not a network-level one)
```

`reverse-shipment` timed out waiting for the reversal page, and the harness's own instrumentation
named the reason without being asked:

```
2 request(s) got no response during this attempt (37s long):
  -30.0s  GET  /api/orders/cmt56hkmr005ktsijrc5avmhs        — net::ERR_NETWORK_CHANGED
  -30.0s  POST /api/shippers/cmt56hlxp005otsijrixbig22/reverse — net::ERR_NETWORK_CHANGED
```

The POST appears **nowhere** in `e2e-artifacts/dev-server.log` — it never reached the server.
`close-month-end` then failed on `readinessGaps` naming Invoice 1009 and the run's own surcharge:
a cascade from the reversal the aborted POST never created, not an independent failure.

`docker events` over the run window shows the documented trigger in the act — another project's
Testcontainers-style suite creating and destroying anonymous Postgres containers on this host:

```
container create/start  zealous_montalcini
  exec  sh -c PGPASSWORD='test' psql --username test --dbname test --host 127.0.0.1 -c 'select version();'
container die/destroy   zealous_montalcini
container create/start  serene_goldwasser        … and again, and quizzical_newton after it
```

Nine such create/start/die/destroy events in thirty minutes. Each one creates or destroys a `veth`
pair, which is a host network-configuration change, which is what makes Chromium abort every
in-flight request including `localhost` — the exact mechanism HANDOFF §5a records as measured, and
the exact workload it names as the case that was caught. **Three parts of this branch's own work
behaved correctly under it**: the classifier called it network-level, the retry gate refused a retry
because four mutations had already committed, and `dev-server.log` supplied the negative evidence.

Run 2 (dev DB reset again) was **25/25, exit 0, zero RETRIED**, and confirmed the two behaviour
changes end to end:

```
Checked 25 flow file(s) for uncounted APIRequestContext mutations, … : none
Dev DB pre-flight for 2026-08: no close period, 0 unposted batch(es), variance 0, 0 ambient readiness gap(s)
Previous run's artifacts kept at …/e2e-artifacts-prev
Creating dev-DB fixtures (erp)...
…
  warmed 243 routes (45 pages, 198 API) in 20.2s
```

— the rotation now printing **after** both refusals, and `e2e-artifacts-prev/` holding run 1's
`reverse-shipment/05-failure.png` and its video. Which is the one-generation guarantee doing its job
on a real failing run, one commit after the change that protects it.

The dev database was reset to pristine afterwards; the working tree is clean.

---

## 7. Found and not fixed

- **`CLAUDE.md` still says "the 14 chapters"** in the `manual:build` paragraph. That is a count an
  ordinary commit moves, and the file's own maintenance rule forbids those — but it predates this
  branch and is arguably a structural fact about the manual rather than a tally. Left alone rather
  than widened into an unrelated edit; worth a decision if anyone adds a chapter.
- **`e2e/run.mjs`'s port-check comment still says "the artifacts rotation below"**, which remains
  literally true after the move but is now two refusals further below than when it was written. Not
  reworded; it would say the same thing.
- **The `easysynq` container stack and its Testcontainers-style suite share this development host.**
  Nothing to fix in this repo, but it means the E2E gate here will keep producing occasional
  network-level failures until the two workloads stop overlapping — which is exactly what
  `CLAUDE.md` says ("Don't run a container-churning workload beside the suite") and what run 1 above
  is a fresh datapoint for.
- **Branch protection still requires only the `ci` check**, so the new `e2e` job runs on every PR
  but does not block a merge. Owner's to change in repo settings; already recorded in HANDOFF §5a
  under "Still owed by the owner".
