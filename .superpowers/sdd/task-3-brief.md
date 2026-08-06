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

