## Task 5: Delete revival-on-create — customers

**Files:**
- Modify: `erp/src/server/customers.ts:68-80` (delete `REVIVAL_DEFAULTS`), `:197-220` (`createCustomer`), `:186` and `:245`-ish (the `findUnique` audit)
- Modify: `erp/tests/customers.test.ts:44`, `:173`, `:317`

**Interfaces:**
- Consumes: Task 4's partial index on `Customer.code`.
- Produces: `createCustomer(input)` returning `{ id }` — unchanged signature, but the id is always a **new** row.

- [ ] **Step 1: Rewrite the two failing tests first**

In `erp/tests/customers.test.ts`, replace the test at line 44 (`"revives a soft-deleted code and brings it back active"`) and the one at line 317 (`"revival resets every field a genuine create would default, not just active"`) with a single test asserting the new contract:

```ts
  it("re-creating a deleted code makes a NEW row with its own history, not a revival", async () => {
    const first = await createCustomer({
      code: "ACME", name: "Acme Original", creditHold: true, orderNotes: "old notes",
    });
    await deleteCustomer(first.id, "keyed by mistake");

    const second = await createCustomer({ code: "ACME", name: "Acme Industries" });

    // A new identity, not the dead row wearing a new name.
    expect(second.id).not.toBe(first.id);

    // Nothing of the predecessor leaks through.
    const row = await getCustomer(second.id);
    expect(row.name).toBe("Acme Industries");
    expect(row.creditHold).toBe(false);
    expect(row.orderNotes).toBe("");
    expect(row.active).toBe(true);

    // The audit trail says "create", and carries none of the predecessor's entries.
    expect((await readAudit("customer", second.id)).map((e) => e.action)).toEqual(["create"]);

    // And the archived row keeps its own value, its own id, and its own history.
    const archived = await prisma.customer.findUnique({ where: { id: first.id } });
    expect(archived?.code).toBe("ACME");
    expect(archived?.deletedAt).not.toBeNull();
    expect((await readAudit("customer", first.id)).map((e) => e.action).sort())
      .toEqual(["create", "delete"]);
  });
```

No new imports needed — `customers.test.ts` already imports `prisma`, `readAudit`, and all five customer service functions. The same is true of `roles.test.ts` and `reference-gl.test.ts` for their tasks. `readAudit` orders **descending**, which is why the two-entry assertion is `.sort()`ed.

The test at line 173 (`"refuses a soft-deleted customer as a parent on revival"`) describes a path that no longer exists — delete it. The sibling tests at 159 and 166 (create/update) still cover the rule.

- [ ] **Step 2: Run them to watch them fail**

```bash
npx vitest run tests/customers.test.ts -t "re-creating a deleted code"
```
Expected: FAIL on `expect(second.id).not.toBe(first.id)` — revival still returns the old id.

- [ ] **Step 3: Delete `REVIVAL_DEFAULTS`**

Remove lines 68–80 of `erp/src/server/customers.ts` entirely — the comment block and the `REVIVAL_DEFAULTS` constant.

- [ ] **Step 4: Rewrite `createCustomer`'s duplicate check**

Replace the revival block (around lines 197–220) with:

```ts
  // Unique only among live rows (see prisma/schema.prisma), so a deleted code is free to be
  // re-used and simply becomes a new row. findFirst, NOT findUnique: the column is still typed
  // unique on the client, so findUnique compiles and silently returns the soft-deleted row.
  const existing = await prisma.customer.findFirst({
    where: { code: data.code, deletedAt: null },
    select: { id: true },
  });
  if (existing) throw new HttpError(400, "A customer with that code already exists");

  const row = await auditedCreate("customer", data, () =>
    withDbErrors({ entity: "Customer", conflictField: "code" }, () =>
      prisma.customer.create({ data })));
  return { id: row.id };
```

- [ ] **Step 5: Fix the remaining `findUnique` on a partial-unique column**

`erp/src/server/customers.ts:186` uses `db.customer.findUnique({ where: { id: cursor } })` — `id` is a real primary key, so **leave it alone**.

Search the file for any `findUnique` keyed on `code`:

```bash
grep -n "findUnique" src/server/customers.ts
```
Every remaining hit must be keyed on `id`. If one is keyed on `code`, convert it to `findFirst` with `deletedAt: null`.

- [ ] **Step 6: Add a regression test for the rename path — no code change**

`updateCustomer` has **no** `findUnique` rename guard; it relies on `withDbErrors` mapping Prisma's P2002 to a 400. Do not add a pre-check that was never there.

That path is fixed by Task 4 alone and needs no edit: a soft-deleted row no longer occupies the constraint, so P2002 no longer fires against an invisible row. This closes the carried backlog item "renaming onto a *soft-deleted* unique value 400s 'already exists' for an invisible row" (handoff §6) for free. Pin it so it stays fixed — add to `erp/tests/customers.test.ts`:

```ts
  it("allows renaming a customer's code onto one only a deleted row still holds", async () => {
    const dead = await createCustomer({ code: "OLD", name: "Gone" });
    await deleteCustomer(dead.id, "no longer a customer");
    const live = await createCustomer({ code: "KEEP", name: "Still here" });

    await updateCustomer(live.id, { code: "OLD" });

    expect((await getCustomer(live.id)).code).toBe("OLD");
  });
```

Run it: `npx vitest run tests/customers.test.ts -t "onto one only a deleted row"` — expected PASS, with no change to `customers.ts`. If it fails, the partial index from Task 4 did not land correctly; go back rather than editing the service.

- [ ] **Step 7: Run the customer tests, then all four gates**

```bash
npx vitest run tests/customers.test.ts
```
Expected: all pass. Then, per Global Constraints — every commit leaves all four green:

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```

- [ ] **Step 8: Commit**

```bash
git add src/server/customers.ts tests/customers.test.ts
git commit -m "$(cat <<'EOF'
feat: re-creating a deleted customer code makes a new row, not a revival

Now that Customer.code is unique only among live rows, a re-used code no
longer has to reuse the dead row — and so no longer inherits its audit
identity, its createdAt, or its history (issue #10).

findFirst, not findUnique: the partial index leaves the column typed unique
on the client, so findUnique still compiles and silently returns the deleted
row. Task 9's sweep guards that.

Also closes the carried backlog item where renaming onto a soft-deleted code
400'd "already exists" for a row the caller cannot see.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

