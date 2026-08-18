# Round 2 Group D — the stale-load class — task brief

Branch `group-d-stale-loads` from `b7460fc`. Issues: **#31 (ruled) + #3, #15, #23, #110; #5 closes
with evidence.** Grounded in a 16-agent recon (4 targeted deep-reads + 12 sweep auditors over the
77-hit / ~48-file `set-state-in-effect` inventory taken 2026-08-18).

**No schema migration anywhere in this group.** No server/service changes except the #110 call-site
wiring (client files only there too). Every change is client-side React or `src/lib/` pure code.

## 0. The ruling and the two shapes that already exist

Owner ruling (#31, 2026-08-18): keep fetching in effects; `src/lib/use-latest.ts` is the standing
discipline. Its two existing tools, and the two rules every fix in this group must follow:

- `makeLatestGate`/`useLatest` — fetch ordering. Ticket at dispatch (`next()` BEFORE the await),
  gate **both** the success and rejection paths (`F7` rule, customers/page.tsx:31–35 — a superseded
  request's rejection must not clobber current state either).
- `makeMutationGate`/`useMutationGate` — mutation-response ordering (applied-monotonic, early
  finisher applies, straggler drops). NOT interchangeable with the latest-gate (use-latest.ts:27–34).
- §5.13 ordering: roll back to server truth first, then report; **a reload must never clear an
  error banner set after it started**, and a success-path reload must not erase a live failure.
- The effect-scoped `let stale = false` cleanup flag (QuoteDetail/templates-list Phase 7 shape) is
  the sanctioned equivalent where the fetch is keyed by an effect dep; don't churn existing uses.

The vitest harness is `environment: "node"` — **no jsdom, no mounting**. TDD lands on pure
extracted logic (`tests/use-latest.test.ts`, `tests/backup-banner.test.tsx` with
`renderToStaticMarkup`, `tests/idempotent-save.test.ts` are the precedents). Mechanical gate
adoption inside components is covered by the helper's unit tests + the full E2E suite + review;
do not invent per-page harnesses.

## Task 1 — #5: close with evidence (controller, no code)

`customers/page.tsx` has been fully ticket-gated (both paths) since **`aeed372`** (Phase 2C-2,
PR #13, 2026-08-01) — the squash body says "adopts the gate in the customers list load() to close
backlog #5", and `use-latest.ts:2–5` cites the issue. The parts list was born gated in the same
commit. Close #5 citing that commit; it does NOT ride the group's PR "Closes" list.

## Task 2 — #3 + #15: the save-scope helper + both detail pages (TDD)

**The insight that binds the design (recon-verified):** the optimistic set happens at `save()`
call time, OUTSIDE the per-key queue (customers/[id]/page.tsx:237, parts/[id]/page.tsx:99), so no
queue arrangement fixes the clobber; and a rollback reload that *awaits* inside the failing key's
queued fn deadlocks against anything queued behind it. The fix is an **epoch-gated, detached,
settle-deferred rollback reload**, one shared pure helper.

**New helper** in `src/lib/` beside use-latest.ts (name at implementer's discretion, e.g.
`makeSaveScope()` in `save-scope.ts`; client-safe, zero React, zero imports from src/server):

- `begin(settled: Promise<unknown>): void` — called at every optimistic-apply site, at save
  **call** time: bumps a monotonic epoch and registers the save's queue-chain promise until it
  settles.
- `reload(fetch, apply): Promise<...>` — the guarded load used by mount/effect/success-path
  callers AND scheduled rollbacks. Algorithm (bindable): take an internal latest-gate ticket; loop:
  `await Promise.allSettled(pending)`; capture `e = epoch`; `data = await fetch()`; if the ticket
  is superseded → return without applying; if `epoch !== e` → loop again (a save intervened
  mid-fetch; its commit may postdate our read); else `apply(data)`. Terminates because the epoch
  advances only on user actions.
- Rollback call sites invoke `reload` **without awaiting it from inside the queued fn**
  (fire-and-forget from the catch, after `setError`) — that detachment is what avoids the same-key
  deadlock while the settle-defer guarantees the GET postdates every dispatched save, so the
  applied payload shows the committed (= optimistic) value for every newer field and server truth
  for the failed one.
- The rollback/ordinary `apply` must NOT clear the error banner (§5.13); customers' `load()` today
  does `setError(null)` on success — the guarded variant used for rollbacks must skip that.

**RED tests first** (`tests/save-scope.test.ts` or similar; pure, hand-resolved deferreds, a real
clone of the pages' `serial()` queue in the test to prove no deadlock):
1. **#3 same-key trace**: save#1 (v1) fails after save#2 (v2, same key) was queued and optimistically
   applied → the rollback GET carrying pre-v1 truth is withheld; after save#2 settles the re-fetch
   applies v2. Watched RED against the current page logic shape (unguarded apply clobbers).
2. **#15 cross-key trace**: A's failing save's rollback GET resolves carrying B's pre-edit value
   while B's save is in flight → withheld; final state shows B's committed value.
3. Ordinary failure (no newer save): rollback applies promptly; the error set at failure survives.
4. Ticket-before-dispatch property; superseded-reload dropped (two overlapping reloads).

**Adoption — customers/[id]/page.tsx (#3):** `begin` at the four optimistic sites (:237 save,
:389 toggleContactFlag, :408 saveAddressField, :431 saveContactField); route ALL `load()` callers
through the scope's reload (mount :144, rollbacks :248/:395/:416/:438, success reloads
:263/:298/:428/:739); this also closes the audit's :144 finding (the page is the only one of the
five detail pages with no use-latest import — reload-vs-reload ordering comes free from the
scope's internal gate). Keep `editGuard.merge` on apply.

**Adoption — parts/[id]/page.tsx (#15):** `begin` in save (:99); gate `load` (:82–86).
`patchDraft` must NOT bump the epoch (typing protection is editGuard's job, not the scope's).
**Also port `useEditGuard`** onto this page (route `setPart` through `merge`, wire `onFocusField`
in IdentitySection) — the parts page never received the Phase 4 fix-wave guard, so it still has
the raw mid-typing clobber customers already fixed.

**Also in this task — the two section-local rollback clobbers with the same shape:**
`parts/[id]/PricingSection.tsx` (saveRow :109, saveBreak :241, move :187) and
`parts/[id]/InspectionsSection.tsx` (saveRow :85) adopt the same helper for their rollback
reloads (they have no queue — `begin` registers the save promise itself). InspectionsSection also
gets its missing load ticket + the `rowsReady` add-guard port from PricingSection (:53–58,
:201–204 there) — three known-solved shapes ported, per the audit.

Out of scope, file as issues (Task 9): extending editGuard to the customers address/contact
arrays (the standing T16 three-page item's territory), CustomFieldsSection's success-reload
typing wipe.

## Task 3 — #23: the field-blocker ticket + the step-codes page (TDD)

Per the issue's own analysis: the ticket idiom, not a second bespoke id guard.

- Extract the catch-continuation into a client-safe leaf `src/lib/field-blocker-panel.ts`:
  `resolveFieldBlockerPanel(gate, fetchBlockers, fieldCtx)` returning the panel value, `null`
  (clear — fetch failed but still current), or `undefined` (stale — touch nothing). **RED test
  first** (`tests/field-blocker-panel.test.ts`, deferred-resolved fetch): (1) bump-then-resolve →
  `undefined`; (2) no bump → panel value; (3) bump-then-reject → `undefined` (a stale rejection
  must not clear a current panel).
- Page wiring (`admin/step-codes/page.tsx`): `const fieldBlockerGate = useLatest()` (NOT named
  `gate` — the permission-ui import shadows, the customers/page.tsx:27–29 hazard); bump in the
  selection-change effect (:56) — the load-bearing half (invalidation at issue time); ticket the
  catch fetch (:103–114) through the leaf. No bump needed at :98/:113 (the queue holds while the
  blocker GET is awaited — the selection change is provably the only racer). Leave `blocked`'s
  id-compare guard (:369) alone.
- **Same file, same task (audit finds):** the ungated `load()` (:46–52) gets the surcharges-page
  ticket shape — its stale `codesRef` re-opens the PR #22 whole-array clobber (a queued field op
  composes the ENTIRE field array from the ref at run time, :197–201, and would write a reverted
  set back to the server). Land `codesRef` under the same discipline surcharges chose (see its
  :88–102). And the label/unit optimistic typing (:154–162, blur-saves :221–239) moves to a
  `textDrafts` overlay (the surcharges :49–52 pattern) so a landing load cannot mangle in-flight
  typing into a persisted whole-array PUT.

## Task 4 — #110: SetupBanner invalidation (TDD)

Clone the `invalidateBackupBanner` mechanism (BackupBanner.tsx:140–230) into SetupBanner —
module-level listener Set, exported `invalidateSetupBanner()`, mount-only subscription whose
handler synchronously bumps a generation ref, re-arms `fetchedRef`, and bumps a refresh nonce;
commit guard via `shouldCommitBannerFetch` (import it — it is exported and unit-pinned — or clone
with the same tests). The one-shot nav path is untouched: **refetch fires only on invalidation,
never per navigation — no per-nav argon2 is reintroduced.**

**Banner-side refetch guard (the cost ruling):** the handler skips the refetch when readiness
data is loaded AND the banner currently renders nothing (`complete`-or-`dismissed` setup strip
AND no password bar) — a banner showing nothing cannot be made MORE correct by refetching, and
this bounds the perpetual-churn cost (a customer create three years from now fires no argon2).
When data is null (never fetched / failed), invalidate normally.

**Call sites** (fire on the success path, immediately after the mutation resolves, BEFORE any
follow-up load — the #124/#131 ordering): SetupChecklist `putState` (~:41); admin/users password
reset (:97) — scoped to the password mutation only, NOT the title/role/active patches;
admin/settings save (:31); admin/billing (:55); ReferenceTable add/remove/paste-done
(:70/:129/:265) gated on the five readiness-counted kinds (`glAccount`, `terms`, `carrier`,
`containerType`, `material`); step-codes create (:123); customers create + paste (:54/:125);
parts create + paste (:77/:159). The banner-side guard makes the wide set affordable.

**RED tests first** (`tests/setup-banner.test.tsx`, the backup-banner recipe — extraction +
`renderToStaticMarkup`, NO mounting): one-shot semantics; invalidation-produced state refetches;
the renders-nothing skip; `/login` reset; generation-supersede; render assertions for both bars.
Cross-tab staleness: out of scope, same as the precedent — one line in the PR.

## Task 5 — shared components: Shell, HistoryPanel, AttachmentsSection, ReferenceTable

- **Shell.tsx**: bump `latest.next()` in the blank-query branch (:98) so an erased/committed
  search cannot reopen the dropdown over a new page (Shell never remounts); optionally the same
  on Escape. Add a second, separate gate for the `/api/auth/me` fetch (:46–49) gating BOTH paths —
  today a superseded me-fetch's transient rejection can redirect a logged-in user to /login.
- **HistoryPanel.tsx**: ticket inside the component's own effect (both paths). Two call sites
  (step-codes :398, surcharges :545) pass a changing `entityId` into an unkeyed subtree — the
  panel can show row A's history under row B's heading. Fixing the component covers all twelve
  call sites.
- **AttachmentsSection.tsx**: ticket in `load` (both paths) — delete-during-upload's overlapping
  refreshes can hide a committed change.
- **ReferenceTable.tsx**: ticket in `load` (both paths) — Show-inactive toggle + handler refetches
  race. Note in a comment that cross-kind safety rests on the mount site's `key={kind}`.

## Task 6 — the ungated-load sweep (sections, docs lists, one page loader)

Mechanical `useLatest` adoption, both paths gated, no behavior change outside the raced window:

- `processes/templates/[id]/page.tsx` `load()` (:59–67) — the highest-traffic genuinely ungated
  loader (six mutation callers); the gate must also cover the `setNameDraft` reconciliation AND
  the `lastServerName.current` write (a dropped stale response must not advance bookkeeping).
  Fix shape is the processes/page.tsx :38–58 verbatim.
- `orders/[id]/DocumentsSection.tsx` `load` (:82–84; mount + post-print refresh race, auto-print
  makes it routine).
- `orders/[id]/CertificationsSection.tsx` `load` (:75) + a `loaded` flag gating the §4.1 gap line
  and create buttons (the InvoicesSection :45/:63/:70 shape — today rows=[] renders every
  "Create cert" button before the first fetch lands).
- `parts/[id]/SpecsSection.tsx` `load` (:22–25) — the PricingSection `rowsLatest` port.
- `shipping/[id]/ShipmentDetail.tsx`: the add-order candidates effect (:402–410) — clone the
  NewShipment #51 fix (`candidatesLatest`), its sibling never got it; and the docs-list effect
  (:164–168).
- `invoicing/[id]/InvoiceDetail.tsx` docs-list effect (:110–114); `certs/[id]/CertDetail.tsx`
  docs-list effect (:105–113); `receivables/statements/Statements.tsx` StatementDocumentsList
  (:81–86) **plus** moving `loadPreview`'s ticket above its clear branch (:168 — clearing the
  selection must invalidate the in-flight preview).
- `orders/new/OrderLineCard.tsx` one-liner: report `onLeadValidity?.(lineId, null)` at fetch
  dispatch (:114) so a part swap cannot leave the save gate blocking on the previous part's
  verdict while the panel shows "Checking…".

## Task 7 — rollback-drain on the mutation-gate pages + the stale-closure pair

The four detail pages built on `applyMutation`/`useMutationGate` share one residual hole: the
§5.13 rollback `load()` takes the newest ticket while a sibling key's PATCH is in flight; the
GET can be served before that PATCH commits, and the sibling's committed write reverts on screen
(its own response is then dropped as stale). Fix, per the audit, uniform: **before dispatching
the rollback load, `await Promise.allSettled` of every OTHER key's in-flight save** (excluding
the own key — awaiting your own chain tail deadlocks). Same-key corrections are safe on these
pages because mutation responses re-apply via the accept gate.

- `orders/[id]/page.tsx` :329 · `invoicing/[id]/InvoiceDetail.tsx` :558 ·
  `shipping/[id]/ShipmentDetail.tsx` :476 · `certs/[id]/CertDetail.tsx` :230 — CertDetail first
  needs the per-key serial queue it never got (the InvoiceDetail :538–544 shape; its absence also
  lets two same-field PATCHes commit out of order server-side, the audit's :223).

**Stale-closure pair** (same sub-class: a handler's captured `load` re-asks an outdated question
with the newest ticket, defeating the gate): `parts/page.tsx` add/paste (:73–82, :159) and
`invoicing/InvoicingList.tsx` createInvoices (:158) — keep a render-updated ref of the loader
(or a refetch-counter dep) so post-mutation refetches always close over the current query.

## Task 8 — the admin sweep + TemplateEditor

- `admin/users/page.tsx`: ticket in `load()` (Promise.all users+roles under ONE ticket — also
  closes the snapshot tear), both paths.
- `admin/audit/page.tsx`: ticket in `load()` (the purest #5 instance — Search button).
- `admin/templates/page.tsx`: ticket on the rows `load()` AND a shared gate for every writer of
  `detail` — the selection effect's `stale` flag and `loadDetail` merge onto one `useLatest`
  gate so a post-mutation detail refresh cannot repaint template A's pane under template B's
  highlighted row.
- `admin/roles/page.tsx`: the **most reachable server-side clobber in the audit** — `toggle`
  composes the full permissions array from click-time state, so two quick checks silently revert
  the first grant server-side. Fix: the surcharges saveQueue+ref shape (:169–185 there) — compose
  inside the queued run from the freshest ref — plus the load ticket.
- `admin/part-fields/page.tsx`: load ticket (single-field bodies mean no write-back
  amplification; display/draft staleness only) + name/sort `textDrafts` overlay (blur can save
  mangled text today).
- `admin/surcharges/page.tsx`: route Name through `textDrafts` like every other text field
  (:318 — today mid-typing text leaks into other saves' whole-row bodies via `rowsRef`); gate the
  `rowsRef` write with `makeMutationGate` on the load ticket (:99 — arrival-ordered ref vs
  dispatch-ordered tickets); ticket the blocker refetch (:250).
- `admin/templates/[id]/edit/TemplateEditor.tsx`: an edit-epoch gate (useLatest semantics) so
  (a) a save landing after a mid-flight edit cannot claim "Saved"/clean (:117–119 gated on no
  intervening `apply()`), and (b) the 409 rollback (:128–131) cannot wipe edits typed during its
  fetch — if an apply intervened, freshen `updatedAt`/logo meta but skip the config reset and the
  conflict banner (the audit's exact semantics; today that path unrecoverably destroys everything
  typed since the last save, under a banner blaming another editor).

## Task 9 — file the out-of-class findings as issues (controller, close-out)

Adjacent finds the audit surfaced that are NOT this class (or are already-tracked family), filed
not fixed: error-channel displacement (ShippingList :58, InvoicingList :110, CertList :117,
customers/page.tsx never-cleared banner); missing in-flight guards (Quotes bumpFollowUp :149,
saved-views default toggle app/page.tsx :189, InvoicingList mid-run tick clobber :159,
PricingSection add/remove-break double-click); BatchDetail :730 unhandled recovery-reload
rejection; Close.tsx readiness `loaded` arms; CustomFieldsSection success-reload typing wipe;
customers arrays editGuard extension (T16 family). Plus the sweep's clean-bill list goes in the
ledger.

## #31 documentation (controller, rides the branch)

`eslint.config.mjs` override comment: rewrite the "it is tracked separately" deferral paragraph
to the permanent decision (ruled 2026-08-18, issue #31; use-latest is the discipline; the sweep
that enforced it is this group). Spec §15: one new decision row. HANDOFF/CLAUDE.md updates ride
the close-out per house rule.

## Process

TDD where a pure seam exists (Tasks 2, 3, 4 — watched RED first); mechanical adoptions covered by
helper tests + gates + E2E. One vitest process at a time. Fresh implementer subagent per task,
task-reviewer per task, fix rounds until approved. Full gates (`npm test`, `tsc`, `eslint`,
`build`) + **`npm run test:e2e` (mandatory — this group is nearly all UI files)**. PR closes
#3, #15, #23, #31, #110 (NOT #5 — closed separately with evidence); attribution in the PR body;
no commit trailers.
