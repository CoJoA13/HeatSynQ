# Task 4 — implementer report (#14 items 1, 2, 4 + #37 + #38)

Branch `group-h-polish`. All work TDD where testable: RED watched for the right reason before
each implementation. Gates green (see bottom). One process deviation, recorded first because it
reshaped the commit plan.

## Deviation: the audit.ts hunk was swept into 8ccd8a2

The brief's "commit audit.ts FIRST and alone" could not be executed as written. While my
`part: { material: true }` edit sat uncommitted in the shared working tree (RED test already
verified, GREEN just confirmed), the concurrent Task 1 session committed the whole of
`src/server/audit.ts` for its reviewer minors — commit `8ccd8a2` therefore carries the
SNAPSHOT_INCLUDE change and its comment. The coordinator confirmed the sweep as their mistake and
directed: no re-commit, no revert, cite 8ccd8a2. The pinning test landed separately as `4a05738`
with the sweep recorded in its commit message. The change itself is exactly the briefed one-line
entry; nothing else about item 2 was affected.

## #14 item 2 — audit diffs show a raw material cuid

- **Snapshot half** (in `8ccd8a2`, see deviation): `erp/src/server/audit.ts:69` —
  `part: { material: true }`, the partSpecification precedent one entry down, with the
  frozen-history note (cuid kept, no backfill). `material` is a to-one relation, so no `orderBy`;
  the #24 sweep (`tests/snapshot-order-sweep.test.ts`) was run after the edit and passes —
  including Task 1's new no-@@map pin.
- **TDD** (`4a05738`): `erp/tests/parts.test.ts:159-173` — updatePart changing `materialId`,
  audit row read back, after-snapshot asserted to carry `material.name` ("Ductile iron") beside
  the raw FK, before-snapshot `material: null`. RED evidence: run against `part: undefined`
  failed `expect(after.material?.name).toBe("Ductile iron")` with `Received: undefined`
  (vitest output, 01:53 run).
- **Render half** (`b6ffe85`): the diff logic extracted to the client-safe leaf
  `erp/src/lib/audit-diff.ts` (the Group D extract-and-test pattern) — `changedFields` now
  suppresses a changed `<x>Id` key when its `<x>` sibling ALSO changed in the same entry, so the
  diff reads once through the resolved relation. The sibling must itself have changed: frozen
  pre-include entries (cuid only) and raw-key-only changes keep the raw key.
  `erp/src/components/HistoryPanel.tsx:6,93` imports and calls it. Tests:
  `erp/tests/audit-diff.test.ts` (7 cases: null sides, updatedAt skip, deep order-sensitive
  compare, suppression, frozen-history keep, sibling-unchanged keep, literal-"Id" keep). RED:
  module-not-found before the leaf existed.

## #14 item 1 — History panel never refreshes after a same-page edit

`79824de`. The SetupBanner/BackupBanner module-level listener-Set idiom cloned into
`erp/src/components/HistoryPanel.tsx`:

