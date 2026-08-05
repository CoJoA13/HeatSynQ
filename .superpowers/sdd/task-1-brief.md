### Task 1: `allocateNumber` key guard (issue #34) + five new settings

**Files:**
- Modify: `src/server/settings.ts`
- Create: `src/lib/cert-constants.ts`
- Test: `tests/allocate-number.test.ts`, `tests/settings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
```ts
// src/server/settings.ts
export type NumberSettingKey = Extract<SettingKey, `${string}_number_next`>;
export async function allocateNumber(key: NumberSettingKey, tx: Prisma.TransactionClient): Promise<number>;
// new SETTINGS keys: bol_number_next, cert_required_default, cert_scope_default,
//                    cert_statement, shipper_liability_text

// src/lib/cert-constants.ts  (pure constants — safe to import from client components)
export const CERT_SCOPES = ["ORDER", "LOAD", "SHIPMENT"] as const;
export type CertScopeValue = (typeof CERT_SCOPES)[number];
export const CERT_SCOPE_LABELS: Record<CertScopeValue, string>;   // "By order" | "By load" | "By shipment"
export const FREIGHT_TERMS = ["PREPAID", "COLLECT"] as const;
export type FreightTermsValue = (typeof FREIGHT_TERMS)[number];
export const FREIGHT_TERMS_LABELS: Record<FreightTermsValue, string>;  // "Prepaid" | "Collect"
```

- [ ] **Step 1: Write the failing tests** in `tests/allocate-number.test.ts`:

```ts
it("allocates from a new numbering key", async () => {
  const n = await prisma.$transaction((tx) => allocateNumber("bol_number_next", tx));
  expect(n).toBe(1000);
  const again = await prisma.$transaction((tx) => allocateNumber("bol_number_next", tx));
  expect(again).toBe(1001);
});

it("refuses a non-numbering key at runtime", async () => {
  await expect(
    prisma.$transaction((tx) =>
      // @ts-expect-error — NumberSettingKey excludes this; the runtime guard is the backstop
      allocateNumber("company_name", tx)),
  ).rejects.toThrow(/not a numbering key/i);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/allocate-number.test.ts`. Expected: unknown setting `bol_number_next`, and no `@ts-expect-error` needed yet (so that line errors too).
- [ ] **Step 3: Create `src/lib/cert-constants.ts`** exactly as the Produces block above. No server imports.
- [ ] **Step 4: Add the five settings** to `SETTINGS` in `src/server/settings.ts`, importing `CERT_SCOPES` from `@/lib/cert-constants`:

```ts
bol_number_next: { schema: numberSeed, default: 1000, label: "Next bill-of-lading number", group: "Numbering" },
cert_required_default: { schema: z.boolean(), default: false,
  label: "Certification required by default", group: "Certifications" },
cert_scope_default: { schema: z.enum(CERT_SCOPES), default: "ORDER",
  label: "Default certification scope", group: "Certifications" },
cert_statement: { schema: z.string(), default: CERT_STATEMENT_DEFAULT,
  label: "Certification statement", group: "Certifications" },
shipper_liability_text: { schema: z.string(), default: SHIPPER_LIABILITY_DEFAULT,
  label: "Shipping ticket liability text", group: "Shipping" },
```

Transcribe both defaults from the owner's samples (`docs/samples/Certification Sample.pdf`, `Shipping Ticket Sample.pdf`) as module constants directly above `SETTINGS`. **Leave `cert_number_next` in place and unused (§3.19) — add a comment saying so, so nobody wires it up.**

- [ ] **Step 5: Narrow `allocateNumber`'s key type and add the runtime backstop:**

```ts
export type NumberSettingKey = Extract<SettingKey, `${string}_number_next`>;

export async function allocateNumber(key: NumberSettingKey, tx: Prisma.TransactionClient): Promise<number> {
  if (!Object.hasOwn(SETTINGS, key)) throw new HttpError(400, `Unknown setting: ${key}`);
  // The template-literal type above is the real guard; this is the backstop for a caller that
  // reached here through a cast or an `any`. A non-numeric default would make the increment
  // below string-concatenate ("" + 1 → "1") and silently reissue numbers (issue #34).
  if (typeof SETTINGS[key].default !== "number") {
    throw new HttpError(400, `"${key}" is not a numbering key`);
  }
  // …existing body unchanged…
}
```

- [ ] **Step 6: Run the tests** — `npx vitest run tests/allocate-number.test.ts tests/settings.test.ts`. Expected: PASS (the `@ts-expect-error` is now required and satisfied).
- [ ] **Step 7: Extend `tests/settings.test.ts`** — every new key round-trips through `getSetting`/`setSetting`, `cert_scope_default` rejects `"ORDERS"` with a 400, `cert_required_default` rejects `"yes"`.
- [ ] **Step 8: Gates + commit** — `fix(settings): guard allocateNumber to numbering keys; add Phase 4 settings` (closes #34)

---

