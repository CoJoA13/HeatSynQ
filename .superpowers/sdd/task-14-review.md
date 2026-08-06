# Task 14 Review — Shipment detail page (e54684c)

> Filed by the controller verbatim from the task-reviewer's returned text (the reviewer runs
> read-only and could not write this file itself). Review ran 2026-08-05 against package
> `review-task-14.diff` (e593d79..e54684c), brief `task-14-brief.md`, and the reconstructed
> stand-in report `task-14-report.md`.

### Spec Compliance

- ✅ Step 1 header — all fields present: ship-to selector of live SHIP_TO addresses (`ShipmentDetail.tsx` diff L278–283, 519–524; active-only confirmed at `erp/src/server/customer-addresses.ts:34`), ship date L528, carrier L534 (with inactive-carrier fallback option L538–540), route L546, comments L553, freight block complete (bill L564, amount L570, terms L578, class L586, description L593, package count prefilled from container sum L458–459/L600, pro no L608, SCAC L615), `shippingNotes` read-only banner L507–511.
- ❌ Step 2 "prefilled to the remainder" — newly added lines prefill to **full ordered qty/weight**, not `ordered − shippedToDate` (`ShipmentOrderPanel.tsx` diff L770, L775: `qty: String(c.qty), weight: String(c.weight)`; self-acknowledged deviation in comment L733–737). See Important #1.
- ✅ Step 2 three grids on `useBulkGrid`, one panel per `ShipperOrderDetail` headed by `label` (`ShipmentOrderPanel.tsx` L1142–1143); sibling-split honored — the three grids are structurally identical (patch/remove/addPicked/addAllRemaining/save, same disabled/title/aria patterns) and colocated in one file (L692–699).
- ✅ Step 3 actions — Add order picker of the customer's OPEN/PARTIAL_SHIPPED orders minus those already on the shipment (L297–305; comma-joined `status=` param confirmed supported at `erp/src/app/api/orders/query.ts:31–48`, and `BoardRow` carries `poNumber`, `orders.ts:76`), Remove order L417–426/L1147, Print all-tickets/BOL/this-order's-ticket disabled with §5.16 tooltips naming Tasks 18–19 (L630–639, L1129, L1165–1171), cert checkbox pre-ticked L1170, stored-documents list L164–203/L676–679, `HistoryPanel entity="shipper"` L682, Void with reason prompt L428–454 (empty reason refused L438).
- ✅ Step 4 banners — credit-hold with customer link L495–500 (informational is correct: the only server-side credit-hold gate is `createShipper`, `erp/src/server/shippers.ts:410–419`; no mutation this page calls checks it), §5.7 warnings L501–505, voided banner L485–489.
- ✅ Step 5 remount — `<ShipmentDetail key={id} id={id} />` (`page.tsx` diff L1198).
- ✅ §5.7 warnings consumed from the GET, not only after mutations — `load()` reads the `{shipper, warnings}` shape and `setWarnings(res.warnings)` (L240–241), so the Task 11/issue-#41 wrapper is actually used on page load.
- ✅ §5.13 — rollback-then-report: `await load().catch(() => {}); setError(...)` in that order (L371–373), with the comment explaining why the order matters.
- ✅ Client/server boundary — no `src/server/**` import in any of the three client files; local type mirrors instead (L68–73).
- ✅ Route conventions on the new endpoint — `handle` wrapper, `mustCan(requireUser(), "shipping", "view")` first line (`documents/route.ts` diff L36–38); 404 for unknown shipper inherited from the service (`documents.ts:176–177`).
- ⚠️ Cannot verify from diff: Step 6 browser verification and screenshots for the demo doc — the report is a reconstructed stand-in; no corroboration exists. Controller should confirm the screenshots landed anywhere.
- ⚠️ Cannot verify from diff: TDD RED→GREEN evidence and the "1279 tests, gates clean" claim — the implementer report contract is unmet through no fault attributable from the diff; the one new test is plausible-as-TDD but unproven.

### Strengths

- The mutation-ordering ticket (`useMutationGate`, L234–254) shared by `load()` and every whole-shipper mutation is the right concurrency shape for a page where every action replaces the whole record, and the catalog fetch has its own `useLatest` guard (L311–324).
- The blur-save guard (L381–387) prevents no-op PATCH/audit spam on tab-through — a real audit-hygiene win.
- The three grids are genuinely parallel implementations, making the sibling-split rule trivially auditable.
- `commitPackageCount` client-validates to a real integer before sending (L392–398) because the server schema is `z.number().int()` — a mismatch that would otherwise surface as a raw Zod error.
- Supplementary-fetch failures accumulate in a separate `loadError` banner (L214–218) instead of being silently erased by the next successful save.

### Issues

#### Critical (Must Fix)

None.

#### Important (Should Fix)

1. **"Prefilled to the remainder" not implemented for the partially-shipped case** — brief Step 2's exact value is binding. Adding a line to the grid prefills ship-now to the full ordered qty/weight (`ShipmentOrderPanel.tsx` diff L770, L775), and shipped-to-date renders "—" for a not-yet-saved row (L757, L828), so when the line was partially shipped on a prior shipment the operator gets an over-shipping default with no on-screen number to correct it against, discovering the problem only via the post-save §5.7 warning. The in-code rationale (no client-callable ship-ledger endpoint, L733–737) is a real constraint but is the implementer's claim, not a waiver — either the shipper GET/order catalog should carry shipped-to-date for candidate lines, or the owner should ratify the deviation.

#### Minor (Nice to Have)

