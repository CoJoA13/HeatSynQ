// A COMPILE-TIME pin, not a test — deliberately outside vitest's `tests/**/*.test.{ts,tsx}` include
// so nothing here ever runs (calling a React hook under vitest's "node" environment would throw),
// while `npx tsc --noEmit` still checks it: tsconfig includes `**/*.ts` and excludes only
// node_modules. The gate that enforces this file is therefore tsc, not the suite.
//
// WHAT IT PINS (#281). `useBulkGrid` owns two names on every composed row, `key` and `isNew`. A
// `Fields` type that declares either one used to shadow the identity at runtime — the invoice
// grid's `LineFields` declared `key`, so every locally-added charge row composed under `key: ""`,
// matched no `clientId`, and could not be typed into or removed. `NoRowIdentity` in bulk-grid.ts
// makes that collision refuse to compile.
//
// MUTATION-PROVEN, which is the only reason this file earns its place: with the prohibition in
// place `npx tsc --noEmit` is silent; delete `& NoRowIdentity` from `useBulkGrid`'s `toFields`
// parameter and the directives below become unused, so tsc fails with
// `error TS2578: Unused '@ts-expect-error' directive`. A `@ts-expect-error` is the one pin shape
// that reds when the guard it names is removed, because it asserts that an error EXISTS.
import { useBulkGrid } from "@/lib/bulk-grid";

type FieldsDeclaringKey = { key: string; description: string };
type FieldsDeclaringIsNew = { isNew: string; description: string };

// The `use` prefix on each is required, not stylistic: `react-hooks/rules-of-hooks` refuses a hook
// call from a function that is neither a component nor a hook, and these are hook-shaped by
// construction — they exist to typecheck a `useBulkGrid` CALL. None is ever invoked.

/** Exported so it is referenced rather than dead, and never called. */
export function useKeyCollisionPin() {
  return useBulkGrid<{ id: string }, FieldsDeclaringKey>(
    [],
    // @ts-expect-error — a Fields type may not declare `key`; useBulkGrid supplies it (#281)
    (r) => ({ key: r.id, description: "" }),
  );
}

/** The sibling half. `isNew` was never exercised by a real caller — only `key` collided — so
 *  without this the prohibition's second member would be unproven. */
export function useIsNewCollisionPin() {
  return useBulkGrid<{ id: string }, FieldsDeclaringIsNew>(
    [],
    // @ts-expect-error — a Fields type may not declare `isNew`; useBulkGrid supplies it (#281)
    () => ({ isNew: "false", description: "" }),
  );
}

/** The third name the hook owns. An added row is identified by its `clientId` before it has a
 *  server id, so a field of that name is the same collision by another route. */
export function useClientIdCollisionPin() {
  return useBulkGrid<{ id: string }, { clientId: string; description: string }>(
    [],
    // @ts-expect-error — a Fields type may not declare `clientId`; useBulkGrid supplies it (#281)
    () => ({ clientId: "", description: "" }),
  );
}

/** The other direction, and the reason the guard is not over-broad: a clean `Fields` type still
 *  compiles, and the composed row still carries `key`/`isNew` for the consumer to read. Any
 *  `@ts-expect-error` here would be unused and would red tsc, so this doubles as the negative
 *  control — it proves the prohibition rejects the collision specifically, not every call. */
export function useCleanFieldsPin(): string[] {
  const grid = useBulkGrid([{ id: "1", n: 2 }], (r) => ({ n: String(r.n) }));
  return grid.rows.map((row) => `${row.key}:${row.isNew}:${row.n}`);
}
