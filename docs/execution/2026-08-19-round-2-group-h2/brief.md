# Round 2 Group H2 — the client-state batch — brief

Branch `group-h2-client-state`, opened 2026-08-19 from `ed5ee77`. Issues in this PR:
**#144, #145, #146, #147, #148, #149** — the Group-D-filed six, split out of Group H by the
controller call its brief records. All display-layer client-state fixes; no schema, no service,
no concurrency invariant moves. Kickoff per the H brief's H2 section: no new recon — but the
filed refs predate the D and H merges, so a six-agent verification pass re-pinned every target
at HEAD (`a8ed769`). All six issues verified still real; the corrected refs below supersede the
issue bodies' `a9ff2ca` refs.

## Verification corrections the tasks are built on (2026-08-19, at `a8ed769`)

- **#145's board target spans TWO files now**: the H #33 slice left the `setSelectedDefault`
  handler in `src/app/page.tsx:171-183` but moved the checkbox into the presentational
  `src/app/board-parts/SavedViewsBar.tsx:43-50` — the guard state lives in page.tsx, a
  `settingDefault` disable prop threads through SavedViewsBar's Props.
- **The orders hub never adopted `useEditGuard`** — it still carries the pre-guard
  `focusedValue` ref (`orders/[id]/page.tsx:357-367`). #149's orders half is an ADOPTION
  (the parts-page precedent), not a keyed-variant integration; the existing scalar merge
  suffices there. The keyed variant is for the customers row arrays only.
- **No `tests/use-edit-guard.test.ts` exists** — `makeEditGuard` has no suite. Task 1 creates
  one covering BOTH the existing scalar guard (pinned first) and the new keyed variant.
- The leaf has **seven consumers** at HEAD (CertDetail, ShipmentDetail, customers/[id],
  InvoiceDetail, BatchDetail, parts/[id]/page, parts/[id]/IdentitySection) — the keyed variant
  must be **additive** so none of them changes.
- `PricingSection.tsx` gained saveScope/invalidateHistory plumbing in H (#14) — new guards must
  not disturb the `invalidateHistory()` + `load()` sequencing already in each handler.
- `CustomFieldsSection.tsx` gained a checkbox "clear" control in H (:94-100) — one more input
  surface with the same mid-save wipe exposure; the fix covers it too.
- `customers/page.tsx`'s filed claim "the file's own F7 comment calls it a bug" is stale — the
  :32-36 comment documents the ticket-gated catch, not this defect. The defect is real.
- AttachmentsSection's #37/#38 redesign left the shared-error mechanism intact; note H's #38
  size pre-check ALSO writes the shared `error` (:86) — it belongs to the upload channel.

## Controller calls (precedent-grounded; no owner input needed)

- **#148 → the merge port, not readOnly-while-saving.** The precedent's own comment
  (`ProcessStepsSection.tsx:217-219`) states the rule: the row stays editable during the
  request, so anything typed after it left must survive the success handler. Freezing inputs
  contradicts the rule the precedent exists to enforce. The port adapts to this file's
  snapshot-diff shape: capture `rowsAtSave` at click; on success-load, keep any field where
  `rowsNow ≠ rowsAtSave`, take the server value elsewhere; `original` = server data always.
  Extract the merge as a pure `src/lib/` helper with a vitest suite (the `step-drafts.ts`
  precedent).
- **#144 customers list → split the channels, don't pick a victim.** The filed trade (clearing
  on load success re-opens the add()-failure-wipe window) dissolves if load and add() stop
  sharing one channel: a load-error state the ticket-gated success clears, an action-error
  state only add() writes and clears. Same family fix as the rest of the issue.
- **#145 InvoicingList → the functional update**, not disabled checkboxes: preserve out-of-run
  ticks with `setTicked(prev => …)`; blocking ticking during a long run trades data loss for
  a UX regression.
- **AttachmentsSection → per-operation error scoping**: a success must never clear the OTHER
  operation's failure (upload-success wipes delete-failure at :99 and vice versa at :116).
  Two channels or a tagged one — implementer's choice; the #38 size-check message rides the
  upload channel.

## Tasks — one wave, three parallel implementers (file-disjoint)

