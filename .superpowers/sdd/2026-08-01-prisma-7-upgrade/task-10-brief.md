## Task 10: Rewrite the documentation that this change invalidates

Handoff §4b: "Update `CLAUDE.md` and §8 in the same change, or the next fresh checkout follows instructions that no longer work." This task is not optional and not cosmetic — the documented schema-change recipe stops working the moment Task 2 lands.

**Files:**
- Modify: `CLAUDE.md` — "Commands", "Schema changes apply to two databases", "Deletion is always soft"
- Modify: `docs/HANDOFF.md` — §4a, §4b, §5.10, §5.11, §5.18, §6, §8, §9

**Interfaces:**
- Consumes: the real test count from Task 9, Step 4.
- Produces: documentation a fresh checkout can follow.

- [ ] **Step 1: Fix `CLAUDE.md`'s two-database recipe**

v7's `migrate dev` no longer generates the client, and `--skip-generate` / `--skip-seed` no longer exist. Replace the recipe under "Schema changes apply to two databases" with:

````markdown
```bash
npx prisma migrate dev                                                     # dev DB, creates the migration
npx prisma generate                                                        # v7 no longer does this for you
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
```

Skipping the second command leaves you typechecking against a stale client; skipping the third
leaves the tests running against a stale schema. `npx prisma generate` is also required before
typechecking a fresh checkout — the client is generated into `prisma/generated/` and is
gitignored, so without it every Prisma type in `src/server/` and the tests is missing.
````

- [ ] **Step 2: Fix `CLAUDE.md`'s first-run command block**

Add `npx prisma generate` after `npm install`, and correct the test count to the number from Task 9:

```bash
npm install
npx prisma generate               # client is gitignored; generate before typechecking or testing
npx prisma migrate deploy         # dev DB
```

Also correct the stale comment on the test line — it still says "75 integration tests".

- [ ] **Step 3: Record the new deletion rule in `CLAUDE.md`**

Under "Deletion is always soft", replace the sentence "Reviving a soft-deleted name must clear the stale permissions attached to it." with:

```markdown
Unique columns on soft-deletable models are unique **only among live rows** (a partial index
filtered on `deletedAt IS NULL`), so re-using a deleted code creates a genuinely new row with
its own id and its own audit history — there is no revival-on-create, and adding one back is a
regression. **Never `findUnique`/`upsert` on such a column**: the generated client still types
it unique, so both compile, and `findUnique` silently returns the deleted row. Use
`findFirst({ where: { code, deletedAt: null } })`. `tests/partial-unique-sweep.test.ts` enforces
both halves.
```

- [ ] **Step 4: Rewrite handoff §5.11 and §5.18**

§5.11 currently says "SUPERSEDED by §5.18 — being deleted, not consolidated." It is now *done*. Replace the whole numbered item with:

```markdown
11. **There is no revival-on-create — deleting it was the point of the Prisma 7 work.** Unique
    columns on soft-deletable models are unique only among live rows. A re-used code is a new
    row with a new id and a real `"create"` audit entry; the archived row keeps its own id, its
    real value and its own history. `findUnique`/`upsert` on those columns is banned and swept
    (`tests/partial-unique-sweep.test.ts`) — the client still types them unique, so both
    compile and `findUnique` returns the *deleted* row.
```

§5.18 becomes a historical record. Prefix it with `**DONE (2026-08-01, branch `prisma-7-upgrade`).**` and **correct its two factual errors in place**, so a future reader does not re-derive them:
- `@@unique` *does* take `where`; the value is `raw("…")`, not a bare string.
- The conversion to `findFirst` is **not** compiler-enforced — the column stays typed unique. Point at the sweep.
- Add: `partialIndexes` is a preview feature; owner approved it 2026-08-01.

- [ ] **Step 5: Rewrite handoff §4b as an outcome, not a forecast**

Replace §4b's "what it actually means for THIS repo" with what actually happened: the ESM flip touched exactly one file (`vitest.config.ts`'s `__dirname`); `engine` was removed not adapted; the generated client is TypeScript and lives gitignored in `prisma/generated`; `tsc` needed no target bump; the six import sites were the whole surface.

- [ ] **Step 6: Update §4a's resume point and §9's kickoff prompts**

§4a item 1 (the Prisma upgrade) is done — replace it with a one-line record and promote Phase 2C to next. In §5.10, add the `npx prisma generate` step. In §9, **delete the Prisma 7 kickoff prompt** and leave Phase 2C's as the live one.

In §6, strike the two backlog items this branch closed: "renaming onto a *soft-deleted* unique value 400s 'already exists'" and "`renameRole` to a soft-deleted role's name → 500 edge". Also strike "Make revival-on-create ONE shared helper before 2C adds a fifth site" — there is no revival to share.

Update §8's `npm test # expect 255 passing` to the real number, and add `npx prisma generate` before `npm test`.

- [ ] **Step 7: Update Phase 2C's inherited obligations**

§4a item 2 lists five obligations 2C inherits. Revival-on-create is not among them and must not be re-added. Confirm the list still reads correctly now that §5.11 has changed meaning.

- [ ] **Step 8: Verify the docs against a clean checkout**

The real test of this task. In a scratch directory:

```bash
git clone /home/cojoa13/Desktop/HeatSynQ /tmp/handoff-check && cd /tmp/handoff-check
git checkout prisma-7-upgrade && cd erp
cp .env.example .env
npm install
```
Then follow `CLAUDE.md`'s documented steps **exactly as written**, against the existing dev database, and confirm `npx tsc --noEmit` and `npm test` both pass. If any documented step is missing or wrong, fix the doc — that is the whole point of the task. Remove `/tmp/handoff-check` afterwards.

- [ ] **Step 9: Commit**

```bash
git add ../CLAUDE.md ../docs/HANDOFF.md
git commit -m "$(cat <<'EOF'
docs: rewrite the schema-change workflow for Prisma 7

v7's `migrate dev` no longer generates the client or seeds, and the client is
now generated into a gitignored path — so the recipe CLAUDE.md and handoff §8
documented no longer works on a fresh checkout. Verified by following the new
instructions verbatim in a clean clone.

§5.11 and §5.18 are rewritten as done rather than pending, with §5.18's two
factual errors corrected in place (@@unique does take `where`; the findFirst
conversion is not compiler-enforced). §4b becomes an outcome record.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification before review

- [ ] All four gates green from a clean state:

```bash
cd erp
rm -rf prisma/generated .next
npx prisma generate
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```

- [ ] Both databases carry the new migration:

```bash
npx prisma migrate status
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate status
```

- [ ] No revival machinery survives anywhere:

```bash
grep -rn "REVIVAL\|revival\|revive" src/ prisma/ | grep -v "^Binary"
```
Expected: no hits in `src/` or `prisma/` other than comments that explicitly say revival no longer exists.

- [ ] The production image builds: `docker compose --profile prod build app`

- [ ] Browser check against the dev database, per handoff §5a's bundled-Chromium recipe: delete a customer, re-create the same code, and confirm the **History panel shows only the new row's `"create"`** — the exact symptom issue #10 was filed for. Clear the fixtures out of `erp` afterwards.

---

## Open question for the owner (does not block this branch)

Issue **#4** remains the one open product decision (contacts flagged for document delivery with no email address). It binds Phases 4–5, not this work. Do not resolve it here.
