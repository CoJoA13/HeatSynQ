# Task 2 report — Schema: eight tables, widened StoredDocument, CHECK, sweeps, registry, audit

**Branch:** `phase-4-certs-shipping`
**Commit:** `a4e1a08` — `feat: cert and shipping schema — eight tables, document ownership check, registry + sweep coverage`
**Status:** DONE

---

## 1. What I implemented

### Step 1 — `prisma/schema.prisma`

Copied spec §4.1/§4.2/§4.3 blocks verbatim, placed after `StoredDocument`, plus the §4.4 columns
and back-relations. **No `onDelete` declared anywhere new** — every new relation takes Prisma's
default.

**New enums (2):**
- `CertScope { ORDER LOAD SHIPMENT }` — same members, same order as Task 1's `CERT_SCOPES`.
- `FreightTerms { PREPAID COLLECT }` — same members, same order as Task 1's `FREIGHT_TERMS`.
- `DocumentKind` widened `TRAVELER` → `TRAVELER SHIPPER BOL CERT`.

**New models (8):** `Cert`, `CertRequirement`, `CertReading`, `Shipper`, `ShipperOrder`,
`ShipperLine`, `ShipperContainer`, `ShipperSerial`.

**§4.4 changes to existing models:**

| Model | Added |
|---|---|
| `Part` | `certRequired Boolean?`, `certScope CertScope?` |
| `Customer` | `certRequiredDefault Boolean?`, `certScopeDefault CertScope?`, `shippers Shipper[]` |
| `Order` | `certRequired Boolean @default(false)`, `certScope CertScope @default(ORDER)`, `customerJobNo String @default("")`, `certs Cert[]`, `shipperOrders ShipperOrder[]` |
| `OrderContainer` | `customerContainerId String @default("")`, `shipperContainers ShipperContainer[]` |
| `OrderLine` | `shipperLines ShipperLine[]`, `certRequirements CertRequirement[]` |
| `OrderSerial` | `shipperSerials ShipperSerial[]` |
| `Carrier` | `shippers Shipper[]` |
| `CustomerAddress` | `shippers Shipper[]` |
| `InspectionCode` | `certRequirements CertRequirement[]` |
| `InspectionScale` | `certRequirements CertRequirement[]` |
| `StoredDocument` | `orderId` → `String?`; `shipperId`/`shipper`, `certId`/`cert`; `@@index([shipperId])`, `@@index([certId])` |

`npx prisma format` produced **zero changes** against my hand-written blocks, so the alignment
churn in the diff is only prisma's own column re-alignment of models that gained a longer field
name — no partial `@@unique(..., where: raw(...))` line was reflowed (all stay single-line,
HANDOFF §5.11).

Three schema comments carry the rationale a reviewer would otherwise have to re-derive:
`Cert`'s "no unique column, and here is why a partial index cannot express the real rule";
`Cert.loadNumber` is a plain integer, not an FK to `Load`; `ShipperOrder.@@unique([orderId,
sequence])` is bare on purpose.

### Steps 2–4 — Migrations (two directories, forced)

**The split was measured, not assumed.** Probed against this project's own Postgres 18 in a
rolled-back transaction before writing anything:

```
BEGIN
ALTER TYPE
ERROR:  unsafe use of new value "SHIPPER" of enum type "DocumentKind"
HINT:  New enum values must be committed before they can be used.
ROLLBACK
```

So the three `DocumentKind` values went into their own earlier directory and the CHECK (whose
expression names all four values) stayed with the tables.

- `prisma/migrations/20260804122600_document_kind_values/migration.sql`
- `prisma/migrations/20260804122700_certs_and_shipping/migration.sql`

Both files carry headers explaining why they are two files, so a future tidy-up does not merge
them back and break the deploy.

**Applied to both databases, client regenerated** — see §4 for `migrate status` output.

### Step 5 — Sweep exemptions (`tests/partial-unique-sweep.test.ts`)

`ALLOWED` gains `Shipper.shipperNumber`, `Shipper.bolNumber`, `Shipper.clientRequestId`, each with
its own documented rationale beside `Order.orderNumber`'s, plus an explicit note that **`Cert`
deliberately adds nothing** (§3.19) so a later reader does not "fix" the gap.

