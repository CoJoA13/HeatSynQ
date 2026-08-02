# Phase 2C-2 — Parts core (design)

**Approved by the owner 2026-08-01** (each section approved in session; the three owner rulings
taken during design are recorded in §3). Sub-spec of `2026-07-29-heat-treat-erp-design.md`; does
not amend it. Second of the three branches the owner split Phase 2C into (2C-1 shared foundations,
merged; **2C-2 Parts core, this spec**; 2C-3 Process Steps + Templates). Inputs: the Phase 2
kickoff brief §2.3, `docs/2026-07-30-process-steps-model.md`, and 2C-1's spec §9.

Branch: `phase-2c2-parts`.

---

## 1. Goal

The owner can key (and paste) real memorized parts — identity, material, weights,
specifications, inspection requirements, pricing with breaks, and owner-defined custom fields —
with the same list/detail/export/paste treatment customers have, full audit, and permission
gating including `change_prices` on the pricing block.

2C-2 also closes the two debt items handoff §6 assigns it, **before** the parts services are
written (Approach A, owner-approved): the audit-layer transaction gap, and the writer-side half
of the reference-delete TOCTOU.

**Testable outcome:** an afternoon of real part entry works — paste twenty parts with prices,
open one, add its specs and inspection rows, and every mutation shows in the audit trail with a
meaningful diff; deleting a material one of them uses is refused with "ACME · 12345" linked to
the part.

## 2. Scope

**In:** the six part models and their migration; the two debt closures; parts' four registry
entries and the registry extension they need; parts services, routes, list/detail pages, Excel
export, paste entry; the part-fields admin page; `deleteCustomer`'s "still has parts" guard; the
shared stale-response list hook (adopted by parts and customers); child-route scoping (built
right for parts, retrofitted to customer children).

**Out (2C-3):** process steps, revisions, templates, the steps designer, and anything that reads
`processStepCode` from a part.

**Out (later phases):** orders/loads/travelers (P3); attachments/photos (P3 — one attachment
story built once); credit-hold enforcement (P3/P4); pricing *resolution* and surcharge
application (P5); quote linkage (P6 — no dangling columns); bulk re-point (P8); list pagination
(the system starts empty; recorded, not built).

