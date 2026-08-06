# Task 17 report — Order hub Certifications + Shipments sections; cert fields throughout

**Status: COMPLETE.** All seven brief steps done. Gates green (1283 vitest, tsc, eslint, build).
Browser-verified on a live dev server with screenshots in `task-17-screenshots/`.

Pre-history worth recording: the first dispatch found `task-17-brief.md` corrupted (it held a
Task 18 code-block fragment — the controller's line-number extraction ran against this lane's
stale plan copy). Work was BLOCKED until the coordinator re-supplied the true brief; everything
below happened after that.

## Commits (lane `phase-4-lane-b`, base 3152512)

| SHA | Commit |
|---|---|
| `caa79dc` | feat(orders): accept the entry-time cert override at create (spec §6.1) |
| `15f0252` | feat(shippers): per-order breakdown on shipment rows for the order hub |
| `ad5c001` | feat(parts,customers): report what a null cert column would inherit |
| `45eb23e` | feat(ui): part and customer certification fields (three-state, inherit labelled) |
| `1cc83fb` | feat(ui): order hub certification and shipment sections, cert fields throughout |

No attribution trailers. The brief's named commit message is `1cc83fb`; the three server commits
are the TDD-first payload widenings it consumes, and `45eb23e` is the sibling pair kept atomic.

## Per-step account

### Step 1 — hub Certifications section
`src/app/orders/[id]/CertificationsSection.tsx` (new). Fetches `GET /api/orders/[id]/certs`
(certs.view-gated; a caller without it sees the section saying why — §5.16, never hidden).
Lists every cert, voided dimmed with a tag, each linking to `/certs/[id]` (Task 16, works on
this lane). Load-scope gap per §4.1: when the order's stored resolution is (required, LOAD) it
shows "by load · N loads · M certs" plus a create button per uncovered load, POSTing
`{loadNumber}` to the hub route (the only scope this section creates — order/shipment scopes are
listed only, created by order save and shipment save respectively). **Orphan warning**: every LIVE
load-scope cert whose `loadNumber` is absent from the order's current loads renders an amber
row naming the cert with a link — "void it or re-create it"; a voided orphan is deliberately not
re-flagged (voiding is the human resolution §4.1 asks for). Non-optimistic `call()` shape; the
create gate is `voidLocked(gate(certs.create))`, so a voided order disables creation with
"Order is voided".

### Step 2 — hub Shipments section
`src/app/orders/[id]/ShipmentsSection.tsx` (new). Fetches `GET /api/orders/[id]/shipments`
(shipping.view-gated, §5.16 message otherwise). Each row: THIS order's own label (`1002-1`,
from the widened per-order breakdown — see below), packing list no, ship date, this order's own
qty/weight, Complete/Partial (all lines `lineComplete` → Complete), carrier, voided tag, and a
"+N other orders" note on multi-order shipments. Links to `/shipping/[id]` — lane A's page, 404
on this lane's dev server, the established cross-lane nav precedent (not "fixed"). Pure read;
voided orders need no extra lock here.

