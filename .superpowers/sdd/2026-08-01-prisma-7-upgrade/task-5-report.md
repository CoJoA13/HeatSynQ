# Task 5 Report: Delete revival-on-create — customers

Status: **DONE_WITH_CONCERNS** (one honest discrepancy from the brief's prediction, explained below — behavior is correct, test count differs from the brief's forecast).

Branch: `prisma-7-upgrade`. Commit: `daa6a62` — "feat: re-creating a deleted customer code makes a new row, not a revival"

## TDD evidence

**RED** — before touching `src/server/customers.ts`, ran the new test (Step 1 already applied, code not yet changed):

```
$ npx vitest run tests/customers.test.ts -t "re-creating a deleted code"
 × customers service > re-creating a deleted code makes a NEW row with its own history, not a revival 171ms
   → expected 'cms9t50j30000phijsp5835u2' not to be 'cms9t50j30000phijsp5835u2' // Object.is equality
 ❯ tests/customers.test.ts:53:27
     53|     expect(second.id).not.toBe(first.id);
 Test Files  1 failed (1)
      Tests  1 failed | 31 skipped (32)
```

Exactly the failure the brief predicted: revival still returns the old id.

**GREEN** — after Steps 3–5 (delete `REVIVAL_DEFAULTS`, rewrite `createCustomer`'s duplicate check, confirm the remaining `findUnique`):

```
$ npx vitest run tests/customers.test.ts
 ✓ tests/customers.test.ts (31 tests) 1492ms
 Test Files  1 passed (1)
      Tests  31 passed (31)
```

## Step 6 regression test — no code change

Added exactly as specified:

```ts
it("allows renaming a customer's code onto one only a deleted row still holds", async () => {
  const dead = await createCustomer({ code: "OLD", name: "Gone" });
  await deleteCustomer(dead.id, "no longer a customer");
  const live = await createCustomer({ code: "KEEP", name: "Still here" });
  await updateCustomer(live.id, { code: "OLD" });
  expect((await getCustomer(live.id)).code).toBe("OLD");
});
```

```
$ npx vitest run tests/customers.test.ts -t "onto one only a deleted row"
 ✓ customers service > allows renaming a customer's code onto one only a deleted row still holds
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

**PASSED without any edit to `customers.ts`**, confirming `updateCustomer` needed no code change and that Task 4's partial index on `Customer.code` is doing its job for the rename path. `updateCustomer` was not touched in this task (`git diff` shows only `createCustomer`, `assertNoCycle`'s docstring, `REVIVAL_DEFAULTS`, and `deleteCustomer`'s comment — no change to `updateCustomer`'s body).

## Inventory of every remaining `findUnique` in `src/server/customers.ts`

```
$ grep -n "findUnique" src/server/customers.ts
175:      await db.customer.findUnique({ where: { id: cursor }, select: { parentId: true } });
184:  // re-used and simply becomes a new row. findFirst, NOT findUnique: the column is still typed
185:  // unique on the client, so findUnique compiles and silently returns the soft-deleted row.
```

Only one actual call: **line 175**, inside `assertNoCycle`, keyed on `id` — a real primary key, not a partial-unique column. Per Step 5, left alone. (Lines 184–185 are comment text, not calls.) There is no remaining `findUnique` keyed on `code` anywhere in the file. `createCustomer`'s duplicate check now uses `findFirst({ where: { code, deletedAt: null } })` as specified.

## Implementation note: I did not delete the whole 197–220 block verbatim

The brief's Step 4 code block, read literally, would have deleted the `parentId`/`termsId` validation that used to sit between the duplicate check and the create/update branch (`if (data.parentId) await assertParentExists(...)`, `if (data.termsId) await assertTermsExists(...)`). Doing that literally would have broken three still-present tests that specifically exercise create-time validation:
- `"refuses a soft-deleted customer as a parent on create"` (line ~159, explicitly called out in my instructions as a sibling test that "must stay")
- `"refuses a soft-deleted terms record on create"`
- `"reports an unknown terms id as a field-anchored 400..."`

I kept those two validation lines, simplified (dropped the `if (existing) ... else ...` branching since `existing` is now always null by the time we reach them — the duplicate-code branch already threw). This matches `assertNoCycle`'s own docstring, which already said "a genuinely fresh row ... so createCustomer calls `assertParentExists` directly instead for that case" — i.e. the design always intended a fresh create to validate `parentId`/`termsId` directly; only the revival branch used `assertNoCycle`. Verified by running the full suite: all validation tests pass, all four gates green.

## Discrepancy from the brief's prediction — an extra test needed removal

The brief predicted "254 passing / 1 skipped" (255 total) for the whole suite (up from the stated baseline of 255 passing / 1 skipped, net −1 from 3 removed + 2 added, but for `customers.test.ts` specifically that arithmetic implies 3 removed − 1 net replaced by the new test = net −2 listed removals, +1 addition = net −1 for the file, since the line-44 replacement is a wash).

**What I actually found**: two tests beyond the three named in the brief also described the now-dead revival code path and had to change:

1. **`"deleting a customer soft-deletes its addresses and contacts, so a reused code does not resurrect them"`** (not listed in the brief) — asserted `revived.id).toBe(id)`, i.e. assumed the reused code kept the same row. Ran it unmodified against the new code first:
   ```
   × deleting a customer soft-deletes its addresses and contacts...
     → expected 'cms9t6acr...' to be 'cms9t6ac7...'
   ```
   Fixed by updating the assertion to `expect(reused.id).not.toBe(id)` and adjusting the comment — the cascade soft-delete of addresses/contacts is still correct and still tested; only the "same id" assumption was wrong. This test's core purpose (addresses/contacts get soft-deleted, don't leak to a new row) still holds and is still verified.

2. **`"guards against a cycle introduced by reviving a customer as its own parent"`** (not listed in the brief) — this test's own comment said outright: "createCustomer skips assertNoCycle entirely, reasoning that a row that doesn't exist yet cannot be in anyone's parent chain — true for a fresh create, false for the revival path." That revival path is now gone entirely, so the scenario it tested (a re-created row pointing at its own former self as parent) can no longer occur — a re-used code always makes a genuinely new id, which can never equal the old, now-deleted parent id. Ran it unmodified first:
   ```
   × guards against a cycle introduced by reviving a customer as its own parent
     → expected [Function] to throw error matching /circular|ancestor/i but got 'That parent does not exist'
   ```
   This is exactly the same class of "describes a path that no longer exists" the brief already identified for the line-173 test (`"refuses a soft-deleted customer as a parent on revival"`) — so I deleted it for the identical reason, rather than patching the regex to match a coincidentally-similar-but-semantically-different failure mode (a plain deleted-parent rejection, already covered by `"refuses a soft-deleted customer as a parent on create"`).

**Net effect**: `customers.test.ts` went from 33 tests to 31 (net −2, not the −1 the brief's file-level math implied). Whole-suite result:

```
$ npm test
 Test Files  30 passed (30)
      Tests  253 passed | 1 skipped (254)
