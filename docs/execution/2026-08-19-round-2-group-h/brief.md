# Round 2 Group H — the polish batch — brief

Branch `group-h-polish`, opened 2026-08-19 from `d539f8a`. Issues in THIS PR: **#14 (items 1,
2, 4), #37, #38, #33 (bounded slice), #100 (items 1, 2, 4, 5, 8, 9), #101, #72, #99, #24, #9**.
The Group-D-filed **#144–#149 run as a SEPARATE H2 PR after H** — the controller call the
backlog delegated, taken on recon's recommendation: H+6 would push one review past this repo's
known convergence comfort, the six are a self-coherent family (Group D's own audit, shared
§5.13/§5.16 vocabulary), and #149's shared-leaf regression surface (use-edit-guard feeds four
pages) deserves its own visible review.

## Kickoff rulings (2026-08-19)

- **#33 → bounded slice + defer the create/edit split** (owner, asked on recon evidence): the
  issue's named seam is the ragged one — create/edit share the zod line schemas, four helpers,
  and the §5.14 SSI pairing; orders.ts is 1750 invariant-dense lines; no test pins module
  boundaries. The slice: board page → presentational components (state stays put),
  `board-columns.ts` finally gets its unit suite, `listOrders`/`exportOrders`/filter builder →
  `order-board.ts` behind a re-exporting barrel (pure reads — zero concurrency invariants move),
  `isDuplicateClientRequestId` → `db-errors.ts` (breaks two import-cycle edges). **The issue
  stays open**, retitled to the remaining create/edit scope, deferral evidence recorded on it.
- Controller calls (recon-grounded, no owner input needed): **#38 closes on the client
  pre-check** (the title is disjunctive; streaming enforcement declined — `http.ts:78-81`'s own
  comment bounds the win, and it would mean hand-rolling a multipart parser in every upload
  route); **#9 gets the FIX, not document-the-limit** (its stated L collapsed to M — the
  tx-threading prerequisite shipped since filing, leaving a ~15-line generic
  claim-before-snapshot in audit.ts); stale strikes at close with citations: **#14 item 3**
  (Group D's `nextSort` recompute), **#100 items 3, 6, 7** (stale-flag guard already
  satisfies the discipline; owner-closed; record-only by design).

## Recon corrections the tasks are built on (all verified at `d539f8a`)

- #24 has a THIRD unordered collection the issue missed: `user.overrides`, in BOTH
  `SNAPSHOT_SELECT.user` and `SNAPSHOT_INCLUDE.user`.
- #9's mechanism is real but half its cost is gone: `tx` is now type-required on every
  `audited*` call, and the order/invoice/quote/template/revision families already claim before
  snapshotting. The exposed path is per-field-key concurrent saves on the customer/parts detail
  pages — designed-in normal operation, so fix, don't document.
- #72 is NOT a constant deletion: seeded installs carry granted `ar.*` `RolePermission` rows
  (and possibly overrides), so removal without a data migration 400s every subsequent whole-set
  role save. The backfill drift-guard test pins frozen migration SQL against `ALL_PERMISSIONS`
  and needs the RETIRED-literal rework.
- #99's hole is generic: `updateReference` finds soft-deleted rows by bare id; the
  `endingStatement` promote normalizer early-returns on a false premise. One live-row guard at
  the top of the transaction fixes every kind at once.
- #14 item 2's fix is one `SNAPSHOT_INCLUDE` entry (`part: { material: true }` — the
  `partSpecification` precedent); frozen history keeps the cuid, accepted.
- #38's server half (Content-Length pre-check) already landed as a fix-wave; only the client
  pre-check remains.
- #100 item 1 (no-op audit on `customerId=current` PATCH), item 2 (SSI test's 200ms sleep →
  bounded lock-state poll), item 5 (float `totalLbs` → round to the Decimal(10,4) grain),
  item 8 (stale overlap banner on close/reopen + stop-panel dismiss), item 9 (suppress the bare
  Material label, owner ruling 8) are all CURRENT and S-sized. #101's ruling delegates the
  implementation choice — take the OR-gate on the existing route (no new route).

## Tasks — two waves

**Wave 1 (parallel — disjoint files):**

- **Task 1 — #24 + #9, audit snapshot fidelity** (`audit.ts` + two test files). #24 FIRST:
  three `orderBy` additions at snapshot CAPTURE (never render) — `role.permissions` by
  permission, `processStepCode.fields` by `[sort, id]`, `user.overrides` by permission in both
  SELECT and INCLUDE — plus the schema-text-parse sweep test (`snapshot-order-sweep.test.ts`,
  the partial-unique-sweep precedent; the v7 client exposes no runtime DMMF). Then #9: generic
  `SELECT … FOR UPDATE` claim at the top of `auditedUpdate`/`auditedSoftDelete` before the
  before-snapshot, table name derived from the `AuditableModel` key (validated against the
  model list); `auditedCreate` needs nothing. Already-claimed families re-lock a held lock —
  a no-op; Serializable callers' 40001s are already retry-wrapped. Two DETERMINISTIC
  interleave tests (deferred-parked `doIt`, never racing). **No other task touches `audit.ts`
  until this lands.**
