## Task 7: Delete revival-on-create — the ten reference kinds

**Files:**
- Modify: `erp/src/server/reference.ts:23-36` (delete `REVIVAL_EXTRA_DEFAULTS`), `:45-54` (the `RefDelegate` type), `:76-105` (`createReference`)
- Modify: `erp/tests/reference-tables.test.ts:81`, `erp/tests/reference-gl.test.ts:73`, `:94`, `:118`

**Interfaces:**
- Consumes: Task 4's partial indexes on all ten reference `name` columns.
- Produces: `createReference(kind, input)` → `{ id }`, always a new row. `RefDelegate` gains `findFirst` and loses `findUnique`.

- [ ] **Step 1: Un-skip the test written in Task 4**

In `erp/tests/reference-gl.test.ts`, change the `it.skip(` from Task 4 Step 7 back to `it(` and delete the "un-skip there" comment above it.

- [ ] **Step 2: Rewrite the three revival tests**

Replace the tests at `reference-gl.test.ts:73` (`"revives a soft-deleted row when the same name is re-created"`), `:94` (`"revival resets extra fields…"`) and `:118` (`"revives a soft-deleted, previously-inactive row as active by default"`) with one:

```ts
  it("re-creating a deleted name makes a NEW row carrying none of the predecessor", async () => {
    const first = await createReference("glAccount", { name: "4010", description: "old" });
    await deleteReference("glAccount", first.id);

    const second = await createReference("glAccount", { name: "4010" });
    expect(second.id).not.toBe(first.id);

    const rows = await listReference("glAccount");
    const fresh = rows.find((r) => r.id === second.id);
    expect(fresh?.description).toBe("");   // schema default, not "old"
    expect(fresh?.active).toBe(true);

    expect((await readAudit("glAccount", second.id)).map((e) => e.action)).toEqual(["create"]);
  });
```

And at `reference-tables.test.ts:81`, replace `"revival resets extra fields for every kind that has one, not just active"` with the same shape run across every kind that has an extra column, so the per-kind coverage is not lost:

```ts
  const KINDS_WITH_EXTRAS = [
    { kind: "glAccount", extra: { description: "old" }, field: "description", fresh: "" },
    { kind: "inspectionCode", extra: {}, field: "defaultScaleId", fresh: null },
    { kind: "paymentType", extra: {}, field: "glAccountId", fresh: null },
    { kind: "commentSnippet", extra: { text: "old" }, field: "text", fresh: "" },
    { kind: "specification", extra: { text: "old" }, field: "text", fresh: "" },
  ] as const;

  it.each(KINDS_WITH_EXTRAS)(
    "$kind: a re-created name is a new row with default extras",
    async ({ kind, extra, field, fresh }) => {
      const first = await createReference(kind, { name: "X1", ...extra });
      await deleteReference(kind, first.id);
      const second = await createReference(kind, { name: "X1" });
      expect(second.id).not.toBe(first.id);
      const rows = await listReference(kind);
      expect(rows.find((r) => r.id === second.id)?.[field]).toBe(fresh);
    },
  );
```

- [ ] **Step 3: Run them to watch them fail**

```bash
npx vitest run tests/reference-gl.test.ts tests/reference-tables.test.ts
```
Expected: FAIL on the `not.toBe(first.id)` assertions.

- [ ] **Step 4: Delete `REVIVAL_EXTRA_DEFAULTS`**

Remove lines 23–36 of `erp/src/server/reference.ts` — the comment block and the constant.

- [ ] **Step 5: Swap `findUnique` for `findFirst` on the delegate type**

In the `RefDelegate` type (around line 48), replace the `findUnique` member:

```ts
type RefDelegate = {
  findMany: (a: object) => Promise<ReferenceRow[]>;
  // findFirst, not findUnique: `name` is unique only among live rows, but the generated client
  // still types it unique — findUnique would compile and return the soft-deleted row.
  findFirst: (a: { where: object; select?: object }) => Promise<{ id: string } | null>;
  create: (a: { data: object }) => Promise<{ id: string }>;
  update: (a: { where: { id: string }; data: object }) => Promise<{ id: string }>;
};
```

`update` stays — `updateReference` still uses it.

- [ ] **Step 6: Rewrite `createReference`**

Replace the body from the `existing` lookup to the `return` (lines ~83–104) with:

```ts
  const existing = await delegate(kind).findFirst({
    where: { name: data.name, deletedAt: null },
    select: { id: true },
  });
  if (existing) {
    throw new HttpError(400, `A ${REFERENCE_LABELS[kind].singular.toLowerCase()} with that name already exists`);
  }

  const row = await auditedCreate(kind, data, () =>
    withDbErrors({ entity: REFERENCE_LABELS[kind].singular, conflictField: "name" }, () =>
      delegate(kind).create({ data })));
  return { id: row.id };
```

- [ ] **Step 7: Leave `updateReference` alone — verify, do not edit**

`updateReference` has no rename pre-check; it relies on `withDbErrors` mapping P2002 → 400. That still works, because a *live* duplicate still raises P2002. **Do not add a pre-check that was never there.**

Task 4 also fixes the reference half of the carried backlog item "renaming onto a soft-deleted unique value 400s 'already exists' for an invisible row" here, for free and with no code change. Pin it, mirroring Task 5 Step 6:

```ts
  it("allows renaming a reference row onto a name only a deleted row still holds", async () => {
    const dead = await createReference("material", { name: "OLD" });
    await deleteReference("material", dead.id);
    const live = await createReference("material", { name: "KEEP" });

    await updateReference("material", live.id, { name: "OLD" });

    expect((await listReference("material")).find((r) => r.id === live.id)?.name).toBe("OLD");
  });
```

Run it: `npx vitest run tests/reference-gl.test.ts -t "onto a name only a deleted row"` — expected PASS with `reference.ts` untouched.

- [ ] **Step 8: Run the reference tests, then all four gates**

```bash
npx vitest run tests/reference-gl.test.ts tests/reference-tables.test.ts
```
Expected: all pass — including the test un-skipped in Step 1. Then, per Global Constraints:

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```
Expected: nothing skipped any more.

- [ ] **Step 9: Commit**

```bash
git add src/server/reference.ts tests/reference-gl.test.ts tests/reference-tables.test.ts
git commit -m "$(cat <<'EOF'
feat: re-creating a deleted reference name makes a new row, not a revival

Covers all ten reference kinds at once. REVIVAL_EXTRA_DEFAULTS is deleted:
a new row takes its schema defaults by construction, which is what that table
was hand-maintaining.

RefDelegate now declares findFirst instead of findUnique, so the dangerous
call shape is not even reachable through the shared delegate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

