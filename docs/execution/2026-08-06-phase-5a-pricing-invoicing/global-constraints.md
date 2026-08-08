## Phase 5A Global Constraints

> **Why this file exists (2026-08-07).** The constraints file at `.superpowers/sdd/global-constraints.md`
> is **Phase 4's**, left at the old flat ledger path and never updated for 5A — its owner-rulings
> bullet says "void only, **no reversing shipments, `REOPENED` stays unreachable**," which is FALSE
> for Phase 5A. The 5A spec (§5.2) makes `INVOICED` and `REOPENED` **reachable and invoice-owned**,
> and Task 15 **is** the reversing shipment. The durable *technical* constraints in that Phase 4
> file are still accurate and are restated here; the owner rulings are replaced with 5A's. **Use
> this file for Tasks 13–20; do not cite the Phase 4 one.** No harm reached Tasks 1–12 — none
> touched reversing shipments or the invoice-owned statuses, and each task's brief carried the
> correct phase requirements — but Task 15 would have been reviewed against a rule 5A repeals.

### Durable technical constraints (unchanged across phases)

- All commands run from `erp/`. Gates after every task: `npm test`, `npx tsc --noEmit`,
  `npx eslint src tests` (plus `npm run build` before review rounds), and `npm run test:e2e` when a
  change touches any UI/flow. Node 26.
- TDD per task: failing test → implement → pass → commit. Conventional commits, **no attribution
  trailers** (a PreToolUse hook blocks them).
- Every mutation through `auditedCreate`/`auditedUpdate`/`auditedSoftDelete`, **`tx` REQUIRED**.
  Canonical nesting: `withDbErrors` → `prisma.$transaction` → `audited*` → writes on `tx`.
  **This phase adds no new audit exceptions.** Adding an auditable entity means extending BOTH
  `AuditableModel` and `SNAPSHOT_INCLUDE`, with a deterministic `orderBy` on every collection.
- **Row locks, never isolation levels, guard cross-transaction invariants.** Claim the row
  (`claimOrder`/`claimOrdersInOrder`, `order-locks.ts`) before reading the state you act on.
  Serializable is the FK-writer pattern (`assertRefExists(kind, id, tx)`), **never** what protects
  a claim. **The guarded state must live on, or be locked with, the claimed row** — a Serializable
  snapshot fixed before the claim re-reads stale state (the Phase 4 print-vs-void lesson).
- Deletion is always soft (`deletedAt`). Never `findUnique`/`upsert`/`update`/`delete` on a
  partial-unique column; use `findFirst({ where: { …, deletedAt: null } })`.
- Client components never import from `src/server/**`; shared pure code goes in `src/lib/`.
- Route handlers: `handle(async (req, { params }) => …)`; `mustCan(requireUser(), area, action)`
  first (or `mustDo` for special actions); `assertRecord(body)` before key checks; DELETE bodies
  read via `req.json().catch(() => null)`. Route tests pass ctx: `{ params: Promise.resolve({ id }) }`.
- Expected failures are `HttpError(400|403|404, message)`, field-anchored, and **a refusal must
  name what is actually blocking it**.
- Money `Decimal(12,2)` via `decimalField(12, 2, …)`; unit/break prices `Decimal(12,4)`; rates
  `Decimal(9,6)`; quantities `z.number().int()`. Check each column against `prisma/schema.prisma`.
- Tests share one DB: `truncateAll()` in `beforeEach`, `signInWith(...)`, `fileParallelism: false`.
  Assert audit **content** (real before/after diffs). **Never `vi.spyOn` a Prisma model delegate.**
- Concurrency tests: run the competing caller at Read Committed so only the row lock, not SSI, can
  serialize the two. A concurrency test that passes with both sides Serializable proves nothing;
  verify it goes RED with the guard removed, or state in the title that the property is
  undiscriminable at this layer.
- `npx prisma migrate dev` refuses without a TTY — use the `/create-migration` recipe (migrate diff
  → hand-write SQL → `migrate deploy` to BOTH `erp` and `erp_test` → `prisma generate`).
- `renderPdf` output is not byte-deterministic across calls; compare STORED bytes on reprint with
  `Buffer.compare`, two fresh renders by pinned content only.

### Owner rulings binding THIS phase (5A spec §3, §5.2, §5.6)

- **Print-only; no email anywhere.**
- **One invoice per order, billed once, when the order is fully `SHIPPED`.** Grouping is
  **superseded** — no per-shipper/per-order/per-PO grouping machinery, no setting. A five-order
  truck produces five invoices (spec ruling 5).
- **`INVOICED` and `REOPENED` are reachable and invoice-owned** (§5.2). `OPEN`/`PARTIAL_SHIPPED`/
  `SHIPPED` stay ship-derived from the human line-complete flags. Finalizing an INVOICE writes
  `INVOICED`; a reversing shipment against an order with a finalized invoice writes `REOPENED`;
  unlock returns the order to its ship-derived value via `recomputeOrderStatus`, which **skips an
  order while it is in an invoice-owned state** (same shape as its voided-order skip). This is
  status-*ownership*, not arithmetic status — the ship-derived states remain flag-driven.
- **The reversing shipment reuses `void_shipper` and `claimOrdersInOrder`** — no second dangerous
  action, no new locking path. Its lines may carry negative `qty`/`weight`; `shippedTotals` already
  sums `qty`, so negatives net down. `Shipper` gains `reversesShipperId` + self-relation.
- **Invoice lifecycle: draft → finalized → unlocked.** Draft edits (update header, replace lines,
  recalculate, discard) apply to DRAFT only; a FINALIZED invoice is immutable except via unlock,
  which returns it to DRAFT. Finalize freezes the current lines (re-prices nothing) and is refused
  while any line has `needsPrice`.
- **`change_prices` gates money-changing invoice edits** (line replace, recalculate, credit) at the
  route layer — the service layer does not gate it, so the route is the only backstop.
- **Credits and the reversing shipment** are the corrections for an already-finalized invoice
  (unlock is the other); do not add a reversing-invoice or edit-after-finalize path.
- **Multi-order freight over-bill is owner-DEFERRED** (2026-08-07): the shop bills no freight, so
  the N× over-bill on a multi-order billable-freight truck is latent. Do not invent a split; the
  code follows spec §5's freight rule as written. Filed in HANDOFF §6.
- `Terms` is a name with no day count — 5A adds no `netDays`/`dueDate` (no dangling columns); 5B
  owns those.
