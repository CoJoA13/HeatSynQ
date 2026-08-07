### Task 6: `surcharges.ts` — definitions, the step-code list, customer overrides

**Files:**
- Create: `src/server/surcharges.ts`
- Modify: `src/lib/reference-links.ts`, `tests/reference-links-sweep.test.ts`
- Test: `tests/surcharges.test.ts`

**Interfaces:**
- Consumes: `assertRefExists`, `findBlockers` (`src/server/reference-blockers.ts:23`), `TARGET_LABELS`, the `SURCHARGE_KINDS` / `SURCHARGE_SCOPES` constants from Task 1.
- Produces:
```ts
// src/server/surcharges.ts
export type SurchargeRow = {
  id: string; name: string; kind: SurchargeKindValue;
  rate: number | null; amount: number | null; minimumAmount: number | null;
  glAccountId: string | null; glAccountName: string | null; needsGlAccount: boolean;
  scope: SurchargeScopeValue; position: number; active: boolean;
  stepCodeIds: string[];
};
export async function listSurcharges(opts?: { includeInactive?: boolean }): Promise<SurchargeRow[]>;
export async function createSurcharge(input: unknown): Promise<{ id: string }>;
export async function updateSurcharge(id: string, input: unknown): Promise<void>;
export async function deleteSurcharge(id: string): Promise<void>;
export async function setSurchargeStepCodes(id: string, stepCodeIds: string[]): Promise<void>;

export type CustomerSurchargeRow = {
  surchargeId: string; surchargeName: string;
  optOut: boolean; rate: number | null; amount: number | null;
};
export async function listCustomerSurcharges(customerId: string): Promise<CustomerSurchargeRow[]>;
export async function setCustomerSurcharge(customerId: string, surchargeId: string, input: unknown): Promise<void>;
```

- [ ] **Step 1: Write the failing tests** `tests/surcharges.test.ts` on the same harness:

```ts
it("creates a percent surcharge and lists it with its GL account name", async () => {
  const gl = await prisma.glAccount.create({ data: { name: "4200", description: "Energy surcharge" } });
  await asSystem(() => createSurcharge({
    name: "EnergySur", kind: "PERCENT", rate: "0.040000", glAccountId: gl.id, scope: "ALL", position: 1 }));
  const rows = await listSurcharges();
  expect(rows[0].name).toBe("EnergySur");
  expect(rows[0].rate).toBe(0.04);
  expect(rows[0].glAccountName).toBe("4200");
  expect(rows[0].needsGlAccount).toBe(false);
});

it("requires a rate for PERCENT and an amount for FLAT, and rejects both", async () => {
  await expect(asSystem(() => createSurcharge({ name: "A", kind: "PERCENT", position: 1 })))
    .rejects.toThrow("A percent surcharge needs a rate");
  await expect(asSystem(() => createSurcharge({ name: "B", kind: "FLAT", position: 1 })))
    .rejects.toThrow("A flat surcharge needs an amount");
  await expect(asSystem(() => createSurcharge({
    name: "C", kind: "PERCENT", rate: "0.04", amount: "5.00", position: 1 })))
    .rejects.toThrow("A percent surcharge cannot also carry a flat amount");
});

it("re-uses a soft-deleted name as a genuinely new row", async () => {
  const { id: first } = await asSystem(() => createSurcharge({ name: "EnergySur", kind: "FLAT", amount: "5.00", position: 1 }));
  await asSystem(() => deleteSurcharge(first));
  const { id: second } = await asSystem(() => createSurcharge({ name: "EnergySur", kind: "FLAT", amount: "6.00", position: 1 }));
  expect(second).not.toBe(first);
});

it("replaces the step-code list wholesale", async () => {
  const a = await prisma.processStepCode.create({ data: { code: "AUST", name: "Austemper" } });
  const b = await prisma.processStepCode.create({ data: { code: "WASH", name: "Hot wash" } });
  const { id } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", scope: "EXCLUDE", position: 1 }));
  await asSystem(() => setSurchargeStepCodes(id, [a.id, b.id]));
  await asSystem(() => setSurchargeStepCodes(id, [b.id]));
  const rows = await listSurcharges();
  expect(rows[0].stepCodeIds).toEqual([b.id]);
});

it("refuses to delete a surcharge a customer rule points at, and names the blocker", async () => {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
  const { id } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", position: 1 }));
  await asSystem(() => setCustomerSurcharge(customer.id, id, { optOut: true }));
  await expect(asSystem(() => deleteSurcharge(id))).rejects.toThrow(/still in use by 1 record/);
  const blockers = await findBlockers("surcharge", id);
  expect(blockers[0].entityLabel).toBe("Customer");
  expect(blockers[0].name).toContain("ACME");
});

// Task 2 hand-wrote SURCHARGE_VIA_STEP_CODE to repair a defect in this plan's own registry
// snippet; its displayName/blockerId have never run. SurchargeStepCode is a join row with no
// name of its own, so without them a blocker panel would show a bare cuid at a person.
it("refuses to delete a step code a surcharge scopes on, naming the surcharge", async () => {
  const code = await prisma.processStepCode.create({ data: { code: "WASH", name: "Hot wash" } });
  const { id } = await asSystem(() => createSurcharge({
    name: "EnergySur", kind: "FLAT", amount: "1.00", scope: "EXCLUDE", position: 1 }));
  await asSystem(() => setSurchargeStepCodes(id, [code.id]));
  await expect(asSystem(() => deleteStepCode(code.id))).rejects.toThrow(/still in use by 1 record/);
  const blockers = await findBlockers("processStepCode", code.id);
  expect(blockers.some((b) => b.name.includes("EnergySur"))).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/surcharges.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Make `surcharge` a `BlockerTarget`** — all four edits in one commit-step so the sweep is never red:
  - `src/lib/reference-links.ts`: `export type BlockerTarget = ReferenceKind | "processStepCode" | "surcharge";`, `TARGET_LABELS` gains `surcharge: "surcharge"` (widen its type to `Record<"processStepCode" | "surcharge", string>`), `ReferenceLinkModel` gains `"customerSurcharge"` and `"invoiceLine"` (the latter is already added in Task 2), and two entries:

```ts
{ model: "customerSurcharge", column: "surchargeId", targetKind: "surcharge",
  label: "Surcharge", entityLabel: "Customer",
  detailPath: (id) => `/customers/${id}`,
  include: { customer: { select: { id: true, code: true, name: true } } },
  blockerId: (r) => String((r.customer as { id: string }).id),
  displayName: (r) => {
    const c = r.customer as { code: string; name: string };
    return `${c.code} · ${c.name}`;
  } },
{ model: "invoiceLine", column: "surchargeId", targetKind: "surcharge",
  label: "Surcharge", ...INVOICE_VIA_LINE },
