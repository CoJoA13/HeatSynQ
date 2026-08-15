# Task 1 — Backlog report: review verdict

**Spec Compliance:** ✅ Spec compliant
**Task quality:** Approved

## Spec Compliance
- Population pinned correctly — `BACKLOG_STATUSES = ["OPEN","PARTIAL_SHIPPED","REOPENED"]`
  (`erp/src/server/reports/backlog.ts:30`), applied as `status: { in }` under `deletedAt: null`
  on the Order (`backlog.ts:193-194`). REOPENED included; SHIPPED/INVOICED/voided excluded.
  Matches the 5-value `OrderStatus` enum (`prisma/schema.prisma:629-635`).
- Amounts = ORDERED — `l.qty` / `l.weight.toNumber()` straight through (`backlog.ts:222-223`);
  no ship-ledger join anywhere.
- Pure read — single `prisma.orderLine.findMany` (`backlog.ts:190`); no claim/tx/audit/Serializable.
  Test asserts `auditLog.count() === 0` (`tests/reports-backlog.test.ts:182`).
- Client/server boundary — `BacklogReport.tsx` is `"use client"` with local row-type mirrors,
  imports only `@/lib/*`; both routes import the single `parseBacklogFilter`.
- Determinism — `today` injected into the pure core; wrapper uses `formatDateOnly(todayDateOnly())`;
  `parseDateOnly` is UTC-midnight, so day math is DST-safe. Group/detail sorts stable.
- Soft-delete — `deletedAt: null`; `findMany` (no `findUnique`). OrderLine is not soft-deletable.
- Registry entry matches the brief verbatim (`report-registry.ts`).
- Route gate 401/403/200 tested with ctx (`tests/reports-backlog.test.ts:234-245`).

## Minor
1. Report shows only GREEN (14 passed); no RED transcript, though the house contract asks for
   RED-then-GREEN. Tests are structured to genuinely RED-verify the load-bearing choices.
2. Detail-row React key `${orderId}-${partNumber}` can collide when one order has two lines on the
   same part (`OrderLine` allows duplicate `partId`; unique is `[orderId, position]`); the row type
   carries no line id.
3. The ordered-vs-remaining choice is not RED-verified against a real shipment (no `ShipperLine`
   seeded) — correct only because no ship join exists. Coverage wish.

No Critical/Important findings.