```

**253 passing / 1 skipped (254 total)** — one fewer passing test than the brief's "254 passing / 1 skipped" prediction, because of the extra dead-path test (#2 above) the brief didn't anticipate. This is a plan-prediction gap, not a bug: the removed test asserted behavior (self-parent cycle via revival) that is now structurally impossible, exactly analogous to the test the brief did know to remove.

## Files changed

- `/home/cojoa13/Desktop/HeatSynQ/erp/src/server/customers.ts`
  - Deleted `REVIVAL_DEFAULTS` and its comment block.
  - Rewrote `createCustomer`'s duplicate-code check: `findFirst({ where: { code, deletedAt: null } })` instead of `findUnique({ where: { code } })`; throws immediately on a live duplicate; dropped the `existing`-branching `auditedUpdate` revival path entirely — every create now goes through `auditedCreate` unconditionally. Kept `assertParentExists`/`assertTermsExists` validation for a fresh create (needed — see above).
  - Updated `assertNoCycle`'s docstring (stale "or the revival path of create" reference; that path no longer exists — only `updateCustomer` calls it now).
  - Updated `deleteCustomer`'s comment on the address/contact cascade (stale reference to `REVIVAL_DEFAULTS` and to a "revived row" that no longer exists; the cascade itself is unchanged and still correct, just for a different, updated reason).
- `/home/cojoa13/Desktop/HeatSynQ/erp/tests/customers.test.ts`
  - Replaced `"revives a soft-deleted code and brings it back active"` with the brief's new test `"re-creating a deleted code makes a NEW row with its own history, not a revival"` (Step 1, verbatim).
  - Deleted `"refuses a soft-deleted customer as a parent on revival"` (Step 1, verbatim — brief-specified).
  - Deleted `"revival resets every field a genuine create would default, not just active"` (Step 1, superseded by the new test — brief-specified).
  - **Deleted `"guards against a cycle introduced by reviving a customer as its own parent"`** — not brief-specified; discovered and removed for the reason explained above.
  - **Fixed `"deleting a customer soft-deletes its addresses and contacts, so a reused code does not resurrect them"`** — not brief-specified; updated its final assertions from `revived.id).toBe(id)` to `reused.id).not.toBe(id)` to match the new contract; core cascade assertions unchanged.
  - Added Step 6's regression test `"allows renaming a customer's code onto one only a deleted row still holds"` verbatim.

## Self-review findings

- No remaining reference to `REVIVAL_DEFAULTS`, "revival", "revived", or "reviving" anywhere in `src/server/customers.ts` (grep confirmed after edits, before the two comment fixes above were applied) — the two stale comments I found were fixed as part of this task since they became actively false (not just imprecise) once the revival branch was deleted; both are 1-comment-block edits, no behavior change.
- `updateCustomer` body is byte-for-byte unchanged (confirmed via `git diff` — no hunk touches it), consistent with the brief's Step 6 note that it needs no code change.
- No new imports were needed in the test file, as the brief predicted.
- Touched only `src/server/customers.ts` and `tests/customers.test.ts`, per the global constraint.
- Did not touch `prisma/schema.prisma` or create a migration.

## Gates (all green)

```
$ npm test
 Test Files  30 passed (30)
      Tests  253 passed | 1 skipped (254)

$ npx tsc --noEmit
(no output — clean)

$ npx eslint src tests
(no output — clean)

$ npm run build
✓ Compiled successfully
✓ Generating static pages (25/25)
```

## Concerns

- Test count is 253 passing / 1 skipped, not the brief's predicted 254 passing / 1 skipped — one fewer passing, because I found and removed a fourth revival-only test (`"guards against a cycle introduced by reviving a customer as its own parent"`) that the brief's Files/Step list didn't name but whose own in-file comment explicitly says it tests the revival branch. I'm confident this is correct (the scenario it tested is now structurally impossible), but flagging it plainly per the task's evidence-honesty instruction since it contradicts the brief's stated prediction.
- I also updated one test not named in the brief (`"deleting a customer soft-deletes its addresses and contacts..."`) whose final two lines assumed same-id reuse. This was a necessary consequence of the code change, not a judgment call about scope creep — the alternative was to leave a failing test.