```

  - `tests/reference-links-sweep.test.ts`: add `kinds.add("surcharge");` beside the existing `kinds.add("processStepCode");` (line 55), with a comment saying why — a surcharge is a maintained table with a delete guard, exactly like a step code, and an unregistered FK aimed at it must fail the sweep.

- [ ] **Step 4: Write `src/server/surcharges.ts`.** `createSurcharge` / `updateSurcharge` follow `createStepCode` / `updateStepCode` verbatim (`process-step-codes.ts:86-125`) — `findFirst` on the live name, conditional Serializable when `glAccountId` is assigned, `assertRefExists("glAccount", …, tx)` inside the transaction. `deleteSurcharge` follows `deleteStepCode` (`:142-148`) — `findBlockers("surcharge", id, tx)` inside one Serializable transaction, refusing with ``That ${TARGET_LABELS.surcharge} is still in use by ${blockers.length} record(s)``. `setSurchargeStepCodes` is a **replace grid with no soft delete** — `deleteMany({ where: { surchargeId } })` then `createMany`, inside `auditedUpdate("surcharge", id, …, { tx })` so one audit row describes the whole replacement, with `assertRefExists("processStepCode", …, tx)` per id and Serializable.

  The kind/amount consistency rules live in a zod `.superRefine`, not in the service body, so the messages are field-anchored:

```ts
const SAVE = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(SURCHARGE_KINDS),
  rate: decimalField(9, 6, { min: "nonnegative" }),
  amount: decimalField(12, 2, { min: "nonnegative" }),
  minimumAmount: decimalField(12, 2, { min: "nonnegative" }),
  glAccountId: z.string().nullable().optional(),
  scope: z.enum(SURCHARGE_SCOPES).optional(),
  position: z.number().int().min(0),
  active: z.boolean().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.kind === "PERCENT") {
    if (v.rate == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rate"], message: "A percent surcharge needs a rate" });
    if (v.amount != null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amount"], message: "A percent surcharge cannot also carry a flat amount" });
  } else {
    if (v.amount == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amount"], message: "A flat surcharge needs an amount" });
    if (v.rate != null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rate"], message: "A flat surcharge cannot also carry a rate" });
  }
});
```

  `needsGlAccount: r.glAccountId === null` mirrors `listStepCodes` (`process-step-codes.ts:80`) — surfaced in the UI now, asserted by 5C's export later.

- [ ] **Step 5: Run the tests** — `npx vitest run tests/surcharges.test.ts tests/reference-links-sweep.test.ts`. Expected: PASS.
- [ ] **Step 6: Gates + commit** — `feat: surcharge definitions with per-operation scope and customer overrides`

---

