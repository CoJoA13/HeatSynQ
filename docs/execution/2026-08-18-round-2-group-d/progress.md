# Round 2 Group D — the stale-load class — progress ledger

Branch `group-d-stale-loads`, opened 2026-08-18 from `b7460fc`.
Issues: **#31 (the ruling) + #3, #5, #15, #23, #110**, plus the sibling-page sweep.

## The #31 owner ruling (2026-08-18, opens the group)

Asked as the group's first action, per the backlog's "decide #31 before fixing any of the others."

**Ruling: option 1 — keep fetching in effects.** The `react-hooks/set-state-in-effect` override in
`eslint.config.mjs` becomes a **documented permanent decision**, not a deferral pending #31.
`src/lib/use-latest.ts` is the standing discipline: the ticket idiom for stale responses, the
invalidation idiom (`invalidateBackupBanner` precedent) for cross-component staleness.

Reasoning recorded on the issue (comment, 2026-08-18): the build is complete through Phase 8, so
the issue's "decide before Phase 3 adds pages" framing no longer applies — the pages exist and are
tested. A fetch library or Server Components would be a real migration over working paper for
consistency, not correctness, and both cut against deliberate early choices (dependency-light;
client components against guarded APIs, which sidestep the every-server-page-must-`requireUser`
constraint).

**Sweep scope ruling (same exchange): named issues + sibling audit.** Recon audits every
fetch-into-state page for the class, not just the five named instances — "fixing them one at a
time is how the class survived this long."

## Recon inventory (2026-08-18)

One-off lint run with the rule set to `warn` (reverted immediately): **77
`set-state-in-effect` hits across ~48 files** — up from the 21/19 in #31's text; phases 3–8 added
reports, receivables, invoicing, orders detail, certs, and admin templates. The full hit list was
the sweep audit's work-list.

Recon ran as 16 agents (4 targeted deep-reads + 12 sweep auditors). Headline findings, all bound
into the brief:

- **#5 is already fixed** — `aeed372` (Phase 2C-2, PR #13) gated the customers list and birthed
  the parts list gated; `use-latest.ts:2–5` cites the issue. Closed with evidence, not re-fixed.
- **#3/#15 cannot be fixed by any queue arrangement** (the optimistic set happens at call time,
  outside the queue; an awaited rollback inside the failing key's fn deadlocks) — the fix is an
  epoch-gated, detached, settle-deferred rollback reload, one shared pure helper (brief Task 2).
- **#23 and #110 confirmed** exactly as filed, fix shapes pinned to the in-repo precedents
  (the ticket idiom; the `invalidateBackupBanner` clone with a banner-side renders-nothing guard).
- The sweep found the class alive well beyond the named issues: ~15 genuinely ungated shared
  `load()`s (three with server-side write-back amplification through stale refs — roles,
  step-codes, surcharges), the four mutation-gate detail pages' rollback-drain residue,
  a stale-closure pair, and TemplateEditor's 409 path that unrecoverably destroys mid-flight
  edits. All in the brief (Tasks 5–8). Out-of-class adjacent finds are filed as issues at
  close-out (Task 9), not fixed — the scope line that keeps the group from ballooning.
- **Clean bills recorded** for: all six /reports screens, NewShipment, processes list,
  QuoteLinkPicker, ReceivablesList, AgingReport, Scoreboard, orders/[id] sections
  (Shipments/Process/Invoices), customers detail sections (TemplateAssignments/
  SurchargeOverrides/Receivables), PreviewPane (serialized by `rendering`), admin/backups,
  orders/new autosave + handleSave (both mutation surfaces verified clean).

## Task verdicts

(one entry per task as reviews land)
