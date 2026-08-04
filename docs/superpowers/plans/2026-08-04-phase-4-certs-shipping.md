# Phase 4 — Certifications & Shipping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cert and ship real orders — certifications at order/load/shipment scope seeded from the part's own inspection requirements, shipments spanning one or many orders with the human ship-line-complete decision driving order status, credit hold as a real gate, and three permanent PDF layouts built to the owner's production samples.

**Architecture:** Eight new tables in two clusters. Certs are `Cert → CertRequirement → CertReading` — requirements frozen from `PartInspection` at seed, readings many-per-requirement, pass/fail computed and overridable **on screen only**. Shipments are `Shipper → ShipperOrder → lines/containers/serials`, where `ShipperOrder` carries the per-order shipment sequence (the `-3` in `72036-3`) and **one shipping ticket is a render of one `ShipperOrder`** — the traveler's per-load mechanic reused. Every shipment mutation claims **every affected order row in sorted id order** (`SELECT … FOR UPDATE`): the row lock is the guarantee at any isolation level, and sorting is what stops two multi-order saves deadlocking. `StoredDocument` widens to one table for all four document kinds behind a database `CHECK`. Spec: `docs/superpowers/specs/2026-08-04-phase-4-certs-shipping-design.md` — **all bare § references below are to it; its prisma blocks are the schema contract.**

**Tech Stack:** Next.js 16 / React 19 client pages against guarded APIs, Prisma 7 (+pg adapter), zod 4, pdfmake (pure JS, `PdfPrinter` Node entry), vitest against real `erp_test`, Playwright (bundled Chromium) E2E.

## Global Constraints

- All commands run from `erp/`. Quality gates after every task: `npm test`, `npx tsc --noEmit`, `npx eslint src tests` (plus `npm run build` before review rounds) — or just `/gates`. Node 26 (`nvm use 26`); `npm ci`'s five skipped-install-scripts warning is expected and must not be "fixed".
- TDD per task: failing test → implement → pass → commit. Conventional commits, **no attribution trailers** (owner instruction; a PreToolUse hook blocks them).
- Every mutation through `auditedCreate`/`auditedUpdate`/`auditedSoftDelete` — `tx` REQUIRED. Canonical nesting: `withDbErrors` → `prisma.$transaction` → `audited*` → writes on `tx`. **This phase adds no new audit exceptions.**
- **Row locks, never isolation levels, guard cross-transaction invariants.** Every shipment/cert mutation calls `claimOrdersInOrder(tx, orderIds)` (Task 7) before reading order state. Transactions run Serializable because they assign registered FKs (`Shipper.carrierId`, `CertRequirement.inspectionCodeId`/`scaleId`) via `assertRefExists(kind, id, tx)` — **that is the FK-writer pattern, NOT what protects the claim.** Never present isolation as the lock.
- Never `findUnique`/`upsert`/`update`/`delete` keyed on a partial-unique column; `findFirst({ where: { …, deletedAt: null } })` instead. Partial `@@unique(...)` attributes stay on ONE line. **`Shipper.shipperNumber`, `Shipper.bolNumber` and `Shipper.clientRequestId` are deliberately plain `@unique` — extend the sweep's documented exemptions (Task 2), do not "fix" them. `Cert` has no unique column at all (§3.19) — do not add one.**
- `npx prisma migrate dev` refuses without a TTY. Use the `/create-migration` skill, or by hand: `npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script`, read the output IN FULL, hand-write `prisma/migrations/<timestamp>_<name>/migration.sql`, then `npx prisma migrate deploy` AND `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy`, then `npx prisma generate`. A PreToolUse hook blocks edits to already-applied migrations.
- Client components never import from `src/server/**`; shared pure code goes in `src/lib/`.
- Route handlers: `handle(async (req, { params }) => …)`; first line `mustCan(requireUser(), area, action)` (or `mustDo` for `void_shipper` / `override_credit_hold` / `manage_users`); `assertRecord(body)` before key checks; DELETE reasons via `reasonFromBody`. Route tests pass ctx: `handler(request, { params: Promise.resolve({ id }) })`.
- Expected failures are `HttpError(400|403|404, message)`, field-anchored. Dates cross the wire as `"yyyy-mm-dd"` strings; use `parseDateOnly`/`formatDateOnly`/`todayDateOnly` from `src/lib/business-days.ts` and store `Date` in `@db.Date` columns.
- Tests share one DB: `truncateAll()` in `beforeEach` (from `tests/helpers/db`), `signInWith(permissions)` from `tests/helpers/auth`. `fileParallelism: false` — do not parallelize. Assert audit **content** (real diffs), not just that entries exist.
- **Never `vi.spyOn` a Prisma model delegate** — `mockRestore()` does not restore it on this client and corrupts the shared singleton for the rest of the run. Save/restore the property by hand.
- **`renderPdf` output is not byte-deterministic across calls.** Compare *stored* bytes on reprint with `Buffer.compare`; compare two *fresh* renders by pinned content only.
- Money/weights `Decimal(12,2)` via `decimalField(12, 2, …)`; readings and min/max `Decimal(10,4)` via `decimalField(10, 4)`; quantities are `z.number().int()`.
- Owner rulings binding this plan (spec §3): print-only, **no email anywhere**; cert required per part with a customer default; all three scopes; one cert per order per scope-instance with a part block per line; seeded requirements with many readings and computed-but-overridable pass/fail that **does not print**; credit hold blocks with `override_credit_hold` + reason; **void only, no reversing shipments, `REOPENED` stays unreachable**; invariant-based edit tightening, never status-based; the printing user's signature; emergent multi-order shipments with one ship-to; a missing cert warns and never blocks; **five orders on a truck print five tickets and one BOL — there is no MOS layout**; no Print/Change.
- Voided = `deletedAt` set (reason required). Voided shipments/certs/orders refuse NEW prints, keep stored prints reprintable forever, and never free a number or a sequence.

---

### Task 1: `allocateNumber` key guard (issue #34) + five new settings

**Files:**
- Modify: `src/server/settings.ts`
- Create: `src/lib/cert-constants.ts`
- Test: `tests/allocate-number.test.ts`, `tests/settings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
```ts
// src/server/settings.ts
export type NumberSettingKey = Extract<SettingKey, `${string}_number_next`>;
export async function allocateNumber(key: NumberSettingKey, tx: Prisma.TransactionClient): Promise<number>;
// new SETTINGS keys: bol_number_next, cert_required_default, cert_scope_default,
//                    cert_statement, shipper_liability_text

// src/lib/cert-constants.ts  (pure constants — safe to import from client components)
export const CERT_SCOPES = ["ORDER", "LOAD", "SHIPMENT"] as const;
export type CertScopeValue = (typeof CERT_SCOPES)[number];
export const CERT_SCOPE_LABELS: Record<CertScopeValue, string>;   // "By order" | "By load" | "By shipment"
export const FREIGHT_TERMS = ["PREPAID", "COLLECT"] as const;
export type FreightTermsValue = (typeof FREIGHT_TERMS)[number];
export const FREIGHT_TERMS_LABELS: Record<FreightTermsValue, string>;  // "Prepaid" | "Collect"
```

- [ ] **Step 1: Write the failing tests** in `tests/allocate-number.test.ts`:

```ts
it("allocates from a new numbering key", async () => {
  const n = await prisma.$transaction((tx) => allocateNumber("bol_number_next", tx));
  expect(n).toBe(1000);
  const again = await prisma.$transaction((tx) => allocateNumber("bol_number_next", tx));
  expect(again).toBe(1001);
});

