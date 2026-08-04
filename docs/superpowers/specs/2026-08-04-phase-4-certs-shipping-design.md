# Phase 4 — Certifications & Shipping (design)

**Status: approved by the owner 2026-08-04 (design session in this document's §3).**
Branch: `phase-4-certs-shipping`.

Inputs this design answers to: the roadmap's Phase 4 line, the approved spec's §5.1/§6/§7.3/§7.4/§8/§9,
HANDOFF §4a (Phase 3's three review lessons), §5 (the conventions), §6 (the carried backlog) and §7
(the samples the owner still owes), Phase 3's design spec §16 (the inheritance list, quoted below
where it binds), the Visual Shop teardown Parts VII–VIII (certs and shipping), and
`docs/2026-07-29-crossref-findings.md` §2.4/§2.5/§5 — which record that **cert record identity, cert
scope semantics, and the ship-line-complete interaction are undefined in *both* Visual Shop
documents** and could only come from the owner. They did; §3 is that session.
Binding context: the approved spec's §3 non-goals and §15 decision log, HANDOFF §5 conventions, and
`CLAUDE.md`.

## 1. Goal

Cert and ship real orders. A certification is produced for an order at the scope its part and
customer call for, seeded from the part's own inspection requirements, filled in with as many
readings as quality actually took, and printed as a permanent PDF. A shipper ships quantities
against order lines — one order or several for the same customer on one document — records what
physically went (containers, serials, ship-to, freight), and closes lines by the human
ship-line-complete decision, which is what moves an order to Partial Shipped and Shipped. Credit
hold becomes a real gate here for the first time. Corrections are voids with a reason; the paper
that left the building is never un-printed.

## 2. Scope

IN: seven new tables (cert, cert requirement, cert reading, shipper, shipper line, shipper
container, shipper serial), the widened `StoredDocument`, and the columns below; cert
resolution/creation/results services; the shipping ledger and order-status derivation; shipper
services with multi-order support; void with reason for both documents; the `override_credit_hold`
named action; four PDF layouts (shipper, MOS shipper, BOL, cert); per-user signature upload; the
Certifications and Shipping nav sections with their list and detail pages; the order hub's
Certifications and Shipments sections; Playwright E2E flows + owner demo walkthrough.

OUT (§15 lists the full set): email of any kind, invoicing and pricing, reversing shipments,
cert charges, cert-by-process, template editing.

## 3. Owner decisions, 2026-08-04 (this design session)

1. **Samples: coming, and they gate the layouts.** The owner will drop the current printed shipper,
   BOL and cert into `docs/samples/`. The four layout tasks (§14 tasks 18–19) are ordered last and
   **blocked on them**; if a sample is missing when its task is reached, **the executor ASKS rather
   than guessing the layout** — the Phase 3 rule, verbatim (P3 spec §10). Everything else in the
   phase proceeds in parallel and is not gated. (The invoice sample is Phase 5's, not this phase's.)

2. **Email is deferred entirely — Phase 4 is print-only.** Owner, verbatim: *"I typically print them
   and then email them or send them with the parts, Customer's preferences. We'll defer email to a
   later date."* There is no email capability in this codebase today (no SMTP client, no dependency,
   no settings key — verified), and Phase 4 adds none. `CustomerContact.getsShippers`/`getsCerts`
   stay stored data that nothing consumes yet. **Issue #4's ruling travels with email, not with this
   phase**: when email is built, a delivery-flagged contact with no email address must be named as a
   visible skip in every send result. This supersedes, for Phase 4 only, the "print/email" wording in
   spec §7.3 and §7.4; the obligation itself is not cancelled.

3. **Cert requirement resolves per part with a customer default.** `Part.certRequired` (yes / no /
   inherit) falls back to `Customer.certRequiredDefault`, which falls back to the plant setting —
   the most-specific-wins chain already used for request days. Order entry shows what resolved and
   lets the person keying the order override it for that one order.

4. **All three cert scopes are real: by order, by load, and by shipment.** By-order prints the
   order's quantities; by-load prints that load's; by-shipment carries that shipment's shipped
   qty/lbs. Scope resolves through the same chain as the requirement.

5. **One certification per order per scope-instance, with a part block per line.** A multi-part
   order produces ONE cert document — one number, one signature, one sheet — repeating a block
   (part number, name, that line's serials, that line's inspection results) per part line. Not one
   cert per part line, and not lead-part-only (a rider's inspection requirements must reach paper).

6. **Cert results: seeded rows, many readings, computed pass/fail with an override.** The cert opens
   pre-loaded with one requirement row per part-line inspection requirement, copied from the part.
   Quality adds as many readings as they took under each requirement. Pass/fail is computed from
   min/max, and a person may override it; the override is flagged, audited and visible.

7. **Credit hold blocks shipping, with a permissioned override.** This is the blocking half of the
   §3.7 Phase 3 ruling ("the squeeze happens at shipping"). A customer on credit hold cannot be
   shipped unless the actor holds the new named action `override_credit_hold`, in which case a
   **reason is required** and lands in the audit entry. The refusal names the customer and links to
   their record. Only the `creditHold` boolean is enforceable now — credit *limit* and past-due gates
   need an A/R balance that does not exist until Phase 5. **Certifications are never blocked by
   credit hold** (approved during the §3 design presentation): quality paperwork is not a credit
   decision.

8. **Corrections in Phase 4 are voids only; reversing shipments land with Phase 5.** Spec §7.3's rule
   (not-yet-invoiced → void, invoiced → reversing shipment) is kept intact, but nothing can reach
   `INVOICED` until Phase 5, so the reverse path would be code nothing could execute. `REOPENED`
   stays reserved and unreachable. Voiding a shipper un-ships its quantities, recomputes the affected
   orders' statuses, requires a reason, and leaves its stored PDFs reprintable forever.

9. **Order edits tighten by invariant, not by status.** No status-based freeze. Refused, each naming
   the blocking shipper: removing a part line that has live shipments; reducing a line's qty or
   weight below its shipped-to-date; voiding an order that has live shipments. PO, dates, notes,
   containers, serials, loads and charges stay editable at every status — the shop corrects a PO
   after shipping routinely, and spec §7.1 already keeps charges editable until invoiced. This is the
   §5a hook Phase 3 left for this phase.

10. **A shipment records containers, serials and a ship-to override — freight stays the bill/$ pair.**
    Which of the order's container rows went and how many; which of the order's serials went (with a
    per-row print-on-shipper flag); and a ship-to chosen from the customer's own saved addresses (not
    a free-typed one-off, so the address stays a maintained record). Freight is spec §7.3's pair —
    a bill-freight flag and an amount. **Freight terms (prepaid/collect/third-party) and a carrier
    pro/tracking number were offered and declined**, so the BOL states no freight terms.

