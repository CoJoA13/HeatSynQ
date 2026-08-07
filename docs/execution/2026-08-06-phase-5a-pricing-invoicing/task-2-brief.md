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

