# Phase 5B — binding Global Constraints (reviewer attention lens)

Copied verbatim from the plan's Global Constraints section and the spec's owner rulings (§3). These
are the project-specific requirements every task must honor; the reviewer template already carries
the generic process rules (YAGNI, test hygiene, review method).

## From the plan's Global Constraints

- All commands run from `erp/`. Quality gates after every task: `npm test`, `npx tsc --noEmit`, `npx eslint src tests` (plus `npm run build` before review rounds) — or `/gates`. Node 26; `npm install`'s five skipped-install-scripts warning is expected and must NOT be "fixed".
- TDD per task: failing test → implement → pass → commit. Conventional commits, **no attribution trailers** (a PreToolUse hook blocks them). Attribution goes in the PR body.
- Every mutation through `auditedCreate` / `auditedUpdate` / `auditedSoftDelete` — `tx` is REQUIRED. Canonical nesting: `withDbErrors` → `prisma.$transaction` → `audited*` → writes on `tx`. This phase adds three auditable models (`ReceiptBatch`, `Payment`, `Application`) and **no audit exceptions**. **Assert audit content (real diffs), not just that entries exist.**
- **Row locks, never isolation levels, guard cross-transaction invariants.** Every application claims the target invoice through 5A's discipline: `claimOrder(tx, orderId)` then `SELECT "id" FROM "Invoice" WHERE "id" = $1 FOR UPDATE`, before reading the open balance it acts on. A payment settling several invoices claims them all through **one sorted statement** — `claimOrdersInOrder(tx, orderIds)` over the orders behind the invoices, deduplicated and ascending — never a per-invoice loop. A credit application also `FOR UPDATE`s the credit's own row, uniformly after the order claims. Transactions run Serializable because they assign registered FKs via `assertRefExists(kind, id, tx)` — **the FK-writer pattern, NOT what protects the claim.** Never present isolation as the lock.
- Never `findUnique` / `upsert` / `update` / `delete` keyed on a partial-unique column; use `findFirst({ where: { …, deletedAt: null } })`. Partial `@@unique(...)` attributes stay on **ONE line**. `ReceiptBatch.batchNumber` is deliberately plain `@unique` (allocation-only, never reissued — the `Invoice.creditNumber` precedent); its documented sweep exemption is added in Task 1.
- Migrations by hand (no TTY): `npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script`, read IN FULL, hand-write `prisma/migrations/<timestamp>_<name>/migration.sql`, then `npx prisma migrate deploy` **and** the `erp_test` deploy, then `npx prisma generate`. **Prisma has no `CHECK` syntax** — `Application_source_check` and the `StoredDocument` kind→owner extension are hand-written into the migration SQL (the 5A `StoredDocument_kind_owner_check` precedent).
- Client components never import from `src/server/**`; shared pure code goes in `src/lib/`.
- Route handlers: `handle(async (req, { params }) => …)`; first line `mustCan(requireUser(), "receivables", action)` (or `mustDo(requireUser(), "write_off")` for write-offs). **`requireUser()` takes no arguments.** `assertRecord(body)` before key checks; DELETE/void reasons via `reasonFromBody`. Route tests pass ctx: `handler(request, { params: Promise.resolve({ id }) })`.
- Expected failures are `HttpError(400|403|404, message)`, field-anchored. Dates cross the wire as `"yyyy-mm-dd"` strings; use `parseDateOnly` / `formatDateOnly` / `todayDateOnly` from `src/lib/business-days.ts` and store `Date` in `@db.Date` columns.
- Tests share one database: `truncateAll()` in `beforeEach`, `signInWith(permissions)`. `fileParallelism: false` — do not parallelize.
- **A concurrency test that passes is not evidence.** Verify each by deleting the guard and watching it go red, and pin the **competing** caller to Read Committed — two Serializable transactions are ordered by SSI whether or not your lock exists (Phase 4 lesson 1).
- **Never `vi.spyOn` a Prisma model delegate** — `mockRestore()` corrupts the shared singleton for the rest of the run. Save and restore the property by hand.
- **`renderPdf` output is not byte-deterministic across calls.** Compare *stored* bytes on reprint with `Buffer.compare`; never `Buffer.compare` two fresh renders. Content pins go on the DEFINITION, not the rendered bytes; copy `allText` (`tests/cert-pdf.test.ts:25-35`) for content and `pageCount` (`tests/traveler.test.ts:61`) plus the `%PDF-` header for structure.
- Money `Decimal(12, 2)` via `decimalField(12, 2, …)`; percentages: `discountPercent` `Decimal(5, 2)` (`2` = 2%), `financeChargeRate` `Decimal(6, 4)` monthly percent (`1.5` = 1.5%/month). Quantities `z.number().int()`. **Rounding is half-up to cents; compute in integer cents where a float would bite.** Totals are sums of already-rounded lines.
- **Reads of an invoice are snapshot-first, unconditionally** (5A §5.4) — an invoice is frozen paper. A/R records against its id and its own `total`; a payment/application never re-derives or rewrites an invoice-side snapshot field.
- **When a fix lands on one member of a sibling group, enumerate the whole group in the report.** This phase's grids: the batch-apply grid, the aging report, and the statement run.

## Owner rulings binding this plan (spec §3)

All four cash-application primitives (partial, terms discount, write-off both flavors, on-account); one payment → many invoices, and across a parent's children; check/card/ACH via `PaymentType`; **no prepayments** (on-account = unapplied receipt only); a credit applies to an invoice or sits on account; **a credit takes its own date**; terms-based early-pay discounts; standard aging by due date with a **separate unapplied column**; finance charges **informational-only, opt-in per run**; open-item statements, family on demand, **archived**.

## The balance rule (spec §4.2) — everything derives from live `Application`

- Invoice open balance = `Invoice.total − Σ (live Application.amount where invoiceId = this)`.
- Payment on-account = `Payment.amount − Σ (live Application.amount where paymentId = this AND type = PAYMENT)`.
- Credit remaining = `|Invoice.total|` (kind = CREDIT) `− Σ (live Application.amount where creditInvoiceId = this)`.
- No balance is ever cached on `Invoice`; a voided (soft-deleted) `Application` drops out of every sum.

## The `Application_source_check` (spec §4.1)

`PAYMENT`/`DISCOUNT`/`WRITE_OFF` ⇒ `creditInvoiceId IS NULL`; `CREDIT` ⇒ `paymentId IS NULL AND creditInvoiceId IS NOT NULL`; a standalone bad-debt `WRITE_OFF` may carry a null `paymentId`.