11. **The signature that prints is the printing user's.** No signer selection, no config keys —
    Visual Shop's three competing answers (`signature_from_cert_control`, `signature_from_last_opid`,
    the printing operator) collapse to one rule. Phase 4 therefore builds the **signature upload on
    the user record**, since `User.signatureImage` has existed since Phase 1 with nothing reading or
    writing it. A user with no signature on file prints their display name over the signature rule —
    visible on screen, blocking nothing.

12. **Multi-order shippers are emergent, one ship-to per shipper.** No "Multi Ord Shipper" mode to
    tick. A shipper is a document; any of that customer's other orders can be added to it; the whole
    shipper has one ship-to, because it is one delivery. The MOS layout prints automatically once the
    shipper covers more than one order. Removing an order is an edit to the document — this is what
    spec §7.3 means by "no Multi-Num-zero workarounds".

13. **A missing certification warns at shipping, never blocks.** A banner naming that the order
    requires a cert and none exists, with a link to produce one; the shipment goes through. Consistent
    with spec §3's "we just ship" and with Visual Shop's own warning that its equivalent gate
    ("Validate Results before Shipping") can stop the dock outright.

14. **Printing a shipper offers its certification, checked by default.** When the order requires a
    cert, the print action shows "also print the certification" pre-ticked; unticking is one click.
    Both PDFs are produced and stored as separate documents.

15. **Print/Change is NOT built — this amends spec §7.4.** Visual Shop's one-off, deliberately
    unsaved print-time edit is dropped. Certs are edited, saved (audited) and printed; after the first
    print, further edits require the existing `edit_cert_results_after_print` action. The reasoning:
    every print is stored byte-for-byte regardless, so nothing about controlled-document behaviour is
    lost, while the record always explains the paper. If a genuine one-off need appears it can be
    added deliberately later.

