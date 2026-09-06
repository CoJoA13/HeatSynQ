// The two parser primitives the source sweeps share, lifted out of `tests/audit-children.test.ts`
// when `tests/archival-gate-sweep.test.ts` (#277) became their second consumer.
//
// WHY A MODULE RATHER THAN A THIRD HAND COPY. Both of these carry a decision record that took a
// review round each to write — #188's "match the CALL, not the text that spells one" for
// `callsBareIdentifier`, and the three silently-dropped specifier shapes for `resolveLocalModule` —
// and a copied docstring is a docstring that drifts (the `dev-db-guard.ts` lesson: four hand copies
// that had already diverged). The 21 regression assertions `audit-children.test.ts` already holds
// over `callsInvalidate` now protect this implementation, since that function is a one-line wrapper
// over `callsBareIdentifier`. Nothing else moved: the tree walk, the allowlist rule and the
// non-vacuous floors stay duplicated per sweep, because each one is four lines and each sweep wants
// a different subject.
//
// This file is deliberately NOT named `*.test.ts`: `vitest.config.ts` collects
// `tests/**/*.test.{ts,tsx}`, so a helper here is type-checked and linted but never executed as a
// suite — the `tests/helpers/db.ts` and `tests/bulk-grid.type-pin.ts` precedent.
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

/**
 * Does this source really CALL `name` — as code, not as text that spells one?
 *
 * **PARSED, NOT PATTERN-MATCHED (#188).** Every hand-rolled comment stripper this repo tried was
 * wrong in a way only running it revealed: stripping block comments first let a `/*` inside a `//`
 * comment open a block that swallowed 23,140 characters of one real file; stripping only `//` let a
 * docblock *mentioning* the call read as the call; and the shipped strip-both version still counted
 * `const hint = "invalidateHistory()"` as a call while eating a genuine call that sat after a `//`
 * inside a string literal — failing in both directions at once. `ts.createSourceFile` answers the
 * question exactly: comments, strings, template text, JSX text and regex literals are all the
 * parser's problem rather than a fifth regex's.
 *
 * WHAT COUNTS: a `CallExpression` whose callee is the bare IDENTIFIER `name`, anywhere in the tree.
 * Deliberately NOT a property access (`x.f()`) and not an uncalled reference (`onSaved={f}`) — both
 * exclusions fail CLOSED, which is the direction every sweep here is built in. The reasoning, and
 * the shapes that must and must not match, are pinned in `audit-children.test.ts`'s self-tests.
 *
 * Parsed as TSX by default because every file asked about so far is a `.tsx` client component; pass
 * a `fileName` when the subject is a `.ts` module, since `const id = <T>(x: T) => x;` is a generic
 * arrow in TS and an unclosed JSX element in TSX.
 *
 * **The backstop for an unparseable file is not this function; it is the rest of the gate set.** A
 * source under `src/` that does not parse reds `npx tsc --noEmit` and `npx eslint`, loudly and by
 * name, and both run beside these suites on every change.
 */
export function callsBareIdentifier(src: string, name: string, fileName = "candidate.tsx"): boolean {
  const parsed = ts.createSourceFile(
    fileName, src, ts.ScriptTarget.Latest, /* setParentNodes */ false,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return found;
}

/** A specifier a local resolver is willing to be asked about: the `@/` alias, or a relative path. */
export const isLocalSpecifier = (spec: string): boolean => spec.startsWith("@/") || spec.startsWith(".");

/**
 * The real file a LOCAL module specifier names, relative to `root`, or `null` if nothing is there.
 *
 * `@/` is the repo's alias for `src/` (`tsconfig.json` `paths`); each caller asserts separately that
 * it is still the ONLY alias, which is what makes `isLocalSpecifier` exhaustive. Extensions are
 * tried in the bundler's order, then the specifier as written, so an extension-carrying `"./X.tsx"`
 * and a non-code asset both land somewhere real rather than reading as unresolvable.
 *
 * `root` is explicit rather than `process.cwd()` so a caller that resolves its paths from
 * `import.meta.url` and one that resolves them from the working directory cannot end up asking the
 * same question of two different trees. `fromFile` is root-relative and so is the answer.
 *
 * WHAT THIS DROPS SILENTLY, enumerated rather than summarised, because each takes an edge out of a
 * caller's graph with NO failure of its own:
 *
 *  1. a SECOND tsconfig path alias — only `@/` is understood, and any other non-relative specifier
 *     answers `null` as though it were a package;
 *  2. a `.js` spelling of a `.ts`/`.tsx` file, which `moduleResolution: "bundler"` accepts;
 *  3. `require()`, and any dynamic `import()` — neither is an import or export DECLARATION, and the
 *     callers only ask about those, so no specifier ever reaches here at all.
 *
 * Callers that depend on the graph being complete assert 1 and 2 away against their own file set.
 */
export function resolveLocalModule(root: string, fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(root, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(root, dirname(fromFile), spec);
  else return null;
  for (const candidate of [
    `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts"), base,
  ]) {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    return relative(root, candidate).split(sep).join("/");
  }
  return null;
}