2. **§5.16 gaps on state-disabled buttons** — when the edit gate allows, `title={editGate.title}` is `undefined`, so "Save lines/containers/serials" disabled-because-not-dirty (L872, L998, L1116), "Add" disabled-because-nothing-picked (L864, L990, L1108), and "Add order" disabled-because-no-choice (L655) carry no tooltip naming why. The empty-candidates case does explain itself via option text (L650, L861, L987, L1105). Per the sibling-split rule, a fix must land on all three grids at once.
3. **Add-order candidates fetch has no staleness guard** — the effect at L297–305 refires on `onShipmentOrderIds` changes with no `useLatest` ticket; a slow older response can transiently repopulate the picker with an order just added (self-correcting only because the server rejects the duplicate add).
4. **New-route test coverage lacks a 404 case** — `tests/shipper-routes.test.ts` diff L1250–1275 covers 401/403/200-empty/lists-one-doc, but not the unknown-shipper 404 the service throws (`documents.ts:176–177`). No negative kind-leak test either, though that is structurally impossible (see adjudication A), so 404 is the only real gap. Otherwise adequate for a read-only endpoint.
5. **Voided banner's fallback text can point nowhere useful** — "see History for the reason" (L487) when the viewer lacks `admin.view`, but `HistoryPanel` is presumably equally gated for them. Order-hub precedent; polish only.

### Adjudication A — `GET /api/shippers/[id]/documents` (route not in spec §9's table)

**Verdict: faithful gap-fill; accept, and record it in §9's route table at whole-branch review.**

Evidence:
- Conventions: `handle` wrapper and `mustCan(requireUser(), "shipping", "view")` as the first line (diff L36–38); metadata-only via the service's `DOCUMENT_SELECT` (never `fileData`); 404 for a missing shipper comes from `listDocumentsForShipper` itself (`documents.ts:176–177`), and its `findFirst({ where: { id } })` deliberately includes voided shippers — correct, since voided shipments keep documents listed forever.
- §8 per-kind ruling: the route's no-filter claim is sound **by construction**, not just by comment. `ownerColumns` (`documents.ts:63–77`) sets `shipperId: null` for TRAVELER and CERT, backed by a DB CHECK, so `where: { shipperId }` can only ever return SHIPPER/BOL rows — and `AREA_FOR_KIND` (`documents.ts:30–32`) maps both to `shipping`, the exact area the route gates on. The per-kind filter is therefore vacuously satisfied: no kind the caller couldn't open can appear.
- Divergence from the Task 11 orders equivalent (`erp/src/app/api/orders/[id]/documents/route.ts`): the orders route passes the session user into `listDocumentsForOrder` because its union crosses areas (TRAVELER/SHIPPER/BOL/CERT); the shipper route doesn't pass a viewer because there is no cross-area kind to filter. Both routes 403 without their base area first (the orders route also `mustCan`s `orders.view` before filtering), so the empty-the-group-not-403 ruling applies identically: it governs kinds *within* an authorized list, and here the kind set collapses to the gating area. No behavioural divergence found.
- Residual note: nothing in the route pins this invariant — if a future kind ever carries `shipperId` under a non-shipping area, `listDocumentsForShipper` silently becomes a leak. `AREA_FOR_KIND`'s `Record<DocumentKind, Area>` totality makes that a reviewable event, not a silent one. A test asserting the no-leak property would harden it (folded into Minor #4).

### Adjudication B — does the voided state lock every control?

**Verdict: from the code, yes — no control escapes.** The browser claim itself stays unverifiable (⚠️ above), but the mechanism holds:

- `voidLocked` forces `editGate` to `{ allowed: false, disabled: true, title: "Shipment is voided" }` (L160–162, L260–261), and `Gate` is exactly `{ allowed, disabled, title }` (`erp/src/lib/permission-ui.ts:5`), so both the `.allowed` and `.disabled` consumers lock.
- Enumeration: header selects/date/checkbox use `disabled` (L519, L528, L534, L564, L578); every text input/textarea uses `readOnly` (L546, L553, L570, L586, L593, L600, L608, L615) — the correct attribute per control type, since `readOnly` is a no-op on checkboxes/selects and they used `disabled` there. Void button → "Already voided" (L262–263, L476). Add-order select+button → `editGate.disabled` (L647, L655). Per panel: Remove order (L1147), all grid qty/weight/count inputs and checkboxes (L830, L836, L842, L967, L1086), all row Remove buttons (L847, L973, L1091), all pickers/Add/Add-all/Save (L859–873, L985–999, L1103–1117) key on `!editGate.allowed` or `editGate.disabled`. Print controls are unconditionally disabled (L631, L635, L1165, L1170). Documents links and HistoryPanel are reads. `onBlurSave`/`onChange` handlers on the readOnly inputs are unreachable because the value can't change.
- The one action the void does not disable is the void prompt's own path when not yet voided — by design.

### Assessment

**Task quality:** Needs fixes

**Reasoning:** The screen is a strong, precedent-faithful implementation — warnings-on-load, mutation ordering, §5.12 remount, and the voided lock are all correct — but the brief's binding "prefilled to the remainder" is not what ships for partially-shipped lines (an over-shipping default with no visible remainder), and that plus the unverifiable browser/TDD evidence means one fix round (or an explicit owner ratification of the prefill deviation) is needed before this task can be trusted.

**Verdicts:** Spec Compliance ❌ (one missed requirement, two ⚠️ unverifiable); Task quality: Needs fixes. Findings: 0 Critical, 1 Important, 4 Minor.