16. **Stored documents: one widened `StoredDocument` table** (Phase 3 spec §16 left this call to this
    phase). `orderId` becomes nullable and is joined by `shipperId` and `certId`, with a database
    `CHECK` that pins each `kind` to exactly one owner; `DocumentKind` gains `SHIPPER`, `BOL`, `CERT`.
    Sibling tables were considered and rejected: documents have a genuinely cross-cutting read
    pattern (a multi-order shipper's PDF belongs on every order it covers) that attachments never
    had, and one table means the permanence guarantee, the `fileData` redaction and the fetch route
    are each written once instead of four times.

17. **A cert record is created when the thing it describes is stable.** Order-scope at order save;
    shipment-scope when the shipper is created; **load-scope on demand**, because Phase 3's own ruling
    (§3.3) keeps loads editable, renumberable and re-splittable after save — eagerly creating a cert
    per load would mean a re-split either orphans certs or deletes ones with readings already typed
    into them. The order hub shows the gap explicitly ("by load · 4 loads · 0 certs") with a create
    action per load, so nothing is silently forgotten.

18. **Results are two levels: requirement → readings.** A frozen requirement row per part-line
    inspection requirement, with reading rows under it. This matches how the printed cert reads (one
    line per characteristic, several numbers across it) and makes "two rows for one characteristic
    disagreeing about min/max" unrepresentable. A flat single table was considered and rejected for
    exactly that drift.

**Settled by design, flagged for the owner at spec review (§6.1):** when an order's part lines
disagree about whether a cert is required, **any** line requiring one makes the order require one
(a rider's requirement is never silently dropped — the visible-skip instinct); when they disagree
about scope, the **lead** part's resolved scope wins (the lead owns document identity, as it owns the
process). Both are overridable at order entry.

## 4. Data model

All tables additive; column additions to `Part`, `Customer`, `Order` and `StoredDocument`, plus
back-relations on eight more models. One hand-written migration (the TTY constraint — use the
`/create-migration` skill), applied to both databases. Partial `@@unique` lines stay single-line
(sweep limitation, HANDOFF §5.11).

```prisma
enum CertScope {
  ORDER
  LOAD
  SHIPMENT
}

model Cert {
  id            String     @id @default(cuid())
  certNumber    Int        @unique
  orderId       String
  order         Order      @relation(fields: [orderId], references: [id])
  scope         CertScope
  loadNumber    Int?       // scope = LOAD
  shipperId     String?    // scope = SHIPMENT
  shipper       Shipper?   @relation(fields: [shipperId], references: [id])
  freeform      String     @default("")  // prints
  internalNotes String     @default("")  // never prints (spec §7.4)
  printedAt     DateTime?                // first print; gates edit_cert_results_after_print
  deletedAt     DateTime?                // voided; reason in the audit entry
  createdAt     DateTime   @default(now())
  updatedAt     DateTime   @updatedAt
  requirements  CertRequirement[]
  documents     StoredDocument[]

  @@index([orderId])
  @@index([shipperId])
}
```

- **`certNumber` is a plain `@unique` on a soft-deletable model — deliberate, documented,
  sweep-exempted**, exactly like `Order.orderNumber` (P3 spec §4) and `User.username` before it: a
  voided cert keeps its number forever, numbers are allocation-only and never re-entered.
  `tests/partial-unique-sweep.test.ts` gains the documented exemption.
- **Uniqueness per scope-instance is service-enforced, not indexed.** One live cert per order for
  `ORDER`, per `(order, loadNumber)` for `LOAD`, per `(order, shipperId)` for `SHIPMENT`. A partial
  unique index cannot express it: Postgres treats NULLs as distinct, so two `(orderId, ORDER, NULL,
  NULL)` rows would not collide. The check runs inside the transaction under `claimOrder`, which is
  where this project's cross-transaction invariants live (CLAUDE.md), with its own test.
- `printedAt` is a real column rather than a derived "has documents" check, because a cert's
  editability must not change when an unrelated document is stored.
- **`loadNumber` is a plain integer, not a foreign key to `Load` — deliberate, and recorded here so a
  reviewer does not read it as an oversight.** It matches `StoredDocument.loadNumber`, which Phase 3
  chose for the same reason: loads are renumbered and re-split by design (P3 §3.3/§5b), so a cert
  pinned to a load *row* would silently follow a row through a renumber and describe a different
  physical load than the one on its paper. Pinning to the number means the cert says "Load 3" and
  keeps saying it. The cost is that a re-split to fewer loads can leave a cert whose load number no
  longer exists; **the order hub flags that cert rather than hiding it**, and the cert is voided or
  re-created by a person, never silently.

```prisma
model CertRequirement {
  id               String           @id @default(cuid())
  certId           String
  cert             Cert             @relation(fields: [certId], references: [id])
  orderLineId      String
  orderLine        OrderLine        @relation(fields: [orderLineId], references: [id])
  position         Int
  inspectionCodeId String
  inspectionCode   InspectionCode   @relation(fields: [inspectionCodeId], references: [id])
  scaleId          String?
  scale            InspectionScale? @relation(fields: [scaleId], references: [id])
  min              Decimal?         @db.Decimal(10, 4)
  max              Decimal?         @db.Decimal(10, 4)
  sampleQty        String           @default("")
  location         String           @default("")
  readings         CertReading[]

  @@unique([certId, position])
  @@index([orderLineId])
  @@index([inspectionCodeId])
  @@index([scaleId])
}

model CertReading {
  id            String          @id @default(cuid())
  requirementId String
  requirement   CertRequirement @relation(fields: [requirementId], references: [id])
  position      Int
  value         Decimal?        @db.Decimal(10, 4)
  passed        Boolean?        // computed from min/max when a value is present
  overridden    Boolean         @default(false)
  note          String          @default("")

  @@unique([requirementId, position])
}
```

- `min`, `max`, `sampleQty` and `location` are **copied from `PartInspection` at seed time and frozen
  there** — editing the part next month must not silently rewrite a cert already being filled in.
  `inspectionCodeId`/`scaleId` stay real foreign keys so the delete guard covers them and names
  render consistently; the *forever*-frozen artifact is the stored PDF, which is the project's
  existing answer to controlled documents.
- Decimal precision matches `PartInspection.min`/`max` exactly (`Decimal(10, 4)`); keep the two in
  step, and validate with `decimalField(10, 4)` before the value reaches Prisma (the `Customer`
  precedent).
- `position` is **cert-wide, not per line**: requirements are seeded in order-line `position` order,
  and within each line in the part's own `PartInspection.sort` order, so `@@unique([certId,
  position])` orders the whole document exactly as it prints.
- **Cert children have no `deletedAt`** — editing them is an edit to the cert, audited as the cert's
  own diff via `SNAPSHOT_INCLUDE`. The Phase 3 order-children precedent, recorded here so a reviewer
  does not read it as an oversight.

```prisma
model Shipper {
  id              String            @id @default(cuid())
  shipperNumber   Int               @unique
  clientRequestId String?           @unique  // idempotency nonce (the createOrder precedent)
  customerId      String
  customer        Customer          @relation(fields: [customerId], references: [id])
  shipToAddressId String?
  shipToAddress   CustomerAddress?  @relation(fields: [shipToAddressId], references: [id])
  shipDate        DateTime          @db.Date
  carrierId       String?
  carrier         Carrier?          @relation(fields: [carrierId], references: [id])
  route           String            @default("")
  comments        String            @default("")
  billFreight     Boolean           @default(false)
  freightAmount   Decimal?          @db.Decimal(12, 2)
  deletedAt       DateTime?         // voided; reason in the audit entry, void_shipper
  createdAt       DateTime          @default(now())
  updatedAt       DateTime          @updatedAt
  lines           ShipperLine[]
  containers      ShipperContainer[]
  serials         ShipperSerial[]
  certs           Cert[]
  documents       StoredDocument[]

  @@index([customerId])
  @@index([shipDate])
  @@index([carrierId])
}

model ShipperLine {
  id           String    @id @default(cuid())
  shipperId    String
  shipper      Shipper   @relation(fields: [shipperId], references: [id])
  orderLineId  String
  orderLine    OrderLine @relation(fields: [orderLineId], references: [id])
  position     Int
  qty          Int       // >= 0
  weight       Decimal   @db.Decimal(12, 2)  // >= 0
  lineComplete Boolean   @default(false)

  @@unique([shipperId, position])
  @@unique([shipperId, orderLineId])
  @@index([orderLineId])
}

model ShipperContainer {
  id               String         @id @default(cuid())
  shipperId        String
  shipper          Shipper        @relation(fields: [shipperId], references: [id])
  orderContainerId String
  orderContainer   OrderContainer @relation(fields: [orderContainerId], references: [id])
  position         Int
  count            Int

  @@unique([shipperId, position])
  @@unique([shipperId, orderContainerId])
  @@index([orderContainerId])
}

