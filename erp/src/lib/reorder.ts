// In src/lib rather than beside any one component: three separate up/down controls need it (part
// process steps, template steps, step-code field defs), and a client component may not import
// from src/server/**. The next-sort.ts precedent.

/**
 * Returns `items` with the entry at `index` swapped with its neighbour in `direction`, or `null`
 * when there is no such neighbour — the bounds check an up/down control has to make before it
 * sends a reorder. Never mutates `items`.
 *
 * A `null` return is "nothing to do", not an error: the controls that call this are already
 * disabled at the ends of the list, so it is the belt to that braces.
 */
export function swapAt<T>(items: readonly T[], index: number, direction: -1 | 1): T[] | null {
  const target = index + direction;
  if (index < 0 || index >= items.length) return null;
  if (target < 0 || target >= items.length) return null;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
