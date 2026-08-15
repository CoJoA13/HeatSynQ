# Task 4 — Sales report — review verdict

**Spec compliance:** ✅ Spec compliant
**Task quality:** Approved

## Verified against the contract

- **SURCHARGE summed, not dropped.** The core filters on line KIND, never partNumber:
  `revenue = lines.filter(l => l.lineKind !== "TAX")` (sales.ts:116). Enum is
  PART/OPERATION/SURCHARGE/FREIGHT/CHARGE/CERT/TAX (schema.prisma:1221) — a `!== "TAX"`
  filter catches every non-TAX kind, present and future. SURCHARGE carries a blank
  partNumber (pricing.ts:277 `blank("SURCHARGE")`), routed to the single `"(no part)"`
  bucket (sales.ts:101); sliced==unsliced total asserted (reports-sales.test.ts:105,136,271).
- **Reconciliation is real, not curve-fit.** Test sums `Σ(credit − debit)` over postings
  with `glAccountId ∉ {ar, tax}` and compares to `sales.total`
  (reports-sales.test.ts:394-397). salesJournal credits revenue for INVOICE, debits it for
  CREDIT (gl-mapping.ts:55) — sign correct: 100+15+200−30 = 285 = report total. Surcharge
  posts to a DISTINCT revenue account (surRev), so it is genuinely on the revenue side, and
  the RED transcript (301 vs 285, tax-inclusive) proves the identity fails when the report is
  wrong. Fixture is invoices/credits only with fresh truncate → no prior GlPosting → delta =
  full journal (holds). Both sides derive from the SAME non-TAX InvoiceLine snapshots; not
  tautological.
- **Frozen snapshot, no live join.** The select pulls InvoiceLine.{kind,partNumber,partName,
  amount} only (sales.ts:236-238) — no Part/StepCode join. Rename-after-finalize test asserts
  the report is unchanged and auditLog.count==0 (reports-sales.test.ts:224-241).
- **finalizedAt half-open [from, nextDay).** `gte from` / `lt addDays(to,1)` (sales.ts:196),
  UTC-based (business-days formatDateOnly/addDays use getUTC*). Last-second-of-July boundary
  test passes (reports-sales.test.ts:287-306); invoiceDate is never read.
- **Credits net.** createCredit copies every source line with `amount: negateMoney(l.amount)`,
  kind and partNumber preserved (invoices.ts:1449-1464); summing signed amounts nets them
  (reports-sales.test.ts:274-285).
- **No part FILTER, part is groupBy-only.** Correctly scoped and documented (query.ts,
  SalesReport.tsx:10-12) — a live-part filter would need the forbidden live join.
- **Boundary/gate/purity.** Client component holds only typed state, no `src/server/**`
  import (SalesReport.tsx:19-31); shared `parseSalesFilter` feeds both routes; route gates
  401/403/200 with ctx (reports-sales.test.ts:405-427); single findMany, no claim/audit.
- **documentNumberOf** replicates invoices.ts:149 verbatim (leaf discipline, correct).

## Minor (nice to have)

- Export "Type" column emits raw enum "INVOICE"/"CREDIT" (export/route.ts DETAIL_COLUMNS)
  while the screen shows the friendly label (SalesReport.tsx:47). Cosmetic xlsx inconsistency.
- `getSetting("invoice_number_prefix")` is read even for grouped views that never surface a
  document number (sales.ts:221). Negligible.
- No explicit test for the customerId filter narrowing the population (coverage wish).

## Assessment
No correctness, concurrency, or data-integrity defect found. SURCHARGE handling and the GL
reconciliation — the two the plan flagged — are both correct and genuinely coupled. Approved.
