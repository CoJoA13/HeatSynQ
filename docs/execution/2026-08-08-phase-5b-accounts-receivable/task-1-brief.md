### Task 1: `ar-constants.ts`, the `receivables` permission area, and the batch-number counter

**Files:**
- Create: `src/lib/ar-constants.ts`
- Modify: `src/lib/permission-constants.ts` (add area + special action), `src/server/settings.ts` (add the counter)
- Test: `tests/permissions.test.ts`, `tests/permissions-sweep.test.ts`, `tests/settings.test.ts`, `tests/allocate-number.test.ts`, `tests/partial-unique-sweep.test.ts`

**Interfaces:**
- Consumes: `AREAS`, `SPECIAL_ACTIONS` (`src/lib/permission-constants.ts`); `numberSeed`, `allocateNumber(key: NumberSettingKey, tx)` (`src/server/settings.ts`).
- Produces:
```ts
// src/lib/ar-constants.ts — pure, client-safe
export const APPLICATION_TYPES = ["PAYMENT", "DISCOUNT", "WRITE_OFF", "CREDIT"] as const;
export type ApplicationTypeValue = (typeof APPLICATION_TYPES)[number];
export const APPLICATION_TYPE_LABELS: Record<ApplicationTypeValue, string> = {
  PAYMENT: "Payment", DISCOUNT: "Discount", WRITE_OFF: "Write-off", CREDIT: "Credit applied",
};
export const RECEIPT_BATCH_STATUSES = ["OPEN", "POSTED"] as const;
export type ReceiptBatchStatusValue = (typeof RECEIPT_BATCH_STATUSES)[number];
export const AGING_BUCKETS = ["CURRENT", "D1_30", "D31_60", "D61_90", "D90_PLUS"] as const;
export type AgingBucketValue = (typeof AGING_BUCKETS)[number];
export const AGING_BUCKET_LABELS: Record<AgingBucketValue, string> = {
  CURRENT: "Current", D1_30: "1–30", D31_60: "31–60", D61_90: "61–90", D90_PLUS: "90+",
};
```
`AREAS` gains `"receivables"`; `SPECIAL_ACTIONS` gains `"write_off"`; `SettingKey` gains `"receipt_batch_number_next"` (the `_number_next` suffix is REQUIRED — `NumberSettingKey = Extract<SettingKey, \`${string}_number_next\`>` is what makes it valid for `allocateNumber`; the spec's shorthand "receipt_batch_next" maps to this).

- [ ] **Step 1: Write the failing permission test.** In `tests/permissions.test.ts`, add:
```ts
it("has a receivables area and a write_off special action", () => {
  expect(AREAS).toContain("receivables");
  expect(SPECIAL_ACTIONS).toContain("write_off");
});
```
- [ ] **Step 2: Run it — Expected: FAIL** (`AREAS` does not contain "receivables").
Run: `npx vitest run tests/permissions.test.ts -t "receivables area"`
- [ ] **Step 3: Add the area and action.** In `src/lib/permission-constants.ts` append `"receivables"` to the `AREAS` array (keep one entry per line) and `"write_off"` to `SPECIAL_ACTIONS`.
- [ ] **Step 4: Run it — Expected: PASS.**
- [ ] **Step 5: Write the failing settings test.** In `tests/allocate-number.test.ts`, add a case allocating `receipt_batch_number_next` twice and asserting it returns `1000` then `1001` (the `order_number_next` precedent already in that file).
- [ ] **Step 6: Run it — Expected: FAIL** (unknown setting key).
- [ ] **Step 7: Register the counter + create `ar-constants.ts`.** Add to `settings.ts`'s registry: `receipt_batch_number_next: { schema: numberSeed, default: 1000, label: "Next receipt-batch number", group: "Numbering" }`. Create `src/lib/ar-constants.ts` with the block above.
- [ ] **Step 8: Run it — Expected: PASS.**
- [ ] **Step 9: Extend the partial-unique sweep exemption.** `ReceiptBatch.batchNumber` (Task 2) will be plain `@unique`. In `tests/partial-unique-sweep.test.ts`, add `"ReceiptBatch.batchNumber"` to the documented allow-list beside `Invoice.creditNumber`, with the comment "allocation-only, never reissued — a voided batch keeps its number".
- [ ] **Step 10: Run the sweeps + gates.** `npx vitest run tests/permissions-sweep.test.ts tests/partial-unique-sweep.test.ts`, then `/gates`. Expected: PASS.
- [ ] **Step 11: Commit.**
```bash
git add src/lib/ar-constants.ts src/lib/permission-constants.ts src/server/settings.ts tests/
git commit -m "feat(5b): A/R constants, receivables permission area, receipt-batch counter"
```

---

