# Task 6 implementer report — the ungated-load sweep (sections, docs lists, one page loader)

Branch `group-d-stale-loads`, commit `b1b8dc6` (the sweep; report committed separately).
Mechanical `useLatest` adoption over the nine audited sites — both paths gated (F7), §5.13
error-clearing semantics preserved per site, no behavior change outside the raced window, no
`src/server` imports, no new tests (the gate factory is pinned in `tests/use-latest.test.ts`).

## Per-change table

| # | File | What was racing | Gate applied | Line refs (post-change) |
|---|------|-----------------|--------------|-------------------------|
| 1 | `erp/src/app/processes/templates/[id]/page.tsx` | `load()` completely ungated with SIX mutation callers (saveName, toggleActive success AND rollback, addStep, saveBoilerplate, removeStep, move) — a slow earlier refetch could clobber a newer one's template, name reconciliation, and rename bookkeeping | The processes/page.tsx shape: ticket at dispatch, both paths gated; the gate covers `setTemplate`, the `setNameDraft` reconciliation, AND the `lastServerName.current` write (a dropped stale response advances no bookkeeping). Mount effect's external `.catch` folded into load's own gated catch; toggleActive's two `await load().catch(() => {})` become plain `await load()` (load no longer rejects) with the §5.13 reload-before-setError order intact | :64–81 (gate + load), :85 (mount), :129–134 (toggleActive) |
| 2 | `erp/src/app/orders/[id]/DocumentsSection.tsx` | Mount fetch vs. print's post-archive refresh — auto-print (`?print=1`) makes both routinely in flight | The InvoicesSection shape: ticket before the fetch, `isCurrent` before `setDocs`, before the success `setError(null)`, and before the failure `setError` (effect's then/catch folded into load) | :81–98 |
| 3 | `erp/src/app/orders/[id]/CertificationsSection.tsx` | Same mount-vs-`createForLoad`-refresh race, PLUS rows=[] before the first fetch rendered every "Create cert for Load N" button (a guaranteed-400 double create) and the §4.1 gap line over unfetched data | Same InvoicesSection gate, plus a `loaded` flag (the InvoicesSection :45/:63/:70 shape) set on both settle paths; `showLoadGap` now requires `loaded && !error` (gates the gap line AND the per-load create buttons inside it), and the empty-state copy is `loaded && !error && rows.length === 0` with a `rows.length > 0 ? table : null` tail | :69–99 (flag + gate), :131–134 (`showLoadGap`), :168, :202 (empty state) |
| 4 | `erp/src/app/parts/[id]/SpecsSection.tsx` | `load` is the funnel for add/remove — overlapping reloads could land out of order | The plain ticket (processes/page.tsx shape), both paths. Deliberately NOT the sibling PricingSection's `saveScope` — this section has no optimistic saves, only report-and-reload, so there is no rollback ordering to defer for (read PricingSection as it now is, post-Task-2). `load` still never clears the shared `onError` banner itself (§5.13 — add/remove clear it before reloading) | :23–41 |
| 5a | `erp/src/app/shipping/[id]/ShipmentDetail.tsx` | Add-order candidates effect re-runs on every add/remove order (`onShipmentOrderIds` dep) with `setAddableOrders` ungated — a slow earlier response clobbers a newer order-set's list | The NewShipment #51 `candidatesLatest` clone: `addableLatest`, ticket at the top of the effect body (before the early return, so losing the customer/permission also invalidates in-flight responses), gate on the set AND the `addLoadError` catch | :406–419 |
| 5b | `erp/src/app/shipping/[id]/ShipmentDetail.tsx` (ShipmentDocumentsList) | Docs-list effect's deps include the print-bumped `refresh` — mount fetch vs. post-print refetch | Standard gate on `setDocs` and `setErr`, both paths | :164–173 |
| 6 | `erp/src/app/invoicing/[id]/InvoiceDetail.tsx` (InvoiceDocumentsList) | Same print-bumped `refresh` vs. mount race | Same docs-list gate (import extended to `useLatest, useMutationGate`). `patchHeader` (:548 area) untouched — Task 7's | :110–121 |
| 7 | `erp/src/app/certs/[id]/CertDetail.tsx` (CertDocumentsList) | Same race | Same docs-list gate (import extended). `patchNotes`/`saveReadings` untouched — Task 7's | :108–119 |
| 8a | `erp/src/app/receivables/statements/Statements.tsx` (StatementDocumentsList) | `[customerId, allowed, refresh]`-driven fetches race each other AND the early-return clear — a cleared selection could be repainted by an in-flight response | Gate with the ticket taken at the TOP of the effect body BEFORE the early-return clear, so clearing also invalidates in-flight responses; success path keeps its existing `setErr(null)` (gated), failure path gated | :84–95 |
| 8b | `erp/src/app/receivables/statements/Statements.tsx` (`loadPreview`) | The existing gate took its ticket AFTER the clear branch, so clearing the selection did not invalidate an in-flight preview | Moved `latest.next()` above the clear branch — everything else in the (already-gated) body unchanged | :172–177 |
| 9 | `erp/src/app/orders/new/OrderLineCard.tsx` | Deterministic false-block: the guard branch reported `onLeadValidity(lineId, null)` at dispatch but the fetch path never did, so a part swap left the save gate refusing on the PREVIOUS part's verdict while the panel showed "Checking…" | One line: `onLeadValidity?.(lineId, null);` after `setLeadCheck({ status: "checking" })` — consistent with the null-means-unknown-never-blocks contract (`src/lib/lead-validity.ts:16–18`) | :115–119 |

