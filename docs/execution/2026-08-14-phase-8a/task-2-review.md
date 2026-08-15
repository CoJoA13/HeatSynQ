# Task 2 — Shipped report — reviewer verdict

## Spec Compliance: ✅ (spec §4.2)

New `shipDate`-windowed aggregation over `ShipperLine → shipperOrder.shipper` (`shipped.ts:694-720`);
does NOT call `shippedTotals`; reuses only the live-filter discipline (`shipper.deletedAt: null`,
`shipped.ts:697-698`). Reversals net into their own `shipDate` window; released rows counted via
snapshot; pure read; group by customer/part/ship-month/day; filter shipDate+customer+part. All match §4.2.

## Task quality: Approved

Only Minor tracking items; every correctness/concurrency/boundary check passes.

### Strengths
- `shippedTotals` genuinely not reused: brand-new findMany, live-filter (`deletedAt: null`) reached
  through `shipperOrder.shipper` only (`shipped.ts:696-704`). Confirmed `shippedTotals` skips released
  rows (`ship-ledger.ts:56`) — the report deliberately does not.
- Reversal netting summed with no special case; pinned by pure test (`reports-shipped.test.ts:876-884`)
  AND DB test (`:956-979`) asserting June qty=10/weight=5, July qty=-10/weight=-5, net 0, and
  `auditLog.count()===0`.
- Released rows counted: dedicated detail test asserts qty 7 / weight 4 / partNumber "REL-SNAP"
  (`:981-997`), and by-part grouping test asserts the released row surfaces under snapshot number
  (`:999-1015`).
- Weight aggregated in integer hundredths (`shipped.ts:527,628`) — no float drift; live-join-first
  part identity with snapshot fallback (`shipped.ts:734-735`), `??` preserving a blank live name.
- Pure read (no claim/tx/audit/Serializable) per README; inclusive `lte` correct on the UTC-midnight
  `@db.Date` shipDate (`shipped.ts:663-669`, `parseDateOnly` UTC-midnight).
- Group key `customerId + " " + partNumber` collision-safe: cuid customerId contains no space, so the
  first space is always the delimiter (`shipped.ts:576-586`).
- Client boundary respected — `ShippedReport.tsx` mirrors row types locally, imports only `@/lib/**`
  (`:220-232`); shared `parseShippedFilter` feeds both routes; route gates 401/403/200 tested with ctx
  (`:1114-1136`); page.tsx is a trivial wrapper fetching no server data.

### Minor (Nice to Have)
1. **partId-filter vs group-by-part asymmetry.** A released row (no live `partId`) is counted in the
   default by-part grouping under its snapshot number (`shipped.ts:585`, test `:999-1015`), but the
   `partId` filter matches only the live `orderLine.partId` (`shipped.ts:703`), so drilling into that
   part hides the released material the grouping showed. Documented (`shipped.ts:690-693`) and
   defensible (a released row has no verifiable part linkage), and spec §4.2 is silent on it — but a
   user seeing "part X: 16" in the grouping then filtering to X and seeing 10 is a surprise. Worth an
   owner/§12 note rather than a silent behavior.
2. **TDD RED evidence thin.** The report asserts tests-first but the only concrete RED cited is a
   stray null-byte test-authoring artifact (explicitly "not a logic bug") — no RED run is shown for
   the reversal-window or released-row logic tests against an absent implementation. Behavior is
   well-pinned GREEN regardless; this is a report-contract gap, not a code defect.
3. **Cosmetic:** a reversal-only month counts its reversal shipper in `shipmentCount` (distinct
   shippers, per the spec's own definition), and the client detail-total re-sums float weights before
   `.toFixed(2)` (`ShippedReport.tsx:333`) — display-only, export dumps per-row group values.
