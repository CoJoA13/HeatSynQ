# Phase 8A — Codex PR-review fix-wave review (PR #106, 0cac5b2..d006f9e)

## Spec Compliance
✅ Spec compliant — all 5 Codex findings correctly resolved (fixed, not moved), verified against the diff and the named context.

- Finding 1 (scoreboard consistent snapshot): `scoreboard.ts:122-160` wraps orders-count + shipped +
  invoice in ONE `prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })`,
  an exact mirror of `aging.ts:179-183` `readSnapshot`. `reportShipped` threaded via optional
  `db: Prisma.TransactionClient = prisma` (`shipped.ts:189-212`) — the one `findMany` switched to
  `db.shipperLine`. Standalone Shipped report unchanged (still `reportShipped(filter)`). Pure read: no
  claim, no audit, not Serializable. Malformed-date parse stays before the tx (`scoreboard.ts:123`).
- Finding 2 (perms-fetch failure before the gate): shared `GateNotice` (`report-ui.tsx:18-36`) renders
  three ordered states — permsError banner → loading → deniedMessage. Each screen reorders the early
  return to `if (permsError || perms === undefined || !viewGate.allowed)` (index + backlog/payments/
  sales/scoreboard/shipped/turnaround). `usePermissions` semantics confirm `permissions===undefined`
  in-flight, `error` on failure (`use-permissions.ts:30-38`). Main-body banner no longer folds
  permsError (correct: the gate guarantees it null past it). `AgingReport.tsx` not in the diff.
- Finding 3 (options-error separation): distinct `optionsError` state in the 5 option-bearing screens;
  option `.catch` → `setOptionsError`, `load()` still clears only `error`, banner shows `error ?? optionsError`.
  Scoreboard has no options — correctly untouched for this finding.
- Finding 4 (inactive-but-live options): every customer/part option fetch now `?includeInactive=1`.
  Routes pass it through (`customers/route.ts:9-12`, `parts/route.ts:9-12`) to the list services;
  `includeInactive` drops `active:true` while the service keeps `deletedAt: null`. Live rows only.
- Finding 5 (export aligned with displayed table): each screen tracks `appliedQuery` (set to `query`
  ONLY on a successful load), and `ExportLink` (`report-ui.tsx:45-63`) is built from `appliedQuery`,
  rendered inert `<span>` while `!upToDate (=loaded && appliedQuery===query)`. On a failed reload the
  export stays inert and the old table shows (dimmed) — screen==export holds.

⚠️ E2E export step (`e2e/flows/reports.mjs:52-82`) is controller-run, but I traced it: the inert window
is between the filter change and the awaited refetch (`reports.mjs:59-63`), before `exportLink.click()`
(`:73`); Playwright auto-waits for the `<a role=link>` to reappear, and the "Updating…" hint is a
`text-slate-400 span`, not `p.bg-red-50`, so the no-error-banner assertion (`:65-68`) still holds. Low risk.

## Strengths
- Both cross-cutting fixes are extracted into ONE shared client-safe `report-ui.tsx` (GateNotice,
  ExportLink) instead of N hand-copies — directly answers the repo's recurring "reimplemented rather
  than shared" defect shape (handoff §6 / the `use-permissions.ts` precedent).
- Finding 1 is a faithful clone of the sanctioned `aging.ts` RepeatableRead read-snapshot, and the
  CLAUDE.md "Reports are pure reads" paragraph is amended in the same wave to sanction it (docs-as-you-go).
- `report-ui.tsx` imports only `type { ReactNode }` — no `src/server/**`, no new client→server edge.
- Commits: one clean conventional commit per finding, no per-commit attribution trailer (convention-correct).

## Issues
### Critical (Must Fix)
- None.
### Important (Should Fix)
- None.
### Minor (Nice to Have)
- `optionsError` is set by the one-shot option fetches but never cleared (no retry affordance). Strictly
  an improvement over the prior shared-state erase; a retry control would be nicer. `BacklogReport.tsx:113-120`.

## Assessment
**Task quality:** Approved
**Reasoning:** All five findings are genuinely fixed (not relocated), the shared extraction is client-safe
and mirrors the sanctioned aging precedent, and no report gained a claim/audit/Serializable — only a
read-only RepeatableRead snapshot. No Critical/Important issues; full gate chain is the controller's to run.
