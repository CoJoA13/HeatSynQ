# SDD ledger — plan: docs/superpowers/plans/2026-08-01-prisma-7-upgrade.md

Branch: prisma-7-upgrade (branched from main @ 2be75f2)
Plan committed: 897a1dd

Task 1: dispatched (BASE 1a2148f, implementer=haiku, brief=task-1-brief.md)
Task 1: review 1 — spec OK, quality Approved; 1 Important (RED checkpoint not evidenced)
Task 1: controller resolved both warnings — trailer present on 813ea78; 255/255 tests, tsc+eslint clean
Task 1: fix round 1/5 dispatched (evidence only, no new commit)
Task 1: fix round 1/5 — RED finding ADDRESSED (evidence produced; reproduction PASSED, contradicting the plan)
Task 1: controller independently reproduced: old __dirname config passes under type:module (vite injects it). Real ESM blast radius = 0 files. Plan corrected in 
Task 1: complete (commit 813ea78, review clean — spec OK, quality Approved, 1 Important addressed)
Task 2: dispatched (BASE a19f773, implementer=sonnet, brief=task-2-brief.md)
Task 2: review 1 — spec OK, quality Approved, 0 Critical, 0 Important
Task 2: minor (deferred): report narrated claims (no-any, TransactionClient) beyond what diff shows — no evidence attached
Task 2: minor (folded into Task 3): reviewer advises end-to-end container start, not just image build — Dockerfile comment documents Prisma 6.19 CLI deps that may be stale under v7
Task 2: complete (commit 0fdd8c5, review clean)
Task 3: dispatched (BASE 0fdd8c5, implementer=sonnet, scope extended: build + container start + migrate deploy + HTTP smoke)
Task 3: FOUND PRODUCTION BUG — run image never copied prisma.config.ts; v7 reads datasource.url from it, so `migrate deploy` crash-looped at container start. Host gates were all green. Fixed 155e796.
Task 3: controller found latent issue — dotenv is a devDependency but prisma.config.ts imports it at runtime; survives `npm prune --omit=dev` only as a transitive dep of prisma->@prisma/config->c12. Referred to reviewer for severity.
Task 3: review 1 — spec OK, quality Approved; 2 Important (dotenv misclassified; tsx missing from prod -> `prisma db seed` fails in image)
Task 3: minor (deferred): Dockerfile's Prisma-6 comment re-verified true on 7.9.1 but not annotated as such
Task 3: fix round 1/5 dispatched — scope widened to erp/package.json by controller decision (both findings are prod boot/first-install path; deferring risks loss)
Task 3: fix round 1/5 — both findings ADDRESSED (verified inside rebuilt image, not inferred), no new breakage
Task 3: note for owner/final review — tsx in prod flips esbuild's ~20 platform binaries to production in the lockfile; judged correct/necessary side effect
Task 3: complete (commits 155e796..74c0751, review clean after 1 fix round)
Task 4: dispatched (BASE 74c0751, implementer=sonnet) — schema-only, revival stays, 255 pass + 1 skipped expected
Task 4: `prisma migrate dev` refuses non-interactive envs; implementer used `migrate diff` + hand-written migration + `migrate deploy`. Controller verified: ZERO drift both DBs, 9 migrations each, 13 partial indexes each, User_username_key still plain.
Task 4: NOTE FOR TASK 10 DOCS — CLAUDE.md's `npx prisma migrate dev` recipe works for a human at a terminal but not in non-interactive/CI contexts; the doc rewrite should say so.
Task 4: review 1 — spec OK, quality Approved, 0 Critical, 0 Important. Replay-from-empty ordering verified against all 8 prior migrations.
Task 4: minor (deferred): skipped test proves "new row" by id inequality only, not via readAudit — plan-mandated body; Tasks 5-8 assert history directly
Task 4: minor (deferred): cosmetic blank line before CustomerContact.@@index from prisma format
Task 4: complete (commit 5e3346e, review clean)
Task 5: dispatched (BASE 5e3346e, implementer=sonnet) — expect 254 passing / 1 skipped
Task 5: implementer deviated 3x (all reported): removed a 4th revival-only test (cycle-via-revival), fixed a 5th test's same-id assumption, and KEPT assertParentExists/assertTermsExists that the brief's abbreviated snippet would have deleted.
Task 5: controller verified deviation 3 correct — validation intact, sole remaining findUnique keyed on id. Review dispatched with lost-cycle-coverage as named risk.
Task 5: review 1 — spec OK, quality Approved, 0 Critical, 0 Important. Cycle coverage confirmed retained (customers.test.ts:92-97, :235-249, both untouched).
Task 5: minor (deferred): tests/customers.test.ts:203 "refuses a soft-deleted terms record on revival" is now stale/redundant with :189 — inert, rename or delete in cleanup
Task 5: complete (commit daa6a62, review clean) — 253 passing / 1 skipped
Task 6: dispatched (BASE daa6a62, implementer=sonnet) — seed P2039 must be observed as RED first
Task 6: implementer disproved the brief's "seed upsert throws P2039" prediction. Controller measured 3 DB states and CONFIRMS: only-dead-row => upsert SILENTLY reuses the dead row (worst case, no error); live-row => normal; dead+live => throws. Plan ground-truth table corrected.
Task 6: IMPLICATION FOR TASKS 7-8 — do not repeat the "throws P2039" framing; the real risk is silent reuse.
Task 6: review 1 — spec OK, quality Approved, 0 Critical, 0 Important. Comments verified to state the real silent-reuse behaviour.
Task 6: minor (deferred): task-6-report.md:290 has an off-by-one in its own before-count narrative; headline totals correct
Task 6: complete (commit f32c4f9, review clean) — 254 passing / 1 skipped
Task 7: dispatched (BASE f32c4f9, implementer=sonnet) — covers all 10 reference kinds; must un-skip the Task 4 test, leaving ZERO skipped
Task 7: review 1 — spec OK, quality Approved; 1 Important (it.each weaker than the test it replaced for inspectionCode/paymentType — defect ORIGINATED IN PLAN TEXT, not implementation)
Task 7: minor (deferred): RefDelegate.findFirst types `where: object`, so a caller could omit deletedAt:null without a type error — one call site today, flagged for Task 9's sweep
Task 7: fix round 1/5 dispatched; plan text corrected in the same pass
Task 7: fix round 1/5 — finding ADDRESSED; implementer proved it by mutation testing (reintroduced the bug, all 5 kinds failed, reverted). reference.ts untouched.
Task 7: minor (deferred): fix omits the includeInactive/?? null belt-and-braces from the controller's corrected snippet — harmless on the tested path (row is live at that point)
Task 7: complete (commits 91fdcaf..b7e69f5, review clean after 1 fix round) — 258 passing / 0 skipped
Task 8: dispatched (BASE b7e69f5, implementer=sonnet) — LAST revival site; dispatch carries Task 7 lesson about trivially-passing reset assertions
Task 8: review 1 — spec OK, quality Approved, 0 Critical, 0 Important. Test seeding verified non-trivial (real gl id + "F1", asserted pre-delete).
Task 8: minor (deferred): "re-created code comes back active even if predecessor was inactive" no longer directly tested; structurally impossible to regress (no predecessor coupling remains)
Task 8: complete (commit 3d35861, review clean) — 256 passing / 0 skipped
Task 8: ALL FOUR REVIVAL SITES REMOVED. Controller verified branch-wide: zero findUnique/upsert keyed on code|name in src/ or prisma/seed.ts.
Task 9: dispatched (BASE 3d35861, implementer=sonnet) — mutation-test proof mandatory; guard against vacuous/false-green sweep
Task 9: sweep found a THIRD plan-text defect — my \s+ regex bridged newlines so @@unique matched the @unique pattern, false-flagging 6 relation fields. Implementer fixed with [ \t]+ and (?<!@).
Task 9: controller independently mutation-tested via prisma/seed.ts upsert — sweep failed naming that file, proving it reaches outside src/ AND catches upsert. Tree restored clean.
Task 9: review 1 — 2 Important (test 2 lacks a non-vacuity guard; stale "throws P2039" in comment + expect message + commit body). Fix round 1 dispatched; plan snippet corrected.
Task 9: fix round 1/5 — both findings ADDRESSED; re-proved by mutation; tree clean; 258/258
Task 9: minor (deferred): models() parsed twice per run (cosmetic)
Task 9: complete (commits 882860c..40524c4, review clean after 1 fix round)
Task 10: dispatched (BASE 40524c4, implementer=sonnet) — docs only; clean-clone verification is the real gate
Task 10: clean-clone verification PASSED (followed CLAUDE.md verbatim in a fresh clone; tsc + 258 tests + eslint green). DBs verified intact after: 9 migrations each, dev data preserved.
Task 10: fix round 1 — implementer flagged 3 more live stale docs; controller swept all .md, confirmed scope = erp/README.md + root README.md + phase-2-kickoff §2.6. Executed-plan archives deliberately NOT edited (falsifying a record != correcting a doc).
Task 10: CRITICAL CATCH — phase-2-kickoff §2.6 instructed Phase 2C to BUILD revival-on-create and to copy createReference (which no longer has it). Marked superseded in place, reasoning preserved.
Task 10: fix round 2 — root README.md still said "Prisma 6"; dispatched.
Task 10: fix rounds 1-2 — all findings ADDRESSED; archives confirmed untouched; kickoff §2.6 now unmistakably superseded with reasoning preserved
Task 10: minor (deferred): erp/README.md:9 credits `migrate deploy` with never-having-generated the client — harmless overreach vs CLAUDE.md's narrower claim
Task 10: minor (deferred): root README "Build phases" still says "process masters" (superseded by Process Steps in 2A) — milestone drift predating this branch
Task 10: complete (commits 1b7fb21..0759773, review clean after 2 fix rounds)
ALL 10 TASKS COMPLETE. Branch 2be75f2..0759773, 20 commits, 258 tests / 0 skipped, all four gates green from a clean regenerated state.
FINAL REVIEW (opus): MERGE AFTER FIXES. 1 Important — sweep had 2 holes: (a) only findUnique|upsert, missing findUniqueOrThrow/update/delete which take the same WhereUniqueInput and WRITE/HARD-DELETE the archived row; (b) block-level @@unique([a,b]) invisible — exactly Phase 2C's Part shape. Both fixed + mutation-proved.
FINAL FIX WAVE: 5 commits (1c92af6 sweep, acb682f tsx->devDeps, 800f743 db.ts loud fail, d1be95a docs, 724e921 sweep limit note). Docker boot of FINAL tree verified: 9 migrations, HTTP 200, dotenv present / tsx absent, dbdata intact.
FINAL RE-REVIEW: All findings addressed, no new breakage — READY TO MERGE.
BRANCH COMPLETE: 2be75f2..724e921, 25 commits, 258 tests / 0 skipped, four gates green from clean regenerated state.
PR #11 opened: https://github.com/CoJoA13/HeatSynQ/pull/11 (base main, head prisma-7-upgrade). Worktree/branch preserved for PR feedback.
