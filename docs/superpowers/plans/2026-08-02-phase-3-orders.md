# Phase 3 — Orders & Loads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enter and print real work orders — lead-part+rider lines, locked recipe revision, auto load-split, per-load traveler PDFs with barcodes, the order board as home, global search live.

**Architecture:** Eleven new tables around `Order` (lines/containers/serials/loads/charges + drafts, saved views, stored documents, two attachment tables sharing one implementation). One save transaction owns the correctness story: number allocation via `FOR UPDATE` on the setting row, recipe lock via `FOR UPDATE` on the revision row (**the row lock is the guarantee — the transaction's isolation level is NOT what protects the lock; never present it as such**, HANDOFF §4a), auto-split from order totals with the lead part's caps. Documents render server-side with pdfmake (template = JSON data) and are stored as exact PDFs. Spec: `docs/superpowers/specs/2026-08-02-phase-3-orders-design.md` — all bare § references below are to it; its prisma blocks are the schema contract.

**Tech Stack:** Next.js 16 / React 19 client pages against guarded APIs, Prisma 7 (+pg adapter), zod 4, pdfmake + bwip-js (both pure JS), vitest against real `erp_test`, Playwright (bundled Chromium) E2E.

## Global Constraints

- All commands run from `erp/`. Quality gates after every task: `npm test`, `npx tsc --noEmit`, `npx eslint src tests` (plus `npm run build` before review rounds). Node 26 (`nvm use 26`); `npm ci`'s five skipped-install-scripts warning is expected and must not be "fixed".
- TDD per task: failing test → implement → pass → commit. Conventional commits, **no attribution trailers** (owner instruction).
- Every mutation through `auditedCreate`/`auditedUpdate`/`auditedSoftDelete` — `tx` REQUIRED. Canonical nesting: `withDbErrors` → `prisma.$transaction` → `audited*` → writes on `tx`. **One documented exception this phase: the order-draft service (§4) writes `prisma.orderDraft` directly — pre-entity scratch, spec-authorized.**
- Any write assigning a non-null registered-FK column (`OrderContainer.typeId`) runs its transaction **Serializable** and calls `assertRefExists("containerType", id, tx)` inside it. The whole order save runs Serializable for uniformity; serialization failures already map to 409 (`translatePrisma` handles P2010-wrapped 40001).
- Never `findUnique`/`upsert`/`update`/`delete` keyed on a partial-unique column (`SavedView` `[userId, name]`); `findFirst({ where: { …, deletedAt: null } })` instead. Partial `@@unique(...)` attributes stay on ONE line. **`Order.orderNumber` is deliberately a plain `@unique` — extend the sweep's documented exemption (Task 1), do not "fix" it.**
- `npx prisma migrate dev` refuses without a TTY. Migration recipe: `npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script`, read the output IN FULL, hand-write `prisma/migrations/<timestamp>_<name>/migration.sql`, then `npx prisma migrate deploy` AND `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy`, then `npx prisma generate`.
- Client components never import from `src/server/**`; shared pure code goes in `src/lib/`.
- Route handlers: `handle(async (req, { params }) => …)`; first line `mustCan(requireUser(), "orders", action)` (or `mustDo` for `void_order`); `assertRecord(body)` before key checks; DELETE reasons via `reasonFromBody`. Route tests pass ctx: `handler(request, { params: Promise.resolve({ id }) })`.
- Expected failures are `HttpError(400|403|404, message)`, field-anchored. Dates cross the wire as `"yyyy-mm-dd"` strings; the service validates with the leap-year rollover guard (the `part-process-steps.ts` DATE shape) and stores `Date` in `@db.Date` columns.
- Tests share one DB: `truncateAll()` in `beforeEach` (from `tests/helpers/db`), `signInWith(permissions)` from `tests/helpers/auth`. Do not parallelize. Assert audit **content** (diffs), not just that entries exist.
- Money/weights `Decimal(12,2)` via `decimalField(12, 2, …)`; qty are `z.number().int().min(1)`.
- Owner rulings binding this plan (spec §3): lead+riders; respect-both split on order totals; loads editable after print with warning; business days Mon–Fri; light reads request date; charges captured now; credit hold warns, never blocks; `vsOrderNumber` field; **traveler is samples-gated — Task 16 ASKS the owner if `docs/samples/` lacks the real documents**; pdfmake + bwip-js.
- Voided = `deletedAt` set (reason required, `void_order`); voided orders block nothing, refuse NEW traveler prints, keep stored prints reprintable, never free their number.

---

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

### Task 2: Pure utilities — serial ranges, business days, load split

**Files:**
- Create: `src/lib/serial-range.ts`, `src/lib/business-days.ts`, `src/lib/load-split.ts`
- Test: `tests/serial-range.test.ts`, `tests/business-days.test.ts`, `tests/load-split.test.ts`

**Interfaces (Produces — client-safe, no server imports):**
```ts
// serial-range.ts
export function expandSerialRange(input: string): string[];
// no braces → [input.trim()]; "EC{001-025}" → ["EC001", …, "EC025"] (25 rows);
// padding = width of the FIRST bound ("EC{001-25}" ≡ "EC{001-025}", VS rule);
// prefix and suffix both allowed ("{01-04}-B"); throws HttpError-shaped {message} via plain
// Error on: nested/multiple brace groups, non-numeric bounds, start > end, expansion > 10_000.

// business-days.ts
export function parseDateOnly(s: string): Date;      // "yyyy-mm-dd", leap-year rollover guard, throws Error on invalid
export function formatDateOnly(d: Date): string;     // UTC → "yyyy-mm-dd"
export function todayDateOnly(): Date;               // today at UTC midnight (matches @db.Date semantics)
export function addBusinessDays(start: Date, n: number): Date;
// n ≥ 0 integer; each step advances one day, skipping Sat/Sun; addBusinessDays(Thu, 5) = next Thu.

// load-split.ts
export type LoadSplit = { qty: number; weight: number };
export function splitLoads(input: { totalQty: number; totalWeight: number;
  loadQty: number | null; loadWeight: number | null }): LoadSplit[];
```
- `splitLoads` (§5.4): `perLoadQty = min(loadQty ?? Infinity, loadWeight ? Math.max(1, Math.floor(loadWeight / (totalWeight / totalQty))) : Infinity)`; both null → `[{ qty: totalQty, weight: totalWeight }]`. Chunks of `perLoadQty`, last chunk = remainder; per-load weight = `round2(totalWeight * qty / totalQty)`, **last load = totalWeight − Σ(others)** so sums are exact to the cent-of-a-pound.

- [ ] **Step 1: Failing tests** — the §12 matrices in full:
  - serial-range: plain string passthrough; 25-row expansion with padding; `{001-25}` equivalence; suffix form; reject nested `{{`, two groups, `{01-}`, `{9-1}`, `{1-99999}` (cap message names 10,000); trims whitespace.
  - business-days: Thu+5=Thu; Fri+1=Mon; Mon+0=Mon; parse rejects `2025-02-29` (rollover guard) and `2025-13-01`; format round-trips.
  - load-split: `1000/300` → 300/300/300/100; weight-only `loadWeight=700, each≈2.6` (1000 pcs, 2600 lb) → perLoad `floor(700/2.6)=269`; **both caps** (the §3.2 example: 1000 pcs @ 2.6 lb, loadQty 300, loadWeight 700 → 269 not 300); heavy piece (each 900 lb, loadWeight 700) → 1/load; exact multiple 900/300 → three equal loads, no zero-qty tail; no caps → single load; weights sum exactly to totalWeight in every case (assert `Σ === total` with 2-dp arithmetic).
- [ ] **Step 2: Run — expect FAIL** (`npx vitest run tests/serial-range.test.ts tests/business-days.test.ts tests/load-split.test.ts`).
- [ ] **Step 3: Implement the three modules** to the signatures above (plain `Error` with clean messages in `src/lib` — services translate to `HttpError(400, …)` at the boundary).
- [ ] **Step 4: Run — expect PASS.** Gates.
- [ ] **Step 5: Commit** — `feat: serial-range, business-days, and load-split utilities`

### Task 3: Shared primitives — allocateNumber + lockCurrentRevision

**Files:**
- Modify: `src/server/settings.ts`, `src/server/part-process-steps.ts`
- Test: `tests/allocate-number.test.ts`, extend `tests/part-process-steps.test.ts`

**Interfaces (Produces):**
```ts
// settings.ts
export async function allocateNumber(key: SettingKey, tx: Prisma.TransactionClient): Promise<number>;
// part-process-steps.ts
export async function lockCurrentRevision(partId: string, tx: Prisma.TransactionClient): Promise<{ revisionNumber: number }>;
```

- [ ] **Step 1: Failing tests.** allocateNumber: returns the seed (default 1000) when no row exists and increments the stored value; two sequential calls give N, N+1; **two concurrent `$transaction`s each allocating get distinct numbers** (fire both without awaiting between starts); writes NO audit row (`prisma.auditLog.count() === 0` after allocation); rejects an unknown key. lockCurrentRevision: 400 "This part has no process steps" when the part has no revision AND when the current revision has zero steps; returns the highest revisionNumber and sets `lockedAt`; idempotent (second call same result, no second audit entry — reuses `lockRevision`'s contract); **the 2C-3 race regression rerun against this caller**: a `lockCurrentRevision` inside a default-isolation tx racing `updateStep` cannot leave the locked revision's steps modified (both orderings — model on the existing "a lock landing mid-mutation" test in `tests/part-process-steps.test.ts`).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**

```ts
// settings.ts — allocation is deliberately unaudited: the consuming entity's own create entry
// records the number; owner edits to the seed still flow through setSetting + auditSettingChange.
export async function allocateNumber(key: SettingKey, tx: Prisma.TransactionClient): Promise<number> {
  if (!Object.hasOwn(SETTINGS, key)) throw new HttpError(400, `Unknown setting: ${key}`);
  const def = SETTINGS[key];
  await tx.setting.upsert({ where: { key }, create: { key, value: def.default as number }, update: {} });
  const [row] = await tx.$queryRaw<{ value: unknown }[]>`
    SELECT "value" FROM "Setting" WHERE "key" = ${key} FOR UPDATE`;
  const parsed = def.schema.safeParse(row.value);
  const current = (parsed.success ? parsed.data : def.default) as number;
  await tx.setting.update({ where: { key }, data: { value: current + 1 } });
  return current;
}
```

```ts
// part-process-steps.ts — same claim SQL as workingRevision (this file is the only home of that
// FOR UPDATE, HANDOFF §4a: the row lock is the guarantee at ANY caller isolation).
export async function lockCurrentRevision(
  partId: string, tx: Prisma.TransactionClient,
): Promise<{ revisionNumber: number }> {
  const claimed = await tx.$queryRaw<{ id: string; revisionNumber: number }[]>`
    SELECT "id", "revisionNumber" FROM "PartProcessRevision"
    WHERE "partId" = ${partId} ORDER BY "revisionNumber" DESC LIMIT 1 FOR UPDATE`;
  if (claimed.length === 0) throw new HttpError(400, "This part has no process steps");
  const stepCount = await tx.partProcessStep.count({ where: { revisionId: claimed[0].id } });
  if (stepCount === 0) throw new HttpError(400, "This part has no process steps");
  await lockRevision(partId, claimed[0].revisionNumber, tx);
  return { revisionNumber: claimed[0].revisionNumber };
}
```

- [ ] **Step 4: Run — expect PASS.** Gates.
- [ ] **Step 5: Commit** — `feat: allocateNumber and lockCurrentRevision primitives`

### Task 4: Orders service — create, read, list, export, traffic light

**Files:**
- Create: `src/server/orders.ts`, `src/lib/traffic-light.ts`
- Test: `tests/orders.test.ts`, `tests/traffic-light.test.ts`

**Interfaces (Produces):**
```ts
// src/lib/traffic-light.ts (pure, client-safe)
export type TrafficLight = "on_target" | "may_miss" | "will_miss" | "did_miss";
export function computeLight(requestDate: Date, today: Date, mayMissDays: number, willMissDays: number): TrafficLight;
// most-urgent-first: did_miss (request < today) → will_miss (≤ willMissDays away) → may_miss (≤ mayMissDays) → on_target

// src/server/orders.ts
export type OrderWarnings = string[]; // e.g. `Line 2 (ACME · 3541720C3): serialization required but no serials entered`
export async function createOrder(input: unknown): Promise<{ order: OrderDetail; warnings: OrderWarnings }>;
export async function getOrder(id: string): Promise<OrderDetail>;   // 404 when missing; voided orders ARE returned (hub renders read-only)
export async function listOrders(filter: {
  search?: string; status?: OrderStatus[]; customerId?: string;
  receivedFrom?: string; receivedTo?: string; requestFrom?: string; requestTo?: string;
  includeVoided?: boolean; sort?: string; dir?: "asc" | "desc";
}): Promise<BoardRow[]>;
export async function exportOrders(filter: /* same */): Promise<Buffer>;
```
`OrderDetail` = order scalars + `lines` (with `part: { id, partNumber, name, customer: { code } }`, lead first) + `containers` (with `type: { name }`) + `serials` + `loads` + `charges` + `light` + `travelerPrinted: boolean` (derived: any `StoredDocument` row exists) + `linkedOrders: { id, orderNumber }[]` (same `linkGroupId`, self excluded). `BoardRow` = `{ id, orderNumber, customerCode, customerName, leadPartNumber, poNumber, vsOrderNumber, qty, weight, receivedDate, requestDate, targetDate, status, voided, light, loadCount, linked, }` — `qty`/`weight` are Σ over lines; `light` computed server-side from the two traffic settings.

`CREATE` zod shape (`.strict()` everywhere):
```ts
const LINE = z.object({ partId: z.string().min(1), qty: z.number().int().min(1),
  weight: decimalField(12, 2, { required: true, min: "positive" }),
  serials: z.array(z.object({ serial: z.string().trim().min(1).max(120),
    description: z.string().max(500).default("") }).strict()).max(10_000).default([]) }).strict();
const CREATE = z.object({
  customerId: z.string().min(1), poNumber: z.string().max(200).default(""),
  vsOrderNumber: z.string().max(60).default(""),
  receivedDate: z.string().optional(), requestDate: z.string().optional(),
  targetDate: z.string().nullable().optional(), notes: z.string().max(4000).default(""),
  lines: z.array(LINE).min(1),
  containers: z.array(z.object({ typeId: z.string().min(1), count: z.number().int().min(1),
    qty: z.number().int().min(1).nullable().optional(),
    tareWeight: decimalField(12, 2, { min: "nonnegative" }),
    grossWeight: decimalField(12, 2, { min: "nonnegative" }) }).strict()).default([]),
  charges: z.array(z.object({ description: z.string().trim().min(1).max(500),
    amount: decimalField(12, 2, { min: "nonnegative" }) }).strict()).default([]),
}).strict();
```

- [ ] **Step 1: Failing tests** — the §12 clusters that belong to create/read/list:
  - create: full two-line sibling order returns lead line with `revisionNumber` = the part's current revision, riders `null`; the locked revision's `lockedAt` set; loads auto-split (assert the mockup case: 2 lines totalling 4500 pcs / 60,750 lb, lead `loadQty` 336 → 14 loads, last 132, weights sum exactly); numbering: two concurrent `createOrder` calls → distinct sequential `orderNumber`s; `receivedDate` defaults to today, `requestDate` defaults via the §6 chain (create parts/customers with overrides: part 3 beats customer 7 beats plant 5; business-day assertion: received Friday + 5 → next Friday); rejects: unknown customer, inactive customer, part of ANOTHER customer (message names the part), inactive part, lead part without steps (400 "This part has no process steps"), bad date strings, duplicate serial within a line (P2002 → 400 naming the serial); serialization warning: `serializationRequired` part with no serials → warning naming the line, order still saved; credit-hold customer → warning present; audit: exactly one `order` create entry whose `after` snapshot has ordered lines/containers/loads and **no `fileData` key anywhere**; draft cleared: seed `OrderDraft` for the actor, create, assert `payload === null`.
  - lock-vs-edit integration (the §12.3 cluster): after `createOrder`, `updateStep` on the lead part cuts revision N+1 and the locked N is byte-identical (reuse the existing byte-compare helper shape from `tests/part-process-steps.test.ts`).
  - traffic light (pure): each boundary at both edges, most-urgent-first when windows overlap (willMiss 3 inside mayMiss 5), did_miss strictly past.
  - list: filters (status, customer, ranges, includeVoided default-off hides voided), search matches number / PO / VS# / lead part number / customer code+name, sort by requestDate asc/desc; rows carry computed `light`.
  - export: `toXlsx` buffer with the BoardRow columns; filtered set only.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `createOrder`** — the §5 transaction verbatim:

```ts
export async function createOrder(input: unknown): Promise<{ order: OrderDetail; warnings: OrderWarnings }> {
  const data = CREATE.parse(input);
  return withDbErrors({ entity: "Order" }, () =>
    prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: data.customerId, deletedAt: null } });
      if (!customer) throw new HttpError(400, "That customer does not exist");
      if (!customer.active) throw new HttpError(400, "That customer is inactive");
      const parts = await resolveLineParts(tx, customer.id, data.lines); // live+active+same-customer, 400s name the line
      const receivedDate = data.receivedDate ? parseDate(data.receivedDate, "Received date") : todayDateOnly();
      const requestDate = data.requestDate ? parseDate(data.requestDate, "Request date")
        : addBusinessDays(receivedDate, parts[0].requestDaysOverride ?? customer.requestDaysOverride
            ?? await getSetting("request_days_default"));
      const orderNumber = await allocateNumber("order_number_next", tx);
      const { revisionNumber } = await lockCurrentRevision(parts[0].id, tx);   // row lock = the guarantee
      for (const typeId of new Set(data.containers.map((c) => c.typeId))) {
        await assertRefExists("containerType", typeId, tx);
      }
      const totals = lineTotals(data.lines);                                   // Σqty, Σweight (2dp)
      const loads = splitLoads({ ...totals, loadQty: parts[0].loadQty,
        loadWeight: parts[0].loadWeight === null ? null : Number(parts[0].loadWeight) });
      const order = await auditedCreate("order", auditPayload(/* order + children, ordered */),
        () => tx.order.create({ data: { orderNumber, customerId: customer.id, /* scalars */,
          lines: { create: data.lines.map((l, i) => ({ position: i + 1, partId: l.partId,
            revisionNumber: i === 0 ? revisionNumber : null, qty: l.qty, weight: l.weight })) },
          containers: { create: /* rows with position */ }, loads: { create: loads.map((l, i) => ({ loadNumber: i + 1, ...l })) },
          charges: { create: /* rows with position */ } } }), { tx });
      await createSerials(tx, order.id, data.lines);        // needs line ids — create after, keyed by position
      const actor = currentActor();
      if (actor.id) await tx.orderDraft.updateMany({ where: { userId: actor.id }, data: { payload: Prisma.DbNull } });
      return { order: await readDetail(tx, order.id), warnings: buildWarnings(customer, parts, data.lines) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
```
(Structure is binding — names/decomposition are the implementer's. `parseDate(s, field)` is a thin service wrapper over `parseDateOnly` that rethrows as a field-anchored `HttpError(400, …)`. `getSetting` reads happen before the tx or via `tx`-free call — it is read-only. Serials: `@@unique([lineId, serial])` violations surface as P2002 → `withDbErrors` 400; map the message to name the serial. `exportOrders` takes the same filter object as `listOrders` and feeds the same rows through `toXlsx`.)
- [ ] **Step 4: Implement** `computeLight`, `getOrder`, `listOrders` (+`light` per row), `exportOrders` (via `toXlsx`).
- [ ] **Step 5: Run — expect PASS.** Gates.
- [ ] **Step 6: Commit** — `feat: order create/read/list/export with locked revisions, auto-split, numbering`

### Task 5: Orders service — edits, void, link

**Files:**
- Modify: `src/server/orders.ts`
- Test: extend `tests/orders.test.ts`

**Interfaces (Produces):**
```ts
export async function updateOrder(id: string, input: unknown): Promise<{ order: OrderDetail; warnings: OrderWarnings }>;
// PATCH of: poNumber, vsOrderNumber, receivedDate, requestDate, targetDate (nullable), notes. NOTHING else.
export async function addLine(orderId: string, input: unknown): Promise<{ order: OrderDetail; warnings: OrderWarnings }>;   // rider only: position = max+1
export async function updateLine(orderId: string, lineId: string, input: unknown): Promise<{ order: OrderDetail; warnings: OrderWarnings }>; // qty/weight only; partId immutable
export async function removeLine(orderId: string, lineId: string): Promise<OrderDetail>;  // position 1 → 400 "The lead part cannot be removed — void the order instead"
export async function replaceContainers(orderId: string, input: unknown): Promise<OrderDetail>; // bulk PUT, Serializable + assertRefExists per distinct typeId
export async function replaceSerials(orderId: string, lineId: string, input: unknown): Promise<OrderDetail>; // bulk PUT per line
export async function replaceCharges(orderId: string, input: unknown): Promise<OrderDetail>;    // bulk PUT
export async function voidOrder(id: string, reason: string): Promise<void>;   // reason trimmed+required IN THE SERVICE
export async function linkOrder(id: string, otherId: string): Promise<OrderDetail>;   // same customer enforced
export async function unlinkOrder(id: string): Promise<OrderDetail>;
```
Every mutator: `withDbErrors` → Serializable tx → resolve the order `findFirst({ id, deletedAt: null })` (404 "Order not found" — voided orders are read-only) → `auditedUpdate("order", id, doIt, { tx })`. Warnings on qty/weight edits: `"Loads no longer sum to the order — re-split or edit loads"` when Σloads ≠ Σlines (qty or weight).

- [ ] **Step 1: Failing tests** — §12.9 in full: scalar PATCH audits a real diff (before/after show the changed field); customer/lead immutability (no input path — assert unknown keys 400 via `.strict()`, and `updateLine` on a lead can change qty but never `partId`/`revisionNumber`); rider add → position max+1; rider remove closes gaps (steps precedent — per-row updates ascending); removing the lead 400s with the exact message; qty edit returns the loads-mismatch warning, matching edit clears it; `replaceSerials` swaps a line's set atomically and rejects in-payload duplicates; `replaceContainers` under a concurrent `deleteReference("containerType")` — the Serializable pair (model on the existing `assertRefExists` race tests); void: requires non-blank reason (400 "A reason is required to void an order"), `auditedSoftDelete` entry carries it, voided order 404s from every mutator, still `getOrder`-readable, hidden from `listOrders` unless `includeVoided`; link: same-customer 400 otherwise, joins existing group, unlink clears, `linkedOrders` excludes self.
- [ ] **Step 2: Run — expect FAIL.**  **Step 3: Implement.**  **Step 4: PASS + gates.**
- [ ] **Step 5: Commit** — `feat: order edits, void with reason, linked orders`

### Task 6: Loads service

**Files:**
- Create: `src/server/order-loads.ts`
- Test: `tests/order-loads.test.ts`

**Interfaces (Produces):**
```ts
export type LoadInput = { loadNumber: number; qty: number | null; weight: number | null };
export async function replaceLoads(orderId: string, input: unknown): Promise<{ order: OrderDetail; warnings: OrderWarnings }>;
// bulk PUT: validates loadNumbers are 1..N exactly once (two-phase negative-park rewrite against
// @@unique([orderId, loadNumber])); each row needs qty or weight (or both); ≥ 1 load.
export async function resplitLoads(orderId: string): Promise<{ order: OrderDetail; warnings: OrderWarnings }>;
// re-runs splitLoads on current totals + lead caps, replacing all loads.
```
Warnings (never blocks): sum mismatch (as Task 5) and `"A traveler has already printed — print a fresh one"` when any `StoredDocument` exists for the order (§3.3).

- [ ] **Step 1: Failing tests**: replace validates the 1..N set (400 "Load numbers must be 1..N with no gaps or repeats"), swaps a renumber atomically (reverse 3 loads' numbers in one call — the two-phase pattern), rejects a row with neither qty nor weight; resplit rebuilds from current lead caps after a qty edit; both return the printed warning iff a stored document exists (seed one directly via prisma in the test); voided order 404s; audit diff shows the load change.
- [ ] **Steps 2–4: FAIL → implement → PASS + gates.**
- [ ] **Step 5: Commit** — `feat: load editing, renumbering, re-split`

### Task 7: Drafts + saved views services

**Files:**
- Create: `src/server/order-drafts.ts`, `src/server/saved-views.ts`
- Test: `tests/order-drafts.test.ts`, `tests/saved-views.test.ts`

**Interfaces (Produces):**
```ts
// order-drafts.ts — THE documented unaudited exception (spec §4). Direct prisma writes, own row only.
export async function getDraft(userId: string): Promise<{ payload: unknown; updatedAt: Date } | null>;
export async function putDraft(userId: string, payload: unknown): Promise<void>;   // upsert; payload ≤ 256 KB serialized (400 above)
export async function clearDraft(userId: string): Promise<void>;                   // payload → DbNull (an update, not a delete)

// saved-views.ts — audited normally.
export async function listViews(userId: string): Promise<SavedViewRow[]>;
export async function createView(userId: string, input: unknown): Promise<SavedViewRow>;  // { name, config, isDefault? }
export async function updateView(userId: string, id: string, input: unknown): Promise<SavedViewRow>;
export async function deleteView(userId: string, id: string): Promise<void>;   // soft; no reason (frees only a per-user name)
```
`config` is opaque `Json` to the server (client owns the shape: `{ columns: string[], filters: …, sort: … }`). `isDefault: true` clears the user's other defaults in the same tx (normalizer). Name: `.trim().min(1).max(80)`; `findFirst({ userId, name, deletedAt: null })` duplicate check (never `findUnique` — partial unique).

- [ ] **Step 1: Failing tests**: draft round-trip; clear nulls payload but keeps the row; oversize payload 400; **no audit rows from any draft call** (the §12.7 assertion); other users' drafts untouched. Views: CRUD own-rows-only (service takes userId — cross-user access is structurally impossible; test two users same view name OK); default normalizer (setting B default clears A); soft-deleted name reusable; audit entries exist for view create/update/delete.
- [ ] **Steps 2–4: FAIL → implement → PASS + gates.**  **Step 5: Commit** — `feat: order drafts (unaudited scratch) and saved board views`

### Task 8: Global search service

**Files:**
- Create: `src/server/search.ts`
- Test: `tests/search.test.ts`

**Interfaces (Produces):**
```ts
export type SearchResults = {
  exactOrderId: string | null;   // input is all digits AND matches a live order's number
  orders: { id: string; orderNumber: number; customerCode: string; poNumber: string; leadPartNumber: string }[];
  parts: { id: string; partNumber: string; customerCode: string; name: string }[];
  customers: { id: string; code: string; name: string }[];
};
export async function globalSearch(user: SessionUser, q: string): Promise<SearchResults>;
```
Groups the caller lacks `*.view` for come back EMPTY (permission-filtered inside the service via `can(user, area, "view")`; orders group covers number / PO / VS# / serial matches (serial via `OrderSerial` join); voided orders excluded; ≤ 10 rows per group, ordered by recency. `q.trim()` < 1 char → all empty.

- [ ] **Step 1: Failing tests**: exact number short-circuit (`"1042"` → `exactOrderId`, still fills groups); serial hit surfaces its order; PO and VS# hits; part by number (per-customer duplicate numbers BOTH returned with their customer codes — §15-decision heritage: a number alone never identifies a part); permission filtering (user with only `parts.view` gets empty orders+customers groups); voided excluded.
- [ ] **Steps 2–4: FAIL → implement → PASS + gates.**  **Step 5: Commit** — `feat: global search service`

### Task 9: Order routes + 401/403

**Files:**
- Create: `src/app/api/orders/route.ts` (GET list / POST create), `src/app/api/orders/export/route.ts`, `src/app/api/orders/[id]/route.ts` (GET / PATCH / DELETE void), `src/app/api/orders/[id]/lines/route.ts` (POST), `src/app/api/orders/[id]/lines/[lineId]/route.ts` (PATCH / DELETE), `src/app/api/orders/[id]/lines/[lineId]/serials/route.ts` (PUT), `src/app/api/orders/[id]/containers/route.ts` (PUT), `src/app/api/orders/[id]/charges/route.ts` (PUT), `src/app/api/orders/[id]/loads/route.ts` (PUT), `src/app/api/orders/[id]/loads/resplit/route.ts` (POST), `src/app/api/orders/[id]/link/route.ts` (POST), `src/app/api/orders/[id]/unlink/route.ts` (POST), `src/app/api/orders/entry-defaults/route.ts` (GET)
- Test: `tests/order-routes.test.ts`

Gates per the spec §9 table: list/get/export/entry-defaults `orders.view`; create `orders.create`; every edit `orders.edit`; DELETE = `mustDo(user, "void_order")` + `reasonFromBody`. `entry-defaults` takes `customerId` + optional `partId`, returns `{ requestDate: "yyyy-mm-dd" }` via the §6 chain (service helper exported from `orders.ts`).

- [ ] **Step 1: Failing tests** — the house 401/403 sweep shape: every handler 401 with no cookie, 403 with a session lacking the exact permission (`signInWith([])` / `signInWith(["orders.view"])` against an edit route, `signInWith(["orders.view","orders.create","orders.edit"])` against DELETE — void needs the special), 200 happy path each; DELETE with blank reason → the service's 400; ctx always `{ params: Promise.resolve({ id, lineId }) }`.
- [ ] **Steps 2–4: FAIL → implement (thin handlers, authorize → parse → delegate) → PASS + gates.**
- [ ] **Step 5: Commit** — `feat: order routes with permission gates`

### Task 10: Aux routes — drafts, saved views, search

**Files:**
- Create: `src/app/api/order-drafts/route.ts` (GET / PUT / DELETE — session only, own row: `requireUser().id`, no permission gate), `src/app/api/saved-views/route.ts` (GET / POST), `src/app/api/saved-views/[id]/route.ts` (PATCH / DELETE) — `orders.view` + own rows, `src/app/api/search/route.ts` (GET `?q=` — `requireUser` only; service filters groups)
- Test: `tests/aux-routes.test.ts`

- [ ] **Step 1: Failing tests**: drafts 401 unauthenticated, isolated per user (user A's PUT invisible to B's GET); saved-views 403 without `orders.view`, [id] routes 404 on another user's view (not 403 — no existence leak); search 401 only, and a `parts.view`-only session gets orders-empty results through the route.
- [ ] **Steps 2–4: FAIL → implement → PASS + gates.**  **Step 5: Commit** — `feat: draft, saved-view, and search routes`

### Task 11: Attachments — one story, two owners

**Files:**
- Create: `src/server/attachments.ts`, `src/app/api/parts/[id]/attachments/route.ts` (GET / POST), `src/app/api/parts/[id]/attachments/[attId]/route.ts` (GET bytes / DELETE), `src/app/api/orders/[id]/attachments/route.ts`, `src/app/api/orders/[id]/attachments/[attId]/route.ts`, `src/components/AttachmentsSection.tsx`
- Modify: `src/app/parts/[id]/page.tsx` (mount between pricing and process steps sections — exact slot: implementer picks adjacent to `CustomFieldsSection`, consistent spot on both pages)
- Test: `tests/attachments.test.ts`

**Interfaces (Produces):**
```ts
export type AttachmentOwner = "part" | "order";
export type AttachmentMeta = { id: string; filename: string; mimeType: string; size: number; createdAt: Date };
export async function listAttachments(owner: AttachmentOwner, ownerId: string): Promise<AttachmentMeta[]>;
export async function getAttachment(owner: AttachmentOwner, ownerId: string, attId: string): Promise<AttachmentMeta & { fileData: Buffer }>;
export async function addAttachment(owner: AttachmentOwner, ownerId: string,
  file: { filename: string; mimeType: string; data: Buffer }): Promise<AttachmentMeta>;
export async function deleteAttachment(owner: AttachmentOwner, ownerId: string, attId: string): Promise<void>;
```
One implementation keyed by owner (the `reference.ts` many-kinds pattern): owner row must be live (404 otherwise); 20 MB cap (400 names the limit); MIME allowlist `image/png image/jpeg image/gif image/webp application/pdf text/plain text/csv` + the two `openxmlformats` types (400 "That file type is not allowed"); audited create/soft-delete (snapshots carry metadata only — `fileData` redaction landed in Task 1). POST routes read `req.formData()` (`file` field + its `name`/`type`); GET bytes streams with `Content-Type` + `Content-Disposition: inline` for images/PDF, `attachment` otherwise. Gates: `.view` to list/get, `.edit` to add/delete, per owner area. `AttachmentsSection({ owner, ownerId, canEdit })` renders list + upload + delete with §5.16 disabled-not-hidden.

- [ ] **Step 1: Failing tests**: round-trip both owners through one suite loop; cap and allowlist 400s; owner-liveness 404 (soft-deleted part); cross-owner isolation (`getAttachment("order", orderId, partAttachmentId)` → 404); audit entries carry filename but never bytes; route 401/403 per area; GET disposition per type.
- [ ] **Steps 2–4: FAIL → implement service+routes+component, mount on the PART page (order hub mounts it in Task 14) → PASS + gates** (component behavior verified in Task 17's E2E; unit scope here is service+routes).
- [ ] **Step 5: Commit** — `feat: attachments — one story, part and order owners`

### Task 12: Board UI (home) + saved views + Shell search

**Files:**
- Modify: `src/app/page.tsx` (the board replaces the welcome), `src/components/Shell.tsx` (global search live; "Orders" nav → `/`)
- Test: extend `tests/permissions-sweep.test.ts` expectations only if the sweep flags the new client files (no server imports — verify, don't exempt)

**Behavior contract (client components against the Task 9/10 routes; §5.16 gating; `use-latest` on every fetch; failed fetches surface in the standard error banner — never `.catch(() => {})`):**
- Columns per spec §11 (order #, `CODE · name`, lead part, PO, qty, weight, received, request, target, light+status, loads, linked, VS #). Light renders color dot + text label. Voided rows (when toggled on) show status "Voided", muted.
- Filters: status multi-select, customer picker (session pick-list of live customers via existing customers API), received/request date ranges, include-voided toggle (default off), search box (server `search` param).
- Column picker: show/hide + reorder (spec §11); the current arrangement is what Save-view captures into `config.columns`.
- Saved views: dropdown (user's views + "Default board"), Save-view button (name prompt; "Set as default" checkbox), applies columns/filters/sort from `config`; delete view w/ confirm. Gated `orders.view` (the page 403s without it — standard shell handling).
- Export button → `/api/orders/export?…` with current filters.
- New Order button → `/orders/new`, gated `orders.create` (disabled + tooltip otherwise).
- Shell search: debounced 250 ms dropdown, grouped Orders/Parts/Customers; Enter with `exactOrderId` → `router.push('/orders/'+id)`; barcode scanners type digits + Enter — that path IS the scan path. Groups the API returns empty are omitted.

- [ ] **Step 1: Build the board page** (client component; fetch on mount + on filter change through `useLatest`).
- [ ] **Step 2: Build Shell search + nav change.**
- [ ] **Step 3: Manual smoke via dev server** (`npm run dev`, seeded admin): board renders empty-state, filters round-trip, search dropdown navigates. Gates (`tsc`, eslint, tests, build).
- [ ] **Step 4: Commit** — `feat: order board home page, saved views, live global search`

### Task 13: Order entry UI + autosave

**Files:**
- Create: `src/app/orders/new/page.tsx`
- Modify: none elsewhere (uses Task 2 lib utils + Task 9/10 routes)

**Behavior contract:**
- The §11 cascade with keyboard-first tab order; autocomplete pickers (customer by code/name; part by number within the chosen customer, showing which parts lack steps — those disabled with "No process steps" when picked as lead; riders allowed).
- Derived-until-touched (the 2C-3 lesson, stated in §11): weight per line = `eachWeight × qty` recomputing on qty change UNTIL the user edits weight (then theirs wins; a "reset to computed" affordance clears the override); request date = from `/api/orders/entry-defaults` until touched. **Draft stores ONLY typed values + override flags, never server-derived data.**
- Serial entry per line: text input; on Enter/blur, `expandSerialRange` (from `src/lib/serial-range.ts`) appends rows; per-row description input; dupes surfaced inline before save.
- Banners: customer standing order notes; credit hold ("⚠ ACME is on credit hold — orders can be entered; shipping will require release" — exact copy owner-visible, keep calm tone); serialization warning live per flagged line with 0 serials.
- Autosave: 2 s debounce PUT `/api/order-drafts`; on mount GET → if payload, "Draft from {time} — Resume / Discard" (Discard = DELETE). Save success → navigate to `/orders/[id]` (draft already cleared server-side); Save & Print → same, then trigger the hub's print action (Task 16 wires the print; until then the button renders disabled with "Traveler arrives later this phase" — remove that stub in Task 16).
- Save errors render field-anchored (the API's 400 messages) in the standard banner; **no reload-after-error** (§5.13).

- [ ] **Step 1: Build the page.**  **Step 2: Manual smoke: key the mockup's sibling order end-to-end against dev DB; verify draft resume by mid-entry reload.**  **Step 3: Gates.**
- [ ] **Step 4: Commit** — `feat: order entry with autosave drafts`

### Task 14: Order hub UI

**Files:**
- Create: `src/app/orders/[id]/page.tsx`
- Modify: `src/components/Shell.tsx` only if the hub needs a nav affordance (it should not — reached from board/search)

**Behavior contract (remounts per id — `key={id}`):**
- Sections per §11: Overview (scalars editable per Task 5 PATCH; Void button `gateDo("void_order")` with reason prompt; linked-orders panel with Link/Unlink); Lines (lead badge "Lead · Rev N locked"; rider add/remove/edit gated `orders.edit`; lead qty/weight editable, part never); Process (read-only render via the part's existing revision API `GET /api/parts/[partId]/process/revisions/[n]` — the 2C-3 routes; no new endpoint); Containers/Serials/Charges (bulk-edit grids PUTting the Task 5 endpoints); Loads (grid + Re-split button + both warnings rendered as amber banners); Notes; Attachments (`AttachmentsSection owner="order"`); Documents (list from Task 16's route — placeholder "No documents yet" section until Task 16 fills it); History (`HistoryPanel entity="order" entityId={id}`).
- Voided: red banner "Voided — {reason from latest audit entry}", every control read-only/disabled.
- Warnings from any mutation response render in the amber banner; errors in the red one; **rollback-before-report** on failed saves (§5.13: reload server truth first, then show why).

- [ ] **Step 1: Build the page.**  **Step 2: Manual smoke: edit scalars, riders, loads; void a scratch order; verify §5.16 tooltips with a restricted user.**  **Step 3: Gates.**
- [ ] **Step 4: Commit** — `feat: order hub page`

### Task 15: Delete-guard extensions + request-day overrides UI

**Files:**
- Modify: `src/server/parts.ts` (deletePart order-blockers), `src/server/customers.ts` (deleteCustomer order-blockers), `src/server/parts.ts`/`customers.ts` zod (accept `requestDaysOverride: z.number().int().min(0).nullable().optional()`), `src/app/parts/[id]/page.tsx` + `src/app/customers/[id]/page.tsx` (the override field, same commit — sibling habit)
- Test: extend `tests/parts.test.ts`, `tests/customers.test.ts`

- [ ] **Step 1: Failing tests**: deletePart refused while a live order's line references it — blocker rows `{ id: orderId, name: "#1042 · ACME", …detailPath "/orders/[id]" }` in the existing BlockerPanel shape + export; voided order does NOT block; deleteCustomer likewise (an order with only voided lines… any live order blocks); requestDaysOverride round-trips through create/update on both entities and 400s on negatives; audit diff shows the column.
- [ ] **Steps 2–3: implement service scans (same query shape as deleteCustomer's parts scan) + zod + UI fields → PASS + gates.**
- [ ] **Step 4: Commit** — `feat: live orders block part/customer deletion; request-day overrides`

### Task 16: Traveler — pdfmake pipeline, stored documents, print UI  ⚠ SAMPLES GATE

**PRECONDITION (spec §3.9/§10): the owner said samples-first.** `docs/samples/2025-aht-orderform-mockup.pdf` fixes the structure; **before starting, check `docs/samples/` for any additional real-document scans and ASK THE OWNER: (a) whether the samples are complete enough to build against, and (b) the two §3.9 mapping calls — the inspection sample-quantity column and the inspection-location image.** Do not guess; do not silently proceed on the mockup alone.

**Files:**
- Modify: `package.json` (add `pdfmake` ^0.2.x, `bwip-js` ^4.x — runtime `dependencies`; npm 12 will skip their install scripts if any — expected)
- Create: `src/server/pdf/render.ts` (pdfmake plumbing), `src/server/traveler.ts` (doc-definition builder + print/list/get), `src/app/api/orders/[id]/traveler/route.ts` (POST `?load=N` optional), `src/app/api/orders/[id]/documents/route.ts` (GET), `src/app/api/documents/[docId]/route.ts` (GET bytes)
- Modify: `src/app/orders/[id]/page.tsx` (print buttons + documents list live), `src/app/orders/new/page.tsx` (enable Save & Print)
- Test: `tests/traveler.test.ts`

**Interfaces (Produces):**
```ts
// pdf/render.ts
export async function renderPdf(def: TDocumentDefinitions): Promise<Buffer>;   // wraps pdfmake; smoke-tested for %PDF header
export async function barcodePng(text: string): Promise<Buffer>;               // bwip-js code128, returns PNG for data-URI embedding
// traveler.ts
export function buildTravelerDefinition(input: TravelerData): TDocumentDefinitions; // PURE — data in, JSON doc-definition out (the template-as-data contract, §10)
export async function printTraveler(orderId: string, loadNumber?: number): Promise<{ documentId: string; pdf: Buffer }>;
export async function listDocuments(orderId: string): Promise<{ id: string; kind: string; loadNumber: number | null; createdAt: Date }[]>;
export async function getDocument(docId: string): Promise<{ id: string; orderId: string; kind: string; loadNumber: number | null; createdAt: Date; fileData: Buffer }>;
// TravelerData: the builder's input, assembled by printTraveler from OrderDetail + the locked
// revision (via getRevision) + the lead part's inspections/material + company settings + the
// barcode PNG — implementer defines the exact type; buildTravelerDefinition stays pure.
```
`printTraveler`: 404 missing order; **400 "Cannot print a traveler for a voided order"**; renders one sheet-set per load (all loads when `loadNumber` omitted, that load only otherwise — each sheet's header carries `Order # / Load N / barcode(orderNumber)`), `auditedCreate("storedDocument", …)` with the bytes, returns them. Reprint = `getDocument` streaming stored bytes untouched. pdfmake wiring: try the vfs build (`pdfmake/build/pdfmake` + `vfs_fonts`) under Node first; if `getBuffer` misbehaves server-side, fall back to `new PdfPrinter(...)` with the vfs font data — **the smoke test is the gate, not hope.**

- [ ] **Step 0: THE GATE — samples + the two §3.9 answers from the owner.**
- [ ] **Step 1: Failing tests**: `%PDF` smoke; `buildTravelerDefinition` is pure and mirrors the mockup section order (assert on the definition's content tree: header carries order number + load number; steps section lists the LOCKED revision's steps with values — build a part, lock via an order, then CHANGE the working revision and assert the definition still shows the locked values; inspection rows present; footer blocks present); per-load render carries that load's qty; voided-order 400; stored-bytes-identical reprint (`Buffer.compare === 0`); documents list ordered newest-first; route 401/403 (`orders.view`).
- [ ] **Steps 2–4: FAIL → implement (npm install first) → PASS + all four gates.**
- [ ] **Step 5: Wire the hub + entry Save & Print; manual smoke: print the mockup-shaped sibling order, open the PDF, eyeball against `docs/samples/`.**
- [ ] **Step 6: Commit** — `feat: traveler PDFs — per-load sheets, stored exact reprints, barcode`

### Task 17: E2E flows + demo walkthrough + docs

**Files:**
- Create: `e2e/flows/order-entry-full.mjs`, `e2e/flows/board-search-scan.mjs`, `e2e/flows/loads-after-print.mjs`, `e2e/flows/void-order.mjs`
- Modify: `e2e/lib/db-fixtures.ts` (order fixtures + exact-key cleanup — the reaper stays exact-key, fixture-customer-scoped, localhost-gated)
- Create: `docs/2026-08-XX-phase-3-demo.md` (dated on the day it's written)
- Modify: `docs/HANDOFF.md` (§4a Phase 3 state; §9 next-kickoff → Phase 4), `CLAUDE.md` only if a new bite-worthy constraint emerged (pdfmake/Node quirk, if any)

- [ ] **Step 1: Flows** (each screenshots named checkpoints to `erp/e2e-artifacts/`): key the two-line sibling order (serials via `{001-005}`) → hub shows "Lead · Rev N locked" → print traveler → documents list grows → board shows the order with its light → global search exact number lands on the hub → edit a load → amber printed-warning appears → void with reason → board hides it until include-voided. `npm run test:e2e` 6/6 existing + 4 new.
- [ ] **Step 2: Demo doc** — screenshots + narrative (2C-3 precedent), presented to the owner before merge.
- [ ] **Step 3: HANDOFF updates** — §4a "Phase 3 DONE" block (tests count, gates, owner rulings recap pointing at spec §3), §9 kickoff prompt for Phase 4 (certs & shipping; inherits list from spec §16).
- [ ] **Step 4: Full gates + `npm run build` + both-DB migrate status clean. Commit** — `feat: phase 3 E2E flows; docs: demo walkthrough + handoff`

---

## Execution notes for the orchestrator

- Fresh subagent per task; independent spec+quality review per task (the loop is not ceremony — it caught real bugs in every prior phase); fix rounds until approved; final whole-branch review before merge; PR body carries the attribution, once.
- Tasks 2–3 are parallel-safe after Task 1. Tasks 4–8 are sequential on the service layer (5 and 6 touch `orders.ts` output types; 7–8 independent of 5–6 but cheap to keep ordered). 9–10 after their services. 11 after 9 (route conventions), before 14 (hub mounts it). 12–14 after 9–10. 15 anytime after 1 (guards read `Order`). 16 after 14 and THE SAMPLES GATE. 17 last.
- If the samples gate stalls (owner unavailable), reorder: run Task 17's non-traveler flows and docs prep, leave Task 16 + the traveler-dependent E2E checkpoints pending — do NOT fake a layout to keep moving.
