# Phase 3 — Orders & Loads (design)

**Status: approved by the owner 2026-08-02 (design session in this document's §3).**
Branch: `phase-3-orders`.

Inputs this design answers to: the roadmap's Phase 3 line, spec §5.1/§5.2/§6/§7.1/§7.2/§12,
HANDOFF §4a (the three 2C-3 review lessons), 2C-2's §2 deferrals (attachments "one story built
once", credit-hold enforcement), 2C-3's §15 inheritances (`lockRevision`, `getRevision`, the
orderability check), and the owner's 2025 order-form mockup
(`docs/samples/2025-aht-orderform-mockup.pdf`, provided 2026-08-02 — the traveler's shape).
Binding context: the approved spec's §3 non-goals and §15 decision log, HANDOFF §5 conventions,
and `CLAUDE.md`.

## 1. Goal

Enter and print real work orders. An order belongs to one customer, carries one or more part
lines (the first line — the **lead part** — owns the process), locks the lead part's process
revision at save, auto-splits into loads from the lead part's per-load caps, and prints a
per-load traveler PDF carrying a scannable barcode. The order board becomes the home page:
saved views, request-date traffic light, search-as-you-type, Excel export. The global search
placeholder goes live. The one-attachment-story lands on parts and orders.

## 2. Scope

IN: eleven new tables (order, line, container, serial, load, charge, order draft, saved
view, stored document, and the two attachment tables that share one implementation) and two
new columns (`Customer.requestDaysOverride`, `Part.requestDaysOverride`); order/draft/saved-view/attachment/search/traveler services and
routes; the order board as home; the order entry page with autosave; the order hub page; the
traveler PDF (pdfmake + bwip-js) with stored-exact-PDF reprints; global search wired; linked
orders; delete-guard extensions (part/customer blocked by live orders); `lockCurrentRevision`
added to the steps service; Playwright E2E flows + owner demo walkthrough.

OUT (§15 lists the full set): everything shipping/certs/invoicing/quoting, scheduling,
tracking, duplication, per-order step edits, pricing display.

## 3. Owner decisions, 2026-08-02 (this design session)

1. **Lead part + rider lines.** An order has 1+ part lines; the first is the lead and its
   revision is the process the order locks and prints. Riders carry part number, qty, weight,
   and serials (billing and certs stay per part number) but bring no recipe — they ran in the
   lead's batch and the paperwork says exactly that. Driven by the shop's sibling-parts case
   (one PO, several part numbers, same material and process, one traveler — e.g. 17-4PH
   H900 smalls; the mockup itself is a two-line sibling order, `35417XXC3`). Nothing
   structural stops riding a part whose own recipe differs — the person keying the order is
   the guard, as in Visual Shop (which allowed multi-part orders only under one shared
   process master; the lead's revision is that constraint translated). Strict one-part and
   full multi-part (every line locks its own revision) were considered and rejected.
2. **Auto-split respects both caps.** When the lead part carries `loadQty` and/or
   `loadWeight`, each load holds as many pieces as fit under BOTH. Mockup-driven refinement:
   multi-line orders split too (the mockup's two-line 4,500-pc order runs at 336/load), so
   the split always runs on **order totals** using the lead part's caps (§5.4 math).
3. **Loads stay editable after a traveler prints, with a warning.** The editor shows
   "traveler already printed — print a fresh one" once any print exists. (Freeze-at-print
   and silent-editable were rejected; every print is stored as its exact PDF regardless,
   so a reprint of a given print always reproduces that file.)
4. **Request-date days are business days (Mon–Fri).** Plant default → per-customer override
   → per-part override, most specific wins, silent (spec §7.1). No holiday calendar.
5. **The traffic light reads the request date.** Owner: request = the customer's ask (drives
   daily urgency); target = internal KPI. Because the request date is always populated at
   entry, this is effectively request-always; target ship stays a plain board column and a
   Phase 8 KPI input. (Visual Shop reads target-only, which renders a mostly-green board
   when targets are rarely set.)
6. **Extra charges are captured in Phase 3.** Description + optional amount — a blank amount
   is a legitimate "needs price" (spec §7.5.3); Phase 5 prices and bills them, and after
   invoicing the invoice owns them (spec §7.1).
7. **Credit hold warns at order entry, never blocks.** A prominent banner; the squeeze
   happens at shipping (Phase 4), Visual Shop's model. (The Phase 2 kickoff's "blocks order
   entry" wording is superseded by this ruling.)
8. **Orders carry an optional `vsOrderNumber`** — the Visual Shop cross-reference for the
   parallel run. Searchable, on the board, on exports. Dies quietly after cutover.
9. **The traveler is built samples-first.** The owner provides current-document samples
   before the traveler task runs; the 2025 mockup (already in `docs/samples/`) fixes the
   shape now (§10), and remaining samples refine the pixel layout. Two open mapping details
   are settled at task time from the samples: the inspection block's **sample-quantity
   column** and the **inspection-location image** (neither exists on `PartInspection` today;
   no columns are added on a hunch).

   **Amended 2026-08-03 (owner ruling closing the Task 16 samples gate).** Three rulings, all
   binding: (a) **the 2025 mockup IS the build target** — no further samples are coming and
   none gate the traveler; build the layout to mirror it. (b) The sample-quantity column maps
   to a new **`PartInspection.sampleQty`, optional free text** (`String @default("")`,
   validated `.max(60)` as display text, never a number — the mockup carries "8" on one
   inspection row and "100%" on the next); it is editable on the part page's inspections grid
   and prints verbatim in the traveler's Key Characteristic Quantity column. (c) **No
   inspection-location images in Phase 3** — the mockup's `{Inspection Location.bmp}` slot
   renders nothing; Phase 4/7 owns image handling. `PartInspection.location` (text) still
   prints.

   **Further amended 2026-08-03 (owner ruling during Task 16 review).** (d) The traveler's
   **`Process:` cell renders BLANK in Phase 3** — Phase 7's template designer owns that slot.
   The mockup prints a process NAME there ("Austemper") and no such field exists on this data
   model; every stand-in considered (the lead part's name, a name assembled from step codes,
   the locked revision "Rev N" — which Task 16 first shipped) was rejected. **Material** and
   **Process ID** are unaffected and still print.

   Recorded observations from the same review, for the owner's demo notes — **no code change**:
   *Process ID* prints the lead part number (`3541719C3`) where the mockup shows a masked
   family number (`35417XXC3`), so a sibling order names its lead rather than the family; and
   the load's weight prints as a small grey sub-line under *Load Quantity*, which is an
   addition to the mockup (real `Load.weight` data with no column of its own there).
10. **PDF stack: pdfmake + bwip-js** (both pure JS). Templates are JSON document definitions
    — the spec §11 "templates are data, not code" architecture and the substrate Phase 7's
    designer will edit. @react-pdf/renderer (templates become React code) and headless
    Chromium (~300 MB browser in the prod image) were rejected.

Also stated and unobjected: **blanket POs need no machinery** — the PO is a plain reusable
text field, prefilled from the customer's default PO, searchable and filterable; a 15-year PO
is the same string on many orders.

## 4. Data model

All tables additive; two column additions to existing models. One hand-written migration
(`migrate diff`, TTY constraint), applied to both databases. Partial `@@unique` lines stay
single-line (sweep limitation, HANDOFF §5.11).

```prisma
enum OrderStatus {
  OPEN
  PARTIAL_SHIPPED   // reserved — Phase 4
  SHIPPED           // reserved — Phase 4
  INVOICED          // reserved — Phase 5
  REOPENED          // reserved — Phase 4 (reversing shipment)
}

model Order {
  id              String    @id @default(cuid())
  orderNumber     Int       @unique
  clientRequestId String?   @unique  // entry form's idempotency nonce (§5.5)
  customerId    String
  customer      Customer    @relation(fields: [customerId], references: [id])
  poNumber      String      @default("")
  vsOrderNumber String      @default("")
  receivedDate  DateTime    @db.Date
  requestDate   DateTime    @db.Date
  targetDate    DateTime?   @db.Date
  status        OrderStatus @default(OPEN)
  notes         String      @default("")
  linkGroupId   String?
  deletedAt     DateTime?   // set = VOIDED (reason required, void_order permission)
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt
  lines         OrderLine[]
  containers    OrderContainer[]
  serials       OrderSerial[]
  loads         Load[]
  charges       OrderCharge[]
  attachments   OrderAttachment[]
  documents     StoredDocument[]

  @@index([customerId])
  @@index([status])
  @@index([receivedDate])
  @@index([requestDate])
  @@index([poNumber])
  @@index([vsOrderNumber])
  @@index([linkGroupId])
}
```

- **`orderNumber` is a plain `@unique` on a soft-deletable model — deliberate, documented,
  sweep-exempted** (the `User.username` precedent, §5.11): a voided order keeps its number
  forever and numbers are never reused or re-entered (allocation-only, §5.2). Reviving or
  reusing an order number is the double-billing adjacency the no-duplication rule exists to
  prevent. `tests/partial-unique-sweep.test.ts` gains the documented exemption.
- **`clientRequestId` is the entry form's idempotency nonce**, and carries the same plain-`@unique`
  sweep exemption for the same reason (fix-wave R4 finding 5). Two tabs can resume ONE autosaved
  draft and both Save; the Serializable loser's 409 is retried automatically, and that retry used
  to allocate the next number and create a SECOND order for one operator action. The nonce is
  minted when a fresh entry form mounts, lives inside the draft payload (so both tabs and the retry
  carry the same one), and `createOrder` answers a collision on it with the order that request
  already created — `{ order, warnings: [], deduped: true }`. Nullable, so historic rows and any
  caller that sends none are unaffected (NULLs never collide in a Postgres unique index); never
  freed by a void, since handing the nonce back to a retry would recreate the duplicate it exists
  to stop.
- **Voided is not an enum value.** Lifecycle status and voidedness are orthogonal:
  `deletedAt` set = voided (displayed as "Voided"), reason lives in the audit entry
  (`auditedSoftDelete`), consistent with soft-delete-everywhere. Phase 3 reaches only
  `OPEN` + voided; the reserved values keep Phases 4–5 from churning the vocabulary.
- Dates are `@db.Date` — day precision is the business reality (received/request/target).

```prisma
model OrderLine {
  id             String  @id @default(cuid())
  orderId        String
  order          Order   @relation(fields: [orderId], references: [id])
  position       Int     // 1 = lead part
  partId         String
  part           Part    @relation(fields: [partId], references: [id])
  revisionNumber Int?    // lead line only: the locked PartProcessRevision number
  qty            Int
  weight         Decimal @db.Decimal(12, 2)
  serials        OrderSerial[]

  @@unique([orderId, position])
  @@index([partId])
}
```

- **Invariant (service-enforced + tested): `revisionNumber` is non-null exactly on
  position 1.** The pair `(lines[0].partId, lines[0].revisionNumber)` is the order's locked
  recipe; `getRevision` renders it (2C-3 §15).
- Every line's part must belong to the order's customer (400 otherwise). qty ≥ 1 integer;
  weight > 0, prefilled `eachWeight × qty`, editable (received weight is reality).
- **Lines, containers, serials, loads, and charges have no `deletedAt`** — editing them is an
  edit to the order (audited as the order's diff via `SNAPSHOT_INCLUDE`), the 2C-3
  steps-under-revision precedent, recorded here so a reviewer doesn't read it as an
  oversight. No `onDelete: Cascade` anywhere (§6 latent-trap note); orders are never
  hard-deleted outside tests and `truncateAll()` handles those.

```prisma
model OrderContainer {
  id          String        @id @default(cuid())
  orderId     String
  order       Order         @relation(fields: [orderId], references: [id])
  position    Int
  typeId      String
  type        ContainerType @relation(fields: [typeId], references: [id])
  count       Int
  qty         Int?
  tareWeight  Decimal?      @db.Decimal(12, 2)
  grossWeight Decimal?      @db.Decimal(12, 2)

  @@unique([orderId, position])
  @@index([typeId])
}

model OrderSerial {
  id          String    @id @default(cuid())
  orderId     String
  order       Order     @relation(fields: [orderId], references: [id])
  lineId      String
  line        OrderLine @relation(fields: [lineId], references: [id])
  position    Int
  serial      String
  description String    @default("")   // heat/lot number, prints on cert (Phase 4)

  @@unique([lineId, serial])
  @@unique([lineId, position])
  @@index([serial])
  @@index([orderId])
}

model Load {
  id         String   @id @default(cuid())
  orderId    String
  order      Order    @relation(fields: [orderId], references: [id])
  loadNumber Int
  qty        Int?
  weight     Decimal? @db.Decimal(12, 2)

  @@unique([orderId, loadNumber])
}

model OrderCharge {
  id          String   @id @default(cuid())
  orderId     String
  order       Order    @relation(fields: [orderId], references: [id])
  position    Int
  description String
  amount      Decimal? @db.Decimal(12, 2)  // null = "needs price" (spec §7.5.3); Phase 5 bills

  @@unique([orderId, position])
}
```

- Container `net` is **derived (gross − tare), never stored**; the traveler prints row
  values and totals. `typeId` is a registered FK (§7).
- Serials: `@@unique([lineId, serial])` catches an honest double-expansion; `@@index([serial])`
  serves global search (spec §6 searches serials).

```prisma
model PartAttachment {
  id         String    @id @default(cuid())
  partId     String
  part       Part      @relation(fields: [partId], references: [id])
  filename   String
  mimeType   String
  size       Int
  fileData   Bytes
  active     Boolean   @default(true)
  deletedAt  DateTime?
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt

  @@index([partId])
}

model OrderAttachment { /* identical shape, orderId → Order */ }
```

- **The one attachment story** (2C-2 §2 deferral): two tables for real FK integrity, ONE
  shared service implementation and ONE shared UI section (the `reference.ts`
  many-kinds-one-service pattern). Files live in Postgres (backups already cover them),
  20 MB cap, MIME allowlist (images / PDF / office documents — no executables), served with
  correct content type + `Content-Disposition`. **`fileData` joins the audit redaction
  keys** — a snapshot must never embed file bytes into `AuditLog` (the `signatureImage`
  precedent). Attachments ARE soft-deletable (user-managed records, not composition edits).

```prisma
model OrderDraft {
  id        String   @id @default(cuid())
  userId    String   @unique
  user      User     @relation(fields: [userId], references: [id])
  payload   Json?
  updatedAt DateTime @updatedAt
}
```

- One row per user; `payload` holds **only what the user typed** (the 2C-3 draft lesson —
  server state is composed at render, staleness unrepresentable). Cleared (`payload: null`)
  on successful save or explicit discard — an update, not a delete.
- **Deliberately unaudited — the documented exception** (the spec-level flag HANDOFF §5.3
  demands): drafts are pre-entity scratch; the real order save is the audited event;
  auditing a 2-second autosave cadence would flood the log with junk. The draft service is
  the only mutation path in the phase that bypasses `audited*`, and this paragraph is its
  authorization. It never contains another user's data and is readable/writable only by its
  own user.

```prisma
model SavedView {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id])
  name      String
  config    Json      // columns (order/visibility), filters, sort
  isDefault Boolean   @default(false)
  deletedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  @@unique([userId, name], where: raw("\"deletedAt\" IS NULL"))
}

enum DocumentKind {
  TRAVELER   // Phase 4+ widens (SHIPPER, CERT, …) or adds sibling tables — its call
}

model StoredDocument {
  id         String       @id @default(cuid())
  orderId    String
  order      Order        @relation(fields: [orderId], references: [id])
  kind       DocumentKind
  loadNumber Int?         // null = full set (one sheet-set per load in one PDF)
  fileData   Bytes
  createdAt  DateTime     @default(now())

  @@index([orderId])
}
```

- SavedViews are per-user, audited normally (deliberate acts), partial-unique on live name.
- StoredDocuments are **permanent — no delete path at all** (spec §8: reprint = same file);
  `fileData` redacted from snapshots. Create-only audit.

**Existing models:** `Customer.requestDaysOverride Int?` and `Part.requestDaysOverride Int?`
(+ both detail pages gain the field — the sibling-pair habit, one commit). `Part`,
`Customer`, `ContainerType`, `User` gain the back-relations shown above.

**Text rules (2C-2 §4 convention):** `poNumber`, `vsOrderNumber`, `serial`,
`charge.description`, `filename` are `.trim()`-validated identifiers where required
(`serial`, `description` of a charge: `.min(1)`); notes/descriptions are `.max(n)` display
text defaulting `""`. Money/weights: `Decimal(12, 2)`; qty: integers.

**No new settings.** `order_number_next`, `request_days_default`,
`traffic_may_miss_days`, `traffic_will_miss_days` already exist (Phase 1).

## 5. The order save — rules and concurrency contract

All inside one `withDbErrors` → `$transaction` (Serializable — required by the registered-FK
writer pattern for `containers[].typeId`; **Serializable is NOT what protects the revision
lock**, see 5.3):

1. **Validate**: customer live + active; each line's part live + active + belongs to the
   customer; line shapes per §4. Inactive customer/part → field-anchored 400 (inactive means
   "don't use going forward"; existing orders keep displaying them).
2. **Allocate the order number**: `allocateNumber("order_number_next", tx)` (new helper in
   `settings.ts`) upserts the setting row if absent, claims it `SELECT … FOR UPDATE`, reads,
   increments. Two concurrent saves cannot share a number. Allocation writes **no audit
   entry** (documented: the order's own create entry records the number; owner edits to the
   seed still flow through the audited settings page). The helper is generic — Phase 4+
   reuses it for shipper/cert/invoice numbering.
3. **Lock the recipe**: `lockCurrentRevision(partId, tx)` — added to
   `part-process-steps.ts`, reusing `workingRevision`'s claim: `SELECT … FOR UPDATE` on the
   part's highest revision, verify **≥ 1 step** (the 2C-3 §15 orderability check — 400
   "This part has no process steps" otherwise; a part with no revision at all gets the same
   400), then set `lockedAt` via the existing idempotent `updateMany` shape, returning
   `revisionNumber` for the lead line. **The row lock is the guarantee** (HANDOFF §4a): a
   step edit racing the save either commits first (we lock what it wrote) or blocks on the
   row and then cuts N+1. The order transaction's isolation level is irrelevant to this
   property and must never be presented as protecting it.
4. **Auto-split loads** on order totals with the lead part's caps:
   `perLoadQty = min(loadQty ?? ∞, loadWeight ? max(1, floor(loadWeight ÷ (Σweight/Σqty))) : ∞)`
   — the weight cap converts through the order's average each-weight (exact for uniform
   siblings; `max(1, …)` keeps a single piece heavier than the cap legal at one per load).
   Neither cap set → one load carrying the totals. Loads get qty chunks (last takes the
   remainder: 1,000 @ 300 → 300/300/300/100) and proportional weights rounded to 2 dp, last
   load absorbing the rounding so sums are exact.
5. **Write** order + children via the audited helpers (`assertRefExists("containerType",
   typeId, tx)` per container row), **clear the caller's draft in the same transaction**,
   and return the order plus non-blocking `warnings[]`: serialization-required lines with
   zero serials (the issue-#4-style visible-skip shape: named per line), and the customer
   credit-hold notice.

**5a. Edits after save** (service-enforced: only while not voided; Phase 4 adds
status-based tightening when statuses beyond OPEN become reachable): PO, VS #, dates, notes,
riders (add/edit/remove — positions close gaps, the steps precedent), containers, serials,
charges, loads. **Customer and lead part/revision are immutable** — wrong-part orders are
voided and re-keyed (that is what void-with-reason is for; it keeps no-duplication airtight).
Editing qty/weight returns a warning when loads no longer sum (warn, never block) and the
loads editor offers an explicit **Re-split** action (re-runs 5.4). All edits are order-level
audited updates with meaningful diffs.

**5b. Loads editor**: edit qty/weight per load, add/remove, renumber (the 2C-2 two-phase
negative-park pattern against `@@unique([orderId, loadNumber])`). Two warnings, both
non-blocking: sums don't match the order, and "a traveler has already printed — print a
fresh one" (derived from `StoredDocument` existence, not a stored flag).

**5c. Void**: `mustDo(user, "void_order")` + reason **required and trimmed in the service**
(§5.17 classification: voiding carries the order's lines/loads/serials away from every list
and frees nothing — the number is never reused; the reason is the point). `auditedSoftDelete`;
voided orders leave the board (toggle to see them), render read-only, block nothing.
**New traveler prints are refused on a voided order** (dead paper); already-stored prints
remain listable and reprintable — the record of what was actually produced never closes.

**5d. Linked orders**: `linkOrder(id, otherId)` — same customer enforced; joins the target's
existing group or mints a `linkGroupId` for both. `unlinkOrder(id)` clears it, cascading to the
last remaining member's own `linkGroupId` too when that would drop the group to size one
(corrected 2026-08-03, code review PR #39: a group of one is NOT harmless — it still reads
"linked" on the board while its own linkedOrders panel comes back empty). Reference-only in
Phase 3.

**Amended 2026-08-02 (owner ruling during Task 5 review):** linking unions groups — a groupless
side joins the other's existing group, two distinct groups merge whole into one (onto the
SOURCE order's surviving groupId), and same-group re-links 400. No order is ever silently
detached by linking; only unlinkOrder removes membership.

**5e. Delete-guard extensions** (§5.14 shape, service-level like `deleteCustomer`'s
parts scan — parts/customers are not registry targets): `deletePart` refuses while live
(non-voided) orders reference the part through any line, naming them
(`#1042 · ACME`, linked to the hub); `deleteCustomer` refuses on live orders likewise.
Both return the BlockerPanel shape with Excel export. Voided orders never block.

## 6. Request dates and the traffic light

- `src/lib/business-days.ts`: `addBusinessDays(date, n)` — Mon–Fri, no holiday calendar
  (owner ruling §3.4). Client-safe (the entry page previews with it; the service computes
  authoritatively).
- Default chain (spec §7.1, most specific wins, silent):
  `part.requestDaysOverride ?? customer.requestDaysOverride ?? request_days_default`,
  applied to `receivedDate`. Prefill only — the user can type over it; the client keeps
  only what the user typed and re-derives until they do.
- Entry prefill comes from `GET /api/orders/entry-defaults?customerId&partId` (gated
  `orders.view`) returning the computed `requestDate` — settings stay unexposed.
- **Traffic light** (board, computed server-side onto each row): evaluated
  most-urgent-first against the **request date** — Did Miss (request < today) → Will Miss
  (within `traffic_will_miss_days`) → May Miss (within `traffic_may_miss_days`) → On
  Target. Rendered as color + text, never color alone. Target ship is a plain column.

## 7. Registry, sweeps, and audit surface

- **Registry**: `{ model: "orderContainer", column: "typeId", targetKind: "containerType",
  liveWhere: { order: { is: { deletedAt: null } } }, blockerId → order, displayName
  "#1042 · ACME", detailPath /orders/[id] }`. The links sweep enforces it automatically;
  `deleteReference("containerType")` now refuses while live orders hold containers of that
  type, with the standard blocker list.
- **Sweep exemption**: `Order.orderNumber` plain-unique rationale added to
  `tests/partial-unique-sweep.test.ts` beside `User.username`.
- **AuditableModel** += `order`, `partAttachment`, `orderAttachment`, `savedView`,
  `storedDocument`. `SNAPSHOT_INCLUDE.order` pulls lines (with part selects), containers
  (with type selects), serials, loads, charges — **every collection `orderBy`'d** (the
  issue-#24 lesson applied from birth). Attachment/document snapshots carry metadata with
  `fileData` redacted. Tests assert audit **content** (real diffs), not just entry
  existence.

## 8. Services

- `src/server/orders.ts` — `createOrder`, `getOrder`, `listOrders` (board query: filters
  status/customer/date-ranges/include-voided, search, sort, traffic light computed),
  `updateOrder`, `voidOrder`, `linkOrder`/`unlinkOrder`, line/container/serial/charge
  operations, `exportOrders`. (The planner may split children into a sibling module if the
  file grows past taste; the transaction shapes stay as §5.)
- `src/server/order-loads.ts` — `replaceLoads` (bulk edit + renumber), `resplitLoads`.
- `src/server/order-drafts.ts` — `getDraft`, `putDraft`, `clearDraft` (the documented
  unaudited exception, §4).
- `src/server/saved-views.ts` — CRUD, own-rows-only, one default per user (normalizer).
- `src/server/attachments.ts` — one implementation, two owners (`part` | `order`):
  list/get/upload/softDelete; owner-liveness checked; caps + allowlist enforced here.
- `src/server/search.ts` — grouped global search (orders by number/PO/VS#/serial, parts,
  customers), permission-filtered per group, exact-order-number short-circuit.
- `src/server/traveler.ts` + `src/server/pdf/` — §10.
- `part-process-steps.ts` gains `lockCurrentRevision(partId, tx)` (§5.3) — same file as
  `workingRevision`/`lockRevision` so the claim SQL exists once.
- `settings.ts` gains `allocateNumber(key, tx)` (§5.2).
- `src/lib/serial-range.ts` — `{001-025}` expansion: first number controls zero-padding
  (`EC{001-25}` ≡ `EC{001-025}`, Visual Shop's rule), reversed/empty ranges rejected,
  expansion cap 10,000 rows; client-safe, used by the entry page.

## 9. Routes

Authorize → parse → delegate, ctx always passed. Area: `orders`.

| Route | Method | Gate |
|---|---|---|
| `/api/orders` | GET | `orders.view` (board query) |
| `/api/orders` | POST | `orders.create` |
| `/api/orders/export` | GET | `orders.view` |
| `/api/orders/[id]` | GET | `orders.view` |
| `/api/orders/[id]` | PATCH | `orders.edit` |
| `/api/orders/[id]` | DELETE (reason in body) | `mustDo("void_order")` |
| `/api/orders/[id]/lines` + `[lineId]` | POST / PATCH / DELETE | `orders.edit` |
| `/api/orders/[id]/containers`, `/serials`, `/charges` (+ children) | PUT (replace) | `orders.edit` |
| `/api/orders/[id]/loads` | PUT (replace), POST `/resplit` | `orders.edit` |
| `/api/orders/[id]/link`, `/unlink` | POST | `orders.edit` |
| `/api/orders/[id]/traveler` (`?load=N`) | POST | `orders.view` (see below) |
| `/api/orders/[id]/documents`, `/api/documents/[id]` | GET | `orders.view` |
| `/api/orders/[id]/attachments` (+ `[attId]`) | GET / POST / DELETE | `orders.view` / `orders.edit` / `orders.edit` |
| `/api/parts/[id]/attachments` (+ `[attId]`) | GET / POST / DELETE | `parts.view` / `parts.edit` / `parts.edit` |
| `/api/orders/entry-defaults` | GET | `orders.view` |
| `/api/order-drafts` | GET / PUT / DELETE | session (own row only) |
| `/api/saved-views` (+ `[id]`) | GET / POST / PATCH / DELETE | `orders.view` (own rows only) |
| `/api/search` | GET | `requireUser`; result groups filtered by the caller's `*.view` |

**Printing gates on `orders.view`, deliberately:** printing changes nothing about the order —
it archives its own output as an audited `StoredDocument` create (who printed, when). It is
an explicit POST, not a read side-effect, so spec §12's "reads never mutate" is intact.
Existing `customers`/`parts` PATCH routes accept `requestDaysOverride`.

## 10. The traveler (pdfmake + bwip-js)

`src/server/pdf/` holds the pdfmake plumbing (fonts: pdfmake's bundled Roboto vfs is the
Phase 3 default); `traveler.ts` builds the **document definition — plain JSON data** — from
one order + one load. This definition is the first instance of the template-as-data contract
Phase 7's designer will edit and version; Phase 3 ships it as the built-in default template,
code-reviewed but not yet owner-editable.

Shape per the mockup (`docs/samples/2025-aht-orderform-mockup.pdf`):

- **Header**: customer name + received-from address (left), company block from settings —
  name/address/phone; a logo image is embedded if the owner drops one in with the samples
  (proper logo upload is Phase 7) — and **Order Number + Load N + Code 128 barcode** (right).
  The barcode encodes the bare order number; scanning it into global search opens the order
  (§9 exact-match short-circuit).
- **Part lines table**: per line qty / part number / name / description / part weight
  (each-weight) / line weight. **Order Quantity** (Σ), **Load Quantity** (this load's qty),
  **containers** (type, count, qty, tare; gross where present; totals printed, net derived).
- **Process / Material** line (lead part's material; process identity is the lead part +
  locked revision).
- **Key Characteristic Inspections**: the lead part's `PartInspection` rows (code, scale,
  min, max, location text). The mockup's sample-quantity column and location image are §3.9
  open items — settled from samples at task time.
- **Process steps** from `getRevision(leadPartId, lockedRevisionNumber)`: position, code,
  instruction, typed field values with units in a fixed order — with **EQ# / OP / Date
  handwriting boxes per step** (paper capture; there is no shop-floor tracking, by decision).
- **Footer blocks**: RESULTS / TEMPERED RESULTS / FINAL INSPECTION PASS-FAIL / Tested
  By-Date / OK to Ship-Date handwriting areas.

**Print mechanics**: "Print traveler" renders one sheet-set per load into ONE PDF, stored as
a `StoredDocument` (loadNumber null); "Print load N" renders just that load (loadNumber N).
The response streams the PDF; the hub lists every prior print; **reprint streams the stored
bytes exactly** (spec §8). The loads-editor warning (§5b) derives from these rows.

**Sequencing**: the traveler task is ordered last among feature tasks and starts only when
the owner's samples are in `docs/samples/` — if they are missing when the task is reached,
the executor ASKS rather than guessing the layout (prime directive).

## 11. UI

**Order board — the home page** (`/` replaces the Phase 1 welcome; nav "Orders" lands here
too). Columns: order #, customer (`CODE · name`), lead part, PO, qty (Σ), weight (Σ),
received, request, target, **light + status**, loads, linked indicator, VS #. Search-as-you-
type; filters (status multi, customer, received/request ranges, include-voided toggle —
default off); column show/hide + reorder; **saved views** (per-user, named, one default,
applied on load); Excel export; `use-latest` stale-response gate; failed loads report (no
`.catch(() => {})`); no pagination (starts empty — recorded, not built).

**Order entry** (`/orders/new`): the approved spec's §6 tab sequence, adapted — customer →
PO → dates → containers → part lines (lead first) → serials per line → charges → notes →
Save / Save & Print (the process needs no stop: it auto-attaches from the lead part). Prefills per §6 and §5; derived values (weight, request date) recompute until the
user types over them — **the page state is only what the user typed** (2C-3 lesson, §4
draft shape). Standing customer order-notes banner; credit-hold warning banner;
serialization warning live + at save; rider add/remove; the lead's current revision
previewed read-only ("Rev N — locks at save"). Autosave every ~2 s to the draft; on return,
"Draft from HH:MM — Resume / Discard".

**Order hub** (`/orders/[id]`, remounts per id — §5.12): Overview (number, customer link,
PO, VS #, dates, status + light, linked-orders panel, Void with reason prompt), Lines (lead
badged "Rev N · locked"), Process (locked revision read-only via `getRevision`), Containers,
Serials, Loads (editor + §5b warnings + Re-split), Charges, Notes (order notes editable;
customer standing notes displayed), Attachments, Traveler (print buttons + stored-print
list), History (`HistoryPanel entity="order"`). Voided → read-only banner naming the reason.
Cert/shipment/invoice sections do not render until their phases build them.

**Attachments section** — one shared component, mounted on the part page and the order hub.

**Customer + part pages** gain `requestDaysOverride` fields (same commit — sibling habit).

**Global search in the Shell** goes live: debounced grouped dropdown (Orders / Parts /
Customers), permission-filtered; **exact order number (typed or scanned) navigates straight
to the hub**. Permission gating §5.16 throughout: disabled-with-tooltip, never hidden;
fields read-only for view-only users.

## 12. Testing

TDD per task; every route 401/403-tested; suite grows from 585. Dense clusters:

1. **Numbering** — concurrent saves get distinct sequential numbers; allocation survives a
   missing setting row; seed edit via settings still audited.
2. **Split math matrix** — qty-only (1,000@300 → 300/300/300/100), weight-only, both-caps
   (the 780-lb example), heavy-piece clamp (1/load), exact multiples, remainders,
   multi-line totals (the mockup's 4,500@336 → 14 loads), no-caps single load; weight sums
   exact to 2 dp.
3. **Lock integration** — save locks Rev N and stores it on the lead line; a step edit
   after save cuts N+1 and the locked revision stays byte-identical; the 2C-3 race
   regression shape rerun against the real caller (mutator vs order save, both orderings);
   idempotent re-lock when two saves quote the same part.
4. **Orderability** — no revision / zero steps → field-anchored 400; riders exempt.
5. **Dates** — business-day chain (part beats customer beats plant; weekend rollover),
   traffic-light boundaries (each edge, most-urgent-first).
6. **Serial expansion** — padding from first number, `EC{001-25}` equivalence, reversed /
   oversized / nested-brace rejection, per-line dupe 400 naming the serial.
7. **Draft lifecycle** — autosave payload round-trip, cleared inside the save transaction,
   own-row isolation, unaudited (asserted: no audit rows from draft writes).
8. **Guards** — deletePart/deleteCustomer blocked by live orders (list + export), voided
   orders unblock; containerType delete blocked by live order containers via registry;
   sweep exemption for `orderNumber` documented and asserted.
9. **Edit rules** — customer/lead immutable (400), rider ops close positions, qty edit
   returns sum warning, re-split rebuilds, load renumber two-phase, void requires reason +
   permission and never frees the number.
10. **Audit content** — order create snapshot includes ordered children; a line edit
    produces a real order-level diff; attachment snapshots carry no `fileData`.
11. **Traveler** — renders against a locked historical revision unchanged; stored bytes
    identical on reprint; per-load render carries that load's numbers; barcode payload =
    order number.
12. **Search** — each group shape, permission filtering, exact-number short-circuit.

## 13. E2E + demo (the 2C-3 harness, owner deliverable)

Flows (screenshots at named checkpoints; artifacts in `erp/e2e-artifacts/`;
`HEADED=1 npm run test:e2e` to watch): key a two-line sibling order end-to-end (customer →
parts → serials via `{001-005}` → save) → hub shows locked Rev N → print traveler → PDF
exists and lists → board shows the order with the right light → type the exact order number
in global search → lands on the hub → edit a load post-print → warning appears → void with
reason → board hides it until the toggle. Dev-database fixtures cleaned per §5a rules
(exact-key, fixture customer, localhost-gated). Final task: the owner demo walkthrough doc
(2C-2/2C-3 precedent) presented before merge.

## 14. Task shape (planner refines)

Foundations first, traveler last (samples gate), the 2C precedent throughout — fresh
subagent per task, independent review per task, fix rounds, final whole-branch review:
(1) schema migration (both DBs) + sweep exemption + registry entry; (2) pure utilities with
their test matrices (`serial-range`, `business-days`, split math); (3) `allocateNumber` +
`lockCurrentRevision` (the two shared primitives, on their existing files); (4) orders
service core — the §5 save transaction (the densest test cluster); (5) order children +
edit rules; (6) loads service (replace/renumber/re-split); (7) drafts + saved views;
(8) attachments (service + both UI mounts); (9) search service; (10) routes + 401/403
sweep; (11) board UI (home) + saved views UI; (12) entry UI + autosave; (13) hub UI;
(14) delete-guard extensions + customer/part `requestDaysOverride` fields; (15) traveler
(pdfmake plumbing + document definition + stored prints — **blocked on samples; ASK if
absent**); (16) E2E flows; (17) demo walkthrough + docs (HANDOFF §4a/§9).

## 15. Non-goals

- No shipping, certs, invoicing, pricing resolution, or quoting anything — including **no
  cert-required flag at entry** (the spec's own entry sequence carries none; cert scope
  lands with Phase 4, which owns its columns) and **no quote columns** (P6, "no dangling
  columns" — 2C-2 §2).
- No pricing display at order entry or on the board (P5 owns resolution; parts already
  carry their price fields).
- No scheduling, no shop-floor tracking, no load status machinery, no promise dates, no
  approval/contract-review/hold gates beyond the credit-hold banner, no Sales Order Entry
  staging, no outside processing (§3 non-goals, permanent).
- **No order duplication** (spec §15) and no lead-part swap — void with reason and re-key.
- No per-order step edits (deleted by the 2026-07-30 amendment, not deferred).
- No recipe-match validation between lead and riders (owner-accepted trade-off, §3.1).
- No holiday calendar in business days; no shared/team saved views; no pagination; no logo
  upload UI (Phase 7); no template editing (Phase 7 — the traveler definition is code-owned
  default data this phase).
- No `PartInspection` sample-quantity or location-image columns yet (§3.9 — settled from
  samples at the traveler task).

## 16. What Phase 4 inherits from Phase 3

- **Reserved statuses** (`PARTIAL_SHIPPED`, `SHIPPED`, `REOPENED`) and the §5a edit-rule
  hook ("Phase 4 adds status-based tightening").
- **`allocateNumber`** for shipper/cert numbering; **`StoredDocument`** as the
  stored-exact-PDF pattern (widen `kind` or add sibling tables — its call).
- **The attachment story** (add `ShipperAttachment` etc. as thin clones over the shared
  service).
- **Credit-hold enforcement at shipping** (the blocking half of the §3.7 ruling) and the
  ship-line-complete world; the serialization warning's shipping-side sibling.
- **`linkGroupId`** if "ship together" affordances are wanted (reference-only today).
- The traveler's per-load render as the precedent for shipper/BOL documents; the §3.9
  inspection-block mapping outcome; cert-required columns (deferred here, §15).