### Step 6 — Registry (`src/lib/reference-links.ts`)

`ReferenceLinkModel` gains `"shipper" | "certRequirement"`. `CERT_VIA_REQUIREMENT` added beside
`PART_VIA_CHILD`, verbatim from the brief. Three entries added: `shipper.carrierId → carrier`
(Carrier's first consumer since Phase 2A — this is what finally gives it a delete guard),
`certRequirement.inspectionCodeId → inspectionCode`, `certRequirement.scaleId → inspectionScale`.
`Shipper` keeps the default `liveWhere` (`{ deletedAt: null }`) as specified.

### Step 7 — Audit (`src/server/audit.ts`)

`AuditableModel` gains `"cert" | "shipper"`. `SNAPSHOT_INCLUDE.cert` and `.shipper` added verbatim
from the brief — **every collection carries an `orderBy`** (issue #24 from birth). Comments record
why the includes are load-bearing: without them, filling in every reading on a cert would diff as
no change at all.

### Step 8 — `tests/certs-schema.test.ts` (new, 11 tests)

Modelled on `tests/orders-schema.test.ts`. Every CHECK case goes through `prisma.$executeRaw`, as
directed — the generated client's types make the illegal combinations uncompilable, so the point is
proving the *database* refuses them.

---

## 2. Changes beyond the brief (and why)

Three edits the brief did not list. Each is required to keep the build green; none changes
behaviour for existing data.

1. **`tests/reference-links-sweep.test.ts`** — the "finds every known reference FK when nothing is
   registered" test hard-codes the full expected FK list. Three new entries appended in sort order.
   Without this the suite fails; the test is a bite-proof guard on the sweep's own regex, so the
   list has to track the schema.

2. **`src/server/traveler.ts`** — `StoredDocument.orderId` becoming nullable broke `tsc` in two
   places (`DocumentMeta.orderId: string`, and `order` now possibly null in `toMeta`). Fixed with a
   **loud guard**, not a coercion:

   ```ts
   const toMeta = ({ order, ...rest }: DocumentSelected): DocumentMeta => {
     if (rest.orderId === null || order === null) {
       throw new HttpError(404, "That document does not belong to an order");
     }
     return { ...rest, orderId: rest.orderId, orderNumber: order.orderNumber };
   };
   ```

   Both readers there are order-scoped traveler paths and the new CHECK guarantees a `TRAVELER`
   always carries an order, so the branch is unreachable for anything they can legitimately be
   handed. A `!` would have handed the download route an `orderNumber` of `undefined` and named the
   file `traveler-undefined.pdf`. `documents.ts` (spec §8) takes over the widened shape later; the
   comment says so.

3. **`SNAPSHOT_SELECT.storedDocument`** gains `shipperId`/`certId`. Its own doc comment describes
   the list as "every scalar except the bytes column" — leaving the two new owner columns out would
   have made that comment false and quietly dropped ownership from any future snapshot.

---

## 3. TDD evidence

### RED — schema smoke test, before any schema change

```
$ npx vitest run tests/certs-schema.test.ts
...
Unknown argument `customerJobNo`. Available options are marked with ?.
 ❯ fixture tests/certs-schema.test.ts:19:17

 Test Files  1 failed (1)
      Tests  11 failed (11)
```

Expected: `prisma.cert`, `prisma.shipper` and `Order.customerJobNo` do not exist yet, so every test
in the file fails at fixture construction.

### RED — both sweeps, after the schema change and before the registry/allowlist edits

```
$ npx vitest run tests/partial-unique-sweep.test.ts tests/reference-links-sweep.test.ts

AssertionError: These columns are @unique (or a bare @@unique([...]) block) on a
soft-deletable model...
+   "Shipper.shipperNumber",
+   "Shipper.bolNumber",
+   "Shipper.clientRequestId",

AssertionError: These foreign keys point at a reference table but are missing from
REFERENCE_LINKS...
+   "certRequirement.inspectionCodeId -> inspectionCode",
+   "certRequirement.scaleId -> inspectionScale",
+   "shipper.carrierId -> carrier",

 Test Files  2 failed (2)
      Tests  3 failed | 9 passed (12)
```

Expected: three unregistered FKs and three undocumented plain-uniques on a soft-deletable model.
This is exactly the pair of guards the brief relies on.

### GREEN — after the migration, registry, allowlist and audit edits

```
$ npx vitest run tests/certs-schema.test.ts
 ✓ tests/certs-schema.test.ts (11 tests) 649ms
 Test Files  1 passed (1)
      Tests  11 passed (11)

$ npx vitest run tests/partial-unique-sweep.test.ts tests/reference-links-sweep.test.ts tests/certs-schema.test.ts
 ✓ tests/partial-unique-sweep.test.ts (2 tests) 9ms
 ✓ tests/reference-links-sweep.test.ts (10 tests) 5ms
 ✓ tests/certs-schema.test.ts (11 tests) 655ms
 Test Files  3 passed (3)
      Tests  23 passed (23)
```

### Step 5's explicit check — the exemption is load-bearing

Removed `"Shipper.shipperNumber"` from `ALLOWED`, ran the sweep, restored it:

```
--- with Shipper.shipperNumber removed ---
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
      Tests  1 failed | 1 passed (2)
--- restored ---
      Tests  2 passed (2)
```

### Two of my own assertions were wrong, and the test caught them

First GREEN run failed 2/11 on `Decimal.toString()`: Prisma normalizes trailing zeros, so
`"125.00"` comes back `"125"` and `"48.2500"` comes back `"48.25"`. Fixed by comparing numerically
(`Number(...)`) with a comment saying why, rather than coupling the test to a rendering detail.

---

## 4. Migration summary

### Statement counts (both files together)

| Statement | Count |
|---|---|
| `CREATE TYPE` | 2 (`CertScope`, `FreightTerms`) |
| `ALTER TYPE … ADD VALUE` | 3 (`SHIPPER`, `BOL`, `CERT` on `DocumentKind`) |
| `CREATE TABLE` | 8 |
| `ALTER TABLE … ADD COLUMN` | 5 tables (`Customer` ×2, `Order` ×3, `OrderContainer` ×1, `Part` ×2, `StoredDocument` ×2) |
| `ALTER COLUMN … DROP NOT NULL` | 1 (`StoredDocument.orderId`) |
| `DROP CONSTRAINT` | 1 (`StoredDocument_orderId_fkey`, immediately re-added) |
| `CREATE INDEX` / `CREATE UNIQUE INDEX` | 26 |
| `ADD CONSTRAINT … FOREIGN KEY` | 21 |
| `ADD CONSTRAINT … CHECK` | 1 (hand-written) |

Every statement except the CHECK came verbatim from `prisma migrate diff
--from-config-datasource --to-schema=prisma/schema.prisma --script`, read in full before use.

**The one non-additive-looking statement**, and why it is fine:
`ALTER TABLE "StoredDocument" DROP CONSTRAINT "StoredDocument_orderId_fkey"` followed by re-adding
it as `ON DELETE SET NULL` (it was `ON DELETE RESTRICT`). That is purely Prisma's default flipping
because the relation became optional — no `onDelete` is declared in the schema. Nothing in this
application hard-deletes an `Order` (deletion is always soft), so the action never fires; if one
ever did, the new CHECK would refuse to let a stored `TRAVELER` be orphaned, which is the outcome
we want. Recorded in the migration header.

### The CHECK, verbatim as applied

```sql
ALTER TABLE "StoredDocument" ADD CONSTRAINT "StoredDocument_kind_owner_check" CHECK (
  (kind = 'TRAVELER' AND "orderId"   IS NOT NULL AND "shipperId" IS NULL     AND "certId" IS NULL) OR
  (kind = 'SHIPPER'  AND "shipperId" IS NOT NULL AND "certId"    IS NULL)                          OR
  (kind = 'BOL'      AND "shipperId" IS NOT NULL AND "orderId"   IS NULL     AND "certId" IS NULL) OR
  (kind = 'CERT'     AND "certId"    IS NOT NULL AND "orderId"   IS NULL     AND "shipperId" IS NULL)
);
```

As stored by Postgres (read back from `pg_constraint`):

```
CHECK ((((kind = 'TRAVELER'::"DocumentKind") AND ("orderId" IS NOT NULL) AND ("shipperId" IS NULL) AND ("certId" IS NULL))
     OR ((kind = 'SHIPPER'::"DocumentKind")  AND ("shipperId" IS NOT NULL) AND ("certId" IS NULL))
     OR ((kind = 'BOL'::"DocumentKind")      AND ("shipperId" IS NOT NULL) AND ("orderId" IS NULL) AND ("certId" IS NULL))
     OR ((kind = 'CERT'::"DocumentKind")     AND ("certId" IS NOT NULL) AND ("orderId" IS NULL) AND ("shipperId" IS NULL))))
```

The `SHIPPER` clause is deliberately looser than the other three — `orderId` does double duty there
as the sub-scope ("which order's ticket, null = the whole set"), exactly as `loadNumber` already
does for a `TRAVELER`. The migration comment says so explicitly and tells a future reader not to
"tighten" it.

Pre-existing data validated on the way in: 7 `TRAVELER` rows in dev, 0 with a null `orderId`;
0 rows in `erp_test`.

### Dry run before touching the real databases

Both migration files were applied to a throwaway `erp_migcheck` database first, then checked for
drift:

```
$ DATABASE_URL=…/erp_migcheck npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script
-- This is an empty migration.
```

Zero drift — the hand-written SQL reproduces `schema.prisma` exactly. The scratch database was
dropped afterwards. This is what made it safe to apply without risking a `P3009` on `erp_test`.

### `migrate status` — both databases

```
===== dev (erp) =====
Prisma schema loaded from prisma/schema.prisma.
Datasource "db": PostgreSQL database "erp", schema "public" at "localhost:5432"

18 migrations found in prisma/migrations

Database schema is up to date!

===== test (erp_test) =====
Prisma schema loaded from prisma/schema.prisma.
Datasource "db": PostgreSQL database "erp_test", schema "public" at "localhost:5432"

18 migrations found in prisma/migrations

Database schema is up to date!
```

---

## 5. Gates

| Gate | Result |
|---|---|
| `npm test` | **1029 passed**, 77 files, 0 failed (82.2s) |
| `npx tsc --noEmit` | clean, exit 0 |
| `npx eslint src tests` | clean, exit 0 |
| `npm run build` | succeeded |
| `npx prisma migrate status` (dev) | up to date, 18 migrations |
| `npx prisma migrate status` (erp_test) | up to date, 18 migrations |

Test count: 1010 (Phase 3 baseline in CLAUDE.md) + 8 (Task 1) + 11 (this task) = 1029. Consistent —
no pre-existing test was deleted or skipped to get green.

E2E (`npm run test:e2e`) not run: this task adds no route, page or user-visible flow.

---

## 6. Test coverage of this task's own contracts

`tests/certs-schema.test.ts`, 11 tests:

1. **Cert graph round-trip** — cert → requirement (with `inspectionCode` + `scale`) → two readings;
   asserts `Decimal(10,4)` values, `passed`, `overridden`, frozen `min`/`max`/`sampleQty`, and that
   `printedAt` starts null.
2. **`LOAD` scope carries a bare `loadNumber`; `SHIPMENT` scope carries a `shipperId`** — covers the
   spec's deliberate "not an FK to `Load`" decision and the `Shipper.certs` back-relation.
3. **Shipment graph round-trip** — shipper → shipperOrder → line / container / serial, including
   `freightClass` staying text (`"92.5"`), `bolNumber` starting null, and the printed
   `"72036-3"` composed from `orderNumber` and `sequence`.
4. **`@@unique([orderId, sequence])` rejects a duplicate even when the first shipment is voided**,
   and then proves sequence 2 is still free — the no-reuse contract in both directions.
5. **`shipperNumber` / `bolNumber` / `clientRequestId` stay taken after a void** (the three sweep
   exemptions, exercised as behaviour), plus two null-BOL/null-nonce shipments coexisting.
6–11. **The CHECK**, all via `$executeRaw`:
   - accepts all five legal pairings, *including* a `SHIPPER` document scoped to one order and a
     `SHIPPER` document scoped to the whole set — the double-duty `orderId` asserted positively, not
     just described in a comment;
   - rejects `CERT` + orderId, `BOL` + orderId, `TRAVELER` + shipperId, no-owner-at-all (all four
     kinds), `CERT` + shipperId, and `SHIPPER` + certId.

   Each rejection asserts SQLSTATE `23514` specifically, not a bare "it threw" — a `NOT NULL`
   violation would be `23502`, so this distinguishes the CHECK firing from any other refusal. Each
   also asserts nothing was written.

---

## 7. Self-review

**Completeness against spec §4, block by block.** Walked §4.1 (`CertScope`, `Cert`,
`CertRequirement`, `CertReading`), §4.2 (`FreightTerms`, `Shipper`, `ShipperOrder`, `ShipperLine`,
`ShipperContainer`, `ShipperSerial`), §4.3 (`DocumentKind`, `StoredDocument`) and §4.4's table
field by field against the committed schema. Every field, type, `@db` annotation, default,
`@@unique` and `@@index` matches. All nine models named in §4.4 have their back-relations. Enum
member order matches Task 1's `CERT_SCOPES`/`FREIGHT_TERMS` exactly, as the brief's Interfaces
section requires.

**The three things flagged as easy to get wrong.** (1) `ShipperOrder` is present as a real middle
table with all three `@@unique` blocks, and its sequence semantics are asserted by a test, not just
commented. (2) The CHECK's `SHIPPER` clause is deliberately looser and both the migration comment
and a positive test case record that. (3) `Cert` has no unique column and no sweep exemption; a
comment in the schema and another in the sweep say why, so nobody adds one back.

**Naming.** Back-relation names follow the existing conventions (`shippers`, `certRequirements`,
`shipperLines`, `shipperContainers`, `shipperSerials`) — plural, named for the child model, matching
`partInspections` / `orderLines` / `documents`.

**YAGNI.** No column, index, service, route or UI beyond §4. No `onDelete`. No revival-on-create.
No `cert_number_next` wiring (§3.19 says it stays unused). The only three edits outside the brief's
file list are the compile-forced ones in §2 above, each minimal.

**Test quality.** Assertions are behavioural, not existence checks: the voided-shipment cases assert
the *specific* Prisma error code `P2002`, the CHECK cases assert SQLSTATE `23514` and that nothing
was written, and the "no owner" case covers all four kinds rather than one. The double-duty
`orderId` gets a positive test, which is the case most likely to be broken by a well-meaning
"tightening" later. Comments on the non-obvious tests explain the contract, not the code.

**Pristine output.** No warnings, no skipped tests, no `.only`, no stray console output. `git status`
clean after commit. The scratch `erp_migcheck` database was dropped.

**Things I checked and deliberately did not change:**
- `DocumentsSection.tsx`'s `KIND_LABELS` still maps only `TRAVELER`. Correct for now — the order hub
  lists only travelers until the documents union lands; adding labels for kinds nothing can produce
  yet would be dead code.
- `redact()` needs no new patterns: none of the new columns matches password/token/secret/
  signatureImage/fileData, and no new bytes column was added.

---

## 8. Concerns

Two, both small and both forward-looking rather than defects in this task:

1. **`traveler.ts`'s `toMeta` guard is a placeholder by design.** It keeps the order-scoped traveler
   paths type-correct and loud, but `getDocument(docId)` is now reachable in principle with a
   `BOL`/`CERT` id that has no order, and would answer 404. That is the honest answer for an
   order-scoped endpoint, and spec §8 hands the whole surface to `documents.ts` — but whoever picks
   that task should read the comment I left there rather than rediscovering the shape.

2. **The two-directory migration split is load-bearing and easy to "tidy up" wrongly.** Both files
   carry headers with the verbatim Postgres error explaining why, but a future squash of the
   migration history would reintroduce the failure. Worth a line in HANDOFF §5 if the owner keeps a
   migration-gotchas list.

Nothing blocking. Every later Phase 4 task now has real tables, a real client, and both databases
in step.
