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
  // instead of the live one. upsert on the same column is state-dependent and its worst case
  // is silent too: with only a dead row it succeeds and quietly reuses that dead row (the row
  // stays deleted); with both a dead and a live row it throws P2039. Neither the silent reuse
  // nor the findUnique misread is caught by tsc, eslint, or any behavioural test that happens
  // not to have a deleted row lying around. This sweep is the only thing standing between
  // that and production.
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

    expect(offenders, `Use findFirst({ where: { <col>, deletedAt: null } }) instead — upsert on a
partially-unique column silently reuses a dead row when only a dead row exists (and throws
P2039 when both a dead and a live row exist), and findUnique returns the soft-deleted row.`).toEqual([]);
  });

  // The invariant behind §5.18: if a model can be soft-deleted, a plain @unique on it means a
  // deleted row keeps occupying that value — which is exactly what forced revival-on-create,
  // and with it the audit-identity bug in issue #10.
  it("every soft-deletable model's unique columns are live-rows-only", () => {
    // User.username is deliberately excluded: createUser has no revival branch and users are
    // never hard-deleted (handoff §4), so no re-create ever collides. Recorded here rather
    // than left as an unexplained gap.
    const ALLOWED = new Set(["User.username"]);

    // [ \t]+ (not \s+) here too: \s+ would let this match bridge across a blank line the same
    // way the field-level match below used to (see comment there) — a schema reformat that
    // happened to break this specific pattern must fail the assertion right below it, not
    // silently evaluate zero models and pass.
    const softDeletable = models().filter(([, body]) => /^[ \t]*deletedAt[ \t]+DateTime\?/m.test(body));
    expect(softDeletable.length).toBeGreaterThan(0); // a broken parse must not silently empty this sweep

    const offenders: string[] = [];
    for (const [name, body] of softDeletable) {
      // [ \t]+ (not \s+) and a negative lookbehind on the `@` keep this match on a single field
      // declaration line. `\s+` matches newlines too, so with the schema's blank line before a
      // model's own `@@unique([...], where: ...)` block, `\s+` bridges straight through the field
      // line, the blank line, and the leading `@` of `@@unique` — and "@@unique" contains
      // "@unique" as a substring, so the block-level constraint itself was being misread as a
      // field-level `@unique` on whatever field happened to be declared last. Caught by running
      // this test for real: it flagged Role.permissions, GlAccount.processStepCodes,
      // ProcessStepCode.fields, InspectionScale.codes, Terms.customers, and Customer.contacts —
      // none of which carry `@unique` at all.
      for (const m of body.matchAll(/^[ \t]*(\w+)[ \t]+\S+[ \t]+.*(?<!@)@unique/gm)) {
        const key = `${name}.${m[1]}`;
        if (!ALLOWED.has(key)) offenders.push(key);
      }
    }

    expect(offenders, `These columns are @unique on a soft-deletable model. A deleted row will
occupy the value forever, forcing revival-on-create back into existence (handoff §5.18).
Use @@unique([col], where: raw("\\"deletedAt\\" IS NULL")) instead.`).toEqual([]);
  });
});