### Step 3 — Overview fields
`src/app/orders/[id]/page.tsx`: `customerJobNo` input (blur-save, the PO/VS# shape),
`certRequired` checkbox + `certScope` select (save-on-change), all through the existing
optimistic `saveOrder` PATCH (rollback-then-report on failure, per-key serial queue, ordering
ticket — all inherited from the page's one mutation path). The client `OrderDetail` mirror
gained the three fields, documented as the STORED/frozen values, never a re-derivation. All
three controls honor `editGate` = void-locked orders.edit (§5.16 titles).

### Step 4 — order entry
`src/app/orders/new/page.tsx`:
- `OrderDraftState` += `customerJobNo` (typed), `certRequiredOverride: boolean|null`,
  `certScopeOverride: CertScopeValue|null`; `ContainerDraft` += `customerContainerId`.
  blankDraft/normalizeDraft/isDraftEmpty all extended (normalize degrades a garbage stored
  scope to null = re-derive).
- **2C-3 honored**: the preview is composed at render — per line
  `part.certRequired ?? part.inheritedCertRequired` OR'd across lines; scope from the lead
  alone — which IS §6.1's chain because parts.ts folds customer-default-else-plant into
  `inheritedCert*` server-side. Nothing derived is stored; overrides win until "overridden —
  reset to resolved". With no lead part picked, the controls are disabled saying "Pick a lead
  part first" (§5.16) rather than showing a made-up No.
- `buildCreateBody`: `certRequired`/`certScope` sent ONLY when overridden (`?? undefined`, the
  receivedDate pattern), `customerJobNo` always, containers carry `customerContainerId`.
- Reference & dates grid gained "Customer job #"; the containers grid gained the "Cust Cont Id"
  column (grid-cols-6 → 7).
- **Sibling grid**: the hub's `ContainersSection` gained the identical column in the same commit
  — mandatory, not optional: that grid PUTs a whole-array replace, so without composing the
  column every hub container save would have silently blanked stored `customerContainerId`
  values (`CONTAINER_ITEM`'s `?? ""`). This was a live latent data-loss bug on this branch since
  Task 4 landed the column; fixed here.

### Step 5 — part and customer pages (sibling pair, one commit: 45eb23e)
- Part (`parts/[id]/IdentitySection.tsx` + page type): "Certification required" three-state
  select — `Inherit — currently Yes/No` / Yes / No — and "Certification scope" —
  `Inherit — currently <label>` / the three scopes. Inherit labels read the new
  `inheritedCert*` row fields (customer default, else plant), so EVERY viewer sees what inherit
  means without needing customers.view or admin.view. Saves through the page's existing
  optimistic `save()`; parts.edit gating with titles.
- Customer (`customers/[id]/page.tsx`): `certRequiredDefault`/`certScopeDefault` three-state
  selects in the Commercial section, inherit labelled `Inherit plant — currently …` from the
  same mechanism (= the plant settings). customers.edit gating.

### Step 6 — browser verification (performed, not claimed)
Dev server `PORT=3001` (lane-B worktree, shared dev DB `erp`), admin/admin, Playwright-driven.
LANEB-prefixed fixtures (customer `LANEB-T17`, parts `LANEB-T17-P1` certRequired=true/ORDER and
`LANEB-T17-P2` inherit/inherit with process step + container type `LANEB-T17 Basket`). Observed:

1. **Entry**: Customer job # field; Certification section disabled with "Pick a lead part…"
   until the lead was picked, then "Certification required ✓ — Resolved from the part/customer
   settings: Yes" and "Scope: By order — Resolved from the lead part". (`01-entry-cert-preview.png`)
2. **Keyed the order (#1002) and the cert appeared on the hub** — the brief's core check:
   Certifications section listing one "By order" cert linking to `/certs/…`; Overview showing
   Customer job # `JOB-4417`, Certification required ✓, scope By order. (`02-hub-cert-appeared.png`)
3. **Load gap + create + orphan**: switched Overview scope to By load → "by load · 1 load ·
   0 certs" + "Create cert for Load 1"; clicked → "1 load · 1 cert", gap button gone. Split to
   2 loads → "Create cert for Load 2" appeared; created it; removed load 2 → amber §4.1 warning:
   "Certification for Load 2 points at a load that no longer exists after a re-split — void it
   or re-create it for a current load." (`03-hub-load-gap-and-orphan.png`)
4. **Cust Cont Id round-trip on the hub grid**: added container (LANEB-T17 Basket ×2,
   Cust Cont Id `LANEB-BIN-7`), saved, reloaded — value persisted; the audit diff in History
   carries `"customerContainerId":"LANEB-BIN-7"`.
5. **Part page**: P2 showed `Inherit — currently No` / `Inherit — currently By order`
   (`04-part-inherit-labels.png`). After setting the CUSTOMER's required-default to Yes via the
   new customer control (`05-customer-cert-defaults.png`), P2's label re-read
   `Inherit — currently Yes` — the chain flows through live.
6. **Shipments section**: created a real shipment via the service layer (packing list 1003,
   qty 4 of 10) — hub row rendered `1002-1`, 1003, 2026-08-06, qty 4, weight 10, **Partial**,
   linking to `/shipping/[id]`; order status flipped to Partial Shipped in History.
   (`06-hub-certs-and-shipments.png`)
7. Cert detail link click-through rendered "Certification #1002" (Task 16 page) — hub links work
   on this lane.

**Fixture cleanup**: every LANEB row (order+children, 3 certs+requirements, shipper+children,
parts, revision/step/step-code, container type, customer) hard-deleted from the dev DB, plus
their 11 audit rows; verified zero LANEB-prefixed rows remain. Order number 1002 / shipper
number 1003 were consumed from the shared counters — by design numbers are never reused, so
this is ordinary operation, not residue. Seed/cleanup scripts deleted; dev server stopped.

Note: the Playwright MCP server's allowed root is the MAIN tree, so screenshots were staged
under `~/Desktop/HeatSynQ/.playwright-mcp/laneb-t17/` (the plugin's own scratch dir — no repo
file touched) and immediately moved into this lane's `task-17-screenshots/`; the staging dir was
removed.

### Step 7 — gates (final run, after all commits and cleanup, from `erp/`)

```
npm test         → Test Files 92 passed (92) · Tests 1283 passed (1283) · 104.06s
npx tsc --noEmit → clean (TSC-OK)
npx eslint src tests → clean (ESLINT-OK)
npm run build    → ✓ Compiled successfully · 46/46 static pages · exit 0
```

Suite grew 1010 → 1283 across the phase; this task added 7 tests (see RED/GREEN below).

## Widened payloads (disclosed per the dispatch contract — no new routes added)

1. **`POST /api/orders` body** (`CREATE`, orders.ts): optional `certRequired`/`certScope`.
   Spec §6.1 says the resolution is "overridable **at entry** and after"; §9's route table names
   only the PATCH half, but the entry half cannot be built on PATCH-after-create (the eager
   ORDER-scope cert would already exist before the override landed). `saveNewOrder` composes
   `data.certX ?? resolved.certX`; the EFFECTIVE pair freezes on, is what the audit payload
   records, and is what decides §6.2's eager order-scope cert (override-to-false suppresses it;
   override-to-LOAD stays lazy). Omitted keys are byte-for-byte the old behaviour.
2. **`ShipperRow.orders`** (shippers.ts, additive): per-`ShipperOrder`
   `{orderId, orderNumber, sequence, qty, weight, complete}` in print order, `complete` = every
   line `lineComplete` (§5.2's human's-call flag, never quantities; empty-lines guarded false).
   Needed because the brief's hub row (label `72036-3`, this order's quantities, complete flag)
   is unanswerable from shipment-wide totals on a multi-order shipment. `listShippers`/
   `exportShippers` unaffected (toXlsx picks declared columns only).
3. **`PartRow.inheritedCertRequired/-Scope`** and **`CustomerRow.inheritedCertRequired/-Scope`**
   (parts.ts / customers.ts, additive, display-only): what a null column would inherit right now
   (part: customer-default-else-plant; customer: plant). One settings read per list/get call,
   folded per row — this is the "existing seam" that carries the chain to the client, so the part
   page, customer page AND the entry preview all work for viewers without customers.view or a
   settings route, and no new endpoint was needed. The authoritative save-time resolution remains
   `resolveCertSettings`; these never feed a write.

**Raised for adjudication: nothing.** No brand-new route was needed; widening #1 is a body
widening of an existing §9 route, flagged here for the reviewer precisely because §9's text
enumerates only the PATCH side.

## Sibling-pair enumeration

- **Parts + Customers pages**: both in `45eb23e` (one commit, per the brief's rule).
- **Containers grids** (sibling-grid lesson, spec §11): entry grid and hub grid gained the
  `Cust Cont Id` column in the same commit (`1cc83fb`) — the hub half was also a data-loss fix
  (whole-array replace would have blanked stored values).
- Server row-widening pair: `parts.ts` and `customers.ts` share one commit (`ad5c001`) with the
  same `plantCertDefaults()` helper shape in each.

## RED/GREEN evidence (TDD)

RED — 6 failures, all for the right reasons, before any implementation
(`npx vitest run tests/cert-resolution.test.ts tests/shipper-children.test.ts tests/parts.test.ts tests/customers.test.ts`):

```
Tests  6 failed | 108 passed (114)
- cert-resolution: 3 × ZodError (CREATE .strict() rejects certRequired/certScope — not yet accepted)
  ("an omitted override changes nothing" passed from the start, by design: it pins existing behaviour)
- shipper-children: AssertionError: Target cannot be null or undefined (row.orders absent)
- parts: toMatchObject miss (no inheritedCertRequired/inheritedCertScope on the row)
- customers: toMatchObject miss (same pair absent)
```

GREEN — same four files after the three server commits:

```
Test Files  4 passed (4) · Tests  114 passed (114)
```

New tests (7): `createOrder cert override` ×4 (false-beats-true + cert suppressed;
true-beats-false + ORDER cert created; LOAD override stays lazy; omitted = chain, frozen),
`shipper-children` per-order breakdown ×1 (two-order shipment: orderId/number/sequence/qty/
weight/complete per slice; flipping one order's line to complete flips only its flag),
`parts` inherited ×1 (customer default beats plant; part's own override never moves the
inherited display; plant shows through on the list row when the customer inherits),
`customers` inherited ×1 (plant values on get and list beside an explicit false default).
UI has no component-test harness in this repo; UI behaviour was verified in the browser (Step 6)
plus tsc/eslint/build.

## Concerns / notes for the reviewer

1. **`POST /api/orders` widening vs §9's letter** — see "Widened payloads" #1. I believe §6.1's
   "overridable at entry" requires it and the alternative (create-then-PATCH) is broken by the
   eager cert; flagged rather than silent.
2. The orphan warning intentionally ignores VOIDED orphans (voiding is the §4.1 resolution). If
   the reviewer reads §4.1's "flags that cert rather than hiding it" as covering voided certs
   too, it's a two-line change.
3. The load-gap summary/create actions render only when the ORDER's stored pair is
   (required=true, scope=LOAD) — §4.1's gap exists so a REQUIRED by-load cert isn't forgotten;
   an order not requiring certs has no gap to flag. Certs of every scope are always listed
   regardless.
4. The hub `PartOption` mirror gained the four cert fields purely for structural compatibility
   with `computeLineWeight`'s parameter type (imported from the entry page by LinesSection);
   the hub itself never reads them — commented at the type.
5. Entry scope select: while un-overridden it displays the resolved scope; re-selecting the
   same value records it as an explicit override (shown by the reset affordance appearing).
   Harmless — the frozen result is identical — but an operator may notice the label flip from
   "Resolved…" to "overridden".
6. Dev-DB counters advanced by one order number and one shipper number during verification
   (numbers never reused by design); all LANEB fixture rows and their audit entries were removed.
7. `task-17-brief.md` and this report are left untracked for the coordinator's SDD-record commit
   (the Task 16 precedent, a749f30).
