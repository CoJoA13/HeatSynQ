## Task 4: Make the 13 unique columns unique only among live rows

Schema + migration only. **Revival-on-create is still in place after this task and all 255 tests must still pass** — with the partial index, `findUnique({ where: { code } })` finds the soft-deleted row exactly as it did before, so every revival path behaves identically. This intermediate green state is deliberate: it separates "the index landed correctly" from "the services changed".

**Files:**
- Modify: `erp/prisma/schema.prisma` — 13 models
- Create: `erp/prisma/migrations/<timestamp>_partial_unique_live_rows/migration.sql` (generated)

**Interfaces:**
- Consumes: the `partialIndexes` preview flag from Task 2.
- Produces: for each of the 13 columns, a live-rows-only unique constraint. Tasks 5–8 depend on this existing before they remove revival.

- [ ] **Step 1: Convert all 13 columns**

The complete list, from handoff §5.18 — customer, role, the ten reference kinds, and processStepCode:

| Model | Column |
|---|---|
| `Role` | `name` |
| `GlAccount` | `name` |
| `Material` | `name` |
| `InspectionScale` | `name` |
| `InspectionCode` | `name` |
| `ContainerType` | `name` |
| `Carrier` | `name` |
| `Terms` | `name` |
| `PaymentType` | `name` |
| `CommentSnippet` | `name` |
| `Specification` | `name` |
| `ProcessStepCode` | `code` |
| `Customer` | `code` |

In each, drop the field-level `@unique` and add a block-level partial unique. Two worked examples — apply the same shape to all thirteen:

```prisma
model Material {
  id        String    @id @default(cuid())
  name      String
  active    Boolean   @default(true)
  deletedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  @@unique([name], where: raw("\"deletedAt\" IS NULL"))
}
```

```prisma
model Customer {
  id   String @id @default(cuid())
  code String
  name String
  // … all other fields unchanged …

  @@unique([code], where: raw("\"deletedAt\" IS NULL"))
  @@index([name])
}
```

Note the escaped double quotes: `raw("\"deletedAt\" IS NULL")`. PostgreSQL folds unquoted identifiers to lower case, and the column is `deletedAt`, so the inner quotes are required.

**Do not touch these** — they are not revival sites and changing them is out of scope:
- `User.username` — `createUser` has no revival branch and users are never hard-deleted (handoff §4). It keeps a plain `@unique`. Task 9's sweep allowlists it explicitly so the decision is recorded rather than forgotten.
- `Session.tokenHash`, `RolePermission.@@unique([roleId, permission])`, `UserPermissionOverride.@@unique([userId, permission])`, `ProcessStepFieldDef.@@unique([codeId, label])` — none has a `deletedAt`.

- [ ] **Step 2: Validate before generating a migration**

```bash
npx prisma validate
```
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 3: Create the migration against the dev database**

```bash
npx prisma migrate dev --name partial_unique_live_rows
```

Expected in the generated SQL, thirteen times over:

```sql
DROP INDEX "Material_name_key";
CREATE UNIQUE INDEX "Material_name_key" ON "Material"("name") WHERE ("deletedAt" IS NULL);
```

Read the file before continuing. If any statement drops a column or recreates a table, **stop** — that is not what this change should produce.

> v7's `migrate dev` no longer generates the client. Run `npx prisma generate` after it.

- [ ] **Step 4: Regenerate the client**

```bash
npx prisma generate
```

- [ ] **Step 5: Apply to the test database**

```bash
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
```
Expected: `1 migration found` / applied. **Skipping this leaves the tests on a stale schema** — the single most repeated trap in this repo.

- [ ] **Step 6: Prove the constraint does what it claims**

Add to `erp/tests/reference-gl.test.ts` (it already owns the cross-kind delegate round-trip):

```ts
  it("permits a deleted row and a live row to share a name, but not two live rows", async () => {
    const first = await createReference("material", { name: "4140" });
    await deleteReference("material", first.id);

    // The whole point of the partial index: the archived row keeps its real name.
    const archived = await prisma.material.findUnique({ where: { id: first.id } });
    expect(archived?.name).toBe("4140");
    expect(archived?.deletedAt).not.toBeNull();

    // A live row may now take that name — and is a genuinely new row.
    const second = await createReference("material", { name: "4140" });
    expect(second.id).not.toBe(first.id);

    // But two live rows may not.
    await expect(createReference("material", { name: "4140" })).rejects.toThrow(/already exists/i);
  });
```

- [ ] **Step 7: Run it**

```bash
npx vitest run tests/reference-gl.test.ts -t "permits a deleted row and a live row"
```
Expected: **FAIL** on `expect(second.id).not.toBe(first.id)` — revival is still in place, so the ids match. That failure is the proof the test is real. Task 7 turns it green.

Keep the body exactly as written and mark it skipped, so the suite stays green between tasks and the test is restored rather than rewritten:

```ts
  // Revival-on-create is still in place until Task 7 removes it — un-skip there.
  it.skip("permits a deleted row and a live row to share a name, but not two live rows", async () => {
```

`reference-gl.test.ts` already imports `prisma`, so `prisma.material.findUnique({ where: { id } })` needs no new import.

- [ ] **Step 8: Run all four gates**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```
Expected: 255 pass, 1 skipped.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations tests/reference-gl.test.ts
git commit -m "$(cat <<'EOF'
feat: make soft-deleted unique columns unique only among live rows

Thirteen columns — customer.code, role.name, the ten reference kinds' name,
and processStepCode.code — move from a plain @unique to a partial unique
index filtered on deletedAt IS NULL. A deleted row now keeps its own id and
its real value instead of physically occupying the constraint.

Schema only: revival-on-create still runs and every test still passes.
Tasks 5-8 remove revival now that the constraint no longer forces it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

