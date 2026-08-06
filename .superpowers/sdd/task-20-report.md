# Task 20 report — E2E flows, demo walkthrough, and docs (2026-08-05/06)

Status: COMPLETE — all gates green (tails below). Branch `phase-4-certs-shipping`, combined tree.
Deliverables: five new E2E flows (harness now 15), `docs/2026-08-05-phase-4-demo.md`,
`docs/HANDOFF.md` §4a/§6/§7/§9, `CLAUDE.md` additions, and the fixture/harness plumbing.

## What was built

### The harness (Step 1–2)

The repo's E2E convention is NOT `*.spec.ts` files — it is a hand-rolled harness (`e2e/run.mjs`,
2C-3-era, spec §12/HANDOFF §5a) driving the bundled Chromium with one `.mjs` module per flow under
`e2e/flows/`. The brief's `e2e/<name>.spec.ts` filenames were therefore mapped onto the house
convention: `e2e/flows/<name>.mjs`, registered in `run.mjs`'s `FLOWS` table. Deviation recorded
here; everything else in the brief is implemented as written.

New files:
- `erp/e2e/flows/ship-partial-then-complete.mjs`
- `erp/e2e/flows/multi-order-shipment.mjs`
- `erp/e2e/flows/cert-results-print.mjs`
- `erp/e2e/flows/void-shipment.mjs`
- `erp/e2e/flows/credit-hold-block-and-override.mjs`
- `erp/e2e/lib/orders.mjs` — shared helpers: `createOrderViaUi` (keys an order through the real
  `/orders/new`, discards a leftover autosave draft, waits for hub-only content — never
  `waitForURL`), `startNewShipment`, `orderPanel`, `waitForShipmentPage` (waits for the
  "Packing List N" heading — the Step 2 URL-trap rule, documented in the helper itself).

Modified:
- `erp/e2e/run.mjs` — five FLOWS entries; a third credential kind (`as: "clerk"`); header comment
  updated (six → fifteen).
- `erp/e2e/lib/db-fixtures.ts` — Phase 4 fixtures + cleanup (below).

