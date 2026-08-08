### Task 8: Customer-side — surcharge overrides, tax rate, cert suppression

> **PLAN HOLE CLOSED (2026-08-07, from Task 6's review). This task now owns a DELETE route.**
> As originally written, this phase gave a customer surcharge override **no removal path at all**:
> Task 6's interface had only `listCustomerSurcharges`/`setCustomerSurcharge`, Task 7's route is
> GET + PUT, and this task's UI consumed those. But a live `CustomerSurcharge` row **blocks
> deletion of the surcharge it points at** (`reference-links.ts:192-200`), and `optOut: false`
> still leaves the row — so creating one override made that surcharge undeletable forever. That is
> precisely the shape `reference-blockers.ts:12-22` names as the Visual Shop dead end this system
> exists to escape: "a block without discoverability looks like data integrity while actually
> being a permanent dead end."
>
> **Task 6's fix wave already added the service half:** `deleteCustomerSurcharge(customerId,
> surchargeId)`, a soft delete through `auditedSoftDelete` (the row has `deletedAt`), 404 if no
> live override exists for the pair, with a test proving a soft-deleted override actually frees
> the blocked surcharge delete.
>
> **What this task owes:** a `DELETE` on `src/app/api/customers/[id]/surcharges/route.ts` calling
> it, gated exactly like the PUT — `mustCan(requireUser(), "customers", "edit")` **plus**
> `mustDo(user, "change_prices")`, since removing an override is a price change just as setting
> one is — and a control in the customer UI that reaches it. Removing an override must be as
> discoverable as adding one.
>
> **Two more carried in from Task 6's re-review, both this task's to honor:**
>
> 1. **The surcharge editor must post the WHOLE row, not a partial patch.** Task 6 fixes its
>    headline defect with normalize-on-write: `updateSurcharge` pins every optional column to its
>    explicit empty value, so a payload that omits a field CLEARS it. That is the coherent reading
>    of the whole-row `SAVE` design and it is deliberate — but it means
>    `updateSurcharge(id, {name, kind, amount, position})` on an inactive surcharge silently
>    re-activates it and wipes `minimumAmount`. `SAVE` still marks `scope`/`active` `.optional()`,
>    so nothing in the type system forces your form to submit them. **Submit every field.**
> 2. **An override belonging to a soft-deleted customer still blocks its surcharge.** The
>    `customerSurcharge → surcharge` registry entry (`reference-links.ts:192-200`) takes the
>    default `liveWhere` on the override row only, so the blocker panel will link at
>    `/customers/{deletedId}`. `deleteCustomerSurcharge` is the escape hatch — but only if this
>    task exposes it somewhere reachable for that case. Pre-existing, and Task 6's fix is what
>    makes it reachable at all; decide deliberately how a deleted customer's override gets cleared
>    rather than discovering it from a support call.

**Files:**
- Modify: `src/server/customers.ts`, `src/app/customers/[id]/page.tsx`
- Create: `src/app/api/customers/[id]/surcharges/route.ts`
- Test: `tests/customers.test.ts` (appended), `tests/surcharges.test.ts` (appended)

**Interfaces:**
- Consumes: `listCustomerSurcharges` / `setCustomerSurcharge` (Task 6).
- Produces: `CustomerRow` gains `salesTaxRate: number | null` and `certChargeSuppressed: boolean`.

- [ ] **Step 1: Write the failing tests** in `tests/customers.test.ts`:

```ts
it("stores a per-customer sales tax rate and cert suppression", async () => {
  const { id } = await asSystem(() => createCustomer({ code: "ACME", name: "Acme" }));
  await asSystem(() => updateCustomer(id, { salesTaxRate: "0.045000", certChargeSuppressed: true }));
  const row = await getCustomer(id);
  expect(row.salesTaxRate).toBe(0.045);
  expect(row.certChargeSuppressed).toBe(true);
});

it("rejects a sales tax rate with too many decimals", async () => {
  const { id } = await asSystem(() => createCustomer({ code: "ACME", name: "Acme" }));
  await expect(asSystem(() => updateCustomer(id, { salesTaxRate: "0.0450001" })))
    .rejects.toThrow(/at most 3 digits before and 6 digits after/);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/customers.test.ts`. Expected: FAIL, unrecognized keys (the customer schema is `.strict()`).
- [ ] **Step 3: Extend `src/server/customers.ts`** — add `salesTaxRate: decimalField(9, 6, { min: "nonnegative" })` and `certChargeSuppressed: z.boolean().optional()` to the zod object, both columns to the `SELECT`, `salesTaxRate` to the Decimal→number mapping, and both fields to `CustomerRow`. This mirrors `creditLimit` / `financeChargeRate` exactly (`customers.ts:42-43, 50-59, 73-94`).
- [ ] **Step 4: The customer surcharges route** — GET lists, PUT upserts one `{ surchargeId, optOut, rate, amount }`. `mustCan(requireUser(), "customers", "view" | "edit")`, plus `mustDo(user, "change_prices")` on the PUT: a per-customer surcharge override is a price change, and `change_prices` is the action that exists for it.
- [ ] **Step 5: The customer page** — add "Sales tax rate" and "Suppress certification charge" beside the existing Taxable / COD / Surcharge opt-out controls (`src/app/customers/[id]/page.tsx:480-560`), and a **Surcharge overrides** section listing every active surcharge with per-row opt-out and rate/amount override. Gate the section on `customers.edit` **and** `change_prices`, computed once, with the same "whichever is actually the blocker" title rule as the parts Pricing section.
- [ ] **Step 6: Run the tests** — `npx vitest run tests/customers.test.ts tests/surcharges.test.ts`. Expected: PASS.
- [ ] **Step 7: Gates + commit** — `feat(customers): sales tax rate, certification charge suppression, per-surcharge overrides`

---