**Out (backlog, deliberately):** the export→paste round-trip contract (export emits `Active`,
paste doesn't accept it; fixing it needs header-row detection — handoff §6's ruling is "fix both
together or neither," meaning everywhere at once). Parts **inherits the current convention**
rather than forking it: its export carries `Active`, its paste does not, and the backlog item now
covers three entities instead of two.

## 3. Owner decisions, 2026-08-01 (this design session)

1. **Price-break basis follows the part's price-per unit.** A per-lb part's break thresholds are
   pounds; a per-each / per-100 / per-1000 part's are pieces. One basis per part; a break row is
   just `(threshold, price)` and never states its own basis.
2. **Material is optional on a part.** Same freedom GL accounts got on step codes: masters can be
   keyed before the materials list is complete.
3. **Unit prices store 4 decimal places** (`0.0575/lb` is real); setup and minimum charges stay
   2-decimal dollar amounts.
4. **Approach A** — the two debt items are fixed on existing code first, so every parts service
   is written against the corrected patterns and the TOCTOU never widens from four writers to
   eight mid-branch.

## 4. Data model

Six models, one enum, **one hand-written migration** (`migrate diff` + hand-authored SQL — the
TTY constraint, CLAUDE.md "Constraints that will bite you"), applied to both databases. Every
partial `@@unique` stays on **one line** or the partial-unique sweep misses it (handoff §5.11).
No revival-on-create anywhere; a re-used part number is a genuinely new row.

```prisma
enum PricePer { EACH LB PER_100 PER_1000 LOT }
enum PartFieldType { TEXT NUMBER DATE CHECKBOX }

model Part {
  id                    String    @id @default(cuid())
  customerId            String
  customer              Customer  @relation(fields: [customerId], references: [id])
  partNumber            String
  name                  String    @default("")
  description           String    @default("")
  materialId            String?
  material              Material? @relation(fields: [materialId], references: [id])
  eachWeight            Decimal   @db.Decimal(10, 4)   // lbs; required, > 0
  loadQty               Int?                            // ≥ 1 when present
  loadWeight            Decimal?  @db.Decimal(10, 2)   // lbs; > 0 when present
  serializationRequired Boolean   @default(false)
  setupCharge           Decimal?  @db.Decimal(12, 2)
  unitPrice             Decimal?  @db.Decimal(12, 4)
  minimumCharge         Decimal?  @db.Decimal(12, 2)
  pricePer              PricePer  @default(EACH)
  active                Boolean   @default(true)
  deletedAt             DateTime?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
  specifications        PartSpecification[]
  inspections           PartInspection[]
  priceBreaks           PartPriceBreak[]
  fieldValues           PartFieldValue[]

  @@unique([customerId, partNumber], where: raw("\"deletedAt\" IS NULL"))
  @@index([partNumber])
  @@index([customerId])
}
```

- **`customerId` is immutable after create.** Moving a part between customers is the
  cross-customer inference hazard the spec bans (main spec §15 amendments); the real-world flow
  is "losing customer's part deactivated, new part keyed fresh." A part keyed under the wrong
  customer is deleted (with reason) and re-keyed. The service rejects `customerId` in any update
  patch with a field-anchored 400.
- Decimal precisions follow the `decimalField(precision, scale)` discipline from
  `customers.ts` — validator and column declared together, kept in sync by paired comments.
- The relation to `Customer` carries no `onDelete: Cascade` — deletion is soft, and
  `deleteCustomer` refuses while live parts exist (§7).

```prisma
model PartSpecification {
  id              String        @id @default(cuid())
  partId          String
  part            Part          @relation(fields: [partId], references: [id])
  specificationId String
  specification   Specification @relation(fields: [specificationId], references: [id])
  deletedAt       DateTime?
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt

  @@unique([partId, specificationId], where: raw("\"deletedAt\" IS NULL"))
  @@index([specificationId])
}

model PartInspection {
  id               String           @id @default(cuid())
  partId           String
  part             Part             @relation(fields: [partId], references: [id])
  inspectionCodeId String
  inspectionCode   InspectionCode   @relation(fields: [inspectionCodeId], references: [id])
  scaleId          String?
  scale            InspectionScale? @relation(fields: [scaleId], references: [id])
  min              Decimal?         @db.Decimal(10, 4)
  max              Decimal?         @db.Decimal(10, 4)
  location         String           @default("")   // "Brinell @ flange OD"
  sort             Int
  deletedAt        DateTime?
  createdAt        DateTime         @default(now())
  updatedAt        DateTime         @updatedAt

  @@index([partId])
  @@index([inspectionCodeId])
  @@index([scaleId])
}

model PartPriceBreak {
  id        String    @id @default(cuid())
  partId    String
  part      Part      @relation(fields: [partId], references: [id])
  threshold Decimal   @db.Decimal(12, 2)   // in the part's price-per unit (owner ruling §3.1)
  price     Decimal   @db.Decimal(12, 4)
  deletedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  @@unique([partId, threshold], where: raw("\"deletedAt\" IS NULL"))
}

model PartFieldDef {
  id        String        @id @default(cuid())
  name      String
  type      PartFieldType
  sort      Int
  active    Boolean       @default(true)
  deletedAt DateTime?
  createdAt DateTime      @default(now())
  updatedAt DateTime      @updatedAt
  values    PartFieldValue[]

  @@unique([name], where: raw("\"deletedAt\" IS NULL"))
}

model PartFieldValue {
  id        String       @id @default(cuid())
  partId    String
  part      Part         @relation(fields: [partId], references: [id])
  fieldId   String
  field     PartFieldDef @relation(fields: [fieldId], references: [id])
  value     String       @default("")
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt

  @@unique([partId, fieldId])
  @@index([fieldId])
}
```

Model-level decisions, each deliberate:

- **`PartSpecification` has no `active` flag** — a spec link is present or removed; there is
  nothing to hide. Soft-deleted and audited like every child; the partial unique lets a removed
  spec be re-added as a new row.
- **`PartInspection` has no uniqueness on `(partId, inspectionCodeId)`** — the same code
  legitimately appears at two locations ("Brinell @ flange OD" and "@ hub"). Rows order by
  `sort`; certs will print them in that order (P4).
- **`PartPriceBreak` is refused on a LOT-priced part**, in both directions: adding a break to a
  LOT part 400s, and switching `pricePer` to LOT while live breaks exist 400s with "delete the
  price breaks first." Never silently ignored — §7.5's "never silently priced" philosophy applied
  to entry.
- **`PartFieldType` is a new enum, not a rename of `StepFieldType`.** The values are identical,
  but a hand-written enum-rename migration (the TTY constraint means every migration is
  hand-authored) risks a drop-and-recreate against columns in use; four duplicated values are
  cheaper than that risk.
- **`PartFieldValue` rows are never deleted** — no `deletedAt` at all. One row per
  `(part, field)`, created on first set, updated thereafter; clearing writes `""`. The value row
  is an attribute holder, not an entity — this keeps its audit history a clean run of updates
  ("Drawing number: A → B") and needs no partial-unique dance. `value` holds a type-validated
  string: NUMBER as a canonical decimal string, DATE as ISO `yyyy-mm-dd`, CHECKBOX as
  `true`/`false`; TEXT ≤ 2000 chars.
- **Deleting a part soft-deletes its spec links, inspections, and breaks in the same
  transaction** (the `deleteCustomer` addresses/contacts precedent, same audited helpers). This
  also keeps the delete guard honest: a live child row can never point out of a dead part, so
  `findBlockers`' `deletedAt: null` filter on the child is sufficient. Field values are left in
  place — they are unreachable except through their part and are not independently live.
- **Field lengths and the "name" rule** (settling handoff §6's "three sibling services spell
  name three ways" before parts copies one): required identifiers use `.trim().min(1)`
  (`partNumber` ≤ 60, `PartFieldDef.name` ≤ 100); optional display text uses `.max(n)` with no
  minimum, defaulting `""` (`name` ≤ 200, `description` ≤ 4000, `location` ≤ 200). A blank
  optional name never sorts first into a default the way the address backlog item describes,
  because parts have no default-picker.
- Day-one custom fields (customer drawing number, revision level — owner, 2026-07-30) are keyed
  by the owner in the admin UI, **not seeded**. The system starts empty by decision.

## 5. Debt closures — first tasks on the branch (Approach A)

### 5.1 Audit transaction gap: closed by the compiler

The optional `tx` parameter on `auditedCreate` / `auditedUpdate` / `auditedSoftDelete` becomes
**required**. Every call site that today runs its mutation and audit insert as two autocommit
statements stops compiling until it wraps both in one `$transaction`. The compiler enumerates
the ~17 sites; no sweep, nothing to forget, and every parts service is born inside the pattern.
Handoff §6 ("worth closing when 2C adds parts") and issue #9's proper fix.

### 5.2 Reference-TOCTOU, writer side

One shared helper in the service layer:

```ts
assertRefExists(kind: ReferenceKind, id: string, tx: Prisma.TransactionClient): Promise<void>
// findFirst({ where: { id, deletedAt: null } }) on the kind's model, via tx.
// Missing/deleted → HttpError(400) naming the column via REFERENCE_LABELS' nameLabel.
```

Called **inside the same Serializable transaction as the write** by every writer that assigns a
column registered in `reference-links.ts`. `assertNoCycle` is the shape being copied;
`assertTermsExists` (which reads on the bare client before the transaction opens) is retired by
this. The four existing writers convert first — `customer.termsId`,
`processStepCode.glAccountId`, `paymentType.glAccountId`, `inspectionCode.defaultScaleId` — then
parts' writers (`part.materialId`, `partSpecification.specificationId`,
`partInspection.inspectionCodeId`, `partInspection.scaleId`) use it from day one.

**Both sides Serializable is the point.** `deleteReference` already runs its blocker scan and
soft delete in one Serializable transaction (2C-1), but Postgres SSI only aborts when a genuine
read-write cycle forms between serializable transactions. With the writer's target-existence
read and FK write in a Serializable transaction too, the race (assignment committing between
blocker scan and soft delete) becomes a dangerous structure and one side aborts — surfacing as
P2034, which `withDbErrors` already maps to a 409-retry. Serializable is **scoped to writes that
assign a registered FK** (the `updateCustomer` parent-change precedent): everything else on
these rows is last-write-wins scalars with no cross-row invariant.

An inactive target stays assignable — `active: false` hides from pick lists, it does not
invalidate assignment (handoff §5.14's inactive-vs-deleted distinction).

## 6. Registry extension — parts as blockers, one registry

A part's inspection row pointing at an inspection code means the **part** is the blocker the
list must show. Today `findBlockers` hands `displayName` the bare child row (no customer on it)
and builds hrefs from the row's own id. Two optional fields on `ReferenceLink` fix this
generically — no `link.model === …` branches in `findBlockers`, the trap 2C-1's review already
caught once:

```ts
/** Relations the blocker query loads — pure data, client-safe. */
include?: Record<string, unknown>;
/** Which entity this blocker IS. Defaults to the row itself (row.id). A child row that
 *  presents its parent (partInspection → part) returns the parent's id here; href,
 *  detailPath and dedupe all use it. */
blockerId?: (row: Record<string, unknown>) => string;
```

`findBlockers` passes `include` to the query, uses `blockerId ?? row.id` for identity and
`detailPath`, and **dedupes by `(entityLabel, id)`** — a part with three inspection rows on one
code lists once.

The four new entries (the schema-walking sweep fails the build until they exist):

| model | column | targetKind | entityLabel | displayName | blocker |
|---|---|---|---|---|---|
| `part` | `materialId` | `material` | Part | `CODE · partNumber` | the row itself |
| `partSpecification` | `specificationId` | `specification` | Part | `CODE · partNumber` (via included part) | the part |
| `partInspection` | `inspectionCodeId` | `inspectionCode` | Part | same | the part |
| `partInspection` | `scaleId` | `inspectionScale` | Part | same | the part |

All four: `detailPath: (id) => `/parts/${id}``, `include` loading the part (child links) and its
customer's `code`. `displayName` is **required in practice** for all four — a part is
`(customer, partNumber)`, never a bare name (2C-1 spec §9); the label renders as
`ACME · 12345`.

## 7. Services

`src/server/parts.ts` plus one file per child (`part-specifications.ts`, `part-inspections.ts`,
`part-price-breaks.ts`, `part-field-defs.ts`, `part-field-values.ts`) — the customers/addresses/
contacts layout. All mutations through the audited helpers inside transactions (§5.1); all six
models join `AuditableModel`, with `SNAPSHOT_INCLUDE` extended per the customer precedent (the
plan pins exact includes — child rows are audited as their own models, so part snapshots stay
lean; `partSpecification` snapshots include the specification's name so history reads as
"ASTM A536 removed", not a cuid).

- `listParts({ search, includeInactive })` — matches `partNumber`, customer `code`, customer
  `name` (insensitive contains); returns rows with `customerCode`, `customerName`,
  `materialName` resolved (the `parentCode` pattern). Ordered by customer code, then part
  number.
- `getPart(id)` — scalars + resolved names; children fetched by their own services.
- `createPart(input)` — duplicate live `(customerId, partNumber)` → field-anchored 400 via
  `findFirst` (never `findUnique`); customer must exist and be live; material (when given)
  validated in-tx via `assertRefExists`.
- `updatePart(id, patch)` — rejects `customerId` (§4); claims the live row in one statement
  (`claimLiveAndUpdate` precedent); LOT/breaks cross-check (§4) inside the same transaction.
- `deletePart(id, reason)` — reason **required, trimmed, enforced in the service** (handoff
  §5.17: it cascades children and frees `(customer, partNumber)` for reuse). Cascades spec
  links, inspections, and breaks in one transaction with "parent part deleted" reasons.
- `deleteCustomer` gains the "still has parts" refusal (live parts count > 0), mirroring its
  child-customers guard. Discoverability: the parts list filtered by that customer names them
  all; no blocker-list machinery needed for a count the list page already shows.
- `deletePartFieldDef(id)` — **blocked while any live part holds a non-empty value** for the
  def, returning the `Blocker` shape (`Part`, `CODE · partNumber`, href) so the admin page
  reuses the 2C-1 blocker list + Excel export. A def is not a reference kind, so this guard is
  bespoke to the service, but the discoverability rule (§5.14) is the same. Defs with only
  empty values delete freely; ordinary retirement is `active: false`.
- Field values: `setPartFieldValues(partId, values)` upserts one row per def, validating each
  value against the def's type; unknown or deleted def → field-anchored 400.

**Permissions.** Everything parts is `parts.view/create/edit/delete`. Pricing is stricter:
`setupCharge`, `unitPrice`, `minimumCharge`, `pricePer`, and every break mutation require the
CRUD permission **and** `change_prices` — enforced at the route (`mustDo`) by inspecting which
fields the parsed patch carries; break routes demand it unconditionally. Reading prices is not
restricted (main spec §7.5 — pricing "always visible"). Field-def admin is `admin.*`, like every
shop-wide config table.

**Paste** (`pasteParts`). Columns (in `src/lib/part-constants.ts`, client-safe):
`Customer | Part number | Name | Description | Material | Each wt | Load qty | Load wt |
Serialization | Setup | Unit price | Min charge | Price per`. Customer resolves by **code**,
material by **name**, both against live rows, per-row error on unknown values — never a cuid.
`Serialization` accepts Yes/No (the TSV lib's existing boolean convention). A row with any
pricing cell non-empty requires `change_prices`: the route passes `allowPricing` (from `canDo`)
into the service, which reports a per-row error without it. Specs, inspections, and custom
fields are keyed on the detail page, not pasted — the boundary customers drew with
addresses/contacts. Per-row error collection, blank-row skipping, and 1-based line numbers all
follow `pasteCustomers`.

## 8. Routes

All `handle()`-wrapped, authorize → parse → delegate, ctx-typed per Next 15.

| Route | Methods | Gate |
|---|---|---|
| `/api/parts` | GET, POST | `parts.view` / `parts.create` (+ `change_prices` if pricing fields present) |
| `/api/parts/export` | GET | `parts.view` |
| `/api/parts/paste` | POST | `parts.create` (pricing per-row, §7) |
| `/api/parts/[id]` | GET, PATCH, DELETE | `parts.view` / `parts.edit` (+ `change_prices` on pricing fields) / `parts.delete` (reason in body) |
| `/api/parts/[id]/specifications` (+ `[linkId]`) | GET, POST, DELETE | `parts.view` / `parts.edit` |
| `/api/parts/[id]/inspections` (+ `[inspId]`) | GET, POST, PATCH, DELETE | `parts.view` / `parts.edit` |
| `/api/parts/[id]/breaks` (+ `[breakId]`) | GET, POST, PATCH, DELETE | `parts.view` / `parts.edit` + `change_prices` |
| `/api/parts/[id]/fields` | GET, PUT | `parts.view` / `parts.edit` |
| `/api/admin/part-fields` (+ `[id]`, `[id]/blockers`, `[id]/blockers/export`) | CRUD | `admin.*` |

**Every child route verifies the child belongs to the part in the URL** — a child of part X
requested through part Y's URL 404s. This fixes, not copies, the shape defect handoff §6 flags
on customer children ("an address of customer X is editable through customer Y's URL"); the
customer address/contact routes are **retrofitted with the same check** while the pattern is
being established.

Excel export via the existing `toXlsx`; columns: Customer code, Customer name, Part number,
Name, Description, Material, Each wt, Load qty, Load wt, Serialization, Setup, Unit price,
Min charge, Price per, Active. Material exports as its **name**, never a cuid.

## 9. UI

**Parts list** (`/parts`, nav entry goes live). Columns: Customer (`CODE · name`), Part number,
Name, Material, Each wt, Active. Search-as-you-type across part number and customer code/name —
**the customer is visible at every selection point** because a part number alone never
identifies a part (main spec §15). Active-only toggle, Excel export, Add and Paste gated via
`permission-ui` (visible, disabled, "Requires parts.create"). Add follows the customers list's
add pattern with the required trio — customer picker, part number, each-weight — and everything
else keyed on the detail page after create. The list fetch uses the **shared
stale-response hook** (new, e.g. `use-latest.ts`): a response is dropped unless it belongs to
the newest request — and the **customers list adopts the same hook**, closing backlog #5 as the
shared pattern it asked for.

**Part detail** (`/parts/[id]`, remounted per record — `<PartDetail key={id}>`, the 2B lesson).
Sections:

1. **Identity** — customer read-only (`CODE · name`, linked to the customer page); part number
   editable; name, description, material pick-list, each-weight, load qty/wt, serialization
   checkbox, active toggle.
2. **Specifications** — chips with remove; add from the specification pick-list.
3. **Inspection requirements** — grid: code, scale (pre-filled from the code's default scale on
   selection, editable), min, max, location; reorder via sort.
4. **Pricing** — setup/unit/minimum/price-per and the breaks grid; every control gated on
   `change_prices` (disabled + "Requires change_prices" when missing); the LOT/breaks refusal
   surfaces the service's message.
5. **Custom fields** — rendered dynamically from live defs by type (TEXT input, NUMBER input,
   DATE picker, CHECKBOX).
6. **HistoryPanel**, then Delete with reason (gated `parts.delete`).

Pick-lists come from `/api/picklists/*` (`material`, `specification`, `inspectionCode`,
`inspectionScale`) with **no soft `.catch`** — a failed fetch shows an error, never an empty
list. The **customer picker** on part-create fetches `/api/customers` and therefore needs
`customers.view`; a parts-only user sees it disabled with "Requires customers.view" (§5.16
applied), never a silently empty picker. Inactive customers/materials assigned to an existing
part render labelled rather than blank (the Terms-selector precedent).

**Part-fields admin** (`/admin/part-fields`): the reference-grid pattern — add, edit, sort,
active toggle, delete with blocker list + export.

## 10. Testing

TDD per task against `erp_test`. The standing enforcement is the sweeps; the per-feature tests
assert content, not just status codes.

- **Sweeps:** reference-links sweep fails until parts' four entries are registered (proved by
  mutation); partial-unique sweep covers the four new partial uniques (single-line);
  permissions sweep covers every new route — 401 **and** 403 per route. §5.1 needs no sweep:
  the compiler is the enforcement.
- **Uniqueness:** same part number under two customers coexists; duplicate under one customer
  400s; delete-then-rekey yields a new id and fresh history (no revival); rename-collision on
  update 400s against live rows only.
- **Audit content:** creates/updates/deletes for all six models assert real before/after diffs
  (a field-value change shows old → new), not merely that an entry exists.
- **Guards:** part delete without reason 400s; reason is trimmed; cascade soft-deletes children
  in one transaction; `deleteCustomer` with live parts refused; blocked reference deletes name
  the part as `CODE · partNumber` with an href to `/parts/{id}`, **deduped** across multiple
  inspection rows; `detailPath`-less entries unaffected; field-def delete blocked only while
  non-empty values exist, blocker list exports.
- **Writer-side TOCTOU:** assigning a soft-deleted material/specification/code/scale →
  field-anchored 400, on create, update, and paste; the checks run on the write's own `tx`
  (asserted structurally — the functional tests prove dead targets are caught; the Serializable
  pairing is reviewed, not race-tested).
- **Immutability & scoping:** `customerId` in an update patch → 400; child of part X through
  part Y's URL → 404 (and the same test retrofitted for customer addresses/contacts).
- **Pricing:** missing `change_prices` → 403 on pricing fields while plain edits succeed, per-row
  paste errors; LOT/breaks refused both directions; 4-decimal prices round-trip through create,
  list, export, and paste without loss.
- **Paste:** unknown customer code / material name per-row errors; each-weight ≤ 0 rejected;
  one bad row doesn't discard the rest; blank rows skipped; column overflow reported.
- **Pick-list & UI wiring:** parts list and detail render for a user with only `parts.view`;
  disabled controls carry their "Requires …" titles.

## 11. Decisions taken by the planner

- **`PartFieldValue` has no soft delete** and `PartSpecification` has no `active` flag — §4's
  rationale; recorded here so a reviewer doesn't read either as an oversight.
- ~~**`deleteCustomer`'s parts refusal is a count, not a blocker list** — the parts list filtered
  by customer already names every blocker with links; duplicating that into the guard adds
  machinery without adding discoverability.~~ **Amended 2026-08-01 (owner ruling, PR #13
  review):** the refusal now carries a blocker list — the count-only premise (a customer-filtered
  parts list) did not hold, and inactive parts blocked deletion while hidden by default.
- **Breaks are edited only on the detail page** (not in paste, not in export) — child rows
  follow the addresses/contacts boundary everywhere.
- **`threshold` is `Decimal(12,2)`** — piece counts and pound thresholds both fit; 4 decimals
  buys nothing on a threshold.
- **The stale-response hook is client-shared** (`src/lib` or a hooks file next to the pages —
  the plan picks the exact home; it must not import from `src/server/**`).

## 12. What 2C-3 inherits

- The Part model and detail page it attaches Process Steps, revisions, and templates to — the
  detail page's section layout leaves the steps designer a clear slot between custom fields and
  history.
- `assertRefExists` and the required-`tx` audit helpers as the established mutation pattern.
- The registry's `include`/`blockerId` extension, ready for any step-level FK (steps name
  `processStepCode`, which is not a reference kind — 2C-3 decides whether step-code deletion
  protection reuses this registry or the step-code service's own guard, and must not hardcode a
  model branch into `findBlockers` either way).
- The pick-list route already serves `processStepCode` (2C-1 §7.2) for the steps designer.
