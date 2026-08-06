### Task 2: Schema — eight tables, widened StoredDocument, CHECK, sweeps, registry, audit

**Files:**
- Modify: `prisma/schema.prisma`, `tests/partial-unique-sweep.test.ts`, `src/lib/reference-links.ts`, `src/server/audit.ts`
- Create: `prisma/migrations/<timestamp>_certs_and_shipping/migration.sql`
- Test: `tests/certs-schema.test.ts`

**Interfaces:**
- Consumes: `CERT_SCOPES`, `FREIGHT_TERMS` (Task 1) — the Prisma enums must list the same members in the same order.
- Produces: enums `CertScope`, `FreightTerms`, widened `DocumentKind`; models `Cert`, `CertRequirement`, `CertReading`, `Shipper`, `ShipperOrder`, `ShipperLine`, `ShipperContainer`, `ShipperSerial` **exactly as spec §4.1/§4.2** (copy the prisma blocks verbatim); `StoredDocument` per §4.3; the §4.4 columns and back-relations. `AuditableModel` gains `"cert" | "shipper"`.

- [ ] **Step 1: Edit `prisma/schema.prisma`** — spec §4 blocks verbatim, placed after `StoredDocument`. No `onDelete` anywhere new. `Order` gains `certRequired`, `certScope`, `customerJobNo`, plus `certs Cert[]` and `shipperOrders ShipperOrder[]`; `OrderContainer` gains `customerContainerId`; `Part`/`Customer` gain their four cert columns; back-relations on `Customer`, `Carrier`, `CustomerAddress`, `OrderLine`, `OrderContainer`, `OrderSerial`, `InspectionCode`, `InspectionScale`. `StoredDocument.orderId` becomes `String?` and gains `shipperId`/`certId`.
- [ ] **Step 2: Generate the migration** with `/create-migration` (or the TTY-less recipe in Global Constraints). **Read the diff output in full.** Expect: 2 `CREATE TYPE`, 1 `ALTER TYPE … ADD VALUE` ×3 for `DocumentKind`, 8 `CREATE TABLE`, `ALTER TABLE "StoredDocument" ALTER COLUMN "orderId" DROP NOT NULL` + 2 `ADD COLUMN` + 2 FKs, `ALTER TABLE`s for the §4.4 columns, and every index in the spec.
- [ ] **Step 3: Hand-append the `CHECK`** to the same migration file (Prisma cannot express it — the `Part.loadQty` precedent):

```sql
ALTER TABLE "StoredDocument" ADD CONSTRAINT "StoredDocument_kind_owner_check" CHECK (
  (kind = 'TRAVELER' AND "orderId"   IS NOT NULL AND "shipperId" IS NULL     AND "certId" IS NULL) OR
  (kind = 'SHIPPER'  AND "shipperId" IS NOT NULL AND "certId"    IS NULL)                          OR
  (kind = 'BOL'      AND "shipperId" IS NOT NULL AND "orderId"   IS NULL     AND "certId" IS NULL) OR
  (kind = 'CERT'     AND "certId"    IS NOT NULL AND "orderId"   IS NULL     AND "shipperId" IS NULL)
);
```

`ADD VALUE` on an enum cannot run in the same transaction as a statement using the new value in Postgres — if `migrate deploy` errors on that, split `DocumentKind`'s three new values into their own earlier migration directory and keep the `CHECK` in this one.

- [ ] **Step 4: Apply to BOTH databases** and regenerate: `npx prisma migrate deploy`, then the `erp_test` one, then `npx prisma generate`. Confirm `npx prisma migrate status` is clean on both and `npx tsc --noEmit` passes.
- [ ] **Step 5: Sweep exemptions** — extend the documented allowlist in `tests/partial-unique-sweep.test.ts` beside `Order.orderNumber`:
  - `Shipper.shipperNumber` — "a voided shipment keeps its packing-list number forever; allocation-only, never reused or re-entered (§3.19)"
  - `Shipper.bolNumber` — "allocated lazily at first BOL print and never reissued; a voided shipment keeps it (§3.19)"
  - `Shipper.clientRequestId` — "idempotency key; handing it back to a retry would recreate the duplicate it exists to stop (P3 §4)"

  Run the sweep: it passes with the exemptions, and TEMPORARILY removing one fails it (verify, then restore).

- [ ] **Step 6: Registry entries** in `src/lib/reference-links.ts` — add `"shipper"` and `"certRequirement"` to `ReferenceLinkModel`, then:

```ts
{ model: "shipper", column: "carrierId", targetKind: "carrier",
  label: "Carrier", entityLabel: "Shipment", detailPath: (id) => `/shipping/${id}`,
  displayName: (r) => `Packing List ${r.shipperNumber}` },
{ model: "certRequirement", column: "inspectionCodeId", targetKind: "inspectionCode",
  label: "Inspection code", ...CERT_VIA_REQUIREMENT },
{ model: "certRequirement", column: "scaleId", targetKind: "inspectionScale",
  label: "Scale", ...CERT_VIA_REQUIREMENT },
```

with, beside `PART_VIA_CHILD`:

```ts
const CERT_VIA_REQUIREMENT = {
  entityLabel: "Certification",
  detailPath: (id: string) => `/certs/${id}`,
  liveWhere: { cert: { is: { deletedAt: null } } },
  include: { cert: { select: { id: true, order: { select: { orderNumber: true } } } } },
  blockerId: (r: Record<string, unknown>) => String((r.cert as { id: string }).id),
  displayName: (r: Record<string, unknown>) =>
    `Cert · #${((r.cert as { order: { orderNumber: number } }).order).orderNumber}`,
} as const;
```

`Shipper`'s own `liveWhere` is the default `{ deletedAt: null }`. Run `tests/reference-links-sweep.test.ts` — green (it fails on an unregistered FK otherwise).

- [ ] **Step 7: Audit surface** in `src/server/audit.ts` — `AuditableModel` gains `"cert" | "shipper"`; `SNAPSHOT_INCLUDE` gains, **every collection `orderBy`'d** (issue #24):

```ts
cert: {
  requirements: {
    orderBy: { position: "asc" },
    include: {
      inspectionCode: { select: { name: true } },
      scale: { select: { name: true } },
      readings: { orderBy: { position: "asc" } },
    },
  },
},
shipper: {
  orders: {
    orderBy: { position: "asc" },
    include: {
      order: { select: { orderNumber: true } },
      lines: { orderBy: { position: "asc" }, include: { orderLine: { select: { position: true } } } },
      containers: { orderBy: { position: "asc" } },
      serials: { orderBy: { orderSerialId: "asc" } },
    },
  },
},
```

- [ ] **Step 8: Schema smoke test** `tests/certs-schema.test.ts` (model on `tests/orders-schema.test.ts`) — graph round-trip (cert → requirement → reading; shipper → shipperOrder → line/container/serial); `@@unique([orderId, sequence])` rejects a duplicate sequence **even when the first shipment is soft-deleted** (the no-reuse contract); the `CHECK` rejects each illegal kind/owner combination: a `CERT` row with `orderId`, a `BOL` row with `orderId`, a `TRAVELER` row with `shipperId`, and a row with no owner at all — each via `prisma.$executeRaw` so the failure is the constraint, not Prisma's types.
- [ ] **Step 9: Gates + commit** — `feat: cert and shipping schema — eight tables, document ownership check, registry + sweep coverage`

---