model ShipperSerial {
  id             String      @id @default(cuid())
  shipperId      String
  shipper        Shipper     @relation(fields: [shipperId], references: [id])
  orderSerialId  String
  orderSerial    OrderSerial @relation(fields: [orderSerialId], references: [id])
  printOnShipper Boolean     @default(true)

  @@unique([shipperId, orderSerialId])
  @@index([orderSerialId])
}
```

- **`shipperNumber` carries the same plain-`@unique` sweep exemption as `certNumber`**, for the same
  reason and with the same documented rationale.
- `@@unique([shipperId, orderLineId])`: one row per order line per shipper. Shipping the same line
  twice means two shippers, which is what two shipments are.
- **A shipper must carry at least one line with `qty > 0`** (service-enforced) — a document about
  nothing is not a shipment. A line with `qty = 0` and `lineComplete = true` is legitimate and
  deliberately allowed: "we are not sending the last three, close the line."
- Shipper children have no `deletedAt`, same reasoning as the cert's.

```prisma
enum DocumentKind {
  TRAVELER
  SHIPPER
  BOL
  CERT
}

model StoredDocument {
  id         String       @id @default(cuid())
  orderId    String?      // TRAVELER
  order      Order?       @relation(fields: [orderId], references: [id])
  shipperId  String?      // SHIPPER, BOL
  shipper    Shipper?     @relation(fields: [shipperId], references: [id])
  certId     String?      // CERT
  cert       Cert?        @relation(fields: [certId], references: [id])
  kind       DocumentKind
  loadNumber Int?         // TRAVELER only: null = full set
  fileData   Bytes
  createdAt  DateTime     @default(now())

  @@index([orderId])
  @@index([shipperId])
  @@index([certId])
}
```

- The kind-to-owner pairing is a **database `CHECK`**, hand-written in the migration (Prisma's schema
  language has no check syntax — the `Part.loadQty` precedent):

  ```sql
  CHECK (
    (kind = 'TRAVELER'        AND "orderId"   IS NOT NULL AND "shipperId" IS NULL AND "certId" IS NULL) OR
    (kind IN ('SHIPPER','BOL') AND "shipperId" IS NOT NULL AND "orderId"  IS NULL AND "certId" IS NULL) OR
    (kind = 'CERT'            AND "certId"    IS NOT NULL AND "orderId"   IS NULL AND "shipperId" IS NULL)
  )
  ```

  Every existing row is a `TRAVELER` with `orderId` set, so the constraint validates on the way in.
- **Still permanent — no delete path at all**, `fileData` still redacted from snapshots, create-only
  audit. Widening the table must not weaken any of the three.

**Existing models gain:**

| Model | Column | Notes |
|---|---|---|
| `Part` | `certRequired Boolean?`, `certScope CertScope?` | null = inherit |
| `Customer` | `certRequiredDefault Boolean?`, `certScopeDefault CertScope?` | null = inherit the plant |
| `Order` | `certRequired Boolean @default(false)`, `certScope CertScope @default(ORDER)` | **resolved and frozen at save**, overridable at entry and after |
| `Customer`, `Carrier`, `CustomerAddress`, `OrderLine`, `OrderContainer`, `OrderSerial`, `InspectionCode`, `InspectionScale` | back-relations | as shown above |

**Two new settings** (new `Certifications` group), closing the resolution chain the way
`request_days_default` already does: `cert_required_default` (boolean, default `false`) and
`cert_scope_default` (`z.enum(["ORDER","LOAD","SHIPMENT"])`, default `ORDER`).

**Text/number rules** (2C-2 §4 convention): `route`, `comments`, `freeform`, `internalNotes`,
`location`, `note` are `.max(n)` display text defaulting `""`; `sampleQty` is `.max(60)` free text,
never a number (the P3 §3.9 ruling); money and weights are `Decimal(12, 2)`; readings and
min/max are `Decimal(10, 4)`; quantities are integers.

## 5. Rules and the concurrency contract

### 5.1 The ship ledger

Shipped-to-date for an order line is the sum of `qty` (and `weight`) across its **live** shipper
lines — a voided shipper contributes nothing. **One derivation, in `ship-ledger.ts`, used
everywhere**: the ship-now prefill (`ordered − shipped`, editable), the over-ship warning, and the
edit invariants in §5.5. Over-shipping **warns and never blocks** — a customer's container takes 310
of a 300 line and the shop ships it.

### 5.2 Status derivation

Recomputed inside the same transaction as every shipper mutation, for every affected order, and
**also whenever an order's line set changes** (adding a rider to a fully shipped order must return it
to Partial Shipped):

- no live shipper lines for the order → `OPEN`
- **every** order line has at least one live shipper line with `lineComplete = true` → `SHIPPED`
  (order lines carry no `deletedAt` — P3 §4 — so every line of the order counts)
- otherwise → `PARTIAL_SHIPPED`

**Quantities never enter this decision.** Ship-line-complete is the human's call (spec §7.3, HANDOFF
§3), and a line counts as complete if any live shipper line for it is marked complete. Voidedness
stays orthogonal to status (P3 §4): a voided order's status is left untouched. `INVOICED` and
`REOPENED` are unreachable in Phase 4.

### 5.3 Locks, ordering, and one new hazard

Every shipper and cert mutation runs `withDbErrors` → `$transaction` (Serializable — the registered-FK
writer pattern applies to `carrierId` and the cert's `inspectionCodeId`/`scaleId` through
`assertRefExists`) and **claims every affected order row with `claimOrder` before reading the state
it acts on**. The row lock is the guarantee at any isolation level; the isolation level must never be
presented as protecting it (CLAUDE.md, and the 2C-3 lesson that produced the rule).

**Multi-order shippers add a hazard Phase 3 never had.** Two saves touching orders `{A, B}` and
`{B, A}` deadlock if each claims in its own order. **Claims are therefore always taken in a
deterministic order — sorted by order id — in every code path that can touch more than one order**,
and that ordering carries its own test with both orderings driven concurrently.

`Shipper.clientRequestId` is the entry form's idempotency nonce, minted when a fresh shipper form
mounts and answered by returning the shipper that request already created — the `createOrder`
precedent (P3 §4), which exists precisely so a Serializable retry cannot burn a second number and
create a second document for one operator action. Never freed by a void.

Numbering uses `allocateNumber("shipper_number_next" | "cert_number_next", tx)` inside that same
transaction, **after issue #34's guard lands** (§14 task 1) — the helper currently type-accepts every
`SettingKey` while only the five `*_number_next` keys are numeric, and Phase 4 is what multiplies its
call sites.

### 5.4 Credit hold

`mustCan(user, "shipping", "create")`, then: a customer with `creditHold` set is refused with a
message naming the customer and **linking to their record**, so whoever can lift the hold is
findable (the §5.14 blocked-delete discoverability rule applied to a permission-shaped block). An
actor holding `override_credit_hold` may proceed with a **reason required and trimmed in the
service** (the §5.17 shape), which is recorded in the audit entry and printed nowhere.
**Certifications are never gated on credit hold.**

### 5.5 Order edits after a shipment (the §5a tightening)

Service-enforced, each refusal naming the blocking shipper (`#5012`, linked to its page) so the block
is discoverable rather than a dead end:

- removing a part line that has live shipper lines;
- reducing a line's `qty` or `weight` below its shipped-to-date;
- **voiding an order that has live shipments** — void the shippers first, otherwise the shipper is
  left pointing at lines that have vanished from every list.

Everything else stays editable at every status: PO, VS #, dates, notes, containers, serials, loads,
charges, and the order's own cert-required/scope. Customer and lead part/revision remain immutable
forever (P3 §5a).

### 5.6 Void

**Shipper** (`mustDo(user, "void_shipper")`, reason required and trimmed in the service): claims
every affected order in sorted order, `auditedSoftDelete`s the shipper, recomputes each order's
status, and **voids any shipment-scoped certs hanging off it with the same reason**. Its stored PDFs
stay listable and reprintable **forever**; new prints against a voided shipper are refused. This is
Phase 3's voided-order rule reused, not reinvented.

**Cert** (`certs.delete`, reason required): same shape. Stored cert PDFs survive; new prints refused.

### 5.7 Warnings, never blocks

Returned as Phase 3's `warnings[]` and rendered as banners, named per line (the issue-#4 visible-skip
habit):

- the order requires a certification and none exists yet, with a link to create one (§3.13);
- a shipper line whose part carries `serializationRequired` is shipping with no serials selected —
  the shipping-side sibling of Phase 3's entry-side warning, which spec §16 names as a warning;
- a shipper line exceeds its order line's remaining quantity or weight.

## 6. Cert resolution, creation, and results

### 6.1 Resolution

**Required** — resolve the chain *per line*, then combine:

```
lineRequires(line) = line.part.certRequired ?? customer.certRequiredDefault ?? cert_required_default
order.certRequired = lines.some(lineRequires)
```

**Any** line requiring a cert makes the order require one, so a rider's requirement is never silently
dropped.

**Scope** — resolved from the lead line only:

```
order.certScope = leadPart.certScope ?? customer.certScopeDefault ?? cert_scope_default
```

The **lead** part's scope wins when lines disagree, because the lead owns document identity exactly
as it owns the process.

Both are **resolved once and frozen onto the order at save**, the same instinct as locking the
process revision: editing a part next month must not re-scope a live order. Both are editable on the
order afterwards, and overridable at entry.

### 6.2 Creation timing (§3.17)

| Scope | Created |
|---|---|
| `ORDER` | at order save, when `certRequired` resolves true |
| `SHIPMENT` | when a shipper is created, one cert per order on that shipper |
| `LOAD` | **on demand**, per load, from the order hub |

Load-scope is lazy because Phase 3 keeps loads editable and re-splittable (P3 §3.3); eager creation
would mean a re-split orphans certs or deletes ones with readings in them. The order hub shows the
gap explicitly — "by load · 4 loads · 0 certs" with a create action per load — so nothing is silently
forgotten. **A load re-split never touches an existing cert**, and that is an asserted test.

### 6.3 Seeding and results

On creation, one `CertRequirement` is written per live `PartInspection` of each order line's part, in
the part's own `sort` order, lines in `position` order, with `min`/`max`/`sampleQty`/`location`
copied and `inspectionCodeId`/`scaleId` referenced. A part with no inspection requirements
contributes no rows — its block prints part identity and serials only.

`passed` is computed whenever a `value` is present: `true` when it falls within whichever of
`min`/`max` are set, `false` otherwise; `null` when there is no value. A person may set `passed`
against the arithmetic, which sets `overridden = true` — shown on screen and carried into the audit
diff. Overriding is `certs.edit`; after `printedAt` is set, every results edit additionally requires
`edit_cert_results_after_print`.

## 7. Registry, sweeps, and audit surface

- **`REFERENCE_LINKS` gains three entries**: `shipper.carrierId → carrier` (**`Carrier`'s first
  consumer since it shipped in Phase 2A** — this is what finally gives it a delete guard and blocker
  list), `certRequirement.inspectionCodeId → inspectionCode`, and `certRequirement.scaleId →
  inspectionScale`. Each with `liveWhere` inheriting the parent's liveness, `blockerId`/`displayName`
  presenting the owning document (`#5012 · ACME`, `Cert #2041`), and a `detailPath`. The links sweep
  enforces registration automatically; `deleteReference` then refuses while live shippers or certs
  hold them, with the standard blocker list and Excel export.
- **Sweep exemptions**: `Cert.certNumber` and `Shipper.shipperNumber` join `Order.orderNumber`,
  `Order.clientRequestId` and `User.username` in `tests/partial-unique-sweep.test.ts`, each with its
  documented rationale. `Shipper.clientRequestId` too, for the P3 reason.
- **`AuditableModel` += `cert`, `shipper`.** `SNAPSHOT_INCLUDE.cert` pulls requirements (with code
  and scale selects) and their readings; `SNAPSHOT_INCLUDE.shipper` pulls lines (with order-line and
  part selects), containers and serials. **Every collection carries an `orderBy`** — the issue-#24
  lesson applied from birth, as Phase 3 did.
