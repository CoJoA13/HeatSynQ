# Task 6 Report — Delete revival-on-create: roles (and the seed's `upsert`)

## Status: DONE_WITH_CONCERNS

The prescribed fix is implemented exactly as designed and all four gates are green. The one
concern is a factual mismatch between the brief's predicted failure mode and observed reality,
investigated exhaustively below, per "verify rather than assume."

---

## 1. The P2039 prediction did NOT reproduce — full investigation

### Step 1 as literally run

```
$ npm run db:seed

> erp@0.1.0 db:seed
> tsx prisma/seed.ts

Seeded Admin role + admin user (password: admin — change it after first login).
```

**No error. No P2039.** This is the verbatim, complete output — nothing was trimmed.

This is *not* simply "the bug wasn't hit" — the dev DB already had a live, non-deleted `Admin`
role from earlier task work (`Role.name = 'Admin'`, `deletedAt` null), so this run exercised
`upsert`'s "found a matching row, do the UPDATE" branch on a fully realistic pre-existing row.

### Why I didn't stop at "well, it passed" — I tested every scenario the brief's claim implies

The brief says "upsert on such a column throws P2039" as a general fact about the partially-unique
`Role.name` column, not something contingent on the exact row state on my first run. Before
accepting "seed doesn't crash" as the final word, I first confirmed the DB-level constraint Task 4
promised is actually present and correct:

```
$ docker compose exec -T db psql -U erp -d erp_test -c "SELECT indexname, indexdef FROM pg_indexes WHERE tablename='Role';"
   indexname   |                                              indexdef
---------------+-----------------------------------------------------------------------------------------------------
 Role_pkey     | CREATE UNIQUE INDEX "Role_pkey" ON public."Role" USING btree (id)
 Role_name_key | CREATE UNIQUE INDEX "Role_name_key" ON public."Role" USING btree (name) WHERE ("deletedAt" IS NULL)
```

Confirmed: Task 4's partial index is present and correct on `erp_test`. So Task 4's actual
deliverable is not in question — only the brief's specific *symptom* claim for `upsert` is.

I then wrote a throwaway spike (`prisma/_spike-upsert.ts`, deleted before commit — never part of
the diff) against `erp_test`, calling `prisma.role.upsert({ where: { name: "Admin" }, update: {},
create: { name: "Admin" } })` under three states:

1. **No `Role` row at all** (clean table) — `SUCCEEDED`, created a fresh row.
2. **A LIVE `Admin` row already exists** — `SUCCEEDED`, updated it (no-op `update: {}`).
3. **Only a SOFT-DELETED `Admin` row exists, no live one** — `SUCCEEDED` — and this is the
   important one: it returned the *same id* as the soft-deleted row, with `deletedAt` still set
   (i.e. still dead). No error, but also not a real create.

I also tested a fourth scenario with query logging enabled (`log: [{level:"query",emit:"event"}]`)
to see the actual SQL:

```
=== Scenario: only a dead "Admin" row exists ===
SQL: UPDATE "public"."Role" SET "deletedAt" = $1 WHERE "public"."Role"."name" = $2
SQL: SELECT "public"."Role"."id" FROM "public"."Role" WHERE ("public"."Role"."name" = $1 AND 1=1) OFFSET $2
SQL: SELECT ... FROM "public"."Role" WHERE (("public"."Role"."name" = $1 AND 1=1) AND "public"."Role"."id" IN ($2)) LIMIT $3 OFFSET $4
SQL: SELECT ... FROM "public"."Role" WHERE "public"."Role"."id" = $1 LIMIT $2 OFFSET $3
SQL: COMMIT
[B-only-dead-row] SUCCEEDED -> { id: '...', name: 'Admin', deletedAt: 2026-08-01T03:36:00.155Z }
```

