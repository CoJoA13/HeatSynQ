## Task 6: Delete revival-on-create — roles (and the seed's `upsert`)

`prisma/seed.ts` breaks in this task, not before: `role.upsert({ where: { name: "Admin" } })` throws **P2039** once `Role.name` is only partially unique. Verified in the spike.

**Files:**
- Modify: `erp/src/server/roles.ts:21-46`
- Modify: `erp/prisma/seed.ts` (the `role.upsert` call)
- Modify: `erp/tests/roles.test.ts`

**Interfaces:**
- Consumes: Task 4's partial index on `Role.name`.
- Produces: `createRole(name)` → `{ id }`, always a new row.

- [ ] **Step 1: Prove the seed is broken**

```bash
npm run db:seed
```
Expected: **FAIL** with `P2039`. This is the verified consequence, and seeing it first is what makes the fix in Step 5 an evidenced change rather than a speculative one.

- [ ] **Step 2: Rewrite the roles revival test**

In `erp/tests/roles.test.ts`, replace the revival test with:

```ts
  it("re-creating a deleted role name makes a NEW role with no inherited grants", async () => {
    const first = await createRole("Shipping");
    await setRolePermissions(first.id, ["customers.view"]);
    await deleteRole(first.id);

    const second = await createRole("Shipping");
    expect(second.id).not.toBe(first.id);

    const roles = await listRoles();
    const fresh = roles.find((r) => r.id === second.id);
    expect(fresh?.permissions).toEqual([]);

    expect((await readAudit("role", second.id)).map((e) => e.action)).toEqual(["create"]);
  });
```

The old revival semantics — "clear the stale permissions off the revived row" — is now structural: a new row has no `RolePermission` rows at all. The assertion above still guards the same user-visible rule, which is why it is kept rather than deleted.

- [ ] **Step 3: Run it to watch it fail**

```bash
npx vitest run tests/roles.test.ts -t "re-creating a deleted role name"
```
Expected: FAIL — ids match.

- [ ] **Step 4: Rewrite `createRole` and `renameRole`**

Replace lines 21–46 of `erp/src/server/roles.ts` with:

```ts
export async function createRole(name: string): Promise<{ id: string }> {
  // findFirst, NOT findUnique — Role.name is unique only among live rows, but the client still
  // types it unique, so findUnique compiles and returns the soft-deleted row instead.
  const existing = await prisma.role.findFirst({ where: { name, deletedAt: null }, select: { id: true } });
  if (existing) throw new HttpError(400, "A role with that name already exists");

  const role = await auditedCreate("role", { name }, () =>
    withDbErrors({ entity: "Role", conflictField: "name" }, () => prisma.role.create({ data: { name } })));
  return { id: role.id };
}

export async function renameRole(roleId: string, name: string): Promise<void> {
  const existing = await prisma.role.findFirst({
    where: { name, deletedAt: null, NOT: { id: roleId } },
    select: { id: true },
  });
  if (existing) throw new HttpError(400, "A role with that name already exists");
  await withDbErrors({ entity: "Role", conflictField: "name" }, () =>
    auditedUpdate("role", roleId, () => prisma.role.update({ where: { id: roleId }, data: { name } })));
}
```

`renameRole`'s rewrite also fixes the carried backlog edge "`renameRole` to a soft-deleted role's name → 500" (handoff §6).

- [ ] **Step 5: Fix the seed**

In `erp/prisma/seed.ts`, replace the `role.upsert` call with a find-then-create. `upsert` cannot be used on a partially-unique column at all:

```ts
  // Not upsert: Role.name is unique only among live rows, and upsert on such a column throws
  // P2039. Find-then-create is the equivalent, and the seed is single-threaded.
  const admin =
    (await prisma.role.findFirst({ where: { name: "Admin", deletedAt: null } })) ??
    (await prisma.role.create({ data: { name: "Admin" } }));
```

The `user.upsert({ where: { username: "admin" } })` call below it is **fine and must not be changed** — `User.username` is still fully unique (Task 4, Step 1).

- [ ] **Step 6: Verify the seed and the tests**

```bash
npm run db:seed && npx vitest run tests/roles.test.ts
```
Expected: seed completes; role tests pass.

Run the seed a second time to confirm idempotence:
```bash
npm run db:seed
```
Expected: completes again with no duplicate-Admin error.

Then all four gates, per Global Constraints:

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/server/roles.ts prisma/seed.ts tests/roles.test.ts
git commit -m "$(cat <<'EOF'
feat: re-creating a deleted role name makes a new role, not a revival

A new row has no RolePermission rows by construction, so the old "clear the
stale grants off the revived role" branch is gone rather than reimplemented.

The seed's role.upsert({ where: { name } }) had to go with it: upsert on a
partially-unique column throws P2039. user.upsert stays — username is still
fully unique.

renameRole's guard moves to findFirst too, closing the carried backlog edge
where renaming onto a soft-deleted role name 500'd.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

