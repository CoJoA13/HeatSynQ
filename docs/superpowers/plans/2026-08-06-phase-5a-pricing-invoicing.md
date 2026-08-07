# Phase 5A — Pricing & Invoicing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Price and invoice a shipped order — operation-level part prices resolved against the ship ledger, surcharges, freight, extra charges, certification charges and sales tax composed into one invoice per order, finalized, printed to the owner's sample layout and stored byte-for-byte, correctable by unlock or credit.

**Architecture:** Part pricing moves from four columns on `Part` into **`PartPrice` rows keyed by Process Step Code**, which is what gives every revenue line a GL account. A **pure, I/O-free `pricing.ts`** turns plain data (shipped totals + price rows + surcharges + config) into computed lines; `invoices.ts` is the only module that talks to Prisma about invoices, and it **snapshots** every line at creation so an invoice explains itself forever. One `Invoice` table carries both invoices (identified by their order number, one live per order via a partial unique index) and credits (`kind = CREDIT`, own counter). Every mutation claims the **order row first, then the invoice row** — the fixed order `order-locks.ts` documents. Spec: `docs/superpowers/specs/2026-08-06-phase-5a-pricing-invoicing-design.md` — **all bare § references below are to it; its prisma blocks are the schema contract.**

**Tech Stack:** Next.js 16 / React 19 client pages against guarded APIs, Prisma 7 (+pg adapter), zod 4, pdfmake (`PdfPrinter` Node entry), vitest against the real `erp_test` database, the bespoke Playwright harness in `e2e/`.

## Global Constraints