**Task 1 — #149, the typed-text overlay** (internally ordered: leaf + tests FIRST, commit,
then integrations).
(a) `src/lib/use-edit-guard.ts` (:55-95): add a row-scoped KEYED variant of `editGuard.merge`
(keyed by row id + field) for array state — **additive only**; the scalar API and its seven
consumers are untouched. NEW `tests/use-edit-guard.test.ts`: pin the existing scalar guard's
behavior first, then drive the keyed variant (deferred-driven, the `save-scope.test.ts` /
`use-latest.test.ts` shape).
(b) Customers arrays: `customers/[id]/page.tsx` — `applyDetail` (:152) routes
`setAddresses`/`setContacts` through the keyed merge; the cells' `noteFocus`
(`editGuard.onFocusField(null)`, :341) becomes row-scoped keys at the onFocus sites
(addresses ~:730-770, contacts ~:858-880); update the :335-341 comment that documents the gap.
(c) Orders adoption: `orders/[id]/page.tsx` — replace the `focusedValue` ref (:357-367) with
`useEditGuard` (the parts/[id] adoption precedent); thread `merge` into `applyMutation`'s
`setOrder` (:233-235) and `saveOrder`'s optimistic patch/rollback (:328/:349). Covered inputs:
Overview scalars :494-514 (incl. H's new customerJobNo :511-514), Notes :629-630; the
onChange-saving date inputs (:526-539) are the trigger, not the target. **Two invariants must
survive verbatim: the travelerPrinted monotonic preserve (:227-235, Codex PR #141 round 5) and
the mutation-gate/drain machinery (:199-237, :323-353).** The bulk grids' own overlays (top
comment :11-15) are out of scope.

**Task 2 — #144 + #145, list-page error channels + in-flight guards.**
#144: `ShippingList.tsx:58` → the NewShipment `loadError` shape (precedent
`NewShipment.tsx:144-149`, banner :417) — a separate, never-auto-cleared picker banner.
`InvoicingList.tsx:110` → own `customersError` state; fix the :247-251 banner's mislabel.
`CertList.tsx:117` → same split (rework the :111-114 shared-channel comment) PLUS a `loaded`
flag so the :194-196 empty-state can't render pre-first-load (the `candidatesLoaded`
precedent, `InvoicingList.tsx:61`/:234). `customers/page.tsx:37-48` → split load/action
channels per the controller call above. `AttachmentsSection.tsx` → per-operation scoping
(:99/:116) per the controller call.
#145 (precedent `processes/templates/[id]/page.tsx`: state :40, early-return :119, disable
:253-254): `Quotes.tsx:149` per-row `bumpingId` (+ disable at :287-290 — one render site
serves both worklist sections, so per-row covers both). `page.tsx:171-183` `settingDefault`
early-return + local mirror kept; thread a disabled prop through
`board-parts/SavedViewsBar.tsx:43-50` (call site page.tsx:216-230). `PricingSection.tsx`
`addBreak` :313 (button :463), `removeBreak` :326 (button :445), `removeRow` :181 (button
:378) — port the in-file `addingRow` shape (state :64, guard :222-223, button :483-487)
without disturbing the invalidateHistory/load sequencing. `InvoicingList.tsx:169` → the
functional `setTicked` preserving out-of-run ticks. Both issues' InvoicingList edits land in
ONE pass — different regions, one file history.

**Task 3 — #146 + #147 + #148, the three precedent-copies.**
#146: `BatchDetail.tsx:730` — catch the `load()` rejection and report via the in-file
precedent (:555-559); the callback serves BOTH apply and application-void (:205/:229), so the
banner wording is generic ("…succeeded, but the page could not be refreshed — reload to see
the current state."). ApplyPanel's own :142 load self-catches — no change there.
#147: `Close.tsx` — gate the affirmative readiness line (:319-320) on `loaded && !error` with
a loading arm (the :292 idiom); give `exportTitle` (:352-356) the `!loaded` arm `closeTitle`
has (:237); treat `gapCount` (:351) as unknown while un-loaded or errored. NOTE: the catch
(:134) sets `loaded = true`, so `!loaded` alone is insufficient — every consumer gates on
`!error` too (clearing gaps in the catch is acceptable belt-and-suspenders, not a substitute).
#148: `CustomFieldsSection.tsx` — the merge port per the controller call above: pure helper in
`src/lib/` + vitest suite, wired at :52's success reload; covers every input surface (:84
checkbox, :95 clear, :103 date, :107 number, :111 text).

## Conventions (from H's incidents — in force from the start)

- **Per-task scratch DBs**: each implementer creates its own database
  (`CREATE DATABASE erp_scratch_<task>` via psql, `npx prisma migrate deploy` with a
  DATABASE_URL override, then run suites with a **`DATABASE_URL_TEST`** override — NOT
  `DATABASE_URL`: `tests/helpers/setup.ts:4` reassigns `DATABASE_URL` from
  `DATABASE_URL_TEST`, so a `DATABASE_URL=…scratch npm test` silently runs against the shared
  `erp_test`; Task 3 discovered this mid-group and verified the working override via
  `pg_stat_activity`. DROP the database when done.) Never cycle `npm test` against the shared
  `erp_test` while other implementers run.
- Explicit-pathspec commits ONLY; the controller commits no file an implementer owns;
  controller minors get solo verification.
- TDD per task: failing test → implement → pass → commit. Conventional messages, no
  attribution trailers.
- One task-reviewer per task, fresh; fix rounds until approved.
- PR body: **one `Closes #n` sentence per issue** (GitHub binds a keyword to one reference).

## Gates

Per task: `npm test`, `npx tsc --noEmit`, `npx eslint src tests` — from `erp/`, suites on the
task's scratch DB. **E2E (`npm run test:e2e`) at group level** after reviews (dev server +
`erp` DB) — every H2 change is UI-visible, so the gate is mandatory; targeted attention:
customers detail (address/contact typing), orders hub (Overview/Notes blur-saves), quotes
worklist (follow-up bump), invoicing list (create run + pickers), board saved views, parts
detail (pricing + custom fields), receivables batches (apply) and close (month switch),
shipping list, certs list.
