# Task 8 — Reports E2E flow + docs

**Branch:** `phase-8a-reports-scoreboard` (no PR/merge). **Plan:** §"Task 8". Final task of 8A: prove the reports in the real app (Playwright) and update the docs as part of the work (CLAUDE.md doc-maintenance rule).

## Part A — the E2E flow (the concrete deliverable)

Add ONE new Playwright flow, `e2e/flows/reports.mjs`, and register it in `e2e/run.mjs`'s `FLOWS` array (as the last flow, `as: "admin"` — it reads only and nothing depends on its state; follow the `board-search-scan.mjs` read-only-nav precedent for structure, screenshots, and the flow signature).

The flow, as admin (reads-only — creates NO orders/invoices/fixtures; the reports render whatever seeded/fixture data exists, so it must be **tolerant of empty or non-empty** results — assert on the page chrome/controls, not on specific row counts):
1. Navigate to `/reports` via the nav; assert the report entries render (Backlog, Shipped, Turnaround, Sales, Payments received, + the homed Invoice register / A/R aging).
2. Open one report (e.g. `/reports/backlog`); assert the table + filter controls render; apply a date-range and/or customer filter; assert the table responds (no error).
3. Click **Export to Excel**; assert the xlsx download happens (the download event / a non-empty file) — the export path is the one shared across all reports.
4. Open the **scoreboard** (`/reports/scoreboard`); assert the three figures + their basis labels render; click the **this-week** and **this-month** presets; assert the window updates.

Keep it robust to the flake landscape: it must not depend on close-month-end or any period state. Place it at the FLOWS tail (after `templates-admin`); it needs no fixtures, so `db-fixtures.ts` needs no new reap entry (confirm — if the flow truly creates nothing, there is nothing to clean).

## Part B — docs (draft; the controller finalizes the merge-state parts)

- **CLAUDE.md:** add ONE curated line (no counts) recording the **reports platform** convention for future work: the `/reports` section + the `reports` area now live; every report is the five-part shape (pure-core service + query.ts + json/export routes + client UI) cloned from A/R aging; reports are **pure reads** (no claim/audit/Serializable — the §11 reads-never-mutate rule); financial reports read the **frozen invoice snapshot** and recognize on `finalizedAt` (Sales) while the scoreboard is a VS-eyeball on `invoiceDate`. Displace/curate, don't just append.
- **HANDOFF.md:** note that 8A (Reports + Scoreboard) is built (the full merge-state paragraph + §4 finalization is the controller's at merge — draft the one-liner, flag the rest for the controller).

## Method & gates

- Get the flow green locally: `npm run test:e2e` runs the whole suite — but to verify JUST your new flow quickly during development without fighting the `close-month-end` flake, you MAY temporarily run a reduced FLOWS (revert any such temp edit before handing off) OR ask the controller to run it. **Do NOT leave any temp edit to `run.mjs`.**
- The controller runs the full gate chain (incl. the full E2E with the new flow) after handoff.
- Commit small units (conventional messages, **no attribution trailer**).

## When done

Write `docs/execution/2026-08-14-phase-8a/task-8-report.md` (the flow built, the CLAUDE.md line added, the E2E result you observed for the reports flow, and confirmation you left NO temp harness edit), update the Task 8 ledger row. Report back concisely. No PR/merge — the whole-branch review + PR are the controller's next steps.