- All commands run from `erp/`. Quality gates after every task: `npm test`, `npx tsc --noEmit`, `npx eslint src tests` (plus `npm run build` before review rounds) — or just `/gates`. Node 26 (`nvm use 26`); `npm ci`'s five skipped-install-scripts warning is expected and must not be "fixed".
- TDD per task: failing test → implement → pass → commit. Conventional commits, **no attribution trailers** (owner instruction; a PreToolUse hook blocks them). Attribution goes in the PR body.
- Every mutation through `auditedCreate` / `auditedUpdate` / `auditedSoftDelete` — `tx` is REQUIRED. Canonical nesting: `withDbErrors` → `prisma.$transaction` → `audited*` → writes on `tx`. **This phase adds no new audit exceptions.**
- **Row locks, never isolation levels, guard cross-transaction invariants.** Every invoice mutation calls `claimOrder(tx, orderId)` and then claims the invoice row with `SELECT "id" FROM "Invoice" WHERE "id" = $1 FOR UPDATE` before reading the state it acts on. Transactions run Serializable because they assign registered FKs (`processStepCodeId`, `glAccountId`, `surchargeId`) via `assertRefExists(kind, id, tx)` — **that is the FK-writer pattern, NOT what protects the claim.** Never present isolation as the lock. Multi-order writes go through `claimOrdersInOrder`; never add a second, differently-ordered claim path.
- Never `findUnique` / `upsert` / `update` / `delete` keyed on a partial-unique column; use `findFirst({ where: { …, deletedAt: null } })`. Partial `@@unique(...)` attributes stay on **ONE line** (the sweep's regexes assume it). `Invoice.creditNumber` and `Invoice.clientRequestId` are deliberately plain `@unique` — extend the sweep's documented exemptions (Task 1), do not "fix" them.
- `npx prisma migrate dev` refuses without a TTY. Use the `/create-migration` skill, or by hand: `npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script`, read the output **IN FULL**, hand-write `prisma/migrations/<timestamp>_<name>/migration.sql`, then `npx prisma migrate deploy` **and** `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy`, then `npx prisma generate`. A PreToolUse hook blocks edits to already-applied migrations.
- Client components never import from `src/server/**`; shared pure code goes in `src/lib/`.
- Route handlers: `handle(async (req, { params }) => …)`; first line `mustCan(requireUser(), area, action)` (or `mustDo` for `unlock_invoice` / `change_prices` / `void_shipper`). **`requireUser()` takes no arguments** — `handle()` publishes the session through `AsyncLocalStorage` (CLAUDE.md's `requireUser(req)` example is stale). `assertRecord(body)` before key checks; DELETE reasons via `reasonFromBody`. Route tests pass ctx: `handler(request, { params: Promise.resolve({ id }) })`.
- Expected failures are `HttpError(400|403|404, message)`, field-anchored. Dates cross the wire as `"yyyy-mm-dd"` strings; use `parseDateOnly` / `formatDateOnly` / `todayDateOnly` from `src/lib/business-days.ts` and store `Date` in `@db.Date` columns.
- Tests share one database: `truncateAll()` in `beforeEach`, `signInWith(permissions)` from the test helpers. `fileParallelism: false` — do not parallelize. **Assert audit content (real diffs), not just that entries exist.**
- **A concurrency test that passes is not evidence.** Verify each by deleting the guard and watching it go red, and pin the **competing** caller to Read Committed — two Serializable transactions are ordered by SSI whether or not your lock exists (Phase 4 lesson 1).
- **Never `vi.spyOn` a Prisma model delegate** — `mockRestore()` does not restore it on this client and corrupts the shared singleton for the rest of the run. Save and restore the property by hand.
- **`renderPdf` output is not byte-deterministic across calls.** Compare *stored* bytes on reprint with `Buffer.compare`; never `Buffer.compare` two fresh renders. **Content pins go on the DEFINITION, not the rendered bytes** — pdfkit writes TTF-subset glyph ids, so a rendered PDF carries no character text to grep for. Copy `allText` (`tests/cert-pdf.test.ts:25-35`) for content and `pageCount` (`tests/traveler.test.ts:61`) plus the `%PDF-` header for structure.
- Money `Decimal(12, 2)` via `decimalField(12, 2, …)`; unit prices `Decimal(12, 4)`; rates and percentages `Decimal(9, 6)` (4% = `0.040000`); each-weights `Decimal(10, 4)`; quantities `z.number().int()`.
- **Rounding is half-up to cents at every line.** Totals are sums of already-rounded lines, never a re-rounded sum. Compute in integer cents where a float would bite.
- **Reads of an invoice are snapshot-first, unconditionally** (§5.4). An invoice is frozen paper, not a document being edited — never live-join-first. That is the opposite of the shipment grids, deliberately.
- **When a fix lands on one member of a sibling group, enumerate the whole group in the report.** This phase's sibling groups: the three notes-pair PATCH sites, the four order-hub bulk grids, and now the part-pricing grid and the invoice-lines grid.
- Owner rulings binding this plan (spec §3): Phase 5 is split 5A/5B/5C; **the invoice's number is the order number** and `invoice_number_next` stays unused; **multiple priced operations per part**, replacing the part's four price columns; **one invoice per order, billed once, at `SHIPPED`** — no grouping machinery; full §7.5 surcharges; freight, extra charges, sales tax and cert charges are all billable; tax is plant rate + per-customer override on the priced subtotal with freight excluded; cert charge is per part with a plant default and a customer suppression; corrections are **unlock → correct → re-lock**, credits only once the customer holds the paper; credits are `Invoice` rows with their own counter; lines are **snapshotted at creation**; `amount = max(extended, minimum) + setup`.

## File Structure

**New server modules**

| File | Responsibility |
|---|---|
| `src/lib/invoice-constants.ts` | Pure constants safe for client import: `INVOICE_KINDS`, `INVOICE_STATUSES`, `INVOICE_LINE_KINDS`, `PRICE_SOURCES`, `SURCHARGE_KINDS`, `SURCHARGE_SCOPES` + their label maps |
| `src/server/pricing.ts` | **Pure.** Line math, break selection, minimums, surcharge computation, tax. No Prisma, no I/O, no `src/server/` imports |
| `src/server/part-prices.ts` | `PartPrice` + re-parented `PartPriceBreak` CRUD |
| `src/server/surcharges.ts` | Surcharge CRUD, the include/exclude replace-grid, customer override rows |
| `src/server/billing-config.ts` | The `BillingConfig` singleton |
| `src/server/invoice-guards.ts` | **Leaf.** `finalizedInvoiceFor(tx, orderId)` + its blocker message, for `orders.ts` / `shippers.ts` / `invoices.ts` — the module that keeps the cycle from existing |
| `src/server/invoices.ts` | Candidates, create, read, draft edits, recalculate, finalize, unlock, discard, credit |
| `src/server/pdf/invoice.ts` | The layout builder: plain data in, plain-JSON pdfmake definition out |

**Modified server modules:** `prisma/schema.prisma`, `src/server/settings.ts`, `src/server/audit.ts`, `src/server/documents.ts`, `src/server/parts.ts`, `src/server/customers.ts`, `src/server/orders.ts`, `src/server/shippers.ts`, `src/server/ship-ledger.ts`, `src/lib/reference-links.ts`, `src/lib/part-constants.ts`.

**Deleted:** `src/server/part-price-breaks.ts` (absorbed into `part-prices.ts`).

**New pages/routes:** `src/app/invoicing/{page.tsx,InvoicingList.tsx}`, `src/app/invoicing/[id]/{page.tsx,InvoiceDetail.tsx}`, `src/app/admin/surcharges/page.tsx`, `src/app/admin/billing/page.tsx`, `src/app/orders/[id]/InvoicesSection.tsx`, and the API routes named in §9.

**Task ordering rationale:** schema first (everything else typechecks against the generated client), then the leaf modules with no dependencies (`pricing.ts`, `invoice-guards.ts`) before the services that consume them, then routes, then pages, then the PDF, then E2E and docs. The pure engine (Task 8) is deliberately placed *before* `invoices.ts` so its exhaustive tests exist before anything can paper over a math bug with a database fixture.

---

### Task 1: `invoice-constants.ts` + the two new settings

**Files:**
- Create: `src/lib/invoice-constants.ts`
- Modify: `src/server/settings.ts`
- Test: `tests/settings.test.ts`, `tests/allocate-number.test.ts`

**Interfaces:**
- Consumes: `allocateNumber(key: NumberSettingKey, tx: Prisma.TransactionClient): Promise<number>` and `numberSeed` (both existing, `src/server/settings.ts`).
- Produces:
```ts
// src/lib/invoice-constants.ts  (pure constants — safe to import from client components)
export const INVOICE_KINDS = ["INVOICE", "CREDIT"] as const;
export type InvoiceKindValue = (typeof INVOICE_KINDS)[number];
export const INVOICE_KIND_LABELS: Record<InvoiceKindValue, string>;

export const INVOICE_STATUSES = ["DRAFT", "FINALIZED"] as const;
export type InvoiceStatusValue = (typeof INVOICE_STATUSES)[number];
export const INVOICE_STATUS_LABELS: Record<InvoiceStatusValue, string>;

export const INVOICE_LINE_KINDS = ["PART", "OPERATION", "SURCHARGE", "FREIGHT", "CHARGE", "CERT", "TAX"] as const;
export type InvoiceLineKindValue = (typeof INVOICE_LINE_KINDS)[number];
export const INVOICE_LINE_KIND_LABELS: Record<InvoiceLineKindValue, string>;

export const PRICE_SOURCES = ["PART_PRICE", "MANUAL"] as const;
export type PriceSourceValue = (typeof PRICE_SOURCES)[number];
export const PRICE_SOURCE_LABELS: Record<PriceSourceValue, string>;

export const SURCHARGE_KINDS = ["PERCENT", "FLAT"] as const;
export type SurchargeKindValue = (typeof SURCHARGE_KINDS)[number];
export const SURCHARGE_KIND_LABELS: Record<SurchargeKindValue, string>;

export const SURCHARGE_SCOPES = ["ALL", "INCLUDE", "EXCLUDE"] as const;
export type SurchargeScopeValue = (typeof SURCHARGE_SCOPES)[number];
export const SURCHARGE_SCOPE_LABELS: Record<SurchargeScopeValue, string>;

// src/server/settings.ts — two new SETTINGS keys:
//   credit_number_next     (numberSeed, default 1000)
//   invoice_number_prefix  (z.string(), default "")
```

- [ ] **Step 1: Write the failing tests.** Append to `tests/allocate-number.test.ts`:

```ts
it("allocates credit numbers from the new counter", async () => {
  const first = await prisma.$transaction((tx) => allocateNumber("credit_number_next", tx));
  const second = await prisma.$transaction((tx) => allocateNumber("credit_number_next", tx));
  expect(first).toBe(1000);
  expect(second).toBe(1001);
});
```

and to `tests/settings.test.ts`:

```ts
it("round-trips the invoice number prefix", async () => {
  await setSetting("invoice_number_prefix", "7");
  expect(await getSetting("invoice_number_prefix")).toBe("7");
});

it("rejects a zero credit number seed", async () => {
  await expect(setSetting("credit_number_next", 0)).rejects.toThrow(/Invalid|Too small/i);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/allocate-number.test.ts tests/settings.test.ts`. Expected: FAIL, `Unknown setting: credit_number_next` (and `invoice_number_prefix` is not assignable to `SettingKey`, so `tsc` errors too).

- [ ] **Step 3: Create `src/lib/invoice-constants.ts`** — every array and label map from the Produces block, with real labels:

```ts
// Pure constants only — no server-only imports. Safe to import from client components.
// The arrays must list the same members in the same order as the Prisma enums in Task 2.
export const INVOICE_KINDS = ["INVOICE", "CREDIT"] as const;
export type InvoiceKindValue = (typeof INVOICE_KINDS)[number];
export const INVOICE_KIND_LABELS: Record<InvoiceKindValue, string> = {
  INVOICE: "Invoice",
  CREDIT: "Credit",
};

export const INVOICE_STATUSES = ["DRAFT", "FINALIZED"] as const;
export type InvoiceStatusValue = (typeof INVOICE_STATUSES)[number];
export const INVOICE_STATUS_LABELS: Record<InvoiceStatusValue, string> = {
  DRAFT: "Draft",
  FINALIZED: "Finalized",
};

export const INVOICE_LINE_KINDS = ["PART", "OPERATION", "SURCHARGE", "FREIGHT", "CHARGE", "CERT", "TAX"] as const;
export type InvoiceLineKindValue = (typeof INVOICE_LINE_KINDS)[number];
export const INVOICE_LINE_KIND_LABELS: Record<InvoiceLineKindValue, string> = {
  PART: "Part",
  OPERATION: "Operation",
  SURCHARGE: "Surcharge",
  FREIGHT: "Freight",
  CHARGE: "Charge",
  CERT: "Certification",
  TAX: "Sales tax",
};

export const PRICE_SOURCES = ["PART_PRICE", "MANUAL"] as const;
export type PriceSourceValue = (typeof PRICE_SOURCES)[number];
export const PRICE_SOURCE_LABELS: Record<PriceSourceValue, string> = {
  PART_PRICE: "Part price",
  MANUAL: "Manual",
};

export const SURCHARGE_KINDS = ["PERCENT", "FLAT"] as const;
export type SurchargeKindValue = (typeof SURCHARGE_KINDS)[number];
export const SURCHARGE_KIND_LABELS: Record<SurchargeKindValue, string> = {
  PERCENT: "Percent",
  FLAT: "Flat amount",
};

export const SURCHARGE_SCOPES = ["ALL", "INCLUDE", "EXCLUDE"] as const;
export type SurchargeScopeValue = (typeof SURCHARGE_SCOPES)[number];
export const SURCHARGE_SCOPE_LABELS: Record<SurchargeScopeValue, string> = {
  ALL: "All operations",
  INCLUDE: "Only these operations",
  EXCLUDE: "All except these",
};
```

- [ ] **Step 4: Add the two settings** to `SETTINGS` in `src/server/settings.ts`, in the `Numbering` group beside the existing counters:

```ts
  credit_number_next: { schema: numberSeed, default: 1000, label: "Next credit number", group: "Numbering" },
  // The invoice's number IS the order number (spec §3.2 — the sample's "7 −" is a plant/form
  // code, not a sequence). This prefix is what prints ahead of it.
  invoice_number_prefix: { schema: z.string(), default: "", label: "Invoice number prefix", group: "Numbering" },
```

and **extend the existing "intentionally unused" comment** so it covers `invoice_number_next` too:

```ts
  // Intentionally unused for the rest of the project — certifications carry no number of their own
  // (P4 §3.19) and an invoice is identified by its order number (5A §3.2). Left in place rather
  // than removed; do not wire either of these up to anything.
  invoice_number_next: { schema: numberSeed, default: 1000, label: "Next invoice number", group: "Numbering" },
  cert_number_next: { schema: numberSeed, default: 1000, label: "Next certification number", group: "Numbering" },
```

- [ ] **Step 5: Run the tests** — `npx vitest run tests/allocate-number.test.ts tests/settings.test.ts`. Expected: PASS.
- [ ] **Step 6: Check the settings page renders them** — `src/lib/settings-ui.ts` drives the widgets by key; `invoice_number_prefix` is a plain string and needs no `TEXTAREA_KEYS` entry. Confirm `npx tsc --noEmit` is clean.
- [ ] **Step 7: Gates + commit** — `feat(settings): add credit numbering and the invoice number prefix`

---

### Task 2: Schema — six tables, the two CHECKs, registry, sweeps, audit

**Files:**
- Modify: `prisma/schema.prisma`, `tests/partial-unique-sweep.test.ts`, `src/lib/reference-links.ts`, `src/server/audit.ts`
- Create: `prisma/migrations/<timestamp>_pricing_and_invoicing/migration.sql`
- Test: `tests/invoicing-schema.test.ts`

**Interfaces:**
- Consumes: the constant arrays from Task 1 — **the Prisma enums must list the same members in the same order.**
- Produces: enums `InvoiceKind`, `InvoiceStatus`, `InvoiceLineKind`, `PriceSource`, `SurchargeKind`, `SurchargeScope`, widened `DocumentKind`; models `PartPrice`, `Surcharge`, `SurchargeStepCode`, `CustomerSurcharge`, `Invoice`, `InvoiceLine`, `BillingConfig` **exactly as spec §4.1–§4.5** (copy the prisma blocks verbatim); the §4.4 column changes and back-relations. `AuditableModel` gains `"partPrice" | "surcharge" | "surchargeStepCode" | "customerSurcharge" | "invoice" | "invoiceLine" | "billingConfig"`.

> **The dev and test databases are empty** — verified during design (spec §3.4: 0 parts, 0 customers, 0 orders, 0 step codes). The `Part` column drops and the `PartPriceBreak` re-parent therefore need **no backfill**. Before writing the migration, confirm it is still true:
> `docker exec erp-db-1 psql -U erp -d erp -t -c 'select count(*) from "Part"'` and the same against `erp_test`. **If either returns a non-zero count, STOP and ask the owner** — the drop would destroy keyed pricing.

- [ ] **Step 1: Edit `prisma/schema.prisma`** — the spec's §4.1–§4.5 blocks verbatim, placed after `StoredDocument`. Then the §4.4 changes:
  - `Part`: **remove** `setupCharge`, `unitPrice`, `minimumCharge`, `pricePer`, and the `priceBreaks PartPriceBreak[]` relation; **add** `billForCert Boolean?`, `certCharge Decimal? @db.Decimal(12, 2)`, `prices PartPrice[]`.
  - `PartPriceBreak`: `partId`/`part` → `partPriceId`/`partPrice`; `@@unique([partPriceId, threshold], where: raw("\"deletedAt\" IS NULL"))` **on one line**.
  - `Customer`: add `salesTaxRate Decimal? @db.Decimal(9, 6)`, `certChargeSuppressed Boolean @default(false)`, `invoices Invoice[]`, `surchargeRules CustomerSurcharge[]`.
  - `Order`: add `invoices Invoice[]`.
  - `OrderLine`, `OrderCharge`, `ProcessStepCode`, `GlAccount`, `User`: back-relations for the new FKs. `GlAccount` needs **named** relations for `BillingConfig`'s three account columns (`"BillingSalesTaxGl"`, `"BillingFreightGl"`, `"BillingOtherChargeGl"`) — Prisma cannot disambiguate three relations between the same pair of models otherwise.
  - `Shipper`: add `reversesShipperId String?` + the self-relation `reverses`/`reversedBy`.
  - `StoredDocument`: add `invoiceId String?` + `invoice Invoice?` with `onDelete: SetNull`, and `@@index([invoiceId])`. `DocumentKind` gains `INVOICE` and `CREDIT`.

- [ ] **Step 2: Generate the migration** with `/create-migration` (or the TTY-less recipe in Global Constraints). **Read the diff output in full.** Expect: 6 `CREATE TYPE`, `ALTER TYPE "DocumentKind" ADD VALUE` ×2, 7 `CREATE TABLE`, `ALTER TABLE "Part" DROP COLUMN` ×4 + `ADD COLUMN` ×2, the `PartPriceBreak` re-parent, `ALTER TABLE "Customer"/"Shipper"/"StoredDocument" ADD COLUMN`, and every index in the spec.

  **`ADD VALUE` on an enum cannot run in the same transaction as a statement that uses the new value** (Postgres). If `migrate deploy` errors on that, split `DocumentKind`'s two new values into their own earlier migration directory — Phase 4 hit exactly this.

- [ ] **Step 3: Hand-append both CHECKs** to the migration (Prisma's schema language has no check constraints — the `StoredDocument_kind_owner_check` precedent):

```sql
-- The kind→owner rule, extended for invoices and credits. Keep this in step with the schema
-- comment on StoredDocument and with DocumentOwner/AREA_FOR_KIND in src/server/documents.ts.
ALTER TABLE "StoredDocument" DROP CONSTRAINT "StoredDocument_kind_owner_check";
ALTER TABLE "StoredDocument" ADD CONSTRAINT "StoredDocument_kind_owner_check" CHECK (
  (kind = 'TRAVELER' AND "orderId"   IS NOT NULL AND "shipperId" IS NULL AND "certId" IS NULL AND "invoiceId" IS NULL) OR
  (kind = 'SHIPPER'  AND "shipperId" IS NOT NULL AND "certId"    IS NULL AND "invoiceId" IS NULL)                      OR
  (kind = 'BOL'      AND "shipperId" IS NOT NULL AND "orderId"   IS NULL AND "certId" IS NULL AND "invoiceId" IS NULL) OR
  (kind = 'CERT'     AND "certId"    IS NOT NULL AND "orderId"   IS NULL AND "shipperId" IS NULL AND "invoiceId" IS NULL) OR
  (kind IN ('INVOICE','CREDIT')
                     AND "invoiceId" IS NOT NULL AND "orderId"   IS NULL AND "shipperId" IS NULL AND "certId" IS NULL)
);

-- BillingConfig is a singleton by construction, not by convention.
ALTER TABLE "BillingConfig" ADD CONSTRAINT "BillingConfig_singleton_check" CHECK ("id" = 'singleton');

-- Seed the one row here rather than lazily on first read, so getBillingConfig is a plain
-- findFirst and setBillingConfig is a plain audited update with a real before-snapshot.
INSERT INTO "BillingConfig" ("id", "billForCertDefault", "updatedAt")
VALUES ('singleton', false, now())
ON CONFLICT ("id") DO NOTHING;
```

  The `SHIPPER` arm stays deliberately loose on `orderId` (it is an optional sub-scope — which order's ticket, null = the whole set). **Do not "tighten" it.**

- [ ] **Step 4: Apply to BOTH databases and regenerate** — `npx prisma migrate deploy`, then `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy`, then `npx prisma generate`. Confirm `npx prisma migrate status` is clean on both.

- [ ] **Step 5: Remove the old pricing surface entirely — delete, never stub or comment out.** Dropping the four `Part` columns breaks `npx tsc --noEmit` in a known set of places. **Every one is resolved by deletion**, so the tree compiles and every gate stays green with *no* part-pricing service or UI until Tasks 4 and 5 build the replacement. Commented-out bodies and render-nothing stubs are dead code a reviewer would rightly flag, and a temporarily-empty `PRICING_FIELDS` is worse than none — a guard that reads as protection while checking nothing.
  - **Delete** `src/server/part-price-breaks.ts`, `tests/part-price-breaks.test.ts`, `src/app/api/parts/[id]/breaks/route.ts`, `src/app/api/parts/[id]/breaks/[breakId]/route.ts`. (Task 4 said it would delete these; it now only creates their replacements.)
  - **Delete** `src/app/parts/[id]/PricingSection.tsx` and its `<PricingSection …>` usage in `src/app/parts/[id]/page.tsx`, along with the four pricing fields on that page's `Part` type. Task 5 creates the file fresh.
  - `src/lib/part-constants.ts` — **delete** `PRICING_FIELDS` and drop the four columns from the paste column order. Then delete the two `PRICING_FIELDS.some(...)` guards in `src/app/api/parts/route.ts:22` and `src/app/api/parts/[id]/route.ts:23`: with the columns gone from `Part`, no parts-route body can carry pricing, so the guard has nothing left to guard.
  - `src/server/parts.ts` — remove the four zod fields, their `SELECT` entries, the Decimal→number mapping, the paste handling, and the `pricePer`-change Serializable branch (which enforced "a LOT part cannot carry breaks"). **That rule is not lost — it moves to `part-prices.ts` in Task 4**, where Task 4's own tests assert it.
  - Update `tests/parts.test.ts` and `tests/parts-paste.test.ts` — delete the cases that assert on the four dropped columns. **Do not weaken a case to keep it passing**; a test that no longer has a subject is deleted, not hollowed out.

- [ ] **Step 6: Sweep exemptions** — extend the documented allowlist in `tests/partial-unique-sweep.test.ts` beside `Shipper.bolNumber`:
  - `Invoice.creditNumber` — "allocated from `credit_number_next` at credit creation and never reissued; a discarded draft must never free a number a customer holds on paper"
  - `Invoice.clientRequestId` — "idempotency key; handing it back to a retry would recreate the duplicate it exists to stop (P3 §4)"

  Run the sweep: it passes with the exemptions, and **temporarily removing one fails it** (verify, then restore).

- [ ] **Step 7: Registry entries** in `src/lib/reference-links.ts` — add `"partPrice"`, `"surcharge"`, `"surchargeStepCode"`, `"invoiceLine"` and `"billingConfig"` to `ReferenceLinkModel`, then:

```ts
const INVOICE_VIA_LINE = {
  entityLabel: "Invoice",
  detailPath: (id: string) => `/invoicing/${id}`,
  liveWhere: { invoice: { is: { deletedAt: null } } },
  include: { invoice: { select: { id: true, kind: true, creditNumber: true,
                                  order: { select: { orderNumber: true } } } } },
  blockerId: (r: Record<string, unknown>) => String((r.invoice as { id: string }).id),
  displayName: (r: Record<string, unknown>) => {
    const inv = r.invoice as { kind: string; creditNumber: number | null; order: { orderNumber: number } };
    return inv.kind === "CREDIT" ? `Credit · ${inv.creditNumber}` : `Invoice · ${inv.order.orderNumber}`;
  },
} as const;

// …then, in REFERENCE_LINKS:
{ model: "partPrice", column: "processStepCodeId", targetKind: "processStepCode",
  label: "Step code", ...PART_VIA_CHILD },
{ model: "surcharge", column: "glAccountId", targetKind: "glAccount",
  label: "GL account", entityLabel: "Surcharge", detailPath: () => "/admin/surcharges" },
{ model: "surchargeStepCode", column: "processStepCodeId", targetKind: "processStepCode",
  label: "Step code", entityLabel: "Surcharge", detailPath: () => "/admin/surcharges" },
{ model: "invoiceLine", column: "processStepCodeId", targetKind: "processStepCode",
  label: "Step code", ...INVOICE_VIA_LINE },
{ model: "invoiceLine", column: "glAccountId", targetKind: "glAccount",
  label: "GL account", ...INVOICE_VIA_LINE },
{ model: "billingConfig", column: "salesTaxGlAccountId", targetKind: "glAccount",
  label: "Sales tax GL account", entityLabel: "Billing settings", detailPath: () => "/admin/billing" },
{ model: "billingConfig", column: "freightGlAccountId", targetKind: "glAccount",
  label: "Freight GL account", entityLabel: "Billing settings", detailPath: () => "/admin/billing" },
{ model: "billingConfig", column: "otherChargeGlAccountId", targetKind: "glAccount",
  label: "Other charge GL account", entityLabel: "Billing settings", detailPath: () => "/admin/billing" },
{ model: "billingConfig", column: "certChargeStepCodeId", targetKind: "processStepCode",
  label: "Certification charge step code", entityLabel: "Billing settings", detailPath: () => "/admin/billing" },
```

  Reuse the existing `PART_VIA_CHILD` constant for `partPrice` (a price row's blocker is its part, exactly as `partInspection`'s is). Run `tests/reference-links-sweep.test.ts` — green; it fails on an unregistered FK otherwise. **This is the change that makes a billed step code or GL account permanently undeletable — that is the intended §5.14 behaviour (spec §7), not an accident.**

  **`Surcharge` is deliberately NOT a blocker target yet.** The sweep only walks FKs whose target is in `REFERENCE_KINDS` plus the single extra `kinds.add("processStepCode")` (`tests/reference-links-sweep.test.ts:52-55`), so `invoiceLine.surchargeId` and `customerSurcharge.surchargeId` are invisible to it and this task stays green without them. **Task 6 makes `surcharge` a `BlockerTarget`** — widening the union, `TARGET_LABELS`, the sweep's `kinds` set, and adding those two entries together, so the sweep never sits red between tasks.

- [ ] **Step 8: Audit surface** in `src/server/audit.ts` — add the seven model names to `AuditableModel`, then `SNAPSHOT_INCLUDE`, **every collection `orderBy`'d** (issue #24):

```ts
partPrice:         { breaks: { orderBy: { threshold: "asc" } }, processStepCode: { select: { code: true, name: true } } },
surcharge:         { stepCodes: { orderBy: { processStepCodeId: "asc" },
                                  include: { processStepCode: { select: { code: true, name: true } } } },
                     glAccount: { select: { name: true } } },
surchargeStepCode: undefined,
customerSurcharge: { surcharge: { select: { name: true } } },
invoice: {
  customer: { select: { code: true, name: true } },
  order: { select: { orderNumber: true } },
  lines: {
    orderBy: { position: "asc" },
    include: { processStepCode: { select: { code: true, name: true } },
               glAccount: { select: { name: true } } },
  },
},
invoiceLine:   undefined,
billingConfig: undefined,
```

- [ ] **Step 9: Schema smoke test** `tests/invoicing-schema.test.ts` (model it on `tests/certs-schema.test.ts`):
  - graph round-trip: part → `PartPrice` → `PartPriceBreak`; invoice → lines with a `parentLineId` child;
  - the live-rows-only `@@unique([orderId])` rejects a **second live `INVOICE`** for one order, **accepts** one after the first is soft-deleted, and **accepts a `CREDIT`** alongside a live invoice;
  - the `StoredDocument` CHECK rejects each illegal combination — an `INVOICE` row with `orderId`, an `INVOICE` row with no `invoiceId`, a `CERT` row carrying `invoiceId` — each via `prisma.$executeRaw` so the failure is the constraint, not Prisma's types;
  - `BillingConfig_singleton_check` rejects `INSERT … VALUES ('other')`.

- [ ] **Step 10: Gates + commit** — `feat: pricing and invoicing schema — price rows, surcharges, invoices, billing config`

---

### Task 3: `billing-config.ts` + Admin → Billing

**Files:**
- Create: `src/server/billing-config.ts`, `src/app/api/admin/billing/route.ts`, `src/app/admin/billing/page.tsx`
- Modify: `src/components/Shell.tsx` (no nav change — Billing lives under Admin, reached from `/admin`), `src/app/admin/page.tsx` (add the card/link)
- Test: `tests/billing-config.test.ts`

**Interfaces:**
- Consumes: `assertRefExists(kind, id, tx)` (`src/server/reference-guards.ts:23`), `auditedUpdate`, `withDbErrors`.
- Produces:
```ts
// src/server/billing-config.ts
export type BillingConfigRow = {
  salesTaxRate: number | null;
  salesTaxGlAccountId: string | null;
  freightGlAccountId: string | null;
  otherChargeGlAccountId: string | null;
  certChargeStepCodeId: string | null;
  certChargeDefault: number | null;
  billForCertDefault: boolean;
};
export async function getBillingConfig(db?: Prisma.TransactionClient): Promise<BillingConfigRow>;
export async function setBillingConfig(input: unknown): Promise<BillingConfigRow>;
```

> **Amended after Task 2 (2026-08-06).** `tests/part-price-breaks.test.ts` **no longer exists** — Task 2 deleted it with the rest of the old pricing surface. Take the harness idiom (`beforeEach(truncateAll)`, `asSystem` wrapping `runWithContext({ actor: { id: null, name: "test" }, user: null }, fn)`) from any current service test, e.g. `tests/certs.test.ts`.
>
> **And `truncateAll()` now RE-SEEDS the `BillingConfig` singleton** (`tests/helpers/db.ts`, Task 2). That is deliberate and correct — production can never have zero rows (the migration seeds it and a CHECK pins the id), so a test database without it would encode a state production cannot reach. The consequence for you: **`getBillingConfig`'s `if (!row) return EMPTY` branch is unreachable under `truncateAll`.** Keep the fallback — a fresh clone or a restore can genuinely arrive without the row — but a test of it must delete the row explicitly first, or it asserts nothing. Both cases are written out below.

- [ ] **Step 1: Write the failing test** `tests/billing-config.test.ts`:

```ts
it("returns the seeded singleton with everything unset", async () => {
  const cfg = await getBillingConfig();
  expect(cfg).toEqual({
    salesTaxRate: null, salesTaxGlAccountId: null, freightGlAccountId: null,
    otherChargeGlAccountId: null, certChargeStepCodeId: null,
    certChargeDefault: null, billForCertDefault: false,
  });
});

// The fallback branch, which truncateAll's re-seed would otherwise make unreachable: delete the
// row first, so this test can actually fail if the `if (!row) return EMPTY` guard is removed.
it("returns the defaults when the row is genuinely absent (a fresh clone, a restore)", async () => {
  await prisma.billingConfig.deleteMany({});
  const cfg = await getBillingConfig();
  expect(cfg.salesTaxRate).toBeNull();
  expect(cfg.billForCertDefault).toBe(false);
});

// Task 2 hand-wrote BILLING_CONFIG_BLOCKER to repair a defect in this plan's own registry
// snippet, and nothing exercises its displayName/blockerId yet — the queries are proven valid
// (they run on every GL-account delete), but no test has ever had a matching row. BillingConfig
// has no `name` column, so findBlockers' default would print "singleton" at a user.
it("refuses to delete a GL account the billing settings point at, naming it usefully", async () => {
  const gl = await prisma.glAccount.create({ data: { name: "4300", description: "Freight" } });
  await asSystem(() => setBillingConfig({ freightGlAccountId: gl.id }));
  await expect(asSystem(() => deleteReference("glAccount", gl.id)))
    .rejects.toThrow(/still in use by 1 record/);
  const blockers = await findBlockers("glAccount", gl.id);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].entityLabel).toBe("Billing settings");
  expect(blockers[0].name).not.toBe("singleton");     // a person must be able to read this
  expect(blockers[0].href).toBe("/admin/billing");
});

it("saves a rate and a GL account, and audits the diff", async () => {
  const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Sales" } });
  await asSystem(() => setBillingConfig({ salesTaxRate: "0.0400", salesTaxGlAccountId: gl.id }));
  const cfg = await getBillingConfig();
  expect(cfg.salesTaxRate).toBe(0.04);
  const entry = await prisma.auditLog.findFirst({
    where: { entity: "billingConfig", entityId: "singleton" }, orderBy: { at: "desc" } });
  const before = entry!.before as { salesTaxRate: string | null };
  const after = entry!.after as { salesTaxRate: string };
  expect(before.salesTaxRate).toBeNull();
  expect(Number(after.salesTaxRate)).toBe(0.04);
});

it("refuses a GL account that does not exist", async () => {
  await expect(asSystem(() => setBillingConfig({ freightGlAccountId: "nope" })))
    .rejects.toThrow("That gl account does not exist");
});

it("refuses a soft-deleted step code", async () => {
  const code = await prisma.processStepCode.create({ data: { code: "CERT", name: "Certification" } });
  await prisma.processStepCode.update({ where: { id: code.id }, data: { deletedAt: new Date() } });
  await expect(asSystem(() => setBillingConfig({ certChargeStepCodeId: code.id })))
    .rejects.toThrow("That process step code does not exist");
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/billing-config.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/server/billing-config.ts`.** `truncateAll` wipes the seeded row, so `getBillingConfig` must tolerate its absence and return the defaults — the tests above depend on that:

```ts
import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { withDbErrors } from "./db-errors";
import { auditedUpdate } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";

const ID = "singleton";

export type BillingConfigRow = {
  salesTaxRate: number | null;
  salesTaxGlAccountId: string | null;
  freightGlAccountId: string | null;
  otherChargeGlAccountId: string | null;
  certChargeStepCodeId: string | null;
  certChargeDefault: number | null;
  billForCertDefault: boolean;
};

const EMPTY: BillingConfigRow = {
  salesTaxRate: null, salesTaxGlAccountId: null, freightGlAccountId: null,
  otherChargeGlAccountId: null, certChargeStepCodeId: null,
  certChargeDefault: null, billForCertDefault: false,
};

// Kept in sync with prisma/schema.prisma's @db.Decimal declarations on BillingConfig.
const SAVE = z.object({
  salesTaxRate: decimalField(9, 6, { min: "nonnegative" }),
  salesTaxGlAccountId: z.string().nullable().optional(),
  freightGlAccountId: z.string().nullable().optional(),
  otherChargeGlAccountId: z.string().nullable().optional(),
  certChargeStepCodeId: z.string().nullable().optional(),
  certChargeDefault: decimalField(12, 2, { min: "nonnegative" }),
  billForCertDefault: z.boolean().optional(),
}).partial().strict();

export async function getBillingConfig(db: Prisma.TransactionClient | typeof prisma = prisma): Promise<BillingConfigRow> {
  // The row is seeded by the migration, but truncateAll removes it between tests and a fresh
  // clone restores it — either way an absent row means "nothing configured", not an error.
  const row = await db.billingConfig.findFirst({ where: { id: ID } });
  if (!row) return EMPTY;
  return {
    salesTaxRate: row.salesTaxRate?.toNumber() ?? null,
    salesTaxGlAccountId: row.salesTaxGlAccountId,
    freightGlAccountId: row.freightGlAccountId,
    otherChargeGlAccountId: row.otherChargeGlAccountId,
    certChargeStepCodeId: row.certChargeStepCodeId,
    certChargeDefault: row.certChargeDefault?.toNumber() ?? null,
    billForCertDefault: row.billForCertDefault,
  };
}

export async function setBillingConfig(input: unknown): Promise<BillingConfigRow> {
  const data = SAVE.parse(input);
  // Serializable whenever an FK is actually being assigned — the createStepCode scoping
  // precedent (process-step-codes.ts:97-108). Clearing one to null needs neither.
  const assigns =
    data.salesTaxGlAccountId != null || data.freightGlAccountId != null ||
    data.otherChargeGlAccountId != null || data.certChargeStepCodeId != null;
  await withDbErrors({ entity: "Billing settings" }, () =>
    prisma.$transaction(async (tx) => {
      if (data.salesTaxGlAccountId) await assertRefExists("glAccount", data.salesTaxGlAccountId, tx);
      if (data.freightGlAccountId) await assertRefExists("glAccount", data.freightGlAccountId, tx);
      if (data.otherChargeGlAccountId) await assertRefExists("glAccount", data.otherChargeGlAccountId, tx);
      if (data.certChargeStepCodeId) await assertRefExists("processStepCode", data.certChargeStepCodeId, tx);
      await auditedUpdate("billingConfig", ID, () =>
        tx.billingConfig.upsert({ where: { id: ID }, create: { id: ID, ...data }, update: data }), { tx });
    }, assigns ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined));
  return getBillingConfig();
}
```

- [ ] **Step 4: Run the tests** — `npx vitest run tests/billing-config.test.ts`. Expected: PASS.

- [ ] **Step 5: The route** `src/app/api/admin/billing/route.ts`:

```ts
import { NextResponse } from "next/server";
import { handle, requireUser, assertRecord } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getBillingConfig, setBillingConfig } from "@/server/billing-config";

export const GET = handle(async () => {
  mustCan(requireUser(), "admin", "view");
  return NextResponse.json(await getBillingConfig());
});

export const PUT = handle(async (req) => {
  mustCan(requireUser(), "admin", "edit");
  const body = await req.json();
  assertRecord(body);
  return NextResponse.json(await setBillingConfig(body));
});
```

- [ ] **Step 6: Route tests** in `tests/billing-config.test.ts` — GET 401 unauthenticated, 403 without `admin.view`, PUT 403 without `admin.edit`, 200 with both. Pass ctx: `GET(request, { params: Promise.resolve({}) })`.

- [ ] **Step 7: The page** `src/app/admin/billing/page.tsx` — a client component modelled on `src/app/admin/settings/page.tsx`: one form, seven controls. The three GL account selects and the step-code select load their options from `/api/admin/reference/glAccount` and `/api/picklists/processStepCode` respectively (**GL accounts are deliberately not on the pick-list route** — `PICKLIST_KINDS` excludes them, §5.15 — and this is an admin page, so the admin route is the right source). Every control gates on `gate(perms, "admin.edit")` and renders **disabled with a title naming the missing permission, never hidden** (§5.16). Add the card link on `src/app/admin/page.tsx` beside Settings.

- [ ] **Step 8: Gates + commit** — `feat(admin): plant billing configuration — GL defaults, tax rate, certification charge`

---

### Task 4: `part-prices.ts` — price rows and their breaks

**Files:**
- Create: `src/server/part-prices.ts`, `src/app/api/parts/[id]/prices/route.ts`, `src/app/api/parts/[id]/prices/[priceId]/route.ts`, `src/app/api/parts/[id]/prices/[priceId]/breaks/route.ts`, `src/app/api/parts/[id]/prices/[priceId]/breaks/[breakId]/route.ts`
- Test: `tests/part-prices.test.ts`

> **Task 2 already deleted the old surface** (`part-price-breaks.ts`, its tests, its two routes, `PRICING_FIELDS` and the parts-route guards). This task only builds the replacement. If any of those still exist when you start, Task 2 is incomplete — say so rather than working around it.

**Interfaces:**
- Consumes: `decimalField(precision, scale, opts)` (`src/server/decimal-field.ts`), `assertRefExists`, `auditedCreate` / `auditedUpdate` / `auditedSoftDelete`, `PRICE_PER` (`src/lib/part-constants.ts`).
- Produces:
```ts
// src/server/part-prices.ts
export type PartBreakRow = { id: string; threshold: number; price: number };
export type PartPriceRow = {
  id: string;
  processStepCodeId: string;
  stepCode: string;            // ProcessStepCode.code
  stepName: string;            // ProcessStepCode.name
  glAccountId: string | null;  // through the step code — this is what gives revenue a GL account
  glAccountName: string;       // the account number as text, "" when the step code has none
  position: number;
  setupCharge: number | null;
  unitPrice: number | null;
  minimumCharge: number | null;
  pricePer: PricePerValue;
  breaks: PartBreakRow[];
};
export async function listPartPrices(partId: string): Promise<PartPriceRow[]>;
export async function addPartPrice(partId: string, input: Record<string, unknown>): Promise<{ id: string }>;
export async function updatePartPrice(partId: string, priceId: string, input: Record<string, unknown>): Promise<void>;
export async function deletePartPrice(partId: string, priceId: string): Promise<void>;
export async function addPriceBreak(partId: string, priceId: string, input: Record<string, unknown>): Promise<{ id: string }>;
export async function updatePriceBreak(partId: string, priceId: string, breakId: string, input: Record<string, unknown>): Promise<void>;
export async function deletePriceBreak(partId: string, priceId: string, breakId: string): Promise<void>;
```

- [ ] **Step 1: Write the failing tests** `tests/part-prices.test.ts` — copy the fixture and `asSystem` helper from `tests/part-price-breaks.test.ts:1-22` verbatim (it is being deleted; its harness is the idiom), then:

```ts
it("adds two priced operations and lists them in position order", async () => {
  const { partId, austemper, straighten } = await fixture();
  await asSystem(() => addPartPrice(partId, {
    processStepCodeId: straighten.id, position: 2, unitPrice: "1.0000", pricePer: "EACH" }));
  await asSystem(() => addPartPrice(partId, {
    processStepCodeId: austemper.id, position: 1, unitPrice: "6.5100",
    minimumCharge: "600.00", pricePer: "EACH" }));
  const rows = await listPartPrices(partId);
  expect(rows.map((r) => r.stepCode)).toEqual(["AUST", "STRT"]);
  expect(rows[0].unitPrice).toBe(6.51);
  expect(rows[0].minimumCharge).toBe(600);
});

it("refuses a second live price row for the same operation", async () => {
  const { partId, austemper } = await fixture();
  await asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 }));
  await expect(asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 2 })))
    .rejects.toThrow("That operation is already priced on this part");
});

it("re-prices an operation after its row is deleted (partial unique)", async () => {
  const { partId, austemper } = await fixture();
  const { id: first } = await asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 }));
  await asSystem(() => deletePartPrice(partId, first));
  const { id: second } = await asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 }));
  expect(second).not.toBe(first);
});

it("refuses a break on a LOT-priced row, and refuses LOT while breaks exist", async () => {
  const { partId, austemper, straighten } = await fixture();
  const { id: lotId } = await asSystem(() => addPartPrice(partId, {
    processStepCodeId: austemper.id, position: 1, pricePer: "LOT", unitPrice: "500.0000" }));
  await expect(asSystem(() => addPriceBreak(partId, lotId, { threshold: 500, price: "0.95" })))
    .rejects.toThrow("A LOT-priced operation cannot carry price breaks");

  const { id: eachId } = await asSystem(() => addPartPrice(partId, {
    processStepCodeId: straighten.id, position: 2, pricePer: "EACH", unitPrice: "1.0000" }));
  await asSystem(() => addPriceBreak(partId, eachId, { threshold: 500, price: "0.95" }));
  await expect(asSystem(() => updatePartPrice(partId, eachId, { pricePer: "LOT" })))
    .rejects.toThrow("A LOT-priced operation cannot carry price breaks");
});

it("refuses a soft-deleted step code", async () => {
  const { partId, austemper } = await fixture();
  await prisma.processStepCode.update({ where: { id: austemper.id }, data: { deletedAt: new Date() } });
  await expect(asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 })))
    .rejects.toThrow("That process step code does not exist");
});

it("scopes every mutator to its part and its price row", async () => {
  const { partId, otherPartId, austemper } = await fixture();
  const { id } = await asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 }));
  await expect(asSystem(() => updatePartPrice(otherPartId, id, { position: 2 })))
    .rejects.toThrow("Price row not found");
  await expect(asSystem(() => deletePartPrice(otherPartId, id)))
    .rejects.toThrow("Price row not found");
});

// Task 2 changed `deletePart` to cascade-soft-delete PartPrice rows (parts.ts) and left it
// untested. It is load-bearing: `partPrice` reuses PART_VIA_CHILD in the FK registry, so if the
// cascade were ever dropped, a deleted part's live price rows would block a step-code delete
// forever behind a blocker naming a part nobody can see. Add this to `tests/parts.test.ts`'s
// existing "delete requires a reason and cascades children" case rather than a new one.
it("soft-deletes a part's price rows when the part is deleted", async () => {
  const { partId, austemper } = await fixture();
  const { id } = await asSystem(() => addPartPrice(partId, { processStepCodeId: austemper.id, position: 1 }));
  await asSystem(() => deletePart(partId, "keyed against the wrong customer"));
  const row = await prisma.partPrice.findUniqueOrThrow({ where: { id } });
  expect(row.deletedAt).not.toBeNull();
  // Its breaks are deliberately left alone — they hang off a dead row under a dead part and no
  // live read can reach them (deletePartPrice follows the same rule).
});

it("audits a price row create/update/delete with a real diff", async () => {
  const { partId, austemper } = await fixture();
  const { id } = await asSystem(() => addPartPrice(partId, {
    processStepCodeId: austemper.id, position: 1, unitPrice: "6.5100" }));
  await asSystem(() => updatePartPrice(partId, id, { unitPrice: "7.0000" }));
  await asSystem(() => deletePartPrice(partId, id));
  const entries = await prisma.auditLog.findMany({
    where: { entity: "partPrice", entityId: id }, orderBy: [{ at: "asc" }, { id: "asc" }] });
  expect(entries.map((e) => e.action)).toEqual(["create", "update", "delete"]);
  const before = entries[1].before as { unitPrice: string };
  const after = entries[1].after as { unitPrice: string };
  expect(Number(before.unitPrice)).toBe(6.51);
  expect(Number(after.unitPrice)).toBe(7);
});
```

  The `fixture()` helper extends the deleted file's: after creating the part, also
  `const austemper = await prisma.processStepCode.create({ data: { code: "AUST", name: "Austemper" } });`
  and the same for `{ code: "STRT", name: "Straighten" }`.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/part-prices.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/server/part-prices.ts`**, following `part-price-breaks.ts`'s idiom exactly — `FIELDS` object → `ADD`/`EDIT` strict schemas → `withDbErrors` → `$transaction` → `audited*` with `{ tx }` → a private `claimLive` doing a scoped `updateMany` that 404s on `count === 0`:

```ts
import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";
import { PRICE_PER, type PricePerValue } from "../lib/part-constants";

export type PartBreakRow = { id: string; threshold: number; price: number };
export type PartPriceRow = {
  id: string; processStepCodeId: string; stepCode: string; stepName: string; position: number;
  setupCharge: number | null; unitPrice: number | null; minimumCharge: number | null;
  pricePer: PricePerValue; breaks: PartBreakRow[];
};

// Kept in sync with prisma/schema.prisma's @db.Decimal declarations on PartPrice.
const PRICE_FIELDS = {
  processStepCodeId: z.string().min(1),
  position: z.number().int().min(0),
  setupCharge: decimalField(12, 2, { min: "nonnegative" }),
  unitPrice: decimalField(12, 4, { min: "nonnegative" }),
  minimumCharge: decimalField(12, 2, { min: "nonnegative" }),
  pricePer: z.enum(PRICE_PER).optional(),
};
const ADD_PRICE = z.object(PRICE_FIELDS).strict();
const EDIT_PRICE = z.object(PRICE_FIELDS).partial().strict();

const BREAK_FIELDS = {
  threshold: decimalField(12, 2, { required: true, min: "positive" }),
  price: decimalField(12, 4, { required: true, min: "nonnegative" }),
};
const ADD_BREAK = z.object(BREAK_FIELDS).strict();
const EDIT_BREAK = z.object(BREAK_FIELDS).partial().strict();

const LOT_WITH_BREAKS = "A LOT-priced operation cannot carry price breaks";

export async function listPartPrices(partId: string): Promise<PartPriceRow[]> {
  const rows = await prisma.partPrice.findMany({
    where: { partId, deletedAt: null },
    include: {
      processStepCode: {
        select: { code: true, name: true, glAccountId: true, glAccount: { select: { name: true } } },
      },
      breaks: { where: { deletedAt: null }, orderBy: { threshold: "asc" } },
    },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id, processStepCodeId: r.processStepCodeId,
    stepCode: r.processStepCode.code, stepName: r.processStepCode.name,
    // The GL account rides along on the read so `createInvoice` never has to re-walk step codes
    // to find the account a revenue line posts to (5A §3.4's whole reason for this restructure).
    glAccountId: r.processStepCode.glAccountId,
    glAccountName: r.processStepCode.glAccount?.name ?? "",
    position: r.position,
    setupCharge: r.setupCharge?.toNumber() ?? null,
    unitPrice: r.unitPrice?.toNumber() ?? null,
    minimumCharge: r.minimumCharge?.toNumber() ?? null,
    pricePer: r.pricePer,
    breaks: r.breaks.map((b) => ({ id: b.id, threshold: b.threshold.toNumber(), price: b.price.toNumber() })),
  }));
}
```

  Then the six mutators. The rules each must enforce, with the exact messages the tests above assert:
  - `addPartPrice` — part must be live (404 `"Part not found"`); `assertRefExists("processStepCode", …, tx)`; a live row for that `(partId, processStepCodeId)` refuses 400 `"That operation is already priced on this part"` via `findFirst({ where: { partId, processStepCodeId, deletedAt: null } })` (**never `findUnique`** — the column pair is unique only among live rows). Serializable, because it assigns a registered FK.
  - `updatePartPrice` — `claimLive(tx, priceId, partId, patch)`; when the patch sets `pricePer: "LOT"`, first count live breaks and refuse 400 `LOT_WITH_BREAKS` if any; re-check the duplicate-operation rule when `processStepCodeId` changes. Serializable whenever it assigns the FK **or** touches `pricePer` — the latter is the write-skew partner of `addPriceBreak`'s LOT read, exactly as `addPartBreak`/`updatePart` were paired before.
  - `deletePartPrice` — `auditedSoftDelete("partPrice", priceId, undefined, tx)` after confirming the row is live and scoped to the part. **Its breaks are left as they are**: the row is gone from every live read, and soft-deleting children individually would write audit noise for rows nothing can reach.
  - `addPriceBreak` / `updatePriceBreak` / `deletePriceBreak` — the deleted file's bodies with `partId` swapped for `partPriceId`, plus a scoping read that the price row is live **and** belongs to `partId` (404 `"Price row not found"`), and the `pricePer === "LOT"` refusal reading the price row rather than the part.

- [ ] **Step 4: Run the tests** — `npx vitest run tests/part-prices.test.ts`. Expected: PASS.

- [ ] **Step 5: The four routes.** Copy `src/app/api/parts/[id]/breaks/route.ts` and its `[breakId]` sibling, re-pathed and re-scoped. **Every one keeps `mustDo(user, "change_prices")` unconditionally** — pricing is gated by that named action, not by `parts.edit` alone. Params for the nested ones: `{ params: Promise.resolve({ id, priceId, breakId }) }`.

- [ ] **Step 6: Confirm Task 2's deletions held** — `src/server/part-price-breaks.ts`, its tests, its two routes, `PRICING_FIELDS` and the two parts-route guards are all gone, and `npx tsc --noEmit` is clean with only the new surface in place.

- [ ] **Step 7: Confirm the sweeps** — `npx vitest run tests/reference-links-sweep.test.ts tests/partial-unique-sweep.test.ts tests/permissions-sweep.test.ts`. All green.

- [ ] **Step 8: Gates + commit** — `feat(parts): price rows keyed by process step code, replacing the part's price columns`

---

### Task 5: Part page — the Pricing section rebuilt on price rows

> **Carried in from Task 4's review (2026-08-06) — this task owns the UI half of it.**
> `updatePartPrice` will move a price row's basis among the **non-LOT** units (EACH → LB →
> PER_1000) while that row still has live breaks, and a break's `threshold` is defined as being
> expressed *in the parent row's price-per unit* (`schema.prisma:490`). So changing the basis
> silently changes what every existing threshold means — a 500-piece break becomes a 500-pound
> break with no warning and no re-statement. The LOT case is already refused in the service
> (LOT cannot carry breaks at all); this is the unguarded gap among the other three units. The old
> flat-column surface behaved the same way, and no requirement covers it, so it was deliberately
> NOT fixed in Task 4.
>
> **Decide and implement the UI behavior here:** warn on the basis change, refuse it while live
> breaks exist, or offer to re-state the thresholds. If you believe the right answer is a service
> guard rather than a UI one, say so and stop — that is a plan change, not your call. Task 9 owns
> what the pricing engine does with a row whose breaks predate a basis change.

**Files:**
- Modify: `src/app/parts/[id]/PricingSection.tsx` (full rewrite), `src/app/parts/[id]/page.tsx` (the `Part` type loses the four pricing fields)
- Test: browser verification (below) — this component has no vitest seam

**Interfaces:**
- Consumes: `listPartPrices` / `addPartPrice` / `updatePartPrice` / `deletePartPrice` / `addPriceBreak` / `updatePriceBreak` / `deletePriceBreak` via the Task 4 routes; `PartPriceRow` (shape above); `gate` / `gateDo` (`src/lib/permission-ui.ts:13,19`); `PRICE_PER_LABELS` (`src/lib/part-constants.ts`).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Rewrite the component.** Keep everything the old one got right — it is being replaced for its *shape*, not its behaviour:
  - the **double gate** computed once (`const disabled = canEdit.disabled || priceGate.disabled; const title = canEdit.disabled ? canEdit.title : priceGate.title;`) — a user holding `change_prices` but not `parts.edit` must see the edit gate's reason, not the pricing one (the existing comment explains why; carry it over);
  - the single `focusedValue` ref + `noteFocus` / blur-save idiom, so a blur that changed nothing issues no request;
  - **roll back to server truth FIRST, then report why** (§5.13) on a failed optimistic save;
  - server messages surfaced verbatim — no client re-paraphrasing of `"A LOT-priced operation cannot carry price breaks"`.

  What changes: instead of four part-level inputs plus one flat break table, render **one card per price row** — a step-code select (options from `/api/picklists/processStepCode`), setup / unit price / minimum / price-per, and that row's own nested break table with its own add-row. Plus an **Add operation** button and a per-row **Remove operation**. Row order follows `position`; give each row up/down buttons that PATCH `position` rather than a drag handle (the codebase has no drag idiom and the invoice prints in this order).

- [ ] **Step 2: Update `src/app/parts/[id]/page.tsx`** — delete `setupCharge` / `unitPrice` / `minimumCharge` / `pricePer` from the `Part` type and from anything that spreads it into `save()`. `PricingSection` no longer needs `save` or `patchDraft` props at all; it owns its own fetches. **Task 2 deleted the old `PricingSection.tsx` outright and removed its usage** — you are creating the file fresh and re-adding the `<PricingSection …>` element, not editing a stub. There is no marker to remove.

- [ ] **Step 3: Verify in a real browser** — vitest cannot see a rendering or state bug, and this section has no server seam left to test through. Drive the bundled Chromium directly per HANDOFF §5a (`npx playwright install chromium` once, then a small `.mjs` against `npm run dev`). Confirm: two priced operations save and reload in position order; a break added under one row does not appear under the other; switching a row to **Lot** while it holds a break shows the server's refusal and leaves the row unchanged; and a user without `change_prices` sees every control **disabled with a title**, not hidden. **Clear the fixtures out of the DEV database afterwards** (`erp`, not `erp_test`).

- [ ] **Step 4: Gates + commit** — `feat(parts): pricing section rebuilt on per-operation price rows`

---

### Task 6: `surcharges.ts` — definitions, the step-code list, customer overrides

**Files:**
- Create: `src/server/surcharges.ts`
- Modify: `src/lib/reference-links.ts`, `tests/reference-links-sweep.test.ts`
- Test: `tests/surcharges.test.ts`

**Interfaces:**
- Consumes: `assertRefExists`, `findBlockers` (`src/server/reference-blockers.ts:23`), `TARGET_LABELS`, the `SURCHARGE_KINDS` / `SURCHARGE_SCOPES` constants from Task 1.
- Produces:
```ts
// src/server/surcharges.ts
export type SurchargeRow = {
  id: string; name: string; kind: SurchargeKindValue;
  rate: number | null; amount: number | null; minimumAmount: number | null;
  glAccountId: string | null; glAccountName: string | null; needsGlAccount: boolean;
  scope: SurchargeScopeValue; position: number; active: boolean;
  stepCodeIds: string[];
};
export async function listSurcharges(opts?: { includeInactive?: boolean }): Promise<SurchargeRow[]>;
export async function createSurcharge(input: unknown): Promise<{ id: string }>;
export async function updateSurcharge(id: string, input: unknown): Promise<void>;
export async function deleteSurcharge(id: string): Promise<void>;
export async function setSurchargeStepCodes(id: string, stepCodeIds: string[]): Promise<void>;

export type CustomerSurchargeRow = {
  surchargeId: string; surchargeName: string;
  optOut: boolean; rate: number | null; amount: number | null;
};
export async function listCustomerSurcharges(customerId: string): Promise<CustomerSurchargeRow[]>;
export async function setCustomerSurcharge(customerId: string, surchargeId: string, input: unknown): Promise<void>;
```

- [ ] **Step 1: Write the failing tests** `tests/surcharges.test.ts` on the same harness:

```ts
it("creates a percent surcharge and lists it with its GL account name", async () => {
  const gl = await prisma.glAccount.create({ data: { name: "4200", description: "Energy surcharge" } });
  await asSystem(() => createSurcharge({
    name: "EnergySur", kind: "PERCENT", rate: "0.040000", glAccountId: gl.id, scope: "ALL", position: 1 }));
  const rows = await listSurcharges();
  expect(rows[0].name).toBe("EnergySur");
  expect(rows[0].rate).toBe(0.04);
  expect(rows[0].glAccountName).toBe("4200");
  expect(rows[0].needsGlAccount).toBe(false);
});

it("requires a rate for PERCENT and an amount for FLAT, and rejects both", async () => {
  await expect(asSystem(() => createSurcharge({ name: "A", kind: "PERCENT", position: 1 })))
    .rejects.toThrow("A percent surcharge needs a rate");
  await expect(asSystem(() => createSurcharge({ name: "B", kind: "FLAT", position: 1 })))
    .rejects.toThrow("A flat surcharge needs an amount");
  await expect(asSystem(() => createSurcharge({
    name: "C", kind: "PERCENT", rate: "0.04", amount: "5.00", position: 1 })))
    .rejects.toThrow("A percent surcharge cannot also carry a flat amount");
});

it("re-uses a soft-deleted name as a genuinely new row", async () => {
  const { id: first } = await asSystem(() => createSurcharge({ name: "EnergySur", kind: "FLAT", amount: "5.00", position: 1 }));
  await asSystem(() => deleteSurcharge(first));
  const { id: second } = await asSystem(() => createSurcharge({ name: "EnergySur", kind: "FLAT", amount: "6.00", position: 1 }));
  expect(second).not.toBe(first);
});

it("replaces the step-code list wholesale", async () => {
  const a = await prisma.processStepCode.create({ data: { code: "AUST", name: "Austemper" } });
  const b = await prisma.processStepCode.create({ data: { code: "WASH", name: "Hot wash" } });
  const { id } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", scope: "EXCLUDE", position: 1 }));
  await asSystem(() => setSurchargeStepCodes(id, [a.id, b.id]));
  await asSystem(() => setSurchargeStepCodes(id, [b.id]));
  const rows = await listSurcharges();
  expect(rows[0].stepCodeIds).toEqual([b.id]);
});

it("refuses to delete a surcharge a customer rule points at, and names the blocker", async () => {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
  const { id } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", position: 1 }));
  await asSystem(() => setCustomerSurcharge(customer.id, id, { optOut: true }));
  await expect(asSystem(() => deleteSurcharge(id))).rejects.toThrow(/still in use by 1 record/);
  const blockers = await findBlockers("surcharge", id);
  expect(blockers[0].entityLabel).toBe("Customer");
  expect(blockers[0].name).toContain("ACME");
});

// Task 2 hand-wrote SURCHARGE_VIA_STEP_CODE to repair a defect in this plan's own registry
// snippet; its displayName/blockerId have never run. SurchargeStepCode is a join row with no
// name of its own, so without them a blocker panel would show a bare cuid at a person.
it("refuses to delete a step code a surcharge scopes on, naming the surcharge", async () => {
  const code = await prisma.processStepCode.create({ data: { code: "WASH", name: "Hot wash" } });
  const { id } = await asSystem(() => createSurcharge({
    name: "EnergySur", kind: "FLAT", amount: "1.00", scope: "EXCLUDE", position: 1 }));
  await asSystem(() => setSurchargeStepCodes(id, [code.id]));
  await expect(asSystem(() => deleteStepCode(code.id))).rejects.toThrow(/still in use by 1 record/);
  const blockers = await findBlockers("processStepCode", code.id);
  expect(blockers.some((b) => b.name.includes("EnergySur"))).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/surcharges.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Make `surcharge` a `BlockerTarget`** — all four edits in one commit-step so the sweep is never red:
  - `src/lib/reference-links.ts`: `export type BlockerTarget = ReferenceKind | "processStepCode" | "surcharge";`, `TARGET_LABELS` gains `surcharge: "surcharge"` (widen its type to `Record<"processStepCode" | "surcharge", string>`), `ReferenceLinkModel` gains `"customerSurcharge"` and `"invoiceLine"` (the latter is already added in Task 2), and two entries:

```ts
{ model: "customerSurcharge", column: "surchargeId", targetKind: "surcharge",
  label: "Surcharge", entityLabel: "Customer",
  detailPath: (id) => `/customers/${id}`,
  include: { customer: { select: { id: true, code: true, name: true } } },
  blockerId: (r) => String((r.customer as { id: string }).id),
  displayName: (r) => {
    const c = r.customer as { code: string; name: string };
    return `${c.code} · ${c.name}`;
  } },
{ model: "invoiceLine", column: "surchargeId", targetKind: "surcharge",
  label: "Surcharge", ...INVOICE_VIA_LINE },
```

  - `tests/reference-links-sweep.test.ts`: add `kinds.add("surcharge");` beside the existing `kinds.add("processStepCode");` (line 55), with a comment saying why — a surcharge is a maintained table with a delete guard, exactly like a step code, and an unregistered FK aimed at it must fail the sweep.

- [ ] **Step 4: Write `src/server/surcharges.ts`.** `createSurcharge` / `updateSurcharge` follow `createStepCode` / `updateStepCode` verbatim (`process-step-codes.ts:86-125`) — `findFirst` on the live name, conditional Serializable when `glAccountId` is assigned, `assertRefExists("glAccount", …, tx)` inside the transaction. `deleteSurcharge` follows `deleteStepCode` (`:142-148`) — `findBlockers("surcharge", id, tx)` inside one Serializable transaction, refusing with ``That ${TARGET_LABELS.surcharge} is still in use by ${blockers.length} record(s)``. `setSurchargeStepCodes` is a **replace grid with no soft delete** — `deleteMany({ where: { surchargeId } })` then `createMany`, inside `auditedUpdate("surcharge", id, …, { tx })` so one audit row describes the whole replacement, with `assertRefExists("processStepCode", …, tx)` per id and Serializable.

  The kind/amount consistency rules live in a zod `.superRefine`, not in the service body, so the messages are field-anchored:

```ts
const SAVE = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(SURCHARGE_KINDS),
  rate: decimalField(9, 6, { min: "nonnegative" }),
  amount: decimalField(12, 2, { min: "nonnegative" }),
  minimumAmount: decimalField(12, 2, { min: "nonnegative" }),
  glAccountId: z.string().nullable().optional(),
  scope: z.enum(SURCHARGE_SCOPES).optional(),
  position: z.number().int().min(0),
  active: z.boolean().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.kind === "PERCENT") {
    if (v.rate == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rate"], message: "A percent surcharge needs a rate" });
    if (v.amount != null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amount"], message: "A percent surcharge cannot also carry a flat amount" });
  } else {
    if (v.amount == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amount"], message: "A flat surcharge needs an amount" });
    if (v.rate != null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rate"], message: "A flat surcharge cannot also carry a rate" });
  }
});
```

  `needsGlAccount: r.glAccountId === null` mirrors `listStepCodes` (`process-step-codes.ts:80`) — surfaced in the UI now, asserted by 5C's export later.

- [ ] **Step 5: Run the tests** — `npx vitest run tests/surcharges.test.ts tests/reference-links-sweep.test.ts`. Expected: PASS.
- [ ] **Step 6: Gates + commit** — `feat: surcharge definitions with per-operation scope and customer overrides`

---

### Task 7: Admin → Surcharges page + routes

**Files:**
- Create: `src/app/api/admin/surcharges/route.ts`, `src/app/api/admin/surcharges/[id]/route.ts`, `src/app/api/admin/surcharges/[id]/step-codes/route.ts`, `src/app/api/admin/surcharges/[id]/blockers/route.ts`, `src/app/api/admin/surcharges/[id]/blockers/export/route.ts`, `src/app/admin/surcharges/page.tsx`
- Modify: `src/app/admin/page.tsx`
- Test: `tests/surcharges.test.ts` (route cases appended)

**Interfaces:**
- Consumes: everything Task 6 produces; `findBlockers("surcharge", id)`; `BlockerPanel` (`src/app/parts/[id]/…` — the shared component 2C-2 added).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Route tests** appended to `tests/surcharges.test.ts` — 401 unauthenticated, 403 without `admin.view` on GET and without `admin.edit` on POST/PUT/DELETE, 200 with them. `handler(request, { params: Promise.resolve({ id }) })`.
- [ ] **Step 2: The five routes**, copied from `src/app/api/admin/step-codes/**` and re-pointed at `surcharges.ts`. `mustCan(requireUser(), "admin", "view" | "edit")`. The blockers pair is a straight copy with `"processStepCode"` swapped for `"surcharge"`.
- [ ] **Step 3: The page** `src/app/admin/surcharges/page.tsx`, modelled on `src/app/admin/step-codes/page.tsx`: a list of surcharges with inline edit, a **needs GL account** badge, the kind/rate/amount/minimum controls (rate shown as a percent and stored as a decimal — label it `%` and divide by 100 on save, so `4` on screen stores `0.040000`), a scope selector, and — when scope is not `ALL` — a multi-select of process step codes from `/api/picklists/processStepCode`. Delete shows the `BlockerPanel` with its Excel export on refusal. All controls gate on `admin.edit`, **disabled with a title, never hidden**.
- [ ] **Step 4: Verify in a real browser** per HANDOFF §5a — create a surcharge, set scope `EXCLUDE` with two step codes, reload, confirm both persist; delete one that a customer rule points at and confirm the blocker panel names the customer and links to it. Clear fixtures from the DEV database afterwards.
- [ ] **Step 5: Gates + commit** — `feat(admin): surcharges page with scope, GL account and blocker panel`

---

### Task 8: Customer-side — surcharge overrides, tax rate, cert suppression

> **PLAN HOLE CLOSED (2026-08-07, from Task 6's review). This task now owns a DELETE route.**
> As originally written, this phase gave a customer surcharge override **no removal path at all**:
> Task 6's interface had only `listCustomerSurcharges`/`setCustomerSurcharge`, Task 7's route is
> GET + PUT, and this task's UI consumed those. But a live `CustomerSurcharge` row **blocks
> deletion of the surcharge it points at** (`reference-links.ts:192-200`), and `optOut: false`
> still leaves the row — so creating one override made that surcharge undeletable forever. That is
> precisely the shape `reference-blockers.ts:12-22` names as the Visual Shop dead end this system
> exists to escape: "a block without discoverability looks like data integrity while actually
> being a permanent dead end."
>
> **Task 6's fix wave already added the service half:** `deleteCustomerSurcharge(customerId,
> surchargeId)`, a soft delete through `auditedSoftDelete` (the row has `deletedAt`), 404 if no
> live override exists for the pair, with a test proving a soft-deleted override actually frees
> the blocked surcharge delete.
>
> **What this task owes:** a `DELETE` on `src/app/api/customers/[id]/surcharges/route.ts` calling
> it, gated exactly like the PUT — `mustCan(requireUser(), "customers", "edit")` **plus**
> `mustDo(user, "change_prices")`, since removing an override is a price change just as setting
> one is — and a control in the customer UI that reaches it. Removing an override must be as
> discoverable as adding one.
>
> **Two more carried in from Task 6's re-review, both this task's to honor:**
>
> 1. **The surcharge editor must post the WHOLE row, not a partial patch.** Task 6 fixes its
>    headline defect with normalize-on-write: `updateSurcharge` pins every optional column to its
>    explicit empty value, so a payload that omits a field CLEARS it. That is the coherent reading
>    of the whole-row `SAVE` design and it is deliberate — but it means
>    `updateSurcharge(id, {name, kind, amount, position})` on an inactive surcharge silently
>    re-activates it and wipes `minimumAmount`. `SAVE` still marks `scope`/`active` `.optional()`,
>    so nothing in the type system forces your form to submit them. **Submit every field.**
> 2. **An override belonging to a soft-deleted customer still blocks its surcharge.** The
>    `customerSurcharge → surcharge` registry entry (`reference-links.ts:192-200`) takes the
>    default `liveWhere` on the override row only, so the blocker panel will link at
>    `/customers/{deletedId}`. `deleteCustomerSurcharge` is the escape hatch — but only if this
>    task exposes it somewhere reachable for that case. Pre-existing, and Task 6's fix is what
>    makes it reachable at all; decide deliberately how a deleted customer's override gets cleared
>    rather than discovering it from a support call.

**Files:**
- Modify: `src/server/customers.ts`, `src/app/customers/[id]/page.tsx`
- Create: `src/app/api/customers/[id]/surcharges/route.ts`
- Test: `tests/customers.test.ts` (appended), `tests/surcharges.test.ts` (appended)

**Interfaces:**
- Consumes: `listCustomerSurcharges` / `setCustomerSurcharge` (Task 6).
- Produces: `CustomerRow` gains `salesTaxRate: number | null` and `certChargeSuppressed: boolean`.

- [ ] **Step 1: Write the failing tests** in `tests/customers.test.ts`:

```ts
it("stores a per-customer sales tax rate and cert suppression", async () => {
  const { id } = await asSystem(() => createCustomer({ code: "ACME", name: "Acme" }));
  await asSystem(() => updateCustomer(id, { salesTaxRate: "0.045000", certChargeSuppressed: true }));
  const row = await getCustomer(id);
  expect(row.salesTaxRate).toBe(0.045);
  expect(row.certChargeSuppressed).toBe(true);
});

it("rejects a sales tax rate with too many decimals", async () => {
  const { id } = await asSystem(() => createCustomer({ code: "ACME", name: "Acme" }));
  await expect(asSystem(() => updateCustomer(id, { salesTaxRate: "0.0450001" })))
    .rejects.toThrow(/at most 3 digits before and 6 digits after/);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/customers.test.ts`. Expected: FAIL, unrecognized keys (the customer schema is `.strict()`).
- [ ] **Step 3: Extend `src/server/customers.ts`** — add `salesTaxRate: decimalField(9, 6, { min: "nonnegative" })` and `certChargeSuppressed: z.boolean().optional()` to the zod object, both columns to the `SELECT`, `salesTaxRate` to the Decimal→number mapping, and both fields to `CustomerRow`. This mirrors `creditLimit` / `financeChargeRate` exactly (`customers.ts:42-43, 50-59, 73-94`).
- [ ] **Step 4: The customer surcharges route** — GET lists, PUT upserts one `{ surchargeId, optOut, rate, amount }`. `mustCan(requireUser(), "customers", "view" | "edit")`, plus `mustDo(user, "change_prices")` on the PUT: a per-customer surcharge override is a price change, and `change_prices` is the action that exists for it.
- [ ] **Step 5: The customer page** — add "Sales tax rate" and "Suppress certification charge" beside the existing Taxable / COD / Surcharge opt-out controls (`src/app/customers/[id]/page.tsx:480-560`), and a **Surcharge overrides** section listing every active surcharge with per-row opt-out and rate/amount override. Gate the section on `customers.edit` **and** `change_prices`, computed once, with the same "whichever is actually the blocker" title rule as the parts Pricing section.
- [ ] **Step 6: Run the tests** — `npx vitest run tests/customers.test.ts tests/surcharges.test.ts`. Expected: PASS.
- [ ] **Step 7: Gates + commit** — `feat(customers): sales tax rate, certification charge suppression, per-surcharge overrides`

---

### Task 9: `pricing.ts` — the pure resolution engine

> **Two things carried in from Task 4's review (2026-08-06).**
>
> 1. **There is no effective dating on price rows.** `PartPrice` has no effective-from/to columns
>    and never did. Do not build date-window selection, and do not assume a price row can be
>    scheduled. What guarantees a deterministic winner is the **live partial unique
>    `(partId, processStepCodeId)`** — exactly one live row per operation per part — plus explicit
>    `orderBy` on the rows (`position asc, id asc`) and on their breaks (`threshold asc`), both
>    already in `listPartPrices`. Rely on those, and do not re-derive an ordering of your own.
> 2. **A row's breaks can predate a change to its basis.** `updatePartPrice` permits moving a row
>    among the non-LOT units while live breaks exist, and `threshold` is expressed in the parent
>    row's price-per unit — so a stored threshold may have been entered under a different unit
>    than the row now carries. Task 5 owns the UI half; decide here what the engine does when it
>    meets such a row, and make the choice explicit in the code rather than implicit in the
>    arithmetic.

**Files:**
- Create: `src/server/pricing.ts`
- Test: `tests/pricing.test.ts`

**Interfaces:**
- Consumes: type-only imports of `PricePerValue` (`src/lib/part-constants.ts`) and the Task 1 constants. **Nothing else.** No Prisma, no `./db`, no other `src/server/` module — this module must stay importable with zero side effects, and its test file must not touch the database.
- Produces:
```ts
// src/server/pricing.ts
export type PriceBreakInput = { threshold: number; price: number };
export type PriceRowInput = {
  processStepCodeId: string; stepCode: string; stepName: string; position: number;
  setupCharge: number | null; unitPrice: number | null; minimumCharge: number | null;
  pricePer: PricePerValue; breaks: PriceBreakInput[];
  glAccountId: string | null; glAccountName: string;
};
export type OrderLineInput = {
  orderLineId: string; position: number;
  partNumber: string; partName: string; partDescription: string; eachWeight: number;
  shippedQty: number; shippedWeight: number;
  prices: PriceRowInput[];
};
export type SurchargeInput = {
  surchargeId: string; name: string; kind: SurchargeKindValue;
  rate: number | null; amount: number | null; minimumAmount: number | null;
  scope: SurchargeScopeValue; stepCodeIds: string[]; position: number;
  glAccountId: string | null; glAccountName: string;
};
export type ChargeInput = { orderChargeId: string; position: number; description: string; amount: number | null };
export type GlRef = { glAccountId: string | null; glAccountName: string };
export type PricingInput = {
  lines: OrderLineInput[];
  surcharges: SurchargeInput[];
  charges: ChargeInput[];
  freight: (GlRef & { amount: number }) | null;
  cert: (GlRef & { amount: number; description: string }) | null;
  tax: (GlRef & { rate: number }) | null;
};
export type ComputedLine = {
  key: string; parentKey: string | null; kind: InvoiceLineKindValue;
  orderLineId: string | null; processStepCodeId: string | null;
  surchargeId: string | null; orderChargeId: string | null;
  glAccountId: string | null; glAccountName: string;
  partNumber: string; partName: string; partDescription: string; description: string;
  qty: number | null; weight: number | null; eachWeight: number | null;
  pricePer: PricePerValue | null;
  unitPrice: number | null; setupCharge: number | null; minimumCharge: number | null;
  breakThreshold: number | null; minimumApplied: boolean;
  rate: number | null; priceSource: PriceSourceValue | null; needsPrice: boolean;
  amount: number;
};
export type PricingResult = {
  lines: ComputedLine[];
  subtotal: number; surchargeTotal: number; chargeTotal: number;
  certTotal: number; freightTotal: number; taxTotal: number; total: number;
};
export function roundCents(value: number): number;
export function selectBreak(row: PriceRowInput, qty: number, weight: number): PriceBreakInput | null;
export function priceOrder(input: PricingInput): PricingResult;
```

- [ ] **Step 1: Write the failing tests** `tests/pricing.test.ts`. **No `truncateAll`, no `prisma` import** — this file is pure unit tests. Start with the golden case, which is the owner's own invoice:

```ts
import { describe, it, expect } from "vitest";
import { priceOrder, selectBreak, roundCents, type PricingInput, type PriceRowInput } from "@/server/pricing";

const GL = { glAccountId: "gl1", glAccountName: "4010" };

function row(over: Partial<PriceRowInput> = {}): PriceRowInput {
  return {
    processStepCodeId: "sc1", stepCode: "AUST", stepName: "Austemper", position: 1,
    setupCharge: null, unitPrice: 6.51, minimumCharge: 600, pricePer: "EACH", breaks: [],
    ...GL, ...over,
  };
}

function input(over: Partial<PricingInput> = {}): PricingInput {
  return {
    lines: [{
      orderLineId: "ol1", position: 1,
      partNumber: "A16-21591-000", partName: "EQUALIZER-RR SUSP", partDescription: "",
      eachWeight: 21, shippedQty: 144, shippedWeight: 3024, prices: [row()],
    }],
    surcharges: [], charges: [], freight: null, cert: null, tax: null,
    ...over,
  };
}

describe("pricing — the sample invoice", () => {
  it("reproduces docs/samples/Invoice Sample.pdf exactly", () => {
    const result = priceOrder(input({
      surcharges: [{
        surchargeId: "s1", name: "EnergySur", kind: "PERCENT", rate: 0.04,
        amount: null, minimumAmount: null, scope: "ALL", stepCodeIds: [], position: 1,
        glAccountId: "gl2", glAccountName: "4200",
      }],
    }));
    const operation = result.lines.find((l) => l.kind === "OPERATION")!;
    expect(operation.amount).toBe(937.44);          // 144 × 6.51, above the 600 minimum
    expect(operation.minimumApplied).toBe(false);
    const surcharge = result.lines.find((l) => l.kind === "SURCHARGE")!;
    expect(surcharge.amount).toBe(37.5);            // 4% of 937.44 = 37.4976, half-up
    expect(result.subtotal).toBe(937.44);
    expect(result.total).toBe(974.94);
  });

  it("emits a PART line carrying quantities and no money", () => {
    const part = priceOrder(input()).lines.find((l) => l.kind === "PART")!;
    expect(part.qty).toBe(144);
    expect(part.weight).toBe(3024);
    expect(part.eachWeight).toBe(21);
    expect(part.amount).toBe(0);
    expect(part.parentKey).toBeNull();
  });

  it("hangs OPERATION lines off their PART line", () => {
    const { lines } = priceOrder(input());
    const part = lines.find((l) => l.kind === "PART")!;
    const op = lines.find((l) => l.kind === "OPERATION")!;
    expect(op.parentKey).toBe(part.key);
  });
});

describe("pricing — price-per bases", () => {
  const bases: [PriceRowInput["pricePer"], number][] = [
    ["EACH", 937.44],       // 144 × 6.51
    ["PER_100", 9.37],      // 144/100 × 6.51 = 9.3744 → 9.37
    ["PER_1000", 0.94],     // 144/1000 × 6.51 = 0.937 → 0.94
    ["LB", 19686.24],       // 3024 × 6.51
    ["LOT", 6.51],          // flat
  ];
  for (const [pricePer, expected] of bases) {
    it(`prices ${pricePer}`, () => {
      const result = priceOrder(input({
        lines: [{ ...input().lines[0], prices: [row({ pricePer, minimumCharge: null })] }],
      }));
      expect(result.lines.find((l) => l.kind === "OPERATION")!.amount).toBe(expected);
    });
  }
});

describe("pricing — breaks", () => {
  const breaks = [{ threshold: 100, price: 6.0 }, { threshold: 500, price: 5.0 }];

  it("takes the highest threshold at or below the basis", () => {
    expect(selectBreak(row({ breaks }), 99, 0)).toBeNull();
    expect(selectBreak(row({ breaks }), 100, 0)!.price).toBe(6);   // exactly on
    expect(selectBreak(row({ breaks }), 499, 0)!.price).toBe(6);
    expect(selectBreak(row({ breaks }), 500, 0)!.price).toBe(5);   // exactly on
    expect(selectBreak(row({ breaks }), 100000, 0)!.price).toBe(5);
  });

  it("compares an LB row against weight, every other unit against quantity", () => {
    expect(selectBreak(row({ breaks, pricePer: "LB" }), 10, 600)!.price).toBe(5);
    expect(selectBreak(row({ breaks, pricePer: "EACH" }), 10, 600)).toBeNull();
  });

  it("records the winning threshold on the line", () => {
    const result = priceOrder(input({
      lines: [{ ...input().lines[0], prices: [row({ breaks, minimumCharge: null })] }],
    }));
    const op = result.lines.find((l) => l.kind === "OPERATION")!;
    expect(op.breakThreshold).toBe(100);
    expect(op.unitPrice).toBe(6);
    expect(op.amount).toBe(864);   // 144 × 6.00
  });
});

describe("pricing — minimum and setup", () => {
  it("floors at the minimum and flags it", () => {
    const result = priceOrder(input({
      lines: [{ ...input().lines[0], shippedQty: 10, shippedWeight: 210,
                prices: [row({ minimumCharge: 600 })] }],
    }));
    const op = result.lines.find((l) => l.kind === "OPERATION")!;
    expect(op.amount).toBe(600);         // 10 × 6.51 = 65.10, floored
    expect(op.minimumApplied).toBe(true);
  });

  it("adds setup ON TOP of the minimum, never inside it (ruling 13)", () => {
    const result = priceOrder(input({
      lines: [{ ...input().lines[0], shippedQty: 10, shippedWeight: 210,
                prices: [row({ minimumCharge: 600, setupCharge: 75 })] }],
    }));
    expect(result.lines.find((l) => l.kind === "OPERATION")!.amount).toBe(675);
  });
});

describe("pricing — needs price", () => {
  it("bills a line with no price rows at zero and flags it", () => {
    const result = priceOrder(input({ lines: [{ ...input().lines[0], prices: [] }] }));
    const op = result.lines.find((l) => l.kind === "OPERATION")!;
    expect(op.amount).toBe(0);
    expect(op.needsPrice).toBe(true);
    expect(op.processStepCodeId).toBeNull();
  });

  it("flags a priced row carrying neither a unit price nor a minimum", () => {
    const result = priceOrder(input({
      lines: [{ ...input().lines[0], prices: [row({ unitPrice: null, minimumCharge: null })] }],
    }));
    expect(result.lines.find((l) => l.kind === "OPERATION")!.needsPrice).toBe(true);
  });

  it("flags an extra charge with no amount", () => {
    const result = priceOrder(input({
      charges: [{ orderChargeId: "c1", position: 1, description: "Rush", amount: null }],
    }));
    const charge = result.lines.find((l) => l.kind === "CHARGE")!;
    expect(charge.needsPrice).toBe(true);
    expect(charge.amount).toBe(0);
  });
});

describe("pricing — surcharge scope", () => {
  const twoOps = {
    ...input().lines[0],
    prices: [
      row({ processStepCodeId: "sc1", stepCode: "AUST", unitPrice: 1, minimumCharge: null, position: 1 }),
      row({ processStepCodeId: "sc2", stepCode: "WASH", unitPrice: 2, minimumCharge: null, position: 2 }),
    ],
  };
  const surcharge = (over: object) => ({
    surchargeId: "s1", name: "S", kind: "PERCENT" as const, rate: 0.1,
    amount: null, minimumAmount: null, scope: "ALL" as const, stepCodeIds: [], position: 1,
    glAccountId: null, glAccountName: "", ...over,
  });

  it("ALL bills every operation line", () => {
    const r = priceOrder(input({ lines: [twoOps], surcharges: [surcharge({})] }));
    expect(r.surchargeTotal).toBe(43.2);        // 10% of (144 + 288)
  });

  it("INCLUDE bills only the listed step codes", () => {
    const r = priceOrder(input({ lines: [twoOps],
      surcharges: [surcharge({ scope: "INCLUDE", stepCodeIds: ["sc2"] })] }));
    expect(r.surchargeTotal).toBe(28.8);        // 10% of 288
  });

  it("EXCLUDE bills everything but the listed step codes", () => {
    const r = priceOrder(input({ lines: [twoOps],
      surcharges: [surcharge({ scope: "EXCLUDE", stepCodeIds: ["sc2"] })] }));
    expect(r.surchargeTotal).toBe(14.4);        // 10% of 144
  });

  it("applies a flat amount and floors at the minimum", () => {
    const flat = priceOrder(input({ lines: [twoOps],
      surcharges: [surcharge({ kind: "FLAT", rate: null, amount: 5 })] }));
    expect(flat.surchargeTotal).toBe(5);
    const floored = priceOrder(input({ lines: [twoOps],
      surcharges: [surcharge({ rate: 0.001, minimumAmount: 25 })] }));
    expect(floored.surchargeTotal).toBe(25);
  });

  it("emits nothing when no operation line qualifies, even with a minimum", () => {
    const r = priceOrder(input({ lines: [twoOps],
      surcharges: [surcharge({ scope: "INCLUDE", stepCodeIds: ["sc9"], minimumAmount: 25 })] }));
    expect(r.lines.some((l) => l.kind === "SURCHARGE")).toBe(false);
    expect(r.surchargeTotal).toBe(0);
  });
});

describe("pricing — tax", () => {
  it("taxes operations, surcharges, charges and cert — never freight", () => {
    const r = priceOrder(input({
      lines: [{ ...input().lines[0], prices: [row({ unitPrice: 1, minimumCharge: null })] }],  // 144.00
      surcharges: [], charges: [{ orderChargeId: "c1", position: 1, description: "Rush", amount: 10 }],
      cert: { amount: 25, description: "Certification", ...GL },
      freight: { amount: 100, ...GL },
      tax: { rate: 0.04, ...GL },
    }));
    expect(r.taxTotal).toBe(7.16);        // 4% of (144 + 10 + 25) = 7.16 — freight excluded
    expect(r.total).toBe(286.16);         // 144 + 10 + 25 + 100 + 7.16
  });

  it("emits no TAX line when there is no tax config", () => {
    expect(priceOrder(input()).lines.some((l) => l.kind === "TAX")).toBe(false);
  });
});

describe("roundCents", () => {
  it("rounds half away from zero and survives float error", () => {
    expect(roundCents(937.4400000000001)).toBe(937.44);
    expect(roundCents(37.4976)).toBe(37.5);
    expect(roundCents(0.125)).toBe(0.13);
    expect(roundCents(-0.125)).toBe(-0.13);
    expect(roundCents(0.124999999)).toBe(0.12);
  });
});

describe("pricing — line ordering", () => {
  it("orders PART → its OPERATIONs → SURCHARGE → FREIGHT → CHARGE → CERT → TAX", () => {
    const r = priceOrder(input({
      surcharges: [{ surchargeId: "s1", name: "S", kind: "FLAT", rate: null, amount: 5,
                     minimumAmount: null, scope: "ALL", stepCodeIds: [], position: 1,
                     glAccountId: null, glAccountName: "" }],
      charges: [{ orderChargeId: "c1", position: 1, description: "Rush", amount: 10 }],
      cert: { amount: 25, description: "Certification", ...GL },
      freight: { amount: 100, ...GL },
      tax: { rate: 0.04, ...GL },
    }));
    expect(r.lines.map((l) => l.kind)).toEqual(
      ["PART", "OPERATION", "SURCHARGE", "FREIGHT", "CHARGE", "CERT", "TAX"]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/pricing.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/server/pricing.ts`.** The whole module computes in **integer cents and ten-thousandths**, converting to dollars only at the boundary — `144 × 6.51` is `937.4400000000001` in IEEE 754 doubles, and this is legal paper:

```ts
// Pure: plain data in, computed lines out. No Prisma, no I/O, no imports from ./ — this module
// must stay importable with zero side effects, which is what lets tests/pricing.test.ts run
// without a database and makes the math reviewable in one sitting.
//
// Money never passes through a float multiplication. Prices are scaled to ten-thousandths and
// quantities/weights to their own integer units, the products are integers, and the single
// division back to cents rounds half away from zero. `144 × 6.51 = 937.4400000000001` in IEEE
// 754; the invoice says $937.44.
import type { PricePerValue } from "../lib/part-constants";
import type {
  InvoiceLineKindValue, PriceSourceValue, SurchargeKindValue, SurchargeScopeValue,
} from "../lib/invoice-constants";

// …the exported types from the Interfaces block above…

/** `numerator / divisor`, rounded half away from zero, in integers. */
function divideRound(numerator: number, divisor: number): number {
  const sign = numerator < 0 ? -1 : 1;
  const n = Math.abs(numerator);
  return sign * Math.floor((n * 2 + divisor) / (divisor * 2));
}

/** Half away from zero, to cents. The `1 + Number.EPSILON` lift is what stops a value that is
 *  a hair BELOW a half-cent purely through float error (937.4399999999999) rounding down. */
export function roundCents(value: number): number {
  const scaled = Math.abs(value) * 100 * (1 + Number.EPSILON);
  const cents = Math.round(scaled);
  return (value < 0 ? -cents : cents) / 100;
}

/** The value a break threshold is compared against: weight for an LB row, quantity for every
 *  other unit (owner ruling 2026-08-01 — the break basis follows the row's price-per unit).
 *  A LOT row can never reach here with breaks: they are refused at entry (part-prices.ts). */
function breakBasis(pricePer: PricePerValue, qty: number, weight: number): number {
  return pricePer === "LB" ? weight : qty;
}

export function selectBreak(row: PriceRowInput, qty: number, weight: number): PriceBreakInput | null {
  const basis = breakBasis(row.pricePer, qty, weight);
  let best: PriceBreakInput | null = null;
  for (const b of row.breaks) {
    if (b.threshold > basis) continue;
    if (best === null || b.threshold > best.threshold) best = b;
  }
  return best;
}

/** Extended amount in CENTS. `price` carries 4 decimals, `qty` is an integer, `weight` 2. */
function extendedCents(pricePer: PricePerValue, qty: number, weight: number, price: number): number {
  const p = Math.round(price * 10_000);
  switch (pricePer) {
    case "EACH":     return divideRound(qty * p, 100);
    case "PER_100":  return divideRound(qty * p, 100 * 100);
    case "PER_1000": return divideRound(qty * p, 100 * 1_000);
    case "LB":       return divideRound(Math.round(weight * 100) * p, 100 * 100);
    case "LOT":      return divideRound(p, 100);
  }
}
```

  `priceOrder` then composes, in exactly this order (the test above pins it):

  1. For each `line` in `position` order: a **`PART`** line — quantities, part identity, `amount: 0`, no GL. Then, for each of that line's `prices` in `position` order, an **`OPERATION`** line with `parentKey` set to the part line's key. A line with **no** price rows still gets one `OPERATION` line: `amount: 0`, `needsPrice: true`, `description: "Needs price"`, every price field null. A row with `unitPrice == null && minimumCharge == null` is likewise `needsPrice`.
     `amount = max(extendedCents, minimumCents) + setupCents`, with `minimumApplied` recorded when the floor won and `breakThreshold` recording which break did.
  2. **`SURCHARGE`** lines, in surcharge `position` order. Base = the sum of `OPERATION` line cents whose `processStepCodeId` passes the scope filter (`ALL` → all; `INCLUDE` → in `stepCodeIds`; `EXCLUDE` → not in it). **If no operation line qualifies, emit no line at all** — a minimum must not conjure a surcharge onto an invoice the surcharge does not apply to. `PERCENT` → `divideRound(base * Math.round(rate * 1e6), 1e6)`; `FLAT` → the amount in cents; then floored at `minimumAmount`. `rate` is snapshotted onto the line.
  3. **`FREIGHT`**, when `input.freight` is present — one line, description `"Freight"`.
  4. **`CHARGE`** lines, one per `charges` entry in `position` order; `amount: null` → `amount: 0, needsPrice: true`.
  5. **`CERT`**, when `input.cert` is present.
  6. **`TAX`**, when `input.tax` is present — base = operations + surcharges + charges + cert **in cents**, freight excluded; `rate` snapshotted.

  Totals are sums of the already-rounded line amounts, per bucket, and `total` is the sum of those buckets. `key` is `` `${kind}-${index}` `` — stable within one computation and only ever used to wire `parentLineId` when the caller writes rows.

- [ ] **Step 4: Run the tests** — `npx vitest run tests/pricing.test.ts`. Expected: PASS, all of them.

- [ ] **Step 5: Prove the module really is pure** — add one test asserting it, so a future edit that reaches for Prisma fails here rather than in production:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

it("imports nothing from the server or the database", () => {
  const src = readFileSync(join(process.cwd(), "src/server/pricing.ts"), "utf8");
  const imports = [...src.matchAll(/^import\s+(?:type\s+)?.*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  expect(imports.every((i) => i.startsWith("../lib/"))).toBe(true);
});
```

- [ ] **Step 6: Gates + commit** — `feat: pure pricing engine — per-operation math, breaks, minimums, surcharges, tax`

---

### Task 10: `invoice-guards.ts` + the new order and shipment invariants

**Files:**
- Create: `src/server/invoice-guards.ts`
- Modify: `src/server/orders.ts` (`replaceCharges`, `voidOrder`), `src/server/shippers.ts` (`voidShipper`, `replaceShipperLines`, `addOrderToShipper`)
- Test: `tests/invoice-guards.test.ts`

**Interfaces:**
- Consumes: `HttpError`, Prisma's `TransactionClient`. **Nothing from `invoices.ts`** — that is the whole point of this module.
- Produces:
```ts
// src/server/invoice-guards.ts — a LEAF. orders.ts, shippers.ts and invoices.ts all import it;
// it imports none of them.
export type FinalizedInvoice = { id: string; orderId: string; orderNumber: number };
export async function finalizedInvoiceFor(tx: Prisma.TransactionClient, orderId: string): Promise<FinalizedInvoice | null>;
export async function finalizedInvoicesFor(tx: Prisma.TransactionClient, orderIds: string[]): Promise<FinalizedInvoice[]>;
export function invoiceBlockMessage(inv: FinalizedInvoice, action: string): string;
```

> **Why a leaf, before the cycle exists.** `orders.ts` and `shippers.ts` need to ask "does this order have a finalized invoice?", and `invoices.ts` needs to import both of them. Importing `invoices.ts` back would be the exact edge that crashed Phase 4 at module-evaluation time two tasks after it was added (lesson 3). `order-locks.ts` and `errors.ts` are the precedents; this is the third.

- [ ] **Step 1: Write the failing tests** `tests/invoice-guards.test.ts`, using a raw `prisma.invoice.create` fixture (Task 11's service does not exist yet — that is deliberate, this module must not depend on it):

```ts
async function finalizedInvoice(orderId: string, customerId: string) {
  return prisma.invoice.create({
    data: { orderId, customerId, kind: "INVOICE", status: "FINALIZED",
            invoiceDate: new Date("2026-08-06"), finalizedAt: new Date() },
  });
}

it("finds a finalized invoice and ignores a draft or a discarded one", async () => {
  const { order, customer } = await savedOrder();
  expect(await prisma.$transaction((tx) => finalizedInvoiceFor(tx, order.id))).toBeNull();

  const draft = await prisma.invoice.create({
    data: { orderId: order.id, customerId: customer.id, kind: "INVOICE",
            status: "DRAFT", invoiceDate: new Date("2026-08-06") } });
  expect(await prisma.$transaction((tx) => finalizedInvoiceFor(tx, order.id))).toBeNull();

  await prisma.invoice.update({ where: { id: draft.id }, data: { status: "FINALIZED" } });
  const found = await prisma.$transaction((tx) => finalizedInvoiceFor(tx, order.id));
  expect(found!.orderNumber).toBe(order.orderNumber);

  await prisma.invoice.update({ where: { id: draft.id }, data: { deletedAt: new Date() } });
  expect(await prisma.$transaction((tx) => finalizedInvoiceFor(tx, order.id))).toBeNull();
});

it("ignores a finalized CREDIT — a credit does not freeze its order", async () => {
  const { order, customer } = await savedOrder();
  await prisma.invoice.create({
    data: { orderId: order.id, customerId: customer.id, kind: "CREDIT", status: "FINALIZED",
            creditNumber: 1000, invoiceDate: new Date("2026-08-06"), finalizedAt: new Date() } });
  expect(await prisma.$transaction((tx) => finalizedInvoiceFor(tx, order.id))).toBeNull();
});

it("freezes extra charges once an invoice is finalized, naming it", async () => {
  const { order, customer } = await savedOrder();
  await asSystem(() => replaceCharges(order.id, [{ description: "Rush", amount: "50.00" }]));  // fine
  await finalizedInvoice(order.id, customer.id);
  await expect(asSystem(() => replaceCharges(order.id, [{ description: "Rush", amount: "60.00" }])))
    .rejects.toThrow(new RegExp(`Invoice ${order.orderNumber}`));
});

it("refuses to void an order that has a finalized invoice", async () => {
  const { order, customer } = await savedOrder();
  await finalizedInvoice(order.id, customer.id);
  await expect(asSystem(() => voidOrder(order.id, "keyed twice")))
    .rejects.toThrow(new RegExp(`Invoice ${order.orderNumber}`));
});

it("refuses to void a shipment on an invoiced order", async () => {
  const { order, customer } = await savedOrder();
  const { shipper } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
  await finalizedInvoice(order.id, customer.id);
  await expect(voidShipper(shipper.id, "wrong truck"))
    .rejects.toThrow(new RegExp(`Invoice ${order.orderNumber}`));
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/invoice-guards.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/server/invoice-guards.ts`:**

```ts
// A LEAF, deliberately: orders.ts and shippers.ts must be able to ask "is this order invoiced?"
// without importing invoices.ts, which imports both of them. Phase 4 lesson 3 — a `const`
// consumed across a module cycle crashes at module-evaluation time, two tasks after the edge is
// added — and order-locks.ts is the precedent for pulling the shared question into a leaf BEFORE
// the cycle exists rather than after it bites.
import type { Prisma } from "../../prisma/generated/prisma/client";

export type FinalizedInvoice = { id: string; orderId: string; orderNumber: number };

/** The live, FINALIZED invoice for this order, if any. A DRAFT freezes nothing (it is still being
 *  assembled) and a CREDIT freezes nothing (it reverses an invoice, it is not one). Read on the
 *  caller's own `tx`, which is already holding that order's claim — the check and the write it
 *  guards must see the same state. */
export async function finalizedInvoiceFor(
  tx: Prisma.TransactionClient, orderId: string,
): Promise<FinalizedInvoice | null> {
  const row = await tx.invoice.findFirst({
    where: { orderId, kind: "INVOICE", status: "FINALIZED", deletedAt: null },
    select: { id: true, orderId: true, order: { select: { orderNumber: true } } },
  });
  return row === null ? null : { id: row.id, orderId: row.orderId, orderNumber: row.order.orderNumber };
}

/** The batched form, for a mutator spanning several orders (voidShipper, the reversing shipment).
 *  One query, not one per order — the `shippedTotals` shape. */
export async function finalizedInvoicesFor(
  tx: Prisma.TransactionClient, orderIds: string[],
): Promise<FinalizedInvoice[]> {
  if (orderIds.length === 0) return [];
  const rows = await tx.invoice.findMany({
    where: { orderId: { in: orderIds }, kind: "INVOICE", status: "FINALIZED", deletedAt: null },
    select: { id: true, orderId: true, order: { select: { orderNumber: true } } },
  });
  return rows.map((r) => ({ id: r.id, orderId: r.orderId, orderNumber: r.order.orderNumber }));
}

/** Names the blocker and links to it — §5.14's discoverability rule, the shape every shipment
 *  refusal in Phase 4 already uses ("Packing List 072826, linked to its page"). */
export function invoiceBlockMessage(inv: FinalizedInvoice, action: string): string {
  return `${action} — Invoice ${inv.orderNumber} is finalized; unlock it or raise a credit ` +
    `(see /invoicing/${inv.id})`;
}
```

- [ ] **Step 4: Wire the three invariants**, each inside the mutator's existing claimed transaction, **after** the claim and before any write:
  - `orders.ts` `replaceCharges` — spec §7.1's "then the invoice owns them":
    `const inv = await finalizedInvoiceFor(tx, orderId); if (inv) throw new HttpError(400, invoiceBlockMessage(inv, "Charges cannot be changed"));`
  - `orders.ts` `voidOrder` — same shape, `"This order cannot be voided"`.
  - `shippers.ts` `voidShipper` — batched over `orderIds` **after `claimLiveShipper`**, `"This shipment cannot be voided"`. Same guard in `replaceShipperLines` and `addOrderToShipper` (`"This shipment cannot be changed"`), since both change what was billed.

- [ ] **Step 5: Run the tests** — `npx vitest run tests/invoice-guards.test.ts tests/orders.test.ts tests/shippers.test.ts tests/shipper-void.test.ts`. Expected: PASS, and no existing test regresses (none of them finalize an invoice, so none is affected).
- [ ] **Step 6: Prove the leaf really is a leaf** — extend `tests/invoice-guards.test.ts` with the same import-shape assertion Task 9 used, asserting `src/server/invoice-guards.ts` imports nothing from `./orders`, `./shippers` or `./invoices`.
- [ ] **Step 7: Gates + commit** — `feat: invoice guards — charges freeze, order void and shipment edits refuse once invoiced`

---

### Task 11: `invoices.ts` — candidates and creation

**Files:**
- Create: `src/server/invoices.ts`
- Test: `tests/invoices.test.ts`

**Interfaces:**
- Consumes: `priceOrder` + its input types (Task 9), `shippedTotals` (`ship-ledger.ts:31`), `claimOrder` (`order-locks.ts:63`), `getBillingConfig` (Task 3), `listSurcharges` / `listCustomerSurcharges` (Task 6), `listPartPrices` (Task 4), `isDuplicateClientRequestId` (**exported from `src/server/orders.ts`** — reuse it, do not re-derive the P2002 sniff), `assertRefExists`, `auditedCreate`, `withDbErrors`.
- Produces:
```ts
// src/server/invoices.ts
export type InvoiceLineDetail = { /* every InvoiceLine column, Decimals as numbers */ };
export type InvoiceDetail = {
  id: string; kind: InvoiceKindValue; status: InvoiceStatusValue;
  orderId: string; orderNumber: number; documentNumber: string;   // prefix + orderNumber, or the credit number
  sourceInvoiceId: string | null; creditNumber: number | null;
  customerId: string; customerCode: string; customerName: string;
  invoiceDate: string; poNumber: string; termsName: string;
  billTo: string; shipTo: string; materialName: string; processNames: string;
  taxRate: number | null;
  subtotal: number; surchargeTotal: number; chargeTotal: number;
  certTotal: number; freightTotal: number; taxTotal: number; total: number;
  finalizedAt: string | null; deletedAt: string | null;
  lines: InvoiceLineDetail[];
};
export type InvoiceCandidate = {
  orderId: string; orderNumber: number; customerCode: string; customerName: string;
  poNumber: string; lastShipDate: string | null;
};
export type InvoiceCreateResult = { invoice: InvoiceDetail; warnings: string[]; deduped: boolean };
export async function listInvoiceCandidates(filter: { customerId?: string; from?: string; to?: string }): Promise<InvoiceCandidate[]>;
export async function readInvoiceDetail(db: Db, id: string): Promise<InvoiceDetail>;
export async function getInvoice(id: string): Promise<InvoiceDetail>;
export async function createInvoice(input: unknown): Promise<InvoiceCreateResult>;
export async function invoiceWarnings(detail: InvoiceDetail): Promise<string[]>;
```

- [ ] **Step 1: Write the fixture helpers.** Copy `asSystem`, `makeCustomer`, `makePart`, `giveSteps`, `savedOrder` and `oneOrderInput` from `tests/shippers.test.ts:1-143` into `tests/invoices.test.ts` (copying rather than importing across test files is this repo's existing convention), then add these six. **Tasks 12–15 and 19 all reuse them** — put them in a shared `tests/helpers/invoicing.ts` if a second file needs them, but they start here:

```ts
/** An order shipped to line-complete on every line → status SHIPPED. No pricing. */
async function shippedOrder(opts: { qty?: number } = {}) {
  const { order, part, customer } = await savedOrder({ qty: opts.qty ?? 144, weight: "3024.00" });
  const input = oneOrderInput(order);
  input.orders[0].lines[0].lineComplete = true;
  const { shipper } = await createShipper(input, { canOverrideCreditHold: false });
  return { order: await getOrder(order.id), part, customer, shipper };
}

/** Shipped, but nothing marked complete → status PARTIAL_SHIPPED. */
async function partiallyShippedOrder() {
  const { order, part, customer } = await savedOrder({ qty: 144, weight: "3024.00" });
  const input = oneOrderInput(order);
  input.orders[0].lines[0].qty = 10;
  const { shipper } = await createShipper(input, { canOverrideCreditHold: false });
  return { order: await getOrder(order.id), part, customer, shipper };
}

/** `shippedOrder`, plus one PartPrice row on its part and a GL account behind the step code. */
async function pricedShippedOrder(opts: {
  qty?: number; unitPrice?: string; minimumCharge?: string; setupCharge?: string;
  pricePer?: string; glAccount?: string | null;
} = {}) {
  const fixture = await shippedOrder({ qty: opts.qty });
  const gl = opts.glAccount === null ? null
    : await prisma.glAccount.create({ data: { name: opts.glAccount ?? "4010", description: "Sales" } });
  const code = await prisma.processStepCode.create({
    data: { code: "AUST", name: "Austemper", glAccountId: gl?.id ?? null } });
  await asSystem(() => addPartPrice(fixture.part.id, {
    processStepCodeId: code.id, position: 1,
    unitPrice: opts.unitPrice ?? "6.5100",
    minimumCharge: opts.minimumCharge ?? "600.00",
    ...(opts.setupCharge ? { setupCharge: opts.setupCharge } : {}),
    pricePer: opts.pricePer ?? "EACH",
  }));
  return { ...fixture, stepCode: code, glAccount: gl };
}

/** A DRAFT invoice over a priced, shipped order. `priced: false` skips the price row so every
 *  line comes back needing a price; `glAccount: null` leaves the step code without an account. */
async function draftFixture(opts: {
  qty?: number; priced?: boolean; glAccount?: string | null;
} = {}) {
  const fixture = opts.priced === false
    ? await shippedOrder({ qty: opts.qty })
    : await pricedShippedOrder({ qty: opts.qty, glAccount: opts.glAccount });
  const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
  return { ...fixture, invoice };
}

/** A FINALIZED invoice. */
async function finalizedFixture(opts: { qty?: number } = {}) {
  const fixture = await draftFixture({ qty: opts.qty });
  const invoice = await asSystem(() => finalizeInvoice(fixture.invoice.id));
  return { ...fixture, invoice };
}

/** One saved line back into the shape `replaceInvoiceLines` accepts — every editable field, so a
 *  round trip through it changes nothing by itself. */
function toLineInput(l: InvoiceLineDetail) {
  return {
    kind: l.kind, parentPosition: l.parentLineId === null ? null : undefined,
    orderLineId: l.orderLineId, processStepCodeId: l.processStepCodeId,
    surchargeId: l.surchargeId, orderChargeId: l.orderChargeId, glAccountId: l.glAccountId,
    partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
    description: l.description, glAccountName: l.glAccountName,
    qty: l.qty, weight: l.weight === null ? null : String(l.weight),
    eachWeight: l.eachWeight === null ? null : String(l.eachWeight),
    pricePer: l.pricePer,
    unitPrice: l.unitPrice === null ? null : String(l.unitPrice),
    setupCharge: l.setupCharge === null ? null : String(l.setupCharge),
    minimumCharge: l.minimumCharge === null ? null : String(l.minimumCharge),
    breakThreshold: l.breakThreshold === null ? null : String(l.breakThreshold),
    minimumApplied: l.minimumApplied, rate: l.rate === null ? null : String(l.rate),
    priceSource: l.priceSource, needsPrice: l.needsPrice, amount: String(l.amount),
  };
}

/** Ships `extra` more of the order's first line on a second shipment. */
async function shipMore(order: OrderDetail, extra: number) {
  const input = oneOrderInput(order);
  input.orders[0].lines[0].qty = extra;
  input.orders[0].lines[0].weight = 0;
  input.orders[0].lines[0].lineComplete = true;
  return createShipper(input, { canOverrideCreditHold: false });
}
```

  Tasks 15 and 19 use two more names for readability: **`shippedFixture` is `shippedOrder`** (same helper, the shipping-side name), and **`invoicedFixture` is `finalizedFixture`**. Use one name each; do not write two helpers that do the same thing.

  Then the tests themselves:

```ts
it("lists only orders at SHIPPED with no live invoice", async () => {
  const { order } = await shippedOrder();                       // line-complete, status SHIPPED
  expect((await listInvoiceCandidates({})).map((c) => c.orderNumber)).toEqual([order.orderNumber]);
  await asSystem(() => createInvoice({ orderId: order.id }));
  expect(await listInvoiceCandidates({})).toEqual([]);
});

it("excludes a partially shipped order and a voided one", async () => {
  const { order } = await partiallyShippedOrder();
  expect(await listInvoiceCandidates({})).toEqual([]);
  const { order: voided } = await shippedOrder();
  await prisma.order.update({ where: { id: voided.id }, data: { deletedAt: new Date() } });
  expect(await listInvoiceCandidates({})).toEqual([]);
});

it("snapshots shipped quantities, part identity and the resolved price", async () => {
  const { order } = await pricedShippedOrder({ qty: 144, unitPrice: "6.5100", minimumCharge: "600.00" });
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  const part = invoice.lines.find((l) => l.kind === "PART")!;
  const op = invoice.lines.find((l) => l.kind === "OPERATION")!;
  expect(part.qty).toBe(144);
  expect(op.amount).toBe(937.44);
  expect(op.unitPrice).toBe(6.51);
  expect(op.minimumCharge).toBe(600);
  expect(op.priceSource).toBe("PART_PRICE");
  expect(op.glAccountName).toBe("4010");
  expect(invoice.total).toBe(937.44);
});

it("numbers an invoice by its order and carries the prefix", async () => {
  await setSetting("invoice_number_prefix", "7");
  const { order } = await pricedShippedOrder();
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  expect(invoice.documentNumber).toBe(`7 - ${order.orderNumber}`);
  expect(invoice.creditNumber).toBeNull();
});

it("refuses a second live invoice for one order", async () => {
  const { order } = await pricedShippedOrder();
  await asSystem(() => createInvoice({ orderId: order.id }));
  await expect(asSystem(() => createInvoice({ orderId: order.id })))
    .rejects.toThrow(/already has an invoice/i);
});

it("allows a new invoice after the first draft is discarded", async () => {
  const { order } = await pricedShippedOrder();
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  await prisma.invoice.update({ where: { id: invoice.id }, data: { deletedAt: new Date() } });
  const second = await asSystem(() => createInvoice({ orderId: order.id }));
  expect(second.invoice.id).not.toBe(invoice.id);
});

it("returns the first invoice for a repeated clientRequestId", async () => {
  const { order } = await pricedShippedOrder();
  const input = { orderId: order.id, clientRequestId: "nonce-1" };
  const a = await asSystem(() => createInvoice(input));
  const b = await asSystem(() => createInvoice(input));
  expect(b.deduped).toBe(true);
  expect(b.invoice.id).toBe(a.invoice.id);
  expect(await prisma.invoice.count()).toBe(1);
});

it("warns, never blocks, on a line with no price", async () => {
  const { order } = await shippedOrder();                        // no PartPrice rows at all
  const { invoice, warnings } = await asSystem(() => createInvoice({ orderId: order.id }));
  expect(invoice.lines.some((l) => l.needsPrice)).toBe(true);
  expect(warnings.join(" ")).toMatch(/needs a price/i);
});

it("bills freight, an extra charge, the cert charge and tax, each with its own GL account", async () => {
  const freightGl = await prisma.glAccount.create({ data: { name: "4300", description: "Freight" } });
  const otherGl = await prisma.glAccount.create({ data: { name: "4400", description: "Other charges" } });
  const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
  const certCode = await prisma.processStepCode.create({
    data: { code: "CERT", name: "Certification", glAccountId: otherGl.id } });
  await asSystem(() => setBillingConfig({
    freightGlAccountId: freightGl.id, otherChargeGlAccountId: otherGl.id,
    salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000",
    certChargeStepCodeId: certCode.id, certChargeDefault: "25.00", billForCertDefault: true,
  }));

  const { order, part, shipper } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
  await prisma.part.update({ where: { id: part.id }, data: { billForCert: true } });
  await prisma.order.update({ where: { id: order.id }, data: { certRequired: true } });
  await prisma.shipper.update({
    where: { id: shipper.id }, data: { billFreight: true, freightAmount: "150.00" } });
  await asSystem(() => replaceCharges(order.id, [{ description: "Rush", amount: "10.00" }]));

  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  const byKind = new Map(invoice.lines.map((l) => [l.kind, l]));
  expect(byKind.get("FREIGHT")!.amount).toBe(150);
  expect(byKind.get("FREIGHT")!.glAccountName).toBe("4300");
  expect(byKind.get("CHARGE")!.amount).toBe(10);
  expect(byKind.get("CHARGE")!.glAccountName).toBe("4400");
  expect(byKind.get("CERT")!.amount).toBe(25);
  expect(byKind.get("CERT")!.glAccountName).toBe("4400");
  // 4% of (100 operations + 10 charge + 25 cert) — freight excluded (ruling 8).
  expect(byKind.get("TAX")!.amount).toBe(5.4);
  expect(byKind.get("TAX")!.glAccountName).toBe("2200");
  expect(invoice.total).toBe(290.4);   // 100 + 10 + 25 + 150 + 5.40
});

it("prints no tax line for a customer who is not taxable", async () => {
  const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
  await asSystem(() => setBillingConfig({ salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000" }));
  const { order, customer } = await pricedShippedOrder();
  await prisma.customer.update({ where: { id: customer.id }, data: { taxable: false } });
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  expect(invoice.lines.some((l) => l.kind === "TAX")).toBe(false);
  expect(invoice.taxTotal).toBe(0);
});

it("prefers the customer's own tax rate over the plant rate", async () => {
  await asSystem(() => setBillingConfig({ salesTaxRate: "0.040000" }));
  const { order, customer } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
  await prisma.customer.update({ where: { id: customer.id }, data: { salesTaxRate: "0.100000" } });
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  expect(invoice.taxTotal).toBe(10);
  expect(invoice.taxRate).toBe(0.1);          // snapshotted on the header
});

it("suppresses the certification charge for a customer flagged for it", async () => {
  const certCode = await prisma.processStepCode.create({ data: { code: "CERT", name: "Certification" } });
  await asSystem(() => setBillingConfig({
    certChargeStepCodeId: certCode.id, certChargeDefault: "25.00", billForCertDefault: true }));
  const { order, customer } = await pricedShippedOrder();
  await prisma.order.update({ where: { id: order.id }, data: { certRequired: true } });
  await prisma.customer.update({ where: { id: customer.id }, data: { certChargeSuppressed: true } });
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  expect(invoice.lines.some((l) => l.kind === "CERT")).toBe(false);
});

it("audits the create with the lines in the snapshot", async () => {
  const { order } = await pricedShippedOrder();
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  const entry = await prisma.auditLog.findFirst({ where: { entity: "invoice", entityId: invoice.id } });
  expect(entry!.action).toBe("create");
  expect(JSON.stringify(entry!.after)).toContain("937.44");
});
```

  Plus **the discriminating concurrency test**, copied in shape from `tests/certs.test.ts:110-177` — including its leading comment, which explains why the competing caller must be pinned to Read Committed:

```ts
it("blocks a concurrent create under Read Committed until the holder commits, then refuses (row-lock discipline)", async () => {
  const { order } = await pricedShippedOrder();
  // Holder: default isolation, claims the Order row, commits an invoice while still holding it.
  // Competitor: createInvoice called against a MANUALLY OPENED default-isolation tx, so SSI is
  // out of the picture and claimOrder's row lock is the only thing that can serialize the two.
  // Verified by deleting the claim and watching this go red.
  // …the certs.test.ts body, with cert.create swapped for invoice.create and the expected
  //   refusal /already has an invoice/i…
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/invoices.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Write the read side of `src/server/invoices.ts`** — `DETAIL_INCLUDE` + `toInvoiceDetail` + `readInvoiceDetail(db, id)` + `getInvoice`, on `readShipperDetail`'s exact shape (`shippers.ts:230-347`). Two differences that matter:
  - **Read the snapshot unconditionally** (§5.4). Unlike `toDetail`'s `l.orderLine?.part.partNumber ?? l.partNumber`, an invoice line reads `l.partNumber` full stop. Put the reason in a comment: an invoice is frozen paper, and ruling 24's refinement says a frozen document reads its snapshot, never live-join-first.
  - `documentNumber` is computed: `kind === "CREDIT" ? String(creditNumber) : prefix === "" ? String(orderNumber) : \`${prefix} - ${orderNumber}\``.
  - Never filter `deletedAt` on the read — a discarded draft stays readable, the `readDetail` precedent for a voided order.

- [ ] **Step 4: Write `listInvoiceCandidates`** — `prisma.order.findMany({ where: { deletedAt: null, status: "SHIPPED", invoices: { none: { kind: "INVOICE", deletedAt: null } } }, … })`, plus the customer and ship-date-range filters, ordered by order number. `lastShipDate` is the max `shipDate` across the order's live shipments.

- [ ] **Step 5: Write `createInvoice`.** The bracket, in order — this is `saveNewShipper` (`shippers.ts:349-630`) with the shipment parts removed:

```
CREATE = z.object({ orderId: z.string().min(1), clientRequestId: z.string().min(1).max(200).optional(),
                    invoiceDate: z.string().optional() }).strict()

read the billing config, the active surcharges and today's date OUTSIDE the transaction
withDbErrors({ entity: "Invoice" }) → prisma.$transaction(Serializable):
  order = claimOrder(tx, orderId)                       // 404 missing, 400 voided
  refuse unless order.status === "SHIPPED"              // "Only a fully shipped order can be invoiced"
  refuse if a live INVOICE already exists for it        // findFirst, NEVER findUnique
  read the customer (code, name, terms, taxable, salesTaxRate, certChargeSuppressed,
                     surchargeOptOut, surchargeRules) and the bill-to / ship-to addresses
  shipped = shippedTotals(tx, order.lines.map(l => l.id))
  build the PricingInput: one OrderLineInput per line with a non-zero net shipped total,
     its part's live PartPrice rows (with their live breaks and each row's step code's GL),
     the surcharges after per-customer opt-out/override, the live OrderCharges,
     freight = sum of billFreight amounts across live shipments (+ the config's freight GL),
     cert    = the §6 resolution (order.certRequired && lead part billForCert ?? config default),
     tax     = customer.taxable ? { rate: customer.salesTaxRate ?? config.salesTaxRate } : null
  computed = priceOrder(input)                          // the pure engine — all the math
  auditedCreate("invoice", payload, () => tx.invoice.create({ data: { …header, lines: { create: … } } }))
     — write PART lines first, then patch each OPERATION line's parentLineId in a second pass,
       since a self-relation cannot be satisfied in one nested create
  return readInvoiceDetail(tx, invoice.id)
```

  Idempotent replay sits **outside** the transaction and inside `withDbErrors`, exactly as `createShipper` does it (`shippers.ts:645-665`): catch, `isDuplicateClientRequestId(err)`, re-read by `clientRequestId`, and **recompute the warnings** for the replay (#50's lesson — the lost-response retry is precisely when the operator never saw them).

- [ ] **Step 6: Write `invoiceWarnings(detail)`** — pure over the detail: one entry per `needsPrice` line naming it (`"Line 1 · A16-21591-000 — Austemper needs a price"`), plus one per line whose step code has no GL account (advisory in 5A; 5C's export refuses). Wire it into an `invoiceResponse` helper in Task 16, the `src/app/api/shippers/response.ts` precedent, so **every** mutating route returns the same `{ invoice, warnings }` shape and no route can silently drop them.

- [ ] **Step 7: Run the tests** — `npx vitest run tests/invoices.test.ts`. Expected: PASS.
- [ ] **Step 8: Verify the concurrency test discriminates** — delete `claimOrder` from `createInvoice`, re-run that one test, confirm it goes **RED**, restore, confirm GREEN. Paste both transcripts into the task report. A passing race test with the guard removed is not evidence.
- [ ] **Step 9: Gates + commit** — `feat: create invoices from shipped orders, snapshotting prices and quantities`

---

### Task 12: `invoices.ts` — draft edits, recalculate, discard

**Files:**
- Modify: `src/server/invoices.ts`
- Test: `tests/invoices.test.ts` (appended)

**Interfaces:**
- Produces:
```ts
export async function updateInvoice(id: string, input: unknown): Promise<InvoiceDetail>;   // header only
export async function replaceInvoiceLines(id: string, input: unknown): Promise<InvoiceDetail>;
export async function recalculateInvoice(id: string): Promise<InvoiceDetail>;
export async function discardInvoice(id: string, reason: string): Promise<void>;
```

- [ ] **Step 1: Write the failing tests:**

```ts
it("refuses every edit on a finalized invoice", async () => {
  const { invoice } = await finalizedFixture();
  await expect(asSystem(() => updateInvoice(invoice.id, { poNumber: "X" })))
    .rejects.toThrow(/finalized/i);
  await expect(asSystem(() => replaceInvoiceLines(invoice.id, [])))
    .rejects.toThrow(/finalized/i);
  await expect(asSystem(() => recalculateInvoice(invoice.id))).rejects.toThrow(/finalized/i);
});

it("recalculates from the order and preserves manual lines", async () => {
  const { order, invoice } = await draftFixture({ qty: 144 });
  await asSystem(() => replaceInvoiceLines(invoice.id, [
    ...invoice.lines.map(toLineInput),
    { kind: "CHARGE", description: "Hand-typed", amount: "25.00", priceSource: "MANUAL" },
  ]));
  await shipMore(order, 6);                                     // ship 6 more of the line
  const after = await asSystem(() => recalculateInvoice(invoice.id));
  expect(after.lines.find((l) => l.kind === "PART")!.qty).toBe(150);
  expect(after.lines.some((l) => l.description === "Hand-typed")).toBe(true);
});

it("discards a draft with a reason and frees the order to be invoiced again", async () => {
  const { order, invoice } = await draftFixture();
  await expect(asSystem(() => discardInvoice(invoice.id, "  "))).rejects.toThrow(/reason/i);
  await asSystem(() => discardInvoice(invoice.id, "keyed against the wrong order"));
  const entry = await prisma.auditLog.findFirst({
    where: { entity: "invoice", entityId: invoice.id, action: "delete" } });
  expect(entry!.reason).toBe("keyed against the wrong order");
  const again = await asSystem(() => createInvoice({ orderId: order.id }));
  expect(again.invoice.id).not.toBe(invoice.id);
});

it("refuses to discard a draft that has printed", async () => {
  const { invoice } = await draftFixture();
  await prisma.storedDocument.create({
    data: { kind: "INVOICE", invoiceId: invoice.id, fileData: new Uint8Array([1]) } });
  await expect(asSystem(() => discardInvoice(invoice.id, "mistake")))
    .rejects.toThrow(/has already printed/i);
});

it("recomputes the totals after a line edit", async () => {
  const { invoice } = await draftFixture();
  const edited = await asSystem(() => replaceInvoiceLines(invoice.id,
    invoice.lines.map((l) => (l.kind === "OPERATION" ? { ...toLineInput(l), amount: "100.00" } : toLineInput(l)))));
  expect(edited.subtotal).toBe(100);
  expect(edited.total).toBe(100);
});
```

- [ ] **Step 2: Run to verify failure**, then implement. Every mutator shares the bracket:
  `withDbErrors` → Serializable `$transaction` → `claimOrder(tx, invoice.orderId)` → **claim the invoice row** (`SELECT "id" FROM "Invoice" WHERE "id" = ${id} FOR UPDATE`) → re-read → refuse if `status === "FINALIZED"` or `deletedAt !== null` → `auditedUpdate` → writes on `tx`. Factor the first four steps into a private `claimLiveInvoice(tx, id)` returning the fresh row — `claimLiveShipper`'s shape (`shippers.ts:708-719`), with the same ordering comment.
- [ ] **Step 3: `replaceInvoiceLines`** is a whole-array replace (the `replaceCharges` / `replaceShipperLines` precedent): delete every line, recreate from the payload at positions 1..n, re-wire `parentLineId` in a second pass, recompute the six totals from the rounded line amounts, one `auditedUpdate` for the lot. A line's `kind` and money fields are what the payload carries; snapshots (`partNumber` etc.) come from the payload too, since a manual line has no order-side row to read them from.
- [ ] **Step 4: `recalculateInvoice`** re-runs Task 11's whole build against current state, then replaces only the derived lines — every line whose `priceSource` is not `MANUAL` — keeping manual ones at the end. `discardInvoice` requires a trimmed reason **in the service** (§5.17), refuses when any `StoredDocument` names the invoice, and `auditedSoftDelete`s.
- [ ] **Step 5: Run the tests, then gates + commit** — `feat: invoice draft editing, recalculation and discard`

---

### Task 13: `invoices.ts` — finalize, unlock, and status ownership

**Files:**
- Modify: `src/server/invoices.ts`, `src/server/ship-ledger.ts`
- Test: `tests/invoices.test.ts` (appended), `tests/ship-ledger.test.ts` (appended)

**Interfaces:**
- Produces: `finalizeInvoice(id: string): Promise<InvoiceDetail>`, `unlockInvoice(id: string, reason: string): Promise<InvoiceDetail>`; `recomputeOrderStatus` gains its invoice-owned-state skip.

- [ ] **Step 1: Write the failing tests:**

```ts
it("refuses to finalize while a line needs a price", async () => {
  const { invoice } = await draftFixture({ priced: false });
  await expect(asSystem(() => finalizeInvoice(invoice.id))).rejects.toThrow(/needs a price/i);
});

it("finalizes, stamps the finalizer, and sets the order INVOICED", async () => {
  const { order, invoice } = await draftFixture();
  const done = await asSystem(() => finalizeInvoice(invoice.id));
  expect(done.status).toBe("FINALIZED");
  expect(done.finalizedAt).not.toBeNull();
  expect((await getOrder(order.id)).status).toBe("INVOICED");
});

it("finalizing twice is a 400, never a second write", async () => {
  const { invoice } = await draftFixture();
  await asSystem(() => finalizeInvoice(invoice.id));
  await expect(asSystem(() => finalizeInvoice(invoice.id))).rejects.toThrow(/already finalized/i);
});

it("finalizes with a step code that has no GL account (5C's export refuses, not this)", async () => {
  const { invoice } = await draftFixture({ glAccount: null });
  await expect(asSystem(() => finalizeInvoice(invoice.id))).resolves.toBeTruthy();
});

it("unlocks with a reason, records it in the audit entry, and returns the order to SHIPPED", async () => {
  const { order, invoice } = await draftFixture();
  await asSystem(() => finalizeInvoice(invoice.id));
  await expect(asSystem(() => unlockInvoice(invoice.id, "  "))).rejects.toThrow(/reason/i);
  await asSystem(() => unlockInvoice(invoice.id, "wrong PO on the paper"));
  expect((await getInvoice(invoice.id)).status).toBe("DRAFT");
  expect((await getOrder(order.id)).status).toBe("SHIPPED");
  const entry = await prisma.auditLog.findFirst({
    where: { entity: "invoice", entityId: invoice.id, action: "update" }, orderBy: { at: "desc" } });
  expect(entry!.reason).toBe("wrong PO on the paper");
});

it("unlock stays available after the invoice has printed", async () => {
  const { invoice } = await draftFixture();
  await asSystem(() => finalizeInvoice(invoice.id));
  await prisma.storedDocument.create({
    data: { kind: "INVOICE", invoiceId: invoice.id, fileData: new Uint8Array([1]) } });
  await expect(asSystem(() => unlockInvoice(invoice.id, "customer disputed a line"))).resolves.toBeTruthy();
});
```

  and in `tests/ship-ledger.test.ts`:

```ts
it("leaves an INVOICED order alone", async () => {
  const { order } = await shippedOrder();
  await prisma.order.update({ where: { id: order.id }, data: { status: "INVOICED" } });
  await prisma.$transaction((tx) => recomputeOrderStatus(tx, [order.id]));
  expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("INVOICED");
});

it("leaves a REOPENED order alone", async () => { /* same, with REOPENED */ });
```

- [ ] **Step 2: Run to verify failure**, then implement.
- [ ] **Step 3: `recomputeOrderStatus` gains the skip** (`ship-ledger.ts:112`), beside its existing voided-order skip, with the reasoning in a comment:

```ts
// INVOICED and REOPENED are INVOICE-OWNED states (5A §5.2): finalize writes INVOICED, a reversing
// shipment writes REOPENED, unlock hands the order back to this function. Any shipment-side
// recompute that ran while an order sat in one of them would silently drop it back to SHIPPED —
// the same reason voided orders are skipped: this function derives one thing, and does not own
// the states another subsystem set.
const INVOICE_OWNED: OrderStatus[] = ["INVOICED", "REOPENED"];
// …then, inside the per-order loop:
if (INVOICE_OWNED.includes(order.status)) continue;
```

- [ ] **Step 4: `finalizeInvoice`** — the shared claim bracket, refuse when already `FINALIZED` (400 `"That invoice is already finalized"`), refuse when any line has `needsPrice` (400 naming the first offending line), then one `auditedUpdate` setting `status`, `finalizedAt`, `finalizedById` (from `currentActor()` — `src/server/context.ts`), then `tx.order.update` to `INVOICED` **through `auditedUpdate("order", …)`** so the status change is on the order's own history. **No GL check** — spec §15 puts that on the export.
- [ ] **Step 5: `unlockInvoice`** — `mustDo` is the route's; the **reason is required and trimmed in the service** (§5.17's shape, `voidShipper`'s precedent). One `auditedUpdate("invoice", id, …, { tx, reason })` clearing `status`/`finalizedAt`/`finalizedById`, then `recomputeOrderStatus(tx, [orderId])` — which now returns the order to its ship-derived value because the skip only fires while the order is still in an invoice-owned state, and the invoice is no longer finalized when it runs. **Order matters: clear the invoice first, recompute second.** Add a test asserting exactly that ordering, because the reverse silently leaves the order `INVOICED` forever.
- [ ] **Step 6: Run the tests, then gates + commit** — `feat: finalize and unlock an invoice; INVOICED and REOPENED become reachable`

---

### Task 14: Credits

**Files:**
- Modify: `src/server/invoices.ts`
- Test: `tests/invoices.test.ts` (appended)

**Interfaces:**
- Consumes: `allocateNumber("credit_number_next", tx)`.
- Produces: `createCredit(invoiceId: string): Promise<InvoiceDetail>`.

- [ ] **Step 1: Write the failing tests:**

```ts
it("derives a credit from a finalized invoice with the sign flipped", async () => {
  const { invoice } = await finalizedFixture({ total: 937.44 });
  const credit = await asSystem(() => createCredit(invoice.id));
  expect(credit.kind).toBe("CREDIT");
  expect(credit.status).toBe("DRAFT");
  expect(credit.sourceInvoiceId).toBe(invoice.id);
  expect(credit.creditNumber).toBe(1000);
  expect(credit.documentNumber).toBe("1000");
  expect(credit.total).toBe(-937.44);
  expect(credit.lines.find((l) => l.kind === "OPERATION")!.amount).toBe(-937.44);
});

it("refuses a credit against a draft", async () => {
  const { invoice } = await draftFixture();
  await expect(asSystem(() => createCredit(invoice.id))).rejects.toThrow(/finalized/i);
});

it("allows a second credit against the same invoice, with its own number", async () => {
  const { invoice } = await finalizedFixture();
  const a = await asSystem(() => createCredit(invoice.id));
  const b = await asSystem(() => createCredit(invoice.id));
  expect(b.creditNumber).toBe(a.creditNumber! + 1);
});

it("can be reduced to a partial amount and finalized without touching the order status", async () => {
  const { order, invoice } = await finalizedFixture();
  const credit = await asSystem(() => createCredit(invoice.id));
  const reduced = await asSystem(() => replaceInvoiceLines(credit.id,
    credit.lines.map((l) => (l.kind === "OPERATION" ? { ...toLineInput(l), amount: "-100.00" } : toLineInput(l)))));
  expect(reduced.total).toBe(-100);
  await asSystem(() => finalizeInvoice(credit.id));
  expect((await getOrder(order.id)).status).toBe("INVOICED");   // unchanged by the credit
});

it("never frees a credit number when the draft is discarded", async () => {
  const { invoice } = await finalizedFixture();
  const credit = await asSystem(() => createCredit(invoice.id));
  await asSystem(() => discardInvoice(credit.id, "raised in error"));
  const next = await asSystem(() => createCredit(invoice.id));
  expect(next.creditNumber).toBe(credit.creditNumber! + 1);
});
```

- [ ] **Step 2: Run to verify failure**, then implement `createCredit`: claim the order, then the **source invoice** row, then re-read; refuse unless the source is a live `FINALIZED` `INVOICE`; `allocateNumber("credit_number_next", tx)` inside the claim; copy every header snapshot and every line with `amount` negated (and `qty`/`weight` left as they are — the paper says what was billed, the money says which way it goes); `auditedCreate`. Finalizing a `CREDIT` writes **no** order status (Task 13's finalize branches on `kind`).
- [ ] **Step 3: Run the tests, then gates + commit** — `feat: credits derived from finalized invoices`

---

### Task 15: The reversing shipment

**Files:**
- Modify: `src/server/shippers.ts`, `prisma/schema.prisma` (already done in Task 2 — `reversesShipperId`), `src/server/ship-ledger.ts` (over-ship warning against the net total)
- Create: `src/app/api/shippers/[id]/reverse/route.ts`
- Test: `tests/shipper-reverse.test.ts`

**Interfaces:**
- Consumes: `claimOrdersInOrder`, `recomputeOrderStatus`, `finalizedInvoicesFor` (Task 10), `shippedTotals`.
- Produces: `reverseShipper(id: string, input: unknown): Promise<ShipperCreateResult>`.

- [ ] **Step 1: Write the failing tests:**

```ts
it("creates a negative shipment that nets the ledger down", async () => {
  const { order, shipper } = await shippedFixture({ qty: 100 });
  const { shipper: reversal } = await reverseShipper(shipper.id, { reason: "wrong parts loaded" });
  expect(reversal.orders[0].lines[0].qty).toBe(-100);
  const totals = await shippedTotals(prisma, [order.lines[0].id]);
  expect(totals.get(order.lines[0].id)!.qty).toBe(0);
});

it("sets REOPENED when the order has a finalized invoice, and leaves the status derived otherwise", async () => {
  const { order: a, shipper: sa } = await invoicedFixture();
  await reverseShipper(sa.id, { reason: "returned" });
  expect((await getOrder(a.id)).status).toBe("REOPENED");

  const { order: b, shipper: sb } = await shippedFixture();      // never invoiced
  await reverseShipper(sb.id, { reason: "returned" });
  expect((await getOrder(b.id)).status).toBe("OPEN");            // derived, ledger back to zero
});

it("refuses to drive a line below zero", async () => {
  const { shipper } = await shippedFixture({ qty: 100 });
  await reverseShipper(shipper.id, { reason: "first" });
  await expect(reverseShipper(shipper.id, { reason: "second" }))
    .rejects.toThrow(/below zero/i);
});

it("requires a reason and the void_shipper action", async () => {
  const { shipper } = await shippedFixture();
  await expect(reverseShipper(shipper.id, { reason: "  " })).rejects.toThrow(/reason/i);
  // route-level: 403 without action.void_shipper
});

it("keeps its own packing-list number and never reuses the original's", async () => {
  const { shipper } = await shippedFixture();
  const { shipper: reversal } = await reverseShipper(shipper.id, { reason: "returned" });
  expect(reversal.shipperNumber).not.toBe(shipper.shipperNumber);
  expect(reversal.orders[0].sequence).toBe(shipper.orders[0].sequence + 1);
});

it("raises no over-ship warning for a reversal", async () => {
  const { shipper } = await shippedFixture({ qty: 100 });
  const { warnings } = await reverseShipper(shipper.id, { reason: "returned" });
  expect(warnings.join(" ")).not.toMatch(/exceeds the remaining/i);
});
```

- [ ] **Step 2: Run to verify failure**, then implement `reverseShipper`. It is `saveNewShipper` with four differences, and it **reuses that function's claim and recompute machinery rather than growing a second path**:
  - every line's `qty` and `weight` are the **negation** of the original shipment's, and `lineComplete` is `false`;
  - `reversesShipperId` is set, `shipDate` defaults to the original's;
  - a reason is required and trimmed in the service, and lands in the audit entry (`voidShipper`'s shape);
  - after the write, for every affected order that `finalizedInvoicesFor` names, write `REOPENED` through `auditedUpdate("order", …)`; for the rest, `recomputeOrderStatus` decides as usual.
- [ ] **Step 3: Relax the schema's non-negative guards** for reversal lines only — the zod `SHIP_LINE` schema keeps `min(0)` for ordinary saves, and the reversal builds its rows internally rather than through that schema. **Add a test that a normal `createShipper` still refuses a negative qty**, so relaxing it here cannot leak.
- [ ] **Step 4: The over-ship warning** (`shippers.ts`, inside `saveNewShipper`'s warning loop) already compares against `priorShipped`; confirm a negative line can never trip it and add the assertion above.
- [ ] **Step 5: The route** `POST /api/shippers/[id]/reverse` — `mustDo(requireUser(), "void_shipper")`, body `{ reason, shipDate? }`, returns `shipperResponse(...)`.
- [ ] **Step 6: Run the tests, then gates + commit** — `feat: reversing shipments — negative quantities, REOPENED, one claim path`

---

### Task 16: Routes + the 401/403 sweep

**Files:**
- Create: `src/app/api/invoices/route.ts`, `src/app/api/invoices/response.ts`, `src/app/api/invoices/query.ts`, `src/app/api/invoices/[id]/route.ts`, `.../[id]/lines/route.ts`, `.../[id]/recalculate/route.ts`, `.../[id]/finalize/route.ts`, `.../[id]/unlock/route.ts`, `.../[id]/credit/route.ts`, `src/app/api/orders/[id]/invoices/route.ts`
- Modify: `tests/permissions-sweep.test.ts`
- Test: `tests/invoice-routes.test.ts`

**Interfaces:**
- Consumes: everything `invoices.ts` exports; `handle` / `requireUser` / `assertRecord` / `reasonFromBody` (`src/server/http.ts`); `mustCan` / `mustDo`.
- Produces:
```ts
// src/app/api/invoices/response.ts — NOT a route (the shippers/response.ts precedent)
export async function invoiceResponse(detail: InvoiceDetail): Promise<NextResponse>;
// { invoice, warnings } on EVERY mutating response, so no route can drop the needs-price surface
```

- [ ] **Step 1: Write the failing route tests** `tests/invoice-routes.test.ts`, using `signInWith(permissions)` from `tests/helpers/auth.ts` and passing ctx on every call. One case per row of this table — the whole point is that no gate is missing:

| Route | Method | Gate |
|---|---|---|
| `/api/invoices` | GET | `invoicing.view` |
| `/api/invoices?candidates=1` | GET | `invoicing.view` |
| `/api/invoices` | POST | `invoicing.create` |
| `/api/invoices/[id]` | GET | `invoicing.view` |
| `/api/invoices/[id]` | PATCH | `invoicing.edit` |
| `/api/invoices/[id]` | DELETE | `invoicing.delete` (+ reason via `reasonFromBody`) |
| `/api/invoices/[id]/lines` | PUT | `invoicing.edit` **and** `action.change_prices` |
| `/api/invoices/[id]/recalculate` | POST | `invoicing.edit` |
| `/api/invoices/[id]/finalize` | POST | `invoicing.edit` |
| `/api/invoices/[id]/unlock` | POST | `action.unlock_invoice` **alone** — no CRUD permission substitutes for it, the `void_shipper` shape |
| `/api/invoices/[id]/credit` | POST | `invoicing.create` |
| `/api/orders/[id]/invoices` | GET | `invoicing.view` |

  Each gets three cases: **401** with no cookie, **403** holding everything *but* the required permission, **200** holding it.

- [ ] **Step 2: Run to verify failure**, then write the routes. Every one follows `src/app/api/shippers/[id]/route.ts` exactly — `handle(async (req, { params }) => …)`, authorize on the first line, parse, delegate, and wrap through `invoiceResponse`. `invoices/query.ts` parses the list filter (customer, status, date range, `candidates=1`) the way `shippers/query.ts` does, so the list and its export can never disagree about what a query string means.

- [ ] **Step 3: Write `invoiceResponse`**, copying `src/app/api/shippers/response.ts` including its reasoning comment — the mutators return a bare `InvoiceDetail`, so without one shared wrapper a route could silently drop the needs-price warnings a screen is supposed to show.

- [ ] **Step 4: Extend `tests/permissions-sweep.test.ts`** — it already asserts every route calls `requireUser`; confirm the ten new routes are covered by the existing walk and that none of them slipped in without a `mustCan`/`mustDo`.

- [ ] **Step 5: Run the tests, then gates + commit** — `feat: invoice routes with the full 401/403 surface`

---

### Task 17: `/invoicing` — the worklist

**Files:**
- Create: `src/app/invoicing/page.tsx`, `src/app/invoicing/InvoicingList.tsx`, `src/app/api/invoices/export/route.ts`
- Test: browser verification

**Interfaces:**
- Consumes: `GET /api/invoices` and `GET /api/invoices?candidates=1`; `gate` (`src/lib/permission-ui.ts`); `useLatest` (`src/lib/use-latest.ts`).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Build the page** on `src/app/shipping/ShippingList.tsx`'s shape — a thin `page.tsx` delegating to a client component. Two sections:
  - **Ready to invoice** — the candidates (order number, customer, PO, last ship date), each row a checkbox, with a **Create invoices** button that POSTs each ticked order in turn and reports per-order failures **beside their order** rather than aborting the run (Task 11's create is per-order and independent, and the response must show that). Each candidate row links to its order.
  - **Invoices** — the list, filtered by customer / status / date range, each row linking to `/invoicing/<id>`, showing the document number, kind, status, total and finalized date. Excel export via the new `export` route, matching every other list in the app.
- [ ] **Step 2: Guard the loads with `useLatest`** — a stale search response must never overwrite a newer one (`src/lib/use-latest.ts`; issues #5/#15 are this exact bug twice). Drop any soft `.catch(() => {})`: a failed fetch says so, it does not impersonate an empty list.
- [ ] **Step 3: Gate every control** with the shared helper — **disabled with a title naming the missing permission, never hidden** (§5.16). The Create-invoices button needs `invoicing.create`.
- [ ] **Step 4: Verify in a real browser** per HANDOFF §5a — a shipped order appears, ticking and creating moves it out of Ready and into the list, the filters narrow correctly, and the export downloads. Clear the DEV-database fixtures afterwards.
- [ ] **Step 5: Gates + commit** — `feat(invoicing): worklist of orders ready to invoice, and the invoice list`

---

### Task 18: `/invoicing/[id]` — the invoice page, and the order hub's Invoices section

**Files:**
- Create: `src/app/invoicing/[id]/page.tsx`, `src/app/invoicing/[id]/InvoiceDetail.tsx`, `src/app/orders/[id]/InvoicesSection.tsx`
- Modify: `src/app/orders/[id]/page.tsx`
- Test: browser verification

**Interfaces:**
- Consumes: the Task 16 routes; `useBulkGrid` (`src/lib/bulk-grid.ts:116`), `useLatest` / `useMutationGate`, `useEditGuard`, `gate` / `gateDo`, `HistoryPanel`, the Task 1 label maps.
- Produces: nothing other tasks consume.

- [ ] **Step 1: The page shell** — `page.tsx` is a bare `<InvoiceDetail key={id} id={id} />`, the `src/app/shipping/[id]/page.tsx` idiom **including its comment**: Next reuses the component instance across `/invoicing/A → /invoicing/B`, and without the key a `defaultValue`-bound field carries one invoice's unsaved text onto another (HANDOFF §5.12 — a Critical in Phase 2B).
- [ ] **Step 2: The body**, on `ShipmentDetail.tsx`'s state model exactly:
  - header (customer, order link, PO, terms, invoice date, status badge, document number) with **optimistic PATCH and rollback-then-report** (§5.13 — reload *first*, then set the error);
  - **one monotonic mutation ticket** shared by every write and by `load` itself, so overlapping calls resolve to the newest (`useMutationGate`);
  - `useEditGuard` on the header, so an arriving detail never resets the field under the cursor — the notes-clobber trio's fix, and this is a fourth member of that sibling group;
  - the **PART/OPERATION grid** and the **charges/surcharge/freight/cert/tax lines**, editable through `useBulkGrid` and saved by the whole-array PUT;
  - totals; actions **Recalculate**, **Finalize**, **Unlock** (prompting for the reason), **Print**, **Raise credit**, **Discard** (prompting for the reason);
  - the Documents list and `HistoryPanel`.
- [ ] **Step 3: Lock the UI to the status.** A finalized invoice renders every editing control disabled with the title `"Invoice is finalized"` — the `voidLocked` helper's shape (`ShipmentDetail.tsx:110-127`), which a discarded draft reuses with `"Invoice is discarded"`. Money-bearing controls take the **double gate** (`invoicing.edit` **and** `change_prices`) computed once, with the same "whichever is actually the blocker" title rule the parts Pricing section uses.
- [ ] **Step 4: The order hub's Invoices section** — spec §6 lists invoices as a hub section. Rows link to `/invoicing/<id>`; when the order is `SHIPPED` with no live invoice, a **Create invoice** button gated on `invoicing.create`. Register it in `src/app/orders/[id]/page.tsx` beside the Shipments and Certifications sections.
- [ ] **Step 5: Verify in a real browser** per HANDOFF §5a — create, edit a line, recalculate, finalize (controls lock), unlock with a reason (controls unlock, order returns to Shipped), raise a credit, and confirm the hub section links both ways. Clear the DEV-database fixtures afterwards.
- [ ] **Step 6: Gates + commit** — `feat(invoicing): invoice page and the order hub's Invoices section`

---

### Task 19: `pdf/invoice.ts` — the layout, print and archive

**Files:**
- Create: `src/server/pdf/invoice.ts`, `src/app/api/invoices/[id]/print/route.ts`
- Modify: `src/server/invoices.ts` (`printInvoice`), `src/server/documents.ts` (`AREA_FOR_KIND`, `DocumentOwner`, `ownerColumns`, `listDocumentsForOrder`, `documentFilename`, `resolveDocumentFilename`), `src/app/orders/[id]/…` (`KIND_LABELS`)
- Test: `tests/invoice-pdf.test.ts`

**Interfaces:**
- Consumes: `renderPdf` (`src/server/pdf/render.ts`), `LAYOUT`, `storeDocument` / `assertPrintable` (`src/server/documents.ts`), `claimOrder`.
- Produces:
```ts
// src/server/pdf/invoice.ts — PURE: plain data in, plain-JSON pdfmake definition out
export type InvoicePdfData = { /* company, remitTo, billTo, shipTo, documentNumber, invoiceDate,
   termsName, orderNumber, poNumber, materialName, processNames, parts[], priceRows[],
   subtotal, surchargeRows[], chargeRows[], certRow, freightRow, taxRow, total */ };
export function buildInvoiceDefinition(input: InvoicePdfData): TDocumentDefinitions;
// src/server/invoices.ts — the three-layer split every print in this codebase uses:
//   settings read → pure read-to-plain-data → pure build → bytes → archive
export async function invoicePrintSettings(): Promise<InvoicePrintSettings>;   // company + remit-to
export async function readInvoicePdfData(db: Db, invoiceId: string, settings?: InvoicePrintSettings): Promise<InvoicePdfData>;
export async function printInvoice(invoiceId: string): Promise<{ documentId: string; documentNumber: string; pdf: Buffer }>;
```

- [ ] **Step 1: Finish widening `documents.ts`.** **Task 2 already did the schema-shaped half** — widening `DocumentKind` made `Record<DocumentKind, Area>` a compile error until it was done, which is exactly the point of that type. Already in place, verified: `AREA_FOR_KIND` has `INVOICE: "invoicing"` / `CREDIT: "invoicing"`; `DocumentOwner` has both arms; so do `ownerColumns`, `DocumentMeta.invoiceId`, `documentFilename` and `resolveDocumentFilename`. **What is still owed here:**
  - `listDocumentsForOrder`'s `OR` gains `{ invoice: { orderId } }`, so an invoice appears on its order's hub (it currently has only the `orderId` / `cert` / `shipper` branches, `src/server/documents.ts:174`);
  - `KIND_LABELS` in `src/app/orders/[id]/DocumentsSection.tsx:18` — today it is `{ TRAVELER: "Traveler" }` alone, so every other kind renders as a raw enum name (the cosmetic gap HANDOFF §6 recorded). Make it exhaustive over all six kinds.
  - **Cover Task 2's untested filename arms.** `documentFilename`'s `INVOICE`/`CREDIT` cases (`src/server/documents.ts:255-258`) and `resolveDocumentFilename`'s new case (`:304-312`) are new production code with no test. `documentFilename` now takes **four optional positionals, three of them numbers** — a caller passing a credit number in the `shipperNumber` slot compiles silently. Add cases to the existing `describe("documentFilename")` block in `tests/documents.test.ts` asserting `invoice-72026.pdf` and `credit-1000.pdf`.
- [ ] **Step 2: Fill in `KIND_LABELS`** on the order hub's Documents list for every kind — the cosmetic gap HANDOFF §6 recorded (non-traveler kinds render as raw enum names today). Enumerate all six so the map is exhaustive.
- [ ] **Step 3: Write the failing tests** `tests/invoice-pdf.test.ts`, on `tests/cert-pdf.test.ts`'s shape:

```ts
/** The owner's own invoice as plain builder input — order 72026, one part, one priced
 *  operation, one surcharge. Every assertion below reads off THIS, so the golden numbers in
 *  tests/pricing.test.ts and the golden paper here describe the same document. */
function sampleData(): InvoicePdfData {
  return {
    company: { name: "American Heat Treating - Alabama, LLC",
               address: "3008 Red Morris Parkway, Anniston AL 36207", phone: "256-835-3370" },
    remitTo: { name: "American Heat Treating - Alabama, LLC",
               street: "3008 Red Morris Parkway", city: "Anniston", state: "AL", zip: "36207" },
    billTo: { name: "GFMCO - Columbus LLC", street: "PO Box 96, 600 12th Street",
              city: "Columbus", state: "GA", zip: "31902-0096" },
    shipTo: { name: "GFMCO - Columbus LLC", street: "PO Box 96, 600 12th Street",
              city: "Columbus", state: "GA", zip: "31902-0096" },
    documentNumber: "7 - 72026", invoiceDate: "2026-07-29", termsName: "Net 30",
    orderNumber: 72026, poNumber: "49499",
    materialName: "Ductile Iron", processNames: "Austemper",
    parts: [{ qty: 144, partNumber: "A16-21591-000", partName: "EQUALIZER-RR SUSP",
              partDescription: "", eachWeight: 21, totalWeight: 3024 }],
    priceRows: [{ description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51,
                  minimumCharge: 600, setupCharge: null, amount: 937.44 }],
    subtotal: 937.44,
    surchargeRows: [{ description: "EnergySur", amount: 37.5 }],
    chargeRows: [], certRow: null, freightRow: null, taxRow: null,
    total: 974.94,
  };
}

it("is a pure builder — the definition survives a JSON round trip", () => {
  const def = buildInvoiceDefinition(sampleData());
  expect(JSON.parse(JSON.stringify(def))).toEqual(def);
});

it("prints the sample's identity block, parts, price rows and totals", async () => {
  // CONTENT is pinned on the DEFINITION, never on rendered bytes — copy `allText` from
  // tests/cert-pdf.test.ts:25-35 along with its comment: pdfkit writes TTF-SUBSET GLYPH IDS, so a
  // rendered PDF carries no character text to grep for. The rendered file is pinned
  // STRUCTURALLY instead (below).
  const text = allText(buildInvoiceDefinition(sampleData())).join(" ");
  expect(text).toContain("Invoice");
  expect(text).toContain("American Heat Treating - Alabama, LLC");
  expect(text).toContain("7 - 72026");
  expect(text).toContain("Net 30");
  expect(text).toContain("Remit To");
  expect(text).toContain("GFMCO - Columbus LLC");
  expect(text).toContain("72026");                 // Our Order #
  expect(text).toContain("49499");                 // Your PO #
  expect(text).toContain("Ductile Iron");
  expect(text).toContain("Austemper");
  expect(text).toContain("A16-21591-000");
  expect(text).toContain("EQUALIZER-RR SUSP");
  expect(text).toContain("Price per Each");
  expect(text).toContain("6.51");
  expect(text).toContain("Minimum Charge");
  expect(text).toContain("600.00");
  expect(text).toContain("Sub Total Amount");
  expect(text).toContain("937.44");
  expect(text).toContain("EnergySur");
  expect(text).toContain("37.50");
  expect(text).toContain("Total Amount Due");
  expect(text).toContain("974.94");

  // Structural pins on the real file — the `%PDF-` header and the page count, exactly as
  // tests/traveler.test.ts:61 and tests/cert-pdf.test.ts:256 do it. Never `Buffer.compare` two
  // fresh renders (CLAUDE.md).
  const pdf = await renderPdf(buildInvoiceDefinition(sampleData()));
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(pageCount(pdf)).toBe(1);                  // copy `pageCount` from tests/traveler.test.ts:61
});

it("stores the print and reprints the identical bytes", async () => {
  const { invoice } = await finalizedFixture();
  const first = await printInvoice(invoice.id);
  const stored = await getDocument(first.documentId);
  expect(Buffer.compare(stored.fileData, first.pdf)).toBe(0);   // STORED bytes — exact by design
});

it("refuses a new print on a discarded draft, and keeps old prints downloadable", async () => {
  const { invoice } = await draftFixture();
  const printed = await printInvoice(invoice.id);
  await asSystem(() => discardInvoice(invoice.id, "raised in error"))
    .catch(() => {});                                            // refused once printed — see Task 12
  await prisma.invoice.update({ where: { id: invoice.id }, data: { deletedAt: new Date() } });
  await expect(printInvoice(invoice.id)).rejects.toThrow(/voided/i);
  await expect(getDocument(printed.documentId)).resolves.toBeTruthy();
});

it("prints a credit with its credit number and negative amounts", async () => {
  const { invoice } = await finalizedFixture();
  const credit = await asSystem(() => createCredit(invoice.id));
  const { documentNumber, documentId, pdf } = await printInvoice(credit.id);
  expect(documentNumber).toBe(String(credit.creditNumber));
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  // The number and the negative amounts are pinned on the DEFINITION, for the glyph-id reason
  // above — build it from the same data the print used.
  const text = allText(buildInvoiceDefinition(await readInvoicePdfData(prisma, credit.id))).join(" ");
  expect(text).toContain(String(credit.creditNumber));
  expect(text).toContain("-937.44");
  const stored = await prisma.storedDocument.findUniqueOrThrow({ where: { id: documentId } });
  expect(stored.kind).toBe("CREDIT");          // the kind follows the invoice row's own kind
  expect(stored.invoiceId).toBe(credit.id);
});
```

- [ ] **Step 4: Write `src/server/pdf/invoice.ts`** to `docs/samples/Invoice Sample.pdf`, on `pdf/cert.ts`'s structure — a header comment naming the sample as the contract and listing **every** deviation, then plain input types ("no Decimals, no Dates, no Prisma rows"), then pure locale-pinned formatters, then one `function xBlock(d): Content` per visual block, then the exported builder. Blocks: title + company, the identity column (`Invoice No.` / `Invoice Date` / `Terms` / `Page No.`), the `Remit To` box, `Billto` / `Shipto`, the order strip (`Our Order #`, `Your PO #`, `Material`, `Process`), the **PARTS** table (`Quantity` · `Part No. / Description` · `Each weight` · `Total Wt`), the **PRICE** block (one row per operation: its name left, its amount right, with `Price per <unit>:` and `Minimum Charge:` beneath), `Sub Total Amount`, one named row per surcharge/charge/cert/freight/tax, and `Total Amount Due`. **Two deviations to state in that header comment**: no "Page N of M" (a pure-JSON definition cannot carry a page-count function — the ticket's and the cert's identical deviation, owner ping #1), and `Process:` prints the lead part's priced operation names comma-joined, byte-identical to the sample whenever a part has one priced operation.
- [ ] **Step 5: Write `printInvoice`** using the identical bracket all four existing prints use (`certs.ts:673-707`): settings read **outside** the transaction → Serializable `$transaction` → `claimOrder` → claim the invoice row → re-read → `assertPrintable` → read-on-`tx` → `renderPdf` → `storeDocument(tx, { kind: invoice.kind === "CREDIT" ? "CREDIT" : "INVOICE", invoiceId }, pdf)`. **No clock inside the builder** — the print date is passed in as data, the traveler's purity rule.
- [ ] **Step 6: The print route** `POST /api/invoices/[id]/print` — `mustCan(requireUser(), "invoicing", "view")` (a print is a read of the document, the cert-print precedent), returning the PDF with the resolved filename.
- [ ] **Step 7: Run the tests, then gates + commit** — `feat: invoice and credit PDFs, stored byte-for-byte`

---

### Task 20: E2E flow, demo walkthrough, and docs

**Files:**
- Create: `e2e/flows/invoice-shipped-order.mjs`, `docs/<date>-phase-5a-demo.md`
- Modify: `e2e/run.mjs`, `e2e/lib/db-fixtures.ts`, `docs/HANDOFF.md`, `CLAUDE.md`
- Test: `npm run test:e2e`

**Interfaces:**
- Consumes: `createOrderViaUi` / `startNewShipment` / `orderPanel` / `waitForShipmentPage` (`e2e/lib/orders.mjs`), `waitForValue` / `fillReliable` / `armPrompt` (`e2e/lib/ui.mjs`).
- Produces: a 16th registered flow.

- [ ] **Step 1: Extend the fixtures** — `e2e/lib/db-fixtures.ts` gains an invoicing customer and a part carrying **two** `PartPrice` rows (so the flow exercises the multi-operation case ruling 3 exists for), a GL account on each step code, one active surcharge, and a `BillingConfig` with a tax rate. Follow the file's existing exact-key teardown; the reaper is localhost-gated and scoped to the fixture customer — **do not widen it**.
- [ ] **Step 2: Write `e2e/flows/invoice-shipped-order.mjs`** with the header comment naming what it pins, the way every existing flow does. The path: key an order against the two-operation part → ship it with both lines marked complete → the board shows **Shipped** → `/invoicing` shows it under *Ready to invoice* → tick and create → the invoice page shows **two** priced operation rows, the surcharge and the tax → **Finalize** → controls lock and the board shows **Invoiced** → **Print** → the document appears in the Documents list → **Unlock** with a reason → controls unlock and the board shows **Shipped** again.
- [ ] **Step 3: Avoid the `/new`-route URL trap** — it has now armed twice (`/orders/new` in Phase 3, `/shipping/new` in Phase 4). This flow's own navigation is `/invoicing → /invoicing/<id>`, so wait for **post-navigation-only content** (the document-number badge), never `page.waitForURL(/\/invoicing\/[^/?]+$/)`.
- [ ] **Step 4: Register it in `e2e/run.mjs`** as the 16th entry, `as: "admin"`, last in `FLOWS` — it creates its own order and leaves nothing later flows depend on. Update the file's header comment (it says "fifteen owner-reviewable flows").
- [ ] **Step 5: Run the suite three times consecutively** — `npm run test:e2e` — to confirm stability, the standing practice since 2C-3.
- [ ] **Step 6: Write the demo walkthrough** `docs/<date>-phase-5a-demo.md` with screenshots, on `docs/2026-08-05-phase-4-demo.md`'s shape: the pricing setup, the worklist, the invoice, the printed PDF against the owner's sample side by side, and the unlock path. **Name every deviation from the sample** rather than letting the owner find them.
- [ ] **Step 7: Update the docs as part of the work** (standing owner rule):
  - **`CLAUDE.md`** — a paragraph on the invoice being frozen paper (snapshot read **unconditionally**, the opposite of the shipment grids), the `invoice-guards.ts` leaf and why it exists, `BillingConfig` as a singleton with a CHECK, and the new sweep exemptions.
  - **`docs/HANDOFF.md`** — a new §4a for 5A (what it delivered, the rulings, the lessons), §6 gaining anything deferred, and **§9 rewritten as the 5B kickoff prompt** carrying spec §16's inheritance list verbatim.
- [ ] **Step 8: Full gates + the E2E suite, then commit** — `feat: invoicing E2E flow, demo walkthrough and docs`

---

## Review and merge

Per the process that has held for four phases: **a fresh subagent per task → the repo's own `task-reviewer` agent on each task's diff → fix rounds until approved → re-review**. Then, on the whole branch:

1. **One whole-branch review on the strongest model** over `main..HEAD` of `phase-5a-pricing-invoicing`, fed the per-task deferred-minors lists from `docs/execution/2026-08-06-phase-5a-pricing-invoicing/progress.md` as triage input.
2. **One fix wave** from that review, with scoped re-review of the fixes.
3. **The owner demo** (`docs/<date>-phase-5a-demo.md`) before the merge.
4. **Open the PR** — attribution and the Claude-Session link in the **PR body**, never a commit trailer (a hook blocks them).
5. **The owner-ratified stopping rule applies from review round 6**: after that round's fixes, further findings become issues unless they are correctness, concurrency, or data-integrity defects.
6. After the squash-merge: verify the squashed tree is byte-identical to the branch tip, all gates plus `npm run test:e2e` green on `main`, both databases migrated — then kick off **5B (Accounts Receivable)** with the §9 prompt.
