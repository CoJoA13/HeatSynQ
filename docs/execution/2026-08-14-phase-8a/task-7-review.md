# Task 7 — Comparison scoreboard: review verdict

**Spec Compliance:** ✅ Spec compliant
**Task quality:** Approved

## Evidence

- Invoiced-$ by `invoiceDate` (owner ruling): `scoreboard.ts:568-575` filters `status:"FINALIZED"`,
  `deletedAt:null`, `invoiceDate: window`; window is inclusive `lte` (`dateRange`, :543-549) because
  `@db.Date`. Contrast confirmed against `sales.ts:16-18,229-231` (finalizedAt, half-open, ex-tax).
- RED transcript genuine: test invoice dated Aug-15 / finalized Jul-20 (`reports-scoreboard.test.ts:823-826`);
  a `finalizedAt`-basis copy returns 0 for August (finalizedAt carries time-of-day). Real.
- Credits netted by kind-split in integer cents: `buildScoreboard` (`scoreboard.ts:500-515`); CREDIT total
  negative → invoices/credits/net all fall out of one sum.
- Shipped REUSED not re-derived: `reportScoreboard` calls `reportShipped({from,to})` (`scoreboard.ts:565`)
  and sums its rows; test asserts equality to `reportShipped(window)` (`test:884-889`).
- Orders entered: `prisma.order.count` by `receivedDate`, `deletedAt:null` (`scoreboard.ts:556-561`);
  voided-excluded test at `test:809-813`; pure-read asserted via `auditLog.count()===0` (`test:814`).
- Presets client-safe & correct: `scoreboard-presets.ts` imports only `./business-days` (itself
  client-safe, no src/server); Mon–Sun ISO week + first/last-of-month, UTC date-only; pinned `test:686-706`.
  One `{from,to}` window drives receivedDate + invoiceDate + reportShipped.
- Export required & mirrors: `export/route.ts` uses shared `parseScoreboardFilter` + `reportScoreboard` +
  `toXlsx` with window caption in A1; test reads buffer back and matches figures+window (`test:928-961`).
- Boundary: `Scoreboard.tsx` is `"use client"`, mirrors the type locally, imports only `@/lib/*` — no
  src/server import. Routes thin (authorize→parse→delegate). 401/403/200 pinned on the list route (`test:905-914`).

## Minor
- Export handler test covers 401 + 200 only, not 403 (`test:917-926`) — same `mustCan` gate as the list
  route (which does cover 403), so behavior is sound; only a coverage gap.
