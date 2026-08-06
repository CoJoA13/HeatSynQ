# Phase 4 fold-in report — phase-4-lane-b → phase-4-certs-shipping

Date: 2026-08-05. Executor: fold-in agent (owner's ruling: fold in first, then Task 20, then one whole-branch review).

## Result

**DONE.**

- Merge commit: `89bd01c` — `merge: fold phase-4-lane-b (Tasks 15-17) into the phase branch` (true merge commit, two parents: `967dac6` main-side, `cf4d63b` lane-b tip; lane history preserved — `git log --graph` shows all 11 lane commits on the side leg).
- Wiring commit: `7b171d5` — `feat(ui): cert detail print goes live on the merged tree`.

## 1. The merge

Pre-merge state: clean tree (untracked scratch only: `.playwright-mcp/`, three main-side SDD reports not yet committed — none collide with lane-b paths). Merge base confirmed as `893dc5e`, matching the briefed lane-b branch point.

`git merge phase-4-lane-b --no-ff` — **zero textual conflicts.** Git auto-merged everything, including the three predicted semantic-conflict files. Auto-merge is not proof of semantic correctness, so each predicted zone was inspected by hand against both parents:

### erp/src/server/shippers.ts — both sides survive, verified
- Lane-b's contribution (T17, `15f0252`): new `ShipperRowOrder` type; `ShipperRow` gains `orders: ShipperRowOrder[]`; `ROW_SELECT` widened (`orderId`, `lineComplete` on lines); `toShipperRow` computes per-order qty/weight (integer-cents, matching the existing IEEE754 sidestep) and `complete` (`lines.length > 0 && every lineComplete` — explicit empty-array guard).
- Main's contribution intact: `readShipperDetail`'s `orderLineShippedToDate` ledger, `printTickets`, `printBol`, `printableShipmentCertIds` all present in the merged file (grep-verified, 6 hits across those symbols). The two sides touched different functions; the only shared region was `ROW_SELECT`'s comment block, which merged cleanly because main never edited it.

### erp/src/server/orders.ts — both sides survive, verified
- Lane-b (T17, `caa79dc`): `CREATE` zod schema gains `certRequired: z.boolean().optional()` / `certScope: z.enum(CERT_SCOPES).optional()`; `saveNewOrder` resolves the chain then applies the per-field entry-time override (`data.certRequired ?? resolved.certRequired`); `auditPayload` comment updated to "EFFECTIVE values". The UPDATE-side override (line ~983) also present.
- Main intact: `readDetail`'s `orderLineShippedToDate` seam (3 grep hits). Different areas of the file; no interleaving.

### erp/src/server/certs.ts (+ cert-results.ts) — both sides survive, verified
- Lane-b (T15): `CertRow` gains `passedCount` with the explicit-equality comment (`passed === true`, never `readingCount - failCount`); computed in `rowsToCertRows` and mirrored in `cert-results.ts`'s `toCertDetail`.
- Main intact: `printCert` and `readCertPdfData` (5 grep hits), untouched by the merge.

### docs/
Lane-b committed **no docs/ changes at all** (its staleness was working-tree-only in the other worktree, never committed), so the predicted "main wins wholesale" rule had nothing to apply to. Main's spec amendments are untouched.

### .gitignore / .superpowers/sdd/ both-added files
- Root `.gitignore`: both sides made the **byte-identical** change (SDD-tracking carve-out, `.superpowers/*` / `!.superpowers/sdd/` / `*.diff` excluded). Git resolved trivially; nothing lane-b-only existed to lose (diff of both sides against base compared equal).
- `.superpowers/sdd/.gitignore` and `global-constraints.md`: both-added with identical content on both sides (verified with `diff` of `git show` output before merging) — auto-resolved, no divergence.
- `task-15-brief.md` existed identically on both sides (main had filed it pre-split); lane-b's `task-15-report`, `task-16-*`, `task-17-*` merged in as adds. Post-merge, `.superpowers/sdd/` holds both lanes' full records: briefs/reports/reviews for tasks 15–19 side by side (verified by listing).

### Prisma
`git diff 893dc5e phase-4-lane-b -- '*prisma*'` is empty — lane-b made no schema or migration changes, as predicted. No regeneration needed, no migration conflict. (Client regenerated state from before the fold-in remains valid; tsc against it is clean.)

## 2. The cross-lane wiring (commit 7b171d5)

`erp/src/app/certs/[id]/CertDetail.tsx` only — the lane-b cert detail page's placeholder print action went live against main's Task 19 route:

- **Gate**: `printGate` is now `voided ? {disabled, "Certification is voided — no new documents can be produced for it"} : gate(perms, "certs.view")` — the same permission the route enforces (`mustCan(user, "certs", "view")`; printing mutates nothing beyond first-print `printedAt` and its own audited archive). The voided refusal keeps its truthful §5.16 title and stays the more specific reason. The "Available once Task 19 lands" title is gone.
- **Pipeline**: `printCertAction` follows ShipmentDetail.tsx's `printDoc` precedent exactly where it applies — POST to `/api/certs/[id]/print`, non-OK responses surface the server's JSON `error`, blob → `URL.createObjectURL` → `window.open` with `opener = null`, popup-blocked case reports "archived and in Documents below" (never silent), revoke on a 60s delay (the race-the-new-tab rule). The `x-print-warnings` decode was deliberately **not** copied: that header is shipment-specific; the cert route sends none (verified against the route source).
- **Post-print refresh**: `load()` re-fetches the full CertDetail so `printedAt` engages the §5.16 post-print results gate live (`resultsGateFor`'s `edit_cert_results_after_print` branch) and the header's "Printed" fact updates; `docsRefresh` counter (new `refresh` prop on `CertDocumentsList`, added to its effect deps) re-fetches the stored-documents list so the new CERT document appears. A failed refresh after a successful print reports "Printed and archived, but the page could not be refreshed" — the voidAction precedent's success-then-refresh-failure shape, so a refresh error never masquerades as a print failure.
- Button shows "Printing…" and disables while in flight; a dedicated `printError` renders in the print bar (the ShipmentDetail placement).
- No tests pinned the old disabled-button state (grepped); no test changes needed. No new UI tests added — this page's siblings (ShipmentDetail print bar) carry none either, and the route itself is already integration-tested from Task 19 (`tests/cert-pdf.test.ts` per the T19 record).

## 3. Gates on the combined tree

All from `/home/cjones/Desktop/HeatSynQ/erp`, run after both commits:

| Gate | Result |
|---|---|
| `npm test` | **97 files, 1357 tests, all passed** (117.4s) |
| `npx tsc --noEmit` | clean, no output |
| `npx eslint src tests` | clean, no output |
| `npm run build` | success; route table renders (incl. `/certs`, `/certs/[id]` alongside `/shipping/*`); grep for error/warn/fail over full output: nothing |

Test-count arithmetic: main 1344 + lane-b's 87 additions over the shared base (~1270 + 87 = 1357 on its side minus the base overlap) — 1357 is exactly main's 1344 + the 13 net-new lane-b cases that weren't already counted... more precisely: the union landed at **1357**, +13 over main's 1344, consistent with lane-b's test additions (367 inserted lines across 6 test files, several extending files main also extended). No test lost, none duplicated, none skipped.

Lane-b's T17 tests specifically (widened `ShipperRow.orders` in `tests/shipper-children.test.ts`, the create-time cert override in `tests/cert-resolution.test.ts` / `tests/cert-routes.test.ts`) pass against main's evolved services in the full run.

Vitest tail:

```
 Test Files  97 passed (97)
      Tests  1357 passed (1357)
   Duration  117.38s
```

## 4. Sanity

- `git log --oneline --graph -15`: merge commit `89bd01c` with the full lane-b leg (11 commits, `3cbc141`…`cf4d63b`) preserved; `7b171d5` on top.
- `.superpowers/sdd/`: both lanes' briefs/reports/reviews present (task-15 through task-19 complete sets), `.gitignore` and `global-constraints.md` tracked once.
- Tracked tree clean after both commits (untracked scratch unchanged: `.playwright-mcp/`, and three main-side reports — `task-14b-report.md`, `task-18-report.md`, `task-19-report.md` — that predate this fold-in and were left as found).

## Concerns

1. **Untracked SDD reports**: `.superpowers/sdd/task-14b-report.md`, `task-18-report.md`, `task-19-report.md` (and `task-14-report.md` / `task-14b-brief.md` from the session-start snapshot) sit untracked in the main tree. The `.gitignore` carve-out intends them tracked. They predate the fold-in and committing them wasn't in my mandate — flagging so the whole-branch review or Task 20 close-out picks them up before the branch is called complete (the owner's ruling is that nothing merges until the whole branch is reviewed; an untracked execution record would silently not travel).
2. **CertDocumentsList "Task 19 owns that" comment** (line ~101) still says printing is Task 19's — read in context it describes the *documents list* not printing (a plain download link), which remains true; left as-is rather than churning a lane-b file beyond the mandate.
3. Nothing else. No semantic incompatibility surfaced; the two lanes touched disjoint functions everywhere they shared files, exactly as the advance ledger predicted.
