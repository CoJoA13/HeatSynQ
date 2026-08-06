### Task 3: Shared primitives — allocateNumber + lockCurrentRevision

**Files:**
- Modify: `src/server/settings.ts`, `src/server/part-process-steps.ts`
- Test: `tests/allocate-number.test.ts`, extend `tests/part-process-steps.test.ts`

**Interfaces (Produces):**
```ts
// settings.ts
export async function allocateNumber(key: SettingKey, tx: Prisma.TransactionClient): Promise<number>;
// part-process-steps.ts
export async function lockCurrentRevision(partId: string, tx: Prisma.TransactionClient): Promise<{ revisionNumber: number }>;
```

- [ ] **Step 1: Failing tests.** allocateNumber: returns the seed (default 1000) when no row exists and increments the stored value; two sequential calls give N, N+1; **two concurrent `$transaction`s each allocating get distinct numbers** (fire both without awaiting between starts); writes NO audit row (`prisma.auditLog.count() === 0` after allocation); rejects an unknown key. lockCurrentRevision: 400 "This part has no process steps" when the part has no revision AND when the current revision has zero steps; returns the highest revisionNumber and sets `lockedAt`; idempotent (second call same result, no second audit entry — reuses `lockRevision`'s contract); **the 2C-3 race regression rerun against this caller**: a `lockCurrentRevision` inside a default-isolation tx racing `updateStep` cannot leave the locked revision's steps modified (both orderings — model on the existing "a lock landing mid-mutation" test in `tests/part-process-steps.test.ts`).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**

```ts
// settings.ts — allocation is deliberately unaudited: the consuming entity's own create entry
// records the number; owner edits to the seed still flow through setSetting + auditSettingChange.
export async function allocateNumber(key: SettingKey, tx: Prisma.TransactionClient): Promise<number> {
  if (!Object.hasOwn(SETTINGS, key)) throw new HttpError(400, `Unknown setting: ${key}`);
  const def = SETTINGS[key];
  await tx.setting.upsert({ where: { key }, create: { key, value: def.default as number }, update: {} });
  const [row] = await tx.$queryRaw<{ value: unknown }[]>`
    SELECT "value" FROM "Setting" WHERE "key" = ${key} FOR UPDATE`;
  const parsed = def.schema.safeParse(row.value);
  const current = (parsed.success ? parsed.data : def.default) as number;
  await tx.setting.update({ where: { key }, data: { value: current + 1 } });
  return current;
}
```

```ts
// part-process-steps.ts — same claim SQL as workingRevision (this file is the only home of that
// FOR UPDATE, HANDOFF §4a: the row lock is the guarantee at ANY caller isolation).
export async function lockCurrentRevision(
  partId: string, tx: Prisma.TransactionClient,
): Promise<{ revisionNumber: number }> {
  const claimed = await tx.$queryRaw<{ id: string; revisionNumber: number }[]>`
    SELECT "id", "revisionNumber" FROM "PartProcessRevision"
    WHERE "partId" = ${partId} ORDER BY "revisionNumber" DESC LIMIT 1 FOR UPDATE`;
  if (claimed.length === 0) throw new HttpError(400, "This part has no process steps");
  const stepCount = await tx.partProcessStep.count({ where: { revisionId: claimed[0].id } });
  if (stepCount === 0) throw new HttpError(400, "This part has no process steps");
  await lockRevision(partId, claimed[0].revisionNumber, tx);
  return { revisionNumber: claimed[0].revisionNumber };
}
```

- [ ] **Step 4: Run — expect PASS.** Gates.
- [ ] **Step 5: Commit** — `feat: allocateNumber and lockCurrentRevision primitives`

