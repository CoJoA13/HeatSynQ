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
- [ ] **Step 3: Write `resolveCertSettings`** in `src/server/certs.ts` exactly as spec §6.1 — one query loading the customer's two defaults and the parts' two columns, plant settings read via `getSetting`, `??` chains per §6.1, `partIds[0]` treated as the lead.
- [ ] **Step 4: Freeze at save** — in `createOrder`'s transaction, after line validation and before the write, call `resolveCertSettings(tx, customerId, lines.map(l => l.partId))` and set `certRequired`/`certScope` on the created order. `customerJobNo` comes straight off the input (`.max(60)`, defaults `""`).
- [ ] **Step 5: Accept edits** — add `certRequired: z.boolean().optional()`, `certScope: z.enum(CERT_SCOPES).optional()`, `customerJobNo: z.string().max(60).optional()` to `UPDATE_ORDER`; add `customerContainerId: z.string().max(60).optional()` to the container item schema; add the four cert columns to the part and customer update schemas and their detail projections.
- [ ] **Step 6: Run the tests** — PASS. Also re-run `npx vitest run tests/orders.test.ts tests/parts.test.ts tests/customers.test.ts` — green.
- [ ] **Step 7: Gates + commit** — `feat(certs): resolution chain frozen onto the order at save`

---

