# Phase 3 SDD progress ledger — plan docs/superpowers/plans/2026-08-02-phase-3-orders.md, branch phase-3-orders, started 2026-08-02
Task 1: complete (commits 5a93325..646872a, review clean — spec ✅, quality Approved)
Task 2: complete (commits 646872a..e56219c, review clean — spec ✅, quality Approved)
  Minor carried: splitLoads has no loadQty<=0 guard (hangs) — real caller (T4) must guarantee >=1-or-null; message-prefix DRY nit in serial-range.ts
Task 3: complete (commits e56219c..6a23b0d incl fix round 1, re-review Approved)
  Minors carried: race-test 200ms window fails silent-green not red (documented in-test); lockCurrentRevision ALSO throws 404 'Part not found' beyond brief Produces (T4+ must handle); allocateNumber FOR UPDATE still has no discriminating test; allocateNumber accepts non-numbering SettingKeys (misbehaves on e.g. company_name); allocation writes bump updatedAt w/ null updatedBy; stale-LIMIT caveat undocumented in lockCurrentRevision comment; idempotency test asserts count not content; audit-exception docs need branch-level pass (allocateNumber is a third unaudited write path)
Task 4: complete (commits 6a23b0d..c132cab + infra c4937e1, review Approved; issue #32 filed for pg@9/adapter)
  Resolved post-review: pg DeprecationWarning filtered in test setup (dotenv precedent, issue #32); SNAPSHOT serials ordering -> line position (was minor 1)
  Minors carried: CHECK constraint on Part.loadQty (hang class) -> fold into T6; 'This part has no process steps' lacks line anchor (spec-pinned copy — owner glance at demo); concurrency 409 test can't isolate mechanism (covered by allocate-number tests); empty-string dates default silently + dir param coerces (route-layer note for T9); createOrder 409 retry is a T13 UI decision
Task 5: complete (commits c4937e1..1aa452c incl union-ruling fix round, re-review Approved; owner ruling: link = union, recorded in spec §5d)
  Minors carried: T5 fix-report prose says six tests (five is correct); voided-groupmate-in-merge untested; case-2/3 link branches lack audit-content assertions (case 1 covered); orders.ts at 1061 lines (split candidate at create/edit seam for final review); stale deleteReference comment in reference.ts undercounts containerType writers; updateOrder({}) empty-patch behavior untested; shared 'Order not found' literal DRY nit
Task 6: complete (commits 1aa452c..a4474c7 [2 commits: loads svc + CHECK constraints], review Approved)
  Minors carried: position-only load correlation caveat needs durable home for T14 loads-editor UI (comment/backlog); 23514 originalCode asserted once per column only; no audit-diff on same-length load edit
Task 7: complete (commits a4474c7..fc00ccb, review Approved; both sweep-allowlist edits verified narrow)
  Minors carried: updateView rename-collision path untested (relies on P2002 backstop); 256KB draft cap boundary untested at exact limit; partial-unique sweep's schema-wide column matching is pre-existing imprecision (could recur — root fix out of T7 scope)
Task 8: complete (commits fc00ccb..ce3cfe3, review Approved; exactOrderId ungated ruling verified against 3 planning artifacts — resurface in demo for owner veto)
  Minors carried: recency ordering untested; rider-line serial match untested; voided-via-serials path untested; lead-part-number order match exceeds T8 brief literal list (benign, tested)
  T17 docs note: spec §9 route table says POST/PATCH/DELETE for containers/serials/charges but PUT-replace is what plan+services+routes built — align the spec table wording (stale artifact, T9 review ⚠)
Task 9: complete (commits ce3cfe3..f3dc22c incl fix round 1, re-review Approved; 17/17 handlers 401+403+200; all 3 minors taken)
Task 10: complete (commits f3dc22c..7646f44 incl draft-wipe fix round, re-review Approved; payload-key guard + explicit-null contract regression-tested)
Task 11: complete (commits 7646f44..3c03539 incl voided-reads fix round, re-review Approved; REQUIRES_LIVE 2x2 matrix)
  Minors carried: upload buffers whole file before cap check (streaming/abort-early — internal tool, low priority)
Task 12: complete (commits 3c03539..600e300 incl rejection-fix round, re-review Approved)
  Minors carried (deferred by choice): voided-row order# link keeps blue underline (conscious-choice item); board page.tsx 413 lines (split candidate: filter bar/saved-views bar/column picker)
Task 13: complete (commits 600e300..5b6ce02 incl 4-part fix round, re-review Approved; race closed w/ timestamped proof; warnings panel applies visibly-never-silently ruling — show owner in demo; hasProcessSteps batched into parts payload)
  Minors carried: isDraftEmpty doc-comment doesn't cross-ref the DELETE branch (cosmetic); Combobox lacks ARIA combobox semantics (backlog); loadError append-only (precedent F9)
SAMPLES GATE CLEARED (owner rulings, 2026-08-03): mockup IS the traveler target — build now; PartInspection gains optional free-text sampleQty (migration+UI+traveler column, folded into T16 w/ dated spec §3.9 amendment); no inspection images in P3 (P4/P7).
Task 14: fix round in flight (bulk-grid orphaned-edit warning)
Task 14: complete (commits 5b6ce02..4f5d48f incl bulk-grid orphan fix, re-review Approved)
  Rides with T15: wire grid.orphanWarning into LoadsSection (shrink-path residual, one-liner)
  Minors carried: Documents placeholder copy (mine, fine); decimal-precision client checks generic 400 (systemic precedent); serialization warning needs parts.view (advisory degrade); AttachmentsSection tooltip conflates voided w/ permission (shared-component limit)
Task 15: complete (commits 4f5d48f..84d5264, review Approved; customers blockers route = parts+orders union)
  Minor carried (final wave): customer page requestDaysOverride whitespace input saves 0 instead of clearing (v.trim() one-liner — sibling asymmetry vs parts page)
OWNER RULING (2026-08-03): traveler 'Process:' cell renders BLANK for P3 (P7 designer owns it) — supersedes T16's 'Rev N (locked)' rendering; Material + Process ID (lead partNumber) stay. Fold into T16 fix round + spec §3.9 amendment addendum.
Task 16: complete (commits 84d5264..125ea43 incl print-UI fix round, re-review Approved; 904 tests; Process cell blank per owner ruling; spec §3.9 double-amended)
  Minors carried: sheet-overflow loses header on 20+-step revisions (latent); router.replace drops whole query string (future-proofing); blank-Process test pins by text absence; owner-list observations recorded in spec (Process ID = lead part number vs mockup family mask; load-weight sub-line addition)
Task 17: complete (commits 125ea43..8ffcc28 + docs nit fix, re-review Approved; refuted eleven→ten finding conceded w/ evidence; E2E 10/10 x3)
ALL 17 TASKS COMPLETE. Final whole-branch review next (fable, merge-base 90be915).
FINAL: whole-branch review (fable) verdict with-fixes; wave 379b9bd applied; issues #33-#38 filed; docs nit 9c839cf; gates re-verified 904/904+tsc+eslint at HEAD; pushed; PR #39 open (squash-only, attribution in body). Awaiting owner demo review + merge.
CODEX ROUND 1 (PR #39): 12/12 findings fixed across 5 commits (31f26af 7ab0b7b e8ba4ae b3655e5 43536dd), 929/929 tests (+25), E2E 10/10 x3, CI green, 12/12 threads replied+resolved.
  Notes: vi.spyOn unsafe on prisma delegates (mockRestore corrupts the singleton — test-convention note for a future docs pass); allocateNumber Int4 check runs on RAW stored value pre-fallback (silent-reseed hazard documented in code); dormant attachment-audit-residue sibling in db-fixtures flagged as follow-up chip (unreached — no E2E uploads yet).
CODEX ROUND 2 (PR #39): 7/7 fixed (d21ee5f a284ef2 a381ab3 2515e1b), 953/953 tests (+24), E2E 10/10 x2, 6 threads replied+resolved + 1 PR comment.
  Note for owner: finding 7 relaxed the hub Process section's gate to orders.view alone (was processes.view via the parts route) — consistent with the traveler already printing the full recipe under orders.view; cheap reversal if vetoed.
CODEX ROUND 3 (PR #39): 6/6 fixed (c796bae..6c0ae10 incl claimOrder unification + StoredDocument index migration), 961/961 tests (+8), E2E 10/10, both DBs clean, CI green, 6/6 threads resolved.
  Notes: renderPdf not byte-deterministic across calls (tests pin /Count marker instead — future traveler-test knowledge); order-loads holder test passes pre-fix via FK locking (kept as pin; traveler tests are the discriminators).
CODEX ROUND 4 (PR #39): 9/9 fixed (860012a..1921f7e incl clientRequestId idempotency migration), 1010/1010 tests (+49), E2E 10/10, both DBs clean, CI green, 9/9 threads resolved.
  Filed: db-errors P2002/P2003 meta-path mismatch (pre-existing, #40). Owner notes 5-6 appended to demo doc. If round 5 arrives: apply the 2C-3 stopping rule (fix correctness/concurrency/data-integrity; triage the rest to issues).
MERGED: PR #39 squashed as 12a17f9; tree byte-identical to 56063b6; main green 1010 tests+tsc+eslint; round 5 triaged to #41-#46 per owner ruling; HANDOFF close-out pushed. PHASE 3 DONE.