it("refuses a non-numbering key at runtime", async () => {
  await expect(
    prisma.$transaction((tx) =>
      // @ts-expect-error — NumberSettingKey excludes this; the runtime guard is the backstop
      allocateNumber("company_name", tx)),
  ).rejects.toThrow(/not a numbering key/i);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/allocate-number.test.ts`. Expected: unknown setting `bol_number_next`, and no `@ts-expect-error` needed yet (so that line errors too).
- [ ] **Step 3: Create `src/lib/cert-constants.ts`** exactly as the Produces block above. No server imports.
- [ ] **Step 4: Add the five settings** to `SETTINGS` in `src/server/settings.ts`, importing `CERT_SCOPES` from `@/lib/cert-constants`:

```ts
bol_number_next: { schema: numberSeed, default: 1000, label: "Next bill-of-lading number", group: "Numbering" },
cert_required_default: { schema: z.boolean(), default: false,
  label: "Certification required by default", group: "Certifications" },
cert_scope_default: { schema: z.enum(CERT_SCOPES), default: "ORDER",
  label: "Default certification scope", group: "Certifications" },
cert_statement: { schema: z.string(), default: CERT_STATEMENT_DEFAULT,
  label: "Certification statement", group: "Certifications" },
shipper_liability_text: { schema: z.string(), default: SHIPPER_LIABILITY_DEFAULT,
  label: "Shipping ticket liability text", group: "Shipping" },
```

Transcribe both defaults from the owner's samples (`docs/samples/Certification Sample.pdf`, `Shipping Ticket Sample.pdf`) as module constants directly above `SETTINGS`. **Leave `cert_number_next` in place and unused (§3.19) — add a comment saying so, so nobody wires it up.**

- [ ] **Step 5: Narrow `allocateNumber`'s key type and add the runtime backstop:**

```ts
export type NumberSettingKey = Extract<SettingKey, `${string}_number_next`>;

export async function allocateNumber(key: NumberSettingKey, tx: Prisma.TransactionClient): Promise<number> {
  if (!Object.hasOwn(SETTINGS, key)) throw new HttpError(400, `Unknown setting: ${key}`);
  // The template-literal type above is the real guard; this is the backstop for a caller that
  // reached here through a cast or an `any`. A non-numeric default would make the increment
  // below string-concatenate ("" + 1 → "1") and silently reissue numbers (issue #34).
  if (typeof SETTINGS[key].default !== "number") {
    throw new HttpError(400, `"${key}" is not a numbering key`);
  }
  // …existing body unchanged…
}
```

- [ ] **Step 6: Run the tests** — `npx vitest run tests/allocate-number.test.ts tests/settings.test.ts`. Expected: PASS (the `@ts-expect-error` is now required and satisfied).
- [ ] **Step 7: Extend `tests/settings.test.ts`** — every new key round-trips through `getSetting`/`setSetting`, `cert_scope_default` rejects `"ORDERS"` with a 400, `cert_required_default` rejects `"yes"`.
- [ ] **Step 8: Gates + commit** — `fix(settings): guard allocateNumber to numbering keys; add Phase 4 settings` (closes #34)

---

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

### Task 3: `documents.ts` — one store for four kinds, traveler migrated onto it

**Files:**
- Create: `src/server/documents.ts`
- Modify: `src/server/traveler.ts` (delete its store/list/get; call the new module), `src/app/api/documents/[docId]/route.ts`
- Test: `tests/documents.test.ts`, `tests/traveler.test.ts` (must stay green untouched in behaviour)

**Interfaces:**
- Consumes: Task 2's `StoredDocument`.
- Produces:
```ts
export type DocumentOwner =
  | { kind: "TRAVELER"; orderId: string; loadNumber: number | null }
  | { kind: "SHIPPER"; shipperId: string; orderId: string | null }
  | { kind: "BOL"; shipperId: string }
  | { kind: "CERT"; certId: string };

export type DocumentMeta = {
  id: string; kind: DocumentKind; createdAt: Date;
  orderId: string | null; shipperId: string | null; certId: string | null; loadNumber: number | null;
};

/** Audited create; metadata only in the payload — the bytes never reach the audit layer. */
export async function storeDocument(tx: Prisma.TransactionClient, owner: DocumentOwner, pdf: Buffer): Promise<DocumentMeta>;
/** Every document that pertains to this order, newest first, incl. a multi-order shipment's BOL. */
export async function listDocumentsForOrder(orderId: string): Promise<DocumentMeta[]>;
export async function listDocumentsForShipper(shipperId: string): Promise<DocumentMeta[]>;
export async function listDocumentsForCert(certId: string): Promise<DocumentMeta[]>;
export async function getDocument(docId: string): Promise<DocumentMeta & { fileData: Buffer }>;
export function documentFilename(meta: DocumentMeta, orderNumber?: number, shipperNumber?: number): string;
```

- [ ] **Step 1: Write the failing tests** in `tests/documents.test.ts`:

```ts
it("lists a multi-order shipment's BOL on every order it covers", async () => {
  const { shipper, orderA, orderB } = await twoOrderShipment();
  await prisma.$transaction((tx) => storeDocument(tx, { kind: "BOL", shipperId: shipper.id }, Buffer.from("%PDF-1.4 bol")));
  expect((await listDocumentsForOrder(orderA.id)).map((d) => d.kind)).toEqual(["BOL"]);
  expect((await listDocumentsForOrder(orderB.id)).map((d) => d.kind)).toEqual(["BOL"]);
});

it("stores no bytes in the audit payload", async () => {
  const { order } = await oneOrder();
  await prisma.$transaction((tx) =>
    storeDocument(tx, { kind: "TRAVELER", orderId: order.id, loadNumber: null }, Buffer.from("%PDF-1.4 x")));
  const entry = await prisma.auditLog.findFirst({ where: { entity: "storedDocument" } });
  expect(JSON.stringify(entry)).not.toContain("fileData");
  expect(JSON.stringify(entry)).not.toContain("%PDF");
});

it("returns stored bytes byte-for-byte", async () => {
  const bytes = Buffer.from("%PDF-1.4 exact");
  const { order } = await oneOrder();
  const meta = await prisma.$transaction((tx) =>
    storeDocument(tx, { kind: "TRAVELER", orderId: order.id, loadNumber: 2 }, bytes));
  expect(Buffer.compare((await getDocument(meta.id)).fileData, bytes)).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/documents.test.ts`. Expected: cannot resolve `@/server/documents`.
- [ ] **Step 3: Write `src/server/documents.ts`.** `storeDocument` maps the `DocumentOwner` union onto the four columns, passes metadata (never `fileData`) as the `auditedCreate` payload, and writes `new Uint8Array(pdf)` (Prisma's `Bytes` input is `Uint8Array<ArrayBuffer>`; Node's `Buffer` is `Uint8Array<ArrayBufferLike>`, which it rejects). `listDocumentsForOrder` is the union query:

```ts
where: { OR: [
  { orderId },
  { cert: { orderId } },
  { shipper: { orders: { some: { orderId } } } },
] },
orderBy: [{ createdAt: "desc" }, { id: "desc" }],
select: DOCUMENT_SELECT,   // never fileData
```

- [ ] **Step 4: Migrate `traveler.ts`** — delete its `listDocuments`/`getDocument`/`DocumentMeta` and its inline `auditedCreate("storedDocument", …)`; `printTraveler` now calls `storeDocument(tx, { kind: "TRAVELER", orderId, loadNumber: loadNumber ?? null }, pdf)` **inside the same claim-holding transaction it already has**. Keep `travelerFilename` delegating to `documentFilename`.
- [ ] **Step 5: Widen the document route gate** in `src/app/api/documents/[docId]/route.ts` — read the meta first, then gate on the owning area: `TRAVELER → orders.view`, `SHIPPER`/`BOL` → `shipping.view`, `CERT → certs.view`. Add a route test asserting a `shipping.view`-only session can fetch a SHIPPER document and gets 403 on a CERT one.
- [ ] **Step 6: Close two coverage gaps Task 2's review found** (both cheap, both in the area this task owns):
  - Add the missing `CHECK` rejection case to `tests/certs-schema.test.ts` via `prisma.$executeRaw`: a `SHIPPER` row with `orderId` set but `shipperId` NULL. That is precisely the combination the `SHIPPER` branch's deliberate looseness still has to forbid, and it is the one a future "tightening" would silently allow.
  - Add a smoke test that every `SNAPSHOT_INCLUDE` entry is a valid Prisma include for its model. `SNAPSHOT_INCLUDE` is typed `Record<AuditableModel, object | undefined>` — plain `object` — so a wrong relation name or `orderBy` field compiles and only explodes at the first `audited*` call in a later task. Iterate the map and issue one `findFirst({ include })` per entry; a bad path throws.
- [ ] **Step 7: Run the tests** — `npx vitest run tests/documents.test.ts tests/traveler.test.ts tests/certs-schema.test.ts`. Expected: PASS, with `traveler.test.ts` unchanged (behaviour is identical; only the seam moved).
- [ ] **Step 8: Gates + commit** — `refactor(documents): one stored-document service for all four kinds`

---

### Task 4: Cert resolution chain and the freeze at order save

**Files:**
- Create: `src/server/certs.ts` (resolution only — creation lands in Task 5)
- Modify: `src/server/orders.ts` (`createOrder` freeze; `UPDATE_ORDER` accepts the three new fields), `src/server/parts.ts`, `src/server/customers.ts`
- Test: `tests/cert-resolution.test.ts`

**Interfaces:**
- Consumes: `CertScopeValue` (Task 1); Task 2's columns.
- Produces:
```ts
export type CertResolution = { certRequired: boolean; certScope: CertScopeValue };
/** Per-line requirement OR'd together; scope from the lead line only (§6.1). `partIds[0]` is the lead. */
export async function resolveCertSettings(db: Db, customerId: string, partIds: string[]): Promise<CertResolution>;
```
Order detail gains `certRequired: boolean`, `certScope: CertScopeValue`, `customerJobNo: string`; part and customer detail gain `certRequired: boolean | null`, `certScope: CertScopeValue | null` / `certRequiredDefault`, `certScopeDefault`.

- [ ] **Step 1: Write the failing tests** in `tests/cert-resolution.test.ts`:

```ts
it("lets the part beat the customer beat the plant", async () => {
  await setSetting("cert_required_default", false);
  const c = await makeCustomer({ certRequiredDefault: true });
  const p = await makePart(c.id, { certRequired: false });
  expect((await resolveCertSettings(prisma, c.id, [p.id])).certRequired).toBe(false);
});

it("requires a cert when ANY line requires one", async () => {
  await setSetting("cert_required_default", false);
  const c = await makeCustomer({ certRequiredDefault: null });
  const lead = await makePart(c.id, { certRequired: false });
  const rider = await makePart(c.id, { certRequired: true });
  expect((await resolveCertSettings(prisma, c.id, [lead.id, rider.id])).certRequired).toBe(true);
});

it("takes scope from the lead line when lines disagree", async () => {
  const c = await makeCustomer({ certScopeDefault: "ORDER" });
  const lead = await makePart(c.id, { certScope: "LOAD" });
  const rider = await makePart(c.id, { certScope: "SHIPMENT" });
  expect((await resolveCertSettings(prisma, c.id, [lead.id, rider.id])).certScope).toBe("LOAD");
});

it("freezes the resolution onto the order at save", async () => {
  const { order, part, customer } = await savedOrder({ partCertRequired: true, partCertScope: "SHIPMENT" });
  await prisma.part.update({ where: { id: part.id }, data: { certRequired: false, certScope: "ORDER" } });
  const after = await getOrder(order.id);
  expect(after.certRequired).toBe(true);
  expect(after.certScope).toBe("SHIPMENT");
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/cert-resolution.test.ts`.
- [ ] **Step 3: Write `resolveCertSettings`** in `src/server/certs.ts` exactly as spec §6.1 — one query loading the customer's two defaults and the parts' two columns, `??` chains per §6.1, `partIds[0]` treated as the lead.

  **Corrected 2026-08-04 after this task's own review.** The plant defaults must NOT be read with the bare `getSetting`, which always queries the top-level `prisma` client. `resolveCertSettings` runs inside `createOrder`'s open Serializable transaction, so a top-level read there holds one connection idle while competing for a second — the exact pool-starvation shape `printTraveler` was fixed for in Phase 3 (fix-wave R4 finding 8), and which `createOrder`'s own comment three lines above the call site warns against. **Give `getSetting` an optional `db` parameter defaulting to `prisma`, and route every read `resolveCertSettings` makes — customer, parts and settings alike — through the `db` argument it already receives**, mirroring how `readTravelerData(db, …)` takes its client for every read. The external signature `resolveCertSettings(db, customerId, partIds)` does not change.
- [ ] **Step 4: Freeze at save** — in `createOrder`'s transaction, after line validation and before the write, call `resolveCertSettings(tx, customerId, lines.map(l => l.partId))` and set `certRequired`/`certScope` on the created order. `customerJobNo` comes straight off the input (`.max(60)`, defaults `""`).
- [ ] **Step 5: Accept edits** — add `certRequired: z.boolean().optional()`, `certScope: z.enum(CERT_SCOPES).optional()`, `customerJobNo: z.string().max(60).optional()` to `UPDATE_ORDER`; add `customerContainerId: z.string().max(60).optional()` to the container item schema; add the four cert columns to the part and customer update schemas and their detail projections.
- [ ] **Step 6: Run the tests** — PASS. Also re-run `npx vitest run tests/orders.test.ts tests/parts.test.ts tests/customers.test.ts` — green.
- [ ] **Step 7: Gates + commit** — `feat(certs): resolution chain frozen onto the order at save`

---

### Task 5: `certs.ts` — scope-aware creation, uniqueness under the claim, void

**Files:**
- Modify: `src/server/certs.ts`
- Test: `tests/certs.test.ts`

**Interfaces:**
- Consumes: `resolveCertSettings` (Task 4), `claimOrder` (existing, `orders.ts`).
- Produces:
```ts
export type CertRow = {
  id: string; orderId: string; orderNumber: number; sequence: number | null;
  customerCode: string; customerName: string; scope: CertScopeValue;
  loadNumber: number | null; shipperId: string | null; shipperNumber: number | null;
  printedAt: string | null; deletedAt: string | null;
  readingCount: number; failCount: number;
};
export type CertDetail = CertRow & {
  freeform: string; internalNotes: string; requirements: CertRequirementDetail[];
  poNumber: string; material: string; receivedDate: string;
};
export type CertFilter = { customerId?: string; scope?: CertScopeValue; printed?: boolean; includeVoided?: boolean; search?: string };

export async function createCert(
  input: { orderId: string; scope: CertScopeValue; loadNumber?: number | null; shipperId?: string | null },
  tx?: Prisma.TransactionClient,
): Promise<CertDetail>;
export async function getCert(id: string): Promise<CertDetail>;
export async function listCerts(filter: CertFilter): Promise<CertRow[]>;
export async function exportCerts(filter: CertFilter): Promise<Buffer>;
export async function updateCert(id: string, input: unknown): Promise<CertDetail>;   // freeform, internalNotes
export async function voidCert(id: string, reason: string): Promise<void>;
export async function certsForOrder(orderId: string): Promise<CertRow[]>;

// Declared HERE (certs.ts) and imported by Task 6's cert-results.ts — this task runs first, so
// declaring them the other way round would be a forward reference that does not compile.
export type CertReadingDetail = {
  id: string; position: number; value: number | null;
  passed: boolean | null; overridden: boolean; note: string;
};
export type CertRequirementDetail = {
  id: string; orderLineId: string; linePosition: number; partNumber: string; partName: string;
  position: number; inspectionCodeId: string; inspectionCodeName: string;
  scaleId: string | null; scaleName: string | null;
  min: number | null; max: number | null; sampleQty: string; location: string;
  readings: CertReadingDetail[];
};
```

- [ ] **Step 1: Write the failing tests** in `tests/certs.test.ts`:

```ts
it("refuses a second live cert for the same scope instance", async () => {
  const { order } = await savedOrder();
  await createCert({ orderId: order.id, scope: "ORDER" });
  await expect(createCert({ orderId: order.id, scope: "ORDER" }))
    .rejects.toThrow(/already has a certification/i);
});

it("allows a second cert once the first is voided", async () => {
  const { order } = await savedOrder();
  const first = await createCert({ orderId: order.id, scope: "ORDER" });
  await voidCert(first.id, "keyed against the wrong load");
  await expect(createCert({ orderId: order.id, scope: "ORDER" })).resolves.toBeTruthy();
});

it("scopes by load and by shipment independently", async () => {
  const { order } = await savedOrder();
  await createCert({ orderId: order.id, scope: "LOAD", loadNumber: 1 });
  await createCert({ orderId: order.id, scope: "LOAD", loadNumber: 2 });
  await expect(createCert({ orderId: order.id, scope: "LOAD", loadNumber: 1 }))
    .rejects.toThrow(/already has a certification/i);
});

it("refuses a cert on a voided order", async () => {
  const { order } = await savedOrder();
  await voidOrder(order.id, "customer cancelled");
  await expect(createCert({ orderId: order.id, scope: "ORDER" })).rejects.toThrow(/not found/i);
});

it("requires a reason to void", async () => {
  const { order } = await savedOrder();
  const cert = await createCert({ orderId: order.id, scope: "ORDER" });
  await expect(voidCert(cert.id, "   ")).rejects.toThrow(/reason/i);
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `createCert`.** `withDbErrors` → Serializable `$transaction` (the FK-writer pattern applies once Task 6 seeds requirements) → `claimOrder(tx, orderId)`; 404 if missing or `deletedAt !== null`; then the **service-enforced uniqueness check** (§4.1 — an index cannot express it because Postgres treats NULLs as distinct):

```ts
const clash = await tx.cert.findFirst({
  where: { orderId, scope, loadNumber: loadNumber ?? null, shipperId: shipperId ?? null, deletedAt: null },
  select: { id: true },
});
if (clash) throw new HttpError(400, "This order already has a certification for that scope");
```

Validate the shape per scope: `LOAD` requires `loadNumber` and no `shipperId`, `SHIPMENT` requires `shipperId` and no `loadNumber`, `ORDER` neither — field-anchored 400s. Then `auditedCreate("cert", …, { tx })` and `seedRequirements(tx, certId)` (Task 6; stub it as a no-op import in this task and let Task 6 fill it).
- [ ] **Step 4: Implement `getCert`/`listCerts`/`exportCerts`/`updateCert`/`voidCert`/`certsForOrder`.** `voidCert` mirrors `voidOrder`: reason trimmed and required **in the service**, `auditedSoftDelete`. `listCerts` computes `readingCount`/`failCount` in the query, honours `includeVoided` (default off), and orders newest-first. `exportCerts` reuses `src/server/excel.ts` exactly as `exportOrders` does.
- [ ] **Step 5: Create the ORDER-scope cert at order save (§6.2).** In `createOrder`'s existing transaction, after the order and its children are written and `certRequired`/`certScope` are frozen (Task 4), call `createCert({ orderId, scope: "ORDER" }, tx)` when `certRequired === true && certScope === "ORDER"`. `LOAD` scope creates nothing here (it is on-demand); `SHIPMENT` scope creates nothing here (Task 8 does it). Test:

```ts
it("creates an ORDER-scope cert at order save and nothing for the other scopes", async () => {
  const a = await savedOrder({ certRequired: true, certScope: "ORDER" });
  expect(await prisma.cert.count({ where: { orderId: a.order.id } })).toBe(1);
  const b = await savedOrder({ certRequired: true, certScope: "LOAD" });
  expect(await prisma.cert.count({ where: { orderId: b.order.id } })).toBe(0);
  const c = await savedOrder({ certRequired: false, certScope: "ORDER" });
  expect(await prisma.cert.count({ where: { orderId: c.order.id } })).toBe(0);
});
```

- [ ] **Step 6: Prove a load re-split never touches a cert (§6.2, §12 cluster 10).** This is the reason load-scope is lazy — assert it rather than trusting it:

```ts
it("leaves a load-scope cert with readings untouched when the loads are re-split", async () => {
  const { order } = await savedOrder({ loadQty: 300, qty: 1000 });     // 4 loads
  const cert = await createCert({ orderId: order.id, scope: "LOAD", loadNumber: 3 });
  await replaceReadings(cert.id, oneReading(cert, "30.0"), { afterPrint: false });
  await resplitLoads(order.id);
  const after = await getCert(cert.id);
  expect(after.deletedAt).toBeNull();
  expect(after.requirements[0].readings[0].value).toBe(30);
  expect(after.loadNumber).toBe(3);
});
```

(Depends on Task 6's `replaceReadings`; if this task runs first, assert the cert's survival and `loadNumber` only and add the readings assertion when Task 6 lands.)

- [ ] **Step 7: Run the tests** — PASS. Add an audit-content assertion: voiding writes an entry whose payload carries the reason, and updating `freeform` produces a real before/after diff.
- [ ] **Step 8: Gates + commit** — `feat(certs): scope-aware creation, listing, export and void`

---

### Task 6: `cert-results.ts` — seeding, readings, computed pass/fail with override

**Files:**
- Create: `src/server/cert-results.ts`, `src/lib/pass-fail.ts`
- Test: `tests/cert-results.test.ts`, `tests/pass-fail.test.ts`

**Interfaces:**
- Consumes: Task 5's `createCert` (calls `seedRequirements` inside its transaction).
- Produces:
```ts
// src/lib/pass-fail.ts  (pure, client-safe — the grid shows the same verdict the server computes)
export function computePassed(value: number | null, min: number | null, max: number | null): boolean | null;
// null when value is null; true when value is within whichever bounds are set; false otherwise.
// No bounds set + a value present → true (nothing to fail against).

// src/server/cert-results.ts
export type CertReadingDetail = {
  id: string; position: number; value: number | null;
  passed: boolean | null; overridden: boolean; note: string;
};
export type CertRequirementDetail = {
  id: string; orderLineId: string; linePosition: number; partNumber: string; partName: string;
  position: number; inspectionCodeId: string; inspectionCodeName: string;
  scaleId: string | null; scaleName: string | null;
  min: number | null; max: number | null; sampleQty: string; location: string;
  readings: CertReadingDetail[];
};
/** One requirement per live PartInspection of every order line's part, lines in position order,
 *  inspections in the part's own `sort` order; min/max/sampleQty/location COPIED (frozen). */
export async function seedRequirements(tx: Prisma.TransactionClient, certId: string): Promise<void>;
/** Full replace of one cert's requirements+readings. Refuses after printedAt unless `afterPrint`. */
/** Replaces the READINGS under whichever requirements the payload names. Requirement rows are
 *  never added, removed or re-derived — the frozen copy is the point — and a requirement the
 *  payload does not mention keeps its readings untouched. Renamed from `replaceResults`
 *  2026-08-04 after this task's review: "results" read as "the cert's whole result set", which
 *  would make an omitted requirement a silent data loss. Merge semantics are deliberate — Task
 *  16's grid submits what the user touched, the 2C-3 "keep only what the user typed" lesson. */
export async function replaceReadings(certId: string, input: unknown, opts: { afterPrint: boolean }): Promise<CertDetail>;
```

- [ ] **Step 1: Write the failing pure tests** in `tests/pass-fail.test.ts` — a table covering: no value → `null`; min only (below/at/above); max only; both bounds (below/at-min/inside/at-max/above); neither bound with a value → `true`.
- [ ] **Step 2: Write `src/lib/pass-fail.ts`** and make them pass.
- [ ] **Step 3: Write the failing service tests** in `tests/cert-results.test.ts`:

```ts
it("seeds one requirement per part inspection, in print order", async () => {
  const { order, leadPart, riderPart } = await twoLineOrder();     // lead has 2 inspections, rider 1
  const cert = await createCert({ orderId: order.id, scope: "ORDER" });
  expect(cert.requirements.map((r) => [r.linePosition, r.position]))
    .toEqual([[1, 1], [1, 2], [2, 3]]);
});

it("freezes min/max against a later part edit", async () => {
  const { order, leadPart, inspection } = await oneLineOrder({ min: 28, max: 32 });
  const cert = await createCert({ orderId: order.id, scope: "ORDER" });
  await prisma.partInspection.update({ where: { id: inspection.id }, data: { min: 40, max: 45 } });
  const after = await getCert(cert.id);
  expect([after.requirements[0].min, after.requirements[0].max]).toEqual([28, 32]);
});

it("computes pass/fail per reading and records an override", async () => {
  const { cert } = await seededCert({ min: 28, max: 32 });
  const saved = await replaceReadings(cert.id, {
    requirements: [{ id: cert.requirements[0].id, readings: [
      { value: "30.0" },
      { value: "25.6", passed: true, overridden: true, note: "retest on the flange OD" },
    ] }],
  }, { afterPrint: false });
  const [a, b] = saved.requirements[0].readings;
  expect([a.passed, a.overridden]).toEqual([true, false]);
  expect([b.passed, b.overridden]).toEqual([true, true]);
});

it("refuses a results edit after printing without the special action", async () => {
  const { cert } = await seededCert({});
  await prisma.cert.update({ where: { id: cert.id }, data: { printedAt: new Date() } });
  await expect(replaceReadings(cert.id, { requirements: [] }, { afterPrint: false }))
    .rejects.toThrow(/already been printed/i);
  await expect(replaceReadings(cert.id, { requirements: [] }, { afterPrint: true })).resolves.toBeTruthy();
});
```

- [ ] **Step 4: Run to verify failure.**
- [ ] **Step 5: Implement.** `seedRequirements` loads the cert's order lines with their parts' live `PartInspection` rows (`orderBy: { sort: "asc" }`), writes requirements with a cert-wide running `position`, and calls `assertRefExists("inspectionCode", …, tx)` / `assertRefExists("inspectionScale", …, tx)` per row — which is why the enclosing transaction is Serializable. `replaceReadings` runs `withDbErrors` → Serializable `$transaction` → `auditedUpdate("cert", …)` → delete-and-recreate readings under each requirement (requirements themselves are never re-seeded — the frozen copy is the point), computing `passed` with `computePassed` unless the row sets `overridden: true`, in which case the supplied `passed` is stored verbatim. A requirement id not belonging to this cert is a 400 naming it.
- [ ] **Step 6: Run the tests** — PASS. Add an audit-content assertion: a reading change produces a real cert-level before/after diff carrying both values.
- [ ] **Step 7: Wire Task 5's call** — `createCert` now genuinely calls `seedRequirements`; re-run `tests/certs.test.ts`.
- [ ] **Step 8: Gates + commit** — `feat(certs): seeded requirements, multi-reading results, computed pass/fail`

---

### Task 7: `ship-ledger.ts` — shipped totals, status derivation, shipment sequence, sorted claims

**Files:**
- Create: `src/server/ship-ledger.ts`
- Modify: `src/server/orders.ts` (add `claimOrdersInOrder` beside `claimOrder`; call `recomputeOrderStatus` from `addLine`/`updateLine`/`removeLine`)
- Test: `tests/ship-ledger.test.ts`

**Interfaces:**
- Consumes: Task 2's `ShipperLine`/`ShipperOrder`.
- Produces:
```ts
// src/server/order-locks.ts — a NEW leaf module (see the extraction note below)
/** Moved here from orders.ts, unchanged. */
export async function claimOrder(tx: Db, orderId: string): Promise<Order | null>;
/** Claims every order row FOR UPDATE in ASCENDING ID ORDER. Sorting is what stops two
 *  multi-order saves over {A,B} and {B,A} deadlocking — never claim in caller order. */
export async function claimOrdersInOrder(tx: Db, orderIds: string[]): Promise<Order[]>;

// src/server/ship-ledger.ts
export type ShippedTotal = { qty: number; weight: number };
/** Sum of LIVE shipper lines per order line. A voided shipment contributes nothing. */
export async function shippedTotals(db: Db, orderLineIds: string[]): Promise<Map<string, ShippedTotal>>;
/** OPEN | PARTIAL_SHIPPED | SHIPPED per §5.2. Quantities never influence it. Voided orders untouched. */
export async function recomputeOrderStatus(tx: Prisma.TransactionClient, orderIds: string[]): Promise<void>;
/** max(sequence) + 1 over ALL ShipperOrders for this order, INCLUDING voided shipments. */
export async function nextShipmentSequence(tx: Prisma.TransactionClient, orderId: string): Promise<number>;
```

**Fixtures note — this task runs BEFORE `createShipper` and `voidShipper` exist (Tasks 8 and 10).**
Its fixtures write `Shipper`/`ShipperOrder`/`ShipperLine` rows directly with `prisma.*.create`, and
"void" means `prisma.shipper.update({ data: { deletedAt: new Date() } })`. Do not import from
`shippers.ts` here — the ledger is deliberately independent of the service that will call it.

- [ ] **Step 1: Write the failing tests** in `tests/ship-ledger.test.ts`:

```ts
it("excludes voided shipments from shipped-to-date", async () => {
  const { orderLine, shipperA } = await twoShipmentsOf(300, 200);   // rows written directly
  expect((await shippedTotals(prisma, [orderLine.id])).get(orderLine.id)!.qty).toBe(500);
  await prisma.shipper.update({ where: { id: shipperA.id }, data: { deletedAt: new Date() } });
  expect((await shippedTotals(prisma, [orderLine.id])).get(orderLine.id)!.qty).toBe(200);
});

it("derives status from ship-line-complete, never from quantity", async () => {
  const { order, line } = await oneLineOrder({ qty: 1000 });
  await shipLine(line, { qty: 1000, lineComplete: false });   // full quantity, NOT complete
  expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
  await shipLine(line, { qty: 1, lineComplete: true });       // one piece, complete
  expect((await getOrder(order.id)).status).toBe("SHIPPED");
});

it("returns a SHIPPED order to PARTIAL_SHIPPED when a rider line is added", async () => {
  const { order, line } = await oneLineOrder({});
  await shipLine(line, { qty: 10, lineComplete: true });
  expect((await getOrder(order.id)).status).toBe("SHIPPED");
  await addLine(order.id, { partId: (await makeRider(order)).id, qty: 5, weight: "10.00" });
  expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
});

it("never reissues a shipment sequence after a void", async () => {
  const { order } = await savedOrder();
  await makeShipment(order, 1);
  const second = await makeShipment(order, 2);
  await prisma.shipper.update({ where: { id: second.id }, data: { deletedAt: new Date() } });
  const next = await prisma.$transaction((tx) => nextShipmentSequence(tx, order.id));
  expect(next).toBe(3);        // NOT 2 — the voided shipment's number is already on paper
});

it("claims orders in ascending id order regardless of caller order", async () => {
  const [a, b, c] = (await Promise.all([savedOrder(), savedOrder(), savedOrder()]))
    .map((r) => r.order.id).sort();
  const seen: string[] = [];
  await prisma.$transaction(async (tx) => {
    // Wrap $queryRaw by plain property save/restore — NEVER vi.spyOn a Prisma delegate
    // (Global Constraints: mockRestore does not restore it on this client).
    const original = tx.$queryRaw.bind(tx);
    (tx as { $queryRaw: unknown }).$queryRaw = ((...args: Parameters<typeof original>) => {
      const sql = String(args[0]);
      if (sql.includes("FOR UPDATE")) seen.push(...[a, b, c].filter((id) => args.flat().includes(id)));
      return original(...args);
    }) as typeof original;
    await claimOrdersInOrder(tx, [c, a, b]);
  });
  expect(seen).toEqual([a, b, c]);
});
```

If the single-statement `ORDER BY … FOR UPDATE` form makes per-id observation awkward, assert the
ordering directly instead: export the sort as `sortedClaimIds(ids: string[]): string[]` from
`orders.ts` and unit-test that, plus one integration test proving two concurrent
`claimOrdersInOrder` calls over `{A,B}` and `{B,A}` both complete rather than deadlocking. **The
concurrent test is the one that matters — do not skip it in favour of the unit test alone.**

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3a: Extract the claims into `src/server/order-locks.ts` FIRST — added 2026-08-04 after Task 5's review.** Task 5 created a genuine bidirectional module cycle: `certs.ts` imports `claimOrder` from `orders.ts`, and `orders.ts` imports `resolveCertSettings`/`createCert` from `certs.ts`. It is safe today only because every crossing export is a hoisted `function` declaration, and this task and Task 8 are both about to widen it (`shippers.ts` needs `claimOrdersInOrder` **and** `createCert`, and `orders.ts` needs `shipmentBlockers` back from `shippers.ts` for §5.5). This codebase already has the precedent and the reasoning: Phase 2A extracted `HttpError` into a zero-import `src/server/errors.ts` specifically to break a `settings → http → sessions → settings` cycle, and `tests/errors.test.ts` asserts that file imports nothing.

  Move `claimOrder` verbatim from `orders.ts` into a new leaf `src/server/order-locks.ts` (importing only `db` and Prisma types — nothing from another service), re-point every existing caller (`orders.ts`, `certs.ts`, `attachments.ts`, `order-loads.ts`, `traveler.ts`), and confirm the cycle is gone. **A moved function with no behaviour change needs no new tests** — the existing suites covering each caller are the proof, and they must stay green untouched.

- [ ] **Step 3b: Implement `claimOrdersInOrder`** in `src/server/order-locks.ts` beside it — `[...new Set(orderIds)].sort()`, then one `SELECT "id" FROM "Order" WHERE "id" = ANY($1) ORDER BY "id" FOR UPDATE`, then `findMany`. A single ordered statement is both the sort and the claim.
- [ ] **Step 4: Implement `ship-ledger.ts`** exactly per §5.1/§5.2/§5.3. `recomputeOrderStatus` skips orders with `deletedAt !== null` (voidedness is orthogonal to status) and never writes `INVOICED` or `REOPENED`. `nextShipmentSequence` runs `_max` over `shipperOrder` for the order with **no live filter** — a voided shipment's sequence is already on a customer's paperwork.
- [ ] **Step 5: Hook the order line mutators** — `addLine`, `updateLine` and `removeLine` in `orders.ts` call `recomputeOrderStatus(tx, [orderId])` at the end of their existing transactions.
- [ ] **Step 6: Run the tests** — PASS.
- [ ] **Step 7: Gates + commit** — `feat(shipping): ship ledger, status derivation, shipment sequence, sorted claims`

---

### Task 8: `shippers.ts` — create, with sorted claims, credit hold and idempotency

**Files:**
- Create: `src/server/shippers.ts`
- Modify: `src/lib/permission-constants.ts` (+`override_credit_hold`)
- Test: `tests/shippers.test.ts`, `tests/permissions.test.ts`

**Interfaces:**
- Consumes: `claimOrdersInOrder`, `recomputeOrderStatus`, `nextShipmentSequence` (Task 7); `allocateNumber` (Task 1); `createCert` (Task 5).
- Produces:
```ts
export type ShipperLineDetail = {
  id: string; orderLineId: string; linePosition: number; partNumber: string; partName: string;
  orderedQty: number; orderedWeight: number; shippedToDateQty: number; shippedToDateWeight: number;
  qty: number; weight: number; lineComplete: boolean;
};
export type ShipperOrderDetail = {
  id: string; orderId: string; orderNumber: number; sequence: number; position: number;
  poNumber: string; customerJobNo: string; label: string;            // `${orderNumber}-${sequence}`
  lines: ShipperLineDetail[];
  containers: { id: string; orderContainerId: string; typeName: string; customerContainerId: string; count: number; position: number }[];
  serials: { id: string; orderSerialId: string; serial: string; description: string; printOnShipper: boolean }[];
};
export type ShipperDetail = {
  id: string; shipperNumber: number; bolNumber: number | null;
  customerId: string; customerCode: string; customerName: string;
  shipToAddressId: string | null; shipDate: string;
  carrierId: string | null; carrierName: string | null; route: string; comments: string;
  billFreight: boolean; freightAmount: number | null; freightTerms: FreightTermsValue;
  freightClass: string; freightDescription: string; packageCount: number | null;
  proNumber: string; scacCode: string; deletedAt: string | null;
  orders: ShipperOrderDetail[];
};
export type ShipperCreateResult = { shipper: ShipperDetail; warnings: string[]; deduped: boolean };

export async function createShipper(input: unknown, opts: { canOverrideCreditHold: boolean }): Promise<ShipperCreateResult>;
export async function getShipper(id: string): Promise<ShipperDetail>;
```
Input shape: `{ clientRequestId?, customerId, shipToAddressId?, shipDate, carrierId?, route?, comments?, billFreight?, freightAmount?, freightTerms?, freightClass?, freightDescription?, packageCount?, proNumber?, scacCode?, creditHoldReason?, orders: [{ orderId, lines: [{ orderLineId, qty, weight, lineComplete }], containers: [...], serials: [...] }] }`

- [ ] **Step 1: Add `override_credit_hold`** to `SPECIAL_ACTIONS` in `src/lib/permission-constants.ts` (eleventh entry) and extend `tests/permissions.test.ts`'s action-count assertion.
- [ ] **Step 2: Write the failing tests** in `tests/shippers.test.ts`:

```ts
it("blocks a customer on credit hold and names them", async () => {
  const { order, customer } = await savedOrder({ creditHold: true });
  await expect(createShipper(oneOrderInput(order), { canOverrideCreditHold: false }))
    .rejects.toThrow(new RegExp(`${customer.name}.*credit hold`, "i"));
});

it("allows the override with a reason and records it in the audit entry", async () => {
  const { order } = await savedOrder({ creditHold: true });
  const { shipper } = await createShipper(
    { ...oneOrderInput(order), creditHoldReason: "owner approved, cheque in hand" },
    { canOverrideCreditHold: true });
  const entry = await prisma.auditLog.findFirst({ where: { entity: "shipper", entityId: shipper.id } });
  expect(JSON.stringify(entry)).toContain("cheque in hand");
});

it("refuses the override with a blank reason", async () => {
  const { order } = await savedOrder({ creditHold: true });
  await expect(createShipper({ ...oneOrderInput(order), creditHoldReason: "  " },
    { canOverrideCreditHold: true })).rejects.toThrow(/reason/i);
});

it("returns the first shipment for a repeated clientRequestId", async () => {
  const { order } = await savedOrder();
  const input = { ...oneOrderInput(order), clientRequestId: "nonce-1" };
  const a = await createShipper(input, { canOverrideCreditHold: false });
  const b = await createShipper(input, { canOverrideCreditHold: false });
  expect(b.deduped).toBe(true);
  expect(b.shipper.id).toBe(a.shipper.id);
  expect(await prisma.shipper.count()).toBe(1);
});

it("warns without blocking on a missing cert and unserialised lines", async () => {
  const { order } = await savedOrder({ certRequired: true, serializationRequired: true });
  const { warnings } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
  expect(warnings.join(" ")).toMatch(/requires a certification/i);
  expect(warnings.join(" ")).toMatch(/no serial numbers/i);
});

it("refuses a shipment with no positive quantity", async () => {
  const { order } = await savedOrder();
  await expect(createShipper(zeroQtyInput(order), { canOverrideCreditHold: false }))
    .rejects.toThrow(/at least one line/i);
});
```

- [ ] **Step 3: Run to verify failure.**
- [ ] **Step 4: Implement `createShipper`** — `withDbErrors` → Serializable `$transaction`:
  1. zod-parse the input (`decimalField(12, 2)` for weights/freight; `freightClass`/`proNumber`/`scacCode` `.max(30)` text).
  2. `claimOrdersInOrder(tx, input.orders.map(o => o.orderId))` — **sorted, always**.
  3. Validate: customer live and matching every order's customer; no voided orders; every `orderLineId` belongs to its order; at least one line with `qty > 0` across the whole shipment; `shipToAddressId` (when given) is a live `SHIP_TO` of that customer.
  4. Credit hold per §5.4 — refuse naming the customer with a link, or require and trim `creditHoldReason` when overriding.
  5. `allocateNumber("shipper_number_next", tx)`; per order `nextShipmentSequence(tx, orderId)`.
  6. `assertRefExists("carrier", carrierId, tx)` when set.
  7. `auditedCreate("shipper", payload, …, { tx })` with the whole graph; the override reason rides in the payload.
  8. `createCert({ orderId, scope: "SHIPMENT", shipperId }, tx)` for every order whose `certRequired` is true **and** whose `certScope` is `SHIPMENT` (§6.2).
  9. `recomputeOrderStatus(tx, orderIds)`.
  10. Collect `warnings[]` per §5.7 — missing cert, serialization-required with no serials selected, over-ship — each **naming the order and line**.

  `clientRequestId` collisions answer with the existing shipment (`deduped: true`) — reuse `orders.ts`'s `isDuplicateClientRequestId` discrimination, which reads the driver adapter's `constraint.fields` because `meta.target` is empty on this stack.
- [ ] **Step 5: Implement `getShipper`** with the full `ShipperDetail` projection, computing `shippedToDate*` per line via `shippedTotals` and `label` as `${orderNumber}-${sequence}`.
- [ ] **Step 6: Run the tests** — PASS.
- [ ] **Step 7: Add the concurrency tests** — two `createShipper` calls racing on one order get distinct packing-list numbers and distinct sequences; two multi-order saves over `{A,B}` and `{B,A}` driven concurrently both complete (no deadlock, no 500).
- [ ] **Step 8: Complete `SNAPSHOT_INCLUDE.shipper` (Task 2 review, spec §7).** Task 2 shipped `orders: { include: { order: { select: { orderNumber } } } }`, but spec §7 says the shipper snapshot pulls its orders "with order **and customer** selects" — without it a shipment's history diff renders `customerId`, `carrierId` and `shipToAddressId` as raw cuids, which is the unreadable-history shape issue #24 exists to prevent. Add the customer select (and the carrier/ship-to name selects on the shipper itself), then assert audit **content**: creating a shipment produces a snapshot naming the customer by code, not by cuid.
- [ ] **Step 9: Gates + commit** — `feat(shipping): create shipments with sorted claims, credit hold and idempotency`

---

### Task 9: Shipment children — replace grids, add and remove orders

**Files:**
- Modify: `src/server/shippers.ts`
- Test: `tests/shipper-children.test.ts`

**Interfaces:**
- Consumes: Task 8's `ShipperDetail`.
- Produces:
```ts
export async function updateShipper(id: string, input: unknown): Promise<ShipperDetail>;      // header only
export async function addOrderToShipper(id: string, orderId: string): Promise<ShipperDetail>;
export async function removeOrderFromShipper(id: string, shipperOrderId: string): Promise<ShipperDetail>;
export async function replaceShipperLines(id: string, shipperOrderId: string, input: unknown): Promise<ShipperDetail>;
export async function replaceShipperContainers(id: string, shipperOrderId: string, input: unknown): Promise<ShipperDetail>;
export async function replaceShipperSerials(id: string, shipperOrderId: string, input: unknown): Promise<ShipperDetail>;
export async function listShippers(filter: ShipperFilter): Promise<ShipperRow[]>;
export async function exportShippers(filter: ShipperFilter): Promise<Buffer>;
export async function shipmentsForOrder(orderId: string): Promise<ShipperRow[]>;
export type ShipperFilter = { customerId?: string; from?: string; to?: string; includeVoided?: boolean; search?: string };
export type ShipperRow = {
  id: string; shipperNumber: number; bolNumber: number | null; customerCode: string; customerName: string;
  shipDate: string; orderCount: number; orderLabels: string[]; carrierName: string | null;
  totalQty: number; totalWeight: number; freightAmount: number | null; deletedAt: string | null;
};
```

- [ ] **Step 1: Write the failing tests** in `tests/shipper-children.test.ts`:

```ts
it("adds another order of the same customer and gives it its own sequence", async () => {
  const { shipper, orderB } = await shipmentPlusSpareOrder();
  const after = await addOrderToShipper(shipper.id, orderB.id);
  expect(after.orders).toHaveLength(2);
  expect(after.orders[1].sequence).toBe(1);          // orderB's FIRST shipment
  expect(after.orders[1].position).toBe(2);          // second ticket on this shipment
});

it("refuses an order belonging to a different customer", async () => {
  const { shipper, foreignOrder } = await shipmentPlusForeignOrder();
  await expect(addOrderToShipper(shipper.id, foreignOrder.id))
    .rejects.toThrow(/same customer/i);
});

it("refuses the same order twice on one shipment", async () => {
  const { shipper, orderA } = await oneOrderShipment();
  await expect(addOrderToShipper(shipper.id, orderA.id)).rejects.toThrow(/already on this shipment/i);
});

it("recomputes status when an order is removed", async () => {
  const { shipper, orderA, shipperOrderA } = await completeShipmentOf(orderA);
  expect((await getOrder(orderA.id)).status).toBe("SHIPPED");
  await removeOrderFromShipper(shipper.id, shipperOrderA.id);
  expect((await getOrder(orderA.id)).status).toBe("OPEN");
});

it("closes positions after a removal", async () => {
  const { shipper, second } = await threeOrderShipment();
  const after = await removeOrderFromShipper(shipper.id, second.id);
  expect(after.orders.map((o) => o.position)).toEqual([1, 2]);
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Every mutator: `withDbErrors` → Serializable `$transaction` → resolve the shipper (404 on missing **or voided** — a voided shipment is read-only, the P3 voided-order shape) → `claimOrdersInOrder(tx, everyAffectedOrderId)` → `auditedUpdate("shipper", id, …)` → writes → `recomputeOrderStatus`. `addOrderToShipper` allocates the new `ShipperOrder.sequence` via `nextShipmentSequence` and appends `position`; `removeOrderFromShipper` closes position gaps (the steps precedent). Position renumbering uses the **two-phase negative-park** pattern against `@@unique([shipperId, position])`, exactly as `order-loads.ts` does.
- [ ] **Step 4: Implement `listShippers`/`exportShippers`/`shipmentsForOrder`** — `use-latest`-friendly (pure data), `includeVoided` default off, search over packing-list number, BOL number, order number and customer code.
- [ ] **Step 5: Refuse removing an order whose ticket has printed** (spec §5.5, added 2026-08-04 by Task 2's review). `ShipperOrder` has no `deletedAt`, so removal hard-deletes the row and frees its `sequence` — and a later shipment of that order would then be handed a number already printed on a customer's ticket. Refuse when a `StoredDocument` exists with `kind: "SHIPPER"` and this shipment's id and either this order's id or `orderId: null` (the whole-set print covers every order on it). The message names the document and says to void the shipment instead. Tests:

```ts
it("refuses to remove an order whose ticket has printed, and allows it before", async () => {
  const { shipper, second } = await twoOrderShipment();
  await expect(removeOrderFromShipper(shipper.id, second.id)).resolves.toBeTruthy();  // nothing printed
  const { shipper: s2, second: sec2 } = await twoOrderShipment();
  await prisma.$transaction((tx) =>
    storeDocument(tx, { kind: "SHIPPER", shipperId: s2.id, orderId: sec2.orderId }, Buffer.from("%PDF-1.4 t")));
  await expect(removeOrderFromShipper(s2.id, sec2.id)).rejects.toThrow(/already printed|void the shipment/i);
});

it("treats a whole-set ticket print as covering every order on the shipment", async () => {
  const { shipper, second } = await twoOrderShipment();
  await prisma.$transaction((tx) =>
    storeDocument(tx, { kind: "SHIPPER", shipperId: shipper.id, orderId: null }, Buffer.from("%PDF-1.4 t")));
  await expect(removeOrderFromShipper(shipper.id, second.id)).rejects.toThrow(/already printed/i);
});
```

- [ ] **Step 6: Assert `ShipperOrder`'s two remaining uniques as behaviour** (Task 2's review left them unexercised): `@@unique([shipperId, orderId])` rejects the same order twice on one shipment (already covered by the service check — assert the constraint too, so a service refactor cannot silently lose it), and `@@unique([shipperId, position])` survives the two-phase negative-park renumber under a removal.
- [ ] **Step 7: Run the tests** — PASS, plus a `replaceShipperLines` test asserting the over-ship warning appears and the save still succeeds.
- [ ] **Step 8: Gates + commit** — `feat(shipping): shipment children, add/remove order, listing and export`

---

### Task 10: Void a shipment; the order edit invariants; the cert cascade

**Files:**
- Modify: `src/server/shippers.ts`, `src/server/orders.ts`
- Test: `tests/shipper-void.test.ts`, `tests/order-ship-invariants.test.ts`

**Interfaces:**
- Produces:
```ts
export async function voidShipper(id: string, reason: string): Promise<void>;
// orders.ts — used by updateLine/removeLine/voidOrder to refuse a contradiction of shipped fact
export async function shipmentBlockers(db: Db, orderId: string, orderLineId?: string): Promise<Blocker[]>;
```

- [ ] **Step 1: Write the failing tests** in `tests/shipper-void.test.ts`:

```ts
it("restores order status, keeps the number, and voids shipment-scoped certs", async () => {
  const { shipper, order, cert } = await completeShipmentWithShipmentCert();
  await voidShipper(shipper.id, "loaded onto the wrong truck");
  expect((await getOrder(order.id)).status).toBe("OPEN");
  expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).deletedAt).not.toBeNull();
  expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).shipperNumber)
    .toBe(shipper.shipperNumber);
});

it("keeps stored PDFs readable after a void", async () => {
  const { shipper } = await oneOrderShipment();
  const bytes = Buffer.from("%PDF-1.4 ticket");
  // storeDocument directly — printShippingTickets arrives in Task 18, and the refusal-to-reprint
  // assertion lives there with it. This task owns only the survival half.
  const doc = await prisma.$transaction((tx) =>
    storeDocument(tx, { kind: "SHIPPER", shipperId: shipper.id, orderId: null }, bytes));
  await voidShipper(shipper.id, "wrong truck");
  expect(Buffer.compare((await getDocument(doc.id)).fileData, bytes)).toBe(0);
});

it("requires a reason", async () => {
  const { shipper } = await oneOrderShipment();
  await expect(voidShipper(shipper.id, "\t ")).rejects.toThrow(/reason/i);
});
```

and in `tests/order-ship-invariants.test.ts`:

```ts
it("refuses removing a line that has shipments, naming the shipment", async () => {
  const { order, line, shipper } = await shipmentOfOneLine();
  await expect(removeLine(order.id, line.id))
    .rejects.toThrow(new RegExp(`Packing List ${shipper.shipperNumber}`));
});

it("refuses reducing a line below its shipped-to-date", async () => {
  const { order, line } = await shipmentOfOneLine({ ordered: 1000, shipped: 400 });
  await expect(updateLine(order.id, line.id, { qty: 300 })).rejects.toThrow(/400 already shipped/i);
  await expect(updateLine(order.id, line.id, { qty: 400 })).resolves.toBeTruthy();
});

it("refuses voiding an order with live shipments, and allows it after the shipment is voided", async () => {
  const { order, shipper } = await shipmentOfOneLine();
  await expect(voidOrder(order.id, "cancelled")).rejects.toThrow(/live shipment/i);
  await voidShipper(shipper.id, "cancelled too");
  await expect(voidOrder(order.id, "cancelled")).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `voidShipper`** — reason trimmed and required **in the service**; Serializable `$transaction`; `claimOrdersInOrder` over every order on the shipment; `auditedSoftDelete("shipper", …)`; `auditedSoftDelete("cert", …)` for every live cert with this `shipperId`, carrying the same reason; `recomputeOrderStatus`. Numbers and sequences are untouched.
- [ ] **Step 4: Implement `shipmentBlockers`** returning the shared `Blocker` shape (`entityLabel: "Shipment"`, `name: `Packing List ${shipperNumber}``, `href: /shipping/${id}`) so the refusals reuse the existing `BlockerPanel`, and wire it into `removeLine`, `updateLine` (qty/weight only, comparing against `shippedTotals`) and `voidOrder` — all **inside their existing claim-holding transactions**.
- [ ] **Step 5: Export the shared print guard** — `printTraveler` inlines its own voided check today. Extract it so Tasks 18–19 cannot forget it:

```ts
// src/server/documents.ts
export const VOIDED_PRINT = "This record is voided — no new documents can be produced for it";
/** Throws 400 VOIDED_PRINT when the owner is voided. Call inside the claim-holding transaction. */
export function assertPrintable(owner: { deletedAt: Date | null }): void;
```

Point `printTraveler` at it (its existing test must stay green), and unit-test it directly here. Tasks 18 and 19 call it for shipments and certs.
- [ ] **Step 6: Run the tests** — PASS.
- [ ] **Step 7: Gates + commit** — `feat(shipping): void with reason, cert cascade, and the order edit invariants`

---

### Task 11: Routes — shipments, certs, hub sections, and the 401/403 sweep

**Files:**
- Create: `src/app/api/shippers/route.ts`, `src/app/api/shippers/export/route.ts`, `src/app/api/shippers/[id]/route.ts`, `src/app/api/shippers/[id]/orders/route.ts`, `src/app/api/shippers/[id]/orders/[shipperOrderId]/route.ts`, `src/app/api/shippers/[id]/orders/[shipperOrderId]/lines/route.ts`, `…/containers/route.ts`, `…/serials/route.ts`, `src/app/api/certs/route.ts`, `src/app/api/certs/export/route.ts`, `src/app/api/certs/[id]/route.ts`, `src/app/api/certs/[id]/results/route.ts`, `src/app/api/orders/[id]/certs/route.ts`, `src/app/api/orders/[id]/shipments/route.ts`
- Test: `tests/shipper-routes.test.ts`, `tests/cert-routes.test.ts`

**Interfaces:**
- Consumes: every service from Tasks 5–10.
- **The two print routes are NOT created here.** `/api/shippers/[id]/print` arrives with Task 18 and `/api/certs/[id]/print` with Task 19, each alongside the layout it streams — a route that 501s is a route nothing can test, and this project does not ship unreachable surface (the 2B finding where a delete route shipped with no caller).

- [ ] **Step 1: Write the failing route tests** — for **every** route: 401 unauthenticated, 403 without the gate, 200/201 with it. Specifically: `POST /api/shippers` needs `shipping.create`; the credit-hold override path passes `canOverrideCreditHold: canDo(user, "override_credit_hold")` and a session **without** it gets the refusal even when a reason is supplied; `DELETE /api/shippers/[id]` needs `mustDo("void_shipper")` and `reasonFromBody`; `PUT /api/certs/[id]/results` passes `{ afterPrint: canDo(user, "edit_cert_results_after_print") }`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Write the handlers** — authorize, parse, delegate; nothing else. Every handler is `handle(async (req, { params }) => …)`; every test passes ctx.
- [ ] **Step 4: Run the tests** — PASS.
- [ ] **Step 5: Extend `tests/permissions-sweep.test.ts`** — it already asserts every route calls `requireUser`; confirm the new routes are covered and that no service under `src/server/` writes `prisma.auditLog.create` directly.
- [ ] **Step 6: Gates + commit** — `feat(api): shipment and certification routes`

---

### Task 12: Admin UI — per-user signature upload and typed settings widgets

**Files:**
- Modify: `src/server/users.ts`, `src/app/admin/users/*` (the user detail form), `src/app/admin/settings/page.tsx`
- Create: `src/app/api/admin/users/[id]/signature/route.ts`
- Test: `tests/user-signature.test.ts`, `tests/settings.test.ts`

**Amended 2026-08-04 after Task 1's review.** Task 1 added the first **boolean** setting (`cert_required_default`) and the first **enum** setting (`cert_scope_default`) to a settings page that has only ever rendered strings and integers — it submits every value as a string, so both new keys are unusable from the UI as shipped. That is the "a field the model supports but no screen can enter" shape this project treats as breaking, so it is fixed here rather than filed. Add to this task, before the signature work:

- [ ] **Step 0a: Write the failing test** — `setSetting("cert_required_default", "true")` (a string, which is what the page currently sends) is rejected by the zod schema with a 400; assert the page's submit path sends a real boolean and a member of `CERT_SCOPES` instead.
- [ ] **Step 0b: Render by declared type** — the settings page reads each key's `group` and label already; extend it to switch on the registry's schema type: checkbox for booleans, `<select>` over `CERT_SCOPES` (labelled with `CERT_SCOPE_LABELS`) for the scope enum, `<textarea>` for the two long standing-text keys (`cert_statement`, `shipper_liability_text` — single-line inputs make them uneditable in practice), and the existing input for everything else. Submit each with its real JavaScript type.
- [ ] **Step 0c: Verify in the browser** that all five of Task 1's settings can be read, changed and saved, then continue with the signature work below.

**Interfaces:**
- Produces:
```ts
export async function setSignature(userId: string, data: Buffer, mimeType: string): Promise<void>;
export async function clearSignature(userId: string): Promise<void>;
export async function getSignature(userId: string): Promise<{ data: Buffer; mimeType: string } | null>;
export const SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;
export const SIGNATURE_MIME = ["image/png", "image/jpeg", "image/bmp"] as const;
```

- [ ] **Step 1: Write the failing tests** — upload round-trips; a 3 MB upload 400s naming the cap; `image/svg+xml` 400s naming the allowed types; **the audit entry for the update contains no image bytes** (`signatureImage` is already in `redact()`'s patterns — assert it, don't assume); clearing sets the column null.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the service using `parseUploadFile`/`assertDeclaredUploadSize` from `src/server/http.ts` (the attachments precedent) and `auditedUpdate("user", …)`.
- [ ] **Step 4: Write the route** gated `mustDo("manage_users")`; `PUT` uploads, `DELETE` clears, `GET` streams the image with its content type.
- [ ] **Step 5: Add the admin UI** — an upload control with a preview and a Clear button on the user detail form, permission-gated per §5.16 (disabled with a tooltip, never hidden).
- [ ] **Step 6: Run the tests** — PASS.
- [ ] **Step 7: Gates + commit** — `feat(admin): per-user signature upload for certifications`

---

### Task 13: Shipping list page

**Files:**
- Create: `src/app/shipping/page.tsx`, `src/app/shipping/ShippingList.tsx`
- Modify: `src/components/Shell.tsx` (the Shipping nav entry goes live)
- Test: `tests/shipping-list.test.ts` (service-level filter coverage; the page is exercised by E2E)

- [ ] **Step 1: Write the failing filter tests** — customer filter, ship-date range, `includeVoided` default off, search matching packing-list number / BOL number / order number / customer code.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Build the page** — a client component against `/api/shippers`. Columns per §11. Use `useLatest` from `src/lib/use-latest.ts` on the load (both success and rejection paths), and **no `.catch(() => {})`** — a failed load renders a real error. Excel export button hits `/api/shippers/export`. Permission gating via `src/lib/permission-ui.ts`.
- [ ] **Step 4: Verify in the browser** with the Browser pane against `npm run dev`: the list renders, the voided toggle works, a failed request shows an error rather than an empty list. Screenshot for the demo doc.
- [ ] **Step 5: Run the tests** — PASS.
- [ ] **Step 6: Gates + commit** — `feat(ui): shipping list page`

---

### Task 14: Shipment page — header, per-order panels, three grids each

**Files:**
- Create: `src/app/shipping/[id]/page.tsx`, `src/app/shipping/[id]/ShipmentDetail.tsx`, `src/app/shipping/[id]/ShipmentOrderPanel.tsx`
- Test: exercised by Task 20's E2E; service coverage already exists

- [ ] **Step 1: Build the header** — customer, ship-to selector (that customer's live `SHIP_TO` addresses), ship date, carrier, route, comments, and the freight block (bill/amount, terms, class, description, package count prefilled from the container sum, pro no, SCAC). The customer's standing `shippingNotes` render as a read-only banner.
- [ ] **Step 2: Build one panel per `ShipperOrderDetail`**, headed with its `label` (`72036-3`), each carrying three grids built on `useBulkGrid` from `src/lib/bulk-grid.ts`: lines (ordered / shipped-to-date / ship-now qty and lbs / ship-line-complete, prefilled to the remainder), containers, serials. **Sibling-split rule: this phase's three grids per panel are the largest sibling group in the codebase — any fix to one lands on all three in the same commit.**
- [ ] **Step 3: Add the actions** — Add order (a picker of that customer's orders with unshipped lines), Remove order, Print (all tickets / this order's ticket / BOL / the cert checkbox pre-ticked), the stored-documents list, `HistoryPanel entity="shipper"`, and Void with a reason prompt.
- [ ] **Step 4: Render the state banners** — the credit-hold refusal (with the link to the customer), the §5.7 warnings, and a voided read-only banner naming the reason.
- [ ] **Step 5: Remount per id** — `<ShipmentDetail key={id} …>`; any `defaultValue`-bound field otherwise keeps the previous record's text (HANDOFF §5.12, a Critical in 2B).
- [ ] **Step 6: Verify in the browser** — build a two-order shipment, edit a line, watch the order's status change on the board. Screenshots for the demo doc.
- [ ] **Step 7: Gates + commit** — `feat(ui): shipment page with per-order ticket panels`

---

### Task 15: Certifications worklist page

**Files:**
- Create: `src/app/certs/page.tsx`, `src/app/certs/CertList.tsx`
- Modify: `src/components/Shell.tsx` (the Certifications nav entry goes live)
- Test: `tests/cert-list.test.ts`

- [ ] **Step 1: Write the failing filter tests** — customer, scope, printed/unprinted, `includeVoided` default off, search over order number and customer code; `failCount` counts readings whose `passed === false`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Build the page** — columns per §11 (order label `#72036-3`, customer, scope, load or shipment, printed?, pass/fail summary), `useLatest`, no soft-catch, Excel export.
- [ ] **Step 4: Verify in the browser.** Screenshot.
- [ ] **Step 5: Run the tests** — PASS.
- [ ] **Step 6: Gates + commit** — `feat(ui): certifications worklist`

---

### Task 16: Cert detail page — requirement blocks and readings grids

**Files:**
- Create: `src/app/certs/[id]/page.tsx`, `src/app/certs/[id]/CertDetail.tsx`, `src/app/certs/[id]/RequirementBlock.tsx`

- [ ] **Step 1: Build the header** — order link, scope and its subject (load number or packing-list number), printed date, and the void action with a reason.
- [ ] **Step 2: Build one requirement block per `CertRequirementDetail`**, grouped by part line and headed with the part number and name. Each block shows the frozen code, scale, min, max, sample qty and location **read-only** (they are frozen by design — §4.1), with an editable readings grid under it: value, computed pass/fail, an explicit override toggle, and a note. **Show pass/fail prominently on screen and note in the UI copy that it does not print** (§3.21) — this is the single most surprising behaviour in the phase and the screen is where it gets explained.
- [ ] **Step 3: Build freeform and internal notes** — internal notes carry a persistent "never printed" label beside the field.
- [ ] **Step 4: Gate post-print editing** — once `printedAt` is set the grids are read-only unless the session holds `edit_cert_results_after_print`, and the disabled state **says why** (§5.16).
- [ ] **Step 5: Add** the print action, the stored-documents list, and `HistoryPanel entity="cert"`. Remount per id.
- [ ] **Step 6: Verify in the browser** — seed a cert, type readings, watch pass/fail compute, override one. Screenshots.
- [ ] **Step 7: Gates + commit** — `feat(ui): certification detail with seeded requirements and readings`

---

### Task 17: Order hub sections and the new order-entry fields

**Files:**
- Modify: `src/app/orders/[id]/*` (hub sections), `src/app/orders/new/*` (entry), `src/app/parts/[id]/*`, `src/app/customers/[id]/*`

- [ ] **Step 1: Add the hub's Certifications section** — lists `certsForOrder`, and for `LOAD` scope shows the explicit gap ("by load · 4 loads · 0 certs") with a create action per load, plus **a warning row for any cert whose `loadNumber` no longer exists** after a re-split (§4.1). Order- and shipment-scope certs are listed, never created here.
- [ ] **Step 2: Add the hub's Shipments section** — `shipmentsForOrder`, each row linking to the shipment and showing its label (`72036-3`), ship date, quantities and complete flags.
- [ ] **Step 3: Add the Overview fields** — `certRequired`, `certScope` (both editable, showing what resolved), and `customerJobNo`.
- [ ] **Step 4: Add the order-entry fields** — the resolved cert-required/scope preview with an override, `customerJobNo`, and the containers grid's new `Cust Cont Id` column. The entry page keeps **only what the user typed** and re-derives until they type over it (the 2C-3 draft lesson).
- [ ] **Step 5: Add the part and customer fields** — `certRequired`/`certScope` on the part (three-state: yes / no / inherit, showing what it inherits), `certRequiredDefault`/`certScopeDefault` on the customer. **Sibling-pair habit: both pages in the same commit.**
- [ ] **Step 6: Verify in the browser** — key an order for a cert-required part, see the cert appear on the hub. Screenshots.
- [ ] **Step 7: Gates + commit** — `feat(ui): order hub certification and shipment sections, cert fields throughout`

---

### Task 18: Shipping ticket layout and its print mechanics

**Files:**
- Create: `src/server/pdf/shipping-ticket.ts`, `src/app/api/shippers/[id]/print/route.ts`
- Modify: `src/server/shippers.ts` (print entry point)
- Test: `tests/shipping-ticket.test.ts`

**Interfaces:**
- Consumes: `storeDocument`, `assertPrintable` (Tasks 3, 10); `claimOrdersInOrder` (Task 7); `shippedTotals` (Task 7).
- Produces:
```ts
export type TicketCompany = { name: string; address: string; phone: string; liabilityText: string };
export type TicketParty = { code: string; name: string; street: string; city: string; state: string; zip: string };
export type TicketLine = { qty: number; partNumber: string; partName: string; partDescription: string; pounds: number };
export type TicketContainer = { typeName: string; count: number; customerContainerId: string };
export type TicketData = {
  company: TicketCompany;
  soldTo: TicketParty;                 // the customer's default BILL_TO
  shipTo: TicketParty;                 // the shipment's ship-to address
  orderLabel: string;                  // "72036-3"
  orderNumber: number;
  shipDate: string;                    // "yyyy-mm-dd"
  poNumber: string;
  packingListNo: number;               // Shipper.shipperNumber
  customerJobNo: string;
  route: string;
  carrierName: string;
  lines: TicketLine[];
  containers: TicketContainer[];
  serials: { serial: string; description: string }[];   // only printOnShipper rows
  shippedComplete: boolean;
  totalQty: number;
  totalWeight: number;
};
export function buildShippingTicketDefinition(input: TicketData[]): TDocumentDefinitions;  // one sheet per order
export async function printShippingTickets(shipperId: string, orderId?: string):
  Promise<{ documentId: string; shipperNumber: number; pdf: Buffer }>;
```

- [ ] **Step 1: Read `docs/samples/Shipping Ticket Sample.pdf`** and build to it — §10.1 lists every block. It is the contract; do not invent fields.
- [ ] **Step 2: Write the failing tests:**

```ts
it("renders one sheet per order on the shipment", async () => {
  const { shipper } = await twoOrderShipment();
  const { pdf } = await printShippingTickets(shipper.id);
  expect(pdf.toString("latin1")).toContain("/Count 2");     // uncompressed page marker, P3's rule
});

it("renders one sheet when a single order is named", async () => {
  const { shipper, orderA } = await twoOrderShipment();
  const { pdf } = await printShippingTickets(shipper.id, orderA.id);
  expect(pdf.toString("latin1")).toContain("/Count 1");
});

it("reprints stored bytes exactly", async () => {
  const { shipper } = await oneOrderShipment();
  const first = await printShippingTickets(shipper.id);
  const stored = await getDocument(first.documentId);
  expect(Buffer.compare(stored.fileData, first.pdf)).toBe(0);   // STORED vs original: exact
});

it("refuses to print a voided shipment but keeps the stored one readable", async () => {
  const { shipper } = await oneOrderShipment();
  const printed = await printShippingTickets(shipper.id);
  await voidShipper(shipper.id, "wrong truck");
  await expect(printShippingTickets(shipper.id)).rejects.toThrow(/voided/i);
  expect((await getDocument(printed.documentId)).fileData.length).toBeGreaterThan(0);
});
```

**Never `Buffer.compare` two fresh renders** — `renderPdf` is not byte-deterministic (Global Constraints).
- [ ] **Step 3: Run to verify failure.**
- [ ] **Step 4: Implement.** `buildShippingTicketDefinition` is plain JSON on the existing `LAYOUT` constants in `src/server/pdf/render.ts`. `printShippingTickets` mirrors `printTraveler` exactly: read settings **outside** the transaction, then Serializable `$transaction` → `claimOrdersInOrder` → read on `tx` (never the top-level client — that was a pool-starvation bug in P3) → `renderPdf` → `storeDocument(tx, { kind: "SHIPPER", shipperId, orderId: orderId ?? null }, pdf)`.
- [ ] **Step 5: Wire the route** — `POST /api/shippers/[id]/print?doc=ticket&order=<id>` gated `shipping.view`, streaming the PDF with `contentDisposition`.
- [ ] **Step 6: Run the tests** — PASS. Open a rendered PDF beside the sample and compare block by block.
- [ ] **Step 7: Gates + commit** — `feat(pdf): shipping ticket, one sheet per order on the shipment`

---

### Task 19: BOL and certification layouts

**Files:**
- Create: `src/server/pdf/bol.ts`, `src/server/pdf/cert.ts`
- Modify: `src/server/shippers.ts`, `src/server/certs.ts`, the print routes
- Test: `tests/bol.test.ts`, `tests/cert-pdf.test.ts`

**Interfaces:**
- Produces:
```ts
export function buildBolDefinition(input: BolData): TDocumentDefinitions;
export async function printBol(shipperId: string): Promise<{ documentId: string; bolNumber: number; pdf: Buffer }>;
export function buildCertDefinition(input: CertPdfData): TDocumentDefinitions;
export async function printCert(certId: string, signerUserId: string): Promise<{ documentId: string; pdf: Buffer }>;
```

- [ ] **Step 1: Read `docs/samples/Bill of Lading Sample.pdf` and `Certification Sample.pdf`** and build to §10.2 and §10.3.
- [ ] **Step 2: Write the failing BOL tests:**

```ts
it("allocates the BOL number on first print and reuses it on reprint", async () => {
  const { shipper } = await twoOrderShipment();
  const a = await printBol(shipper.id);
  const b = await printBol(shipper.id);
  expect(b.bolNumber).toBe(a.bolNumber);
  expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).bolNumber).toBe(a.bolNumber);
});

it("does not allocate a BOL number for a shipment that never prints one", async () => {
  const { shipper } = await oneOrderShipment();
  await printShippingTickets(shipper.id);
  expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).bolNumber).toBeNull();
});

it("lists every order number on the shipment", async () => {
  const { shipper, orderA, orderB } = await twoOrderShipment();
  const { pdf } = await printBol(shipper.id);
  const text = pdf.toString("latin1");
  expect(text).toContain(String(orderA.orderNumber));
  expect(text).toContain(String(orderB.orderNumber));
});
```

- [ ] **Step 3: Write the failing cert tests:**

```ts
it("prints readings but never min, max, scale or pass/fail", async () => {
  const { cert, user } = await certWithReadings({ min: 28, max: 32, readings: [30.0, 25.6] });
  const { pdf } = await printCert(cert.id, user.id);
  const text = pdf.toString("latin1");
  expect(text).toContain("30.0");
  expect(text).toContain("25.6");
  expect(text).not.toMatch(/\bPass\b|\bFail\b/);
  expect(text).not.toContain("Min");            // §3.21 — the sample carries no requirements table
});

it("never prints internal notes", async () => {
  const { cert, user } = await certWithReadings({ internalNotes: "SECRET-INTERNAL-STRING" });
  const { pdf } = await printCert(cert.id, user.id);
  expect(pdf.toString("latin1")).not.toContain("SECRET-INTERNAL-STRING");
});

it("falls back to the display name when the signer has no signature on file", async () => {
  const { cert, user } = await certWithReadings({ signature: null });
  const { pdf } = await printCert(cert.id, user.id);
  expect(pdf.toString("latin1")).toContain(user.displayName);
});

it("sets printedAt on the first print only", async () => {
  const { cert, user } = await certWithReadings({});
  await printCert(cert.id, user.id);
  const first = (await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt;
  await printCert(cert.id, user.id);
  expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt).toEqual(first);
});
```

- [ ] **Step 4: Run to verify failure.**
- [ ] **Step 5: Implement both.** `printBol` allocates `bol_number_next` **only when `bolNumber` is null**, inside the claim-holding transaction. `printCert` embeds the *printing* user's `signatureImage` (§3.11), pulls `cert_statement` from settings, and renders each requirement as the sample does: a line naming the specification and scale, then a bare wrapping grid of that requirement's reading values.
- [ ] **Step 6: Wire the print routes** — `?doc=bol` on the shipment print route; `POST /api/certs/[id]/print`; and the **cert-with-shipment checkbox** (§3.14): the shipment print action accepts `cert=1` and prints each covered order's cert alongside, storing each as its own document.
- [ ] **Step 7: Run the tests** — PASS. Open both rendered PDFs beside their samples and compare block by block.
- [ ] **Step 8: Gates + commit** — `feat(pdf): bill of lading and certification layouts`

---

### Task 20: E2E flows, demo walkthrough, and docs

**Files:**
- Create: `e2e/ship-partial-then-complete.spec.ts`, `e2e/multi-order-shipment.spec.ts`, `e2e/cert-results-print.spec.ts`, `e2e/void-shipment.spec.ts`, `e2e/credit-hold-block-and-override.spec.ts`, `docs/<date>-phase-4-demo.md`
- Modify: `docs/HANDOFF.md` (§4a, §6, §7, §9), `CLAUDE.md`

- [ ] **Step 1: Write the five flows** per §13. Fixtures follow HANDOFF §5a: exact-key, scoped to the fixture customer, localhost-gated, cleaned from the **dev** database (`erp`, not `erp_test`) afterwards.
- [ ] **Step 2: Avoid the Phase 3 URL trap** — never `page.waitForURL(/\/shipping\/[^/?]+$/)`; it matches the literal `/shipping/new` route that is still on screen. Wait for content that can only exist after navigation (the packing-list number badge).
- [ ] **Step 3: Run the whole harness three times consecutively** — `npm run test:e2e` — to confirm stability, as Phase 3 did. Expected: 15/15 each time.
- [ ] **Step 4: Write the demo walkthrough** with screenshots at every named checkpoint (the 2C-2 / 2C-3 / Phase 3 precedent), including the three deviations a reader will notice: pass/fail shows on screen and not on paper; `cert_number_next` sits in Settings unused; and `Cust Cont Id` / `Customer Job No` are built but unused by this shop (§3.22).
- [ ] **Step 5: Update `docs/HANDOFF.md`** — §4a gains the Phase 4 record (tasks, gates, test count, review rounds); §6 gains anything triaged rather than fixed; **§7 item 1 is struck — the samples arrived**; §9's kickoff prompt is rewritten for Phase 5 (Invoicing & A/R + QBO) quoting the spec's §16 inheritance list.
- [ ] **Step 6: Update `CLAUDE.md`** — the sorted-claim rule for multi-order writes, the `StoredDocument` kind/owner `CHECK`, and the "certs have no unique column, `Cert` adds no sweep exemption" note.
- [ ] **Step 7: Full gates** — `/gates` including `npm run build` and the E2E suite. Expected: all green, tests well past 1010.
- [ ] **Step 8: Commit** — `docs: Phase 4 demo walkthrough and handoff update`

---

## Review and merge

After Task 20: the **whole-branch review on the strongest model**, one fix wave, then the PR. Codex review rounds are fixed on-branch while they converge and triaged to issues by owner ruling when they stop (the PR #39 precedent: 34 fixed across rounds 1–4, round 5 → issues #41–#46). Attribution goes in the **PR body**, never in a commit.
