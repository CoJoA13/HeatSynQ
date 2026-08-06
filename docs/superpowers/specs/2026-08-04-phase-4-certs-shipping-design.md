# Phase 4 — Certifications & Shipping (design)

**Status: approved by the owner 2026-08-04 (design session in this document's §3).**
Branch: `phase-4-certs-shipping`.

Inputs this design answers to: the roadmap's Phase 4 line, the approved spec's §5.1/§6/§7.3/§7.4/§8/§9,
HANDOFF §4a (Phase 3's three review lessons), §5 (the conventions), §6 (the carried backlog) and §7
(the samples the owner owed), Phase 3's design spec §16 (the inheritance list, quoted where it
binds), the Visual Shop teardown Parts VII–VIII (certs and shipping), and
`docs/2026-07-29-crossref-findings.md` §2.4/§2.5/§5 — which record that **cert record identity, cert
scope semantics, and the ship-line-complete interaction are undefined in *both* Visual Shop
documents** and could only come from the owner. They did; §3 is that session.

**The owner's four production samples arrived mid-session** and are the layout contract:
`docs/samples/Shipping Ticket Sample.pdf`, `Bill of Lading Sample.pdf`, `Certification Sample.pdf`
and `Invoice Sample.pdf` (the last is Phase 5's). **They overturned four of this design's own
decisions before a line of code was written** — recorded as §3.19–§3.22 rather than silently
rewritten, because what the samples corrected is more instructive than the corrections.

Binding context: the approved spec's §3 non-goals and §15 decision log, HANDOFF §5 conventions, and
`CLAUDE.md`.

## 1. Goal

Cert and ship real orders. A certification is produced for an order at the scope its part and
customer call for, seeded from the part's own inspection requirements, filled in with as many
readings as quality actually took, and printed as a permanent PDF. A shipment ships quantities
against order lines — one order or several for the same customer on one truck — records what
physically went (containers, serials, ship-to, freight), and closes lines by the human
ship-line-complete decision, which is what moves an order to Partial Shipped and Shipped. Each order
on a shipment prints its own shipping ticket; the truck gets one bill of lading. Credit hold becomes
a real gate here for the first time. Corrections are voids with a reason; the paper that left the
building is never un-printed.

## 2. Scope

IN: eight new tables (cert, cert requirement, cert reading, shipper, shipper order, shipper line,
shipper container, shipper serial), the widened `StoredDocument`, and the columns in §4; cert
resolution/creation/results services; the shipping ledger and order-status derivation; shipments
spanning several orders; void with reason for both documents; the `override_credit_hold` named
action; three PDF layouts (shipping ticket, BOL, certification); per-user signature upload; the
Certifications and Shipping nav sections with their list and detail pages; the order hub's
Certifications and Shipments sections; Playwright E2E flows + owner demo walkthrough.

OUT (§15 lists the full set): email of any kind, invoicing and pricing, reversing shipments,
cert charges, cert-by-process, template editing.

## 3. Owner decisions, 2026-08-04 (this design session)

1. **Samples: provided, and they are the layout contract.** The owner delivered the current printed
   shipping ticket, BOL, certification and invoice into `docs/samples/` during this session, closing
   HANDOFF §7 item 1. The layout tasks (§14) build to them. They are real filled-in documents for
   orders `72036-3` and `72026`, not mockups — which is why §3.19–§3.22 exist.

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
   order produces ONE cert document — one signature, one sheet — repeating a block (part number,
   name, that line's serials, that line's inspection results) per part line. Not one cert per part
   line, and not lead-part-only (a rider's inspection requirements must reach paper).

6. **Cert results: seeded rows, many readings, computed pass/fail with an override.** The cert opens
   pre-loaded with one requirement row per part-line inspection requirement, copied from the part.
   Quality adds as many readings as they took under each requirement. Pass/fail is computed from
   min/max, and a person may override it; the override is flagged, audited and visible **on screen**
   (§3.21: it does not print).

7. **Credit hold blocks shipping, with a permissioned override.** This is the blocking half of the
   §3.7 Phase 3 ruling ("the squeeze happens at shipping"). A customer on credit hold cannot be
   shipped unless the actor holds the new named action `override_credit_hold`, in which case a
   **reason is required** and lands in the audit entry. The refusal names the customer and links to
   their record. Only the `creditHold` boolean is enforceable now — credit *limit* and past-due gates
   need an A/R balance that does not exist until Phase 5. **Certifications are never blocked by
   credit hold**: quality paperwork is not a credit decision.

8. **Corrections in Phase 4 are voids only; reversing shipments land with Phase 5.** Spec §7.3's rule
   (not-yet-invoiced → void, invoiced → reversing shipment) is kept intact, but nothing can reach
   `INVOICED` until Phase 5, so the reverse path would be code nothing could execute. `REOPENED`
   stays reserved and unreachable. Voiding a shipment un-ships its quantities, recomputes the
   affected orders' statuses, requires a reason, and leaves its stored PDFs reprintable forever.

9. **Order edits tighten by invariant, not by status.** No status-based freeze. Refused, each naming
   the blocking shipment: removing a part line that has live shipments; reducing a line's qty or
   weight below its shipped-to-date; voiding an order that has live shipments. PO, dates, notes,
   containers, serials, loads and charges stay editable at every status — the shop corrects a PO
   after shipping routinely, and spec §7.1 already keeps charges editable until invoiced. This is the
   §5a hook Phase 3 left for this phase.

10. **A shipment records containers, serials and a ship-to override.** Which of the order's container
    rows went and how many; which of the order's serials went (with a per-row print-on-shipper flag);
    and a ship-to chosen from the customer's own saved addresses (not a free-typed one-off, so the
    address stays a maintained record).

    **Amended by §3.21 (samples).** Freight was originally ruled to be spec §7.3's bill/$ pair only,
    with freight terms and a pro number explicitly declined. The BOL sample carries all of them, so
    the ruling is superseded: freight class, freight description, prepaid/collect, carrier pro number
    and SCAC code are all captured. The owner noted the sample load was *"a customer owned truck"* —
    which is why its `Carrier` reads "Customer" and several carrier fields are blank.

11. **The signature that prints is the printing user's.** No signer selection, no config keys —
    Visual Shop's three competing answers (`signature_from_cert_control`, `signature_from_last_opid`,
    the printing operator) collapse to one rule. Phase 4 therefore builds the **signature upload on
    the user record**, since `User.signatureImage` has existed since Phase 1 with nothing reading or
    writing it. A user with no signature on file prints their display name over the signature rule —
    visible on screen, blocking nothing. The sample cert confirms the shape: a signature image above
    a typed name, title and company.

12. **Multi-order shipments are emergent, one ship-to per shipment.** No "Multi Ord Shipper" mode to
    tick. A shipment is a document; any of that customer's other orders can be added to it; the whole
    shipment has one ship-to, because it is one delivery. Removing an order is an edit to the
    document — this is what spec §7.3 means by "no Multi-Num-zero workarounds".

    **Amended by §3.20 (samples).** The original ruling said an "MOS layout" would print
    automatically once a shipment covered more than one order. The samples show otherwise: **one
    shipping ticket per order, plus one BOL for the truck.** The MOS shipper layout is deleted from
    scope; the BOL *is* the multi-order document.

13. **A missing certification warns at shipping, never blocks.** A banner naming that the order
    requires a cert and none exists, with a link to produce one; the shipment goes through. Consistent
    with spec §3's "we just ship" and with Visual Shop's own warning that its equivalent gate
    ("Validate Results before Shipping") can stop the dock outright.

14. **Printing a shipment offers its certifications, checked by default.** When an order on the
    shipment requires a cert, the print action shows "also print the certification" pre-ticked;
    unticking is one click. Each PDF is produced and stored as its own document.

15. **Print/Change is NOT built — this amends spec §7.4.** Visual Shop's one-off, deliberately
    unsaved print-time edit is dropped. Certs are edited, saved (audited) and printed; after the first
    print, further edits require the existing `edit_cert_results_after_print` action. The reasoning:
    every print is stored byte-for-byte regardless, so nothing about controlled-document behaviour is
    lost, while the record always explains the paper. If a genuine one-off need appears it can be
    added deliberately later.

16. **Stored documents: one widened `StoredDocument` table** (Phase 3 spec §16 left this call to this
    phase). `orderId` becomes nullable and is joined by `shipperId` and `certId`, with a database
    `CHECK` that pins each `kind` to a legal owner combination; `DocumentKind` gains `SHIPPER`, `BOL`,
    `CERT`. Sibling tables were considered and rejected: documents have a genuinely cross-cutting read
    pattern (a multi-order shipment's BOL belongs on every order it covers) that attachments never
    had, and one table means the permanence guarantee, the `fileData` redaction and the fetch route
    are each written once instead of four times.

17. **A cert record is created when the thing it describes is stable.** Order-scope at order save;
    shipment-scope when the shipment is created; **load-scope on demand**, because Phase 3's own
    ruling (§3.3) keeps loads editable, renumberable and re-splittable after save — eagerly creating a
    cert per load would mean a re-split either orphans certs or deletes ones with readings already
    typed into them. The order hub shows the gap explicitly ("by load · 4 loads · 0 certs") with a
    create action per load, so nothing is silently forgotten.

18. **Results are two levels: requirement → readings.** A frozen requirement row per part-line
    inspection requirement, with reading rows under it. This matches how the printed cert reads and
    makes "two rows for one characteristic disagreeing about min/max" unrepresentable. A flat single
    table was considered and rejected for exactly that drift.

### Amendments after the samples arrived (same session, 2026-08-04)

19. **Numbering follows the samples exactly, and it is not what this design first assumed.** The
    shipping ticket and the certification both print `Order No.: 72036-3` **and** `Packing List No:
    072826`; the certification carries **no certification number at all**; the BOL carries its own
    `Shipper's Bill of Lading No.: 12795`. Therefore:

    - A **shipment gets one global number**, printed as **"Packing List No"**. A shipment covering
      five orders cannot be identified by any one of them, so this number is structural, not
      cosmetic. Source: `allocateNumber("shipper_number_next")`.
    - **Each order on a shipment also carries its own shipment sequence** — the `-3` in `72036-3`,
      meaning "the third shipment against order 72036". Allocated per order under `claimOrder`,
      **never reused** (a voided shipment keeps its sequence, exactly as a voided order keeps its
      number).
    - **Certifications get no number of their own.** They are identified by order + scope instance,
      which is what the sample prints. `cert_number_next` is left in the settings registry but is
      now **unused by design** — recorded here so a future reader does not "fix" it by wiring it up.
    - **The BOL gets its own counter**, `bol_number_next` (new setting), allocated **lazily at first
      BOL print** and stored on the shipment so every reprint shows the same number. Not every
      shipment gets a BOL — a customer-owned truck does not — so allocating at shipment creation
      would burn numbers on shipments that never produce one.

20. **Five orders on a truck print five shipping tickets and one BOL.** The BOL sample lists all five
    order numbers (`TRV NO. 71955,71957,71959,71960,71961`) while the shipping ticket sample covers
    exactly one order and carries its own `Received By / Date` strip. **This is the traveler's
    per-load render, reused**: one sheet-set per order within one PDF, or one order printed alone.
    It also drives the data model — see `ShipperOrder` in §4, which is what a ticket is a render of.

21. **The certification prints readings, not a requirements table.** The sample carries no min/max,
    no scale column, no pass/fail and no per-reading structure. It carries a standing statement
    (*"We certify that the listed Parts / Materials were heat treated in accordance with … Quality
    Assurance Manual 08/01/22 and customer requirements as follows:"*), then a line naming the
    specification and scale (*"Were heat treated as per P.O. NONE to HRC:"*), then a **bare grid of
    reading values**. Min/max, scale, pass/fail and the override flag remain in the model and on
    screen — they are how quality works — but **they do not print**. Two standing text blocks
    therefore become settings in this phase (`cert_statement`, `shipper_liability_text`), because
    hard-coding a quality-manual reference into a PDF builder is exactly the coupling spec §8 exists
    to remove; Phase 7's designer takes them over.

22. **Two fields the shop does not use are built anyway, on the owner's explicit instruction.**
    `Cust Cont Id` (the customer's own identifier for a bin, a column on the ticket's container
    table) and `Customer Job No` (a per-order field beside the PO). Owner, verbatim: *"While our
    shop does not use them, they are handy and are used frequently by other shops and some
    contracts."* Recorded with the reasoning because this is the one place in this phase where
    something is built without a present-day user, and a future reviewer should know it was a
    decision and not an accident.

### Amendments during PR #47 review (2026-08-06)

23. **Snapshot + release — shipper children snapshot printed identity; their order-side FKs are
    nullable `ON DELETE SET NULL`.** The original `RESTRICT` FKs from
    `ShipperLine`/`ShipperContainer`/`ShipperSerial` to the order-side rows meant that once any
    shipment (voided included — its children survive by §5.6) referenced an order's
    line/container/serial, the order-correction APIs (`removeLine` after voiding every blocker,
    `replaceContainers`, `replaceSerials`) died on a raw FK error — the documented void-then-correct
    recovery path could not work. Owner ruled **snapshot + release** over "honest refusal": each
    child captures at save time exactly what the paper prints (`partNumber`/`partName`/
    `partDescription`/`orderedQty`/`orderedWeight`; `typeName`/`customerContainerId`;
    `serial`/`description`), the FKs become nullable `SET NULL`, reads prefer the live join and
    fall back to the snapshot once released. Voided-shipment history survives through the
    snapshot; orders stay correctable through the APIs they always had. Migration
    `20260806091506_shipper_children_snapshot_release` backfilled every existing row from the
    joins `RESTRICT` had kept intact.

24. **Ruling 23 extends to `CertRequirement` (round 3, same session).** A frozen requirement's
    `orderLineId` is nullable `SET NULL` with the line identity it prints (`linePosition`,
    `partNumber`, `partName`) snapshotted at seed time, beside the min/max/sampleQty/location that
    were always frozen copies — a requirement must never block `removeLine`. Migration
    `20260806104833_cert_requirement_snapshot_release`. Released rows in shipment grids render
    read-only from their snapshots and **survive every shipper-side replace as frozen history**
    (replaces delete only rows still tied to a live order-side row). **Refined in round 4 (same
    day): a requirement's identity reads the SNAPSHOT unconditionally** — the whole row is a
    frozen copy, so a later part rename or an earlier rider's removal must never shift a seeded
    certification; the cert page groups requirement blocks by the frozen `linePosition`
    accordingly. Shipment-grid rows stay live-join-first (a shipment is a document being edited);
    a certification is frozen at seed. Round 4 also pinned two release consequences: the
    order-hub document list matches whole-shipment paper only through the shipper relation
    (`orderId: null` — a sibling order's own ticket is not this order's paper), and audit
    snapshots order serials by `[serial, id]` since `orderSerialId` stopped being a stable key.

25. **§5.4's credit-hold gate extends to shipment EXTENSION.** Owner ruled (round 3): a hold set
    after a shipment exists gates `addOrderToShipper` and `replaceShipperLines` — the two paths
    that add shipped work — with the same shape as creation: named + linked refusal;
    `override_credit_hold` plus a reason recorded in the audit entry proceeds. Header edits,
    containers, serials and removal stay ungated.

26. **A voided order produces no new cert paper.** `voidOrder` leaves ORDER/LOAD-scope certs live
    by design, so `printCert` checks the owning order's `deletedAt` under its claim and refuses
    with the shared voided-print rule; stored prints stay downloadable (§5.6). Also settled in
    round 3: the cert=1 bundle resolves **inside `printShippingTickets`' own claimed
    transaction** (a separate unlocked resolution could describe a different shipment state than
    the tickets printed); an order UPDATE landing on certRequired + ORDER scope creates the
    ORDER-scope cert `createOrder` would have (idempotent, §6.2's timing followed); LOAD-scope
    cert creation requires a load the order currently has; and the cert export carries
    passed/pending counts beside readings/fails (the worklist's three-state rule).

**Settled by design, not by ruling:** when an order's part lines disagree about whether a cert is
required, **any** line requiring one makes the order require one (a rider's requirement is never
silently dropped); when they disagree about scope, the **lead** part's resolved scope wins (the lead
owns document identity, as it owns the process). Both are overridable at order entry. And a
**consignee different from the ordering customer needs no new schema** — the BOL sample is consigned
to "Max Coating", and `CustomerAddress` already carries a `name`, so a third-party destination is a
named `SHIP_TO` address of that customer and stays a maintained record.

## 4. Data model

All tables additive; column additions to five existing models. One hand-written migration (the TTY
constraint — use the `/create-migration` skill), applied to both databases. Partial `@@unique` lines
stay single-line (sweep limitation, HANDOFF §5.11).

### 4.1 Certifications

```prisma
enum CertScope {
  ORDER
  LOAD
  SHIPMENT
}

model Cert {
  id            String     @id @default(cuid())
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

- **No `certNumber`** (§3.19). A cert is identified by its order and scope instance, and prints
  `Order No.: <orderNumber>-<shipmentSequence>` for shipment scope, the bare order number otherwise.
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
  pinned to a load *row* would silently follow that row through a renumber and describe a different
  physical load than the one on its paper. Pinning to the number means the cert says "Load 3" and
  keeps saying it. The cost is that a re-split to fewer loads can leave a cert whose load number no
  longer exists; **the order hub flags that cert rather than hiding it**, and a person voids or
  re-creates it, never the system silently.

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
  passed        Boolean?        // computed from min/max when a value is present; screen only (§3.21)
  overridden    Boolean         @default(false)
  note          String          @default("")

  @@unique([requirementId, position])
}
```

- `min`, `max`, `sampleQty` and `location` are **copied from `PartInspection` at seed time and frozen
  there** — editing the part next month must not silently rewrite a cert already being filled in.
  `inspectionCodeId`/`scaleId` stay real foreign keys so the delete guard covers them and names
  render consistently; the *forever*-frozen artifact is the stored PDF, which is this project's
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

### 4.2 Shipments

The hierarchy is **`Shipper → ShipperOrder → lines / containers / serials`**, and that middle table
is what §3.20 forced: the per-order shipment sequence (`-3`) belongs to the pair, one shipping ticket
is a render of one `ShipperOrder`, and "add order to the shipment / remove order from it" operates on
it directly rather than inferring order membership from a set of lines.

```prisma
enum FreightTerms {
  PREPAID
  COLLECT
}

model Shipper {
  id                String         @id @default(cuid())
  shipperNumber     Int            @unique      // prints as "Packing List No"
  bolNumber         Int?           @unique      // allocated lazily at first BOL print (§3.19)
  clientRequestId   String?        @unique      // idempotency nonce (the createOrder precedent)
  customerId        String
  customer          Customer       @relation(fields: [customerId], references: [id])
  shipToAddressId   String?                     // also the BOL's consignee (§3, closing note)
  shipToAddress     CustomerAddress? @relation(fields: [shipToAddressId], references: [id])
  shipDate          DateTime       @db.Date
  carrierId         String?
  carrier           Carrier?       @relation(fields: [carrierId], references: [id])
  route             String         @default("")
  comments          String         @default("")
  billFreight       Boolean        @default(false)
  freightAmount     Decimal?       @db.Decimal(12, 2)
  freightTerms      FreightTerms   @default(PREPAID)
  freightClass      String         @default("")  // NMFC class, e.g. "70" or "92.5" — text, never math
  freightDescription String        @default("")  // "Manufactured Castings I/S"
  packageCount      Int?                         // prefilled from the container sum, editable
  proNumber         String         @default("")
  scacCode          String         @default("")
  deletedAt         DateTime?                    // voided; reason in the audit entry, void_shipper
  createdAt         DateTime       @default(now())
  updatedAt         DateTime       @updatedAt
  orders            ShipperOrder[]
  certs             Cert[]
  documents         StoredDocument[]

  @@index([customerId])
  @@index([shipDate])
  @@index([carrierId])
}

model ShipperOrder {
  id         String   @id @default(cuid())
  shipperId  String
  shipper    Shipper  @relation(fields: [shipperId], references: [id])
  orderId    String
  order      Order    @relation(fields: [orderId], references: [id])
  sequence   Int      // the "-3" in "72036-3": this order's Nth shipment, never reused
  position   Int      // print order of the tickets within one shipment
  lines      ShipperLine[]
  containers ShipperContainer[]
  serials    ShipperSerial[]

  @@unique([shipperId, orderId])
  @@unique([shipperId, position])
  @@unique([orderId, sequence])
  @@index([orderId])
}

// Amended 2026-08-06 (ruling 23, snapshot + release): the three FKs to the order-side rows are
// nullable ON DELETE SET NULL, and each child snapshots the identity it prints at save time.
model ShipperLine {
  id              String       @id @default(cuid())
  shipperOrderId  String
  shipperOrder    ShipperOrder @relation(fields: [shipperOrderId], references: [id])
  orderLineId     String?
  orderLine       OrderLine?   @relation(fields: [orderLineId], references: [id], onDelete: SetNull)
  position        Int
  qty             Int          // >= 0
  weight          Decimal      @db.Decimal(12, 2)  // >= 0
  lineComplete    Boolean      @default(false)
  partNumber      String       // snapshot at save
  partName        String       @default("")
  partDescription String       @default("")
  orderedQty      Int
  orderedWeight   Decimal      @db.Decimal(12, 2)

  @@unique([shipperOrderId, position])
  @@unique([shipperOrderId, orderLineId])
  @@index([orderLineId])
}

model ShipperContainer {
  id                  String          @id @default(cuid())
  shipperOrderId      String
  shipperOrder        ShipperOrder    @relation(fields: [shipperOrderId], references: [id])
  orderContainerId    String?
  orderContainer      OrderContainer? @relation(fields: [orderContainerId], references: [id], onDelete: SetNull)
  position            Int
  count               Int
  typeName            String          // snapshot at save
  customerContainerId String          @default("")

  @@unique([shipperOrderId, position])
  @@unique([shipperOrderId, orderContainerId])
  @@index([orderContainerId])
}

model ShipperSerial {
  id             String       @id @default(cuid())
  shipperOrderId String
  shipperOrder   ShipperOrder @relation(fields: [shipperOrderId], references: [id])
  orderSerialId  String?
  orderSerial    OrderSerial? @relation(fields: [orderSerialId], references: [id], onDelete: SetNull)
  printOnShipper Boolean      @default(true)
  serial         String       // snapshot at save
  description    String       @default("")

  @@unique([shipperOrderId, orderSerialId])
  @@index([orderSerialId])
}
```

- **`shipperNumber` and `bolNumber` are plain `@unique` on a soft-deletable model — deliberate,
  documented, sweep-exempted**, exactly like `Order.orderNumber` (P3 spec §4) and `User.username`
  before it: a voided shipment keeps both forever and neither is ever reused or re-entered.
  `Shipper.clientRequestId` carries the P3 nonce exemption. `tests/partial-unique-sweep.test.ts`
  gains all three with their rationale.
- **`@@unique([orderId, sequence])` is what makes `72036-3` stable.** The sequence is allocated
  under `claimOrder` as `max(sequence for that order, including voided shipments) + 1`, so voiding
  shipment 2 never renumbers shipment 3 — the number is already on paper in a customer's hands.
- `@@unique([shipperOrderId, orderLineId])`: one row per order line per shipment. Shipping the same
  line twice means two shipments, which is what two shipments are.
- **A shipment must carry at least one line with `qty > 0`** across all its orders (service-enforced)
  — a document about nothing is not a shipment. A line with `qty = 0` and `lineComplete = true` is
  legitimate and deliberately allowed: "we are not sending the last three, close the line."
- Shipment children have no `deletedAt`, same reasoning as the cert's.
- `freightClass` is **text, never a number** — NMFC classes include `92.5` and `77.5`, and nothing
  ever does arithmetic on one. The same reasoning as `PartInspection.sampleQty` (P3 §3.9).

### 4.3 Stored documents

```prisma
enum DocumentKind {
  TRAVELER
  SHIPPER
  BOL
  CERT
}

model StoredDocument {
  id         String       @id @default(cuid())
  orderId    String?      // TRAVELER: owner. SHIPPER: which order's ticket (null = the whole set)
  order      Order?       @relation(fields: [orderId], references: [id])
  shipperId  String?      // SHIPPER, BOL: owner
  shipper    Shipper?     @relation(fields: [shipperId], references: [id])
  certId     String?      // CERT: owner
  cert       Cert?        @relation(fields: [certId], references: [id])
  kind       DocumentKind
  loadNumber Int?         // TRAVELER only: null = the whole set
  fileData   Bytes
  createdAt  DateTime     @default(now())

  @@index([orderId])
  @@index([shipperId])
  @@index([certId])
}
```

- Ownership is decided by `kind`, and `orderId` doubles as the **sub-scope** for a `SHIPPER`
  document exactly as `loadNumber` does for a `TRAVELER` — printing one order's ticket out of a
  five-order shipment is the same shape as printing one load's traveler. Enforced by a hand-written
  `CHECK` (Prisma's schema language has no check syntax — the `Part.loadQty` precedent):

  ```sql
  CHECK (
    (kind = 'TRAVELER' AND "orderId"   IS NOT NULL AND "shipperId" IS NULL     AND "certId" IS NULL) OR
    (kind = 'SHIPPER'  AND "shipperId" IS NOT NULL AND "certId"    IS NULL)                          OR
    (kind = 'BOL'      AND "shipperId" IS NOT NULL AND "orderId"   IS NULL     AND "certId" IS NULL) OR
    (kind = 'CERT'     AND "certId"    IS NOT NULL AND "orderId"   IS NULL     AND "shipperId" IS NULL)
  )
  ```

  Every existing row is a `TRAVELER` with `orderId` set, so the constraint validates on the way in.
- **Still permanent — no delete path at all**, `fileData` still redacted from snapshots, create-only
  audit. Widening the table must not weaken any of the three.

### 4.4 Changes to existing models

| Model | Column | Notes |
|---|---|---|
| `Part` | `certRequired Boolean?`, `certScope CertScope?` | null = inherit |
| `Customer` | `certRequiredDefault Boolean?`, `certScopeDefault CertScope?` | null = inherit the plant |
| `Order` | `certRequired Boolean @default(false)`, `certScope CertScope @default(ORDER)` | **resolved and frozen at save**, overridable at entry and after |
| `Order` | `customerJobNo String @default("")` | §3.22; prints on the ticket beside the PO |
| `OrderContainer` | `customerContainerId String @default("")` | §3.22; the ticket's "Cust Cont Id" column |
| `Order`, `Customer`, `Carrier`, `CustomerAddress`, `OrderLine`, `OrderContainer`, `OrderSerial`, `InspectionCode`, `InspectionScale` | back-relations | as shown above — `Order` gains `certs Cert[]` and `shipperOrders ShipperOrder[]` on top of its four columns |

**Five new settings.** Numbering: `bol_number_next` (integer seed, the `numberSeed` schema, default
1000). Standing text (§3.21): `cert_statement` and `shipper_liability_text`, both strings whose
defaults are transcribed from the samples. Certification chain: `cert_required_default` (boolean,
default `false`) and `cert_scope_default` (`z.enum(["ORDER","LOAD","SHIPMENT"])`, default `ORDER`).
`cert_number_next` stays in the registry **unused by design** (§3.19) — do not wire it up.

**Text/number rules** (2C-2 §4 convention): `route`, `comments`, `freeform`, `internalNotes`,
`location`, `note`, `freightDescription`, `customerJobNo`, `customerContainerId`, `proNumber`,
`scacCode`, `freightClass` are `.max(n)` display text defaulting `""`; `sampleQty` is `.max(60)`
free text, never a number (P3 §3.9); money and weights are `Decimal(12, 2)`; readings and min/max are
`Decimal(10, 4)`; quantities are integers.

## 5. Rules and the concurrency contract

### 5.1 The ship ledger

Shipped-to-date for an order line is the sum of `qty` (and `weight`) across its **live** shipper
lines — a voided shipment contributes nothing. **One derivation, in `ship-ledger.ts`, used
everywhere**: the ship-now prefill (`ordered − shipped`, editable), the over-ship warning, and the
edit invariants in §5.5. Over-shipping **warns and never blocks** — a customer's container takes 310
of a 300 line and the shop ships it.

### 5.2 Status derivation

Recomputed inside the same transaction as every shipment mutation, for every affected order, and
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

Every shipment and cert mutation runs `withDbErrors` → `$transaction` (Serializable — the
registered-FK writer pattern applies to `carrierId` and the cert's `inspectionCodeId`/`scaleId`
through `assertRefExists`) and **claims every affected order row with `claimOrder` before reading the
state it acts on**. The row lock is the guarantee at any isolation level; the isolation level must
never be presented as protecting it (CLAUDE.md, and the 2C-3 lesson that produced the rule).

**Multi-order shipments add a hazard Phase 3 never had.** Two saves touching orders `{A, B}` and
`{B, A}` deadlock if each claims in its own order. **Claims are therefore always taken in a
deterministic order — sorted by order id — in every code path that can touch more than one order**,
and that ordering carries its own test with both orderings driven concurrently.

The **shipment sequence** (§3.19) is allocated inside that same claim: `max(sequence) + 1` over every
`ShipperOrder` for that order **including voided shipments**, so a number already printed on a
customer's paperwork is never handed out twice.

`Shipper.clientRequestId` is the entry form's idempotency nonce, minted when a fresh shipment form
mounts and answered by returning the shipment that request already created — the `createOrder`
precedent (P3 §4), which exists precisely so a Serializable retry cannot burn a second number and
create a second document for one operator action. Never freed by a void.

Numbering uses `allocateNumber("shipper_number_next" | "bol_number_next", tx)` inside a transaction,
**after issue #34's guard lands** (§14 task 1) — the helper currently type-accepts every `SettingKey`
while only the `*_number_next` keys are numeric, and Phase 4 is what multiplies its call sites.

### 5.4 Credit hold

`mustCan(user, "shipping", "create")`, then: a customer with `creditHold` set is refused with a
message naming the customer and **linking to their record**, so whoever can lift the hold is
findable (the §5.14 blocked-delete discoverability rule applied to a permission-shaped block). An
actor holding `override_credit_hold` may proceed with a **reason required and trimmed in the
service** (the §5.17 shape), which is recorded in the audit entry and printed nowhere.
**Certifications are never gated on credit hold.**

### 5.5 Order edits after a shipment (the §5a tightening)

Service-enforced, each refusal naming the blocking shipment (`Packing List 072826`, linked to its
page) so the block is discoverable rather than a dead end:

- removing a part line that has live shipper lines;
- reducing a line's `qty` or `weight` below its shipped-to-date;
- **voiding an order that has live shipments** — void the shipments first, otherwise the shipment is
  left pointing at lines that have vanished from every list.

**Added 2026-08-04 (Task 2 review).** One more refusal, on the shipment side:
**removing an order from a shipment is refused once a shipping ticket for that order has printed.**
`ShipperOrder` has no `deletedAt` by design, so removing one hard-deletes the row — which frees its
`sequence`, because a unique index cannot hold a number whose row is gone. A later shipment of that
order would then be handed a number a customer is already holding on paper. Voiding the whole
shipment is the correct correction and keeps every sequence claimed forever (§5.6). Before any
ticket has printed the sequence is on nothing, so removal stays free — the refusal is exactly as
narrow as the hazard.

Everything else stays editable at every status: PO, VS #, customer job no, dates, notes, containers,
serials, loads, charges, and the order's own cert-required/scope. Customer and lead part/revision
remain immutable forever (P3 §5a).

### 5.6 Void

**Shipment** (`mustDo(user, "void_shipper")`, reason required and trimmed in the service): claims
every affected order in sorted order, `auditedSoftDelete`s the shipper, recomputes each order's
status, and **voids any shipment-scoped certs hanging off it with the same reason**.

**Added 2026-08-04 (Task 10 review).** A shipment-scoped cert is voided **when its order leaves the
shipment**, not only when the whole shipment is voided. `removeOrderFromShipper` hard-deletes the
`ShipperOrder` join row but the cert created for that order at shipment-save time still points at
the shipper — leaving a certification scoped to a shipment that no longer carries its parts, and
leaving `voidShipper`'s later cascade writing to a cert whose order it never claimed (a row-lock
violation, since the claim is computed from the shipment's *current* orders). Voiding the cert at
removal time, under the claim that mutator already holds for that order, fixes the orphan at its
source and keeps `voidShipper`'s cascade provably covered by its own claim. Its stored PDFs
stay listable and reprintable **forever**; new prints against a voided shipment are refused. Its
`shipperNumber`, `bolNumber` and every `ShipperOrder.sequence` are kept and never reissued. This is
Phase 3's voided-order rule reused, not reinvented.

**Cert** (`certs.delete`, reason required): same shape. Stored cert PDFs survive; new prints refused.

### 5.7 Warnings, never blocks

Returned as Phase 3's `warnings[]` and rendered as banners, named per line (the issue-#4 visible-skip
habit):

- an order on the shipment requires a certification and none exists yet, with a link to create one
  (§3.13);
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
| `SHIPMENT` | when a shipment is created, one cert per `ShipperOrder` on it |
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
diff, and **not printed** (§3.21). Overriding is `certs.edit`; after `printedAt` is set, every results
edit additionally requires `edit_cert_results_after_print`.

## 7. Registry, sweeps, and audit surface

- **`REFERENCE_LINKS` gains three entries**: `shipper.carrierId → carrier` (**`Carrier`'s first
  consumer since it shipped in Phase 2A** — this is what finally gives it a delete guard and blocker
  list), `certRequirement.inspectionCodeId → inspectionCode`, and `certRequirement.scaleId →
  inspectionScale`. Each with `liveWhere` inheriting the parent's liveness, `blockerId`/`displayName`
  presenting the owning document (`Packing List 072826`, `Cert · #72036-3`), and a `detailPath`. The
  links sweep enforces registration automatically; `deleteReference` then refuses while live
  shipments or certs hold them, with the standard blocker list and Excel export.
- **Sweep exemptions**: `Shipper.shipperNumber`, `Shipper.bolNumber` and `Shipper.clientRequestId`
  join `Order.orderNumber`, `Order.clientRequestId` and `User.username` in
  `tests/partial-unique-sweep.test.ts`, each with its documented rationale. **`Cert` adds none** —
  it has no unique column (§3.19).
- **`AuditableModel` += `cert`, `shipper`.** `SNAPSHOT_INCLUDE.cert` pulls requirements (with code
  and scale selects) and their readings; `SNAPSHOT_INCLUDE.shipper` pulls its orders (with order and
  customer selects) and each one's lines, containers and serials. **Every collection carries an
  `orderBy`** — the issue-#24 lesson applied from birth, as Phase 3 did.
- Tests assert audit **content** (a real before/after diff), not merely that an entry exists.

## 8. Services

- `src/server/ship-ledger.ts` — `shippedTotals(tx, orderLineIds)`, `recomputeOrderStatus(tx,
  orderIds)`, `nextShipmentSequence(tx, orderId)`. The single derivation of §5.1, §5.2 and §5.3;
  every other module calls it.
- `src/server/shippers.ts` — `createShipper`, `getShipper`, `listShippers` (filters, search, sort,
  export), `updateShipper`, `addOrderToShipper`/`removeOrderFromShipper`, `replaceLines`,
  `replaceContainers`, `replaceSerials`, `voidShipper`.
- `src/server/certs.ts` — `resolveCertSettings(customerId, lineParts)`, `createCert(scope-aware)`,
  `getCert`, `listCerts`, `updateCert`, `voidCert`.
- `src/server/cert-results.ts` — `seedRequirements(tx, certId)`, `replaceReadings`, the pass/fail
  computation and override handling.
- `src/server/documents.ts` — **extracted from `traveler.ts`**: `storeDocument(tx, {kind, owner,
  bytes})`, `listDocumentsForOrder(orderId, permissions)`, `getDocument(docId)`. With one widened
  table, the permanence guarantee, the redaction rule and the byte-exact reprint should exist once.
  The order-hub union is one query:
  `{ OR: [{ orderId }, { cert: { orderId } }, { shipper: { orders: { some: { orderId } } } }] }`
  — which is what puts a multi-order shipment's BOL on every order it covers.

  **Owner ruling 2026-08-04 (Task 3 review): that union is filtered by the caller's permissions.**
  The union means `GET /api/orders/[id]/documents`, gated on `orders.view` alone, would otherwise
  reveal to an order-entry-only user that a BOL or a certification exists for their order. The list
  therefore shows only the kinds the viewer may actually open — `TRAVELER` needs `orders.view`,
  `SHIPPER`/`BOL` need `shipping.view`, `CERT` needs `certs.view` — implemented the way
  `src/server/search.ts` already filters its grouped results, not as a second bespoke mechanism.
  Considered and rejected: showing the row greyed-out per §5.16, and showing everything on the
  grounds that it is only metadata.
- `src/server/pdf/shipping-ticket.ts`, `pdf/bol.ts`, `pdf/cert.ts` — document definitions (plain
  JSON), on the existing `pdf/render.ts` plumbing. **No MOS layout** (§3.20).
- `settings.ts` — `allocateNumber`'s key type narrows to
  `Extract<SettingKey, \`${string}_number_next\`>` (issue #34); four new keys (§4.4).
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
| `/api/shippers/[id]/orders` (+ `[shipperOrderId]`) | POST / DELETE | `shipping.edit` |
| `/api/shippers/[id]/orders/[shipperOrderId]/lines`, `/containers`, `/serials` | PUT (replace) | `shipping.edit` |
| `/api/shippers/[id]/print` (`?doc=ticket\|bol&order=<id>&cert=1`) | POST | `shipping.view` |
| `/api/shippers/[id]/documents` | GET | `shipping.view` (added 2026-08-05, see below) |
| `/api/certs/[id]/documents` | GET | `certs.view` (added 2026-08-05, see below) |
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
gate on the **owning entity's** area — a traveler behind `orders.view`, a ticket or BOL behind
`shipping.view`, a cert behind `certs.view`. Printing gates on `.view` for the same reason the
traveler does (P3 §9): it changes nothing about the record, archives its own output as an audited
create, and is an explicit POST, so spec §12's "reads never mutate" holds. Existing `parts` and
`customers` PATCH routes accept the new cert columns; `orders` PATCH accepts `certRequired`,
`certScope` and `customerJobNo`; the containers replace route accepts `customerContainerId`.

`SPECIAL_ACTIONS` gains `override_credit_hold` (eleven total) — a spec §9 amendment.

**Amendment 2026-08-05 (Task 14 review adjudication):** `GET /api/shippers/[id]/documents` was
missing from this table — Task 3 built `listDocumentsForShipper`, Task 11 exposed the *orders*
document list, and nothing ever exposed the shipment one, which the shipment page needs for its
stored-documents list. Task 14 added it; its review adjudicated the addition a faithful gap-fill:
`handle` + `mustCan(shipping.view)` first line, metadata-only select, and the §8 per-kind filter is
satisfied *by construction* — `ownerColumns` nulls `shipperId` for TRAVELER/CERT behind a DB CHECK,
so only SHIPPER/BOL rows (both `shipping`-area kinds per `AREA_FOR_KIND`) can ever match.

**Amendment 2026-08-05 (Task 16 review adjudication):** `GET /api/certs/[id]/documents` added on the
same footing — the cert detail page's stored-documents list mirrors the shipper route's pattern, and
the same CHECK (`certId` non-null only for kind CERT) plus `AREA_FOR_KIND`'s `CERT → certs` mapping
make the §8 per-kind filter vacuously satisfied behind `mustCan(certs.view)`.

**Amendment 2026-08-05 (Task 17 review adjudication):** `POST /api/orders` also accepts optional
`certRequired`/`certScope`. §6.1's "overridable at entry" cannot be implemented create-then-PATCH:
§6.2 creates the ORDER-scope cert *inside* `saveNewOrder`'s transaction when the effective pair is
(true, ORDER), and `updateOrder` writes the columns as plain scalars without creating or destroying
certs — so the entry-time override must ride the create body. Validation and audit parity with the
PATCH path is maintained (identical zod shapes; the audit entry records the effective frozen pair).

**Amendments 2026-08-05 (Task 19 review adjudications, owner-ratified):**
- **The print route's `cert=1` branch also requires `certs.view`** on top of `shipping.view`. The §8
  ruling forbids disclosing cert existence to shipping-only users, so letting them produce cert
  paper they cannot open or list would be incoherent. The UI degrades cleanly: the checkbox is
  unticked and disabled with a permission-naming tooltip, and the request omits `cert=1`.
- **`cert=1` with a cert-REQUIRING order that has no cert prints the tickets and WARNS** — it does
  not refuse the request (owner ruling, honoring §3.13's "a missing cert warns and never blocks" in
  the default pre-ticked flow). No cert is archived; the response carries a named warning the UI
  surfaces.
- **`cert=1` on a LOAD-scope order prints ALL its live load certs** — including loads that did not
  ship on this shipment — and sets `printedAt` on each, placing their readings behind
  `edit_cert_results_after_print`. Owner accepted the side effect: the shipment cannot know which
  loads went, and the alternatives either kill the combined print for load-scope shops or silently
  drop quality paper.
- **`SIGNATURE_MIME` drops `image/bmp`** — pdfkit cannot embed BMP, so a BMP signature rendered on
  screen while every cert silently printed the typed-name fallback. New uploads must be PNG/JPEG;
  existing BMP rows keep falling back safely.

## 10. Documents

Three layouts on `src/server/pdf/`'s existing plumbing, each a JSON document definition — the same
template-as-data contract Phase 7's designer will edit and version. Built to the owner's samples in
`docs/samples/`, which are the contract.

### 10.1 Shipping ticket — `Shipping Ticket Sample.pdf`

One ticket per `ShipperOrder`. "Print tickets" renders one sheet per order of the shipment into ONE
PDF (`StoredDocument{kind: SHIPPER, shipperId, orderId: null}`); "print this order's ticket" renders
just that one (`orderId` set) — **the traveler's per-load mechanic, reused** (§3.20).

- Header: company name and `Shipping Ticket`, `Order No.: <orderNumber>-<sequence>`, `Ship Date`,
  logo top-right, `Page N of M`.
- **Sold To** (the customer's default `BILL_TO` address, with the customer code in the corner) and
  **Ship To** (the shipment's ship-to address, with its own id) side by side.
- Field strip: `Purchase Order Number`, `Packing List No` (= `shipperNumber`), `Customer Job No`,
  `Route`, `Carrier`.
- Parts table: `Quantity` | `Part No. / Part Name / Part Description` (stacked) | `Pounds`, one row
  per shipper line, showing that shipment's quantities.
- Container table in two column groups: `Container Type` | `# Of Containers` | `Cust Cont Id`.
- Serials where `printOnShipper`.
- The `shipper_liability_text` standing block (§3.21), transcribed from the sample as its default.
- `Shipped Complete` when every line on this ticket is `lineComplete`, then `Quantity Shipped` and
  `Pounds Shipped` totals.
- Footer tear-off: order number, shipped-complete, totals again, **`Received By: ____ Date: ____`**,
  `Sold To`, `Shipped ON`.

### 10.2 Bill of lading — `Bill of Lading Sample.pdf`

**The multi-order document** (§3.20). One per shipment, `StoredDocument{kind: BOL, shipperId}`.

**Model confirmed by the owner 2026-08-04 (during Task 3's review):** a BOL belongs to exactly one
shipment and does not exist until someone prints one — the sample's five order numbers
(`TRV NO. 71955, 71957, 71959, 71960, 71961`) are five orders that went out on one truck as one
shipment. A BOL built independently of a shipment, and a BOL gathering several shipments onto one
form, were both put to the owner and both rejected. Nothing in the model changes; this paragraph
exists because the question was asked and answered, and a future reader should not have to re-ask it.
Straight-bill-of-lading form: `Original - Not Negotiable`, `Carrier's Pro No.` (`proNumber`),
`Shipper's Bill of Lading No.` (`bolNumber`, allocated on this first print), `Consignee's Ref/PO No.`
(the orders' POs), `Carrier's Code (SCAC)`; name of carrier; the standard UDSBL boilerplate; ship-from
(company settings) and date; **`Consigned to` + `Destination` from the ship-to address, which is how a
third-party consignee like the sample's "Max Coating" is expressed**; **`TRV NO.` listing every order
number on the shipment**; the freight table (`No. Packages` = `packageCount`, `Kind Of Package,
Description of Articles` = `freightDescription`, `Weight` = the shipment's total, `Class or Rate` =
`freightClass`); and the prepaid/collect block driven by `freightTerms`. `Delivering Carrier`, `Car or
Vehicle Initials`, `Received $`, `Charges Advanced` and the signature lines print as blank rules for
hand completion, as they are on the sample.

### 10.3 Certification — `Certification Sample.pdf`

`StoredDocument{kind: CERT, certId}`.

- Header: logo, company name, `Certification`, `Order No.` (`<orderNumber>-<sequence>` for shipment
  scope, the bare number otherwise), `Date`, `Entry Date` (the order's received date), `Page N of M`.
- `To:` the customer name and address block; `Purchase Order No.`, `Packing List No.` (the
  shipment's `shipperNumber` where one applies), `Material` (the lead part's material).
- Parts table: `Quantity` | `Part Number / Part Name / Part Description` | `Pounds`, one row per part
  line, with scope-appropriate quantities (order totals / that load's / that shipment's shipped).
- The `cert_statement` standing block (§3.21), whose default is transcribed from the sample.
- Per requirement: a line naming the specification and scale — the sample's *"Were heat treated as
  per P.O. NONE to HRC:"* — then that requirement's readings **as a bare wrapping grid of values**.
  **No min/max column, no scale column, no pass/fail, no override marker** (§3.21).
- Each part line's serials with their `description` (the heat/lot field Phase 3 added for exactly
  this), where the part has them.
- The freeform block. **Never `internalNotes`.**
- Signature block: the printing user's `signatureImage`, then their display name, title and the
  company — or their display name typed over the rule when no image is on file.
- Footer: company address, phone, fax.

**Print mechanics** (the traveler's, reused): the response streams the PDF; every print is stored
byte-for-byte; the detail page lists every prior print and **reprint streams the stored bytes
exactly**. Printing a shipment offers its certifications pre-ticked (§3.14). Prints against a voided
shipment, cert or order are refused; stored ones remain.

## 11. UI

**Shipping list** (`/shipping`, nav goes live): packing list no, customer (`CODE · name`), ship date,
orders covered, carrier, qty and weight totals, freight, BOL no, voided indicator. Search-as-you-type,
filters (customer, ship-date range, include-voided toggle default off), Excel export, the
`use-latest` stale-response gate, and a failed load that says so (no `.catch(() => {})`).

**Shipment page** (`/shipping/[id]`, remounts per id — §5.12): header (customer, ship-to selector from
that customer's saved addresses, ship date, carrier, route, comments, freight block — bill/amount,
terms, class, description, package count, pro no, SCAC — and the customer's standing shipping notes
displayed). Then **one panel per order on the shipment**, headed `72036-3`, each with its lines grid
(ordered / shipped-to-date / ship-now qty and lbs / ship-line-complete, prefilled to the remainder),
containers and serials. **Add order** (that customer's orders with unshipped lines); Print (all
tickets, one order's ticket, BOL, and the cert checkbox pre-ticked); stored documents; History; Void
with reason. Credit-hold refusal and the §5.7 warnings render as banners.

**Certifications worklist** (`/certs`): order (`#72036-3`), customer, scope, load or shipment,
printed?, a pass/fail summary. Filters and export.

**Cert page** (`/certs/[id]`): header (order link, scope and its subject, printed date); one
requirement block per part line with its readings grid, showing min/max, scale and computed pass/fail
**on screen even though none of it prints**; freeform; internal notes clearly marked as never
printing; Print; documents; History. Post-print, the results grid is read-only unless the actor holds
`edit_cert_results_after_print`, and says so.

**Order hub** gains **Certifications** and **Shipments** sections — the two Phase 3 deliberately left
unrendered — plus cert-required, scope and customer job no on Overview. **Order entry** shows the
resolved cert-required/scope with an override, plus customer job no and the containers grid's new
`Cust Cont Id` column. **Part** and **Customer** pages gain their cert fields. **Admin → Users** gains
the signature upload with a preview. **Admin → Settings** gains the Certifications group and the two
standing-text blocks.

Permission gating stays §5.16 throughout — disabled with a tooltip naming the missing permission,
never hidden; fields read-only for view-only users. Bulk grids reuse `src/lib/bulk-grid.ts`, and the
**sibling-split lesson applies**: a fix landing on one grid lands on every other in the same commit —
this phase adds three more grids per shipment order, which is the largest sibling group yet.

## 12. Testing

TDD per task; every route 401/403-tested; the suite grows from 1010. Dense clusters:

1. **Numbering** — concurrent shipment saves get distinct sequential packing-list numbers; the BOL
   number is allocated only on first BOL print and is stable across reprints; issue #34's narrowed
   key type rejects a non-numbering key.
2. **Shipment sequence** — `72036-3` is stable: voiding shipment 2 does not renumber 3; a new
   shipment after a void gets 4, not 2; concurrent shipments against one order get distinct
   sequences; the sequence counts voided shipments.
3. **Ledger** — shipped-to-date across several shipments; a voided shipment contributes nothing;
   prefill equals the remainder; over-ship warns and still saves.
4. **Status derivation matrix** — every combination across multi-line orders: none, partial,
   all-but-one complete, all complete, complete with a short quantity, a void restoring the previous
   status, and adding a rider line to a `SHIPPED` order returning it to `PARTIAL_SHIPPED`. Asserts
   explicitly that **quantities do not influence the outcome**.
5. **Claim ordering** — two multi-order saves over `{A, B}` and `{B, A}` run concurrently in both
   orderings without deadlock; the sorted-claim helper is asserted directly.
6. **Idempotency** — a retried shipment save with the same `clientRequestId` returns the first
   shipment and allocates no second number and no second sequence.
7. **Credit hold** — refusal names the customer and links to them; the override needs the action and
   a non-blank reason; the reason reaches the audit entry and no document; certs are unaffected.
8. **Edit invariants** — removing a shipped line, reducing below shipped-to-date, and voiding an
   order with live shipments each refuse and name the shipment; the same operations succeed once it
   is voided.
9. **Cert resolution** — part beats customer beats plant; any line requiring a cert wins; the lead's
   scope wins on disagreement; the values freeze at order save and a later part edit does not move
   them; the per-order override sticks.
10. **Creation timing** — order-scope at save; shipment-scope per `ShipperOrder`; load-scope only on
    demand; **a load re-split leaves an existing cert with readings untouched**; the per-scope
    uniqueness check refuses a duplicate under concurrency.
11. **Results** — seeding order and content from `PartInspection`; min/max frozen against a later
    part edit; many readings under one requirement; pass/fail computed at each boundary (min only,
    max only, both, neither, no value); an override flags and audits; **the rendered cert contains
    no min/max, scale or pass/fail text** (§3.21 asserted against the PDF, not just assumed).
12. **Documents** — the `CHECK` rejects an illegal kind/owner combination in each direction; a
    `SHIPPER` document may carry `orderId` (one ticket) or not (the set), and a `BOL` may not; stored
    bytes reprint `Buffer.compare`-identical while two fresh renders are compared by content (the
    `renderPdf` non-determinism rule); no delete path exists; `fileData` never appears in a snapshot;
    the order-hub union returns a multi-order shipment's BOL on every order it covers.
13. **Guards and registry** — carrier delete blocked by a live shipment with blocker list and export;
    inspection code and scale blocked by a live cert requirement; the links sweep sees all three new
    FKs; all three new plain-unique columns carry asserted sweep exemptions.
14. **Routes** — 401/403 for every new route; `/api/documents/[docId]` gates per owner kind (a
    `shipping.view`-only user can fetch a ticket PDF and not a cert PDF).

## 13. E2E + demo

Five flows join the existing ten (screenshots at named checkpoints, artifacts in
`erp/e2e-artifacts/`, dev-database fixtures cleaned per HANDOFF §5a's exact-key, fixture-customer,
localhost-gated rules):

1. `ship-partial-then-complete` — ship part of a two-line order → board shows Partial Shipped → ship
   the rest with both lines complete → Shipped.
2. `multi-order-shipment` — one shipment covering two orders → print tickets (two sheets) and the
   BOL (listing both order numbers) → both order hubs list the same documents.
3. `cert-results-print` — create a cert, see it seeded from the part's inspections, enter readings,
   see computed pass/fail on screen, print, reprint and confirm the identical stored file.
4. `void-shipment` — void with a reason → the orders' statuses return → the stored PDFs are still
   listed and still reprintable → a new shipment gets the next sequence, not the freed one.
5. `credit-hold-block-and-override` — a held customer refuses with a link to the customer → the
   override with a reason succeeds → the reason appears in history.

**Watch out for the Phase 3 E2E trap** (§4a): a URL regex like `/\/shipping\/[^/?]+$/` also matches
a literal `/shipping/new` route. Wait for content that can only exist post-navigation, not a broader
regex.

Final task: the owner demo walkthrough with screenshots, in `docs/` and named for the day it is
written (the 2C-2 / 2C-3 / Phase 3 precedent), presented before merge.

## 14. Task shape (planner refines)

Foundations first, one fresh subagent per task with an independent spec-and-quality review and fix
rounds, then the whole-branch review before the PR. **The samples are already in hand, so no task is
gated** — the Phase 3 samples gate is closed (§3.1).

1. `allocateNumber` numbering-key guard (**closes issue #34, before anything multiplies its call
   sites**) + the four new settings.
2. Schema migration, both databases (hand-written per the `/create-migration` skill) + the
   `StoredDocument` `CHECK` + sweep exemptions + `REFERENCE_LINKS` entries + `AuditableModel` /
   `SNAPSHOT_INCLUDE`.
3. `documents.ts` extraction + widened `StoredDocument`, with the traveler migrated onto it and its
   tests still green.
4. Cert resolution chain: `Part`/`Customer`/`Order` columns, `resolveCertSettings`, the freeze in
   `createOrder`.
5. `certs.ts` — scope-aware creation, uniqueness under the claim, get/list/update/void.
6. `cert-results.ts` — seeding, requirement/reading replace, pass/fail and override.
7. `ship-ledger.ts` — shipped-to-date, status derivation, shipment-sequence allocation, and the
   recompute hooks on order line operations.
8. `shippers.ts` core — create: sorted claims, `ShipperOrder` with its sequence, credit hold and
   override, idempotency, Serializable + `assertRefExists`.
9. Shipment children — lines/containers/serials replace, add and remove order.
10. `voidShipper` + the §5.5 order edit invariants + the shipment-scoped cert cascade.
11. Routes (shipments, certs, hub sections, signature) + the widened `/api/documents/[docId]` gate +
    the 401/403 sweep.
12. Signature upload (service + Admin → Users).
13. Shipping list page.
14. Shipment page (header + one panel per order, three grids each).
15. Certifications worklist page.
16. Cert detail page (requirement and readings grids).
17. Order hub Certifications + Shipments sections; order entry, part, customer and container fields
    (`customerJobNo`, `customerContainerId`, cert columns).
18. Shipping ticket layout + its per-order/whole-set print mechanics.
19. BOL layout + lazy `bolNumber` allocation; cert layout + the cert-with-shipment checkbox.
20. E2E flows + demo walkthrough + docs (HANDOFF §4a/§9, `CLAUDE.md`).

## 15. Non-goals

- **No email**, of any kind (§3.2). Issue #4's visible-skip obligation travels with email whenever it
  is built; it is deferred, not cancelled.
- **No reversing shipments and no `REOPENED`** (§3.8) — Phase 5, with invoices to reverse against.
- **No Print/Change** (§3.15) — amends spec §7.4.
- **No MOS shipper layout** (§3.20) — the BOL is the multi-order document; spec §8's eight document
  types become seven in practice.
- No invoicing, pricing resolution, surcharges, cert charges, or "bill for cert" anything (Phase 5) —
  and **no dangling columns for them** (the 2C-2 §2 rule).
- No cert-by-process, no cert formats or per-customer cert text, no per-customer document variants,
  no logo upload UI, no template editing — **Phase 7 owns templates**; this phase ships built-in
  default definitions plus two standing-text settings (§3.21).
- No credit-limit or past-due gates (no A/R balance until Phase 5); no shipping hold on an order; no
  "available to ship" gating of any kind (spec §3 — the shop ships when work is physically done).
- No kanban shipping, no shipping labels, no pickup/signature-pad capture, no available-to-ship
  notifications (spec §3 confirmed-unused list). The ticket's `Received By / Date` strip is **printed
  blank for a pen** — it captures nothing.
- No shop-floor tracking, no final-inspection gate, no Quick Track equivalent (spec §3, permanent).
- No per-shipment pricing display; no partial-load shipping machinery (shipping stays decoupled from
  load boundaries, HANDOFF §3).
- Issue #33's decomposition of `orders.ts` is not taken on here unless this phase's diff requires it.

## 16. What Phase 5 inherits from Phase 4

- **`Order.status` reaches `PARTIAL_SHIPPED` and `SHIPPED`**, derived from ship-line-complete.
  `INVOICED` and `REOPENED` are still unreachable and are Phase 5's to make reachable — `REOPENED`
  specifically by the **reversing shipment** deferred in §3.8, which is the negative-quantity
  counterpart to `voidShipper` and should reuse its sorted-claim and status-recompute machinery.
- **`ship-ledger.ts` is the shipped-quantity source of truth** — invoice-from-shipments reads it
  rather than re-deriving totals. `ShipperOrder` is the natural grouping unit for spec §7.6's
  per-shipper / per-order / per-PO invoice grouping.
- **`allocateNumber` is proven on three counters** (order, shipper, BOL) with issue #34's guard;
  `invoice_number_next` is the fourth and needs no new pattern. Note `cert_number_next` is
  deliberately unused (§3.19).
- **`StoredDocument` is the one document table** with a kind-to-owner `CHECK`; invoices, credits and
  statements widen `DocumentKind` and add their own owner column the same way — the permanence,
  redaction and byte-exact reprint guarantees already exist once, in `documents.ts`.
- **`Shipper.billFreight`/`freightAmount`/`freightTerms`** are captured and unpriced; Phase 5 bills
  them. `OrderCharge.amount = null` still means "needs price" (P3 §3.6).
- **Credit hold's override action and its reason-in-audit shape** are the template for Phase 5's
  invoice unlock and A/R period close.
- **The invoice sample is already in `docs/samples/`** and answers several Phase 5 questions early:
  the invoice number reads `7 − 72026` against `Our Order #: 72026`; it prints `Material` and
  `Process: Austemper` (the same process-name slot the traveler renders blank, P3 §3.9d — it recurs
  here, and Phase 7's designer owns it); it shows a per-line pricing block with `Price per Each` and
  `Minimum Charge` side by side; and it carries a named surcharge line (`EnergySur`).
- **Email is owed** (§3.2) with issue #4's visible-skip ruling attached; whichever phase builds it
  inherits the recipient flags already on `CustomerContact`.
- Cert charges, "bill for cert" and per-customer cert suppression are Visual Shop behaviours this
  phase deliberately does not model; Phase 5 decides whether the shop wants any of them.
