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

