## Task 2: BillingConfig GL defaults — service, delete-blocker registry, admin UI

**Files:**
- Modify: `erp/src/server/billing-config.ts`
- Modify: `erp/src/lib/reference-links.ts`
- Modify: `erp/tests/reference-links-sweep.test.ts`
- Modify: `erp/src/app/admin/billing/page.tsx`
- Test: `erp/tests/billing-config.test.ts`

**Interfaces:**
- Consumes: `assertRefExists("glAccount", id, tx)`, `setBillingConfig`/`getBillingConfig` (existing).
- Produces: `BillingConfigRow` gains `arGlAccountId`/`discountGlAccountId`/`writeOffGlAccountId: string | null`, read by `gl-mapping.ts`/`gl-export.ts`/`close-periods.ts`.

- [ ] **Step 1: Write the failing service test.** In `erp/tests/billing-config.test.ts` add (mirror the existing round-trip + blocker tests):

```ts
it("round-trips the three 5C GL defaults and blocks deleting an account in use", async () => {
  const gl = await prisma.glAccount.create({ data: { name: "1200", description: "A/R" } });
  const saved = await asSystem(() => setBillingConfig({ arGlAccountId: gl.id }));
  expect(saved.arGlAccountId).toBe(gl.id);
  await expect(asSystem(() => deleteReference("glAccount", gl.id))).rejects.toThrow();
  const blockers = await findBlockers("glAccount", gl.id);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].entityLabel).toBe("Billing settings");
  expect(blockers[0].href).toBe("/admin/billing");
});

it("refuses a discount/write-off GL account that does not exist", async () => {
  await expect(asSystem(() => setBillingConfig({ discountGlAccountId: "nope" })))
    .rejects.toThrow("That gl account does not exist");
});

// Proves GL_POSTING_BLOCKER at runtime (its include/displayName/liveWhere:{} can't be checked by
// the static sweep). Build the rows directly — no export service exists yet in this task.
it("a GL account on a sent GlPosting blocks its deletion, named by the export batch", async () => {
  const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Revenue" } });
  const period = await prisma.closePeriod.create({ data: { year: 2026, month: 7, beginningAr: 0,
    invoicedTotal: 0, creditTotal: 0, paymentTotal: 0, discountTotal: 0, writeOffTotal: 0, endingAr: 0, agingEndingAr: 0 } });
  const batch = await prisma.glExportBatch.create({ data: { exportNumber: 1000, closePeriodId: period.id,
    periodEnd: new Date("2026-07-31"), fileName: "x.csv", file: new Uint8Array([1]), register: new Uint8Array([2]) } });
  await prisma.glPosting.create({ data: { batchId: batch.id, sourceType: "INVOICE", sourceId: "i1",
    glDate: new Date("2026-07-15"), glAccountId: gl.id, glAccountName: "4010", debit: 100, credit: 0, side: "SALES" } });
  const blockers = await findBlockers("glAccount", gl.id);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].entityLabel).toBe("GL export");
  expect(blockers[0].name).toBe("GL export #1000");
});
```

- [ ] **Step 2: Run it red.**

```bash
npx vitest run tests/billing-config.test.ts -t "round-trips the three 5C GL defaults"
```

Expected: FAIL (`arGlAccountId` not on the returned row / not accepted by `SAVE`).

- [ ] **Step 3: Extend `billing-config.ts` in the five lockstep spots.** (a) `BillingConfigRow` type — add `arGlAccountId: string | null;`, `discountGlAccountId: string | null;`, `writeOffGlAccountId: string | null;`. (b) the `EMPTY` fallback — add `arGlAccountId: null,` etc. (c) the `SAVE` zod — add `arGlAccountId: z.string().nullable().optional(),` etc. (d) `getBillingConfig`'s return mapping — add `arGlAccountId: row.arGlAccountId,` (raw string, **not** `.toNumber()`). (e) `setBillingConfig` — add the three to the `assigns` boolean and add three guards:

```ts
if (data.arGlAccountId) await assertRefExists("glAccount", data.arGlAccountId, tx);
if (data.discountGlAccountId) await assertRefExists("glAccount", data.discountGlAccountId, tx);
if (data.writeOffGlAccountId) await assertRefExists("glAccount", data.writeOffGlAccountId, tx);
```

