### Task 1: `invoice-constants.ts` + the two new settings

**Files:**
- Create: `src/lib/invoice-constants.ts`
- Modify: `src/server/settings.ts`
- Test: `tests/settings.test.ts`, `tests/allocate-number.test.ts`

**Interfaces:**
- Consumes: `allocateNumber(key: NumberSettingKey, tx: Prisma.TransactionClient): Promise<number>` and `numberSeed` (both existing, `src/server/settings.ts`).
- Produces:
```ts
// src/lib/invoice-constants.ts  (pure constants — safe to import from client components)
export const INVOICE_KINDS = ["INVOICE", "CREDIT"] as const;
export type InvoiceKindValue = (typeof INVOICE_KINDS)[number];
export const INVOICE_KIND_LABELS: Record<InvoiceKindValue, string>;

export const INVOICE_STATUSES = ["DRAFT", "FINALIZED"] as const;
export type InvoiceStatusValue = (typeof INVOICE_STATUSES)[number];
export const INVOICE_STATUS_LABELS: Record<InvoiceStatusValue, string>;

export const INVOICE_LINE_KINDS = ["PART", "OPERATION", "SURCHARGE", "FREIGHT", "CHARGE", "CERT", "TAX"] as const;
export type InvoiceLineKindValue = (typeof INVOICE_LINE_KINDS)[number];
export const INVOICE_LINE_KIND_LABELS: Record<InvoiceLineKindValue, string>;

export const PRICE_SOURCES = ["PART_PRICE", "MANUAL"] as const;
export type PriceSourceValue = (typeof PRICE_SOURCES)[number];
export const PRICE_SOURCE_LABELS: Record<PriceSourceValue, string>;

export const SURCHARGE_KINDS = ["PERCENT", "FLAT"] as const;
export type SurchargeKindValue = (typeof SURCHARGE_KINDS)[number];
export const SURCHARGE_KIND_LABELS: Record<SurchargeKindValue, string>;

export const SURCHARGE_SCOPES = ["ALL", "INCLUDE", "EXCLUDE"] as const;
export type SurchargeScopeValue = (typeof SURCHARGE_SCOPES)[number];
export const SURCHARGE_SCOPE_LABELS: Record<SurchargeScopeValue, string>;

// src/server/settings.ts — two new SETTINGS keys:
//   credit_number_next     (numberSeed, default 1000)
//   invoice_number_prefix  (z.string(), default "")
```

- [ ] **Step 1: Write the failing tests.** Append to `tests/allocate-number.test.ts`:

```ts
it("allocates credit numbers from the new counter", async () => {
  const first = await prisma.$transaction((tx) => allocateNumber("credit_number_next", tx));
  const second = await prisma.$transaction((tx) => allocateNumber("credit_number_next", tx));
  expect(first).toBe(1000);
  expect(second).toBe(1001);
});
```

and to `tests/settings.test.ts`:

```ts
it("round-trips the invoice number prefix", async () => {
  await setSetting("invoice_number_prefix", "7");
  expect(await getSetting("invoice_number_prefix")).toBe("7");
});

it("rejects a zero credit number seed", async () => {
  await expect(setSetting("credit_number_next", 0)).rejects.toThrow(/Invalid|Too small/i);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/allocate-number.test.ts tests/settings.test.ts`. Expected: FAIL, `Unknown setting: credit_number_next` (and `invoice_number_prefix` is not assignable to `SettingKey`, so `tsc` errors too).

- [ ] **Step 3: Create `src/lib/invoice-constants.ts`** — every array and label map from the Produces block, with real labels:

```ts
// Pure constants only — no server-only imports. Safe to import from client components.
// The arrays must list the same members in the same order as the Prisma enums in Task 2.
export const INVOICE_KINDS = ["INVOICE", "CREDIT"] as const;
export type InvoiceKindValue = (typeof INVOICE_KINDS)[number];
export const INVOICE_KIND_LABELS: Record<InvoiceKindValue, string> = {
  INVOICE: "Invoice",
  CREDIT: "Credit",
};

export const INVOICE_STATUSES = ["DRAFT", "FINALIZED"] as const;
export type InvoiceStatusValue = (typeof INVOICE_STATUSES)[number];
export const INVOICE_STATUS_LABELS: Record<InvoiceStatusValue, string> = {
  DRAFT: "Draft",
  FINALIZED: "Finalized",
};

export const INVOICE_LINE_KINDS = ["PART", "OPERATION", "SURCHARGE", "FREIGHT", "CHARGE", "CERT", "TAX"] as const;
export type InvoiceLineKindValue = (typeof INVOICE_LINE_KINDS)[number];
export const INVOICE_LINE_KIND_LABELS: Record<InvoiceLineKindValue, string> = {
  PART: "Part",
  OPERATION: "Operation",
  SURCHARGE: "Surcharge",
  FREIGHT: "Freight",
  CHARGE: "Charge",
  CERT: "Certification",
  TAX: "Sales tax",
};

export const PRICE_SOURCES = ["PART_PRICE", "MANUAL"] as const;
export type PriceSourceValue = (typeof PRICE_SOURCES)[number];
export const PRICE_SOURCE_LABELS: Record<PriceSourceValue, string> = {
  PART_PRICE: "Part price",
  MANUAL: "Manual",
};

export const SURCHARGE_KINDS = ["PERCENT", "FLAT"] as const;
export type SurchargeKindValue = (typeof SURCHARGE_KINDS)[number];
export const SURCHARGE_KIND_LABELS: Record<SurchargeKindValue, string> = {
  PERCENT: "Percent",
  FLAT: "Flat amount",
};

export const SURCHARGE_SCOPES = ["ALL", "INCLUDE", "EXCLUDE"] as const;
export type SurchargeScopeValue = (typeof SURCHARGE_SCOPES)[number];
export const SURCHARGE_SCOPE_LABELS: Record<SurchargeScopeValue, string> = {
  ALL: "All operations",
  INCLUDE: "Only these operations",
  EXCLUDE: "All except these",
};
```

- [ ] **Step 4: Add the two settings** to `SETTINGS` in `src/server/settings.ts`, in the `Numbering` group beside the existing counters:

```ts
  credit_number_next: { schema: numberSeed, default: 1000, label: "Next credit number", group: "Numbering" },
  // The invoice's number IS the order number (spec §3.2 — the sample's "7 −" is a plant/form
  // code, not a sequence). This prefix is what prints ahead of it.
  invoice_number_prefix: { schema: z.string(), default: "", label: "Invoice number prefix", group: "Numbering" },
```

and **extend the existing "intentionally unused" comment** so it covers `invoice_number_next` too:

```ts
  // Intentionally unused for the rest of the project — certifications carry no number of their own
  // (P4 §3.19) and an invoice is identified by its order number (5A §3.2). Left in place rather
  // than removed; do not wire either of these up to anything.
  invoice_number_next: { schema: numberSeed, default: 1000, label: "Next invoice number", group: "Numbering" },
  cert_number_next: { schema: numberSeed, default: 1000, label: "Next certification number", group: "Numbering" },
```

- [ ] **Step 5: Run the tests** — `npx vitest run tests/allocate-number.test.ts tests/settings.test.ts`. Expected: PASS.
- [ ] **Step 6: Check the settings page renders them** — `src/lib/settings-ui.ts` drives the widgets by key; `invoice_number_prefix` is a plain string and needs no `TEXTAREA_KEYS` entry. Confirm `npx tsc --noEmit` is clean.
- [ ] **Step 7: Gates + commit** — `feat(settings): add credit numbering and the invoice number prefix`

---

