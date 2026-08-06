# Task 17 Review — Order hub sections + cert fields (caa79dc..1cc83fb, range 3152512..1cc83fb)

> Filed by the controller verbatim from the task-reviewer's returned text. Review ran 2026-08-05
> against review-task-17.diff. Controller resolved the ⚠️ items same-day: 45eb23e carries parts +
> customers together (sibling pair atomic), 1cc83fb carries BOTH container grids, zero trailers
> across the range.

### Spec Compliance

- ✅ **Hub Certifications section** — every cert listed voided-dimmed (CertificationsSection.tsx:282-299 in diff), LOAD gap "by load · N loads · M certs" with per-load create only when the stored pair is (required, LOAD) (226-265), orphan warning for live load certs whose loadNumber left the current set (229-246), creation restricted to LOAD scope (POST {loadNumber} only, 203-214).
- ✅ **Hub Shipments section** — shipmentsForOrder rows with this order's own <orderNumber>-<sequence> label, packing-list number, ship date, per-order qty/weight, Complete/Partial from lineComplete, carrier, voided tag, /shipping/[id] link (ShipmentsSection.tsx, 528-556).
- ✅ **Overview** — customerJobNo blur-save (698-707), certRequired checkbox + certScope select through the existing optimistic saveOrder PATCH, showing stored/frozen resolved values (729-750), all on editGate (void-locked).
- ✅ **Order entry** — resolved preview derived at render from certRequired ?? inheritedCertRequired OR'd across lines, scope from the lead (998-1014); only explicit overrides stored in the draft and only overrides travel in the create body (?? undefined, 1041-1042) — 2C-3 held; §5.16 disabled-with-reason before a lead is picked (1176-1207); Cust Cont Id in the entry grid (1137-1144).
- ✅ **Part/customer pages** — three-state selects with "Inherit — currently …" labels from server-computed inheritedCert* (IdentitySection.tsx 1272-1293; customers/[id]/page.tsx 89-108).
- ✅ House constraints — no src/server/** imports (local mirrors, 133-141, 455-467); no soft-catch; voidLocked create gate (775); route table unchanged (existing route's body widened); no delegate spies.
- ⚠️→✅ resolved by controller (above): per-commit grouping, trailer absence.

### Adjudication A — POST /api/orders widened for the entry-time cert override

**Faithful gap-fill; accepted.** §6.1 says "overridable at entry"; §6.2 creates the ORDER-scope cert INSIDE saveNewOrder's transaction when the effective pair is (true, ORDER) (orders.ts:722), and updateOrder writes the columns as plain scalars never creating/destroying a cert (orders.ts:1027-1028) — create-then-PATCH cannot suppress an eager cert or prevent one, so the create body is the only place an entry-time override can land. §9's PATCH-only sentence is an enumeration of changed EXISTING routes, and CREATE already carried customerJobNo/customerContainerId from Task 4 outside it. Parity maintained: CREATE's shapes byte-identical to UPDATE's (173-174 vs 965-966); audit records the effective frozen pair via certResolution (633-634, 394), wired per the pre-existing audit-content test; omitted keys ?? resolved — old behavior exactly, pinned by the "omitted changes nothing" test. §9 note recorded on main same-day.

### Adjudication B — customerContainerId data-loss fix

(i) **Bug real**: CONTAINER_ITEM.customerContainerId is .optional() (orders.ts:126); replaceContainers is delete-then-createMany passing it straight through (1213-1220), so an omitted key recreates rows with the DB default "". The hub grid's pre-fix payload omitted the column entirely (316-321, 360) — every hub container save since Task 4 blanked stored values. (ii) **Coverage complete**: the hub grid (fixed — composes and always sends the column, 337-348, 379-383) and the entry create (sends it, 1058-1064) are the only client callers of the replace path. (iii) **No automated regression test** — client-side bug, no component harness; the server's omit-and-default IS Task 4's binding shape, so no server seam can pin the round-trip. Browser-verified manually. → E2E pin for T20. (iv) **Sweep ENUMERATED, not sampled**: OrderContainer (6 columns, all composed), OrderSerial (both), OrderCharge (both), Load (all three), ShipperContainer has no analogous column. No other omit-and-blank column exists.

### Adjudication C — orphan warning flags live orphans only

**Live-only is correct.** §4.1: "the order hub flags that cert rather than hiding it, and a person voids or re-creates it, never the system silently." Voiding is one of the two named human resolutions; a voided orphan is resolved and still LISTED (dimmed, voided tag, 283-292) — nothing hidden. Re-flagging would produce a permanent warning whose only prescribed action is already done.

### Strengths

- Create-override tests exercise consequences, not columns: override-to-false suppresses the eager cert, override-to-true creates it, override-to-LOAD stays lazy (tests/cert-resolution.test.ts 1821-1855) — exactly §6.2's behaviors.
- inheritedCert* as server-computed display companions: one settings read per call, no N+1, no new route; tests prove the part's own override never moves the inherited display.
- ShipperRow.orders widening select-scoped (orderId + lineComplete only — no signature-bytes-class leaks), deterministic order, complete flag guards the empty-lines edge.
- Draft normalization degrades garbage stored scope to null-means-re-derive (scopeOrNull, 932-937).
- Unusually honest report: the §9 tension, the voided-orphan reading, and the re-select-records-override quirk all self-flagged.

### Issues

Critical: none. Important: none.

Minor:
1. No automated regression for the data-loss fix (browser-only) — E2E pin for roadmap item 20 (ContainersSection.tsx:343-348 in diff).
2. Override path's audit content asserted only transitively — one toMatchObject on entry.after in the override tests would close it.
3. Gap summary counts orphans ("by load · 1 load · 2 certs" after a re-split while a create button is offered) — the warning above explains it; "covering" wording would disambiguate.
4. Re-selecting the resolved value records an override (label flips to "overridden"; frozen result identical). Disclosed.

### Assessment

**Spec Compliance:** ✅
**Task quality:** Approved (first pass)