- Tests assert audit **content** (a real before/after diff), not merely that an entry exists.

## 8. Services

- `src/server/ship-ledger.ts` — `shippedTotals(tx, orderLineIds)`, `recomputeOrderStatus(tx,
  orderIds)`. The single derivation of §5.1 and §5.2; every other module calls it.
- `src/server/shippers.ts` — `createShipper`, `getShipper`, `listShippers` (filters, search, sort,
  export), `updateShipper`, `addOrderToShipper`/`removeOrderFromShipper`, `replaceLines`,
  `replaceContainers`, `replaceSerials`, `voidShipper`.
- `src/server/certs.ts` — `resolveCertSettings(customerId, lineParts)`, `createCert(scope-aware)`,
  `getCert`, `listCerts`, `updateCert`, `voidCert`.
- `src/server/cert-results.ts` — `seedRequirements(tx, certId)`, `replaceResults`, the pass/fail
  computation and override handling.
- `src/server/documents.ts` — **extracted from `traveler.ts`**: `storeDocument(tx, {kind, owner,
  bytes})`, `listDocumentsForOrder(orderId)`, `getDocument(docId)`. With one widened table, the
  permanence guarantee, the redaction rule and the byte-exact reprint should exist once. The
  order-hub union is one query:
  `{ OR: [{ orderId }, { cert: { orderId } }, { shipper: { lines: { some: { orderLine: { orderId } } } } }] }`
  — which is what puts a multi-order shipper's PDF on every order it covers.
- `src/server/pdf/shipper.ts`, `pdf/mos-shipper.ts`, `pdf/bol.ts`, `pdf/cert.ts` — document
  definitions (plain JSON), on the existing `pdf/render.ts` plumbing.
- `settings.ts` — `allocateNumber`'s key type narrows to
  `Extract<SettingKey, \`${string}_number_next\`>` (issue #34).
- `users.ts` — signature upload/read/clear on `User.signatureImage` (size cap, MIME allowlist,
  already covered by `redact()`).
- `orders.ts` — the §5.5 invariants and the status-recompute hook on line operations. **Issue #33's
  decomposition of `orders.ts` is deliberately not taken on** unless this phase's own diff makes it
  necessary.

## 9. Routes

Authorize → parse → delegate, ctx always passed.

| Route | Method | Gate |
|---|---|---|
| `/api/shippers` | GET | `shipping.view` |
| `/api/shippers` | POST | `shipping.create` (+ §5.4 credit-hold gate) |
| `/api/shippers/export` | GET | `shipping.view` |
| `/api/shippers/[id]` | GET / PATCH | `shipping.view` / `shipping.edit` |
| `/api/shippers/[id]` | DELETE (reason in body) | `mustDo("void_shipper")` |
| `/api/shippers/[id]/orders` (+ `[orderId]`) | POST / DELETE | `shipping.edit` |
| `/api/shippers/[id]/lines`, `/containers`, `/serials` | PUT (replace) | `shipping.edit` |
| `/api/shippers/[id]/print` (`?doc=shipper\|bol&cert=1`) | POST | `shipping.view` |
| `/api/certs` | GET / POST | `certs.view` / `certs.create` |
| `/api/certs/export` | GET | `certs.view` |
| `/api/certs/[id]` | GET / PATCH | `certs.view` / `certs.edit` |
| `/api/certs/[id]` | DELETE (reason in body) | `certs.delete` |
| `/api/certs/[id]/results` | PUT (replace) | `certs.edit` (+ `edit_cert_results_after_print` once printed) |
| `/api/certs/[id]/print` | POST | `certs.view` |
| `/api/orders/[id]/certs` | GET / POST (load-scope create) | `certs.view` / `certs.create` |
| `/api/orders/[id]/shipments` | GET | `shipping.view` |
| `/api/admin/users/[id]/signature` | PUT / DELETE | `mustDo("manage_users")` |

**One existing route changes.** `/api/documents/[docId]` gates on `orders.view` today; it must now
gate on the **owning entity's** area — a traveler behind `orders.view`, a shipper or BOL behind
`shipping.view`, a cert behind `certs.view`. Printing gates on `.view` for the same reason the
traveler does (P3 §9): it changes nothing about the record, archives its own output as an audited
create, and is an explicit POST, so spec §12's "reads never mutate" holds. Existing `parts` and
`customers` PATCH routes accept the new cert columns; `orders` PATCH accepts `certRequired`/
`certScope`.

`SPECIAL_ACTIONS` gains `override_credit_hold` (eleven total) — a spec §9 amendment.

## 10. Documents

Four layouts on `src/server/pdf/`'s existing plumbing, each a JSON document definition — the same
template-as-data contract Phase 7's designer will edit and version. **Tasks 18–19 are blocked on the
owner's samples in `docs/samples/`; if one is absent when its task is reached, the executor ASKS
rather than guessing** (§3.1).

- **Shipper** — company block from settings (`company_name`/`address`/`phone`; a logo image is
  embedded only if the owner drops one in with the samples — proper logo upload is Phase 7, exactly
  as the traveler has it); customer, ship-to address, ship date, carrier,
  route; per line: order number, PO, part number/name, ordered / shipped-to-date / this shipment's
  qty and weight, ship-line-complete; containers (type, count) with totals; serials where
  `printOnShipper`; freight; shipping comments and the customer's standing shipping notes.
- **MOS shipper** — the same content grouped by order, printed automatically when the shipper covers
  more than one order (§3.12). One data model, two definitions.
- **BOL** — carrier-facing: ship-from (company), ship-to, carrier and route, piece count and total
  weight from the shipment's containers, order/PO references, and a signature line. Prints under the
  shipper's number; **no new numbering setting**, and **no freight terms** (§3.10).
- **Certification** — header with cert number, order, PO, customer and date; a **block per part
  line**: part number/name/description, that line's serials with their descriptions (the heat/lot
  field Phase 3 added for exactly this), and its requirement rows with their readings and pass/fail;
  scope-appropriate quantities (order totals / that load's / that shipment's shipped qty and lbs);
  the freeform block; **never** `internalNotes`; and the signature block — the printing user's
  `signatureImage`, or their display name typed over the rule when none is on file.

