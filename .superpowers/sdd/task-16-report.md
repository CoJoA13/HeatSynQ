# Task 16 report — Cert detail page: requirement blocks and readings grids

Implementer: lane-B agent, 2026-08-05/06. Worktree `/home/cjones/Desktop/HeatSynQ-laneB`, branch `phase-4-lane-b`.

## What was built, per brief step

**Step 1 — header.** `src/app/certs/[id]/CertDetail.tsx`: `Certification #<orderNumber>[-<sequence>]`
(the §3.19 label, `certLabel`, the CertList.tsx precedent — sequence only for SHIPMENT scope), customer
`CODE · name`, an Order link to `/orders/[orderId]`, scope label plus its SUBJECT (`Load N` for LOAD,
`Packing List N` for SHIPMENT, nothing for ORDER — `scopeSubject`), printed date (`toLocaleString()` or
"not yet"), PO / material / received date, and the Void action (prompt for a reason → `DELETE
/api/certs/[id]` with the reason in the body → follow-up `load()`, two separate try/catches — the
ShipmentDetail.tsx `voidAction` precedent).

**Step 2 — requirement blocks.** Blocks grouped by part line: consecutive requirements sharing an
`orderLineId` fold under one `Line N — PARTNO · name` heading (requirements arrive in the cert's own
running `position` order, so consecutive grouping preserves both orders). Each block
(`src/app/certs/[id]/RequirementBlock.tsx`):
- Frozen fields (inspection code, scale, min, max, sample qty, location) render as **plain text, not
  inputs** — read-only by design (§4.1) — with the caption "Frozen when this certification was created —
  part changes never rewrite it."
- Readings grid: value input, computed pass/fail badge, explicit override checkbox, note input, remove
  (×), Add reading, Save readings. Pass/fail is computed live with the SAME `computePassed`
  (`src/lib/pass-fail.ts`) the server runs, three-state: Pass (green) / Fail (red) / **Pending (amber)
  for a blank value** — never inferred by subtraction (the Task 15 review finding, honored per-row and
  in the summary). Checking override swaps the badge for a Pass/Fail/Pending select whose choice is
  stored verbatim by the server (`overridden: true`).
- **§3.21 UI copy, twice**: a prominent summary section under the header — `N passed / N failed /
  N pending` in large type with "Pass/fail is shown on screen only — it never appears on the printed
  certification, and neither do min/max, scale, or override marks. The printed document carries the
  bare reading values." — and the grid column header itself reads "Pass/fail (screen only)".
- Saves go through `PUT /api/certs/[id]/results` naming ONLY that block's requirement — the merge
  semantics honored client-side too: a save of one block never touches (or discards drafts of) sibling
  blocks. Values cross as decimal strings; a client-side `decimalField(10,4)`-mirroring regex refuses a
  typo'd value in place (a local refusal, not a failed save) so the draft survives; notes over 500
  chars likewise.

**Step 3 — notes.** Freeform (labeled "(prints on the certification)") and Internal notes with a
persistent amber **"never printed"** badge beside the label. Blur-save PATCH with the focused-value
guard (no PATCH on a plain tab-through), optimistic with rollback-then-report: on failure `load()` runs
BEFORE `setError` (§5.13).

