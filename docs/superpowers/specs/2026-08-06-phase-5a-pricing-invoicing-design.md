# Phase 5A — Pricing & Invoicing: Design Specification

**Date:** 2026-08-06
**Status:** Approved by owner in the design session of 2026-08-06 (§3 records every ruling taken)
**Branch:** `phase-5a-pricing-invoicing`
**Supersedes, in part:** spec §7.5 (pricing hierarchy), §7.6 (invoice grouping), §5.1's Invoice/Credit row
**Depends on:** Phase 3 (orders, loads, `allocateNumber`, `StoredDocument`), Phase 4 (`ship-ledger.ts`,
`order-locks.ts`, `documents.ts`, credit hold's override-with-reason shape)

---

## 1. Goal

Turn shipped orders into invoices the shop can send, priced from the part's own operation prices,
with surcharges, freight, extra charges, certification charges and sales tax, printed to the layout
of `docs/samples/Invoice Sample.pdf` and stored byte-for-byte.

Phase 5 as the roadmap wrote it is eleven subsystems. The owner split it (§3.1) into **5A pricing and
invoicing**, **5B accounts receivable**, and **5C month-end close and the QuickBooks Online summary
export**. This document is 5A alone. The roadmap's testable outcome — "invoice shipped orders and
reconcile a month" — is reached at the end of 5C; 5A's own testable outcome is **"price and invoice a
shipped order, correct it, and reprint it."**

## 2. Scope

**In:** part price rows keyed by Process Step Code (replacing the part's four price columns); the
surcharge subsystem; the pricing resolution engine; invoice creation from shipped orders; the
invoice's draft → finalized → unlocked lifecycle; credits; the reversing shipment; freight,
extra-charge, certification-charge and sales-tax billing; plant billing configuration; the invoice
and credit PDFs with permanent stored bytes; the `/invoicing` worklist and invoice page; the order
hub's Invoices section; Admin → Surcharges and Admin → Billing.

**Out (5B):** payments, payment batches, applications, aging, statements, finance charges.
**Out (5C):** the month-end close record and the QBO summary GL export.
**Out (Phase 6):** quote-sourced pricing — tier 1 of the resolution chain.
**Out (Phase 7):** template editing of any kind, including the invoice layout.

**No dangling columns for later phases** (the 2C-2 §2 rule). 5A adds nothing that only 5B or 5C would
read. Where 5B/5C need a hook, §16 names it as an obligation rather than a column.

## 3. Owner decisions, 2026-08-06 (this design session)

1. **Phase 5 is split into 5A / 5B / 5C**, each with its own spec, branch, review loop and merge.
   Phase 2C's three-way split (owner ruling, 2026-08-01) is the precedent: as written, Phase 5 was
   roughly 3× Phase 4, and nothing would have merged for weeks. 5A is about Phase-4-sized.

2. **The `7` in the sample's `Invoice No.: 7 − 72026` is a plant / form code, not a sequence.** The
   invoice's real number is the **order number**. `invoice_number_next` therefore stays in the
   settings registry **unused by design**, exactly as `cert_number_next` does (Phase 4 §3.19) — do
   not wire it up. The prefix becomes a typed setting so the paper can keep printing it.

3. **A part carries more than one priced operation.** The sample's `PRICE` block is headed
   `Austemper` — a Process Step Code name — and a job can bill austempering and straightening as
   separate rows on one invoice. Part pricing is therefore restructured from four columns on `Part`
   into **price rows keyed by Process Step Code** (§4.1).

4. **The restructure replaces, it does not coexist.** `Part.setupCharge` / `unitPrice` /
   `minimumCharge` / `pricePer` are dropped rather than kept as a fallback: two representations of
   one price would force every reader to answer "row or column wins?", and a column price has no
   Process Step Code and therefore no GL account. **Verified before ruling: the dev database is
   empty** — 0 parts, 0 customers, 0 orders, 0 step codes — so there is nothing to backfill. This
   change is free today and expensive after the parallel run starts.

5. **One invoice per order, billed exactly once, when the order is fully shipped.** An order is
   invoiced when it reaches `SHIPPED` — which Phase 4 derives from the human ship-line-complete
   flags, not arithmetic. Partial shipments wait for the order to finish; they are not billed
   separately. Consequences the owner accepted explicitly: a five-order truck produces five
   invoices, and spec §7.6's configurable per-shipper / per-order / per-PO grouping is **superseded**
   — there is no grouping machinery and no grouping setting.

6. **Surcharges are built to the full spec §7.5 shape**: owner-defined named add-ons, percent or
   flat, with per-surcharge include/exclude lists of Process Step Codes, a minimum-dollar floor,
   their own GL account, and per-customer opt-out *and* rate override.

7. **An invoice must also be able to bill freight, order extra charges, sales tax and certification
   charges.** All four are real for this shop. Every one of them therefore needs a GL account it can
   reach, which is what §4.5's billing configuration exists for.

8. **Sales tax: one plant rate with an optional per-customer override.** `Customer.taxable = false`
   prints no tax line at all. Tax computes on priced operation lines + surcharges + extra charges +
   certification charges; **freight is excluded**. Single plant, so no tax-code table.

9. **The certification charge is decided per part, with a plant default and a per-customer
   suppression.** `Part.billForCert` (yes / no / inherit the plant default) and an optional
   `Part.certCharge`; a part that says bill but names no amount takes the plant default amount. One
   certification-charge line per invoice, billed when the **order** resolved to cert-required, priced
   from the **lead** part (the lead owns document identity — Phase 4, settled by design). A
   per-customer flag suppresses it entirely. The charge posts through a Process Step Code named in
   the billing configuration, so it carries a GL account like every other line.

10. **Corrections are unlock → correct → re-lock; credits are for invoices the customer already
    holds.** The existing `unlock_invoice` named action does the work, with a reason required and
    trimmed in the service and recorded in the audit entry — the credit-hold shape Phase 4 §16
    predicted would be reused here. Unlock stays available **after** printing: the stored PDF is the
    permanent record of what was sent, so the invoice's live content may move on.

11. **A credit is an `Invoice` row with `kind = CREDIT`**, derived from the original with the sign
    handled, freely reducible to a partial amount before finalizing, and numbered from a new
    `credit_number_next` counter — the order number is already spent on the invoice. One table, one
    lifecycle, one PDF builder. Visual Shop's "Dupe Inv to Credit" behaves the same way.

12. **Invoice lines are snapshotted at creation, in one line table.** A line owns its numbers from
    the moment it is written: shipped qty and weight, part identity, the step code, the pricing
    inputs that produced the price, and the GL account in force. A draft has an explicit
    **Recalculate from order**; finalize locks. This is Phase 4's snapshot + release doctrine
    (rulings 23–24) applied to permanent paper, and it is what makes Visual Shop's "from that point
    the invoice tables are authoritative and order-side edits no longer affect billing" true here.

13. **The setup charge is added on top of the minimum, not inside it**:
    `amount = max(extended, minimumCharge) + setupCharge`. The minimum is a floor on the work; setup
    is charged once in addition.

**Settled by design, not by ruling** (recorded so a later reader does not reopen them):

- **Finalize does not require a GL account.** Spec §15's amendment already rules that GL accounts are
  optional at entry and that *the export* must refuse rather than post without one. 5C owns that
  check; 5A's finalize is refused only for a line that still **needs a price**.
- **`Process:` on the invoice prints the lead part's priced operation names joined by comma.** For a
  single-operation part that is byte-identical to the sample — the same answer ruling 27 gave for
  multi-part certifications.
- **Discarding a draft invoice requires a reason** (§5.17): it frees the order number for a new
  invoice, which is exactly the unique-identifier case that rule governs. A printed or finalized
  invoice cannot be discarded at all.
- **The reversing shipment reuses `void_shipper`.** Spec §9's dangerous-action list reads
  "void/reverse shipper" as one action; no new named action is added.

## 4. Data model

Money is `Decimal(12, 2)`; unit prices are `Decimal(12, 4)`; rates and percentages are
`Decimal(9, 6)` (so 4% stores as `0.040000`); weights follow Phase 3/4 (`Decimal(12, 2)` totals,
`Decimal(10, 4)` each-weights); quantities are integers. Display text is `.max(n)` defaulting `""`
(the 2C-2 §4 convention).

### 4.1 Part pricing, restructured

```prisma
model PartPrice {
  id                String           @id @default(cuid())
  partId            String
  part              Part             @relation(fields: [partId], references: [id])
  processStepCodeId String
  processStepCode   ProcessStepCode  @relation(fields: [processStepCodeId], references: [id])
  position          Int              // print order of the PRICE rows on the invoice
  setupCharge       Decimal?         @db.Decimal(12, 2)
  unitPrice         Decimal?         @db.Decimal(12, 4)
  minimumCharge     Decimal?         @db.Decimal(12, 2)
  pricePer          PricePer         @default(EACH)
  breaks            PartPriceBreak[]
  deletedAt         DateTime?
  createdAt         DateTime         @default(now())
  updatedAt         DateTime         @updatedAt

  @@unique([partId, processStepCodeId], where: raw("\"deletedAt\" IS NULL"))
  @@index([partId])
  @@index([processStepCodeId])
}
```

`PartPriceBreak` re-parents from `partId` to `partPriceId`, keeping its `threshold` /`price` columns
and its rules: thresholds are expressed in **the parent row's** `pricePer` unit, and a `LOT`-priced
row still refuses breaks. Its live-rows-only unique becomes `([partPriceId, threshold])`.

`Part` loses `setupCharge`, `unitPrice`, `minimumCharge`, `pricePer` and its direct `priceBreaks`
relation. It gains `billForCert Boolean?` (null = inherit the plant default) and
`certCharge Decimal? @db.Decimal(12, 2)`.

`PRICING_FIELDS` in `src/lib/part-constants.ts` and the parts paste column order lose the four
dropped columns; price rows are edited on their own grid and are **not** part of the parts paste
contract in 5A.

### 4.2 Surcharges

```prisma
enum SurchargeKind  { PERCENT  FLAT }
enum SurchargeScope { ALL  INCLUDE  EXCLUDE }

model Surcharge {
  id            String              @id @default(cuid())
  name          String              // prints on the invoice, e.g. "EnergySur"
  kind          SurchargeKind       @default(PERCENT)
  rate          Decimal?            @db.Decimal(9, 6)   // PERCENT: 0.040000 = 4%
  amount        Decimal?            @db.Decimal(12, 2)  // FLAT
  minimumAmount Decimal?            @db.Decimal(12, 2)
  glAccountId   String?
  glAccount     GlAccount?          @relation(fields: [glAccountId], references: [id])
  scope         SurchargeScope      @default(ALL)
  position      Int
  active        Boolean             @default(true)
  deletedAt     DateTime?
  createdAt     DateTime            @default(now())
  updatedAt     DateTime            @updatedAt
  stepCodes     SurchargeStepCode[]
  customerRules CustomerSurcharge[]

  @@unique([name], where: raw("\"deletedAt\" IS NULL"))
}

model SurchargeStepCode {         // the INCLUDE or EXCLUDE list; replace-grid, no soft delete
  id                String          @id @default(cuid())
  surchargeId       String
  surcharge         Surcharge       @relation(fields: [surchargeId], references: [id])
  processStepCodeId String
  processStepCode   ProcessStepCode @relation(fields: [processStepCodeId], references: [id])

  @@unique([surchargeId, processStepCodeId])
}

model CustomerSurcharge {         // per-customer opt-out and override
  id          String    @id @default(cuid())
  customerId  String
  customer    Customer  @relation(fields: [customerId], references: [id])
  surchargeId String
  surcharge   Surcharge @relation(fields: [surchargeId], references: [id])
  optOut      Boolean   @default(false)
  rate        Decimal?  @db.Decimal(9, 6)
  amount      Decimal?  @db.Decimal(12, 2)
  deletedAt   DateTime?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@unique([customerId, surchargeId], where: raw("\"deletedAt\" IS NULL"))
}
```

`Customer.surchargeOptOut` keeps its existing meaning as the **blanket** switch: on, no surcharge of
any kind is appended for that customer. A `CustomerSurcharge` row refines one surcharge only.

`scope = ALL` ignores `stepCodes`; `INCLUDE` bills only operation lines whose step code is listed;
`EXCLUDE` bills every operation line whose step code is not listed. Visual Shop's separate
`_include` / `_include_nonppg` / `_exclude` key family collapses to one mode plus one list —
the same information, without three ways to express a contradiction.

### 4.3 Invoice and credit

```prisma
enum InvoiceKind     { INVOICE  CREDIT }
enum InvoiceStatus   { DRAFT  FINALIZED }
enum InvoiceLineKind { PART  OPERATION  SURCHARGE  FREIGHT  CHARGE  CERT  TAX }
enum PriceSource     { PART_PRICE  MANUAL }   // QUOTE is added by Phase 6

model Invoice {
  id              String        @id @default(cuid())
  kind            InvoiceKind   @default(INVOICE)
  orderId         String
  order           Order         @relation(fields: [orderId], references: [id])
  sourceInvoiceId String?                     // CREDIT: the invoice it derives from
  sourceInvoice   Invoice?      @relation("InvoiceCredits", fields: [sourceInvoiceId], references: [id])
  credits         Invoice[]     @relation("InvoiceCredits")
  creditNumber    Int?          @unique       // CREDIT only; allocation-only, sweep-exempt (§7)
  customerId      String
  customer        Customer      @relation(fields: [customerId], references: [id])
  status          InvoiceStatus @default(DRAFT)
  invoiceDate     DateTime      @db.Date
  // Snapshots of what the paper says — read unconditionally (§5.4)
  poNumber        String        @default("")
  termsName       String        @default("")
  billTo          String        @default("")  // rendered multi-line address block
  shipTo          String        @default("")
  materialName    String        @default("")  // lead part
  processNames    String        @default("")  // lead part's priced operations, comma-joined
  taxRate         Decimal?      @db.Decimal(9, 6)
  // Totals, all rounded, all sums of already-rounded lines
  subtotal        Decimal       @default(0) @db.Decimal(12, 2)   // OPERATION lines
  surchargeTotal  Decimal       @default(0) @db.Decimal(12, 2)
  chargeTotal     Decimal       @default(0) @db.Decimal(12, 2)
  certTotal       Decimal       @default(0) @db.Decimal(12, 2)
  freightTotal    Decimal       @default(0) @db.Decimal(12, 2)
  taxTotal        Decimal       @default(0) @db.Decimal(12, 2)
  total           Decimal       @default(0) @db.Decimal(12, 2)
  finalizedAt     DateTime?
  finalizedById   String?
  finalizedBy     User?         @relation(fields: [finalizedById], references: [id])
  clientRequestId String?       @unique       // idempotency nonce; sweep-exempt (§7)
  deletedAt       DateTime?                   // discarded DRAFT only (§5.5)
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  lines           InvoiceLine[]
  documents       StoredDocument[]

  @@unique([orderId], where: raw("\"deletedAt\" IS NULL AND \"kind\" = 'INVOICE'::\"InvoiceKind\""))
  @@index([customerId])
  @@index([status])
  @@index([invoiceDate])
  @@index([orderId])
}
```

The live-rows-only partial unique on `orderId` (further filtered to `kind = 'INVOICE'`) is the real
guard behind ruling 5: **one live invoice per order**, enforced by the database rather than by a
service check that a race could slip past. Credits are excluded from it because an invoice may be
credited more than once.

```prisma
model InvoiceLine {
  id                String           @id @default(cuid())
  invoiceId         String
  invoice           Invoice          @relation(fields: [invoiceId], references: [id])
  position          Int
  kind              InvoiceLineKind
  parentLineId      String?                                   // OPERATION lines hang off their PART line
  parentLine        InvoiceLine?     @relation("InvoiceLineTree", fields: [parentLineId], references: [id])
  children          InvoiceLine[]    @relation("InvoiceLineTree")

  // Every order-side link is nullable ON DELETE SET NULL — rulings 23-24
  orderLineId       String?
  orderLine         OrderLine?       @relation(fields: [orderLineId],       references: [id], onDelete: SetNull)
  processStepCodeId String?
  processStepCode   ProcessStepCode? @relation(fields: [processStepCodeId], references: [id], onDelete: SetNull)
  surchargeId       String?
  surcharge         Surcharge?       @relation(fields: [surchargeId],       references: [id], onDelete: SetNull)
  orderChargeId     String?
  orderCharge       OrderCharge?     @relation(fields: [orderChargeId],     references: [id], onDelete: SetNull)
  glAccountId       String?
  glAccount         GlAccount?       @relation(fields: [glAccountId],       references: [id], onDelete: SetNull)

  // Snapshots — what the paper says
  partNumber        String           @default("")
  partName          String           @default("")
  partDescription   String           @default("")
  description       String           @default("")   // operation / surcharge / freight / charge / cert / tax label
  glAccountName     String           @default("")   // the account number as text
  qty               Int?
  weight            Decimal?         @db.Decimal(12, 2)
  eachWeight        Decimal?         @db.Decimal(10, 4)

  // Pricing inputs, snapshotted so the line can explain itself forever
  pricePer          PricePer?
  unitPrice         Decimal?         @db.Decimal(12, 4)
  setupCharge       Decimal?         @db.Decimal(12, 2)
  minimumCharge     Decimal?         @db.Decimal(12, 2)
  breakThreshold    Decimal?         @db.Decimal(12, 2)   // the break that won, null if none
  minimumApplied    Boolean          @default(false)
  rate              Decimal?         @db.Decimal(9, 6)    // SURCHARGE percent or TAX rate
  priceSource       PriceSource?
  needsPrice        Boolean          @default(false)

  amount            Decimal          @default(0) @db.Decimal(12, 2)

  @@unique([invoiceId, position])
  @@index([invoiceId])
  @@index([orderLineId])
}
```

`parentLineId` is a self-relation rather than a parent *position* deliberately: a draft edit can
renumber positions, and CLAUDE.md's rule is that grouping identity must never rest on a value that
can be reused.

### 4.4 Changes to existing models

| Model | Change |
|---|---|
| `Part` | **drops** `setupCharge`, `unitPrice`, `minimumCharge`, `pricePer`; **gains** `billForCert Boolean?` (null = inherit plant), `certCharge Decimal? @db.Decimal(12, 2)`, relation `prices PartPrice[]` |
| `PartPriceBreak` | `partId` → `partPriceId`; unique becomes `([partPriceId, threshold])` among live rows |
| `Customer` | **gains** `salesTaxRate Decimal? @db.Decimal(9, 6)` (override), `certChargeSuppressed Boolean @default(false)`, relations `invoices Invoice[]`, `surchargeRules CustomerSurcharge[]` |
| `Order` | **gains** `invoices Invoice[]`. `INVOICED` and `REOPENED` become reachable (§5.2) |
| `OrderLine`, `OrderCharge`, `ProcessStepCode`, `GlAccount` | back-relations from `InvoiceLine` |
| `Shipper` | **gains** `reversesShipperId String?` + self-relation; a reversing shipment's lines may carry negative `qty`/`weight` (§5.6) |
| `StoredDocument` | **gains** `invoiceId String?` (`ON DELETE SET NULL`, matching its three existing owner columns); `DocumentKind` gains `INVOICE` and `CREDIT`; the hand-written `CHECK` gains their arm |
| `User` | back-relation `finalizedInvoices Invoice[]` |

### 4.5 Plant billing configuration

Freight, other-charge and sales-tax GL accounts, the certification-charge Process Step Code, the
default certification charge, the plant sales-tax rate and the plant "bill for cert" default all have
to be **referenced, not typed as free strings** — otherwise deleting a GL account cannot name its
blockers, which §5.14 makes binding. They are therefore real foreign keys on a single row rather than
values inside `Setting` JSON:

```prisma
model BillingConfig {
  id                     String           @id @default("singleton")
  salesTaxRate           Decimal?         @db.Decimal(9, 6)
  salesTaxGlAccountId    String?
  salesTaxGlAccount      GlAccount?       @relation("BillingSalesTaxGl",    fields: [salesTaxGlAccountId],    references: [id])
  freightGlAccountId     String?
  freightGlAccount       GlAccount?       @relation("BillingFreightGl",     fields: [freightGlAccountId],     references: [id])
  otherChargeGlAccountId String?
  otherChargeGlAccount   GlAccount?       @relation("BillingOtherChargeGl", fields: [otherChargeGlAccountId], references: [id])
  certChargeStepCodeId   String?
  certChargeStepCode     ProcessStepCode? @relation(fields: [certChargeStepCodeId], references: [id])
  certChargeDefault      Decimal?         @db.Decimal(12, 2)
  billForCertDefault     Boolean          @default(false)
  updatedAt              DateTime         @updatedAt
}
```

A hand-written `CHECK ("id" = 'singleton')` pins it to one row, in the same migration and the same
style as `StoredDocument_kind_owner_check`. The trade-off is recorded rather than hidden: plant
billing configuration now lives in two homes — scalars that need no FK stay in `Setting`, these do
not. The alternative (cuids inside `Setting` JSON) is tidier and silently voids the delete guard.

### 4.6 Settings

Two new keys, both plain scalars:

- `credit_number_next` — `numberSeed`, default `1000`, group Numbering.
- `invoice_number_prefix` — `z.string()`, default `""`, group Numbering. Prints ahead of the order
  number as the sample's `7 −`.

`invoice_number_next` **stays in the registry and is now unused by design** (ruling 2), joining
`cert_number_next`. Both carry the comment that already sits above `cert_number_next`: do not wire
this up.

## 5. Rules and the concurrency contract

### 5.1 Locks

Every invoice mutation is `withDbErrors` → `$transaction` (Serializable — the registered-FK writer
pattern applies to `processStepCodeId`, `glAccountId` and `surchargeId` through `assertRefExists`)
→ **`claimOrder(tx, orderId)`** → **claim the invoice row** (`SELECT "id" FROM "Invoice" WHERE
"id" = $1 FOR UPDATE`) → re-read → act. Order first, then the entity's own row: the fixed order
`order-locks.ts` already documents, and the house rule it carries — *the guarded state must live on,
or be locked with, the claimed row.*

A credit claims the order, then the **source invoice** row, then its own row, in that order. The
reversing shipment reuses `claimOrdersInOrder` and `voidShipper`'s machinery; **no second,
differently-ordered claim path is added anywhere.**

`allocateNumber("credit_number_next", tx)` runs inside the claim. Invoices allocate nothing — their
number is the order's.

### 5.2 Statuses, and who owns them

`OPEN` / `PARTIAL_SHIPPED` / `SHIPPED` remain **ship-derived**, recomputed by
`recomputeOrderStatus` from the human ship-line-complete flags exactly as Phase 4 built it.

`INVOICED` and `REOPENED` become **invoice-owned**:

- finalizing an `INVOICE` writes `INVOICED`;
- a reversing shipment against an order with a finalized invoice writes `REOPENED`;
- unlocking returns the order to its ship-derived value by calling `recomputeOrderStatus`.

`recomputeOrderStatus` gains one rule: **it leaves an order alone while that order is in an
invoice-owned state**, the same shape as its existing skip for voided orders. Without this, any
shipment-side recompute would silently drop `INVOICED` back to `SHIPPED`. Finalizing a `CREDIT`
changes no order status.

### 5.3 Creation

Candidates are live, unvoided orders at `status = SHIPPED` with no live invoice. The worklist is
filterable by customer and ship-date range and exports to Excel like every other list.

Creating an invoice needs `invoicing.create`. Per order, inside one claimed transaction: read the
ship ledger (`shippedTotals`) for the order's lines, resolve prices (§6), write the header snapshot
and every line through `auditedCreate`, compute totals. A bulk run is a loop of these, each
independent — one order's failure never rolls back another order's invoice, and the response names
each failure beside its order. The **live-rows-only unique on `orderId`** is the guard against a
double-create; `clientRequestId` answers the lost-response case the same way `createOrder` and
`createShipper` do, and the client mints **one nonce per candidate order**, not one per run, so a
retried run cannot merge two orders' idempotency.

`invoiceDate` defaults to the creation date, stays editable while the invoice is a draft, and is
frozen at finalize.

**Line composition and ordering.** One `PART` line per order line with a **non-zero net shipped
total**, carrying that line's shipped qty and weight and **no money** (`amount = 0`); beneath it, one
`OPERATION` line per live `PartPrice` row of that line's part, in `position` order. Then, at invoice
level and in this order: `SURCHARGE` lines (surcharge `position`), `FREIGHT`, `CHARGE` lines
(`OrderCharge.position`), `CERT`, and `TAX` last. `InvoiceLine.position` is assigned in exactly that
sequence, so the stored order is the printed order.

The order hub carries the same action for a single order.

### 5.4 Reads are snapshot-first

An invoice is frozen paper, not a document being edited. Its identity and pricing fields are
**read from the snapshot unconditionally** — never live-join-first — which is ruling 24's refinement
applied here: a part rename, a step-code rename or a surcharge rate change must never rewrite an
invoice that has already been raised. (Shipment grids stay live-join-first because a shipment is
being edited; a certification and an invoice are not.)

### 5.5 Draft, finalize, unlock, discard

- **Draft edits** need `invoicing.edit`; any edit that changes money on a line additionally needs
  `change_prices` — the named action that already gates part pricing.
- **Recalculate from order** re-reads the ship ledger and the part prices and replaces every derived
  line, **preserving manual lines** (`priceSource = MANUAL`). It is refused on a finalized invoice.
- **Finalize** (`invoicing.edit`) is refused while **any line has `needsPrice`**. It stamps
  `finalizedAt` / `finalizedById`, writes `Order.status = INVOICED`, and is idempotent — finalizing a
  finalized invoice is a 400 naming the state, never a second write. It does **not** check GL
  accounts (§3, settled by design).
- **Unlock** needs `mustDo(user, "unlock_invoice")` and a **reason, required and trimmed in the
  service**, recorded in the audit entry — never a column, never printed. It returns the invoice to
  `DRAFT` and recomputes the order's status. It stays available after printing.
- **Discard** (`invoicing.delete`) soft-deletes a `DRAFT` that has **never printed**, with a reason
  required (§5.17 — it frees the order number). A finalized or printed invoice can never be
  discarded; correct it or credit it.

### 5.6 Credits and the reversing shipment

A **credit** is raised from a finalized invoice: lines are copied with the sign flipped and
`sourceInvoiceId` set, `creditNumber` allocated, then edited down to a partial amount if wanted,
finalized and printed. Its lifecycle is the invoice's; its permissions are the invoice's.

A **reversing shipment** is a `Shipper` with `reversesShipperId` set, whose lines carry negative
quantities and weights, defaulting to the original shipment's ship date. It requires
`mustDo(user, "void_shipper")` and a reason. It claims through `claimOrdersInOrder`, is refused if it
would drive any line's shipped-to-date below zero, and — when the order has a finalized invoice —
writes `REOPENED`. `shippedTotals` needs no change: it already sums `qty`, so negatives reduce the
ledger by construction. The over-ship warning is computed against the net total, so a reversal never
raises one.

### 5.7 New order- and shipment-edit invariants

Each refusal names the blocking invoice and links to it, the §5.14 discoverability rule Phase 4
already applies to shipments:

- **extra charges freeze** once a finalized invoice exists on the order — spec §7.1's "then the
  invoice owns them", enforced in the service;
- **voiding an order with a finalized invoice is refused** — credit or unlock first;
- **voiding or editing a shipment on an order with a finalized invoice is refused** — it would change
  what was billed; the corrections are unlock, or a reversing shipment.

`orders.ts` and `shippers.ts` must **not** import `invoices.ts` to ask these questions. A leaf
module **`invoice-guards.ts`** holds `finalizedInvoiceFor(tx, orderId)` and the blocker message, and
all three import it — the move that produced `order-locks.ts`, applied before the cycle exists rather
than after it crashes (Phase 4 lesson 3).

### 5.8 Warnings, never blocks

Returned as Phase 3's `warnings[]` and rendered as banners, named per line:

- a line priced at zero because the part carries no price row for that operation ("needs price") —
  finalize refuses, but creation never does;
- an `OrderCharge` with `amount = null` on the invoice;
- a part price row whose Process Step Code has no GL account (advisory in 5A; 5C's export refuses).

## 6. Pricing resolution

The chain of spec §7.5, with tier 1 absent until Phase 6:

1. ~~Quote referenced on the order~~ — **Phase 6.** 5A ships the chain with this tier missing and a
   documented seam (`PriceSource.QUOTE` is not added, per the no-dangling-columns rule).
2. **The part's `PartPrice` rows** — one `OPERATION` line per live row, in `position` order.
3. **Zero and flagged `needsPrice`** — never silently priced, never silently dropped.

`pricing.ts` is a **pure, I/O-free module**: plain data in, computed lines out. It is a leaf, it
imports nothing from the rest of `src/server/`, and it is where the exhaustive tests live.

**Per-operation math**, in that row's `pricePer`:

```
basis      = EACH      → shipped qty
             PER_100   → shipped qty / 100
             PER_1000  → shipped qty / 1000
             LB        → shipped weight
             LOT       → 1 (flat; basis is ignored)
breakBasis = LB        → shipped weight        (pounds)
             otherwise → shipped qty           (pieces)   ← 2C-2 ruling 1
price      = the live break with the highest threshold <= breakBasis, else unitPrice
extended   = basis × price
amount     = max(extended, minimumCharge) + setupCharge    ← ruling 13
```

**Amendment, 2026-08-07 (from Task 9's review).** This block previously compared break thresholds
against `basis`, which would have measured a per-100 row's thresholds in *hundreds*. That
contradicted the owner decision of 2026-08-01 (2C-2 design §3, decision 1): *"Price-break basis
follows the part's price-per unit. A per-lb part's break thresholds are pounds; a per-each /
per-100 / per-1000 part's are **pieces**."* The ruling governs, and `prisma/schema.prisma`'s
`PartPriceBreak.threshold` column cites it by name — so the two bases are now written out
separately. Only the **break comparison** changes; `extended` still divides by 100 or 1000 as
before, so no total moves for a row without breaks.

Concretely: a PER_100 row with a 500 break, shipped 1,000 pieces. Under the old text the basis was
10, the 500 break never triggered, and the customer paid list price. Under the ruling the 1,000
pieces clear the threshold and the break applies. `pricing.ts`'s `breakBasis()` implements the
ruling, with a test that moves a row across the `LB` boundary — the only crossing that reinterprets
a stored threshold, since EACH/PER_100/PER_1000 all count pieces.

`minimumApplied` is recorded when the floor won, and `breakThreshold` records which break did.
Shipped qty and weight come from `ship-ledger.ts` and nowhere else — the invoice never re-derives
totals from shipper rows itself. Rounding is **half-up to cents at every line**; totals are sums of
already-rounded lines, never a re-rounded sum.

**Surcharges** compute on the sum of `OPERATION` line amounts whose step code passes that surcharge's
`scope` filter — not on freight, charges, certification or tax. `PERCENT` → `base × rate`; `FLAT` →
`amount`; then floored at `minimumAmount`. A `CustomerSurcharge` row replaces the rate or amount;
either its `optOut` or `Customer.surchargeOptOut` suppresses the line entirely. Inactive and
soft-deleted surcharges are skipped.

**Freight** is one line summing `billFreight` amounts across the order's **live** shipments.

> **Owner ruling, 2026-08-07 — the multi-order freight over-bill is DEFERRED, knowingly.** Ruling 5
> (one invoice per order, grouping superseded) and this freight rule collide on a multi-order
> shipment: a Shipper carries one `freightAmount` for the whole truck, so N orders on one
> billable-freight truck each sum that same freight — an N× over-bill. Task 11's code implements
> this rule faithfully; the contradiction is the spec's, not the code's. The owner's own shop
> **does not bill freight at all**, so the defect is latent for this deployment and there is no
> billable-freight-on-a-multi-order-truck data to be wrong. Deferred rather than fixed because the
> correct split (freight on one order / proportional by weight or value / single-order-only) is a
> billing-policy question the owner wants to research against how other shops actually do it. Filed
> in HANDOFF §6. **Do not invent a split.** When it is picked up, whichever rule is chosen must sum
> back to the truck's exact freight, once.
**Extra charges** are one `CHARGE` line per live `OrderCharge`, `amount = null` → `needsPrice`.
**Certification charge** is one line when the order resolved cert-required and the lead part's
`billForCert` (or the plant default) says bill, priced from `Part.certCharge` else
`BillingConfig.certChargeDefault`, suppressed by `Customer.certChargeSuppressed`.
**Tax** is the last line: `(operations + surcharges + charges + cert) × rate`, freight excluded,
rate = `Customer.salesTaxRate ?? BillingConfig.salesTaxRate`, and no line at all when the customer is
not taxable.

**The sample is the golden case**, asserted as a test: 144 each at `$6.51` against a `$600.00`
minimum → `$937.44`; `EnergySur` at 4% → `$37.4976` → **`$37.50`** half-up; total **`$974.94`**.

## 7. Registry, sweeps, and audit surface

**`REFERENCE_LINKS`** gains every new FK that targets a reference kind, so the sweep stays green and
every blocked delete names its blockers:

| model | column | target | detail path |
|---|---|---|---|
| `partPrice` | `processStepCodeId` | `processStepCode` | `/parts/${id}` |
| `surcharge` | `glAccountId` | `glAccount` | `/admin/surcharges` |
| `surchargeStepCode` | `processStepCodeId` | `processStepCode` | `/admin/surcharges` |
| `invoiceLine` | `processStepCodeId` | `processStepCode` | `/invoicing/${id}` |
| `invoiceLine` | `glAccountId` | `glAccount` | `/invoicing/${id}` |
| `billingConfig` | `salesTaxGlAccountId` | `glAccount` | `/admin/billing` |
| `billingConfig` | `freightGlAccountId` | `glAccount` | `/admin/billing` |
| `billingConfig` | `otherChargeGlAccountId` | `glAccount` | `/admin/billing` |
| `billingConfig` | `certChargeStepCodeId` | `processStepCode` | `/admin/billing` |

The registry is keyed per `(model, column)`, so each column above is its own entry — the sweep walks
the Prisma schema and fails on any FK to a reference kind that is missing one.

Consequence, stated so it is a decision and not a surprise: **a Process Step Code or GL account that
an invoice has billed through can never be deleted.** That is correct under §5.14 — deletion is for
rows typed by mistake, and ordinary retirement is `active: false`, which keeps existing references
rendering.

**`Surcharge` becomes a `BlockerTarget`** in its own right: deleting one referenced by invoice lines
or customer rules is refused with the blocker list and its Excel export, the same treatment
`ProcessStepCode` has.

**Partial-unique sweep.** `Invoice.creditNumber` and `Invoice.clientRequestId` are plain field-level
`@unique` on a soft-deletable model and need **documented sweep exemptions** beside
`Shipper.bolNumber` / `Shipper.clientRequestId`: both are allocation-only or idempotency keys, never
re-entered, and a discarded draft must never free a credit number a customer holds on paper. The
`@@unique([orderId], where: raw(...))` block must stay on **one line** — the sweep's regexes assume
it (§5.11's known limit).

**Audit.** `invoice`, `invoiceLine`, `partPrice`, `surcharge`, `surchargeStepCode`,
`customerSurcharge` and `billingConfig` join `AuditableModel`. `SNAPSHOT_INCLUDE` gains:
`invoice → lines` ordered by `position`; `surcharge → stepCodes` ordered by `processStepCodeId`;
`partPrice → breaks` ordered by `threshold`. **Every collection gets an explicit `orderBy`** — issue
#24's lesson, applied at the point of writing rather than filed again.

## 8. Services

| Module | Responsibility |
|---|---|
| `pricing.ts` | **Pure.** Line math, break selection, minimums, surcharge computation, tax. No Prisma, no I/O, no imports from `src/server/`. |
| `part-prices.ts` | `PartPrice` + re-parented `PartPriceBreak` CRUD, gated on `change_prices`. |
| `surcharges.ts` | Surcharge CRUD, the include/exclude replace-grid, and the customer override rows. |
| `billing-config.ts` | Read/write the singleton, with `assertRefExists` on each FK. |
| `invoice-guards.ts` | **Leaf.** `finalizedInvoiceFor(tx, orderId)` + blocker message, for `orders.ts`, `shippers.ts` and `invoices.ts`. |
| `invoices.ts` | Candidates, create (single + run), read, draft edits, recalculate, finalize, unlock, discard, credit. |
| `pdf/invoice.ts` | The layout builder — plain data in, plain-JSON pdfmake definition out. |
| `shippers.ts` | Gains the reversing shipment, reusing its own claims and recompute. |

## 9. Routes

`/api/invoices` (GET list + candidates, POST create/run) · `/api/invoices/[id]` (GET, PATCH, DELETE)
· `/api/invoices/[id]/lines` (PUT replace) · `/api/invoices/[id]/recalculate` (POST) ·
`/api/invoices/[id]/finalize` (POST) · `/api/invoices/[id]/unlock` (POST) ·
`/api/invoices/[id]/credit` (POST) · `/api/invoices/[id]/print` (POST) ·
`/api/parts/[id]/prices` + `/api/parts/[id]/prices/[priceId]` (+ `/breaks`) ·
`/api/admin/surcharges` (+ `/[id]`, `/[id]/step-codes`) · `/api/admin/billing` ·
`/api/customers/[id]/surcharges` · `/api/shippers/[id]/reverse` (POST).

Every handler is `handle(...)`, authorizes first (`requireUser` + `mustCan`/`mustDo`), parses with
zod, delegates. The 401/403 route sweep is extended to cover all of them.

## 10. Documents

`DocumentKind` gains **`INVOICE`** and **`CREDIT`**, both owned by `StoredDocument.invoiceId`, both
mapping to the `invoicing` area in `AREA_FOR_KIND`. The hand-written CHECK gains:

```sql
(kind IN ('INVOICE','CREDIT') AND "invoiceId" IS NOT NULL
   AND "orderId" IS NULL AND "shipperId" IS NULL AND "certId" IS NULL)
```

`listDocumentsForOrder` gains a fourth branch (`{ invoice: { orderId } }`) so an invoice appears on
its order's hub, and `documentFilename` yields `invoice-72026.pdf` / `credit-1000.pdf`. The order
hub's `KIND_LABELS` map is completed for every kind while we are here — the cosmetic gap HANDOFF §6
recorded.

**`pdf/invoice.ts` builds to `docs/samples/Invoice Sample.pdf`**: title and company; `Invoice No.`
(`invoice_number_prefix` + the order number), `Invoice Date`, `Terms`, `Page No.`; the `Remit To`
box; `Billto` / `Shipto`; the order-information strip (`Our Order #`, `Your PO #`, `Material`,
`Process`); the **PARTS** grid (Quantity · Part No. / Name / Description · Each weight · Total Wt);
the **PRICE** grid (operation name → amount, with `Price per <unit>` and `Minimum Charge` beneath);
`Sub Total Amount`; one line per surcharge, named; `Total Amount Due`; the footer contact strip.
Credits print the same layout with the credit number and negative amounts.

Prints run through the existing bracket: settings read outside the transaction → Serializable
`$transaction` → claim → re-read → `assertPrintable` → render → `storeDocument`. Reprints reissue
stored bytes and are never re-rendered.

**Two deviations recorded rather than hidden**, both Phase 7's to close: the invoice prints no
"Page N of M" (a pure-JSON template cannot carry page-count functions — the shipping ticket's
identical limitation, owner ping #1); and `Process:` prints the lead part's priced operation names
comma-joined, which is byte-identical to the sample whenever a part has one priced operation.

## 11. UI

- **`/invoicing`** — a *Ready to invoice* section (orders at `SHIPPED` with no invoice, ticked and
  created in one run) above the invoice list, filtered by customer / status / date, Excel-exported.
  Closes one of the four nav entries that 404 today.
- **`/invoicing/[id]`** — header (customer, order, PO, terms, dates, status), the PARTS and PRICE
  grids, the charge/surcharge/freight/tax lines, totals; actions Recalculate, Finalize, Unlock,
  Print, Raise credit, Discard; the Documents list and `HistoryPanel`.
- **Order hub** gains an **Invoices** section (spec §6 lists it) with the create action.
- **Part page** — the Pricing section is rebuilt as price rows with nested break grids, still
  double-gated on `parts.edit` and `change_prices`.
- **Customer page** — per-customer surcharge overrides grid, sales-tax rate override, certification
  charge suppression.
- **Admin → Surcharges** (modelled on the step-codes page) and **Admin → Billing** (the singleton).

Controls the user cannot use are **disabled with a tooltip naming what is missing, never hidden**
(§5.16), through the shared permission helper. Every editable grid uses the existing `bulk-grid`
hook and the draft-preservation shape 2C-3 settled — keep only what the user typed, composed with
server state at render.

## 12. Testing

Vitest against the real `erp_test` database, `truncateAll()` per test, TDD per task.

- **`pricing.ts` unit tests** — every `pricePer`; break selection **at the boundaries** (exactly on a
  threshold, one below, one above, no breaks, a single break); the minimum floor winning and losing;
  setup on top; `LOT`; zero and needs-price; half-up rounding including `x.xx5`; the sample invoice's
  own numbers as a golden case.
- **Surcharges** — `ALL` / `INCLUDE` / `EXCLUDE`; percent and flat; `minimumAmount`; customer rate
  override; per-surcharge opt-out; blanket `Customer.surchargeOptOut`; inactive and soft-deleted
  surcharges skipped.
- **Tax** — base excludes freight; non-taxable customer produces no line; customer rate override.
- **Ledger integration** — partial shipments; over-ship; a voided shipment excluded; a released
  (`orderLineId = null`) shipper line; a reversing shipment netting the total.
- **Snapshot + release** — remove an order line after invoicing and the invoice still prints what it
  billed; rename a part or a step code and the invoice does not move.
- **Lifecycle** — finalize refused on needs-price; finalize idempotent; unlock requires a reason and
  the reason lands in the audit entry; discard refused once printed; the new order/shipment
  invariants each refuse and each name the invoice.
- **Concurrency**, each **verified by deleting its guard and watching the test go red**, with the
  competing caller pinned to **Read Committed** so only the row lock can serialise the two (Phase 4
  lesson 1): two concurrent creates for one order → exactly one invoice; finalize vs recalculate;
  unlock vs credit; reversing shipment vs finalize; part-price edit vs invoice create.
- **Idempotency** — the create run re-driven with the same `clientRequestId`.
- **PDF** — content-pinned assertions (never `Buffer.compare` on two fresh renders); stored-byte
  reprint compared exactly; the definition round-trips through `JSON.parse(JSON.stringify(...))`.
- **Sweeps** — `REFERENCE_LINKS` for every new FK; `AuditableModel` / `SNAPSHOT_INCLUDE` coverage;
  the partial-unique sweep with its two new documented exemptions; the 401/403 route sweep.

## 13. E2E and demo

A **16th Playwright flow**: enter an order against a part with two priced operations → ship it to
line-complete → create the invoice from the worklist → confirm the resolved prices, a surcharge and
tax → finalize → print → unlock with a reason → confirm the order returns to `SHIPPED`. It waits on
post-navigation-only content, **never a URL pattern** — `/invoicing/new` does not exist, but the
`/orders/new` and `/shipping/new` trap has now armed twice and the habit is cheap.

The whole suite runs against `npm run dev` and the dev database. An owner-facing walkthrough with
screenshots lands as a dated `docs/<date>-phase-5a-demo.md` before the merge, as every phase since
2C-3 has done.

## 14. Task shape (planner refines)

Foundations first, one fresh subagent per task with an independent spec-and-quality review and fix
rounds, then the whole-branch review before the PR. Roughly eighteen tasks:

1. Schema migration (hand-written per the `/create-migration` skill, both databases) + the two
   `CHECK` constraints + `REFERENCE_LINKS` entries + sweep exemptions + `AuditableModel` /
   `SNAPSHOT_INCLUDE`.
2. Settings (`credit_number_next`, `invoice_number_prefix`) + `billing-config.ts` + Admin → Billing.
3. `part-prices.ts` — price rows, re-parented breaks, `change_prices` gating.
4. Part page Pricing section rebuilt on price rows.
5. `surcharges.ts` + the include/exclude replace-grid.
6. Admin → Surcharges page.
7. Customer-side surcharge overrides, tax-rate override, cert suppression (service + customer page).
8. `pricing.ts` — the pure engine and its exhaustive tests.
9. `invoice-guards.ts` + the new order/shipment invariants in `orders.ts` / `shippers.ts`.
10. `invoices.ts` — candidates and creation (single + run), claims, snapshots, idempotency.
11. `invoices.ts` — draft edits, recalculate, discard.
12. `invoices.ts` — finalize, unlock, and the `INVOICED` / `REOPENED` status ownership.
13. Credits.
14. The reversing shipment in `shippers.ts`.
15. Routes + the 401/403 sweep.
16. `/invoicing` worklist page.
17. `/invoicing/[id]` invoice page + the order hub's Invoices section.
18. `pdf/invoice.ts` + print/store mechanics; then E2E flow, demo walkthrough, and docs.

## 15. Non-goals

- **No payments, applications, aging, statements or finance charges** — 5B.
- **No month-end close and no QBO export** — 5C. 5A adds no columns only they would read.
- **No quote-sourced pricing** — Phase 6 owns tier 1 of §7.5.
- **No invoice grouping machinery** — ruling 5 supersedes spec §7.6's per-shipper / per-order /
  per-PO configurability. There is no grouping setting to get wrong.
- **No email**, of any kind — Phase 4 §3.2's deferral stands, with issue #4's visible-skip obligation
  still travelling with email whenever it is built.
- **No template editing, no per-customer invoice variants, no logo upload** — Phase 7.
- **No exotic pricing** — screw/washer matrices, dimensional grids, inspection-based pricing,
  metal-market pricing, bracket/step price codes and PPG structures stay out (spec §3, permanent).
- **No mass price change** utility (Visual Shop's Part Maintenance Price Change) — Phase 8 at the
  earliest, if ever.
- **No credit types**, no "no charge" flag, no invoice utilities that rewrite history — the
  unlock/correct/re-lock and credit paths cover the correction scenarios, per spec §12.
- **No A/R balance**, so credit *limit* and past-due gates remain unbuildable; only `creditHold`
  is enforceable, as Phase 4 §3.7 already recorded.

## 16. What 5B and 5C inherit from 5A

- **`Invoice` is the A/R document.** 5B adds payments, applications and balances *against* it and
  must not restate its totals; `Invoice.total` is the amount owed at finalize.
- **`Order.status = INVOICED` is invoice-owned and set at finalize**; `recomputeOrderStatus` skips
  invoice-owned states. 5B's "close paid invoices" must not touch order status at all.
- **`Terms` is a name with no day count.** A due date and any aging bucket needs `Terms.netDays`,
  which 5A deliberately does **not** add (no dangling columns). **5B adds it**, together with
  `Invoice.dueDate` computed at finalize.
- **`Customer.financeChargeRate` and `Customer.parentId` are already modelled and still unread.** 5B
  is the phase that consumes both — the parent link so one check can pay several children's invoices
  and a statement can roll up, exactly as Phase 2B modelled it for.
- **`InvoiceLine.glAccountId` + `glAccountName` are the GL summary.** 5C's export groups finalized
  invoice lines by account and never re-walks orders. `ProcessStepCode.needsGlAccount` already
  exists and is surfaced; **5C is where the export refuses** rather than posting without an account —
  spec §15's amendment, and the assertion `process-step-codes.ts:79` promises.
- **`BillingConfig` is where 5C's remaining GL defaults belong** (A/R account, discount, adjustment,
  write-off, and the sales/credit accounts of the journal entry) — as FK columns on the same row, not
  as `Setting` strings.
- **`PaymentType.glAccountId` already exists** and is a pick-list with no consumer; 5B is its
  consumer.
- **`credit_number_next` is allocated; `invoice_number_next` and `cert_number_next` are not.** Do not
  wire either up.
- **The owner homework HANDOFF §7 records now gates 5C, not 5A**: the QuickBooks Online
  finance-charge treatment (settle with the bookkeeper) and the GL account list for operations,
  surcharges and payment types. 5A can be built, reviewed and merged before either arrives — but
  **the GL account list should be keyed before 5A's demo**, or the demo prices work through step
  codes with no accounts behind them.
- **`CustomerContact.getsInvoices` / `getsStatements` are still stored and still unread.** They wait
  for email, wherever it lands.
