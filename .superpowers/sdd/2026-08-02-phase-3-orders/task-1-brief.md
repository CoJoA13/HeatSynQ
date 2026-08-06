### Task 1: Schema — eleven tables, two columns, migration, sweep exemption, registry entry

**Files:**
- Modify: `prisma/schema.prisma` (after `ProcessTemplateStep`; back-relations on `Customer`, `Part`, `ContainerType`, `User`)
- Create: `prisma/migrations/<timestamp>_orders_and_loads/migration.sql`
- Modify: `tests/partial-unique-sweep.test.ts` (orderNumber exemption), `src/lib/reference-links.ts` (+`orderContainer` entry), `src/server/audit.ts` (models + snapshot + redact)
- Test: `tests/orders-schema.test.ts`

**Interfaces:**
- Produces: enum `OrderStatus`, enum `DocumentKind`, models `Order`, `OrderLine`, `OrderContainer`, `OrderSerial`, `Load`, `OrderCharge`, `PartAttachment`, `OrderAttachment`, `OrderDraft`, `SavedView`, `StoredDocument` **exactly as spec §4** (copy the prisma blocks verbatim; `OrderAttachment` mirrors `PartAttachment` with `orderId`/`order`). Columns `Customer.requestDaysOverride Int?`, `Part.requestDaysOverride Int?`. Back-relations: `Customer.orders Order[]`, `Part.orderLines OrderLine[]`, `Part.attachments PartAttachment[]`, `ContainerType.orderContainers OrderContainer[]`, `User.orderDraft OrderDraft?`, `User.savedViews SavedView[]`.
- Produces for Task 4+: `AuditableModel` gains `"order" | "partAttachment" | "orderAttachment" | "savedView" | "storedDocument"`.

- [ ] **Step 1: Edit `prisma/schema.prisma`** — spec §4 blocks verbatim. No `onDelete` anywhere new. `SavedView`'s partial unique on ONE line. `Order.orderNumber Int @unique` (plain — deliberate).
- [ ] **Step 2: Migration** per the TTY recipe; verify purely additive (11 `CREATE TABLE`, 2 `ALTER TABLE … ADD COLUMN`, 2 `CREATE TYPE`, FKs, the spec's indexes incl. partial unique `ON "SavedView"("userId","name") WHERE "deletedAt" IS NULL`). Apply to BOTH DBs; `npx prisma generate`; `tsc` clean.
- [ ] **Step 3: Sweep exemption** — extend the documented allowlist in `tests/partial-unique-sweep.test.ts` beside `User.username`: `Order.orderNumber` — "voided orders keep their number forever; numbers are allocation-only and never reused or re-entered (spec §4)". Run the sweep: passes with the exemption, and TEMPORARILY removing the exemption fails it (verify both, keep the exemption).
- [ ] **Step 4: Registry entry** in `src/lib/reference-links.ts` — add `"orderContainer"` to `ReferenceLinkModel` and:

```ts
{ model: "orderContainer", column: "typeId", targetKind: "containerType",
  label: "Container", entityLabel: "Order", detailPath: (id) => `/orders/${id}`,
  liveWhere: { order: { is: { deletedAt: null } } },
  include: { order: { select: { id: true, orderNumber: true, customer: { select: { code: true } } } } },
  blockerId: (r) => String((r.order as { id: string }).id),
  displayName: (r) => { const o = r.order as { orderNumber: number; customer: { code: string } };
    return `#${o.orderNumber} · ${o.customer.code}`; } },
```

Run `tests/reference-links-sweep.test.ts` — green (it would fail on the unregistered FK otherwise).
- [ ] **Step 5: Audit surface** — `AuditableModel` union + `SNAPSHOT_INCLUDE`: `order: { lines: { orderBy: { position: "asc" }, include: { part: { select: { partNumber: true } } } }, containers: { orderBy: { position: "asc" }, include: { type: { select: { name: true } } } }, serials: { orderBy: [{ lineId: "asc" }, { position: "asc" }] }, loads: { orderBy: { loadNumber: "asc" } }, charges: { orderBy: { position: "asc" } } }` (**every collection `orderBy`'d — issue #24**); `partAttachment/orderAttachment/savedView/storedDocument: undefined`. Add `"filedata"` to `redact()`'s `sensitiveKeyPatterns` (spec §7 — snapshots must never embed file bytes; patterns are lowercase-substring matched).
- [ ] **Step 6: Schema smoke test** `tests/orders-schema.test.ts` — graph round-trip (order → line → serial; container → type; load; charge; draft; saved view; stored document; one attachment of each kind); `orderNumber` uniqueness rejects a duplicate even when the first order is soft-deleted (the no-reuse contract); `SavedView` name unique only among live rows per user. Model on `tests/process-schema.test.ts`.
- [ ] **Step 7: Gates + commit** — `feat: order schema — eleven tables, request-day overrides, registry + sweep coverage`

