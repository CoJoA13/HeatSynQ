# Task 3 — Turnaround report — review

**Verdict:** Spec Compliant ✅ · Task quality **Approved**

## Spec Compliance
- ✅ Completion date derived from SHIPMENTS, never the audit log (`turnaround.ts:209-238`); population = only `status: "SHIPPED"`, `deletedAt: null` (`:192-197`), INVOICED excluded even when derivable (test `reports-turnaround.test.ts:304-322`).
- ✅ Per-line "complete" mirrors `ship-ledger.ts` (`lineComplete: true`, live shipper `deletedAt: null`, quantity-independent) — `turnaround.ts:210-213` vs `ship-ledger.ts:113-123`.
- ✅ Per-line EARLIEST complete shipDate → order = MAX (full-ship, owner default) — `turnaround.ts:233-238`.
- ✅ REOPENED refinement `shipper: { reversedBy: { none: { deletedAt: null } } }` (`:212`) correct against `shippers.ts reverseShipperInTx` (reversal = live negative shipment, `reversesShipperId` set, `lineComplete: false`, original never voided — `shippers.ts:1654-1663`); `reversedBy` is the verified back-relation of `reverses` (`schema.prisma:1011-1013`).
- ✅ Route gate `reports.view`, thin handlers, 401/403/200; shared parse (`query.ts`); client component holds no `src/server/**` import; pure read (audit count asserted 0).

## Strengths
- The REOPENED test isolates the exclusion honestly: it seeds the original with `lineComplete: true` and does NOT run `reverseShipperInTx`, so step-6b flag-clearing can't mask the bug — only the `reversedBy` filter drops the reversed original (`reports-turnaround.test.ts:355-374`). The RED transcript (2 failed | 17 passed) is internally consistent with the 19-test file under a first-ship/no-exclusion first cut.
- `derivable` skip (`turnaround.ts:237-240`) is defensive-correct: in production a currently-SHIPPED order always has a live complete line, and the reversedBy exclusion can never remove the LAST complete shipment (step 6b already cleared any reversed shipment's flag), so no false skips.
- Whole-day math over `@db.Date` UTC-midnight is exact (`turnaround.ts:81-83`, `business-days.ts:20-41`); in-memory range filter on the derived date is the right call since completion isn't a SQL column.

## Issues
### Critical — none
### Important — none
### Minor (owner-facing note, not a defect)
- **"By part" attributes each order's turnaround to EVERY distinct part on the order** (`turnaround.ts:93-97`, `129-142`): a multi-part order counts once per part group while the headline avg/count stay over distinct orders (`buildTurnaround` returns `orderCount = orders.length`). This is a defensible, clearly-scoped semantic ("avg turnaround among orders containing part X"), documented and pinned (`reports-turnaround.test.ts:99-129`) — flag it to the owner like Task 2's per-part note, not a double-counting bug.
- `partId` filter selects the order population but grouping still slices all parts on those orders (implementer-noted, the backlog precedent) — mildly surprising, consistent with prior reports.

## Reasoning
The load-bearing derivation (shipment-sourced, ledger-mirrored `lineComplete`, per-line-earliest→order-MAX, live-reversal exclusion) is correct and matches the two reference sources; population, filters, grouping, route gates, client/server boundary, and pure-read discipline all hold. The only judgment call is the "by part" semantic, which is defensible and documented.
