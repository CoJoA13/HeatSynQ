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
export async function replaceResults(certId: string, input: unknown, opts: { afterPrint: boolean }): Promise<CertDetail>;
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
  const saved = await replaceResults(cert.id, {
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
  await expect(replaceResults(cert.id, { requirements: [] }, { afterPrint: false }))
    .rejects.toThrow(/already been printed/i);
  await expect(replaceResults(cert.id, { requirements: [] }, { afterPrint: true })).resolves.toBeTruthy();
});
```

- [ ] **Step 4: Run to verify failure.**
- [ ] **Step 5: Implement.** `seedRequirements` loads the cert's order lines with their parts' live `PartInspection` rows (`orderBy: { sort: "asc" }`), writes requirements with a cert-wide running `position`, and calls `assertRefExists("inspectionCode", …, tx)` / `assertRefExists("inspectionScale", …, tx)` per row — which is why the enclosing transaction is Serializable. `replaceResults` runs `withDbErrors` → Serializable `$transaction` → `auditedUpdate("cert", …)` → delete-and-recreate readings under each requirement (requirements themselves are never re-seeded — the frozen copy is the point), computing `passed` with `computePassed` unless the row sets `overridden: true`, in which case the supplied `passed` is stored verbatim. A requirement id not belonging to this cert is a 400 naming it.
- [ ] **Step 6: Run the tests** — PASS. Add an audit-content assertion: a reading change produces a real cert-level before/after diff carrying both values.
- [ ] **Step 7: Wire Task 5's call** — `createCert` now genuinely calls `seedRequirements`; re-run `tests/certs.test.ts`.
- [ ] **Step 8: Gates + commit** — `feat(certs): seeded requirements, multi-reading results, computed pass/fail`

---