- Set at `:28`, `subscribeHistoryInvalidations` at `:34` (exported for the contract test, the
  subscribeSetupInvalidations precedent), `invalidateHistory` at `:49` (success-path, before
  follow-up loads — the #124/#131 ordering, stated in its doc comment).
- The panel subscribes in a mount effect (`:59`) bumping a `refreshNonce` (`:58`) that re-runs
  the fetch effect (`:65-77`). The landing stays gated by the effect-scoped stale flag — the
  sanctioned useLatest-equivalent where the fetch is keyed entirely by effect deps
  (refreshNonce now included), per CLAUDE.md's stale-load discipline.
- One refinement beyond the straight clone: `loadedKeyRef` (`:64-67`) keeps the current rows on
  screen during a same-key invalidation refetch instead of flashing "Loading history…" after
  every blur-save, while a re-pointed `entityId` still blanks to loading first (the original
  behavior, preserved — its comment explains why).
- Call sites, success path before any follow-up load: parts page `save()`
  (`erp/src/app/parts/[id]/page.tsx:129`); SpecsSection add/remove (`:63`, `:71`);
  InspectionsSection saveRow/removeRow/move/add (`:105`, `:129`, `:151`, `:194`); PricingSection
  saveRow/move/removeRow/addRow/saveBreak/addBreak/removeBreak (`:120`, `:185`, `:210`, `:243`,
  `:270`, `:322`, `:330`); CustomFieldsSection save (`:51`). Other HistoryPanel mount sites
  (orders, customers, …) deliberately NOT wired — they benefit whenever their pages later call it.
- Test: `erp/tests/history-invalidation.test.ts` pins the register/invalidate/unsubscribe
  contract (no DOM test env — the setup-banner.test.tsx approach). RED: exports missing.

## #14 item 4 — price text convention on blur-save

`af22661`. One convention: the text a fresh reload renders (server Decimal → JS number → React's
shortest round-trip string; "0.5500" → "0.55"). `normalizePriceText` in the new client-safe leaf
`erp/src/lib/price-display.ts`; applied on the SUCCESSFUL blur-save path only, in
`erp/src/app/parts/[id]/PricingSection.tsx` — `blurSaveRow` (`:136-149`) and `blurSaveBreak`
(`:296-313`; the break cells are the same class of 4-decimal input, so leaving them out would
recreate the issue one table down). Both re-sets are guarded on the field still holding the
exact text the save sent, so a user who refocused and kept typing mid-flight is never clobbered.
Tests: `erp/tests/price-display.test.ts` (trailing zeros, leading forms, idempotence,
unparseable-unchanged). RED: module-not-found.

## #37 — Combobox ARIA + attachments tooltip

- **ARIA** (`4d7cb24`): `erp/src/app/orders/new/Combobox.tsx` — attributes only, machinery
  untouched. `useId` listbox id (`:39`); input `role="combobox"`,
  `aria-expanded={open && filtered.length > 0}` (as `showList`), `aria-controls`,
  `aria-autocomplete="list"`, `aria-activedescendant` only while the list shows (`:69-73`); ul
  `role="listbox" id={listboxId}` (`:92`); each option button `role="option"`,
  id `` `${listboxId}-${i}` ``, `aria-selected={opt.value === value}`, `aria-disabled` beside the
  kept native `disabled` (`:104-106`); li rows `role="presentation"` (a bare listitem is not a
  valid listbox child; the option role lives on the button that carries the native disabled).
  All three consumers compile unchanged — verified by tsc + eslint over
  orders/new/page.tsx, OrderLineCard.tsx, orders/[id]/LinesSection.tsx.
- **Tooltip** (`8d68eee`, one pass with #38): `erp/src/components/AttachmentsSection.tsx:46`
  gains optional `disabledTitle` overriding the permission wording (`:53`);
  `erp/src/app/orders/[id]/page.tsx:645` passes voidLocked's exact "Order is voided" when
  voided. Parts page unchanged.

## #38 — client-side 20 MB pre-check

`8d68eee`. `erp/src/lib/upload-limits.ts` — `MAX_ATTACHMENT_BYTES` (20 × 1024 × 1024) and
`attachmentSizeError` returning the server's refusal verbatim ("Attachments cannot exceed
20 MB", attachments.ts:179), with the mirror-by-convention comment (no src/server import from a
client component). `AttachmentsSection.onFileChosen` (`:84-90`) refuses before building the
FormData: sets the error, resets the picker, returns. `erp/src/server/http.ts:73-82`'s pointer
comment now records the close: pre-checks at both ends, streaming enforcement declined (Group H
kickoff controller call, 2026-08-19 — the win is bounded to a client that lies about its size,
and streaming would mean hand-rolling a multipart parser per upload route). Tests:
`erp/tests/upload-limits.test.ts` — boundary behavior (at-cap accepted, one byte over refused)
plus a drift guard reading attachments.ts and failing if the cap or message ever moves without
the leaf. RED: module-not-found.

## Commits

| SHA | Scope |
| --- | --- |
| (`8ccd8a2`) | Task 1's commit carrying the swept `part: { material: true }` entry — see deviation |
| `4a05738` | test(parts): material-name snapshot pin (#14 item 2) |
| `b6ffe85` | audit-diff leaf + HistoryPanel raw-FK suppression (#14 item 2 render half) |
| `79824de` | invalidateHistory idiom + parts page/section wiring (#14 item 1) |
| `af22661` | price-display leaf + PricingSection blur-save normalize (#14 item 4) |
| `4d7cb24` | Combobox ARIA (#37) |
| `8d68eee` | AttachmentsSection one-pass: disabledTitle + size pre-check + http.ts comment (#37, #38) |

## Gates (from erp/, after all commits)

- `npm test` — 197 files, 3292 tests, all passed (shared erp_test DB; no cross-run noise, no
  scratch DB needed).
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.
- E2E deliberately NOT run (group-level per the brief). Note for the group run: the parts flow
  should verify the History panel refreshing after a section save and the material rendering by
  name in the diff; the orders/new flow should verify the combobox roles
  (combobox/listbox/option, activedescendant tracking).