**Step 4 — post-print gating.** `resultsGateFor`: voided → locked "Certification is voided"; missing
`certs.edit` → `gate`'s own "Requires certs.edit"; printed without the special action → locked with
**"This certification has been printed — editing results requires edit_cert_results_after_print"**
(§5.16 — names the missing permission). Notes stay on plain `certs.edit` after print (the after-print
tightening covers the results grid only, spec §11's wording), void-locked like everything else.

**Step 5 — print, documents, history.** Print renders **disabled** with the §5.16 title "Available once
the certification layout lands (Task 19)" (the ShipmentDetail.tsx disabled-print precedent), switching
to "Certification is voided — no new documents can be produced for it" once voided. Stored documents
list via **new route `GET /api/certs/[id]/documents`** (see "Deviations"), gated `certs.view`, each row
a link to the existing `GET /api/documents/[docId]` download. `HistoryPanel entity="cert"
entityId={id}`. `page.tsx` mounts `<CertDetail key={id} id={id} />` — remount per id (HANDOFF §5.12).

**State model** (the ShipmentDetail/order-hub precedent): one `useMutationGate` ticket sequence shared
by `load`, notes PATCH and results PUT (every one replaces the whole `cert` state); per-requirement
remount counters (`blockResets`) discard exactly one block's draft on that block's save success
(re-seed from fresh server truth) or failure (rollback), leaving sibling drafts intact. `useLatest`-family
gating on every fetch path; no soft-catch anywhere — every fetch failure lands in a rendered error
state (the documents list and HistoryPanel each degrade with their own visible message).

## Files

- Created: `erp/src/app/certs/[id]/page.tsx`, `erp/src/app/certs/[id]/CertDetail.tsx`,
  `erp/src/app/certs/[id]/RequirementBlock.tsx`, `erp/src/app/api/certs/[id]/documents/route.ts`
- Edited: `erp/tests/cert-routes.test.ts` (one new route test)
- No `src/server/**` imports in any client component; shared code from `src/lib` only
  (`fetcher`, `permission-ui`, `use-permissions`, `use-latest`, `pass-fail`, `cert-constants`).

## Deviations disclosed

1. **New route `GET /api/certs/[id]/documents` is not in spec §9's route table.** The cert page must
   list stored documents (§11 "Print; documents; History"), but on this branch nothing exposes
   `listDocumentsForCert` (documents.ts, Task 3) over HTTP, and the only listing surface that could
   reach a CERT document — `GET /api/orders/[id]/documents` — gates on `orders.view` (a certs-only user
   would get nothing) and lists the whole order's mixed kinds. Lane A faced the identical gap for the
   shipment page and resolved it with `GET /api/shippers/[id]/documents` (commit e54684c on
   `phase-4-certs-shipping`); this route mirrors that reviewed precedent exactly, gated `certs.view`
   (the one kind it can return sits behind the same area the route gates on — no cross-kind leak
   possible). **Flagged here for adjudication per the brief**; if the ruling goes the other way the
   route + its test excise cleanly.
2. **Two §5.16 titles are informational rather than permission-naming**: the always-disabled Print
   button (names Task 19 / the void refusal — the lane-A shipment-page precedent verbatim) and the
   not-dirty Save button ("No unsaved changes"). Both still say why, which is the rule's substance.
3. The seed/browser-verification fixture script and a throwaway limited user (`laneb-editor`) were
   created in the shared DEV db and **fully cleaned up** (verified zero LANEB-prefixed rows and the
   user/role/sessions deleted; final check output in "Browser verification"). The temp script was
   deleted before commit; nothing of it is in the tree.

## TDD evidence

New server surface = the documents route only; the three UI files add no server/route surface (the
project has no component-test harness; UI verified in the browser, below).

**RED** — test written first, importing the not-yet-existing route:

```
$ npx vitest run tests/cert-routes.test.ts
Error: Cannot find module '@/app/api/certs/[id]/documents/route' imported from
'…/erp/tests/cert-routes.test.ts'.
 Test Files  1 failed (1)
      Tests  no tests
```

**GREEN** — after writing `src/app/api/certs/[id]/documents/route.ts`:

```
$ npx vitest run tests/cert-routes.test.ts
 ✓ cert routes > GET /api/certs/[id]/documents requires certs.view and lists only this cert's documents
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

The test covers 401 (no session), 403 (`orders.view` only), 200 with `certs.view` listing exactly this
cert's document (another cert's doc excluded), metadata-only (`fileData` absent), and 404 for a missing
cert — the `handler(request, { params: Promise.resolve({ id }) })` ctx shape throughout.

## Gates (all from `erp/`, after fixture cleanup and temp-file deletion)

```
npm test           →  Test Files  92 passed (92)   Tests  1276 passed (1276)
npx tsc --noEmit   →  clean (no output)
npx eslint src tests → clean (no output)
npm run build      →  ✓ Compiled successfully · exit=0 · route list includes
                      ƒ /api/certs/[id]/documents and ƒ /certs/[id]
```

(Suite was 1010 at phase start; 1276 includes both lanes' growth to date on this branch plus this
task's test.)

## Browser verification (performed — Playwright MCP, real browser)

Dev server `PORT=3001 npm run dev` against the shared DEV db `erp`; fixtures all LANEB-prefixed.
Seeded: customer LANEB1, part LANEB-PN-100 with two inspections (Rockwell min 58 / max 62, scale
"LANEB HRC", sample qty 5; Case depth min 0.02 / max 0.04, no scale, sample qty "100%"), an order via
`createOrder`, an ORDER-scope cert via `createCert` (requirements seeded frozen).

Observed, signed in as admin/admin:
1. Page renders: header facts, "No readings yet" summary, §3.21 copy, disabled Print naming Task 19,
   two requirement blocks under one part-line heading with frozen fields as text, empty grids, notes,
   empty documents list, History showing the create entry.
2. **Typed readings and watched pass/fail compute live**: 60 → Pass, 65 → Fail, blank row → Pending.
3. **Overrode the failing row**: checked override → badge became a Pending/Pass/Fail select → chose
   Pass. Saved; summary updated to **"2 passed / 0 failed / 1 pending"**; block remounted onto server
   truth with the override intact. DB check: value 60 `passed=true overridden=false note="mid-face"`;
   value 65 `passed=true overridden=true`; blank `value=null passed=null`. History (after reload)
   shows the real requirements/readings audit diff.
4. **Notes**: blur-saved both fields; DB confirmed both; audit diffs (`freeform: "" → …`,
   `internalNotes: "" → …`) visible in History. One honest wrinkle: on the FIRST attempt the
   internal-notes text was wiped because the freeform PATCH's whole-detail response landed mid-type in
   the other field — see Concerns #1.
5. **Post-print gating**: set `printedAt`; admin (holds the special action) still edits. Signed in as a
   purpose-made `certs.view`+`certs.edit`-only user: grid fully locked, and the DOM titles read exactly
   "This certification has been printed — editing results requires edit_cert_results_after_print" on
   inputs (readOnly), selects and buttons (disabled); Void button "Requires certs.delete"; History
   degrades to its no-permission message.
6. **Void**: as admin, voided with reason "LANEB demo — voided for browser verification" → red banner
   "Voided — LANEB demo — voided for browser verification" (reason resolved from the audit trail), a
   DOM sweep found **zero unlocked controls** in main — textareas/inputs readOnly, selects/checkboxes/
   buttons disabled, titles "Certification is voided" / "Already voided" / "…no new documents can be
   produced for it" — the mandated locking split (readOnly for text, disabled for the rest).

Screenshots (local, gitignored by the SDD dir's `*` rule — PNGs aren't tracked):
`.superpowers/sdd/task-16-screenshots/laneb-task16-{grid-before-save,printed-admin,postprint-locked-editor,voided}.png`

Cleanup verified: `{"customers":0,"parts":0,"certs":0,"users":0,"stepCodes":0,"inspCodes":0}` for every
LANEB-prefixed fixture; laneb-editor user, its role and sessions deleted; dev server stopped.

## Concerns

1. **Cross-field clobber window on the notes pair** (pre-existing pattern, inherited here): both notes
   are controlled by the one `cert` state, and a PATCH answers with the whole detail. Typing into field
   B while field A's save is in flight lets A's response (carrying B's OLD value) reset B's text. This
   is byte-for-byte the ShipmentDetail.tsx `patchHeader` / customers-page shape, so I kept the
   precedent rather than invent a divergent notes-only merge — but my scripted test hit it on the first
   try (instant typing), and a fast human tab-typist could too. Worth a fix-wave item across all three
   pages rather than a one-off here.
2. **HistoryPanel doesn't refresh after this page's own saves** (fetches once per entity/id mount —
   its existing behavior on the order hub too). Reload shows the entries. Noting, not fixing: shared
   component, sibling-split rule applies.
3. The route-table deviation (documents route) needs the adjudication named above.
4. Readings arrive as `number` (server `Decimal.toNumber()`), so a stored value like `0.0200`
   re-displays as "0.02" in the grid — trailing zeros aren't preserved. Cosmetic; the stored decimal is
   exact.
