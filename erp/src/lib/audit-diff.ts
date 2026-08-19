// Client-safe leaf (the permission-constants precedent — no src/server imports): HistoryPanel's
// pure diff logic, extracted so tests/audit-diff.test.ts can pin it without a DOM test env
// (#14 item 2's render half, the Group D extract-and-test pattern).

/**
 * The keys whose values differ between an audit entry's before/after snapshots — what
 * HistoryPanel renders as the entry's diff lines.
 *
 * Comparison is whole-key JSON.stringify, deliberately order-sensitive: snapshot CAPTURE orders
 * every list relation (tests/snapshot-order-sweep.test.ts, #24), so an order difference IS a
 * difference. `updatedAt` is excluded — it moves on every mutation and explains nothing.
 *
 * The raw-FK suppression (#14 item 2): when a `<x>Id` key changed AND its sibling relation key
 * (`<x>` — the same name minus `Id`) changed in the same entry, the raw key is dropped so the
 * diff reads once — `material: {…"Ductile iron"…}`, not that plus `materialId: "cmsb1z…"`. The
 * sibling must itself have CHANGED, not merely exist: frozen pre-include history carries only the
 * cuid (no sibling key on either side — accepted, snapshots are frozen, no backfill), and an
 * entry where only the raw key moved has no readable twin to defer to; both keep the raw key.
 */
export function changedFields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  if (!before || !after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [...keys]
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .filter((k) => k !== "updatedAt");
  const changedSet = new Set(changed);
  return changed.filter((k) => !(k.length > 2 && k.endsWith("Id") && changedSet.has(k.slice(0, -2))));
}