## Gates

Run from `erp/`:

| Gate | Result |
|------|--------|
| `npx vitest run tests/use-latest.test.ts tests/lead-validity.test.ts` | ✅ 2 files, 13 tests passed |
| `npx tsc --noEmit` | ✅ exit 0 |
| `npx eslint src tests` | ✅ exit 0 |

No new tests: `tests/lead-validity.test.ts` pins only the pure `resolveLeadValidity` reducer — it
does not (and cannot, under the node-env no-mounting rule) pin the component-side `onLeadValidity`
dispatch contract, so there was no case to extend with a null-at-dispatch trace. The existing
"keeps an unknown verdict from the current lead as unknown" case already pins the null-never-blocks
half the one-liner relies on.

## Reviewer-attention notes

1. **Commit-boundary incident (process, not content).** My staged nine files were swept into the
   concurrent Task 4 implementer's report commit (`cd9d9aa`, "docs: Task 4 implementer report")
   the moment it was created between my `git add` and `git commit`. The branch was local-only
   (never pushed), so I split the tip: `20a2e43` re-creates the Task 4 report commit with ONLY the
   report file, `b1b8dc6` carries the Task 6 sweep alone. Verified `git diff cd9d9aa b1b8dc6` is
   empty — the tree is byte-identical to the pre-split state; only the commit boundary moved.
2. **Change 1 removes two `.catch(() => {})`** on toggleActive's rollback/success reloads because
   the folded load never rejects — its failures now report through the gated internal catch (same
   message, same §5.13 reload-before-setError order). A load failure during the FAILURE rollback
   briefly sets the load's error before toggleActive overwrites it with the PATCH's message —
   the same final state as before (the old code swallowed the load failure outright).
3. **Change 3's empty-state tail** is now `: rows.length > 0 ? <table/> : null` — before the first
   fetch (or after a failed one) the section renders neither the empty-copy nor the table, exactly
   the InvoicesSection precedent. The orphan warnings derive from `rows` and stay unchanged
   (empty rows → no orphans, no gating needed).
4. **Change 5a takes its ticket BEFORE the early return** where NewShipment takes it after; this is
   the strictly-safer placement (a shipper losing its customer mid-flight invalidates the response)
   and matches the brief's "ticket at effect top" wording. NewShipment's `setCandidates([])`
   clear-at-top was deliberately NOT cloned — ShipmentDetail's effect never cleared, and adding a
   clear would be a behavior change outside the raced window (the customer is fixed per shipment).
5. **The three docs lists (5b/6/7) do NOT clear `err` on success** — that is their existing
   behavior (the `err` short-circuit render), preserved per the no-behavior-change rule; only
   Statements' list ever cleared, and it keeps doing so (gated). If the never-clearing `err` is
   worth fixing it is the Task 9 error-channel family, not this sweep.
6. **DocumentsSection (change 2) folds the mount effect's `setError(null)`-on-success into `load`**,
   which means print's post-archive refresh now also clears the error banner on success where
   before only the mount path did. This is the processes/page.tsx-blessed §5.13 success-clear,
   ticket-gated; print's own failure path never calls `load`, so no live failure is erased by it.

## Fix round 1 (review Important — CertificationsSection error conflation)

**Finding.** `showLoadGap = loaded && !error` conflated two error sources: `createForLoad`'s catch
writes the SAME shared `error` and does not reload, so a transient POST failure (network blip,
500) permanently hid the §4.1 gap line and every "Create cert for Load N" button — before Task 6
they stayed visible and a second click succeeded. A behavior change outside the raced window, and
against §5.16 (disabled-with-reason, never hidden). The same conflation hit the empty-state copy's
`!error` gate.

**Choice: option (a), split the channels** — a new `loadError` state owned exclusively by `load()`
(set on its gated failure path, cleared on its gated success), with `error` reverting to
createForLoad's channel alone. Why (a) over (b): option (b)'s "buttons disabled while an error is
set" would let a createForLoad failure disable its own retry button — with no reload in its catch,
nothing would ever clear the error, so the retry the finding says to preserve would be dead until
a page reload. (InvoicesSection does live with that shape for its single Create button, but this
section's pre-existing second-click retry is exactly what the review flags as regressed.) Split
channels keep the retry fully live: a create failure hides and disables nothing.

**The minor, folded in.** `showLoadGap` is now gated on `loaded` alone: after a failed MOUNT (or
refresh) load the gap block renders with its create buttons DISABLED and titled "Could not confirm
which loads already have a cert — reload the page to try again" (permission reason takes
precedence when `createGate` is itself the blocker) — nothing re-triggers `load` (its deps are
fixed for the page's life), so disabled-with-reason is the honest state, not showing nothing.
`loadError` renders in its own red banner beside `error`'s; the empty-state copy's gate is
`loaded && !loadError`.

**Known cosmetic residue (deliberate, noted for the reviewer):** under a failed mount load the gap
line's counts read "· 0 certs" from the empty rows — directly beneath the red loadError banner and
above buttons whose disabled reason says coverage could not be confirmed, so the state is named
twice before the count could mislead; restyling the counts line for the error case would be scope
creep. Under a failed REFRESH the rows (and counts) are the last successful load's — stale but
real, buttons disabled with the same reason.

**Gates.** `npx tsc --noEmit` exit 0; `npx eslint src/app/orders/[id]/CertificationsSection.tsx`
exit 0.