- **Task 2 — #72 + #99 + #100 item 4, permission/reference cleanups.** #72: delete `"ar"` from
  `AREAS`; hand-written data migration (create-migration skill flow — no TTY) deleting the four
  `ar.*` rows from `RolePermission` AND `UserPermissionOverride` (explicit IN list); rework
  `backup-permission-backfill.test.ts`'s equality guard with a commented RETIRED frozen
  literal; swap `permissions.test.ts`'s `ar` example. RED-first migration test in the backfill
  style. #99: live-row guard (`findFirst({ id, deletedAt: null })` ON THE TX, the #60 rule) as
  the first statement in `updateReference`'s transaction, 404 matching `db-errors.ts`'s P2025
  message shape; correct the two now-true comments; verify (don't change) `deleteReference`.
  #100 item 4: thread `manageUsersGate` into the users page's four row controls + Add form
  (§5.16 disabled-with-reason; `UserSignatureControl` is the in-file precedent).
- **Task 3 — #100 items 1, 2, 5, 8, 9 + #101, the quoting surface.** Item 1: `updateQuote`
  skips the audited wrapper on an empty effective patch (response contract unchanged — still
  returns detail + overlap warnings); TDD by audit-row count. Item 2: replace the SSI test's
  fixed sleep with a bounded poll of pg lock state (never touches the assertions). Item 5:
  round the two products to the Decimal grain at the computation sites. Item 8:
  `setOverlapWarnings([])` on close/reopen success; stop-panel gains a dismiss that clears
  `createdQuote` and reloads the worklist. Item 9: value-based suppression at
  `pdf/quote.ts:464` citing ruling 8 (contract untouched — no drift-guard impact); TDD in
  `quote-pdf.test.ts`. #101: OR-gate (`orders.view || quotes.view`) inside the eligible route
  (no new route; extend the §5.15 comment — the route serves two screens), `ActiveQuotesSection`
  computes the same OR with the neither-case §5.16 message naming `quotes.view`; invert
  `quote-routes.test.ts:374`, add the neither→403 case. Route+test change in ONE commit.

**Wave 2 (after wave 1):**

- **Task 4 — #14 items 1, 2, 4 + #37 + #38, the parts/attachments/combobox cluster.** #14
  item 1: HistoryPanel gains the module-level listener-Set invalidation idiom (the
  SetupBanner/BackupBanner shape — extend, never hand-roll) + calls from the parts page's save
  funnels; item 2: `part: { material: true }` in `SNAPSHOT_INCLUDE` (**after Task 1's
  audit.ts edits are committed**) + TDD asserting the audit row carries the material name —
  and decide the raw-FK-key suppression in `changedFields` in the same pass; item 4: one price
  display convention via a small `src/lib/` normalize leaf applied on successful blur-save.
  #37: the WAI-ARIA editable-combobox pattern in `Combobox.tsx` (role/aria-expanded/
  aria-controls/aria-autocomplete/aria-activedescendant, listbox + option ids, aria-selected/
  disabled — behavior unchanged); AttachmentsSection gains a `disabledTitle` override so the
  voided order reads "Order is voided," not "Requires orders.edit" (§5.16 — the current
  wording states the WRONG reason). #38: client `file.size` pre-check in `onFileChosen`
  mirroring the server's exact message, cap constant in a `src/lib/upload-limits.ts` leaf with
  a vitest test; update `http.ts:79`'s pointer comment. AttachmentsSection's two edits (#37 +
  #38) in one pass — its prop surface is redesigned once.
- **Task 5 — #33, the bounded slice** (LAST — the pure-move diff must not drown behavioral
  review). (A) Board page: extract `SavedViewsBar`/`FilterBar`/`ColumnPicker`/`BoardTable` as
  props-driven presentational components — **extract JSX, never state**; the viewsReady gating
  and use-latest discipline move nothing. Add `tests/board-columns.test.ts` for
  `defaultViewConfig`/`normalizeViewConfig`/`buildOrderQuery` (the leaf exists, tests don't).
  (B) Service: `listOrders` + `exportOrders` + `OrderFilter`/`BoardRow` + the shared WHERE
  builder → `src/server/order-board.ts`; `isDuplicateClientRequestId` → `db-errors.ts`;
  `orders.ts` re-exports everything moved (all 36+ test files and 13 routes untouched). Each
  extraction is a VERBATIM cut-paste (diff the moved region); the orders↔shippers cycle
  comments update in the same commit. Record the create/edit deferral + retitle on #33.

## Gates

Per task: `npm test`, `npx tsc --noEmit`, `npx eslint src tests` — all from `erp/`.
**E2E (`npm run test:e2e`) runs at GROUP level** after wave 2 + reviews (dev server + `erp`
DB), plus targeted flow attention: orders/new combobox keyboard flows, parts detail, quotes
worklist, admin users/roles, board search/scan. Explicit-pathspec commits ONLY. One
task-reviewer per task, fresh each; fix rounds until approved.

## H2 (queued, separate PR after H merges)

#144–#149 exactly as recon shaped them: #144+#145's InvoicingList edits in one pass; #149's
use-edit-guard row-keyed extension lands first (leaf + deferred tests, then integrations);
#146/#147/#148 are S precedent-copies. Batch ≈ L. Kickoff needs no new recon.