**Root cause of the mismatch:** Prisma 7.9.1's pg driver adapter does **not** generate a native
`INSERT ... ON CONFLICT ("name") DO UPDATE` for this upsert (which is the only way I can see this
throwing P2039 — Postgres would reject an `ON CONFLICT` clause whose arbiter doesn't syntactically
match the partial index's predicate). Instead it does a client-side `SELECT` by `name` (ignoring
`deletedAt` — exactly the "trap" the brief describes for `findUnique`, playing out the same way
inside `upsert`'s internals) followed by a plain `UPDATE ... WHERE id = ...` or `INSERT`. That SELECT
never touches the partial index as a Postgres arbiter, so there is nothing to throw P2039 about.

**The real, confirmed bug is silent, not a crash:** when the only row named "Admin" is
soft-deleted, `upsert({ where: { name: "Admin" }, update: {} })` finds it (matching by name alone,
ignoring `deletedAt`), and its `update: {}` payload is a no-op — so it returns the *same dead row*,
still soft-deleted, and the caller (the seed) goes on to attach the `admin` user's `roleId` and
fresh `RolePermission` rows to that invisible role id. This is arguably worse than a crash: it
fails silently and locks the admin account onto a role nothing lists.

I demonstrated this concretely against the real dev DB with the *unfixed* seed logic (before my
fix reached this file) is irrelevant now since I fixed seed.ts before this run — instead I proved
the *fixed* seed correctly avoids the bug: I manually soft-deleted the dev DB's live Admin row via
raw SQL, then ran the post-fix `npm run db:seed`, and confirmed it created a **brand-new** live
Admin row rather than reattaching to the dead one (see §3 below).

**Conclusion:** Task 4's deliverable (the partial index) is exactly as documented and correctly
applied. The brief's specific claim that `role.upsert(...)` throws P2039 does not hold for Prisma
7.9.1 + `@prisma/adapter-pg` as actually used in this repo — the failure mode is silent stale-row
reuse, not a crash. The fix prescribed by the brief (find-then-create, filtered on
`deletedAt: null`) is still exactly correct and eliminates this bug regardless of which failure
mode is real, so I proceeded with implementing it rather than treating this as a reason to halt
work — consistent with how earlier tasks on this branch (Task 4's "wrong prediction in the plan
itself") handled analogous mismatches: report honestly, keep engineering the fix that's actually
right. I corrected the misleading "upsert... throws P2039" comment the brief's snippet would have
put in `seed.ts` (see §4, deviation 1) so the codebase doesn't carry a claim I disproved.

The spike files (`prisma/_spike-upsert.ts`, `prisma/_spike-upsert2.ts`) were scratch-only, run and
deleted before any commit — they are not part of the diff.

---

## 2. TDD evidence for the roles test

**RED** — new test added (Step 2), run in isolation before the service change:

```
$ npx vitest run tests/roles.test.ts -t "re-creating a deleted role name"
 × roles service > re-creating a deleted role name makes a NEW role with no inherited grants 152ms
   → expected 'cms9tlbhp0000u0ijd0bayckn' not to be 'cms9tlbhp0000u0ijd0bayckn' // Object.is equality
    67|     expect(second.id).not.toBe(first.id);
       |                           ^
 Test Files  1 failed (1)
      Tests  1 failed | 6 skipped (7)
```

Confirms the old revival branch really was returning the same id for a re-created name.

**GREEN** — after rewriting `createRole`/`renameRole` (Step 4):

```
$ npx vitest run tests/roles.test.ts
 ✓ tests/roles.test.ts (7 tests) 380ms
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

(An 8th test — the `renameRole` backlog-bug regression, see §4 deviation 2 — was added afterward;
final `roles.test.ts` count is 8/8 passing.)

---

## 3. Seed: broken-then-fixed evidence

Since `npm run db:seed` did not fail outright (see §1), I instead verified the fix's actual
correctness directly: I manually put the dev DB into the state the brief was worried about (a
soft-deleted `Admin` and no live one), then ran the **fixed** seed:

```
$ docker compose exec -T db psql -U erp -d erp -c 'UPDATE "Role" SET "deletedAt" = now() WHERE name = '"'"'Admin'"'"';'
UPDATE 1

$ npm run db:seed
Seeded Admin role + admin user (password: admin — change it after first login).

$ docker compose exec -T db psql -U erp -d erp -c 'SELECT id, name, "deletedAt" FROM "Role" WHERE name = '"'"'Admin'"'"';'
            id             | name  |        deletedAt
---------------------------+-------+-------------------------
 cms7mvipa0000ijy2b1ks1c8d | Admin | 2026-08-01 03:37:52.247
 cms9tmkb60000wlijntg7sk86 | Admin |
(2 rows)
```

The fixed seed created a **new** live row (`cms9tmkb6...`) rather than reattaching to the dead one
(`cms7mvipa...`, still soft-deleted, untouched) — exactly the intended fix. This is direct proof
the fix eliminates the real bug, independent of whether the crash the brief predicted ever
manifests.

I then cleaned the dev DB back to a single live Admin role (deleted the artificial dead row and
its orphaned `RolePermission` rows, both manufactured solely by my manual `UPDATE ... SET
deletedAt` — not organic data) so the dev environment is left tidy:

```
$ docker compose exec -T db psql -U erp -d erp -c 'DELETE FROM "RolePermission" WHERE "roleId" = '"'"'cms7mvipa0000ijy2b1ks1c8d'"'"';'
DELETE 58
$ docker compose exec -T db psql -U erp -d erp -c 'DELETE FROM "Role" WHERE id = '"'"'cms7mvipa0000ijy2b1ks1c8d'"'"';'
DELETE 1
$ docker compose exec -T db psql -U erp -d erp -c 'SELECT id, name, "deletedAt" FROM "Role";'
            id             |   name   | deletedAt
---------------------------+----------+-----------
 cms9fk1f30009ij0cbjobe30c | CustOnly |
 cms9tmkb60000wlijntg7sk86 | Admin    |
```

### Idempotence (Step 6, run twice on a normal — not artificially soft-deleted — dev DB)

```
$ npm run db:seed
Seeded Admin role + admin user (password: admin — change it after first login).
$ npm run db:seed
Seeded Admin role + admin user (password: admin — change it after first login).
```

Both runs completed without error; the `Role` table held exactly one `Admin` row
(`cms7mvipa0000ijy2b1ks1c8d`) with the same id both times — no duplicate created. Idempotence
confirmed.

---

## 4. Inventory of every `findUnique`/`upsert` remaining

### `src/server/roles.ts`

| Call | Keyed on | Notes |
|---|---|---|
| `prisma.role.findFirst({ where: { name, deletedAt: null } })` in `createRole` | `name`, filtered live | Replaces the old `findUnique({ where: { name } })`. `Role.name` is only partially unique, so `findUnique` would compile and silently return a soft-deleted row. |
| `prisma.role.findFirst({ where: { name, deletedAt: null, NOT: { id: roleId } } })` in `renameRole` | `name`, filtered live, excluding self | Same reasoning; also fixes the carried backlog bug (see deviation 2). |
| `prisma.role.update({ where: { id: roleId }, data: { name } })` in `renameRole` | `id` | `id` is the primary key, fully unique regardless of `deletedAt` — correct to leave as-is (this uses `.update`, not `.upsert`/`.findUnique`, but is the `where: { id }` shape the brief says to leave alone). |

No remaining `findUnique` or `upsert` call in `roles.ts` — every lookup that used to be keyed on
`name` is now `findFirst` filtered on `deletedAt: null`.

### `prisma/seed.ts`

| Call | Keyed on | Notes |
|---|---|---|
| `prisma.role.findFirst({ where: { name: "Admin", deletedAt: null } })` then `prisma.role.create(...)` | `name`, filtered live | Replaces `role.upsert({ where: { name: "Admin" } })`. |
| `prisma.rolePermission.upsert({ where: { roleId_permission: { roleId, permission } } })` | compound `(roleId, permission)` | **Untouched — correctly so.** `RolePermission` has `@@unique([roleId, permission])` with no `deletedAt` column on the model at all (it's a pure join table, hard-cascaded via the FK to `Role`), so this constraint is fully unique with no partial-index trap. Confirmed by reading `prisma/schema.prisma`. |
| `prisma.user.upsert({ where: { username: "admin" } })` | `username` | **Untouched per the brief's explicit instruction.** `User.username` was deliberately left fully unique in Task 4 (not given a partial index), so `upsert` on it is safe and correct as-is. |

---

## 5. Deviations from the brief, with justification

1. **Comment text in `prisma/seed.ts` rewritten.** The brief's snippet's comment reads: `// Not
   upsert: Role.name is unique only among live rows, and upsert on such a column throws P2039.`
   Given §1's investigation, that specific claim ("upsert... throws P2039") is false for this
   codebase's Prisma version — `upsert` does not throw, it silently reuses the wrong row. I
   rewrote the comment to describe the actual, verified failure mode (silent reattachment to a
   dead row) instead of asserting a symptom that doesn't reproduce here. The functional code
   (find-then-create, filtered on `deletedAt: null`) is unchanged from the brief — this is a
   documentation-accuracy fix only, made because a comment asserting a falsifiable, disproven claim
   into the codebase would mislead the next reader who tests it (as I did).

2. **Added a regression test for the `renameRole`-onto-a-soft-deleted-name fix.** The brief's
   "Specifics" section says converting `renameRole`'s guard to `findFirst` "also fixes a carried
   backlog bug — renaming onto a soft-deleted role name used to 500... Mention it in the commit
   body," which only requires a commit-message mention, not a test. I first verified the claim
   manually with a throwaway test file (`tests/_verify-rename.test.ts`, deleted before commit —
   not part of the diff) — confirmed: `renameRole(liveId, "<name of a soft-deleted role>")`
   resolves without throwing, where it would previously have hit a `findUnique` on a non-fully-
   unique column and (per the same class of bug this whole task fixes) misbehaved. Since this is a
   real, previously-broken code path with an easy, cheap assertion, and `tests/roles.test.ts` is an
   explicitly in-scope file, I added it as a permanent test rather than leaving the fix
   uncovered:

   ```ts
   it("renameRole onto a soft-deleted role's name is allowed, not a 500", async () => {
     const { id: deadId } = await createRole("Old");
     await deleteRole(deadId);
     const { id: liveId } = await createRole("Live");
     await expect(renameRole(liveId, "Old")).resolves.not.toThrow();
     expect((await listRoles()).find((r) => r.id === liveId)?.name).toBe("Old");
   });
   ```

   This brings `tests/roles.test.ts` to 8 tests (7 prescribed + this one), all passing.

3. **`createRole`'s old revival branch removed exactly as prescribed** — no deviation, but noting
   explicitly since the "Judgment" section calls for accounting for every removed guard: the
   removed branch's only job was `prisma.$transaction([rolePermission.deleteMany, role.update])`
   to clear stale grants off a revived row. That invariant ("a re-created role name has no
   permissions") is still directly asserted by the kept/rewritten test
   (`re-creating a deleted role name makes a NEW role with no inherited grants`), which checks
   `fresh?.permissions` is `[]` after `createRole("Shipping")` a second time. No other guard was
   dropped — `renameRole`'s own-name-exempt check, `setRolePermissions`'s unknown-permission
   rejection, and `deleteRole`'s "still assigned" guard are all untouched.

No other deviations. Function signatures (`createRole(name)` → `{ id }`, `renameRole(roleId,
name)`, `deleteRole(roleId)`, `setRolePermissions(roleId, permissions)`, `listRoles()`) are
unchanged, matching the brief's explicit instruction not to touch them.

---

## 6. Final gate results (all four green)

```
$ npm test
 Test Files  30 passed (30)
      Tests  254 passed | 1 skipped (255)

$ npx tsc --noEmit
(no output — clean)

$ npx eslint src tests
(no output — clean)

$ npm run build
✓ Compiled successfully in 1948ms
✓ Generating static pages (25/25)
```

**Test count: 254 passing / 1 skipped (255 total)** — the brief's stated baseline was 253/1; the
delta of +1 is the `renameRole`-onto-soft-deleted-name regression test added in deviation 2 above.
`roles.test.ts` itself grew from 6 tests (5 kept + 1 rewritten revival test → renamed) to 8 (the
revival-rewrite plus the new rename-onto-dead-name test).

---

## 7. Files changed

- `/home/cojoa13/Desktop/HeatSynQ/erp/src/server/roles.ts` — `createRole`/`renameRole` rewritten
  to `findFirst`-then-create/update, revival branch removed.
- `/home/cojoa13/Desktop/HeatSynQ/erp/prisma/seed.ts` — `role.upsert` replaced with
  find-then-create; comment corrected per deviation 1. `rolePermission.upsert` and `user.upsert`
  untouched.
- `/home/cojoa13/Desktop/HeatSynQ/erp/tests/roles.test.ts` — revival test replaced with the
  brief's prescribed "re-creating a deleted role name..." test; one additional regression test
  added for the `renameRole` backlog-bug fix (deviation 2).

No changes to `prisma/schema.prisma`, no new migration, as instructed.

## 8. Self-review findings / concerns

- **Primary concern (already elaborated in §1):** the brief's "verified in the spike... P2039" claim
  does not reproduce in this repo's actual Prisma 7.9.1 + `@prisma/adapter-pg` setup. I investigated
  this exhaustively (three DB-state scenarios, SQL query logging, direct dev-DB demonstration of the
  fixed behavior) before concluding the discrepancy is real, narrow (doesn't implicate Task 4's
  actual deliverable), and doesn't change what the correct fix is. Flagging this prominently as
  requested, since it may be relevant to Tasks 7/8 (`reference.ts`, `process-step-codes.ts`), which
  likely carry the same "expect P2039" assumption in their own briefs for whatever partially-unique
  columns they touch — worth the next implementer re-verifying rather than assuming, per the
  branch's established pattern.
- No other concerns. The fix is structurally identical to Task 5's `createCustomer` pattern, all
  four gates are green, and the two intentionally-untouched `upsert` calls
  (`rolePermission.upsert`, `user.upsert`) were individually verified against
  `prisma/schema.prisma` to confirm they're keyed on fully-unique columns.
