# Task 2 report — Schema: six tables, the two CHECKs, registry, sweeps, audit

**Status: DONE_WITH_CONCERNS** (nothing broken; three deliberate scope decisions the brief did not
cover, all called out below under *Ambiguities and how I resolved them*).

**Commit:** `269f525` — `feat: pricing and invoicing schema — price rows, surcharges, invoices, billing config`
**Base:** `b532505` (Task 1). Branch `phase-5a-pricing-invoicing`.

---

## 1. Precondition check (the hard gate)

Run before a single line of migration SQL was written, against **both** databases:

```
docker exec erp-db-1 psql -U erp -d <db> -t -c 'select count(*) from "<table>"'
```

| table | `erp` | `erp_test` |
|---|---|---|
| `Part` | **0** | **0** |
| `PartPriceBreak` | **0** | **0** |
| `Customer` | **0** | **0** |
| `Order` | **0** | **0** |
| `ProcessStepCode` | **0** | **0** |

All zero, matching design spec §3.4. The four `Part` column drops and the `PartPriceBreak`
re-parent therefore destroy nothing, and no backfill was written (none is expressible: there is no
`processStepCodeId` to attribute an old `Part.unitPrice` to). The counts and their consequence are
recorded in the migration's own header comment so a future reader of the file sees why it is safe.

---

## 2. Migrations

### Split, and why — the enum could not be done in one

Confirmed empirically rather than assumed. The generated diff put

```sql
ALTER TYPE "DocumentKind" ADD VALUE 'INVOICE';
ALTER TYPE "DocumentKind" ADD VALUE 'CREDIT';
```

in the same script as the re-stated `StoredDocument_kind_owner_check`, whose expression contains
`kind IN ('INVOICE','CREDIT')`. Postgres refuses to use a new enum value in the transaction that
added it (`ERROR: unsafe use of new value ... of enum type`), and `prisma migrate deploy` runs one
migration **directory** per transaction. This is precisely the Phase 4 situation, and
`20260804122600_document_kind_values` is the standing precedent.

Rather than write it wrong and discover the failure, I applied the split **proactively**: created
part 1, ran `migrate deploy` (part 1 applied cleanly, the two values are committed), then
re-generated `migrate diff --from-config-datasource` — which then produced the remaining script with
the `ADD VALUE` lines already absent. That is the whole reason part 2 is machine-generated rather
than hand-trimmed: nothing was deleted from a diff by hand, so nothing could be deleted by mistake.

