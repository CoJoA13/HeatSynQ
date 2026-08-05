# Phase 3 final fix wave — report

Branch: `phase-3-orders`
Commit: `379b9bd39b8e1b6ada4427d3b7b608c6d329481c` — `fix: final review wave — customer override trim, comment/doc corrections`

## Findings addressed

1. **(Behavior) `erp/src/app/customers/[id]/page.tsx`** — Request-days-override `onBlur` now trims first and branches on the trimmed value (`const trimmed = v.trim(); if (trimmed === "") {...} const n = Number(trimmed);`), matching `erp/src/app/parts/[id]/IdentitySection.tsx`'s shape exactly. A whitespace-only input now clears the override to `null` instead of saving `0`. Verified side-by-side against the parts sibling: identical trim/branch/parse/validate flow, differing only in each file's own state setter (`setC` vs `patchDraft`) and error-reporting name (`setError` vs `onError`) — pre-existing per-file idioms, not part of the bug.

2. **(Comment) `erp/src/server/part-process-steps.ts`** — Both spots (`workingRevision`'s CONCURRENCY paragraph at ~line 82-90, and `lockCurrentRevision`'s doc comment at ~line 381-386) corrected from "default-isolation transaction" to the fact: the order save's transaction (`orders.ts:522`) is Serializable, same as this file's own mutators. Reworded the load-bearing point so it survives the correction: Serializable on *both* sides is still never the guarantee — Postgres's serializable property holds only for the pairing as a whole, no caller is required to preserve it going forward, and what actually protects `lockedAt` is the row lock, which blocks regardless of any participant's isolation level. Added the requested one-sentence caveat to `lockCurrentRevision`: its `ORDER BY … DESC LIMIT 1` target is chosen before blocking and isn't re-picked on wake, benign today only because new revisions are exclusively cut through `workingRevision`'s own claim on the same row.

3. **(Docs) `CLAUDE.md` + `docs/HANDOFF.md`** — Added one sentence to each audit paragraph naming Phase 3's two sanctioned exceptions beyond the retired `settings.ts` one: the order-draft service (`order-drafts.ts` — pre-entity scratch, spec-authorized, sweep-allowlisted in `tests/permissions-sweep.test.ts`'s `EXCEPT` set) and `allocateNumber`'s counter bump (`settings.ts` — the consuming entity's own create entry is the audit trail, per that function's existing header comment). Left the existing (already-retired) `settings.ts` mention untouched — out of scope for this wave.

4. **(Comment) `erp/src/server/reference.ts` ~line 200-205** — "All four registered FK writers" reworded to "Every registered FK writer" with an explicit pointer to `src/lib/reference-links.ts`'s `REFERENCE_LINKS` as the source of truth, keeping the original four as a named example ("not just the original four ..."). Chose the reword option over hardcoding a new number: `REFERENCE_LINKS` currently holds 11 entries (confirmed by reading the file), a count likely to keep growing across phases, so a hardcoded number would just rot again.

## Verification

- `npx vitest run tests/customers.test.ts tests/parts.test.ts` — 52/52 passed (item 1's covering suites).
- `npm test` (full suite) — **904/904 passed**, matching the stated baseline exactly.
- `npx tsc --noEmit` — clean, no errors (ran `npx prisma generate` first per project convention).
- `npx eslint src tests` — clean, no errors/warnings.
- `npm run build` — succeeded, exit code 0, all routes emitted.

## Scope discipline

`git diff --stat` against the prior HEAD touches exactly 5 files (`CLAUDE.md`, `docs/HANDOFF.md`, and the three source files named in the four findings) — 24 insertions, 16 deletions, no unrelated changes. Two pre-existing untracked directories (`.claude/`, `.vscode/`) were present before this session and were deliberately left out of the commit.

## Concerns

None. All four findings map to the described root cause exactly as diagnosed in the review; no follow-on issues surfaced during the fix or verification.
