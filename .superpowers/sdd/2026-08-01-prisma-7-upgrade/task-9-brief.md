## Task 9: Sweep test — guard the silent `findUnique` trap

The reason this task exists: the partial index leaves these columns typed unique on the client, so `findUnique({ where: { code } })` compiles, returns the wrong row, and **no gate catches it**. Verified in the spike. Every conversion in Tasks 5–8 was manual; this is what stops the fifth one from being missed the way revival-on-create was missed four times.

Same technique as `tests/permissions-sweep.test.ts`, which the repo already trusts.

**Files:**
- Create: `erp/tests/partial-unique-sweep.test.ts`

**Interfaces:**
- Consumes: `prisma/schema.prisma` as data.
- Produces: two failing-on-regression invariants. Nothing imports from it.

- [ ] **Step 1: Write the sweep**

Create `erp/tests/partial-unique-sweep.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");

/** Every `model X { … }` block in the schema, as [name, body] pairs. */
function models(): [string, string][] {
  return [...SCHEMA.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((m) => [m[1], m[2]]);
}

/** Columns declared unique only among live rows, e.g. @@unique([code], where: raw("…")). */
function partialUniqueColumns(): Set<string> {
  const cols = new Set<string>();
  for (const [, body] of models()) {
    for (const m of body.matchAll(/@@unique\(\[([^\]]+)\][^)]*\bwhere:/g)) {
      m[1].split(",").forEach((c) => cols.add(c.trim()));
    }
  }
  return cols;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [full] : [];
  });
}

describe("partial unique sweep", () => {
  // A partial unique index does NOT remove the column from the generated WhereUniqueInput —
  // verified against Prisma 7.9.1, where the type stays AtLeast<{…}, "id" | "code">. So
  // findUnique({ where: { code } }) compiles, and silently returns the SOFT-DELETED row
  // instead of the live one. upsert on the same column throws P2039 at runtime. Neither is
  // caught by tsc, eslint, or any behavioural test that happens not to have a deleted row
  // lying around. This sweep is the only thing standing between that and production.
  it("no findUnique or upsert is keyed on a live-rows-only unique column", () => {
    const partial = partialUniqueColumns();
    expect(partial.size).toBeGreaterThan(0); // the sweep is worthless if the parse silently fails

    const files = [...tsFiles(join(process.cwd(), "src")), join(process.cwd(), "prisma/seed.ts")];
    const offenders: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\.(findUnique|upsert)\(\s*\{\s*where:\s*\{\s*(\w+)/g)) {
        if (partial.has(m[2])) {
          offenders.push(`${file.replace(process.cwd() + "/", "")}: .${m[1]}({ where: { ${m[2]} … } })`);
        }
      }
    }

    expect(offenders, `Use findFirst({ where: { <col>, deletedAt: null } }) instead — findUnique on a
partially-unique column returns the soft-deleted row, and upsert throws P2039.`).toEqual([]);
  });

  // The invariant behind §5.18: if a model can be soft-deleted, a plain @unique on it means a
  // deleted row keeps occupying that value — which is exactly what forced revival-on-create,
  // and with it the audit-identity bug in issue #10.
  it("every soft-deletable model's unique columns are live-rows-only", () => {
    // User.username is deliberately excluded: createUser has no revival branch and users are
    // never hard-deleted (handoff §4), so no re-create ever collides. Recorded here rather
    // than left as an unexplained gap.
    const ALLOWED = new Set(["User.username"]);

    const offenders: string[] = [];
    for (const [name, body] of models()) {
      if (!/^\s*deletedAt\s+DateTime\?/m.test(body)) continue;
      for (const m of body.matchAll(/^\s*(\w+)\s+\S+\s+.*@unique/gm)) {
        const key = `${name}.${m[1]}`;
        if (!ALLOWED.has(key)) offenders.push(key);
      }
    }

    expect(offenders, `These columns are @unique on a soft-deletable model. A deleted row will
occupy the value forever, forcing revival-on-create back into existence (handoff §5.18).
Use @@unique([col], where: raw("\\"deletedAt\\" IS NULL")) instead.`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — it must pass**

```bash
npx vitest run tests/partial-unique-sweep.test.ts
```
Expected: 2 passing. If the first test reports offenders, Tasks 5–8 missed a call site — fix the source, not the sweep.

- [ ] **Step 3: Prove the sweep actually bites**

Temporarily reintroduce the bug in `erp/src/server/roles.ts`:

```ts
  const existing = await prisma.role.findUnique({ where: { name } });
```

```bash
npx vitest run tests/partial-unique-sweep.test.ts
```
Expected: **FAIL**, naming `src/server/roles.ts`. A sweep that has never been seen to fail is not a guard. **Revert the edit** and re-run to confirm green.

- [ ] **Step 4: Run all four gates**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```
Expected: 257-ish tests pass (the two new sweep cases, minus the revival tests collapsed in Tasks 5–8). Record the real number — Task 10 writes it into the docs.

- [ ] **Step 5: Commit**

```bash
git add tests/partial-unique-sweep.test.ts
git commit -m "$(cat <<'EOF'
test: sweep for findUnique/upsert on live-rows-only unique columns

A partial unique index does not remove the column from the generated
WhereUniqueInput (verified against 7.9.1: the type stays AtLeast<…, "id" |
"code">), so findUnique still compiles and silently returns the soft-deleted
row, and upsert throws P2039. No other gate catches either.

The second case guards the rule itself: a plain @unique on a soft-deletable
model is what forced revival-on-create in the first place.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

