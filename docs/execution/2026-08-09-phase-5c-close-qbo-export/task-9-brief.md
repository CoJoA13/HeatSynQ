## Task 9: E2E flow, demo doc, and documentation

**Files:**
- Create: `erp/tests/e2e/close.spec.ts`, `docs/2026-08-09-phase-5c-demo.md`
- Modify: `docs/HANDOFF.md`, `CLAUDE.md`, and the spec's §15 decision log if the contract shifted

**Interfaces:** none (verification + docs).

- [ ] **Step 1: Write the E2E flow** `close.spec.ts` (Playwright, DEV db `erp`, bundled Chromium; heed the `getByLabel`-on-`<select>` trap — use `getByRole("combobox")` / `locator("label",{hasText}).locator("select")`): sign in as admin; set the three GL defaults in Admin → Billing; create + finalize a July-dated invoice; take a payment with a discount + a small write-off; open `/receivables/close`; assert the preliminary schedule reconciles (variance 0); close July; export; download the CSV and assert Σdebit = Σcredit by parsing it; then reopen July, void the payment, re-close, re-export, and assert a non-empty balanced reversing delta. Clean up the fixtures from the DEV db afterward.

- [ ] **Step 2: Run the full gate chain.**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build && npm run test:e2e
```

Expected: all green. Capture the counts for the handoff.

- [ ] **Step 3: Write the demo doc** `docs/2026-08-09-phase-5c-demo.md` — the walkthrough (seed accounts → enter a month → preliminary → close → export → reopen/correct/re-export), a screenshot or two of the register, and a **flagged-deviations** list for an owner ruling. Explicitly restate the two owner-homework items (spec §14): the real GL account list, and the bookkeeper's QBO import method + the correction-JE-dating question.

- [ ] **Step 4: Update the docs (part of the work, not a follow-up).**
  - `docs/HANDOFF.md`: §4 — add the current-phase state (or, once merged, a one-paragraph "Merged, in build order" entry + the history-file pointer); §9 — replace the 5C kickoff with the next work (Phase 6 quoting, or the 5B/5C follow-up backlog). Update the migration count and test tallies (dated).
  - `CLAUDE.md`: add the two new house rules this phase establishes, displacing nothing that stands — **(a)** the period-lock advisory-lock pattern (the guarded fact is the *absence* of a `ClosePeriod` row, so both the close and `assertPeriodOpen` take a per-`(year,month)` `pg_advisory_xact_lock`; a plain `findFirst` is not a guard), and **(b)** the GL-export delta contract (per-event `GlPosting` ledger, bounded by the exported period-end, new/reversed detection — idempotent and reversal-safe; nothing cached on `Invoice`/`Payment`/`Application`).
  - The spec's §15 decision log / the 5C design spec's §17 only if an owner ruling amended the contract during execution.

- [ ] **Step 5: Commit the docs and demo.**

```bash
git add docs/HANDOFF.md CLAUDE.md docs/2026-08-09-phase-5c-demo.md erp/tests/e2e
git commit -m "docs(5c): E2E close flow, demo, and handoff/house-rule updates"
```

- [ ] **Step 6: Open the PR** (attribution in the PR body, never a commit trailer). Summarize the deliverables, the gate results, the two owner-homework items, and any deferred review findings.

---

