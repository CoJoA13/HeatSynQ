## Task 8: Delete revival-on-create — process step codes

The last site, and the one that also soft-deleted children (`ProcessStepFieldDef`) on revival.

**Files:**
- Modify: `erp/src/server/process-step-codes.ts:44-49` (delete `REVIVAL_DEFAULTS`), `:66-99` (`createStepCode`)
- Modify: `erp/tests/process-step-codes.test.ts:34`, `:45`, `:57`

**Interfaces:**
- Consumes: Task 4's partial index on `ProcessStepCode.code`.
- Produces: `createStepCode(input)` → `{ id }`, always a new row with no field definitions. Signature unchanged.

> Exact exported names, confirmed against the source: `listStepCodes`, `createStepCode`, `updateStepCode`, `deleteStepCode`, `setStepFields`. Field definitions are **not** part of `createStepCode`'s input — `CREATE` has no `fields` key; they are attached separately through `setStepFields`.

- [ ] **Step 1: Rewrite the three revival tests as one**

Replace the tests at lines 34, 45 and 57 of `erp/tests/process-step-codes.test.ts` with:

```ts
  it("re-creating a deleted code makes a NEW code with no inherited fields", async () => {
    const gl = await createReference("glAccount", { name: "4010" });
    const { id: firstId } = await createStepCode({
      code: "HT-01", name: "Austenitize", glAccountId: gl.id, equipmentTag: "F1",
    });
    await setStepFields(firstId, [{ label: "Soak", type: "NUMBER", unit: "min", sort: 0 }]);
    await deleteStepCode(firstId);

    const { id: secondId } = await createStepCode({ code: "HT-01", name: "Renamed" });
    expect(secondId).not.toBe(firstId);

    const [fresh] = await listStepCodes();
    expect(fresh).toMatchObject({
      id: secondId, code: "HT-01", name: "Renamed",
      glAccountId: null, equipmentTag: "", active: true, needsGlAccount: true,
    });
    expect(fresh.fields).toEqual([]);

    // A real create entry under its own identity — the defect issue #10 was filed for.
    expect((await readAudit("processStepCode", secondId)).map((e) => e.action)).toEqual(["create"]);
  });
```

`readAudit` is already imported by this test file. It orders **descending**, which is why single-entry assertions are written as an exact array and multi-entry ones are sorted.

Keep the test at line 80 (`"still rejects a duplicate code when the existing row is not soft-deleted"`) exactly as it is — that rule is unchanged and it is the guard proving the constraint still bites.

- [ ] **Step 2: Run it to watch it fail**

```bash
npx vitest run tests/process-step-codes.test.ts -t "re-creating a deleted code"
```
Expected: FAIL — ids match.

- [ ] **Step 3: Delete `REVIVAL_DEFAULTS`**

Remove lines 44–49 of `erp/src/server/process-step-codes.ts` — the comment and the constant.

- [ ] **Step 4: Rewrite the create**

Replace everything in `createStepCode` from the `existing` lookup down to `return { id: row.id };` with the create branch alone. The whole `existing ? … : …` ternary, its long revival comment, and the `$transaction` that deleted the predecessor's `processStepFieldDef` rows all go — a new row has no children to clear:

```ts
export async function createStepCode(input: z.input<typeof CREATE>): Promise<{ id: string }> {
  const data = CREATE.parse(input);

  // findFirst, NOT findUnique: `code` is unique only among live rows, but the generated client
  // still types it unique, so findUnique would compile and return the soft-deleted row.
  const existing = await prisma.processStepCode.findFirst({
    where: { code: data.code, deletedAt: null },
    select: { id: true },
  });
  if (existing) throw new HttpError(400, "A process step code with that code already exists");

  const row = await auditedCreate("processStepCode", data, () =>
    withDbErrors({ entity: "Process step code", conflictField: "code" }, () =>
      prisma.processStepCode.create({ data })));
  return { id: row.id };
}
```

`data` is passed straight through, exactly as the old create branch did. `CREATE` carries no `fields` key, so there is no child-record handling in this function at all — that lives in `setStepFields`.

- [ ] **Step 5: Check the remaining `findUnique`**

```bash
grep -n "findUnique" src/server/process-step-codes.ts
```
The one remaining hit is keyed on `id`, a primary key. **Leave it.** Any hit keyed on `code` means Step 4 was applied incompletely.

- [ ] **Step 6: Run the tests**

```bash
npx vitest run tests/process-step-codes.test.ts
```
Expected: all pass.

- [ ] **Step 7: Run all four gates — every revival site is now converted**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```
Expected: all green, nothing skipped.

- [ ] **Step 8: Commit**

```bash
git add src/server/process-step-codes.ts tests/process-step-codes.test.ts
git commit -m "$(cat <<'EOF'
feat: re-creating a deleted step code makes a new code, not a revival

The last of the four revival sites. The transaction that soft-deleted the
old row's field definitions on revival is gone with it — a new row has no
children to clear.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