- [ ] **Step 4: Register the FKs in `reference-links.ts`.** The schema Task 1 added carries **four** new reference-targeting `@relation` FKs at `glAccount`: the three `BillingConfig` defaults **and** `GlPosting.glAccountId` (a frozen `onDelete: SetNull` snapshot, the `InvoiceLine.glAccountId` precedent). The sweep exempts only `onDelete: Cascade`, so all four must be registered or the build stays red. Add `"glPosting"` to the `ReferenceLinkModel` union, then a `GL_POSTING_BLOCKER` const + the four entries:

```ts
// GlPosting has no `deletedAt` (append-only), so `liveWhere: {}` is required (the BillingConfig
// precedent); the row a person can act on is its export batch (the INVOICE_VIA_LINE shape).
const GL_POSTING_BLOCKER = {
  entityLabel: "GL export",
  detailPath: () => "/receivables/close",
  liveWhere: {},
  include: { batch: { select: { id: true, exportNumber: true } } },
  blockerId: (r: Record<string, unknown>) => String((r.batch as { id: string }).id),
  displayName: (r: Record<string, unknown>) => `GL export #${(r.batch as { exportNumber: number }).exportNumber}`,
} as const;
```

```ts
{ model: "billingConfig", column: "arGlAccountId", targetKind: "glAccount",
  label: "A/R GL account", ...BILLING_CONFIG_BLOCKER },
{ model: "billingConfig", column: "discountGlAccountId", targetKind: "glAccount",
  label: "Discount GL account", ...BILLING_CONFIG_BLOCKER },
{ model: "billingConfig", column: "writeOffGlAccountId", targetKind: "glAccount",
  label: "Write-off GL account", ...BILLING_CONFIG_BLOCKER },
{ model: "glPosting", column: "glAccountId", targetKind: "glAccount",
  label: "GL account", ...GL_POSTING_BLOCKER },
```

Registering `GlPosting.glAccountId` here blocks deleting a GL account that appears on a sent export — the same "posted history is permanent" call the `invoiceLine`/`processStepCode` entries make; in practice the account is already blocked by the invoice line or payment type that generated the posting, so this adds no new restriction, only satisfies the sweep. `db.glPosting` exists as a Prisma delegate, so `findBlockers` needs no change.

- [ ] **Step 5: Update the sweep's expected-offenders list.** In `erp/tests/reference-links-sweep.test.ts`, the `finds every known reference FK when nothing is registered` case asserts a `.sort()`-ed exact array — add **four** entries in sorted position (the test `.sort()`s, so exact placement follows string order — `glPosting` sorts after `customerSurcharge` and before `invoiceLine`):

```ts
      "billingConfig.arGlAccountId -> glAccount",        // sorts before certChargeStepCodeId
      "billingConfig.discountGlAccountId -> glAccount",  // between certChargeStepCodeId and freightGlAccountId
      "billingConfig.writeOffGlAccountId -> glAccount",  // after salesTaxGlAccountId
      "glPosting.glAccountId -> glAccount",              // after customerSurcharge.*, before invoiceLine.*
```

- [ ] **Step 6: Run the service + sweep tests green.**

```bash
npx vitest run tests/billing-config.test.ts tests/reference-links-sweep.test.ts
```

Expected: PASS.

- [ ] **Step 7: Add the three admin selects.** In `erp/src/app/admin/billing/page.tsx`: extend the `Cfg` type with the three `string | null` fields, then add three `<select>` blocks copying the existing "Freight GL account" block verbatim, changing only the field name (in `value`/`onChange`/`savedMark`) and the `<span>` label (e.g. "A/R GL account", "Discount GL account", "Write-off GL account"). `glAccounts` and `save()` need no change.

- [ ] **Step 8: Verify the admin flow in the browser and run E2E.** This touches a UI flow. Verify the three selects render and save (preview_start the dev server, navigate to `/admin/billing`, set each, confirm the saved mark), then:

```bash
npm run test:e2e
```

Expected: all flows pass.

- [ ] **Step 9: Commit.**

```bash
git add erp/src/server/billing-config.ts erp/src/lib/reference-links.ts erp/tests/reference-links-sweep.test.ts erp/tests/billing-config.test.ts erp/src/app/admin/billing/page.tsx
git commit -m "feat(5c): BillingConfig A/R, discount, write-off GL defaults + admin UI"
```

---

