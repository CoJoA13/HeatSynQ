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
  await replaceResults(cert.id, oneReading(cert, "30.0"), { afterPrint: false });
  await resplitLoads(order.id);
  const after = await getCert(cert.id);
  expect(after.deletedAt).toBeNull();
  expect(after.requirements[0].readings[0].value).toBe(30);
  expect(after.loadNumber).toBe(3);
});
```

(Depends on Task 6's `replaceResults`; if this task runs first, assert the cert's survival and `loadNumber` only and add the readings assertion when Task 6 lands.)

- [ ] **Step 7: Run the tests** — PASS. Add an audit-content assertion: voiding writes an entry whose payload carries the reason, and updating `freeform` produces a real before/after diff.
- [ ] **Step 8: Gates + commit** — `feat(certs): scope-aware creation, listing, export and void`

---

