# Task 14b Review — Shipment creation flow (a78c1a2 + 2967163, range e8869dd..2967163)

> Filed by the controller verbatim from the task-reviewer's returned text (reviewer runs
> read-only). Review ran 2026-08-05 against review-task-14b.diff.

### Spec Compliance

- ✅ **Single atomic nested POST via `createShipper`** — `NewShipment.tsx` builds the whole graph (customer, ship-to, dates, carrier/freight, per-order lines/containers/serials) and submits once to `POST /api/shippers` (diff L1437-1496; `buildBody`/`handleSave`). No "create empty then edit" anywhere; nothing is allocated until save.
- ✅ **Nonce minted at mount, stable across retries** — `useState(() => crypto.randomUUID())` (`clientRequestId`), included in every `buildBody()`. Failed save → `setError`, no remount, no re-mint; next click reuses the same state-held nonce. Within one attempt, `submitWithConflictRetry` (src/lib/idempotent-save.ts:52-61) re-submits the same body reference on 409. Not theater.
- ✅ **Deduped path navigates to the FIRST shipment** — shippers.ts:613 returns `{ shipper: readShipperDetail(prisma, existing.id), warnings: [], deduped: true }`; client `router.push`es to the existing shipment.
- ✅ **Credit-hold banner matches server enforcement byte-for-byte** — shippers.ts:444-453: refusal string `` `${code} · ${name} is on credit hold — see /customers/${id} to lift it` `` (448), reason required (451). Client mirrors both; `ErrorText`'s regex over the server string renders even a stale-client 400 with a live link. Route passes `canOverrideCreditHold: canDo(user, "override_credit_hold")`.
- ✅ **Non-holder: refusal, no dead-end controls (§5.16)** — `holdBlocked` disables Save with a title naming the missing action; reason field renders only when `overrideGate.allowed`; without-override branch renders the explanatory line instead.
- ✅ **§5.7 warnings rendered, not raced past** — on warnings the render REPLACES the entire form with the warnings panel + explicit "Go to shipment" button; the warning cannot unmount until the operator acts and a second Save is structurally impossible.
- ✅ **Remainder prefill via one derivation** — `prefillLineRow` → `shipRemainder(ordered, shipped)` (ShipmentGrids.tsx); shipped from `OrderDetail.orderLineShippedToDate`, computed by the same `shippedTotals` call (orders.ts `readDetail`, dense with real 0/0). Containers at order count, serials all-in — each with a structural SIBLING-SPLIT NOTE.
- ✅ **No new route; §9 unchanged** — no new route.ts files in the diff; the seam is a widened existing payload (efde514 precedent).
- ✅ House rules: no src/server/** imports in client files (local DTO mirrors verified field-by-field against orders.ts:34-48); `import type { OrderLineShippedToDate }` type-only, erased; no vi.spyOn; conventional commits; TDD RED/GREEN evidence present.
- ⚠️ Cannot verify from diff: browser-verification specifics (refused clerk, blank-reason refusal, audit entry content, 6/15 prefill, deduped replay) — every claim is consistent with traced code paths (refusal title, validate()'s message, reason entering audit payload at shippers.ts:192, shipRemainder(10,4)=6, dedup at :613); screenshots untracked. T20 E2E is the durable recapture, as with Task 14.

### Adjudication A — the seam contradiction

**Conclusion: right seam; accept with the cost noted.**

- Cost (i), blast radius: ONE `shipperLine.findMany` with `orderLineId: { in: [...] }` (ship-ledger.ts:35-38), backed by `@@index([orderLineId])` (schema.prisma:947), three-column select over a handful of lines. Single, batched, indexed — negligible per order GET/mutation. Task 14's rejection was written for the EDIT page, where a fresher transport already existed; for the create page no such transport exists, so the cost now buys something.
- Cost (ii), staleness: does NOT bite the create page the way it would have bitten edit. On edit, the same page's own saves mutate the ledger while the separately-fetched catalog sits still (self-inflicted staleness). On create, nothing mutates the ledger before the one POST; the figure is fetched at order-add and can only drift via a concurrent shipper — exactly the race §5.7's server-computed post-save warnings authoritatively close.
- Two sources on the edit page? No. The edit page's `OrderDetailLite` slice does not read the new field — it sources shipped-to-date exclusively from the shipper GET. One derivation (`shippedTotals`), two transports, each page reading exactly one; the arithmetic cannot diverge. The order-detail copy rides unused in the edit page's catalog payload — dead weight, not a divergence risk.

### Adjudication B — the shared-grids refactor

**Conclusion: reviewed edit-page behavior survives intact.**

- LinesGrid/ContainersGrid/SerialsGrid keep `useBulkGrid` (compose, updateExisting/updateAdded, orphan warning); save() bulk-PUT bodies byte-identical; per-grid Save via the `footer` slot with the same `!gate.allowed || !dirty` disable.
- Remainder prefill on both addPicked and addAllRemaining lives once in `LinesGridView` (ShipmentGrids.tsx:174-183) — the efde514 arithmetic exactly; `addRows([prefillLineRow(...)])` is a batch-of-one, equivalent.
- Shipped-to-date candidate column preserved (dense ledger overlay passed into the view).
- Every grid control keys disabled/title off the passed `gate`; the edit page passes `editGate` unchanged — voided/permission lockdown flows through exactly as reviewed.
- Both SIBLING-SPLIT NOTEs moved into ShipmentGrids.tsx (containers :277-284, serials :387-391), single-copy contract documented at the top of both files. The serials note's wording is more accurate than the original.
- The useBulkGrid deviation on the create page is justified: hooks can't run in a loop over a variable order count, the overlay model has no server rows here, and orders/new parent-owned draft state is the used precedent. Disclosed, honest, correct.

### Strengths

- Idempotency chain airtight end to end: mount-minted nonce → build-once body → by-reference 409 retry → server dedup returning the first shipment, with design reasons written at each link.
- Seam widening minimal and self-documenting: 20 lines in orders.ts, dense-ledger comment citing the sparse-map hazard, type-only import annotated against the module cycle, RED/GREEN tests asserting content not existence.
- Credit-hold UX genuinely two-sided per §5.16; `ErrorText` turning the server's refusal tail into a live link is a nice stale-client fallback.
- §5.13 honored on failure; the warnings panel destroying the form kills double-submit-from-a-kept-form by construction.

### Issues

Critical: none. Important: none.

Minor:
1. **Serials prefill over-includes on repeat shipments**: second partial shipment prefills in every order serial including ones that traveled on shipment 1 — no §5.7 warning covers serial re-shipment, and the fact isn't client-readable today (edit page shares the limitation; here ergonomics slightly worse — remove vs add). Disclosed, visible, structurally noted. Acceptable-as-parity; a per-serial shipped fact is whole-branch backlog material.
2. **Report concern 2 overstates create-page gating**: header inputs (ship date, carrier, route, comments, freight fields) are never disabled for a user lacking shipping.create — Save is disabled with the reason so no dead end, but "every control disabled" is not what the code does.
3. **State-disabled buttons without §5.16 titles**: "Add order" (!addChoice || addingOrder), "Save shipment" while saving, "Remove order" ungated. Same class as the T14 minors — fold into whole-branch review.
4. `savedShipment.warnings` keyed by array index — harmless static list, codebase generally keys by content.

### Assessment

**Spec Compliance:** ✅ (one ⚠️ unverifiable-from-diff, corroborated by code traces)
**Task quality:** Approved (first pass)