| directory | contents |
|---|---|
| `20260806221400_document_kind_invoice_values` | the two `ALTER TYPE ... ADD VALUE` statements, plus a header comment explaining that splitting them back out breaks the deploy (mirrors the Phase 4 file's own wording) |
| `20260806221500_pricing_and_invoicing` | 6 `CREATE TYPE`, 7 `CREATE TABLE`, the `Part` 4-drop/2-add, the `PartPriceBreak` re-parent (drop FK + drop index + drop `partId` + add `partPriceId NOT NULL`), `Customer`/`Shipper`/`StoredDocument` `ADD COLUMN`, every index, every FK — then the two hand-written CHECKs and the singleton seed |

### The hand-appended SQL (verbatim from the brief, with two added comments)

`StoredDocument_kind_owner_check` is **dropped and re-added whole** rather than patched: a CHECK
constraint cannot be altered in place, and re-stating it keeps the current definition readable in
one place. Every one of the four Phase 4 arms gained an `"invoiceId" IS NULL` clause; the
`SHIPPER` arm's deliberate looseness on `orderId` is preserved and carries a `do not "tighten" it`
comment beside it, matching the Phase 4 file.

`BillingConfig_singleton_check` is `CHECK ("id" = 'singleton')`, and the migration seeds the one
row (`ON CONFLICT DO NOTHING`) so `getBillingConfig` can be a plain `findFirst` in Task 3.

### Application and verification

```
npx prisma migrate deploy                                        # erp   → both applied
DATABASE_URL=…/erp_test npx prisma migrate deploy                # erp_test → both applied
npx prisma generate                                              # 7.9.1 → prisma/generated/prisma
npx prisma migrate status              (erp)      → "Database schema is up to date!"  (25 migrations)
npx prisma migrate status              (erp_test) → "Database schema is up to date!"  (25 migrations)
```

Post-apply spot checks against `erp_test`:
- `pg_constraint` contains both `StoredDocument_kind_owner_check` and `BillingConfig_singleton_check`.
- `BillingConfig` holds exactly `('singleton', false)`.
- `pg_enum` for `DocumentKind` is `TRAVELER, SHIPPER, BOL, CERT, INVOICE, CREDIT` in that order.

`tests/invoicing-schema.test.ts` now pins all four of those facts in CI rather than leaving them as
a one-time manual observation.

---

## 3. Schema

§4.1–§4.5 blocks copied verbatim from the design spec, with **one addition Prisma requires and the
spec's blocks omit**: `Surcharge` needs `invoiceLines InvoiceLine[]`, the back-relation for
`InvoiceLine.surchargeId`. Without it the schema does not validate. Nothing else was paraphrased.

Enum members and their order match `src/lib/invoice-constants.ts` exactly (`INVOICE_KINDS`,
`INVOICE_STATUSES`, `INVOICE_LINE_KINDS`, `PRICE_SOURCES`, `SURCHARGE_KINDS`, `SURCHARGE_SCOPES`) —
and that is now a **test**, not a promise: the smoke test queries `pg_enum ORDER BY enumsortorder`
per type and compares to the constant array. Comparing against the database rather than the
generated client is deliberate: the DB's own sort order is what a mis-ordered `ALTER TYPE` would
corrupt, and the client would happily agree with a wrong schema.

**Placement note (deviation from the brief's letter).** The brief said "placed after
`StoredDocument`". I appended the new models at the **end of the file** instead. Inserting seven
models between `StoredDocument` and `CertScope`/`Cert` would split Phase 4's block in half; every
prior phase appended. Placement has no functional effect (Prisma is order-independent), and both
sweeps parse the file with per-model regexes. Flagging it because it is a literal brief deviation.

`GlAccount` carries the three **named** relations (`BillingSalesTaxGl`, `BillingFreightGl`,
`BillingOtherChargeGl`) — required, as the brief warned. `Invoice`'s partial unique is on one line:

```
@@unique([orderId], where: raw("\"deletedAt\" IS NULL AND \"kind\" = 'INVOICE'::\"InvoiceKind\""))
```

`npx prisma format` was run afterwards and **preserved the one-line form** (verified by grep, and by
the sweep passing). The format pass also realigned columns on `GlAccount`, `ProcessStepCode`,
`Customer`, `Part`, `OrderCharge` and `PartPriceBreak` — that whitespace is the bulk of the schema
diff and carries no semantic change.

---

## 4. Deletions (Step 5) — what each file contained

| deleted | lines | contents |
|---|---|---|
| `src/server/part-price-breaks.ts` | 87 | `PartBreakRow` type; `listPartBreaks`, `addPartBreak` (with the LOT refusal and the live-duplicate pre-check), `updatePartBreak`, `deletePartBreak` |
| `tests/part-price-breaks.test.ts` | 87 | 7 cases: threshold-ascending list, duplicate-live-threshold rejection, delete-then-reuse under the partial unique, LOT refusal, decimal bounds, part-scoping of update/delete, `partPriceBreak` audit entries |
| `src/app/api/parts/[id]/breaks/route.ts` | 18 | `GET` (list) + `POST` (add), both `mustDo(user, "change_prices")` on write |
| `src/app/api/parts/[id]/breaks/[breakId]/route.ts` | 22 | `PATCH` + `DELETE`, both `change_prices` |
| `src/app/parts/[id]/PricingSection.tsx` | 182 | the part page's pricing card — four bound inputs plus the price-break grid, gated on `parts.edit` ∧ `change_prices` |

Both now-empty route directories were removed. No commented-out bodies, no render-nothing stubs, no
empty `PRICING_FIELDS` tuple.

**Modified as part of the same removal**

- `src/lib/part-constants.ts` — `PRICING_FIELDS` deleted; the four pricing columns removed from
  `PART_PASTE_COLUMNS`, with a comment recording that pricing is deliberately not in the paste
  contract in 5A (spec §4.1). `PRICE_PER` / `PRICE_PER_LABELS` / `PricePerValue` **kept** — the
  `PricePer` enum still exists on `PartPrice` and `InvoiceLine`, and plan Task 5 names
  `PRICE_PER_LABELS` as a consumed interface. They have no current importer, which is expected for
  two tasks.
- `src/app/api/parts/route.ts`, `src/app/api/parts/[id]/route.ts` — both `PRICING_FIELDS.some(...)`
  guards and the now-unused `mustDo` imports removed.
- `src/app/api/parts/export/route.ts` — the four pricing columns removed from the xlsx column list.
- `src/app/api/parts/paste/route.ts` — `allowPricing` removed (see §7 below).
- `src/app/parts/[id]/page.tsx` — `PricingSection` import and usage, the four fields on the local
  `Part` type, the `PricePerValue` import, and the stale `PRICING_FIELDS`-gate comment on `save()`.
  The delete-confirmation prompt now says "specifications, inspections, and prices" (it cascades
  price ROWS now, not breaks).
- `src/server/parts.ts` — four zod fields, four `SELECT` entries, the Decimal→number mapping and the
  `PartRow` members, `parsePricePer`, the paste handling, and the `pricePer`-change Serializable
  branch with its LOT/breaks check. `updatePart`'s Serializable trigger is now `materialId` alone.

**Tests updated (cases deleted, never weakened)**

- `tests/parts.test.ts` — deleted `"switching pricePer to LOT with live breaks is refused"` (its
  rule moves to `part-prices.ts` in Task 4 per the brief). The decimal-precision case kept its two
  `eachWeight` assertions and dropped only the `unitPrice` round-trip, since `eachWeight` still
  exercises `decimalField`. One `toMatchObject` lost its `pricePer: "EACH"` key.
- `tests/parts-paste-export.test.ts` — deleted `"pricePer accepts the enum names case-insensitively"`
  and `"pricing cells without allowPricing are per-row errors"` (both had no subject left). The
  export header-row assertion lost four columns. The paste-route case kept its 401/403 assertions
  and dropped its `change_prices` half, renamed to `"paste route: parts.create required"`.
- `tests/parts-routes.test.ts` — deleted `"break routes demand change_prices unconditionally"`
  (routes gone) and `"POST with any pricing field present requires change_prices"` (guard gone).
  `"PATCH ... pricing fields likewise; plain edits pass with parts.edit alone"` was **narrowed, not
  hollowed**: the plain-edit and 401 assertions are a different, still-live rule, so the case
  survives as `"PATCH /api/parts/[id] passes with parts.edit alone"`. The non-object-body 400 case
  survives with its comment rewritten to name `assertRecord` as what makes it a 400 now.

Net: **1409 → 1415** tests (18 added by the new smoke test, 12 deleted, and the arithmetic works out
because the smoke file adds 18 while the five deleted cases plus the seven from
`part-price-breaks.test.ts` come to 12).

**Stale prose references cleaned** — four comments named `addPartBreak` / `part-price-breaks.ts`
after those ceased to exist (`src/server/attachments.ts`, `src/server/part-field-values.ts`,
`src/server/parts.ts`, `tests/attachments.test.ts`). Each was reworded to name only the surviving
siblings; the `part-field-values.ts` one notes that the LOT/breaks Serializable pair moved with the
pricing rather than vanishing.

---

## 5. Sweeps

### Partial-unique sweep

Two documented exemptions added beside `Shipper.bolNumber`, with the prose the brief specified:
`Invoice.creditNumber` (allocated from `credit_number_next`, never reissued; a discarded draft must
not free a number a customer holds on paper) and `Invoice.clientRequestId` (idempotency key). The
block also records explicitly that `Invoice`'s **live-rows-only** `@@unique([orderId], where: …)` is
a different thing and is NOT exempted.

**Bite verification (the check the brief asked for), performed and restored:**

| removed from `ALLOWED` | result |
|---|---|
| `Invoice.creditNumber` | `1 failed` — `expected [ 'Invoice.creditNumber' ] to deeply equal []` |
| `Invoice.clientRequestId` | `1 failed` — `expected [ 'Invoice.clientRequestId' ] to deeply equal []` |
| (restored) | `2 passed` |

Each removal was made against a backup copy and reverted immediately; the file in the commit is the
original with both entries present.

The sweep's *first* test (no `findUnique`/`upsert`/`update`/`delete` keyed on a live-rows-only
column) now also covers five newly-partial column names — `orderId`, `processStepCodeId`,
`surchargeId`, `partPriceId`, `partId_processStepCodeId`. Checked before and after the change: **no
call site in `src/**` or `prisma/seed.ts` keys any of those methods on any of them**, so no new
allowlist entry was needed. Worth knowing for later tasks: `Invoice.orderId` is now a
partial-unique column name, so `invoice.update({ where: { orderId } })` will fail this sweep by
design.

### Reference-links sweep

**The brief missed one thing here, and it was a real bug.** Adding the nine registry entries made
`tests/reference-links-sweep.test.ts`'s hard-coded `"finds every known reference FK when nothing is
registered"` list stale. I let the test tell me what the schema walk actually finds rather than
guessing, and the nine it reported are **exactly** the nine the brief listed:

```
billingConfig.certChargeStepCodeId -> processStepCode
billingConfig.freightGlAccountId -> glAccount
billingConfig.otherChargeGlAccountId -> glAccount
billingConfig.salesTaxGlAccountId -> glAccount
invoiceLine.glAccountId -> glAccount
invoiceLine.processStepCodeId -> processStepCode
partPrice.processStepCodeId -> processStepCode
surcharge.glAccountId -> glAccount
surchargeStepCode.processStepCodeId -> processStepCode
```

The list was updated with two comments: one noting `invoiceLine`'s two survive because the sweep's
cascade exemption covers `onDelete: Cascade` only (these are `SetNull`), and one recording that
`invoiceLine.surchargeId` / `customerSurcharge.surchargeId` are deliberately absent until Task 6
makes `surcharge` a `BlockerTarget`.

---

## 6. The defect the brief's registry snippet contained

**This is the most important finding in the task.** The brief's `REFERENCE_LINKS` entries for
`surchargeStepCode` and the four `billingConfig` columns supply no `liveWhere`. `findBlockers`
(`src/server/reference-blockers.ts:34`) defaults it to `{ deletedAt: null }`:

```ts
where: { [link.column]: id, ...(link.liveWhere ?? { deletedAt: null }) },
```

Neither `SurchargeStepCode` nor `BillingConfig` has a `deletedAt` column. That is not an
over-reporting bug — Prisma throws `Unknown argument 'deletedAt'`, so **every GL-account and
process-step-code delete in the application 500s**. Taken as-written the brief would have shipped
that. It surfaced as 21 failures across 6 files on the first full `npm test` (`reference-gl`,
`process-step-codes`, `process-step-code-blockers`, `reference-blockers`, `reference-tables`).

Fixed with two shared constants beside the existing `PART_VIA_CHILD` / `CERT_VIA_REQUIREMENT`:

- `SURCHARGE_VIA_STEP_CODE` — `liveWhere: { surcharge: { is: { deletedAt: null } } }` (liveness is
  inherited from the parent, the `partProcessStep` precedent), plus `blockerId`/`displayName`
  reading the parent surcharge, because a `SurchargeStepCode` row has no `name` and is not a thing
  a person can act on. Without those, the blocker list would have rendered a bare join-row cuid.
- `BILLING_CONFIG_BLOCKER` — `liveWhere: {}` (the singleton is always live) and a constant
  `displayName` of `"Plant billing settings"`. Its four columns share one `blockerId` (the row's own
  `'singleton'` id), so `findBlockers`' dedupe on `entityLabel:blockerId` lists a GL account used as
  two of the three billing accounts **once**, which is the behaviour you want.

`INVOICE_VIA_LINE` was copied from the brief unchanged and already carried its `liveWhere`;
`partPrice` reuses `PART_VIA_CHILD` as instructed and `PartPrice` does have `deletedAt`, so the
default is correct there.

---

## 7. Ambiguities and how I resolved them

Four things the brief did not cover. All are recorded here rather than buried.

**(a) `DocumentKind` widening breaks `src/server/documents.ts`, and deletion does not fix it.**
The brief's Step 5 says "dropping the four Part columns breaks tsc in a known set of places. Every
one is resolved by deletion." That is true of the Part columns but not of the enum:
`AREA_FOR_KIND` is `Record<DocumentKind, Area>` (a missing entry is a compile error **by design** —
its own comment says so), and `documentFilename` / `resolveDocumentFilename` are exhaustive switches
returning `string`. Plan Task 15 owns `documents.ts`, so there is a genuine task-ordering conflict.

CLAUDE.md is explicit and binding here: *"Adding a `DocumentKind` means a new migration extending
the CHECK **and** the `DocumentOwner` union + `AREA_FOR_KIND` in `src/server/documents.ts`"* — and
the brief's own Step 3 comment says to keep the CHECK in step with `DocumentOwner`/`AREA_FOR_KIND`.
So I did the schema-shaped half and stopped:

- **Done here:** `AREA_FOR_KIND` gains `INVOICE`/`CREDIT` → `"invoicing"`; `DocumentOwner` gains both
  arms; `ownerColumns` gains both arms (refactored to a `none` spread so every arm sets every column
  explicitly, which is what makes it mirror the CHECK); `DocumentMeta` and `DOCUMENT_SELECT` gain
  `invoiceId`; `documentFilename` yields `invoice-72026.pdf` / `credit-1000.pdf` per spec §10, taking
  `creditNumber` as a fourth caller-supplied argument (the module performs no lookups, by its own
  rule); `resolveDocumentFilename` gains the one case that does. `audit.ts`'s `SNAPSHOT_SELECT`
  entry for `storedDocument` gains `invoiceId` to keep its "every scalar except `fileData`" contract.
- **Left for Task 15:** `listDocumentsForOrder`'s `OR` gains `{ invoice: { orderId } }`, and
  `printInvoice` itself. Task 15's Step 1 should be trimmed accordingly.

Making `DocumentMeta.invoiceId` required forced `invoiceId: null` into four hand-built literals
(`traveler.ts`, the cert print route, two in the shipper print route) and one test fixture — all
mechanical.

**(b) `truncateAll()` deleted the BillingConfig singleton.** The migration seeds the row precisely
so `getBillingConfig` is "a plain `findFirst`" and `setBillingConfig` "a plain audited update with a
real before-snapshot" (spec §4.5 / the brief's own Step 3 comment). But `tests/helpers/db.ts`
truncates every table in `beforeEach`, so in the test environment that row would not exist — and
Task 3, finding `findFirst` returning `null` in every test, would be pushed toward exactly the lazy
create the spec rules out. I added a re-seeding `INSERT … ON CONFLICT DO NOTHING` to `truncateAll`,
with a comment explaining why, and a smoke-test case asserting the row survives a truncate. This
touches a helper every one of the 97 test files uses; the full suite is green.

**(c) `deletePart`'s cascade had to change.** It soft-deleted `partPriceBreak` rows by `partId`,
which no longer compiles. Deleting the line outright would have silently dropped a real invariant (a
deleted part's pricing stays live), so I translated it one level up: it now cascades the part's
`PartPrice` rows. Their breaks are deliberately left alone, matching the rule plan Task 4 states for
`deletePartPrice` ("its breaks are left as they are"). The part page's delete prompt was updated to
match.

**(d) `pasteParts(text, { allowPricing })`.** With no pricing columns in the paste contract the flag
guards nothing, so I removed the parameter entirely rather than leave a dead option — the brief's
"remove the paste handling", and spec §4.1's "not part of the parts paste contract in 5A", make this
permanent rather than temporary. `src/app/api/parts/paste/route.ts` no longer imports `canDo`.

**Also worth flagging:** plan line 742 tells Task 5 to "remove the `// TASK 5:` marker Task 2 left".
I left no marker — the amended brief forbids stubs and placeholders, and a dangling marker comment
is the kind of thing a reviewer flags. Task 5 has nothing to remove.

**Not done, deliberately:** `docs/HANDOFF.md` and spec §15 were not touched. Task 1 did not touch
them either, and `progress.md` records the controller's intent to fold notes in "at phase wrap". I
did make one surgical `CLAUDE.md` edit, because a *binding* constraint there had become factually
wrong: the paragraph naming where `StoredDocument_kind_owner_check` lives and which arms it has. It
now names both migrations, the current arm list including INVOICE/CREDIT, the `ADD VALUE`-in-its-own-
directory rule, and a new bullet for the `BillingConfig` singleton and the `truncateAll` re-seed.
(CLAUDE.md's "1010 integration tests" figure was already stale before this task and is left alone to
avoid per-task churn; it currently reads 1415.)

---

## 8. Tests written — `tests/invoicing-schema.test.ts` (18 cases)

Modelled on `tests/certs-schema.test.ts`, including its `checkViolation` matcher shape
(`P2010` / `originalCode: "23514"`) and its raw-`$executeRaw` approach for the CHECK cases — the
generated client's types make the illegal combinations uncompilable, so the point is proving the
**database** refuses them.

- **Graph round-trips** — part → `PartPrice` (per step code, with `pricePer`, setup/unit/minimum
  decimals) → `PartPriceBreak` ordered by threshold; invoice → lines with an `OPERATION` line
  hanging off its `PART` line via `parentLineId`, reading back `children`, the live step-code and GL
  names, snapshot columns and every pricing input.
- **The re-parent's consequence** — the same threshold on two different price rows of one part is
  now legal (it was not when breaks hung off the part), while a duplicate on one row still `P2002`s.
- **The live-rows-only `@@unique([orderId])`** — a second live `INVOICE` is rejected; a soft-deleted
  one frees the order; two `CREDIT`s sit alongside a live invoice.
- **The two sweep exemptions, proved not asserted** — `creditNumber` and `clientRequestId` stay
  taken after the invoice is discarded, and NULLs still never collide.
- **Snapshot + release** — deleting an `OrderLine` releases `InvoiceLine.orderLineId` to null and
  the snapshot columns keep printing, rather than the delete being blocked.
- **Enum contract** — all six new types compared to their `invoice-constants.ts` arrays via
  `pg_enum ORDER BY enumsortorder`, plus `DocumentKind`'s six values in order.
- **`StoredDocument` CHECK** — accepts `INVOICE`/`CREDIT` owned by `invoiceId` alone; rejects an
  `INVOICE` naming an order, an `INVOICE`/`CREDIT` with no invoice, a `CERT` carrying an invoice, a
  `TRAVELER` carrying an invoice, and (regression guard on the deliberately-loose arm) a `SHIPPER`
  naming an order but no shipment.
- **`BillingConfig`** — the seeded row survives a truncate; `('other')` is refused by the CHECK; all
  four FKs resolve to real `GlAccount`/`ProcessStepCode` rows (the §4.5 point: references, not
  strings, so a delete guard can name its blockers).

---

## 9. Gates

| gate | result |
|---|---|
| `npm test` | **97 files / 1415 tests passed, 0 failed** (from 1409 at Task 1) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | succeeds (standalone build) |
| `npx prisma migrate status` — `erp` | "Database schema is up to date!" (25 migrations) |
| `npx prisma migrate status` — `erp_test` | "Database schema is up to date!" (25 migrations) |
| `npm run test:e2e` | **all 15 Playwright flows PASS** |

E2E was run because `src/app/parts/[id]/page.tsx` changed (owner rule: Playwright on any
UI/flow-touching change). Note that `npx tsc --noEmit` reported four errors against stale
`.next/types/validator.ts` / `.next/dev/types/validator.ts` entries for the deleted `breaks` routes
until those generated directories were removed; `npm run build` regenerates them correctly, and the
final tsc run above was after a real build.

---

## 10. For the reviewer / next tasks

1. **Task 15's Step 1 is partly done** — see §7(a). Only `listDocumentsForOrder`'s `OR` clause and
   `printInvoice` remain.
2. **Task 4** owns: the `partPrice` / `partPriceBreak` services, the LOT-vs-breaks rule (deleted from
   `parts.ts` here, as instructed), and whether `deletePartPrice` needs anything beyond what
   `deletePart`'s new cascade already does.
3. **Task 6** must widen `BlockerTarget`, `TARGET_LABELS`, the sweep's `kinds` set and add the two
   `surchargeId` registry entries **together** — the sweep is green today only because `surcharge`
   is not yet a target, and splitting that change leaves it red between commits.
4. **`Invoice.orderId` is now a partial-unique column name.** Any later
   `findUnique`/`upsert`/`update`/`delete` keyed on `orderId` — on *any* model, the sweep is
   column-name-only — will fail `tests/partial-unique-sweep.test.ts`. Use
   `findFirst({ where: { orderId, deletedAt: null } })`.
5. `PRICE_PER` / `PRICE_PER_LABELS` in `src/lib/part-constants.ts` currently have no importer. That
   is expected until Task 5; don't "clean them up".