**Print mechanics** (the traveler's, reused): the response streams the PDF; every print is stored
byte-for-byte as a `StoredDocument`; the detail page lists every prior print and **reprint streams
the stored bytes exactly**. Printing a shipper offers its certification pre-ticked (§3.14), producing
two documents in one action. Prints against a voided shipper, cert or order are refused; stored ones
remain.

## 11. UI

**Shipping list** (`/shipping`, nav goes live): shipper #, customer (`CODE · name`), ship date,
orders covered, carrier, qty and weight totals, freight, voided indicator. Search-as-you-type,
filters (customer, ship-date range, include-voided toggle default off), Excel export, the
`use-latest` stale-response gate, and a failed load that says so (no `.catch(() => {})`).

**Shipper page** (`/shipping/[id]`, remounts per id — §5.12): header (customer, ship-to selector from
that customer's saved addresses, ship date, carrier, route, freight bill + amount, comments, the
customer's standing shipping notes displayed); a lines grid showing ordered / shipped-to-date /
ship-now qty and lbs / ship-line-complete, prefilled to the remainder; **Add order** (that customer's
orders with unshipped lines); containers; serials; Print (shipper, BOL, and the cert checkbox
pre-ticked); stored documents; History; Void with reason. Credit-hold refusal and the §5.7 warnings
render as banners.

**Certifications worklist** (`/certs`): cert #, order, customer, scope, load or shipper, printed?,
a pass/fail summary. Filters and export.

**Cert page** (`/certs/[id]`): header (order link, scope and its subject, number, printed date); one
requirement block per part line with its readings grid; freeform; internal notes clearly marked as
never printing; Print; documents; History. Post-print, the results grid is read-only unless the actor
holds `edit_cert_results_after_print`, and says so.

**Order hub** gains **Certifications** and **Shipments** sections — the two Phase 3 deliberately left
unrendered — plus cert-required and scope on Overview. **Order entry** shows the resolved
cert-required/scope with an override. **Part** and **Customer** pages gain their cert fields.
**Admin → Users** gains the signature upload with a preview.

Permission gating stays §5.16 throughout — disabled with a tooltip naming the missing permission,
never hidden; fields read-only for view-only users. Bulk grids reuse `src/lib/bulk-grid.ts`, and the
**sibling-split lesson applies**: a fix landing on one grid lands on every other in the same commit.

## 12. Testing

TDD per task; every route 401/403-tested; the suite grows from 1010. Dense clusters:

1. **Numbering** — concurrent shipper and cert saves get distinct sequential numbers; issue #34's
   narrowed key type rejects a non-numbering key at compile time and the guard at runtime.
2. **Ledger** — shipped-to-date across several shippers; a voided shipper contributes nothing;
   prefill equals the remainder; over-ship warns and still saves.
3. **Status derivation matrix** — every combination across multi-line orders: no shipments, partial,
   all-but-one complete, all complete, complete with a short quantity, a void restoring the previous
   status, and adding a rider line to a `SHIPPED` order returning it to `PARTIAL_SHIPPED`. Asserts
   explicitly that **quantities do not influence the outcome**.
4. **Claim ordering** — two multi-order saves over `{A, B}` and `{B, A}` run concurrently in both
   orderings without deadlock; the sorted-claim helper is asserted directly.
5. **Idempotency** — a retried shipper save with the same `clientRequestId` returns the first
   shipper and allocates no second number.
6. **Credit hold** — refusal names the customer and links to them; the override needs the action and
   a non-blank reason; the reason reaches the audit entry and no document; certs are unaffected.
7. **Edit invariants** — removing a shipped line, reducing below shipped-to-date, and voiding an
   order with live shipments each 400/409 naming the shipper; the same operations succeed once the
   shipper is voided.
8. **Cert resolution** — part beats customer beats plant; any line requiring a cert wins; the lead's
   scope wins on disagreement; the values freeze at order save and a later part edit does not move
   them; the per-order override sticks.
9. **Creation timing** — order-scope at save; shipment-scope per order on shipper creation;
   load-scope only on demand; **a load re-split leaves an existing cert with readings untouched**;
   the per-scope uniqueness check refuses a duplicate under concurrency.
10. **Results** — seeding order and content from `PartInspection`; min/max frozen against a later
    part edit; many readings under one requirement; pass/fail computed at each boundary (min only,
    max only, both, neither, no value); an override flags and audits.
11. **Documents** — the `CHECK` rejects zero owners, two owners, and a kind/owner mismatch; stored
    bytes reprint `Buffer.compare`-identical while two fresh renders are compared by content (the
    `renderPdf` non-determinism rule); no delete path exists; `fileData` never appears in a snapshot;
    the order-hub union returns a multi-order shipper's PDF on every order it covers.
12. **Guards and registry** — carrier delete blocked by a live shipper with blocker list and export;
    inspection code and scale blocked by a live cert requirement; the links sweep sees all three new
    FKs; both new plain-unique columns carry asserted sweep exemptions.
13. **Routes** — 401/403 for every new route; `/api/documents/[docId]` gates per owner kind (a
    `shipping.view`-only user can fetch a shipper PDF and not a cert PDF).

## 13. E2E + demo

Five flows join the existing ten (screenshots at named checkpoints, artifacts in
`erp/e2e-artifacts/`, dev-database fixtures cleaned per HANDOFF §5a's exact-key, fixture-customer,
localhost-gated rules):

1. `ship-partial-then-complete` — ship part of a two-line order → board shows Partial Shipped → ship
   the rest with both lines complete → Shipped.
2. `mos-two-orders` — build one shipper covering two orders for one customer → print → both order
   hubs list the same shipper and the same PDF.
3. `cert-results-print` — create a cert, see it seeded from the part's inspections, enter readings,
   see computed pass/fail, print, reprint and confirm the identical stored file.
4. `void-shipper` — void with a reason → the order's status returns → the stored PDF is still listed
   and still reprintable.
5. `credit-hold-block-and-override` — a held customer refuses with a link to the customer → the
   override with a reason succeeds → the reason appears in history.

**Watch out for the Phase 3 E2E trap** (§4a): a URL regex like `/\/shippers\/[^/?]+$/` also matches
a literal `/shippers/new` route. Wait for content that can only exist post-navigation, not a broader
regex.

Final task: the owner demo walkthrough with screenshots, in `docs/` and named for the day it is
written (the 2C-2 / 2C-3 / Phase 3 precedent), presented before merge.

## 14. Task shape (planner refines)

Foundations first, document layouts last behind the samples gate, one fresh subagent per task with an
independent spec-and-quality review and fix rounds, then the whole-branch review before the PR.

1. `allocateNumber` numbering-key guard (**closes issue #34, before anything multiplies its call
   sites**) + the two new settings.
2. Schema migration, both databases (hand-written per the `/create-migration` skill) + the `CHECK`
   constraints + sweep exemptions + `REFERENCE_LINKS` entries + `AuditableModel` /
   `SNAPSHOT_INCLUDE`.
3. `documents.ts` extraction + widened `StoredDocument`, with the traveler migrated onto it and its
   tests still green.
4. Cert resolution chain: `Part`/`Customer`/`Order` columns, `resolveCertSettings`, the freeze in
   `createOrder`.
5. `certs.ts` — scope-aware creation, numbering, uniqueness under the claim, get/list/update/void.
6. `cert-results.ts` — seeding, requirement/reading replace, pass/fail and override.
7. `ship-ledger.ts` — shipped-to-date and status derivation, with the recompute hooks on order line
   operations.
8. `shippers.ts` core — create: sorted claims, credit hold and override, idempotency, Serializable +
   `assertRefExists`.
9. Shipper children — lines/containers/serials replace, add and remove order.
10. `voidShipper` + the §5.5 order edit invariants + the shipment-scoped cert cascade.
11. Routes (shippers, certs, hub sections, signature) + the widened `/api/documents/[docId]` gate +
    the 401/403 sweep.
12. Signature upload (service + Admin → Users).
13. Shipping list page.
14. Shipper document page.
15. Certifications worklist page.
16. Cert detail page (requirement and readings grids).
17. Order hub Certifications + Shipments sections; order entry, part and customer cert fields.
18. Shipper + MOS shipper layouts — **blocked on samples; ASK if absent**.
19. BOL + cert layouts and the print actions (including the cert-with-shipper checkbox) — **blocked
    on samples; ASK if absent**.
20. E2E flows + demo walkthrough + docs (HANDOFF §4a/§9, `CLAUDE.md`).

## 15. Non-goals

- **No email**, of any kind (§3.2). Issue #4's visible-skip obligation travels with email whenever it
  is built; it is deferred, not cancelled.
- **No reversing shipments and no `REOPENED`** (§3.8) — Phase 5, with invoices to reverse against.
- **No Print/Change** (§3.15) — amends spec §7.4.
- No invoicing, pricing resolution, surcharges, cert charges, or "bill for cert" anything (Phase 5) —
  and **no dangling columns for them** (the 2C-2 §2 rule).
- No cert-by-process, no cert formats or per-customer cert text, no template editing, no logo upload
  UI, no per-customer document variants — **Phase 7 owns templates**; this phase ships built-in
  default definitions, code-owned.
- No credit-limit or past-due gates (no A/R balance until Phase 5); no shipping hold on an order; no
  "available to ship" gating of any kind (spec §3 — the shop ships when work is physically done).
- No kanban shipping, no shipping labels, no pickup/signature-pad capture, no available-to-ship
  notifications, no delivery flagging (spec §3 confirmed-unused list).
- No shop-floor tracking, no final-inspection gate, no Quick Track equivalent (spec §3, permanent).
- No freight terms and no carrier pro/tracking number (§3.10, offered and declined).
- No per-shipment pricing display; no partial-load shipping machinery (shipping stays decoupled from
  load boundaries, HANDOFF §3).
- Issue #33's decomposition of `orders.ts` is not taken on here unless this phase's diff requires it.

## 16. What Phase 5 inherits from Phase 4

- **`Order.status` reaches `PARTIAL_SHIPPED` and `SHIPPED`**, derived from ship-line-complete.
  `INVOICED` and `REOPENED` are still unreachable and are Phase 5's to make reachable — `REOPENED`
  specifically by the **reversing shipment** deferred in §3.8, which is the negative-quantity
  counterpart to `voidShipper` and should reuse its sorted-claim and status-recompute machinery.
- **`ship-ledger.ts` is the shipped-quantity source of truth** — invoice-from-shipments reads it
  rather than re-deriving totals.
- **`allocateNumber` is now proven on three counters** (order, shipper, cert) with issue #34's guard;
  `invoice_number_next` is the fourth and needs no new pattern.
- **`StoredDocument` is the one document table** with a kind-to-owner `CHECK`; invoices, credits and
  statements widen `DocumentKind` and add their own owner column the same way — the permanence,
  redaction and byte-exact reprint guarantees already exist once, in `documents.ts`.
- **`Shipper.billFreight`/`freightAmount`** are captured and unpriced; Phase 5 bills them.
  `OrderCharge.amount = null` still means "needs price" (P3 §3.6).
- **Credit hold's override action and its reason-in-audit shape** are the template for Phase 5's
  invoice unlock and A/R period close.
- **Email is owed** (§3.2) with issue #4's visible-skip ruling attached; whichever phase builds it
  inherits the recipient flags already on `CustomerContact`.
- Cert charges, "bill for cert" and per-customer cert suppression are Visual Shop behaviours this
  phase deliberately does not model; Phase 5 decides whether the shop wants any of them.
