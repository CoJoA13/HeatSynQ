### Task 17: E2E flow, demo walkthrough, and docs

**Files:**
- Create: `e2e/flows/receivables-apply-age-statement.mjs`
- Modify: `e2e/run.mjs` (register the flow), `e2e/lib/db-fixtures.ts` (A/R fixtures)
- Create: `docs/2026-08-08-phase-5b-demo.md`
- Modify: `docs/HANDOFF.md` (§4 current-phase note while in flight; the merged paragraph waits for the PR)
- Test: `npm run test:e2e`

- [ ] **Step 1: The north-star flow.** `receivables-apply-age-statement.mjs`: seed a shipped→invoiced order, finalize the invoice; create a batch, add a check, apply a **partial payment + an early-pay discount + a small write-off** leaving an **on-account** remainder; open the **aging** report and assert the invoice sits in the right bucket with the unapplied column populated; **print a statement** (combined family, FC assessed) and confirm it archives and reappears in Documents. Clean the A/R fixtures in teardown (the harness rule).
- [ ] **Step 2: Run `npm run test:e2e` — Expected: the new flow + all prior flows PASS** (16 + 1).
- [ ] **Step 3: Demo doc.** `docs/2026-08-08-phase-5b-demo.md` in the 5A demo's shape: what it delivers, how to watch it live, and any deviations that need an owner ruling (e.g. the batch POSTED lifecycle if the owner wants it trimmed; discount-on-partial-payment basis).
- [ ] **Step 4: HANDOFF note.** Update §4's current-phase block to "Phase 5B in flight" with the three binding docs (spec, this plan, the execution ledger `docs/execution/2026-08-08-phase-5b-accounts-receivable/`).
- [ ] **Step 5: Commit.**
```bash
git add e2e/ docs/2026-08-08-phase-5b-demo.md docs/HANDOFF.md
git commit -m "test(5b): E2E apply→age→statement flow; demo doc; handoff current-phase note"
```

---

## Review and merge

After Task 17, run the plan's own closing sequence — the process that has held for five phases:

1. **Whole-branch review on the strongest model** — spec compliance (§3 rulings, §16 non-goals, §17 5C hooks all honored) + code quality; verdict recorded in the execution ledger.
2. **One fix wave**, then a scoped re-review. The owner-ratified **stopping rule** (CLAUDE.md): from round 6 on, findings triage to issues unless they are correctness, concurrency, or data-integrity defects.
3. **The owner demo** (`docs/2026-08-08-phase-5b-demo.md`) — rule on any flagged deviations.
4. **Gates green** (`npm test`, `tsc`, `eslint`, `build`, `npm run test:e2e`), then the **PR** with attribution in the body (never a commit trailer), squash-merged.
5. **Post-merge:** condense §4a into HANDOFF's "Merged, in build order" as one paragraph, move the narrative to `docs/history/2026-08-08-phase-5b-accounts-receivable.md`, and activate §9 as the **5C** kickoff (month-end close + QBO export).

**Watch-items carried from the design (verify these did not regress at review):**
- No balance is ever cached on `Invoice` — every figure derives from live `Application` rows (spec §4.2).
- Every application claims the invoice row before reading the balance it guards; multi-invoice writes use one sorted `claimOrdersInOrder` statement (`EXPLAIN` shows `LockRows` above `Sort`).
- The `Application_source_check` and the extended `StoredDocument` kind→owner `CHECK` match their schema comments.
- Finance charges are never posted — informational only; 5C inherits nothing to post (spec §17).
- Concurrency tests were verified RED with their guard removed and the competing caller pinned to Read Committed.