Fixtures (HANDOFF §5a discipline — exact-key, scoped to the fixture customers, localhost-gated,
cleaned from the DEV database `erp` afterward):
- `E2ESHIPCUST` (plain shipping customer) with `E2E-SHIP-A`/`E2E-SHIP-B` (certRequired: false,
  explicit — pins resolution regardless of the dev DB's plant settings) and `E2E-CERT-PART`
  (certRequired: true, scope ORDER) carrying two real `PartInspection` rows (`E2E Hardness`
  40–50 on scale `E2E HRC`; `E2E Case Depth` 0.02–0.045) — the cert-seeding source.
- `E2EHOLDCUST` (creditHold: true) with `E2E-HOLD-PART`. Separate from Phase 3's `E2EORDCUST`
  (which is also on hold — that would block every ordinary shipping flow) and from the process
  suite's `E2ECUST`.
- Reference rows: `E2E Tote` container type, the inspection code/scale rows above.
- A third fixture user, `e2e_clerk` (`E2E Shipping Clerk Role`): parts/customers/processes view +
  orders view/create/edit + shipping view/create/edit + certs.view, **without**
  `action.override_credit_hold` — the credit-hold flow's blocked half. (`processes.view` is
  needed because the entry page's lead-part preview reads a `processes.view`-gated route — found
  by the first run's failure, see "Runs" below.)
- Cleanup: new `deleteShippingAndCerts` (certs → readings/requirements → shipper children →
  shipper/cert rows, plus their audit entries AND each stored document's own audit entry — the
  fix-wave-12 lesson re-applied), `deletePhase4Reference` (codes before scales; after certs,
  part-inspections and orders), `partInspection` sweep before parts, clerk user/sessions/drafts.
  Both `cleanup()` (id-driven) and `reapLeftovers()` (exact-key self-heal) extended; voided
  shipments/certs deliberately NOT filtered out (the void flows leave them behind on purpose).

### Per-flow account (what each asserts)

**11. ship-partial-then-complete** (spec §13.1) — creates a 2-line order (100×A, 40×B) via the
real entry page; **Cust Cont Id round-trip pin** (Task 17 adjudication B — no vitest seam
exists): hub containers grid saves count 4 + `BIN-0007`, second save touches ONLY count (4→5),
full page reload, asserts `BIN-0007` survived; shipment 1 from `/shipping/new` asserts prefill =
full ordered (100/40), ships 60/0, nothing complete; board row asserts **"· Partially shipped"**
(exact); shipment 2 asserts prefill = REMAINDER (40, and weight 400 — the ledger proof), ships
50 (deliberate over-ship), ticks both Complete; asserts the §5.7 amber save-with-warnings panel
("Packing List N saved." + `/exceeds the remaining/`) renders in a real browser before "Go to
shipment"; asserts second shipment is a distinct id, higher packing-list number, sequence label
`N-2`; board asserts **"· Shipped"** and NOT "· Partially shipped" (quantities don't influence
status — the over-shipped 50 changed nothing).

**12. multi-order-shipment** (spec §13.2; the Task 14 browser recapture + the Task 19
x-print-warnings pin) — creates order C (cert part, 12) and order D (plain, 10); one shipment
from `/shipping/new` with both; asserts one panel per order labeled `C-1`/`D-1`; **line edit
through the edit page's grid** (D: 10→8, `Save lines`, PUT asserted ok, value re-asserted from
the server's own response); "Print all tickets" (cert box pre-ticked): asserts the whole-set
document row ("Whole shipment"), the "1 certification archived" info line, fetches the stored
PDF and asserts `%PDF-` + **`/Count 2`** (two ticket sheets, one per order — §3.20, the P3
uncompressed-page-marker technique); "Print BOL": asserts the BOL document row and (after
reload) the "· BOL N" heading badge; **both order hubs list the same documents** — asserts
BOL/SHIPPER(/CERT on C) rows on each hub and that the BOL link href (document id) is IDENTICAL
on both (§8 union, not a copy); asserts hub D's Shipments row `D-1` + "(+1 other order)"; then
**voids order C's cert** (prompt reason, banner asserted) and prints tickets again with the box
still ticked — asserts the amber `x-print-warnings` render: `/requires a certification and none
exists to print/` + `/its ticket printed without one/` (the 2026-08-05 refusal→warning ruling,
pinned in a real browser).

**13. cert-results-print** (spec §13.3) — creates a cert-part order; the ORDER-scope cert exists
on the hub (created by order save, §6.2); asserts SEEDING + freeze rendering (both requirement
blocks, `E2E HRC` scale, location text, "No readings yet"); types readings 45 → asserts live
"Pass" badge and 60 → "Fail" BEFORE any save (client `computePassed` = server's); saves, asserts
the three-state summary **"1 passed / 1 failed / 0 pending"** (server truth, never
subtraction); overrides the failing reading (checkbox + explicit Pass choice), saves, asserts
"2 passed / 0 failed"; asserts the on-page §3.21 statement (`never appears on the printed
certification`); prints — asserts the archived "Certification" document row and that the
"not yet" printed-fact is gone; **fetches the stored PDF twice and asserts
`Buffer.compare === 0`** (byte-identical stored reprint; two FRESH renders are deliberately never
byte-compared — the renderPdf non-determinism rule); second print asserts a SECOND archived
document row.

**14. void-shipment** (spec §13.4) — creates an order (30×A), ships it complete, prints the
ticket (cert box unticked — not this flow's subject); asserts hub "· Shipped"; voids with a
reason (prompt copy asserted); asserts the "Voided — reason" banner; **programmatic lock sweep**:
`$$eval` over every `main input/select/textarea/button` asserting each is `disabled || readOnly`
(per-control-type — the Task 14 recapture's "looks disabled vs cannot be edited" distinction),
plus the two §5.16 titles verbatim ("Shipment is voided — stored prints stay available",
"Already voided"); asserts the stored ticket is still listed and still downloads as a real PDF;
asserts the order's status RETURNED to "· Open"; new shipment asserts prefill back at the full
30 (voided shipments contribute nothing to the ledger) and lands as sequence `N-2` with a higher
packing-list number (nothing freed).

**15. credit-hold-block-and-override** (spec §13.5; runs as the clerk) — order entry for the
held customer warns-and-saves (the P3 entry-side ruling, via the warnings interstitial);
`/shipping/new` as clerk: asserts the named+linked red banner, the "requires the
override_credit_hold action" copy, **zero** reason fields offered, Save disabled with the §5.16
title matching `/is on credit hold — saving requires the override_credit_hold action$/`;
re-login as admin (holds the action): asserts the reason field appears, **blank reason refused**
("A reason is required to override the credit hold."), real reason saves → shipment page;
asserts via the same authenticated audit API that the CREATE entry's
`after.creditHoldOverrideReason` equals the typed reason (and screenshots the History panel).

### Steps 4–6: docs

- **Demo walkthrough** `docs/2026-08-05-phase-4-demo.md` — Phase 3 demo format: delivered
  narrative, seed state, the five flows with named-checkpoint screenshot lists (artifact paths,
  gitignored as before), rendered-PDF descriptions verified against the actual `tickets.pdf`
  (two sheets, tear-off strip, liability text, Cust Cont Id columns), `bol.pdf` ("TRV NO.
  1018,1019", "Shipper's Bill of Lading No.") and `certification.pdf` (bare reading grid
  `45.0 | 60.0` including the overridden value; no min/max/scale/verdict; name-over-rule
  signature), watching-it-live, what-changed-for-daily-use, **the three §3.22-and-friends
  deviations the brief names** (pass/fail on screen not paper; `cert_number_next` unused in
  Settings; Cust Cont Id / Customer Job No built-but-unused), plus the two print-side owner
  pings, and the gate results.
- **HANDOFF §4a** rewritten as the Phase 4 record (status, finish sequence, delivered list,
  lanes/fold-in story incl. `89bd01c`/`7b171d5`, review-round statistics incl. the retroactive
  Task 14 story and Task 14b's origin, the 2026-08-04/05 owner rulings, the four owner pings,
  deferred-minors location = the ledger); lessons list grown to eleven (added the stale-lane-copy
  lesson and the `/new` URL-trap recurrence); "what to do next" is now the finish sequence.
  **§6** gains "Carried out of Phase 4 (triaged, not fixed)". **§7 item 1** was already struck
  (samples closed 2026-08-04) — verified, left as-is. **§9** rewritten as the Phase 5 kickoff
  prompt (Invoicing & A/R + QBO) quoting spec §16's inheritance list verbatim-in-substance,
  in the existing prompt format; the Phase 4 start prompt stays as the historical block.
- **CLAUDE.md** — three additions in house style, each verified against code first:
  the sorted-claim rule (`claimOrdersInOrder`, one `ORDER BY id FOR UPDATE` statement, never a
  loop — verified in `src/server/order-locks.ts`), the `StoredDocument` kind/owner `CHECK`
  bullet (verified in `prisma/migrations/20260804122700_certs_and_shipping/migration.sql`,
  including the deliberate SHIPPER-orderId looseness), and the five-plain-@unique +
  "Cert has no unique column, adds no sweep exemption" note (verified against `schema.prisma`
  and `tests/partial-unique-sweep.test.ts`'s exemption list). Also updated the row-locks
  paragraph's `claimOrder` location (orders.ts → order-locks.ts — it moved in Task 7).

## HANDOFF/CLAUDE.md claims verified against code (not memory)

- `claimOrdersInOrder` / `sortedClaimIds`: `src/server/order-locks.ts` — single
  `SELECT … WHERE id = ANY(…) ORDER BY "id" FOR UPDATE`; `LockRows`-above-`Sort` reasoning in
  its own comment.
- `StoredDocument_kind_owner_check`: migration SQL at
  `prisma/migrations/20260804122700_certs_and_shipping/migration.sql:329` — four kind arms,
  SHIPPER deliberately looser (orderId = sub-scope).
- Sweep exemptions: `tests/partial-unique-sweep.test.ts:142-143` lists exactly
  `User.username, Order.orderNumber, Order.clientRequestId, Shipper.shipperNumber,
  Shipper.bolNumber, Shipper.clientRequestId`; Cert adds nothing (its schema comment and
  §3.19 confirm no unique column).
- `cert_number_next` genuinely unused: registry entry in `settings.ts`, zero consumers
  elsewhere (repo grep).
- 19 migrations on both DBs; exactly three are Phase 4's
  (`git diff --name-only 586a569..HEAD -- erp/prisma/migrations`):
  `document_kind_values`, `certs_and_shipping`, `user_signature_mime_type`.
- Credit-hold reason lands in the create audit payload as `creditHoldOverrideReason`
  (`shippers.ts` auditPayload), reason-column-free — which is why the flow asserts it via the
  audit API rather than HistoryPanel text.
- §6's new "cert-print info line points at the wrong list" item: `listDocumentsForShipper`
  filters `{ shipperId }`; cert documents are `{ kind: CERT, certId }` (the CHECK forbids a
  shipperId on them), so they cannot appear in the shipment's Documents list the info line
  points at.
- §7 item 1 already struck through in HANDOFF (closed 2026-08-04) — confirmed before touching.

## Runs (Step 3) — three consecutive 15/15

- **Shakedown run** (before the stability series): 14/15 — `credit-hold-block-and-override`
  failed at the shared order-entry helper: the clerk lacked `processes.view`, so the lead-part
  preview route 403'd and the "Rev 1 — locks at save" checkpoint never rendered. Fixed in the
  FLOW's fixture (clerk role gains `processes.view`, with a comment explaining why) — a fixture
  gap, not an app bug; no waits or retries added anywhere.
- **Run 1: 15/15. Run 2: 15/15. Run 3: 15/15.** (Summaries below; each run prints the fixture
  create/cleanup lines and per-flow PASS list; artifacts regenerated per run.) No flake appeared
  in any run; the only intervention across the series was the permission fix above, made BEFORE
  the series started.
- One machine note: the bundled Chromium was not yet installed on this (new) machine —
  `npx playwright install chromium` per HANDOFF §5a, once.

Run summaries (verbatim tails):

```
Run 1 (after fixture fix):  All 15 flows passed.
Run 2:                      All 15 flows passed.
Run 3:                      All 15 flows passed.
```

(Full per-flow PASS lists identical across runs: template-build-and-load, typed-fields,
revision-cut, blocked-code-delete, permission-gating, processes-list, order-entry-full,
board-search-scan, loads-after-print, void-order, ship-partial-then-complete,
multi-order-shipment, cert-results-print, void-shipment, credit-hold-block-and-override.)

## Demo checkpoints list

Flow 11: order-created, cust-cont-id-preserved, new-shipment-partial, shipment-1-saved,
board-partially-shipped, save-warnings-overship, shipment-2-saved, board-shipped.
Flow 12: two-order-panels, shipment-saved, line-edited, tickets-printed, bol-printed,
hub-c-documents, hub-d-documents, cert-voided, print-warns-missing-cert (+ tickets.pdf, bol.pdf).
Flow 13: hub-cert-listed, cert-seeded-frozen, computed-pass-fail-live, readings-saved,
override-round-trip, cert-printed, reprint-archived (+ certification.pdf).
Flow 14: shipped-and-printed, order-shipped-before-void, voided-every-control-locked,
order-status-returned, new-shipment-sequence-2.
Flow 15: order-saved-despite-hold, clerk-blocked, admin-sees-reason-field, blank-reason-refused,
override-saved, override-in-history.

## Gates (Step 7)

- `npm test` — **1357 passed (97 files), 0 failed** (`Test Files 97 passed (97) / Tests 1357
  passed (1357)`)
- `npx tsc --noEmit` — clean (exit 0)
- `npx eslint src tests` — clean (exit 0)
- `npm run build` — succeeded (exit 0; route table includes `/shipping/new` et al.)
- `npm run test:e2e` — **15/15, three consecutive runs** (above); both databases report no
  pending migrations

## Concerns / observations for the whole-branch review

1. **Flow-file naming deviates from the brief's literal `e2e/*.spec.ts`** — the harness's own
   convention (`e2e/flows/*.mjs` + `run.mjs` registry) was followed instead; the brief's five
   flow NAMES are exact.
2. **The shipment page's cert-print info line** ("N certifications archived — open them from
   Documents below") points at a list that cannot contain them (recorded in HANDOFF §6; copy-only
   fix).
3. **Order-hub Documents list renders raw kind names** (SHIPPER/BOL/CERT) — its KIND_LABELS map
   only knows TRAVELER (recorded in HANDOFF §6; the flows assert against the raw names, so a
   label fix will need a two-line flow update — flagged so the fixer knows).
4. **Shipment-page HistoryPanel renders the raw `orders` JSON diff** on line-replace updates
   (visible in flow 12's artifacts) — legible-history candidate for a later phase; the audit
   CONTENT is correct.
5. The credit-hold flow asserts the audit reason via the API (`after.creditHoldOverrideReason`)
   because no screen renders a create entry's payload — "appears in history" is satisfied at the
   API + a History screenshot; if the owner wants the reason VISIBLE in the panel, that is a
   HistoryPanel feature request, not a data gap.
6. **The clerk fixture needed `processes.view` to key an order** — a real (small) UX fact: a user
   without processes.view keying an order sees "Could not verify process steps" on the lead line.
   Worth a §5.16-style look someday; not a Phase 4 regression.
7. Videos: Playwright records a `page@….webm` per popup page (prints open tabs); harmless
   artifact noise alongside `video.webm`.

## Commits

- `a7fe24b` — `test(e2e): five Phase 4 flows — ship ledger, multi-order print, certs, void, credit hold`
- `aa1f02b` — `docs: Phase 4 demo walkthrough and handoff update` (demo doc, HANDOFF, CLAUDE.md,
  this report)
- `<this file's amendment>` — the report's own gate/commit facts finalized after the commits above.
